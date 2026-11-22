import { createHash } from 'node:crypto'
import express, { type Request, type Response, Router } from 'express'
import type { Database } from '@atproto/bsky'
import { TID } from '@atproto/common'
import { isValidDid } from '@atproto/syntax'
import { AuthRequiredError } from '@atproto/xrpc-server'

export async function initChatTables(pool: Database['pool']): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS torah_appview.chat_convo (
      id TEXT PRIMARY KEY,
      rev TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS torah_appview.chat_member (
      convo_id TEXT NOT NULL REFERENCES torah_appview.chat_convo(id) ON DELETE CASCADE,
      did TEXT NOT NULL,
      last_read_message_id TEXT,
      muted BOOLEAN NOT NULL DEFAULT FALSE,
      PRIMARY KEY (convo_id, did)
    );

    CREATE TABLE IF NOT EXISTS torah_appview.chat_message (
      id TEXT PRIMARY KEY,
      convo_id TEXT NOT NULL REFERENCES torah_appview.chat_convo(id) ON DELETE CASCADE,
      sender_did TEXT NOT NULL,
      rev TEXT NOT NULL,
      text TEXT NOT NULL,
      facets JSONB,
      embed JSONB,
      sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      deleted BOOLEAN NOT NULL DEFAULT FALSE
    );

    CREATE INDEX IF NOT EXISTS idx_chat_message_convo ON torah_appview.chat_message(convo_id, sent_at DESC);
    CREATE INDEX IF NOT EXISTS idx_chat_member_did ON torah_appview.chat_member(did);
  `)
}

class ChatAuthError extends Error {
  name = 'ChatAuthError'
  status: number
  constructor(message: string, status = 401) {
    super(message)
    this.status = status
  }
}

class ChatForbiddenError extends Error {
  name = 'ChatForbiddenError'
  status = 403
  constructor(message = 'Not a member of this convo') {
    super(message)
    this.status = 403
  }
}

/** Authenticate service JWTs with the AppView's standard verifier. */
export type AuthenticateChatRequest = (req: Request) => Promise<string>

function getCallerDid(res: Response): string {
  const did: unknown = res.locals.torahChatDid
  if (!isValidDid(did)) {
    throw new ChatAuthError('Authentication required')
  }
  return did
}

function isInvalidJwtError(err: unknown): boolean {
  return (
    err instanceof SyntaxError ||
    // @NOTE jose 5.1 reports malformed protected headers without an error code.
    (err instanceof TypeError &&
      err.message === 'Invalid Token or Protected Header formatting') ||
    (err instanceof Error &&
      'code' in err &&
      typeof err.code === 'string' &&
      err.code.startsWith('ERR_J'))
  )
}

async function assertMembership(
  pool: unknown,
  convoId: string,
  callerDid: string,
) {
  const res = await (
    pool as {
      query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }>
    }
  ).query(
    'SELECT 1 FROM torah_appview.chat_member WHERE convo_id = $1 AND did = $2',
    [convoId, callerDid],
  )
  if (res.rows.length === 0) {
    throw new ChatForbiddenError()
  }
}

async function getMemberProfile(pool: any, did: string) {
  const res = await pool.query(
    'SELECT did, handle, "takedownRef", "upstreamStatus" FROM torah_appview.actor WHERE did = $1',
    [did],
  )
  const row = res.rows[0]
  return {
    did,
    handle: row?.handle || 'handle.invalid',
    displayName: row?.handle || did,
    avatar: undefined,
    chatDisabled:
      !row ||
      Boolean(row.takedownRef) ||
      (row.upstreamStatus != null && row.upstreamStatus !== 'active'),
  }
}

async function buildConvoView(pool: any, convoId: string, callerDid: string) {
  const convoRes = await pool.query(
    'SELECT id, rev, created_at, updated_at FROM torah_appview.chat_convo WHERE id = $1',
    [convoId],
  )
  if (convoRes.rows.length === 0) return null
  const convo = convoRes.rows[0]

  const membersRes = await pool.query(
    'SELECT did, last_read_message_id, muted FROM torah_appview.chat_member WHERE convo_id = $1',
    [convoId],
  )
  const callerMember = membersRes.rows.find((m: any) => m.did === callerDid)

  const memberProfiles = await Promise.all(
    membersRes.rows.map((m: any) => getMemberProfile(pool, m.did)),
  )

  const lastMsgRes = await pool.query(
    'SELECT id, rev, sender_did, text, facets, embed, sent_at FROM torah_appview.chat_message WHERE convo_id = $1 AND deleted = false ORDER BY sent_at DESC, id DESC LIMIT 1',
    [convoId],
  )
  const lastMsg = lastMsgRes.rows[0]

  let unreadCount = 0
  if (callerMember) {
    if (callerMember.last_read_message_id) {
      const readMsgRes = await pool.query(
        'SELECT id, sent_at FROM torah_appview.chat_message WHERE id = $1 AND convo_id = $2',
        [callerMember.last_read_message_id, convoId],
      )
      const readAt = readMsgRes.rows[0]?.sent_at
      if (readAt) {
        const countRes = await pool.query(
          'SELECT COUNT(*) as cnt FROM torah_appview.chat_message WHERE convo_id = $1 AND sender_did != $2 AND deleted = false AND (sent_at, id) > ($3, $4)',
          [convoId, callerDid, readAt, callerMember.last_read_message_id],
        )
        unreadCount = parseInt(countRes.rows[0]?.cnt || '0', 10)
      } else {
        const countRes = await pool.query(
          'SELECT COUNT(*) as cnt FROM torah_appview.chat_message WHERE convo_id = $1 AND sender_did != $2 AND deleted = false',
          [convoId, callerDid],
        )
        unreadCount = parseInt(countRes.rows[0]?.cnt || '0', 10)
      }
    } else {
      const countRes = await pool.query(
        'SELECT COUNT(*) as cnt FROM torah_appview.chat_message WHERE convo_id = $1 AND sender_did != $2 AND deleted = false',
        [convoId, callerDid],
      )
      unreadCount = parseInt(countRes.rows[0]?.cnt || '0', 10)
    }
  }

  const lastMessageView = lastMsg
    ? {
        $type: 'chat.bsky.convo.defs#messageView',
        id: lastMsg.id,
        rev: lastMsg.rev,
        text: lastMsg.text,
        facets: lastMsg.facets || undefined,
        embed: lastMsg.embed || undefined,
        sender: { did: lastMsg.sender_did },
        sentAt: lastMsg.sent_at.toISOString(),
      }
    : undefined

  const kind =
    membersRes.rows.length <= 2
      ? { $type: 'chat.bsky.convo.defs#directConvo' }
      : { $type: 'chat.bsky.convo.defs#groupConvo' }

  return {
    id: convo.id,
    rev: convo.rev,
    members: memberProfiles,
    lastMessage: lastMessageView,
    muted: callerMember?.muted ?? false,
    status: 'accepted',
    unreadCount,
    kind,
  }
}

export type UnreadCounts = {
  unreadAcceptedConvos: number
  unreadRequestConvos: number
}

/** Count unread conversations using the accepted-only legacy chat model. */
export async function getUnreadCounts(
  pool: Database['pool'],
  callerDid: string,
  includeGroupChats = true,
): Promise<UnreadCounts> {
  const result = await pool.query<UnreadCounts>(
    `SELECT COUNT(*)::int AS "unreadAcceptedConvos",
            0::int AS "unreadRequestConvos"
     FROM (
       SELECT mine.convo_id
       FROM torah_appview.chat_member AS mine
       CROSS JOIN LATERAL (
         SELECT COUNT(*) AS member_count
         FROM torah_appview.chat_member AS member
         WHERE member.convo_id = mine.convo_id
       ) AS membership
       LEFT JOIN torah_appview.chat_message AS last_read
         ON last_read.id = mine.last_read_message_id
         AND last_read.convo_id = mine.convo_id
       WHERE mine.did = $1
         AND mine.muted = FALSE
         AND EXISTS (
           SELECT 1
           FROM torah_appview.chat_message AS message
           WHERE message.convo_id = mine.convo_id
             AND message.sender_did <> $1
             AND message.deleted = FALSE
             AND (
               last_read.id IS NULL
               OR (message.sent_at, message.id) > (last_read.sent_at, last_read.id)
             )
         )
         AND (
           ($2::boolean AND membership.member_count > 2)
           OR (
             membership.member_count = 2
             AND EXISTS (
               SELECT 1
               FROM torah_appview.chat_member AS other
               JOIN torah_appview.actor AS actor ON actor.did = other.did
               WHERE other.convo_id = mine.convo_id
                 AND other.did <> $1
                 AND actor."takedownRef" IS NULL
                 AND (
                   actor."upstreamStatus" IS NULL
                   OR actor."upstreamStatus" = 'active'
                 )
                 AND NOT EXISTS (
                   SELECT 1
                   FROM torah_appview.actor_block AS block
                   WHERE (block.creator = $1 AND block."subjectDid" = other.did)
                      OR (block.creator = other.did AND block."subjectDid" = $1)
                 )
                 AND NOT EXISTS (
                   SELECT 1
                   FROM torah_appview.list_block AS block
                   JOIN torah_appview.list_item AS item
                     ON item."listUri" = block."subjectUri"
                   WHERE (block.creator = $1 AND item."subjectDid" = other.did)
                      OR (block.creator = other.did AND item."subjectDid" = $1)
                 )
             )
           )
         )
       LIMIT 100
     ) AS unread`,
    [callerDid, includeGroupChats],
  )
  return result.rows[0]
}

type DirectChatPolicy = {
  canChat: boolean
  convoId?: string
}

type DirectChatPolicyRow = {
  callerActive: boolean
  recipientActive: boolean
  blocked: boolean
  recipientFollowsCaller: boolean
  declaration: unknown
  declarationTakedown: string | null
  convoId: string | null
}

/** Resolve direct-chat permissions without creating a conversation. */
export async function getDirectChatPolicy(
  pool: Database['pool'],
  callerDid: string,
  recipientDid: string,
): Promise<DirectChatPolicy> {
  if (callerDid === recipientDid) return { canChat: false }
  const result = await pool.query<DirectChatPolicyRow>(
    `SELECT
       EXISTS (
         SELECT 1 FROM torah_appview.actor
         WHERE did = $1 AND "takedownRef" IS NULL
           AND ("upstreamStatus" IS NULL OR "upstreamStatus" = 'active')
       ) AS "callerActive",
       EXISTS (
         SELECT 1 FROM torah_appview.actor
         WHERE did = $2 AND "takedownRef" IS NULL
           AND ("upstreamStatus" IS NULL OR "upstreamStatus" = 'active')
       ) AS "recipientActive",
       (
         EXISTS (
           SELECT 1 FROM torah_appview.actor_block
           WHERE (creator = $1 AND "subjectDid" = $2)
              OR (creator = $2 AND "subjectDid" = $1)
         )
         OR EXISTS (
           SELECT 1 FROM torah_appview.list_block AS block
           JOIN torah_appview.list_item AS item
             ON item."listUri" = block."subjectUri"
           WHERE (block.creator = $1 AND item."subjectDid" = $2)
              OR (block.creator = $2 AND item."subjectDid" = $1)
         )
       ) AS blocked,
       EXISTS (
         SELECT 1 FROM torah_appview.follow
         WHERE creator = $2 AND "subjectDid" = $1
       ) AS "recipientFollowsCaller",
       (
         SELECT json FROM torah_appview.record WHERE uri = $3
       ) AS declaration,
       (
         SELECT "takedownRef" FROM torah_appview.record WHERE uri = $3
       ) AS "declarationTakedown",
       (
         SELECT convo.id
         FROM torah_appview.chat_convo AS convo
         JOIN torah_appview.chat_member AS mine
           ON mine.convo_id = convo.id AND mine.did = $1
         JOIN torah_appview.chat_member AS other
           ON other.convo_id = convo.id AND other.did = $2
         WHERE (
           SELECT COUNT(*) FROM torah_appview.chat_member
           WHERE convo_id = convo.id
         ) = 2
         ORDER BY convo.created_at, convo.id
         LIMIT 1
       ) AS "convoId"`,
    [
      callerDid,
      recipientDid,
      `at://${recipientDid}/chat.bsky.actor.declaration/self`,
    ],
  )
  const row = result.rows[0]
  const convoId = row.convoId ?? undefined
  if (!row.callerActive || !row.recipientActive || row.blocked) {
    return { canChat: false, convoId }
  }
  // @NOTE Privacy settings apply to new chats; existing accepted chats continue.
  if (convoId) return { canChat: true, convoId }
  if (row.declarationTakedown) return { canChat: false }

  let allowIncoming: unknown = 'following'
  if (row.declaration !== null) {
    try {
      const declaration: unknown =
        typeof row.declaration === 'string'
          ? JSON.parse(row.declaration)
          : row.declaration
      allowIncoming =
        declaration &&
        typeof declaration === 'object' &&
        !Array.isArray(declaration) &&
        'allowIncoming' in declaration
          ? declaration.allowIncoming
          : undefined
    } catch {
      return { canChat: false }
    }
  }
  return {
    canChat:
      allowIncoming === 'all' ||
      (allowIncoming === 'following' && row.recipientFollowsCaller),
  }
}

/** Reuse legacy direct IDs and atomically create a single new pair conversation. */
export async function getOrCreateDirectConvo(
  pool: Database['pool'],
  callerDid: string,
  recipientDid: string,
): Promise<string> {
  const policy = await getDirectChatPolicy(pool, callerDid, recipientDid)
  if (!policy.canChat) {
    throw new ChatForbiddenError('Messages are unavailable for these members')
  }
  if (policy.convoId) return policy.convoId

  const members = [callerDid, recipientDid].sort()
  const pairHash = createHash('sha256')
    .update(JSON.stringify(members))
    .digest('hex')
  const id = `c_${pairHash}`
  // @NOTE One statement keeps both membership inserts atomic. The existing
  // convo primary key serializes callers that observed the same absent pair.
  const result = await pool.query<{ id: string }>(
    `WITH saved_convo AS (
       INSERT INTO torah_appview.chat_convo (id, rev)
       VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id
       RETURNING id
     ), saved_members AS (
       INSERT INTO torah_appview.chat_member (convo_id, did)
       SELECT saved_convo.id, member.did
       FROM saved_convo
       CROSS JOIN UNNEST($3::text[]) AS member(did)
       ON CONFLICT (convo_id, did) DO NOTHING
       RETURNING convo_id
     )
     SELECT id FROM saved_convo`,
    [id, TID.nextStr(), members],
  )
  return result.rows[0].id
}

/** List only the accepted memberships represented by the legacy chat tables. */
export async function getAcceptedConvoIds(
  pool: Database['pool'],
  callerDid: string,
  limit: number,
  kind?: 'direct' | 'group',
): Promise<string[]> {
  const result = await pool.query<{ id: string }>(
    `SELECT c.id FROM torah_appview.chat_convo c
     JOIN torah_appview.chat_member m ON m.convo_id = c.id
     WHERE m.did = $1
       AND (
         $3::text IS NULL
         OR ($3 = 'direct' AND (
           SELECT COUNT(*) FROM torah_appview.chat_member members
           WHERE members.convo_id = c.id
         ) = 2)
         OR ($3 = 'group' AND (
           SELECT COUNT(*) FROM torah_appview.chat_member members
           WHERE members.convo_id = c.id
         ) > 2)
       )
     ORDER BY c.updated_at DESC, c.id DESC LIMIT $2`,
    [callerDid, limit, kind ?? null],
  )
  return result.rows.map((row) => row.id)
}

function directMembers(
  input: unknown,
  callerDid: string,
): [string, string] | undefined {
  const requested = typeof input === 'string' ? [input] : input
  if (
    !Array.isArray(requested) ||
    requested.length < 1 ||
    requested.length > 10 ||
    requested.some((did) => !isValidDid(did))
  ) {
    return
  }
  const members = [...new Set<string>([callerDid, ...requested])].sort()
  if (members.length !== 2) return
  return members as [string, string]
}

async function isChatActorActive(
  pool: Database['pool'],
  did: string,
): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM torah_appview.actor
     WHERE did = $1 AND "takedownRef" IS NULL
       AND ("upstreamStatus" IS NULL OR "upstreamStatus" = 'active')`,
    [did],
  )
  return result.rows.length > 0
}

async function assertCanSend(
  pool: Database['pool'],
  convoId: string,
  callerDid: string,
): Promise<void> {
  await assertMembership(pool, convoId, callerDid)
  const members = await pool.query<{ did: string }>(
    'SELECT did FROM torah_appview.chat_member WHERE convo_id = $1',
    [convoId],
  )
  if (members.rows.length === 2) {
    const recipient = members.rows.find((member) => member.did !== callerDid)
    const policy =
      recipient && (await getDirectChatPolicy(pool, callerDid, recipient.did))
    if (!policy?.canChat) {
      throw new ChatForbiddenError('Messages are unavailable for these members')
    }
  } else if (
    members.rows.length < 2 ||
    !(await isChatActorActive(pool, callerDid))
  ) {
    throw new ChatForbiddenError('This conversation is unavailable')
  }
}

/** Create the chat router with mandatory verified service authentication. */
export function createChatRouter(
  db: Pick<Database, 'pool'>,
  authenticate: AuthenticateChatRequest,
): Router {
  if (typeof authenticate !== 'function') {
    throw new TypeError('Chat authentication callback is required')
  }
  const router = Router()
  router.use(async (req, res, next) => {
    if (!req.path.startsWith('/xrpc/chat.bsky.')) {
      return next('router')
    }
    try {
      const did = await authenticate(req)
      // @NOTE Standard AppView auth also accepts service issuers with fragments.
      // Chat membership is always attached to a bare actor DID.
      if (!isValidDid(did)) {
        throw new ChatAuthError('Chat authentication requires an actor DID')
      }
      res.locals.torahChatDid = did
      next()
    } catch (err: unknown) {
      if (
        err instanceof ChatAuthError ||
        err instanceof AuthRequiredError ||
        isInvalidJwtError(err)
      ) {
        res.status(401).json({
          error: 'AuthRequired',
          message: 'Valid service authentication is required',
        })
      } else {
        res.status(503).json({
          error: 'ServiceUnavailable',
          message: 'Authentication service unavailable',
        })
      }
    }
  })
  router.use(express.json())

  router.get('/xrpc/chat.bsky.convo.getUnreadCounts', async (req, res) => {
    const includeGroups = req.query.includeGroupChats
    if (
      includeGroups !== undefined &&
      includeGroups !== 'true' &&
      includeGroups !== 'false'
    ) {
      return res.status(400).json({
        error: 'InvalidRequest',
        message: 'includeGroupChats must be true or false',
      })
    }
    try {
      const counts = await getUnreadCounts(
        db.pool,
        getCallerDid(res),
        includeGroups !== 'false',
      )
      return res.json(counts)
    } catch {
      return res.status(500).json({
        error: 'InternalServerError',
        message: 'Unable to load unread conversation counts',
      })
    }
  })

  router.get('/xrpc/chat.bsky.convo.getConvoAvailability', async (req, res) => {
    const callerDid = getCallerDid(res)
    const members = directMembers(req.query.members, callerDid)
    if (!members) {
      return res.status(400).json({
        error: 'InvalidRequest',
        message:
          'Exactly two distinct actors are required for a direct conversation',
      })
    }
    try {
      const recipient = members.find((did) => did !== callerDid)!
      const policy = await getDirectChatPolicy(db.pool, callerDid, recipient)
      const convo = policy.convoId
        ? await buildConvoView(db.pool, policy.convoId, callerDid)
        : undefined
      return res.json({ canChat: policy.canChat, ...(convo ? { convo } : {}) })
    } catch {
      return res.status(500).json({
        error: 'InternalServerError',
        message: 'Unable to check conversation availability',
      })
    }
  })

  router.get('/xrpc/chat.bsky.actor.getStatus', async (_req, res) => {
    try {
      const active = await isChatActorActive(db.pool, getCallerDid(res))
      return res.json({
        chatDisabled: !active,
        canCreateGroups: false,
        groupMemberLimit: 0,
      })
    } catch {
      return res.status(500).json({
        error: 'InternalServerError',
        message: 'Unable to load chat status',
      })
    }
  })

  router.get(
    '/xrpc/chat.bsky.actor.exportAccountData',
    (_req: Request, res: Response) => {
      res.json({})
    },
  )

  router.get(
    '/xrpc/chat.bsky.actor.getActorMetadata',
    (_req: Request, res: Response) => {
      res.json({
        day: { messagesSent: 0, messagesReceived: 0 },
        month: { messagesSent: 0, messagesReceived: 0 },
        all: { messagesSent: 0, messagesReceived: 0 },
      })
    },
  )

  // Convo endpoints
  const handleGetConvoForMembers = async (req: Request, res: Response) => {
    try {
      const callerDid = getCallerDid(res)
      const members = directMembers(
        req.method === 'POST' ? req.body?.members : req.query.members,
        callerDid,
      )
      if (!members) {
        return res.status(400).json({
          error: 'InvalidRequest',
          message:
            'Exactly two distinct actors are required for a direct conversation',
        })
      }
      const recipient = members.find((did) => did !== callerDid)!
      const convoId = await getOrCreateDirectConvo(
        db.pool,
        callerDid,
        recipient,
      )
      const convo = await buildConvoView(db.pool, convoId, callerDid)
      return res.json({ convo })
    } catch (err: any) {
      if (err instanceof ChatForbiddenError) {
        return res
          .status(403)
          .json({ error: 'Forbidden', message: err.message })
      }
      return res.status(500).json({
        error: 'InternalServerError',
        message: err?.message || 'Chat error',
      })
    }
  }

  router.get(
    '/xrpc/chat.bsky.convo.getConvoForMembers',
    handleGetConvoForMembers,
  )
  router.post(
    '/xrpc/chat.bsky.convo.getConvoForMembers',
    handleGetConvoForMembers,
  )

  router.get(
    '/xrpc/chat.bsky.convo.getConvo',
    async (req: Request, res: Response) => {
      try {
        const callerDid = getCallerDid(res)
        const convoId = req.query.convoId as string
        if (!convoId) {
          return res
            .status(400)
            .json({ error: 'InvalidRequest', message: 'convoId is required' })
        }
        // Verify caller is a member before exposing convo data
        await assertMembership(db.pool, convoId, callerDid)
        const convo = await buildConvoView(db.pool, convoId, callerDid)
        if (!convo) {
          return res
            .status(404)
            .json({ error: 'NotFound', message: 'Convo not found' })
        }
        return res.json({ convo })
      } catch (err: unknown) {
        if (err instanceof ChatAuthError) {
          return res
            .status(err.status)
            .json({ error: 'AuthRequired', message: err.message })
        }
        if (err instanceof ChatForbiddenError) {
          return res
            .status(403)
            .json({ error: 'Forbidden', message: err.message })
        }
        const message = err instanceof Error ? err.message : 'Chat error'
        return res.status(500).json({ error: 'InternalServerError', message })
      }
    },
  )

  router.get(
    '/xrpc/chat.bsky.convo.listConvos',
    async (req: Request, res: Response) => {
      try {
        const callerDid = getCallerDid(res)
        const status = req.query.status
        if (
          status !== undefined &&
          status !== 'accepted' &&
          status !== 'request'
        ) {
          return res.status(400).json({
            error: 'InvalidRequest',
            message: 'status must be accepted or request',
          })
        }
        const limit =
          req.query.limit === undefined ? 50 : Number(req.query.limit)
        if (
          (req.query.limit !== undefined &&
            typeof req.query.limit !== 'string') ||
          !Number.isInteger(limit) ||
          limit < 1 ||
          limit > 100
        ) {
          return res.status(400).json({
            error: 'InvalidRequest',
            message: 'limit must be an integer between 1 and 100',
          })
        }
        const kind = req.query.kind
        if (kind !== undefined && kind !== 'direct' && kind !== 'group') {
          return res.status(400).json({
            error: 'InvalidRequest',
            message: 'kind must be direct or group',
          })
        }
        // @NOTE The legacy tables contain accepted memberships only.
        if (status === 'request') return res.json({ convos: [] })
        const convoIds = await getAcceptedConvoIds(
          db.pool,
          callerDid,
          limit,
          kind,
        )
        const convos = await Promise.all(
          convoIds.map((id) => buildConvoView(db.pool, id, callerDid)),
        )

        return res.json({
          convos: convos.filter(Boolean),
        })
      } catch (err: any) {
        return res.status(500).json({
          error: 'InternalServerError',
          message: err?.message || 'Chat error',
        })
      }
    },
  )

  router.get(
    '/xrpc/chat.bsky.convo.getMessages',
    async (req: Request, res: Response) => {
      try {
        const callerDid = getCallerDid(res)
        const convoId = req.query.convoId as string
        const limit = parseInt((req.query.limit as string) || '50', 10)
        if (!convoId) {
          return res
            .status(400)
            .json({ error: 'InvalidRequest', message: 'convoId is required' })
        }

        // Verify caller is member
        const memberCheck = await db.pool.query(
          'SELECT 1 FROM torah_appview.chat_member WHERE convo_id = $1 AND did = $2',
          [convoId, callerDid],
        )
        if (memberCheck.rows.length === 0) {
          return res
            .status(403)
            .json({ error: 'Forbidden', message: 'Not a member of this convo' })
        }

        const msgsRes = await db.pool.query(
          `SELECT id, rev, sender_did, text, facets, embed, sent_at
         FROM torah_appview.chat_message
         WHERE convo_id = $1 AND deleted = false
         ORDER BY sent_at DESC, id DESC LIMIT $2`,
          [convoId, limit],
        )

        const messages = msgsRes.rows.map((m: any) => ({
          $type: 'chat.bsky.convo.defs#messageView',
          id: m.id,
          rev: m.rev,
          text: m.text,
          facets: m.facets || undefined,
          embed: m.embed || undefined,
          sender: { did: m.sender_did },
          sentAt: m.sent_at.toISOString(),
        }))

        return res.json({ messages })
      } catch (err: any) {
        return res.status(500).json({
          error: 'InternalServerError',
          message: err?.message || 'Chat error',
        })
      }
    },
  )

  router.post(
    '/xrpc/chat.bsky.convo.sendMessage',
    async (req: Request, res: Response) => {
      try {
        const callerDid = getCallerDid(res)
        const { convoId, message } = req.body || {}
        if (!convoId || !message?.text) {
          return res.status(400).json({
            error: 'InvalidRequest',
            message: 'convoId and message.text required',
          })
        }

        await assertCanSend(db.pool, convoId, callerDid)

        const msgId = `m_${TID.nextStr()}`
        const rev = TID.nextStr()
        const now = new Date()

        await db.pool.query(
          `INSERT INTO torah_appview.chat_message (id, convo_id, sender_did, rev, text, facets, embed, sent_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            msgId,
            convoId,
            callerDid,
            rev,
            message.text,
            message.facets ? JSON.stringify(message.facets) : null,
            message.embed ? JSON.stringify(message.embed) : null,
            now,
          ],
        )

        await db.pool.query(
          'UPDATE torah_appview.chat_convo SET rev = $1, updated_at = $2 WHERE id = $3',
          [rev, now, convoId],
        )

        const messageView = {
          $type: 'chat.bsky.convo.defs#messageView',
          id: msgId,
          rev,
          text: message.text,
          facets: message.facets || undefined,
          embed: message.embed || undefined,
          sender: { did: callerDid },
          sentAt: now.toISOString(),
        }

        return res.json(messageView)
      } catch (err: any) {
        if (err instanceof ChatForbiddenError) {
          return res
            .status(403)
            .json({ error: 'Forbidden', message: err.message })
        }
        return res.status(500).json({
          error: 'InternalServerError',
          message: err?.message || 'Chat error',
        })
      }
    },
  )

  router.post(
    '/xrpc/chat.bsky.convo.sendMessageBatch',
    async (req: Request, res: Response) => {
      try {
        const callerDid = getCallerDid(res)
        const items: Array<{
          convoId: string
          message: { text: string; facets?: unknown; embed?: unknown }
        }> = req.body?.items || []
        const results: unknown[] = []
        if (
          !Array.isArray(items) ||
          items.some(
            (item) =>
              typeof item?.convoId !== 'string' ||
              !item.convoId ||
              typeof item.message?.text !== 'string' ||
              !item.message.text,
          )
        ) {
          return res.status(400).json({
            error: 'InvalidRequest',
            message: 'Each item requires convoId and message.text',
          })
        }
        // @NOTE Authorize the entire batch before the first write.
        for (const item of items) {
          await assertCanSend(db.pool, item.convoId, callerDid)
        }
        for (const item of items) {
          const { convoId, message } = item
          const msgId = `m_${TID.nextStr()}`
          const rev = TID.nextStr()
          const now = new Date()

          await db.pool.query(
            `INSERT INTO torah_appview.chat_message (id, convo_id, sender_did, rev, text, facets, embed, sent_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              msgId,
              convoId,
              callerDid,
              rev,
              message.text,
              message.facets ? JSON.stringify(message.facets) : null,
              message.embed ? JSON.stringify(message.embed) : null,
              now,
            ],
          )

          await db.pool.query(
            'UPDATE torah_appview.chat_convo SET rev = $1, updated_at = $2 WHERE id = $3',
            [rev, now, convoId],
          )

          results.push({
            $type: 'chat.bsky.convo.defs#messageView',
            id: msgId,
            rev,
            text: message.text,
            facets: message.facets || undefined,
            embed: message.embed || undefined,
            sender: { did: callerDid },
            sentAt: now.toISOString(),
          })
        }

        return res.json({ items: results })
      } catch (err: unknown) {
        if (err instanceof ChatAuthError) {
          return res
            .status(err.status)
            .json({ error: 'AuthRequired', message: err.message })
        }
        if (err instanceof ChatForbiddenError) {
          return res
            .status(403)
            .json({ error: 'Forbidden', message: err.message })
        }
        const message = err instanceof Error ? err.message : 'Chat error'
        return res.status(500).json({ error: 'InternalServerError', message })
      }
    },
  )

  router.post(
    '/xrpc/chat.bsky.convo.updateRead',
    async (req: Request, res: Response) => {
      try {
        const callerDid = getCallerDid(res)
        const { convoId, messageId } = (req.body || {}) as {
          convoId?: string
          messageId?: string
        }
        if (!convoId) {
          return res
            .status(400)
            .json({ error: 'InvalidRequest', message: 'convoId is required' })
        }
        await assertMembership(db.pool, convoId, callerDid)

        let readId: string | null
        if (messageId !== undefined) {
          if (typeof messageId !== 'string' || !messageId) {
            return res.status(400).json({
              error: 'InvalidRequest',
              message: 'messageId must be a non-empty string',
            })
          }
          const message = await db.pool.query(
            'SELECT id FROM torah_appview.chat_message WHERE id = $1 AND convo_id = $2',
            [messageId, convoId],
          )
          if (message.rows.length === 0) {
            return res.status(400).json({
              error: 'InvalidRequest',
              message: 'messageId does not belong to this conversation',
            })
          }
          readId = messageId
        } else {
          const latest = await db.pool.query(
            'SELECT id FROM torah_appview.chat_message WHERE convo_id = $1 ORDER BY sent_at DESC, id DESC LIMIT 1',
            [convoId],
          )
          readId = latest.rows[0]?.id ?? null
        }
        await db.pool.query(
          'UPDATE torah_appview.chat_member SET last_read_message_id = $1 WHERE convo_id = $2 AND did = $3',
          [readId, convoId, callerDid],
        )

        const convo = await buildConvoView(db.pool, convoId, callerDid)
        return res.json({ convo })
      } catch (err: unknown) {
        if (err instanceof ChatAuthError) {
          return res
            .status(err.status)
            .json({ error: 'AuthRequired', message: err.message })
        }
        if (err instanceof ChatForbiddenError) {
          return res
            .status(403)
            .json({ error: 'Forbidden', message: err.message })
        }
        const message = err instanceof Error ? err.message : 'Chat error'
        return res.status(500).json({ error: 'InternalServerError', message })
      }
    },
  )

  router.get('/xrpc/chat.bsky.convo.getLog', (_req: Request, res: Response) => {
    res.json({ logs: [] })
  })

  router.post(
    '/xrpc/chat.bsky.convo.muteConvo',
    async (req: Request, res: Response) => {
      try {
        const callerDid = getCallerDid(res)
        const { convoId } = (req.body || {}) as { convoId?: string }
        if (!convoId) {
          return res
            .status(400)
            .json({ error: 'InvalidRequest', message: 'convoId is required' })
        }
        await assertMembership(db.pool, convoId, callerDid)
        await db.pool.query(
          'UPDATE torah_appview.chat_member SET muted = true WHERE convo_id = $1 AND did = $2',
          [convoId, callerDid],
        )
        const convo = await buildConvoView(db.pool, convoId, callerDid)
        return res.json({ convo })
      } catch (err: unknown) {
        if (err instanceof ChatAuthError) {
          return res
            .status(err.status)
            .json({ error: 'AuthRequired', message: err.message })
        }
        if (err instanceof ChatForbiddenError) {
          return res
            .status(403)
            .json({ error: 'Forbidden', message: err.message })
        }
        const message = err instanceof Error ? err.message : 'Chat error'
        return res.status(500).json({ error: 'InternalServerError', message })
      }
    },
  )

  router.post(
    '/xrpc/chat.bsky.convo.unmuteConvo',
    async (req: Request, res: Response) => {
      try {
        const callerDid = getCallerDid(res)
        const { convoId } = (req.body || {}) as { convoId?: string }
        if (!convoId) {
          return res
            .status(400)
            .json({ error: 'InvalidRequest', message: 'convoId is required' })
        }
        await assertMembership(db.pool, convoId, callerDid)
        await db.pool.query(
          'UPDATE torah_appview.chat_member SET muted = false WHERE convo_id = $1 AND did = $2',
          [convoId, callerDid],
        )
        const convo = await buildConvoView(db.pool, convoId, callerDid)
        return res.json({ convo })
      } catch (err: unknown) {
        if (err instanceof ChatAuthError) {
          return res
            .status(err.status)
            .json({ error: 'AuthRequired', message: err.message })
        }
        if (err instanceof ChatForbiddenError) {
          return res
            .status(403)
            .json({ error: 'Forbidden', message: err.message })
        }
        const message = err instanceof Error ? err.message : 'Chat error'
        return res.status(500).json({ error: 'InternalServerError', message })
      }
    },
  )

  router.post(
    '/xrpc/chat.bsky.convo.leaveConvo',
    async (req: Request, res: Response) => {
      try {
        const callerDid = getCallerDid(res)
        const { convoId } = (req.body || {}) as { convoId?: string }
        if (!convoId) {
          return res
            .status(400)
            .json({ error: 'InvalidRequest', message: 'convoId is required' })
        }
        await assertMembership(db.pool, convoId, callerDid)
        await db.pool.query(
          'DELETE FROM torah_appview.chat_member WHERE convo_id = $1 AND did = $2',
          [convoId, callerDid],
        )
        return res.json({ convoId, rev: TID.nextStr() })
      } catch (err: unknown) {
        if (err instanceof ChatAuthError) {
          return res
            .status(err.status)
            .json({ error: 'AuthRequired', message: err.message })
        }
        if (err instanceof ChatForbiddenError) {
          return res
            .status(403)
            .json({ error: 'Forbidden', message: err.message })
        }
        const message = err instanceof Error ? err.message : 'Chat error'
        return res.status(500).json({ error: 'InternalServerError', message })
      }
    },
  )

  return router
}
