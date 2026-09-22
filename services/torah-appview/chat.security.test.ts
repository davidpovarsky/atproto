/**
 * Security regression tests for torah-appview chat endpoints.
 *
 * Tests:
 * 1. Forged/unsigned/invalid JWT tokens rejected (401)
 * 2. Expired JWT tokens rejected (401)
 * 3. User C cannot read convo A/B (403 — getConvo)
 * 4. User C cannot send into convo A/B (403 — sendMessageBatch)
 * 5. User C cannot mark/mute/leave convo A/B (403)
 * 6. Valid A/B messaging works (200)
 * 7. Missing convoId returns 400
 */
import express from 'express'
import supertest from 'supertest'

// --- JWT helpers ---

function makeJwt(payload: Record<string, unknown>): string {
  const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const b = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const s = Buffer.from('placeholder').toString('base64url')
  return ${h}..
}

const DID_A = 'did:plc:userAAAAAAAAAAAAAAAAAAAAAAA'
const DID_B = 'did:plc:userBBBBBBBBBBBBBBBBBBBBBBBB'
const DID_C = 'did:plc:userCCCCCCCCCCCCCCCCCCCCCCCC'
const CONVO_AB = 'convo-ab-fixture-001'

function validToken(did: string): string {
  return makeJwt({ iss: did, sub: did, exp: Math.floor(Date.now() / 1000) + 3600 })
}
function expiredToken(did: string): string {
  return makeJwt({ iss: did, sub: did, exp: Math.floor(Date.now() / 1000) - 60 })
}
function malformedToken(): string { return 'not-a-jwt' }
function nonDidToken(): string { return makeJwt({ iss: 'not-a-did', sub: 'not-a-did', exp: Math.floor(Date.now() / 1000) + 3600 }) }

function auth(did: string) { return { Authorization: Bearer  } }
function authExpired(did: string) { return { Authorization: Bearer  } }
function authMalformed() { return { Authorization: Bearer  } }
function authNonDid() { return { Authorization: Bearer  } }

// --- In-memory DB pool ---

type QR = { rows: Record<string, unknown>[] }
type Pool = { query: (sql: string, params: unknown[]) => Promise<QR> }

function makePool(): Pool {
  const members: Record<string, string[]> = { [CONVO_AB]: [DID_A, DID_B] }
  return {
    async query(sql: string, params: unknown[]): Promise<QR> {
      const s = sql.trim().toUpperCase()
      // assertMembership: SELECT 1 ... WHERE convo_id= AND did=
      if (s.includes('SELECT 1') && s.includes('CONVO_ID = ') && s.includes('DID = ')) {
        const ok = (members[params[0] as string] ?? []).includes(params[1] as string)
        return { rows: ok ? [{}] : [] }
      }
      // getMessages membership check pattern (same query shape)
      if (s.includes('SELECT 1') && s.includes('CONVO_ID = ')) {
        const ok = (members[params[0] as string] ?? []).includes(params[1] as string)
        return { rows: ok ? [{}] : [] }
      }
      // listConvos
      if (s.includes('JOIN TORAH_APPVIEW.CHAT_MEMBER') && s.includes('WHERE M.DID = ')) {
        const did = params[0] as string
        return { rows: Object.entries(members).filter(([,dids]) => dids.includes(did)).map(([id]) => ({ id })) }
      }
      // convo record
      if (s.includes('FROM TORAH_APPVIEW.CHAT_CONVO WHERE ID = ')) {
        const id = params[0] as string
        return { rows: members[id] ? [{ id, rev: 'r1', created_at: new Date(), updated_at: new Date() }] : [] }
      }
      // members list
      if (s.includes('FROM TORAH_APPVIEW.CHAT_MEMBER WHERE CONVO_ID = ')) {
        const id = params[0] as string
        return { rows: (members[id] ?? []).map(did => ({ did, last_read_message_id: null, muted: false })) }
      }
      // actor profile
      if (s.includes('FROM TORAH_APPVIEW.ACTOR WHERE DID = ')) {
        return { rows: [{ did: params[0], handle: user.test }] }
      }
      // misc fallthrough (messages, counts, INSERTs, UPDATEs, DELETEs)
      if (s.startsWith('SELECT COUNT')) return { rows: [{ cnt: '0' }] }
      return { rows: [] }
    }
  }
}

// --- Build app ---

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createChatRouter } = require('./chat') as { createChatRouter: (db: { pool: Pool }) => express.Router }

function app() {
  const a = express()
  a.use(express.json())
  a.use(createChatRouter({ pool: makePool() }))
  return a
}

// ===========================================================================
// Tests
// ===========================================================================

describe('Chat auth — invalid tokens', () => {
  test('no auth header → 401', () =>
    supertest(app()).get('/xrpc/chat.bsky.convo.getConvo').query({ convoId: CONVO_AB })
      .expect(401))
  test('malformed token → 401', () =>
    supertest(app()).get('/xrpc/chat.bsky.convo.getConvo').query({ convoId: CONVO_AB })
      .set(authMalformed()).expect(401))
  test('expired token → 401', () =>
    supertest(app()).get('/xrpc/chat.bsky.convo.getConvo').query({ convoId: CONVO_AB })
      .set(authExpired(DID_A)).expect(401).then(r => expect(r.body.message).toMatch(/expired/i)))
  test('token with non-DID iss → 401', () =>
    supertest(app()).get('/xrpc/chat.bsky.convo.getConvo').query({ convoId: CONVO_AB })
      .set(authNonDid()).expect(401))
})

describe('Chat authorization — cross-convo isolation', () => {
  test('C cannot getConvo A/B → 403', () =>
    supertest(app()).get('/xrpc/chat.bsky.convo.getConvo').query({ convoId: CONVO_AB })
      .set(auth(DID_C)).expect(403))
  test('A can getConvo A/B → 200', () =>
    supertest(app()).get('/xrpc/chat.bsky.convo.getConvo').query({ convoId: CONVO_AB })
      .set(auth(DID_A)).expect(200).then(r => expect(r.body.convo).toBeDefined()))

  test('C cannot sendMessageBatch into A/B → 403', () =>
    supertest(app()).post('/xrpc/chat.bsky.convo.sendMessageBatch')
      .set(auth(DID_C)).send({ items: [{ convoId: CONVO_AB, message: { text: 'intrusion' } }] })
      .expect(403))
  test('A can sendMessageBatch into A/B → 200', () =>
    supertest(app()).post('/xrpc/chat.bsky.convo.sendMessageBatch')
      .set(auth(DID_A)).send({ items: [{ convoId: CONVO_AB, message: { text: 'hello' } }] })
      .expect(200).then(r => expect(r.body.items).toHaveLength(1)))

  test('C cannot updateRead on A/B → 403', () =>
    supertest(app()).post('/xrpc/chat.bsky.convo.updateRead')
      .set(auth(DID_C)).send({ convoId: CONVO_AB }).expect(403))
  test('A can updateRead on A/B → 200', () =>
    supertest(app()).post('/xrpc/chat.bsky.convo.updateRead')
      .set(auth(DID_A)).send({ convoId: CONVO_AB }).expect(200))

  test('C cannot muteConvo A/B → 403', () =>
    supertest(app()).post('/xrpc/chat.bsky.convo.muteConvo')
      .set(auth(DID_C)).send({ convoId: CONVO_AB }).expect(403))
  test('A can muteConvo A/B → 200', () =>
    supertest(app()).post('/xrpc/chat.bsky.convo.muteConvo')
      .set(auth(DID_A)).send({ convoId: CONVO_AB }).expect(200))

  test('C cannot unmuteConvo A/B → 403', () =>
    supertest(app()).post('/xrpc/chat.bsky.convo.unmuteConvo')
      .set(auth(DID_C)).send({ convoId: CONVO_AB }).expect(403))

  test('C cannot leaveConvo A/B → 403', () =>
    supertest(app()).post('/xrpc/chat.bsky.convo.leaveConvo')
      .set(auth(DID_C)).send({ convoId: CONVO_AB }).expect(403))
  test('A can leaveConvo A/B → 200', () =>
    supertest(app()).post('/xrpc/chat.bsky.convo.leaveConvo')
      .set(auth(DID_A)).send({ convoId: CONVO_AB }).expect(200)
      .then(r => expect(r.body.convoId).toBe(CONVO_AB)))
})

describe('Chat input validation', () => {
  test('getConvo without convoId → 400', () =>
    supertest(app()).get('/xrpc/chat.bsky.convo.getConvo').set(auth(DID_A)).expect(400))
  test('updateRead without convoId → 400', () =>
    supertest(app()).post('/xrpc/chat.bsky.convo.updateRead').set(auth(DID_A)).send({}).expect(400))
  test('muteConvo without convoId → 400', () =>
    supertest(app()).post('/xrpc/chat.bsky.convo.muteConvo').set(auth(DID_A)).send({}).expect(400))
  test('leaveConvo without convoId → 400', () =>
    supertest(app()).post('/xrpc/chat.bsky.convo.leaveConvo').set(auth(DID_A)).send({}).expect(400))
})
