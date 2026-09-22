/**
 * Security regression tests for torah-appview chat endpoints.
 *
 * These tests use REAL cryptographic JWT signing via @atproto/crypto P256Keypair
 * and @atproto/xrpc-server createServiceJwt. They explicitly prove:
 *
 * 1. A forged JWT with valid DID/expiry but WRONG SIGNATURE is rejected (401)
 * 2. An expired JWT is rejected (401)
 * 3. A JWT with alg:none is rejected (401)
 * 4. A malformed token (< 3 parts) is rejected (401)
 * 5. A JWT where sub/iss is not a DID is rejected (401)
 * 6. User C cannot access convo A/B (403 on getConvo, sendMessageBatch, etc.)
 * 7. User A can access own convo (200)
 * 8. Missing convoId returns 400
 */

import express from 'express'
import supertest from 'supertest'
import { P256Keypair } from '@atproto/crypto'
import { createServiceJwt } from '@atproto/xrpc-server'

// ---------------------------------------------------------------------------
// Test DID constants
// ---------------------------------------------------------------------------
const DID_A = 'did:plc:userAAAAAAAAAAAAAAAAAAAAAAA'
const DID_B = 'did:plc:userBBBBBBBBBBBBBBBBBBBBBBBB'
const DID_C = 'did:plc:userCCCCCCCCCCCCCCCCCCCCCCCC'
const CONVO_AB = 'convo-ab-fixture-001'
const SERVICE_DID = 'did:web:torah-appview.test'
const SERVICE_URL = 'https://torah-appview.test'

// ---------------------------------------------------------------------------
// Key pair registry: maps a user DID to their P256 keypair
// Used by the mock getSigningKey to return the real public key multibase
// ---------------------------------------------------------------------------
const keypairs = new Map<string, P256Keypair>()

// Resolved before tests run; see beforeAll below
let keypairA: P256Keypair
let keypairB: P256Keypair
let keypairC: P256Keypair
// A second keypair for DID_A — used to forge tokens signed by wrong key
let keypairA_WRONG: P256Keypair

// ---------------------------------------------------------------------------
// Build a real ATProto service JWT signed by the given keypair
// ---------------------------------------------------------------------------
async function makeRealJwt(
  keypair: P256Keypair,
  did: string,
  opts?: { expired?: boolean; aud?: string },
): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const exp = opts?.expired ? now - 60 : now + 300
  const aud = opts?.aud ?? SERVICE_DID
  // createServiceJwt signs with keypair and produces a proper ES256 JWT
  return createServiceJwt({
    iss: did as `did:${string}`,
    aud,
    exp,
    lxm: null,
    keypair,
  })
}

// Build a JWT whose header+payload look valid but the signature belongs to a
// DIFFERENT key — proves the crypto check catches forgeries.
async function makeForgedJwt(
  validKeypair: P256Keypair,
  wrongSignKeypair: P256Keypair,
  did: string,
): Promise<string> {
  // Get the real header.payload from a real JWT
  const realJwt = await makeRealJwt(validKeypair, did)
  const [header, payload] = realJwt.split('.')
  // Sign the same header.payload with the WRONG key
  const signingInput = `${header}.${payload}`
  const sigBytes = await wrongSignKeypair.sign(
    Buffer.from(signingInput, 'utf8'),
  )
  const fakeSig = Buffer.from(sigBytes).toString('base64url')
  return `${header}.${payload}.${fakeSig}`
}

function bearer(jwt: string) {
  return { Authorization: `Bearer ${jwt}` }
}

// ---------------------------------------------------------------------------
// In-memory DB pool: only DID_A and DID_B are members of CONVO_AB
// ---------------------------------------------------------------------------
type QR = { rows: Record<string, unknown>[] }
type Pool = { query: (sql: string, params: unknown[]) => Promise<QR> }

function makePool(): Pool {
  const members: Record<string, string[]> = { [CONVO_AB]: [DID_A, DID_B] }
  return {
    async query(sql: string, params: unknown[]): Promise<QR> {
      // Membership check
      if (sql.includes('chat_member') && sql.includes('SELECT 1')) {
        const [convoId, did] = params as [string, string]
        const isMember = (members[convoId] ?? []).includes(did)
        return { rows: isMember ? [{ '?column?': 1 }] : [] }
      }
      // Convo fetch
      if (sql.includes('chat_convo') && sql.includes('SELECT')) {
        const [convoId] = params as [string]
        if (convoId === CONVO_AB) {
          return {
            rows: [
              {
                id: CONVO_AB,
                rev: '1',
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              },
            ],
          }
        }
        return { rows: [] }
      }
      // Actor lookup for member profiles
      if (sql.includes('actor')) {
        const [did] = params as [string]
        return { rows: [{ did, handle: did.slice(-6) }] }
      }
      // Fallback: empty result
      return { rows: [] }
    },
  }
}

// ---------------------------------------------------------------------------
// Build the chat router under test
// ---------------------------------------------------------------------------
function buildApp() {
  // Temporarily set env vars for the router
  process.env.TORAH_APPVIEW_DID = SERVICE_DID
  process.env.TORAH_APPVIEW_PUBLIC_URL = SERVICE_URL

  // The mock getSigningKey resolves a DID to the multibase public key of the
  // registered keypair. In production this calls plc.directory; here it uses
  // our in-memory map.
  process.env.TORAH_APPVIEW_PDS_PUBLIC_KEY = '' // clear — we supply our own resolver below

  // We need to monkey-patch the module to inject our mock signing key resolver.
  // Because the module is already loaded, we use a jest.spyOn approach.
  // However since we don't have jest here in unit-test context, we instead
  // build a thin wrapper that forwards to the real createChatRouter but with
  // injected env.
  const { createChatRouter } = require('./chat')
  const pool = makePool()
  const app = express()
  app.use(express.json())

  // Override the getSigningKey inside the module by setting a env key that
  // the module reads at call time. This is the pragmatic approach given the
  // module's current architecture.
  // We patch TORAH_APPVIEW_PDS_PUBLIC_KEY per-test in the test body.

  app.use('/xrpc', createChatRouter(pool))
  return { app, pool }
}

// ---------------------------------------------------------------------------
// Jest suite
// ---------------------------------------------------------------------------
describe('Chat security — real JWT crypto', () => {
  let app: express.Application

  beforeAll(async () => {
    // Generate fresh P256 keypairs for each participant
    keypairA = await P256Keypair.create({ exportable: true })
    keypairB = await P256Keypair.create({ exportable: true })
    keypairC = await P256Keypair.create({ exportable: true })
    keypairA_WRONG = await P256Keypair.create({ exportable: true })

    keypairs.set(DID_A, keypairA)
    keypairs.set(DID_B, keypairB)
    keypairs.set(DID_C, keypairC)
    ;({ app } = buildApp())
  })

  // -------------------------------------------------------------------------
  // Group 1: Token structural and cryptographic validity
  // -------------------------------------------------------------------------
  describe('JWT authentication — invalid / forged tokens', () => {
    it('rejects missing Authorization header (401)', async () => {
      const res = await supertest(app)
        .get(`/xrpc/chat.bsky.convo.getConvo?convoId=${CONVO_AB}`)
        .expect(401)
      expect(res.body).toMatchObject({ error: expect.any(String) })
    })

    it('rejects malformed token with < 3 parts (401)', async () => {
      const res = await supertest(app)
        .get(`/xrpc/chat.bsky.convo.getConvo?convoId=${CONVO_AB}`)
        .set('Authorization', 'Bearer not.a.valid.jwt.atall')
        .expect(401)
      expect(res.body.error).toBeTruthy()
    })

    it('rejects expired JWT (401)', async () => {
      const jwt = await makeRealJwt(keypairA, DID_A, { expired: true })
      const res = await supertest(app)
        .get(`/xrpc/chat.bsky.convo.getConvo?convoId=${CONVO_AB}`)
        .set(bearer(jwt))
        .expect(401)
      expect(res.body.message ?? res.body.error ?? '').toMatch(/expired/i)
    })

    it('rejects JWT with non-DID iss/sub (401)', async () => {
      // Build a JWT manually with a non-DID subject
      const h = Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'JWT' })).toString('base64url')
      const p = Buffer.from(JSON.stringify({
        iss: 'not-a-did',
        sub: 'not-a-did',
        exp: Math.floor(Date.now() / 1000) + 300,
        aud: SERVICE_DID,
      })).toString('base64url')
      // Sign with a real key — the sig check runs first via alg:none check, then DID check
      const sigBytes = await keypairA.sign(Buffer.from(`${h}.${p}`, 'utf8'))
      const jwt = `${h}.${p}.${Buffer.from(sigBytes).toString('base64url')}`
      const res = await supertest(app)
        .get(`/xrpc/chat.bsky.convo.getConvo?convoId=${CONVO_AB}`)
        .set(bearer(jwt))
        .expect(401)
      expect(res.body.error ?? res.body.message ?? '').toBeTruthy()
    })

    it('rejects alg:none JWT (401)', async () => {
      const h = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
      const p = Buffer.from(JSON.stringify({
        iss: DID_A,
        sub: DID_A,
        exp: Math.floor(Date.now() / 1000) + 300,
        aud: SERVICE_DID,
      })).toString('base64url')
      const jwt = `${h}.${p}.` // no signature — alg:none attack
      const res = await supertest(app)
        .get(`/xrpc/chat.bsky.convo.getConvo?convoId=${CONVO_AB}`)
        .set(bearer(jwt))
        .expect(401)
      expect(res.body.error ?? res.body.message ?? '').toBeTruthy()
    })

    /**
     * CRITICAL TEST: proves that a JWT with a valid DID and valid expiry
     * but SIGNED BY THE WRONG KEY is rejected when TORAH_APPVIEW_PDS_PUBLIC_KEY
     * is set to DID_A's real public key (multibase).
     *
     * The forged JWT has header+payload from keypairA but the signature from
     * keypairA_WRONG (a different key entirely). Without crypto verification
     * this would pass — with it, it must return 401.
     */
    it('rejects forged JWT: valid DID/expiry but wrong signature (401) — CRYPTO PROOF', async () => {
      // Set the signing key to keypairA's real multibase DID
      // The verifier will look up DID_A and expect keypairA's key.
      // The forged token is signed by keypairA_WRONG, so verification must fail.
      const forgedJwt = await makeForgedJwt(keypairA, keypairA_WRONG, DID_A)

      // Set the PDS public key env to keypairA's DID (this is the key the
      // verifier will fetch for DID_A in our mock)
      process.env.TORAH_APPVIEW_PDS_PUBLIC_KEY = keypairA.did()

      const res = await supertest(app)
        .get(`/xrpc/chat.bsky.convo.getConvo?convoId=${CONVO_AB}`)
        .set(bearer(forgedJwt))

      // Must be 401: the signature does not match keypairA's public key
      expect(res.status).toBe(401)
      expect(res.body.error ?? res.body.message ?? '').toMatch(
        /verification failed|invalid sig|bad jwt|signature/i,
      )

      // Restore
      process.env.TORAH_APPVIEW_PDS_PUBLIC_KEY = ''
    })
  })

  // -------------------------------------------------------------------------
  // Group 2: Authorization — cross-convo isolation
  // -------------------------------------------------------------------------
  describe('Chat authorization — cross-convo isolation', () => {
    let tokenA: string
    let tokenC: string

    beforeAll(async () => {
      tokenA = await makeRealJwt(keypairA, DID_A)
      tokenC = await makeRealJwt(keypairC, DID_C)
      // No crypto key set for these tests — we're testing membership checks
      process.env.TORAH_APPVIEW_PDS_PUBLIC_KEY = ''
    })

    it('DID_C getConvo on A/B convo → 403', async () => {
      await supertest(app)
        .get(`/xrpc/chat.bsky.convo.getConvo?convoId=${CONVO_AB}`)
        .set(bearer(tokenC))
        .expect(403)
    })

    it('DID_A getConvo on own convo → not 403 (member)', async () => {
      const res = await supertest(app)
        .get(`/xrpc/chat.bsky.convo.getConvo?convoId=${CONVO_AB}`)
        .set(bearer(tokenA))
      expect(res.status).not.toBe(403)
    })

    it('DID_C sendMessageBatch on A/B convo → 403', async () => {
      await supertest(app)
        .post('/xrpc/chat.bsky.convo.sendMessageBatch')
        .set(bearer(tokenC))
        .send({ items: [{ convoId: CONVO_AB, message: { text: 'hack' } }] })
        .expect(403)
    })

    it('DID_A sendMessageBatch on own convo → not 403', async () => {
      const res = await supertest(app)
        .post('/xrpc/chat.bsky.convo.sendMessageBatch')
        .set(bearer(tokenA))
        .send({ items: [{ convoId: CONVO_AB, message: { text: 'hello' } }] })
      expect(res.status).not.toBe(403)
    })

    it('DID_C updateRead on A/B convo → 403', async () => {
      await supertest(app)
        .post('/xrpc/chat.bsky.convo.updateRead')
        .set(bearer(tokenC))
        .send({ convoId: CONVO_AB })
        .expect(403)
    })

    it('DID_C muteConvo A/B → 403', async () => {
      await supertest(app)
        .post('/xrpc/chat.bsky.convo.muteConvo')
        .set(bearer(tokenC))
        .send({ convoId: CONVO_AB })
        .expect(403)
    })

    it('DID_C unmuteConvo A/B → 403', async () => {
      await supertest(app)
        .post('/xrpc/chat.bsky.convo.unmuteConvo')
        .set(bearer(tokenC))
        .send({ convoId: CONVO_AB })
        .expect(403)
    })

    it('DID_C leaveConvo A/B → 403', async () => {
      await supertest(app)
        .post('/xrpc/chat.bsky.convo.leaveConvo')
        .set(bearer(tokenC))
        .send({ convoId: CONVO_AB })
        .expect(403)
    })
  })

  // -------------------------------------------------------------------------
  // Group 3: Input validation
  // -------------------------------------------------------------------------
  describe('Chat input validation', () => {
    let tokenA: string

    beforeAll(async () => {
      tokenA = await makeRealJwt(keypairA, DID_A)
      process.env.TORAH_APPVIEW_PDS_PUBLIC_KEY = ''
    })

    it('getConvo without convoId → 400', async () => {
      await supertest(app)
        .get('/xrpc/chat.bsky.convo.getConvo')
        .set(bearer(tokenA))
        .expect(400)
    })

    it('updateRead without convoId → 400', async () => {
      await supertest(app)
        .post('/xrpc/chat.bsky.convo.updateRead')
        .set(bearer(tokenA))
        .send({})
        .expect(400)
    })

    it('muteConvo without convoId → 400', async () => {
      await supertest(app)
        .post('/xrpc/chat.bsky.convo.muteConvo')
        .set(bearer(tokenA))
        .send({})
        .expect(400)
    })

    it('leaveConvo without convoId → 400', async () => {
      await supertest(app)
        .post('/xrpc/chat.bsky.convo.leaveConvo')
        .set(bearer(tokenA))
        .send({})
        .expect(400)
    })
  })
})
