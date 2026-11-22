import { Client } from 'pg'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  test,
} from 'vitest'
import type { Database } from '@atproto/bsky'
import {
  getAcceptedConvoIds,
  getDirectChatPolicy,
  getOrCreateDirectConvo,
  getUnreadCounts,
  initChatTables,
} from '../chat.ts'

const A = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa'
const B = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb'
const C = 'did:plc:cccccccccccccccccccccccc'
const at = '2026-01-01T00:00:00.000Z'
let client: Client
let pool: Database['pool']

beforeAll(async () => {
  const connectionString = process.env.TORAH_CHAT_TEST_DATABASE_URL
  if (!connectionString) {
    throw new Error(
      'TORAH_CHAT_TEST_DATABASE_URL must name an isolated empty PostgreSQL test database',
    )
  }
  client = new Client({ connectionString })
  await client.connect()
  const existing = await client.query(
    "SELECT to_regnamespace('torah_appview') AS existing",
  )
  if (existing.rows[0].existing !== null) {
    throw new Error(
      'Refusing to test in a database with an existing torah_appview schema',
    )
  }
  pool = client as unknown as Database['pool']
})

afterAll(async () => {
  await client?.end()
})

beforeEach(async () => {
  await client.query('BEGIN')
  await client.query(`
    CREATE SCHEMA torah_appview;
    CREATE TABLE torah_appview.actor (
      did TEXT PRIMARY KEY,
      handle TEXT,
      "takedownRef" TEXT,
      "upstreamStatus" TEXT
    );
    CREATE TABLE torah_appview.actor_block (
      creator TEXT NOT NULL,
      "subjectDid" TEXT NOT NULL
    );
    CREATE TABLE torah_appview.follow (
      creator TEXT NOT NULL,
      "subjectDid" TEXT NOT NULL
    );
    CREATE TABLE torah_appview.record (
      uri TEXT PRIMARY KEY,
      json TEXT NOT NULL,
      "takedownRef" TEXT
    );
    CREATE TABLE torah_appview.list_block (
      creator TEXT NOT NULL,
      "subjectUri" TEXT NOT NULL
    );
    CREATE TABLE torah_appview.list_item (
      "subjectDid" TEXT NOT NULL,
      "listUri" TEXT NOT NULL
    );
  `)
  await initChatTables(pool)
  await client.query(
    'INSERT INTO torah_appview.actor (did) VALUES ($1), ($2), ($3)',
    [A, B, C],
  )
})

afterEach(async () => {
  await client.query('ROLLBACK')
})

async function conversation(id = 'direct', members = [A, B]): Promise<string> {
  await client.query(
    'INSERT INTO torah_appview.chat_convo (id, rev) VALUES ($1, $1)',
    [id],
  )
  for (const did of members) {
    await client.query(
      'INSERT INTO torah_appview.chat_member (convo_id, did) VALUES ($1, $2)',
      [id, did],
    )
  }
  return id
}

async function message(
  id: string,
  convoId = 'direct',
  sender = B,
  sentAt = at,
  deleted = false,
): Promise<void> {
  await client.query(
    'INSERT INTO torah_appview.chat_message (id, convo_id, sender_did, rev, text, sent_at, deleted) VALUES ($1, $2, $3, $1, $1, $4, $5)',
    [id, convoId, sender, sentAt, deleted],
  )
}

async function readThrough(
  messageId: string,
  convoId = 'direct',
): Promise<void> {
  await client.query(
    'UPDATE torah_appview.chat_member SET last_read_message_id = $1 WHERE convo_id = $2 AND did = $3',
    [messageId, convoId, A],
  )
}

async function expectCount(
  count: number,
  includeGroups?: boolean,
): Promise<void> {
  expect(await getUnreadCounts(pool, A, includeGroups)).toEqual({
    unreadAcceptedConvos: count,
    unreadRequestConvos: 0,
  })
}

describe('PostgreSQL unread conversation counts', () => {
  it('counts a conversation once even when it has multiple unread messages', async () => {
    await conversation()
    await message('m_001')
    await message('m_002')
    await expectCount(1)
  })

  test.each(['empty', 'outgoing', 'deleted'])(
    '%s messages do not create an unread conversation',
    async (variant) => {
      await conversation()
      if (variant === 'outgoing') await message('m_001', 'direct', A)
      if (variant === 'deleted') await message('m_001', 'direct', B, at, true)
      await expectCount(0)
    },
  )

  it('excludes muted conversations', async () => {
    await conversation()
    await message('m_001')
    await client.query(
      'UPDATE torah_appview.chat_member SET muted = TRUE WHERE did = $1',
      [A],
    )
    await expectCount(0)
  })

  it('uses message ID as a tie-breaker for unread messages in the same millisecond', async () => {
    await conversation()
    await message('m_001')
    await message('m_002')
    await readThrough('m_002')
    await expectCount(0)
    await message('m_003')
    await expectCount(1)
    await readThrough('m_003')
    await expectCount(0)
  })

  it('retains a deleted message as the read watermark', async () => {
    await conversation()
    await message('m_001')
    await message('m_002', 'direct', B, at, true)
    await readThrough('m_002')
    await expectCount(0)
    await message('m_003')
    await expectCount(1)
  })

  test.each(['foreign-conversation', 'missing-message'])(
    '%s legacy read marker cannot hide unread messages',
    async (variant) => {
      await conversation()
      await message('m_001')
      if (variant === 'foreign-conversation') {
        await conversation('foreign', [B, C])
        await message(
          'foreign-message',
          'foreign',
          B,
          '2026-02-01T00:00:00.000Z',
        )
      }
      await readThrough(
        variant === 'foreign-conversation'
          ? 'foreign-message'
          : 'missing-message',
      )
      await expectCount(1)
    },
  )

  test.each([
    { note: 'normal active actor', status: null, count: 1 },
    { note: 'explicit active actor', status: 'active', count: 1 },
    { note: 'deactivated actor', status: 'deactivated', count: 0 },
    { note: 'suspended actor', status: 'suspended', count: 0 },
    { note: 'taken-down upstream actor', status: 'takendown', count: 0 },
    { note: 'deleted upstream actor', status: 'deleted', count: 0 },
  ])('$note gives $count', async ({ status, count }) => {
    await conversation()
    await message('m_001')
    await client.query(
      'UPDATE torah_appview.actor SET "upstreamStatus" = $1 WHERE did = $2',
      [status, B],
    )
    await expectCount(count)
  })

  it('excludes a direct peer missing from the actor index', async () => {
    await conversation()
    await message('m_001')
    await client.query('DELETE FROM torah_appview.actor WHERE did = $1', [B])
    await expectCount(0)
  })

  it('excludes a locally taken-down direct peer', async () => {
    await conversation()
    await message('m_001')
    await client.query(
      'UPDATE torah_appview.actor SET "takedownRef" = $1 WHERE did = $2',
      ['fixture-takedown', B],
    )
    await expectCount(0)
  })

  test.each([
    { note: 'outgoing block', creator: A, subject: B },
    { note: 'incoming block', creator: B, subject: A },
  ])('$note excludes direct conversations', async ({ creator, subject }) => {
    await conversation()
    await message('m_001')
    await client.query(
      'INSERT INTO torah_appview.actor_block (creator, "subjectDid") VALUES ($1, $2)',
      [creator, subject],
    )
    await expectCount(0)
  })

  test.each([
    { note: 'outgoing list block', creator: A, subject: B },
    { note: 'incoming list block', creator: B, subject: A },
  ])('$note excludes direct conversations', async ({ creator, subject }) => {
    await conversation()
    await message('m_001')
    await client.query(
      'INSERT INTO torah_appview.list_block (creator, "subjectUri") VALUES ($1, $2)',
      [creator, 'at://fixture/list'],
    )
    await client.query(
      'INSERT INTO torah_appview.list_item ("subjectDid", "listUri") VALUES ($1, $2)',
      [subject, 'at://fixture/list'],
    )
    await expectCount(0)
  })

  it('includes group conversations by default and honors includeGroupChats=false', async () => {
    await conversation('group', [A, B, C])
    await message('m_001', 'group')
    await expectCount(1)
    await expectCount(1, true)
    await expectCount(0, false)
  })

  it('does not apply direct-peer exclusions to group conversations', async () => {
    await conversation('group', [A, B, C])
    await message('m_001', 'group')
    await client.query(
      'UPDATE torah_appview.actor SET "upstreamStatus" = $1 WHERE did = $2',
      ['deactivated', B],
    )
    await client.query(
      'INSERT INTO torah_appview.actor_block (creator, "subjectDid") VALUES ($1, $2)',
      [B, A],
    )
    await expectCount(1)
  })

  it('excludes orphaned single-member conversations', async () => {
    await conversation('direct', [A])
    await message('m_001')
    await expectCount(0)
  })

  it('does not count a conversation belonging only to other actors', async () => {
    await conversation('other', [B, C])
    await message('m_001', 'other', C)
    await expectCount(0)
  })

  it('caps accepted unread conversation count at 100', async () => {
    for (let i = 0; i < 105; i++) {
      const id = await conversation(`convo-${i}`)
      await message(`message-${i}`, id)
    }
    await expectCount(100)
  })
})

async function declaration(allowIncoming: unknown): Promise<void> {
  await client.query(
    'INSERT INTO torah_appview.record (uri, json) VALUES ($1, $2)',
    [
      `at://${B}/chat.bsky.actor.declaration/self`,
      JSON.stringify({ allowIncoming }),
    ],
  )
}

async function follow(creator: string, subject: string): Promise<void> {
  await client.query(
    'INSERT INTO torah_appview.follow (creator, "subjectDid") VALUES ($1, $2)',
    [creator, subject],
  )
}

describe('PostgreSQL direct chat privacy', () => {
  it('defaults a missing declaration to people the recipient follows', async () => {
    expect((await getDirectChatPolicy(pool, A, B)).canChat).toBe(false)
    await follow(B, A)
    expect((await getDirectChatPolicy(pool, A, B)).canChat).toBe(true)
  })

  it('does not confuse the sender following the recipient with the reverse relationship', async () => {
    await follow(A, B)
    expect((await getDirectChatPolicy(pool, A, B)).canChat).toBe(false)
  })

  test.each([
    { note: 'all', setting: 'all', followed: false, expected: true },
    {
      note: 'none despite following',
      setting: 'none',
      followed: true,
      expected: false,
    },
    {
      note: 'following without relationship',
      setting: 'following',
      followed: false,
      expected: false,
    },
    {
      note: 'following with relationship',
      setting: 'following',
      followed: true,
      expected: true,
    },
    {
      note: 'unknown value',
      setting: 'future-setting',
      followed: true,
      expected: false,
    },
    {
      note: 'non-string value',
      setting: true,
      followed: true,
      expected: false,
    },
  ])(
    '$note respects the indexed declaration',
    async ({ setting, followed, expected }) => {
      await declaration(setting)
      if (followed) await follow(B, A)
      expect((await getDirectChatPolicy(pool, A, B)).canChat).toBe(expected)
      const conversations = await client.query(
        'SELECT COUNT(*)::int AS count FROM torah_appview.chat_convo',
      )
      expect(conversations.rows[0].count).toBe(0)
    },
  )

  it('fails closed for malformed declaration JSON', async () => {
    await client.query(
      'INSERT INTO torah_appview.record (uri, json) VALUES ($1, $2)',
      [`at://${B}/chat.bsky.actor.declaration/self`, '{'],
    )
    await follow(B, A)
    expect((await getDirectChatPolicy(pool, A, B)).canChat).toBe(false)
  })

  it('does not enable new chats from a taken-down declaration', async () => {
    await declaration('all')
    await client.query('UPDATE torah_appview.record SET "takedownRef" = $1', [
      'fixture',
    ])
    expect((await getDirectChatPolicy(pool, A, B)).canChat).toBe(false)
  })

  it('keeps an existing accepted direct chat available after incoming privacy changes', async () => {
    await conversation()
    await declaration('none')
    expect(await getDirectChatPolicy(pool, A, B)).toEqual({
      canChat: true,
      convoId: 'direct',
    })
  })

  it('does not substitute a group conversation for a direct conversation', async () => {
    await conversation('group', [A, B, C])
    await declaration('all')
    const policy = await getDirectChatPolicy(pool, A, B)
    expect(policy.canChat).toBe(true)
    expect(policy.convoId).toBeUndefined()
    const conversations = await client.query(
      'SELECT COUNT(*)::int AS count FROM torah_appview.chat_convo',
    )
    expect(conversations.rows[0].count).toBe(1)
  })

  test.each([
    { note: 'sender block', creator: A, subject: B },
    { note: 'recipient block', creator: B, subject: A },
  ])(
    '$note prevents an existing direct chat from sending',
    async ({ creator, subject }) => {
      await conversation()
      await declaration('all')
      await client.query(
        'INSERT INTO torah_appview.actor_block (creator, "subjectDid") VALUES ($1, $2)',
        [creator, subject],
      )
      const policy = await getDirectChatPolicy(pool, A, B)
      expect(policy.canChat).toBe(false)
      expect(policy.convoId).toBe('direct')
    },
  )

  test.each([
    { note: 'sender list block', creator: A, subject: B },
    { note: 'recipient list block', creator: B, subject: A },
  ])(
    '$note prevents new and existing direct chats',
    async ({ creator, subject }) => {
      await declaration('all')
      await client.query(
        'INSERT INTO torah_appview.list_block (creator, "subjectUri") VALUES ($1, $2)',
        [creator, 'at://fixture/list'],
      )
      await client.query(
        'INSERT INTO torah_appview.list_item ("subjectDid", "listUri") VALUES ($1, $2)',
        [subject, 'at://fixture/list'],
      )
      expect((await getDirectChatPolicy(pool, A, B)).canChat).toBe(false)
      await conversation()
      expect((await getDirectChatPolicy(pool, A, B)).canChat).toBe(false)
    },
  )

  test.each([
    { note: 'deactivated sender', did: A, status: 'deactivated' },
    { note: 'deactivated recipient', did: B, status: 'deactivated' },
    { note: 'suspended recipient', did: B, status: 'suspended' },
  ])(
    '$note cannot use an existing direct conversation',
    async ({ did, status }) => {
      await conversation()
      await declaration('all')
      await client.query(
        'UPDATE torah_appview.actor SET "upstreamStatus" = $1 WHERE did = $2',
        [status, did],
      )
      expect((await getDirectChatPolicy(pool, A, B)).canChat).toBe(false)
    },
  )

  it('excludes a locally taken-down recipient', async () => {
    await conversation()
    await declaration('all')
    await client.query(
      'UPDATE torah_appview.actor SET "takedownRef" = $1 WHERE did = $2',
      ['fixture', B],
    )
    expect((await getDirectChatPolicy(pool, A, B)).canChat).toBe(false)
  })

  it('excludes a missing recipient', async () => {
    await conversation()
    await declaration('all')
    await client.query('DELETE FROM torah_appview.actor WHERE did = $1', [B])
    expect((await getDirectChatPolicy(pool, A, B)).canChat).toBe(false)
  })
})

describe('PostgreSQL atomic direct conversation creation', () => {
  it('converges opposite-side opens that both observed an absent pair', async () => {
    await follow(A, B)
    await follow(B, A)
    let absentLookups = 0
    const observedPool = {
      async query(text: string, params: unknown[]) {
        const result = await client.query(text, params)
        if (
          text.includes('AS "callerActive"') &&
          result.rows[0].convoId === null
        ) {
          absentLookups++
        }
        return result
      },
    } as unknown as Database['pool']
    const [first, second] = await Promise.all([
      getOrCreateDirectConvo(observedPool, A, B),
      getOrCreateDirectConvo(observedPool, B, A),
    ])
    expect(absentLookups).toBe(2)
    expect(first).toBe(second)
    expect(first).toMatch(/^c_[0-9a-f]{64}$/)
    expect(
      (
        await client.query(
          'SELECT COUNT(*)::int AS count FROM torah_appview.chat_convo',
        )
      ).rows[0].count,
    ).toBe(1)
    const members = await client.query(
      'SELECT did FROM torah_appview.chat_member ORDER BY did',
    )
    expect(members.rows.map((row) => row.did)).toEqual([A, B])
  })

  it('preserves the existing legacy conversation ID', async () => {
    await conversation('legacy-random-convo')
    await declaration('none')
    expect(await getOrCreateDirectConvo(pool, A, B)).toBe('legacy-random-convo')
    expect(await getOrCreateDirectConvo(pool, B, A)).toBe('legacy-random-convo')
    expect(
      (
        await client.query(
          'SELECT COUNT(*)::int AS count FROM torah_appview.chat_convo',
        )
      ).rows[0].count,
    ).toBe(1)
  })

  it('rolls back the conversation and first membership if the second membership fails', async () => {
    await follow(A, B)
    await follow(B, A)
    await client.query(`
      CREATE FUNCTION torah_appview.reject_fixture_member() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'fixture member insertion failure';
      END;
      $$;
      CREATE TRIGGER reject_fixture_member
      BEFORE INSERT ON torah_appview.chat_member
      FOR EACH ROW WHEN (NEW.did = '${B}')
      EXECUTE FUNCTION torah_appview.reject_fixture_member();
    `)
    await client.query('SAVEPOINT atomic_creation')
    await expect(getOrCreateDirectConvo(pool, A, B)).rejects.toThrow(
      'fixture member insertion failure',
    )
    await client.query('ROLLBACK TO SAVEPOINT atomic_creation')
    expect(
      (
        await client.query(
          'SELECT COUNT(*)::int AS count FROM torah_appview.chat_convo',
        )
      ).rows[0].count,
    ).toBe(0)
    expect(
      (
        await client.query(
          'SELECT COUNT(*)::int AS count FROM torah_appview.chat_member',
        )
      ).rows[0].count,
    ).toBe(0)
    await client.query('RELEASE SAVEPOINT atomic_creation')
  })
})

describe('PostgreSQL accepted conversation kind filters', () => {
  test.each([
    { kind: undefined, expected: ['direct', 'group'] },
    { kind: 'direct' as const, expected: ['direct'] },
    { kind: 'group' as const, expected: ['group'] },
  ])(
    'kind=$kind returns only the requested memberships',
    async ({ kind, expected }) => {
      await conversation('direct', [A, B])
      await conversation('group', [A, B, C])
      await conversation('other-actors', [B, C])
      expect((await getAcceptedConvoIds(pool, A, 50, kind)).sort()).toEqual(
        expected,
      )
    },
  )

  it('applies the requested page limit after the kind filter', async () => {
    await conversation('direct-old', [A, B])
    await conversation('direct-new', [A, C])
    await conversation('group', [A, B, C])
    expect(await getAcceptedConvoIds(pool, A, 1, 'direct')).toHaveLength(1)
  })
})
