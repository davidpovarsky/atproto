import type { Application, RequestHandler } from 'express'

const thumbnailPrefix = '/img/avatar_thumbnail/plain/'
const avatarPrefix = '/img/avatar/plain/'

const avatarThumbnailAlias: RequestHandler = (req, _res, next) => {
  if (
    (req.method === 'GET' || req.method === 'HEAD') &&
    req.url.startsWith(thumbnailPrefix)
  ) {
    req.url = avatarPrefix + req.url.slice(thumbnailPrefix.length)
  }
  next()
}

type MiddlewareLayer = { handle: RequestHandler }

/**
 * Reuse the installed avatar processor for the client's thumbnail preset.
 * The existing chat router is already before the upstream image middleware.
 */
export function installAvatarThumbnailAlias(
  app: Application,
  before: RequestHandler,
): void {
  const stack = (app._router as { stack?: MiddlewareLayer[] } | undefined)
    ?.stack
  const index = stack?.findIndex((layer) => layer.handle === before)
  if (!stack || index === undefined || index < 0) {
    throw new Error(
      'Avatar compatibility requires its registered routing anchor',
    )
  }

  app.use(avatarThumbnailAlias)
  const layer = stack.pop()
  if (!layer || layer.handle !== avatarThumbnailAlias) {
    throw new Error(
      'Unable to install avatar compatibility before the image route',
    )
  }
  stack.splice(index, 0, layer)
}
