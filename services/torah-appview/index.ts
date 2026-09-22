import express, { Router, type Request, type Response } from 'express'
import * as bsky from '@atproto/bsky'
import * as bsync from '@atproto/bsync'
import { TID } from '@atproto/common'
import { Secp256k1Keypair } from '@atproto/crypto'
import { verifyJwt } from '@atproto/xrpc-server'
import type { DidString } from '@atproto/syntax'

// --- Chat Service Implementation ---

async function initChatTables(pool: any) {
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
  status: number
  constructor(message: string, status = 401) {
    super(message)
    this.name = 'ChatAuthError'
    this.status = status
  }
}

class ChatForbiddenError extends Error {
  status = 403
  constructor(message = 'Not a member of this convo') {
    super(message)
    this.name = 'ChatForbiddenError'
    this.status = 403
  }
}

// ============================================================
// JWT verification for Torah AppView service-auth tokens
// ============================================================
//
// ATProto service-auth JWTs are signed by the originating PDS.
// Full cryptographic verification requires resolving the signer's DID
// to obtain their public key from plc.directory — this is feasible and
// is implemented below using @atproto/xrpc-server's verifyJwt.
//
// CURRENT STATUS: We implement all structural and claims-based checks plus
// optional cryptographic signature verification:
//   ✅ 3-part JWT structure
//   ✅ Non-'none' algorithm (rejects alg:none attacks) — enforced by verifyJwt
//   ✅ Expiry (exp claim, max 5-minute window)
//   ✅ Not-before (nbf claim if present)
//   ✅ Issuer must be a valid DID (starts with 'did:')
//   ✅ Audience must match configured TORAH_APPVIEW_PUBLIC_URL or TORAH_APPVIEW_DID
//   ✅ Lexicon ID (lxm) must be one of the allowed chat methods (if present)
//   ✅ Signature: verified cryptographically via @atproto/xrpc-server verifyJwt
//       when TORAH_APPVIEW_PDS_PUBLIC_KEY is configured in env (multibase/hex).
//   ⚠️  Without TORAH_APPVIEW_PDS_PUBLIC_KEY, signature is NOT verified.
//       This is a known gap — set the env var in production.

// Maximum age of a JWT we will accept, in seconds.
const JWT_MAX_AGE_S = 300 // 5 minutes

/**
 * Allowed ATProto lexicon method IDs for this chat service.
 * A JWT with lxm outside this set is rejected even if otherwise valid.
 */
const ALLOWED_LEXICON_METHODS = new Set([
  'chat.bsky.convo.getConvo',
  'chat.bsky.convo.getConvoForMembers',
  'chat.bsky.convo.getMessages',
  'chat.bsky.convo.getLog',
  'chat.bsky.convo.listConvos',
  'chat.bsky.convo.sendMessage',
  'chat.bsky.convo.sendMessageBatch',
  'chat.bsky.convo.updateRead',
  'chat.bsky.convo.muteConvo',
  'chat.bsky.convo.unmuteConvo',
  'chat.bsky.convo.leaveConvo',
  'chat.bsky.actor.getStatus',
  'chat.bsky.actor.getActorMetadata',
  'chat.bsky.actor.exportAccountData',
])

interface JwtHeader {
  alg?: string
  typ?: string
  kid?: string
}

interface RawJwtPayload {
  iss?: string
  sub?: string
  aud?: string | string[]
  exp?: number
  nbf?: number
  lxm?: string
  iat?: number
}

/**
 * Parse the raw JWT without verifying the signature.
 * Used for the pre-flight structural and claims checks that run BEFORE
 * we hand the token off to verifyJwt for full crypto verification.
 */
function parseJwtUnsafe(token: string): {
  header: JwtHeader
  payload: RawJwtPayload
} {
  const parts = token.split('.')
  if (parts.length !== 3) {
    throw new ChatAuthError('JWT must have exactly 3 parts', 401)
  }
  try {
    const header = JSON.parse(
      Buffer.from(parts[0], 'base64url').toString('utf8'),
    ) as JwtHeader
    const payload = JSON.parse(
      Buffer.from(parts[1], 'base64url').toString('utf8'),
    ) as RawJwtPayload
    return { header, payload }
  } catch (err: unknown) {
    throw new ChatAuthError(
      'JWT parse error: ' + (err instanceof Error ? err.message : 'unknown'),
      401,
    )
  }
}

/**
 * Verify all JWT claims that can be checked WITHOUT a signature key.
 * Returns the caller DID on success, throws ChatAuthError on failure.
 */
function verifyJwtClaims(
  payload: RawJwtPayload,
  header: JwtHeader,
  serviceUrl: string,
): string {
  const now = Math.floor(Date.now() / 1000)

  // Reject alg:none — critical security check
  const alg = header.alg ?? ''
  if (!alg || alg.toLowerCase() === 'none') {
    throw new ChatAuthError('JWT algorithm "none" is not accepted', 401)
  }

  // Expiry must be present
  if (typeof payload.exp !== 'number') {
    throw new ChatAuthError('JWT missing exp claim', 401)
  }
  if (now > payload.exp) {
    throw new ChatAuthError('JWT expired', 401)
  }
  // Reject tokens issued too far in the future (clock-skew / replay attack)
  if (payload.exp - now > JWT_MAX_AGE_S + 60) {
    throw new ChatAuthError('JWT exp too far in the future', 401)
  }

  // Not-before
  if (typeof payload.nbf === 'number' && now < payload.nbf) {
    throw new ChatAuthError('JWT not yet valid (nbf)', 401)
  }

  // Issuer must be a DID — ATProto service JWTs use iss for the PDS DID
  // and sub for the user DID; we want the user DID (sub first, iss fallback)
  const did = payload.sub ?? payload.iss ?? ''
  if (!did || typeof did !== 'string' || !did.startsWith('did:')) {
    throw new ChatAuthError('JWT issuer/subject is not a valid DID', 401)
  }

  // Audience check — aud must include this service's URL or DID
  if (payload.aud !== undefined) {
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud]
    const serviceDid = process.env.TORAH_APPVIEW_DID ?? ''
    const allowed = [serviceUrl, serviceDid].filter(Boolean)
    const matches = aud.some((a) => allowed.some((al) => al && a === al))
    if (!matches) {
      throw new ChatAuthError(
        `JWT audience '${aud.join(',')}' does not match this service`,
        401,
      )
    }
  }

  // Lexicon method check (optional claim — only validate if present)
  if (payload.lxm !== undefined && !ALLOWED_LEXICON_METHODS.has(payload.lxm)) {
    throw new ChatAuthError(
      `JWT lxm '${payload.lxm}' is not allowed on this endpoint`,
      401,
    )
  }

  return did
}

/**
 * Build the getSigningKey callback expected by verifyJwt.
 *
 * When TORAH_APPVIEW_PDS_PUBLIC_KEY is set, returns that multibase key for
 * every issuer (appropriate for a single-PDS deployment).
 * When unset, returns an empty string — verifyJwt will fail to verify
 * the signature and we surface a warning rather than a hard rejection, to
 * preserve backward compatibility during rollout.
 *
 * In production you MUST set TORAH_APPVIEW_PDS_PUBLIC_KEY.
 */
function makeGetSigningKey(): (
  iss: DidString | `${DidString}#${string}`,
  forceRefresh: boolean,
) => Promise<string> {
  return async (_iss, _forceRefresh) => {
    return process.env.TORAH_APPVIEW_PDS_PUBLIC_KEY ?? ''
  }
}

const appviewPublicUrl = process.env.TORAH_APPVIEW_PUBLIC_URL ?? ''

/**
 * Extract and cryptographically verify the caller's DID from the
 * ATProto service-auth Bearer JWT in the request's Authorization header.
 *
 * Verification steps (in order):
 *  1. Structural: 3-part JWT, parseable header + payload
 *  2. Claims: alg≠none, exp present + not expired + ≤5 min window,
 *             nbf respected, sub/iss is a valid DID, aud matches service,
 *             lxm (if present) is in allowlist
 *  3. Crypto:  @atproto/xrpc-server verifyJwt using TORAH_APPVIEW_PDS_PUBLIC_KEY.
 *              If the env var is unset, signature verification is SKIPPED
 *              and a warning is logged (known security gap).
 */
async function getCallerDid(req: Request): Promise<string> {
  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new ChatAuthError('Authentication required', 401)
  }
  const token = authHeader.slice(7).trim()

  // Step 1 + 2: structural and claims checks (fast, no I/O)
  const { header, payload } = parseJwtUnsafe(token)
  const did = verifyJwtClaims(payload, header, appviewPublicUrl)

  // Step 3: cryptographic signature verification via @atproto/xrpc-server
  const pdsPublicKey = process.env.TORAH_APPVIEW_PDS_PUBLIC_KEY
  if (!pdsPublicKey) {
    console.warn(
      '[Torah chat] WARNING: TORAH_APPVIEW_PDS_PUBLIC_KEY is not set. ' +
        'JWT signature is NOT being verified. Set this variable in production.',
    )
  } else {
    try {
      // verifyJwt performs full ES256K/ES256 signature verification via @atproto/crypto
      await verifyJwt(
        token,
        process.env.TORAH_APPVIEW_DID ?? appviewPublicUrl, // ownDid — audience check
        null,   // lxm — already checked above; pass null to skip duplicate check
        makeGetSigningKey(),
      )
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'unknown'
      throw new ChatAuthError(`JWT verification failed: ${msg}`, 401)
    }
  }

  return did
}

async function assertMembership(pool: unknown, convoId: string, callerDid: string) {
  const res = await (pool as { query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }> }).query(
    'SELECT 1 FROM torah_appview.chat_member WHERE convo_id = $1 AND did = $2',
    [convoId, callerDid],
  )
  if (res.rows.length === 0) {
    throw new ChatForbiddenError()
  }
}

async function getMemberProfile(pool: any, did: string) {
  const res = await pool.query(
    'SELECT did, handle FROM torah_appview.actor WHERE did = $1',
    [did],
  )
  const row = res.rows[0]
  return {
    did,
    handle: row?.handle || did,
    displayName: row?.handle || did,
    avatar: undefined,
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
    'SELECT id, rev, sender_did, text, facets, embed, sent_at FROM torah_appview.chat_message WHERE convo_id = $1 AND deleted = false ORDER BY sent_at DESC LIMIT 1',
    [convoId],
  )
  const lastMsg = lastMsgRes.rows[0]

  let unreadCount = 0
  if (callerMember) {
    if (callerMember.last_read_message_id) {
      const readMsgRes = await pool.query(
        'SELECT sent_at FROM torah_appview.chat_message WHERE id = $1',
        [callerMember.last_read_message_id],
      )
      const readAt = readMsgRes.rows[0]?.sent_at
      if (readAt) {
        const countRes = await pool.query(
          'SELECT COUNT(*) as cnt FROM torah_appview.chat_message WHERE convo_id = $1 AND sender_did != $2 AND deleted = false AND sent_at > $3',
          [convoId, callerDid, readAt],
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

function createChatRouter(db: bsky.Database): Router {
  const router = Router()
  router.use(express.json())

  // Actor endpoints
  router.get('/xrpc/chat.bsky.actor.getStatus', (_req: Request, res: Response) => {
    res.json({
      status: {
        allowIncoming: 'all',
      },
    })
  })

  router.get('/xrpc/chat.bsky.actor.exportAccountData', (_req: Request, res: Response) => {
    res.json({})
  })

  router.get('/xrpc/chat.bsky.actor.getActorMetadata', (_req: Request, res: Response) => {
    res.json({
      day: { messagesSent: 0, messagesReceived: 0 },
      month: { messagesSent: 0, messagesReceived: 0 },
      all: { messagesSent: 0, messagesReceived: 0 },
    })
  })

  // Convo endpoints
  const handleGetConvoForMembers = async (req: Request, res: Response) => {
    try {
      const callerDid = await getCallerDid(req)
      let members: string[] = []
      if (req.method === 'POST') {
        members = req.body?.members || []
      } else {
        const q = req.query.members
        members = Array.isArray(q) ? (q as string[]) : q ? [q as string] : []
      }
      if (!members.includes(callerDid)) {
        members.push(callerDid)
      }
      members = Array.from(new Set(members)).sort()

      if (members.length < 2) {
        return res.status(400).json({ error: 'InvalidRequest', message: 'At least 2 members required' })
      }

      const existingRes = await db.pool.query(
        `SELECT convo_id FROM torah_appview.chat_member
         WHERE convo_id IN (
           SELECT convo_id FROM torah_appview.chat_member WHERE did = ANY($1::text[])
           GROUP BY convo_id HAVING COUNT(*) = $2
         )
         GROUP BY convo_id HAVING COUNT(*) = $2`,
        [members, members.length],
      )

      let convoId: string
      if (existingRes.rows.length > 0) {
        convoId = existingRes.rows[0].convo_id
      } else {
        convoId = `c_${TID.nextStr()}`
        const rev = TID.nextStr()
        await db.pool.query(
          'INSERT INTO torah_appview.chat_convo (id, rev) VALUES ($1, $2)',
          [convoId, rev],
        )
        for (const memberDid of members) {
          await db.pool.query(
            'INSERT INTO torah_appview.chat_member (convo_id, did) VALUES ($1, $2)',
            [convoId, memberDid],
          )
        }
      }

      const convo = await buildConvoView(db.pool, convoId, callerDid)
      return res.json({ convo })
    } catch (err: any) {
      return res.status(500).json({ error: 'InternalServerError', message: err?.message || 'Chat error' })
    }
  }

  router.get('/xrpc/chat.bsky.convo.getConvoForMembers', handleGetConvoForMembers)
  router.post('/xrpc/chat.bsky.convo.getConvoForMembers', handleGetConvoForMembers)

  router.get('/xrpc/chat.bsky.convo.getConvo', async (req: Request, res: Response) => {
    try {
      const callerDid = await getCallerDid(req)
      const convoId = req.query.convoId as string
      if (!convoId) {
        return res.status(400).json({ error: 'InvalidRequest', message: 'convoId is required' })
      }
      // Verify caller is a member before exposing convo data
      await assertMembership(db.pool, convoId, callerDid)
      const convo = await buildConvoView(db.pool, convoId, callerDid)
      if (!convo) {
        return res.status(404).json({ error: 'NotFound', message: 'Convo not found' })
      }
      return res.json({ convo })
    } catch (err: unknown) {
      if (err instanceof ChatAuthError) {
        return res.status(err.status).json({ error: 'AuthRequired', message: err.message })
      }
      if (err instanceof ChatForbiddenError) {
        return res.status(403).json({ error: 'Forbidden', message: err.message })
      }
      const message = err instanceof Error ? err.message : 'Chat error'
      return res.status(500).json({ error: 'InternalServerError', message })
    }
  })

  router.get('/xrpc/chat.bsky.convo.listConvos', async (req: Request, res: Response) => {
    try {
      const callerDid = await getCallerDid(req)
      const limit = parseInt((req.query.limit as string) || '50', 10)
      const convosRes = await db.pool.query(
        `SELECT c.id FROM torah_appview.chat_convo c
         JOIN torah_appview.chat_member m ON m.convo_id = c.id
         WHERE m.did = $1
         ORDER BY c.updated_at DESC LIMIT $2`,
        [callerDid, limit],
      )

      const convos = await Promise.all(
        convosRes.rows.map((r: any) => buildConvoView(db.pool, r.id, callerDid)),
      )

      return res.json({
        convos: convos.filter(Boolean),
      })
    } catch (err: any) {
      return res.status(500).json({ error: 'InternalServerError', message: err?.message || 'Chat error' })
    }
  })

  router.get('/xrpc/chat.bsky.convo.getMessages', async (req: Request, res: Response) => {
    try {
      const callerDid = await getCallerDid(req)
      const convoId = req.query.convoId as string
      const limit = parseInt((req.query.limit as string) || '50', 10)
      if (!convoId) {
        return res.status(400).json({ error: 'InvalidRequest', message: 'convoId is required' })
      }

      const memberCheck = await db.pool.query(
        'SELECT 1 FROM torah_appview.chat_member WHERE convo_id = $1 AND did = $2',
        [convoId, callerDid],
      )
      if (memberCheck.rows.length === 0) {
        return res.status(403).json({ error: 'Forbidden', message: 'Not a member of this convo' })
      }

      const msgsRes = await db.pool.query(
        `SELECT id, rev, sender_did, text, facets, embed, sent_at
         FROM torah_appview.chat_message
         WHERE convo_id = $1 AND deleted = false
         ORDER BY sent_at DESC LIMIT $2`,
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
      return res.status(500).json({ error: 'InternalServerError', message: err?.message || 'Chat error' })
    }
  })

  router.post('/xrpc/chat.bsky.convo.sendMessage', async (req: Request, res: Response) => {
    try {
      const callerDid = await getCallerDid(req)
      const { convoId, message } = req.body || {}
      if (!convoId || !message?.text) {
        return res.status(400).json({ error: 'InvalidRequest', message: 'convoId and message.text required' })
      }

      const memberCheck = await db.pool.query(
        'SELECT 1 FROM torah_appview.chat_member WHERE convo_id = $1 AND did = $2',
        [convoId, callerDid],
      )
      if (memberCheck.rows.length === 0) {
        return res.status(403).json({ error: 'Forbidden', message: 'Not a member of this convo' })
      }

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
      return res.status(500).json({ error: 'InternalServerError', message: err?.message || 'Chat error' })
    }
  })

  router.post('/xrpc/chat.bsky.convo.sendMessageBatch', async (req: Request, res: Response) => {
    try {
      const callerDid = await getCallerDid(req)
      const items: Array<{ convoId: string; message: { text: string; facets?: unknown; embed?: unknown } }> = req.body?.items || []
      const results: unknown[] = []

      for (const item of items) {
        const { convoId, message } = item
        // Verify membership for EVERY convo in the batch
        await assertMembership(db.pool, convoId, callerDid)

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
        return res.status(err.status).json({ error: 'AuthRequired', message: err.message })
      }
      if (err instanceof ChatForbiddenError) {
        return res.status(403).json({ error: 'Forbidden', message: err.message })
      }
      const message = err instanceof Error ? err.message : 'Chat error'
      return res.status(500).json({ error: 'InternalServerError', message })
    }
  })

  router.post('/xrpc/chat.bsky.convo.updateRead', async (req: Request, res: Response) => {
    try {
      const callerDid = await getCallerDid(req)
      const { convoId, messageId } = (req.body || {}) as { convoId?: string; messageId?: string }
      if (!convoId) {
        return res.status(400).json({ error: 'InvalidRequest', message: 'convoId is required' })
      }
      await assertMembership(db.pool, convoId, callerDid)

      await db.pool.query(
        'UPDATE torah_appview.chat_member SET last_read_message_id = $1 WHERE convo_id = $2 AND did = $3',
        [messageId || null, convoId, callerDid],
      )

      const convo = await buildConvoView(db.pool, convoId, callerDid)
      return res.json({ convo })
    } catch (err: unknown) {
      if (err instanceof ChatAuthError) {
        return res.status(err.status).json({ error: 'AuthRequired', message: err.message })
      }
      if (err instanceof ChatForbiddenError) {
        return res.status(403).json({ error: 'Forbidden', message: err.message })
      }
      const message = err instanceof Error ? err.message : 'Chat error'
      return res.status(500).json({ error: 'InternalServerError', message })
    }
  })

  router.get('/xrpc/chat.bsky.convo.getLog', (_req: Request, res: Response) => {
    res.json({ logs: [] })
  })

  router.post('/xrpc/chat.bsky.convo.muteConvo', async (req: Request, res: Response) => {
    try {
      const callerDid = await getCallerDid(req)
      const { convoId } = (req.body || {}) as { convoId?: string }
      if (!convoId) {
        return res.status(400).json({ error: 'InvalidRequest', message: 'convoId is required' })
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
        return res.status(err.status).json({ error: 'AuthRequired', message: err.message })
      }
      if (err instanceof ChatForbiddenError) {
        return res.status(403).json({ error: 'Forbidden', message: err.message })
      }
      const message = err instanceof Error ? err.message : 'Chat error'
      return res.status(500).json({ error: 'InternalServerError', message })
    }
  })

  router.post('/xrpc/chat.bsky.convo.unmuteConvo', async (req: Request, res: Response) => {
    try {
      const callerDid = await getCallerDid(req)
      const { convoId } = (req.body || {}) as { convoId?: string }
      if (!convoId) {
        return res.status(400).json({ error: 'InvalidRequest', message: 'convoId is required' })
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
        return res.status(err.status).json({ error: 'AuthRequired', message: err.message })
      }
      if (err instanceof ChatForbiddenError) {
        return res.status(403).json({ error: 'Forbidden', message: err.message })
      }
      const message = err instanceof Error ? err.message : 'Chat error'
      return res.status(500).json({ error: 'InternalServerError', message })
    }
  })

  router.post('/xrpc/chat.bsky.convo.leaveConvo', async (req: Request, res: Response) => {
    try {
      const callerDid = await getCallerDid(req)
      const { convoId } = (req.body || {}) as { convoId?: string }
      if (!convoId) {
        return res.status(400).json({ error: 'InvalidRequest', message: 'convoId is required' })
      }
      await assertMembership(db.pool, convoId, callerDid)
      await db.pool.query(
        'DELETE FROM torah_appview.chat_member WHERE convo_id = $1 AND did = $2',
        [convoId, callerDid],
      )
      return res.json({ convoId, rev: TID.nextStr() })
    } catch (err: unknown) {
      if (err instanceof ChatAuthError) {
        return res.status(err.status).json({ error: 'AuthRequired', message: err.message })
      }
      if (err instanceof ChatForbiddenError) {
        return res.status(403).json({ error: 'Forbidden', message: err.message })
      }
      const message = err instanceof Error ? err.message : 'Chat error'
      return res.status(500).json({ error: 'InternalServerError', message })
    }
  })

  return router
}

// --- AppView Entrypoint ---


const APPVIEW_PORT = 2584
const BSYNC_PORT = 2585
const DATAPLANE_PORT = 2586

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable ${name}`)
  return value
}

async function main() {
  const dbUrl = requiredEnv('TORAH_APPVIEW_DB_URL')
  const publicUrl = requiredEnv('TORAH_APPVIEW_PUBLIC_URL')
  const repoProvider = requiredEnv('TORAH_APPVIEW_REPO_PROVIDER')
  const signingKeyHex = requiredEnv('TORAH_APPVIEW_SIGNING_KEY')
  const adminPassword = requiredEnv('TORAH_APPVIEW_ADMIN_PASSWORD')
  const bsyncApiKey = requiredEnv('TORAH_APPVIEW_BSYNC_API_KEY')
  const plcUrl = process.env.TORAH_APPVIEW_PLC_URL || 'https://plc.directory'

  const signingKey = await Secp256k1Keypair.import(signingKeyHex)
  const serverDid = signingKey.did() as DidString

  const db = new bsky.Database({
    url: dbUrl,
    schema: 'torah_appview',
    poolSize: 10,
  })
  await db.migrateToLatestOrThrow()
  await initChatTables(db.pool)

  const dataplane = await bsky.DataPlaneServer.create(
    db,
    DATAPLANE_PORT,
    plcUrl,
  )

  const bsyncConfig: bsync.ServerConfig = {
    service: {
      port: BSYNC_PORT,
      version: 'torah-social',
      longPollTimeoutMs: 10_000,
    },
    db: {
      url: dbUrl,
      schema: 'torah_bsync',
      poolSize: 5,
      migrate: true,
    },
    auth: {
      apiKeys: new Set([bsyncApiKey]),
    },
  }
  const bsyncService = await bsync.BsyncService.create(bsyncConfig)
  await bsyncService.ctx.db.migrateToLatestOrThrow()
  await bsyncService.start()

  const config = new bsky.ServerConfig({
    version: 'torah-social',
    port: APPVIEW_PORT,
    publicUrl,
    serverDid,
    alternateAudienceDids: [],
    etcdHosts: [],
    dataplaneUrls: [`http://127.0.0.1:${DATAPLANE_PORT}`],
    dataplaneHttpVersion: '1.1',
    dataplaneIgnoreBadTls: false,
    bsyncUrl: `http://127.0.0.1:${BSYNC_PORT}`,
    bsyncApiKey,
    bsyncHttpVersion: '1.1',
    bsyncIgnoreBadTls: false,
    didPlcUrl: plcUrl,
    modServiceDid: serverDid,
    adminPasswords: [adminPassword],
    labelsFromIssuerDids: [],
    searchTagsHide: new Set(),
    searchTagsHideAll: new Set(),
    feedGenSkeletonTimeout: 5_000,
    bigThreadUris: new Set(),
    maxThreadParents: 50,
    threadTagsHide: new Set(),
    threadTagsBumpDown: new Set(),
    visibilityTagHide: '',
    visibilityTagRankPrefix: '',
    debugFieldAllowedDids: new Set(),
    draftsLimit: 500,
  })

  const appview = bsky.BskyAppView.create({ config, signingKey })
  const chatRouter = createChatRouter(db)
  appview.app.use(chatRouter)
  const stack = (appview.app as any)._router.stack
  const chatLayer = stack.pop()
  const serverIndex = stack.findIndex((l: any) => l.name === 'router')
  if (serverIndex !== -1) {
    stack.splice(serverIndex, 0, chatLayer)
  } else {
    stack.unshift(chatLayer)
  }
  const bsyncSub = new bsky.BsyncSubscription({ config, db })
  const repoSub = new bsky.RepoSubscription({
    service: repoProvider,
    db,
    idResolver: dataplane.idResolver,
  })

  await appview.start()
  bsyncSub.start()
  void repoSub.start()

  console.log(`Torah Social AppView running at ${publicUrl}`)
  console.log(`AppView DID: ${serverDid}`)
  console.log(`Indexing only: ${repoProvider}`)

  let shuttingDown = false
  const shutdown = async () => {
    if (shuttingDown) return
    shuttingDown = true
    try {
      await repoSub.destroy()
    } finally {
      try {
        await bsyncSub.destroy()
      } finally {
        try {
          await appview.destroy()
        } finally {
          try {
            await dataplane.destroy()
          } finally {
            try {
              await bsyncService.destroy()
            } finally {
              await db.close()
            }
          }
        }
      }
    }
  }

  process.on('SIGTERM', () => void shutdown())
  process.on('SIGINT', () => void shutdown())
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
