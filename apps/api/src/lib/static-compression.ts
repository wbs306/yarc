import type { MiddlewareHandler } from 'hono'
import { compress } from 'hono/compress'

const compressResponse = compress()

// Apply only to build assets, never APIs/SSE or workspace/PDF downloads.
export const staticCompression: MiddlewareHandler = async (c, next) => {
  await next()
  if (c.res.status !== 200) return
  const vary = c.res.headers.get('Vary')
  if (!vary?.split(',').some(value => ['*', 'accept-encoding'].includes(value.trim().toLowerCase()))) {
    c.header('Vary', vary ? `${vary}, Accept-Encoding` : 'Accept-Encoding')
  }
  // Byte ranges describe the original representation. Keep both range and
  // HEAD responses untouched, including Content-Length/Content-Range.
  if (c.req.method !== 'GET' || c.req.header('Range')) return
  await compressResponse(c, async () => {})
}
