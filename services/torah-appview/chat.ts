import express, { Router, type Request, type Response } from 'express'
import { TID } from '@atproto/common'
import type { Database } from '@atproto/bsky'

export async function initChatTables(pool: any) {
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

function getCallerDid(req: Request): string {
  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new Error('Authentication required')
  }
  const token = authHeader.slice(7).trim()
  try {
    const parts = token.split('.')
    if (parts.length < 2) throw new Error('Invalid JWT format')
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    const did = (payload.iss || payload.sub) as string
    if (!did || typeof did !== 'string' || !did.startsWith('did:')) {
      throw new Error('Invalid token issuer')
    }
    return did
  } catch (err: any) {
    throw new Error('Invalid auth token: ' + (err?.message || 'unknown'))
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

export function createChatRouter(db: Database): Router {
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
      const callerDid = getCallerDid(req)
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

      // Check if convo already exists with these exact members
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
      const callerDid = getCallerDid(req)
      const convoId = req.query.convoId as string
      if (!convoId) {
        return res.status(400).json({ error: 'InvalidRequest', message: 'convoId is required' })
      }
      const convo = await buildConvoView(db.pool, convoId, callerDid)
      if (!convo) {
        return res.status(404).json({ error: 'NotFound', message: 'Convo not found' })
      }
      return res.json({ convo })
    } catch (err: any) {
      return res.status(500).json({ error: 'InternalServerError', message: err?.message || 'Chat error' })
    }
  })

  router.get('/xrpc/chat.bsky.convo.listConvos', async (req: Request, res: Response) => {
    try {
      const callerDid = getCallerDid(req)
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
      const callerDid = getCallerDid(req)
      const convoId = req.query.convoId as string
      const limit = parseInt((req.query.limit as string) || '50', 10)
      if (!convoId) {
        return res.status(400).json({ error: 'InvalidRequest', message: 'convoId is required' })
      }

      // Verify caller is member
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
      const callerDid = getCallerDid(req)
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
      const callerDid = getCallerDid(req)
      const items = req.body?.items || []
      const results: any[] = []

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
    } catch (err: any) {
      return res.status(500).json({ error: 'InternalServerError', message: err?.message || 'Chat error' })
    }
  })

  router.post('/xrpc/chat.bsky.convo.updateRead', async (req: Request, res: Response) => {
    try {
      const callerDid = getCallerDid(req)
      const { convoId, messageId } = req.body || {}
      if (!convoId) {
        return res.status(400).json({ error: 'InvalidRequest', message: 'convoId is required' })
      }

      await db.pool.query(
        'UPDATE torah_appview.chat_member SET last_read_message_id = $1 WHERE convo_id = $2 AND did = $3',
        [messageId || null, convoId, callerDid],
      )

      const convo = await buildConvoView(db.pool, convoId, callerDid)
      return res.json({ convo })
    } catch (err: any) {
      return res.status(500).json({ error: 'InternalServerError', message: err?.message || 'Chat error' })
    }
  })

  router.get('/xrpc/chat.bsky.convo.getLog', (_req: Request, res: Response) => {
    res.json({ logs: [] })
  })

  router.post('/xrpc/chat.bsky.convo.muteConvo', async (req: Request, res: Response) => {
    try {
      const callerDid = getCallerDid(req)
      const { convoId } = req.body || {}
      await db.pool.query(
        'UPDATE torah_appview.chat_member SET muted = true WHERE convo_id = $1 AND did = $2',
        [convoId, callerDid],
      )
      const convo = await buildConvoView(db.pool, convoId, callerDid)
      return res.json({ convo })
    } catch (err: any) {
      return res.status(500).json({ error: 'InternalServerError', message: err?.message || 'Chat error' })
    }
  })

  router.post('/xrpc/chat.bsky.convo.unmuteConvo', async (req: Request, res: Response) => {
    try {
      const callerDid = getCallerDid(req)
      const { convoId } = req.body || {}
      await db.pool.query(
        'UPDATE torah_appview.chat_member SET muted = false WHERE convo_id = $1 AND did = $2',
        [convoId, callerDid],
      )
      const convo = await buildConvoView(db.pool, convoId, callerDid)
      return res.json({ convo })
    } catch (err: any) {
      return res.status(500).json({ error: 'InternalServerError', message: err?.message || 'Chat error' })
    }
  })

  router.post('/xrpc/chat.bsky.convo.leaveConvo', async (req: Request, res: Response) => {
    try {
      const callerDid = getCallerDid(req)
      const { convoId } = req.body || {}
      await db.pool.query(
        'DELETE FROM torah_appview.chat_member WHERE convo_id = $1 AND did = $2',
        [convoId, callerDid],
      )
      return res.json({ convoId, rev: TID.nextStr() })
    } catch (err: any) {
      return res.status(500).json({ error: 'InternalServerError', message: err?.message || 'Chat error' })
    }
  })

  return router
}
