import { once } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { beforeAll, describe, expect, it, test } from 'vitest'
import type { Database } from '@atproto/bsky'
import { type Keypair, P256Keypair, Secp256k1Keypair } from '@atproto/crypto'
import { AuthRequiredError, createServiceJwt } from '@atproto/xrpc-server'
import { AuthVerifier } from '../../packages/bsky/dist/auth-verifier.js'
import { type AuthenticateChatRequest, createChatRouter } from './chat.ts'

const DID_A = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa'
const DID_B = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb'
const DID_C = 'did:plc:cccccccccccccccccccccccc'
const CHAT_DID = 'did:web:appview.example.test'
const CONVO_AB = 'convo-ab'
const keys = new Map<string, Keypair>()
let wrongKey: Keypair
let ownDid: `did:key:${string}`

beforeAll(async () => {
  keys.set(DID_A, await P256Keypair.create())
  keys.set(DID_B, await Secp256k1Keypair.create())
  keys.set(DID_C, await P256Keypair.create())
  wrongKey = await P256Keypair.create()
  ownDid = (await Secp256k1Keypair.create()).did() as typeof ownDid
})

function makeVerifier(): AuthVerifier {
  const dataplane = {
    getIdentityByDid({ did }: { did: string }) {
      const key = keys.get(did)
      if (!key) return Promise.reject(new AuthRequiredError('Unknown identity'))
      const method = {
        Type: 'Multikey',
        PublicKeyMultibase: key.did().slice('did:key:'.length),
      }
      return Promise.resolve({
        keys: Buffer.from(
          JSON.stringify({ atproto: method, atproto_label: method }),
        ),
      })
    },
  } as unknown as ConstructorParameters<typeof AuthVerifier>[0]
  return new AuthVerifier(dataplane, {
    ownDid,
    alternateAudienceDids: [CHAT_DID],
    modServiceDid: ownDid,
    adminPasses: [],
  })
}

async function makeToken(
  iss: string,
  lxm: string | null,
  options: { aud?: string; exp?: number; key?: Keypair } = {},
): Promise<string> {
  const keypair = options.key ?? keys.get(iss.split('#')[0])
  if (!keypair) throw new Error('Missing fixture key')
  return createServiceJwt({
    iss,
    aud: options.aud ?? CHAT_DID,
    exp: options.exp,
    lxm,
    keypair,
  })
}

type QueryCall = { sql: string; params: unknown[] }

type FixtureOptions = {
  active?: boolean
  policy?: Partial<{
    callerActive: boolean
    recipientActive: boolean
    blocked: boolean
    recipientFollowsCaller: boolean
    declaration: string | null
    declarationTakedown: string | null
    convoId: string | null
  }>
}

function makePool(options: FixtureOptions = {}) {
  const queries: QueryCall[] = []
  const pool = {
    query(sql: string, params: unknown[] = []) {
      queries.push({ sql, params })
      let rows: Record<string, unknown>[] = []
      if (sql.includes('AS "callerActive"')) {
        rows = [
          {
            callerActive: true,
            recipientActive: true,
            blocked: false,
            recipientFollowsCaller: false,
            declaration: JSON.stringify({ allowIncoming: 'all' }),
            declarationTakedown: null,
            convoId: CONVO_AB,
            ...options.policy,
          },
        ]
      } else if (sql.includes('SELECT 1 FROM torah_appview.actor')) {
        rows = options.active === false ? [] : [{ active: 1 }]
      } else if (sql.startsWith('SELECT did FROM torah_appview.chat_member')) {
        rows = params[0] === CONVO_AB ? [{ did: DID_A }, { did: DID_B }] : []
      } else if (sql.includes('SELECT 1 FROM torah_appview.chat_member')) {
        if (
          params[0] === CONVO_AB &&
          [DID_A, DID_B].includes(String(params[1]))
        ) {
          rows = [{ member: 1 }]
        }
      } else if (sql.includes('WITH saved_convo AS')) {
        rows = [{ id: params[0] }]
      } else if (sql.includes('SELECT c.id FROM torah_appview.chat_convo c')) {
        rows = [{ id: CONVO_AB }]
      } else if (sql.includes('SELECT id, rev, created_at')) {
        rows = [
          {
            id: params[0],
            rev: '1',
            created_at: new Date(),
            updated_at: new Date(),
          },
        ]
      } else if (sql.includes('SELECT did, last_read_message_id')) {
        rows = [DID_A, DID_B].map((did) => ({
          did,
          last_read_message_id: null,
          muted: false,
        }))
      } else if (sql.includes('SELECT did, handle')) {
        rows = [{ did: params[0], handle: 'fixture.test' }]
      } else if (sql.includes('COUNT(*) as cnt')) {
        rows = [{ cnt: '0' }]
      } else if (sql.includes('AS "unreadAcceptedConvos"')) {
        rows = [{ unreadAcceptedConvos: 1, unreadRequestConvos: 0 }]
      } else if (sql.startsWith('SELECT id FROM torah_appview.chat_message')) {
        if (
          sql.includes('WHERE id = $1') &&
          params[0] === 'own-message' &&
          params[1] === CONVO_AB
        ) {
          rows = [{ id: 'own-message' }]
        } else if (sql.includes('ORDER BY sent_at')) {
          rows = [{ id: 'latest-message' }]
        }
      }
      return Promise.resolve({ rows })
    },
  } as unknown as Database['pool']
  return { pool, queries }
}

async function startFixture(
  authenticate?: AuthenticateChatRequest,
  options: FixtureOptions = {},
) {
  const { pool, queries } = makePool(options)
  const verifier = makeVerifier()
  const app = express()
  app.use(
    createChatRouter(
      { pool },
      authenticate ??
        (async (req) => {
          const { credentials } = await verifier.standard({ req })
          return credentials.iss
        }),
    ),
  )
  app.get('/xrpc/app.bsky.actor.getProfile', (_req, res) =>
    res.json({ public: true }),
  )
  const server = createServer(app)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as AddressInfo
  return {
    queries,
    async request(
      method: string,
      path: string,
      token?: string,
      body?: unknown,
    ) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      return { status: response.status, body: await response.json() }
    },
    async [Symbol.asyncDispose]() {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
        server.closeAllConnections()
      })
    },
  }
}

const chatRoutes = [
  { method: 'GET', nsid: 'chat.bsky.actor.getStatus' },
  { method: 'GET', nsid: 'chat.bsky.actor.exportAccountData' },
  { method: 'GET', nsid: 'chat.bsky.actor.getActorMetadata' },
  { method: 'GET', nsid: 'chat.bsky.convo.getConvoForMembers' },
  { method: 'POST', nsid: 'chat.bsky.convo.getConvoForMembers' },
  { method: 'GET', nsid: 'chat.bsky.convo.getConvo' },
  { method: 'GET', nsid: 'chat.bsky.convo.listConvos' },
  { method: 'GET', nsid: 'chat.bsky.convo.getMessages' },
  { method: 'POST', nsid: 'chat.bsky.convo.sendMessage' },
  { method: 'POST', nsid: 'chat.bsky.convo.sendMessageBatch' },
  { method: 'POST', nsid: 'chat.bsky.convo.updateRead' },
  { method: 'GET', nsid: 'chat.bsky.convo.getLog' },
  { method: 'GET', nsid: 'chat.bsky.convo.getUnreadCounts' },
  { method: 'GET', nsid: 'chat.bsky.convo.getConvoAvailability' },
  { method: 'POST', nsid: 'chat.bsky.convo.muteConvo' },
  { method: 'POST', nsid: 'chat.bsky.convo.unmuteConvo' },
  { method: 'POST', nsid: 'chat.bsky.convo.leaveConvo' },
]

describe('chat authentication boundary', () => {
  it('requires an authentication callback at construction', () => {
    const { pool } = makePool()
    expect(() => {
      // @ts-expect-error An authentication callback is mandatory.
      createChatRouter({ pool })
    }).toThrow('authentication callback is required')
  })

  test.each(chatRoutes)(
    '$method $nsid rejects missing authentication before database access',
    async ({ method, nsid }) => {
      await using fixture = await startFixture()
      const response = await fixture.request(method, `/xrpc/${nsid}`)
      expect(response.status).toBe(401)
      expect(fixture.queries).toHaveLength(0)
    },
  )

  test.each(chatRoutes)(
    '$method $nsid rejects a real token signed by the wrong key',
    async ({ method, nsid }) => {
      await using fixture = await startFixture()
      const token = await makeToken(DID_A, nsid, { key: wrongKey })
      const response = await fixture.request(method, `/xrpc/${nsid}`, token)
      expect(response.status).toBe(401)
      expect(fixture.queries).toHaveLength(0)
    },
  )

  it('passes public AppView requests through without invoking chat authentication', async () => {
    let calls = 0
    await using fixture = await startFixture(() => {
      calls++
      return Promise.reject(new Error('Must not be called'))
    })
    const response = await fixture.request(
      'GET',
      '/xrpc/app.bsky.actor.getProfile',
    )
    expect(response).toEqual({ status: 200, body: { public: true } })
    expect(calls).toBe(0)
  })

  test.each([
    { note: 'malformed JWT', token: 'not-a-jwt' },
    {
      note: 'malformed JWT payload JSON',
      token: `${Buffer.from('{"alg":"ES256","typ":"JWT"}').toString('base64url')}.${Buffer.from('{').toString('base64url')}.AA`,
    },
    {
      note: 'alg:none',
      token: `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from('{"iss":"did:plc:aaaaaaaaaaaaaaaaaaaaaaaa","aud":"did:web:appview.example.test","exp":9999999999}').toString('base64url')}.`,
    },
  ])('$note returns 401', async ({ token }) => {
    await using fixture = await startFixture()
    expect(
      (await fixture.request('GET', '/xrpc/chat.bsky.convo.getLog', token))
        .status,
    ).toBe(401)
  })

  test.each([
    { note: 'expired JWT', opts: { exp: 1 } },
    { note: 'wrong audience', opts: { aud: 'did:web:elsewhere.example.test' } },
    {
      note: 'proxy fragment as audience',
      opts: { aud: `${CHAT_DID}#bsky_chat` },
    },
  ])('$note returns 401', async ({ opts }) => {
    await using fixture = await startFixture()
    const token = await makeToken(DID_A, 'chat.bsky.convo.getLog', opts)
    expect(
      (await fixture.request('GET', '/xrpc/chat.bsky.convo.getLog', token))
        .status,
    ).toBe(401)
    expect(fixture.queries).toHaveLength(0)
  })

  test.each([
    { note: 'missing method claim', lxm: null },
    {
      note: 'another endpoint method claim',
      lxm: 'chat.bsky.convo.sendMessage',
    },
  ])('$note returns 401', async ({ lxm }) => {
    await using fixture = await startFixture()
    const token = await makeToken(DID_A, lxm)
    expect(
      (await fixture.request('GET', '/xrpc/chat.bsky.convo.getLog', token))
        .status,
    ).toBe(401)
  })

  test.each([
    { note: 'P256 actor key', did: DID_A },
    { note: 'Secp256k1 actor key', did: DID_B },
  ])('$note is accepted with the advertised chat audience', async ({ did }) => {
    await using fixture = await startFixture()
    const token = await makeToken(did, 'chat.bsky.convo.getLog')
    expect(
      await fixture.request('GET', '/xrpc/chat.bsky.convo.getLog', token),
    ).toEqual({
      status: 200,
      body: { logs: [] },
    })
  })

  it('preserves the configured primary AppView audience', async () => {
    await using fixture = await startFixture()
    const token = await makeToken(DID_A, 'chat.bsky.convo.getLog', {
      aud: ownDid,
    })
    expect(
      (await fixture.request('GET', '/xrpc/chat.bsky.convo.getLog', token))
        .status,
    ).toBe(200)
  })

  it('rejects a labeler service issuer even when standard auth accepts its legacy method-less token', async () => {
    await using fixture = await startFixture()
    const token = await makeToken(`${DID_A}#atproto_labeler`, null)
    expect(
      (await fixture.request('GET', '/xrpc/chat.bsky.convo.getLog', token))
        .status,
    ).toBe(401)
    expect(fixture.queries).toHaveLength(0)
  })

  it('fails closed and reports verifier infrastructure failure without exposing its details', async () => {
    await using fixture = await startFixture(() =>
      Promise.reject(new Error('private resolver failure')),
    )
    const response = await fixture.request(
      'GET',
      '/xrpc/chat.bsky.convo.getLog',
      'irrelevant',
    )
    expect(response).toEqual({
      status: 503,
      body: {
        error: 'ServiceUnavailable',
        message: 'Authentication service unavailable',
      },
    })
    expect(fixture.queries).toHaveLength(0)
  })
})

it('does not classify an unrelated verifier TypeError as invalid credentials', async () => {
  await using fixture = await startFixture(() =>
    Promise.reject(new TypeError('private resolver type failure')),
  )
  const response = await fixture.request(
    'GET',
    '/xrpc/chat.bsky.convo.getLog',
    'irrelevant',
  )
  expect(response.status).toBe(503)
  expect(response.body).toEqual({
    error: 'ServiceUnavailable',
    message: 'Authentication service unavailable',
  })
  expect(fixture.queries).toHaveLength(0)
})

describe('chat membership and read state', () => {
  test.each([
    { method: 'GET', nsid: 'chat.bsky.convo.getConvo' },
    { method: 'GET', nsid: 'chat.bsky.convo.getMessages' },
    { method: 'POST', nsid: 'chat.bsky.convo.sendMessage' },
    { method: 'POST', nsid: 'chat.bsky.convo.sendMessageBatch' },
    { method: 'POST', nsid: 'chat.bsky.convo.updateRead' },
    { method: 'POST', nsid: 'chat.bsky.convo.muteConvo' },
    { method: 'POST', nsid: 'chat.bsky.convo.unmuteConvo' },
    { method: 'POST', nsid: 'chat.bsky.convo.leaveConvo' },
  ])(
    '$method $nsid rejects a verified nonmember with 403',
    async ({ method, nsid }) => {
      await using fixture = await startFixture()
      const token = await makeToken(DID_C, nsid)
      const body = {
        convoId: CONVO_AB,
        message: { text: 'fixture' },
        items: [{ convoId: CONVO_AB, message: { text: 'fixture' } }],
      }
      const response = await fixture.request(
        method,
        `/xrpc/${nsid}?convoId=${CONVO_AB}`,
        token,
        method === 'POST' ? body : undefined,
      )
      expect(response.status).toBe(403)
      expect(
        fixture.queries.filter(({ sql }) =>
          /^(INSERT|UPDATE|DELETE|WITH saved_convo)/.test(sql),
        ),
      ).toHaveLength(0)
    },
  )

  it('returns a member conversation with 200', async () => {
    await using fixture = await startFixture()
    const token = await makeToken(DID_A, 'chat.bsky.convo.getConvo')
    const response = await fixture.request(
      'GET',
      `/xrpc/chat.bsky.convo.getConvo?convoId=${CONVO_AB}`,
      token,
    )
    expect(response.status).toBe(200)
    expect(response.body.convo.id).toBe(CONVO_AB)
  })

  it('does not use an attacker-controlled sub claim instead of the verified issuer', async () => {
    await using fixture = await startFixture()
    const key = keys.get(DID_C)!
    const header = Buffer.from(
      JSON.stringify({ typ: 'JWT', alg: key.jwtAlg }),
    ).toString('base64url')
    const payload = Buffer.from(
      JSON.stringify({
        iss: DID_C,
        sub: DID_A,
        aud: CHAT_DID,
        exp: Math.floor(Date.now() / 1000) + 60,
        lxm: 'chat.bsky.convo.getConvo',
      }),
    ).toString('base64url')
    const unsigned = `${header}.${payload}`
    const signature = Buffer.from(
      await key.sign(Buffer.from(unsigned)),
    ).toString('base64url')
    const response = await fixture.request(
      'GET',
      `/xrpc/chat.bsky.convo.getConvo?convoId=${CONVO_AB}`,
      `${unsigned}.${signature}`,
    )
    expect(response.status).toBe(403)
  })

  it('authorizes the complete send batch before any write', async () => {
    await using fixture = await startFixture()
    const token = await makeToken(DID_A, 'chat.bsky.convo.sendMessageBatch')
    const response = await fixture.request(
      'POST',
      '/xrpc/chat.bsky.convo.sendMessageBatch',
      token,
      {
        items: [
          { convoId: CONVO_AB, message: { text: 'allowed fixture' } },
          { convoId: 'not-a-member', message: { text: 'forbidden fixture' } },
        ],
      },
    )
    expect(response.status).toBe(403)
    expect(
      fixture.queries.filter(({ sql }) =>
        /^(INSERT|UPDATE|DELETE|WITH saved_convo)/.test(sql),
      ),
    ).toHaveLength(0)
  })

  it('rejects a foreign message read marker before changing state', async () => {
    await using fixture = await startFixture()
    const token = await makeToken(DID_A, 'chat.bsky.convo.updateRead')
    const response = await fixture.request(
      'POST',
      '/xrpc/chat.bsky.convo.updateRead',
      token,
      {
        convoId: CONVO_AB,
        messageId: 'foreign-message',
      },
    )
    expect(response.status).toBe(400)
    expect(
      fixture.queries.filter(({ sql }) => sql.startsWith('UPDATE')),
    ).toHaveLength(0)
  })

  it('marks through the latest message when no explicit read marker is supplied', async () => {
    await using fixture = await startFixture()
    const token = await makeToken(DID_A, 'chat.bsky.convo.updateRead')
    const response = await fixture.request(
      'POST',
      '/xrpc/chat.bsky.convo.updateRead',
      token,
      { convoId: CONVO_AB },
    )
    expect(response.status).toBe(200)
    expect(
      fixture.queries.find(({ sql }) => sql.startsWith('UPDATE'))?.params,
    ).toEqual(['latest-message', CONVO_AB, DID_A])
  })

  test.each([
    { query: '', expected: true },
    { query: '?includeGroupChats=true', expected: true },
    { query: '?includeGroupChats=false', expected: false },
  ])(
    'unread counts query $query passes the correct group filter',
    async ({ query, expected }) => {
      await using fixture = await startFixture()
      const token = await makeToken(DID_A, 'chat.bsky.convo.getUnreadCounts')
      const response = await fixture.request(
        'GET',
        `/xrpc/chat.bsky.convo.getUnreadCounts${query}`,
        token,
      )
      expect(response).toEqual({
        status: 200,
        body: { unreadAcceptedConvos: 1, unreadRequestConvos: 0 },
      })
      expect(fixture.queries[0].params).toEqual([DID_A, expected])
    },
  )

  it('rejects an invalid group-filter parameter', async () => {
    await using fixture = await startFixture()
    const token = await makeToken(DID_A, 'chat.bsky.convo.getUnreadCounts')
    const response = await fixture.request(
      'GET',
      '/xrpc/chat.bsky.convo.getUnreadCounts?includeGroupChats=invalid',
      token,
    )
    expect(response.status).toBe(400)
    expect(fixture.queries).toHaveLength(0)
  })
})

describe('direct chat availability and enforcement', () => {
  test.each([true, false])(
    'actor active=%s returns the current status schema',
    async (active) => {
      await using fixture = await startFixture(undefined, { active })
      const token = await makeToken(DID_A, 'chat.bsky.actor.getStatus')
      const response = await fixture.request(
        'GET',
        '/xrpc/chat.bsky.actor.getStatus',
        token,
      )
      expect(response).toEqual({
        status: 200,
        body: {
          chatDisabled: !active,
          canCreateGroups: false,
          groupMemberLimit: 0,
        },
      })
    },
  )

  it('returns an existing direct conversation without writing', async () => {
    await using fixture = await startFixture()
    const token = await makeToken(DID_A, 'chat.bsky.convo.getConvoAvailability')
    const response = await fixture.request(
      'GET',
      `/xrpc/chat.bsky.convo.getConvoAvailability?members=${DID_B}`,
      token,
    )
    expect(response.status).toBe(200)
    expect(response.body.canChat).toBe(true)
    expect(response.body.convo.id).toBe(CONVO_AB)
    expect(
      fixture.queries.filter(({ sql }) =>
        /^(INSERT|UPDATE|DELETE|WITH saved_convo)/.test(sql),
      ),
    ).toHaveLength(0)
  })

  it('checks a possible new conversation without creating it', async () => {
    await using fixture = await startFixture(undefined, {
      policy: { convoId: null },
    })
    const token = await makeToken(DID_A, 'chat.bsky.convo.getConvoAvailability')
    const response = await fixture.request(
      'GET',
      `/xrpc/chat.bsky.convo.getConvoAvailability?members=${DID_B}`,
      token,
    )
    expect(response).toEqual({ status: 200, body: { canChat: true } })
    expect(
      fixture.queries.filter(({ sql }) =>
        /^(INSERT|UPDATE|DELETE|WITH saved_convo)/.test(sql),
      ),
    ).toHaveLength(0)
  })

  test.each([
    { note: 'no members', members: [] },
    { note: 'invalid DID', members: ['not-a-did'] },
    { note: 'self conversation', members: [DID_A] },
    { note: 'group conversation', members: [DID_B, DID_C] },
    {
      note: 'too many entries',
      members: Array.from({ length: 11 }, () => DID_B),
    },
  ])('$note is rejected before a database query', async ({ members }) => {
    await using fixture = await startFixture()
    const query = new URLSearchParams()
    for (const did of members) query.append('members', did)
    const token = await makeToken(DID_A, 'chat.bsky.convo.getConvoAvailability')
    const response = await fixture.request(
      'GET',
      `/xrpc/chat.bsky.convo.getConvoAvailability?${query}`,
      token,
    )
    expect(response.status).toBe(400)
    expect(fixture.queries).toHaveLength(0)
  })

  test.each(['GET', 'POST'])(
    '%s creation cannot bypass the recipient declaration',
    async (method) => {
      await using fixture = await startFixture(undefined, {
        policy: {
          convoId: null,
          declaration: JSON.stringify({ allowIncoming: 'none' }),
        },
      })
      const token = await makeToken(DID_A, 'chat.bsky.convo.getConvoForMembers')
      const response = await fixture.request(
        method,
        `/xrpc/chat.bsky.convo.getConvoForMembers?members=${DID_B}`,
        token,
        method === 'POST' ? { members: [DID_B] } : undefined,
      )
      expect(response.status).toBe(403)
      expect(
        fixture.queries.filter(({ sql }) =>
          /^(INSERT|UPDATE|DELETE|WITH saved_convo)/.test(sql),
        ),
      ).toHaveLength(0)
    },
  )

  test.each(['sendMessage', 'sendMessageBatch'])(
    '%s cannot bypass an existing direct-chat block',
    async (method) => {
      await using fixture = await startFixture(undefined, {
        policy: { blocked: true },
      })
      const nsid = `chat.bsky.convo.${method}`
      const token = await makeToken(DID_A, nsid)
      const item = { convoId: CONVO_AB, message: { text: 'fixture' } }
      const response = await fixture.request(
        'POST',
        `/xrpc/${nsid}`,
        token,
        method === 'sendMessage' ? item : { items: [item] },
      )
      expect(response.status).toBe(403)
      expect(
        fixture.queries.filter(({ sql }) =>
          /^(INSERT|UPDATE|DELETE|WITH saved_convo)/.test(sql),
        ),
      ).toHaveLength(0)
    },
  )

  it('continues an existing direct chat after an incoming-privacy change', async () => {
    await using fixture = await startFixture(undefined, {
      policy: { declaration: JSON.stringify({ allowIncoming: 'none' }) },
    })
    const token = await makeToken(DID_A, 'chat.bsky.convo.sendMessage')
    const response = await fixture.request(
      'POST',
      '/xrpc/chat.bsky.convo.sendMessage',
      token,
      {
        convoId: CONVO_AB,
        message: { text: 'fixture in the test database stub' },
      },
    )
    expect(response.status).toBe(200)
    expect(fixture.queries.some(({ sql }) => sql.startsWith('INSERT'))).toBe(
      true,
    )
  })
})

describe('accepted-only legacy conversation lists', () => {
  it('returns an empty request list without duplicating accepted conversations', async () => {
    await using fixture = await startFixture()
    const token = await makeToken(DID_A, 'chat.bsky.convo.listConvos')
    const response = await fixture.request(
      'GET',
      '/xrpc/chat.bsky.convo.listConvos?status=request',
      token,
    )
    expect(response).toEqual({ status: 200, body: { convos: [] } })
    expect(fixture.queries).toHaveLength(0)
  })

  test.each(['', '?status=accepted'])(
    'list query %s returns accepted conversations',
    async (query) => {
      await using fixture = await startFixture()
      const token = await makeToken(DID_A, 'chat.bsky.convo.listConvos')
      const response = await fixture.request(
        'GET',
        `/xrpc/chat.bsky.convo.listConvos${query}`,
        token,
      )
      expect(response.status).toBe(200)
      expect(response.body.convos).toHaveLength(1)
      expect(response.body.convos[0].id).toBe(CONVO_AB)
      expect(response.body.convos[0].status).toBe('accepted')
    },
  )

  test.each([
    '?status=unknown',
    '?kind=unknown',
    '?limit=0',
    '?limit=101',
    '?limit=not-a-number',
  ])(
    'invalid list query %s is rejected before database access',
    async (query) => {
      await using fixture = await startFixture()
      const token = await makeToken(DID_A, 'chat.bsky.convo.listConvos')
      const response = await fixture.request(
        'GET',
        `/xrpc/chat.bsky.convo.listConvos${query}`,
        token,
      )
      expect(response.status).toBe(400)
      expect(fixture.queries).toHaveLength(0)
    },
  )
  test.each(['direct', 'group'] as const)(
    'passes the requested %s conversation kind to the database filter',
    async (kind) => {
      await using fixture = await startFixture()
      const token = await makeToken(DID_A, 'chat.bsky.convo.listConvos')
      const response = await fixture.request(
        'GET',
        `/xrpc/chat.bsky.convo.listConvos?status=accepted&kind=${kind}&limit=10`,
        token,
      )
      expect(response.status).toBe(200)
      expect(fixture.queries[0].params).toEqual([DID_A, 10, kind])
    },
  )
})
