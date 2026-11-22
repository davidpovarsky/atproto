import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import express, { type ErrorRequestHandler, Router } from 'express'
import { describe, expect, it, test, vi } from 'vitest'
import { createMiddleware } from '../../packages/bsky/dist/image/server.js'
import {
  createImageProcessor,
  getInfo,
} from '../../packages/bsky/dist/image/sharp.js'
import { installAvatarThumbnailAlias } from './image-compat.ts'

const did = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa'
const cid = 'bafkreidtz4dfq3bkyvs2adrfwjyilqzv5z2eel7mesuymhyjpzborbtunu'
const thumbnailPath = `/img/avatar_thumbnail/plain/${did}/${cid}`
const avatarPath = `/img/avatar/plain/${did}/${cid}`

async function startFixture() {
  const cache = await mkdtemp(path.join(tmpdir(), 'torah-avatar-compat-'))
  const processor = createImageProcessor({
    format: 'webp',
    width: 2,
    height: 2,
  })
  const rendered = processor.toBuffer()
  processor.end(
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="blue"/></svg>',
    ),
  )
  const image = await rendered
  await writeFile(path.join(cache, [did, cid, 'avatar'].join('::')), image)

  const unexpectedLookup = vi.fn(() =>
    Promise.reject(new Error('Unexpected external blob lookup')),
  )
  const ctx = {
    cfg: { blobCacheLocation: cache },
    dataplane: {
      getIdentityByDid: unexpectedLookup,
      getBlobTakedown: unexpectedLookup,
    },
  } as unknown as Parameters<typeof createMiddleware>[0]
  const seen: Array<{ method: string; url: string; originalUrl: string }> = []
  const app = express()
  app.use((_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    next()
  })

  // Match the service's existing chat-router position before the image route.
  const chatRouter = Router()
  chatRouter.use((req, res, next) => {
    if (!req.path.startsWith('/xrpc/chat.bsky.')) return next('router')
    return res.status(401).json({
      url: req.url,
      originalUrl: req.originalUrl,
    })
  })
  app.use(chatRouter)
  app.use((_req, _res, next) => next())
  app.use((req, _res, next) => {
    seen.push({
      method: req.method,
      url: req.url,
      originalUrl: req.originalUrl,
    })
    next()
  })
  app.use(createMiddleware(ctx, { prefix: '/img/' }))
  app.use((req, res) =>
    res.status(404).json({ url: req.url, originalUrl: req.originalUrl }),
  )
  const onError: ErrorRequestHandler = (error, _req, res, _next) => {
    res.status(error.statusCode ?? 500).json({ message: error.message })
  }
  app.use(onError)

  // Deliberately install last: successful image requests prove relocation.
  installAvatarThumbnailAlias(app, chatRouter)
  const server = createServer(app)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  return {
    image,
    seen,
    unexpectedLookup,
    async request(method: string, url: string) {
      const response = await fetch(origin + url, { method, redirect: 'manual' })
      return {
        status: response.status,
        headers: response.headers,
        body: Buffer.from(await response.arrayBuffer()),
      }
    },
    async [Symbol.asyncDispose]() {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
      await rm(cache, { recursive: true, force: true })
    },
  }
}

describe('avatar thumbnail compatibility with the installed image route', () => {
  it('serves a decodable cached avatar without redirecting or fetching elsewhere', async () => {
    await using fixture = await startFixture()
    const response = await fixture.request('GET', thumbnailPath)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/webp')
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(response.headers.get('x-cache')).toBe('hit')
    expect(response.headers.has('location')).toBe(false)
    expect(response.body).toEqual(fixture.image)
    expect(await getInfo(Readable.from(response.body))).toMatchObject({
      width: 2,
      height: 2,
      mime: 'image/webp',
    })
    expect(fixture.unexpectedLookup).not.toHaveBeenCalled()
  })

  it('delegates HEAD while preserving image headers and sending no body', async () => {
    await using fixture = await startFixture()
    const response = await fixture.request('HEAD', thumbnailPath)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/webp')
    expect(response.headers.get('content-length')).toBe(
      String(fixture.image.length),
    )
    expect(response.body).toHaveLength(0)
    expect(fixture.seen[0].method).toBe('HEAD')
    expect(fixture.unexpectedLookup).not.toHaveBeenCalled()
  })

  it('preserves the format suffix, query bytes, and original URL', async () => {
    await using fixture = await startFixture()
    const suffix = '@webp?one=%2f&two=a+b'
    const response = await fixture.request('GET', thumbnailPath + suffix)
    expect(response.status).toBe(200)
    expect(fixture.seen).toEqual([
      {
        method: 'GET',
        url: avatarPath + suffix,
        originalUrl: thumbnailPath + suffix,
      },
    ])
    expect(fixture.unexpectedLookup).not.toHaveBeenCalled()
  })

  test.each(['POST', 'PUT', 'DELETE', 'OPTIONS'])(
    'does not rewrite %s requests',
    async (method) => {
      await using fixture = await startFixture()
      const response = await fixture.request(method, thumbnailPath)
      expect(response.status).toBe(404)
      expect(fixture.seen[0]).toEqual({
        method,
        url: thumbnailPath,
        originalUrl: thumbnailPath,
      })
      expect(fixture.unexpectedLookup).not.toHaveBeenCalled()
    },
  )

  test.each([
    { url: avatarPath, status: 200 },
    {
      url: thumbnailPath.replace('avatar_thumbnail', 'avatar_thumbnail_extra'),
      status: 400,
    },
    { url: '/else' + thumbnailPath, status: 404 },
    { url: thumbnailPath.replace('/plain/', '/plainish/'), status: 400 },
    { url: '/else?next=' + thumbnailPath, status: 404 },
  ])('does not rewrite the nonmatching path $url', async ({ url, status }) => {
    await using fixture = await startFixture()
    const response = await fixture.request('GET', url)
    expect(response.status).toBe(status)
    expect(fixture.seen[0]).toEqual({
      method: 'GET',
      url,
      originalUrl: url,
    })
    expect(fixture.unexpectedLookup).not.toHaveBeenCalled()
  })

  test.each([
    {
      url: `/img/avatar_thumbnail/plain/not-a-did/${cid}`,
      message: 'Invalid did',
    },
    {
      url: `/img/avatar_thumbnail/plain/${did}/not-a-cid`,
      message: 'Invalid cid',
    },
    {
      url: thumbnailPath + '@png',
      message: 'Invalid path: bad format',
    },
  ])(
    'retains the installed validator for $message',
    async ({ url, message }) => {
      await using fixture = await startFixture()
      const response = await fixture.request('GET', url)
      expect(response.status).toBe(400)
      expect(JSON.parse(response.body.toString('utf8'))).toEqual({ message })
      expect(fixture.unexpectedLookup).not.toHaveBeenCalled()
    },
  )

  it('leaves the existing chat router request and auth response unchanged', async () => {
    await using fixture = await startFixture()
    const url = '/xrpc/chat.bsky.convo.getLog?cursor=fixture'
    const response = await fixture.request('GET', url)
    expect(response.status).toBe(401)
    expect(JSON.parse(response.body.toString('utf8'))).toEqual({
      url,
      originalUrl: url,
    })
    expect(fixture.unexpectedLookup).not.toHaveBeenCalled()
  })

  it('fails installation when the exact registered routing anchor is absent', () => {
    const app = express()
    app.use(Router())
    expect(() => installAvatarThumbnailAlias(app, Router())).toThrow(
      'Avatar compatibility requires its registered routing anchor',
    )
  })
})
