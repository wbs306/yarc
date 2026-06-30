import { Context } from 'hono'

export function getCorsHeaders(origin: string) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Range',
    'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Range, Content-Length, Content-Type',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Max-Age': '86400',
  }
}

export function corsMiddleware(origin: string) {
  return async (c: Context, next: () => Promise<void>) => {
    // Set CORS headers
    const headers = getCorsHeaders(origin)
    for (const [key, value] of Object.entries(headers)) {
      c.header(key, value)
    }

    // Handle preflight
    if (c.req.method === 'OPTIONS') {
      return new Response(null, { status: 204 })
    }

    await next()
  }
}
