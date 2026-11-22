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
import { getUnreadCounts, initChatTables } from '../chat.ts'

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
