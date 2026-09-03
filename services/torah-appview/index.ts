import * as bsky from '@atproto/bsky'
import * as bsync from '@atproto/bsync'
import { Secp256k1Keypair } from '@atproto/crypto'
import type { DidString } from '@atproto/syntax'

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
