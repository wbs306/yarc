/**
 * Service Worker for YARC.
 *
 * Caches PDF responses in CacheStorage so that switching between papers
 * does not re-fetch the full binary each time.  Non-PDF requests pass
 * through to the network unchanged.
 *
 * Handles both full (200) and range (206) requests:
 *   - First full request is cached.
 *   - Subsequent range requests are served from the cached full response
 *     by slicing the body.
 *   - If no cache exists yet and a range request comes in, the full PDF
 *     is fetched in the background to populate the cache for next time.
 */

const PDF_CACHE = 'yarc-pdf-v1'

self.addEventListener('install', () => self.skipWaiting())

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== PDF_CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)

  if (
    event.request.method !== 'GET' ||
    !/^\/api\/papers\/[0-9a-f-]+\/pdf$/i.test(url.pathname)
  ) {
    return
  }

  const rangeHeader = event.request.headers.get('Range')

  event.respondWith(
    caches.open(PDF_CACHE).then(async (cache) => {
      const cached = await cache.match(event.request)

      if (cached && !rangeHeader) {
        // Full request, cache hit.
        return cached
      }

      if (cached && rangeHeader) {
        // Range request, cache hit — slice the full body.
        const fullBody = await cached.arrayBuffer()
        const parsed = parseRange(rangeHeader, fullBody.byteLength)
        if (parsed) {
          const slice = fullBody.slice(parsed.start, parsed.end + 1)
          return new Response(slice, {
            status: 206,
            headers: {
              'Content-Type': 'application/pdf',
              'Content-Range': `bytes ${parsed.start}-${parsed.end}/${fullBody.byteLength}`,
              'Content-Length': String(slice.byteLength),
              'Accept-Ranges': 'bytes',
            },
          })
        }
        // Malformed range — return full response.
        return cached
      }

      // Cache miss — fetch from network.
      const response = await fetch(event.request)

      if (response.ok && !rangeHeader) {
        // Full 200 response — cache it.
        cache.put(event.request, response.clone())
      } else if (rangeHeader && !response.ok) {
        // Range request failed (maybe 416) — try fetching the full PDF
        // in the background to populate the cache for next time.
        const fullReq = new Request(event.request, { headers: new Headers() })
        fetch(fullReq).then((r) => {
          if (r.ok) cache.put(fullReq, r.clone())
        }).catch(() => {})
      }

      return response
    })
  )
})

function parseRange(header, totalLength) {
  const match = header.match(/^bytes=(\d*)-(\d*)$/)
  if (!match) return null

  let start = match[1] ? parseInt(match[1], 10) : undefined
  let end = match[2] ? parseInt(match[2], 10) : undefined

  if (start === undefined && end !== undefined) {
    // Suffix range: bytes=-500
    start = Math.max(totalLength - end, 0)
    end = totalLength - 1
  } else if (start !== undefined && end === undefined) {
    end = totalLength - 1
  } else if (start === undefined || end === undefined) {
    return null
  }

  if (start > end || start >= totalLength) return null
  end = Math.min(end, totalLength - 1)
  return { start, end }
}
