import { Router } from 'express'
import { didWebToUrl, isDidWeb } from '@atproto/did'
import type { AppContext } from '../context.js'

export const createRouter = (ctx: AppContext): Router => {
  const router = Router()

  router.get('/.well-known/did.json', (req, res) => {
    const host = req.headers.host || (ctx.cfg.publicUrl ? new URL(ctx.cfg.publicUrl).host : 'localhost')
    const serviceEndpoint = ctx.cfg.publicUrl || `https://${host}`
    const docDid = isDidWeb(ctx.cfg.serverDid) ? ctx.cfg.serverDid : `did:web:${host}`

    res.json({
      '@context': [
        'https://www.w3.org/ns/did/v1',
        'https://w3id.org/security/multikey/v1',
      ],
      id: docDid,
      verificationMethod: [
        {
          id: `${docDid}#atproto`,
          type: 'Multikey',
          controller: docDid,
          publicKeyMultibase: ctx.signingKey.did().replace('did:key:', ''),
        },
      ],
      service: [
        {
          id: '#bsky_notif',
          type: 'BskyNotificationService',
          serviceEndpoint,
        },
        {
          id: '#bsky_appview',
          type: 'BskyAppView',
          serviceEndpoint,
        },
        {
          id: '#bsky_chat',
          type: 'BskyChatService',
          serviceEndpoint,
        },
      ],
    })
  })

  return router
}
