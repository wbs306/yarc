/**
 * Service Worker for YARC.
 *
 * Keeps the built application shell and previously viewed workspace resources
 * available when the browser loses access to the YARC backend. Workspace text
 * snapshots are persisted separately in IndexedDB by the live-file client.
 */

// Preserve PDFs cached by the previous PDF-only worker across this upgrade.
const PDF_CACHE = 'yarc-pdf-v1'
const APP_CACHE = 'yarc-app-v3'
const FILE_CACHE = 'yarc-files-v1'
const ACTIVE_CACHES = new Set([PDF_CACHE, APP_CACHE, FILE_CACHE])

const appShellResponse = () => new Response('YARC 当前不可用，且此页面尚未缓存。', {
  status: 503,
  headers: { 'Content-Type': 'text/plain; charset=utf-8' },
})

const cacheResponse = async (cacheName, request, response) => {
  if (!response.ok) return
  const cache = await caches.open(cacheName)
  await cache.put(request, response.clone())
}

const precacheApplicationShell = async () => {
  const cache = await caches.open(APP_CACHE)
  const shell = await fetch('/', { cache: 'no-cache' })
  if (shell.ok) await cache.put('/', shell.clone())

  // Vite's manifest lists every eagerly and lazily loaded build asset, so an
  // installed app can reopen offline instead of relying on a warm browser cache.
  try {
    const manifestResponse = await fetch('/.vite/manifest.json', { cache: 'no-cache' })
    if (!manifestResponse.ok) return
    const manifest = await manifestResponse.json()
    const assets = new Set()
    for (const entry of Object.values(manifest)) {
      if (entry.file) assets.add(`/${entry.file}`)
      for (const css of entry.css || []) assets.add(`/${css}`)
      for (const asset of entry.assets || []) assets.add(`/${asset}`)
    }
    await Promise.all([...assets].map(async (asset) => {
      try {
        const response = await fetch(asset, { cache: 'no-cache' })
        if (response.ok) await cache.put(asset, response)
      } catch {
        // A later runtime request can fill any asset missed during install.
      }
    }))
  } catch {
    // Development builds may not contain a Vite manifest. Runtime caching still
    // makes a successfully opened application available on the next visit.
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(precacheApplicationShell().catch(() => {}))
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => !ACTIVE_CACHES.has(key)).map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  )
})

const networkFirst = async (event, cacheName, fallbackToShell = false) => {
  const { request } = event
  try {
    const response = await fetch(request)
    // Do not delay the visible response while CacheStorage consumes a cloned
    // body (especially important for large workspace attachments).
    event.waitUntil(cacheResponse(cacheName, request, response).catch(() => {}))
    return response
  } catch {
    const cache = await caches.open(cacheName)
    return await cache.match(request)
      || (fallbackToShell ? await cache.match('/') : undefined)
      || appShellResponse()
  }
}

const parseRange = (header, totalLength) => {
  const match = header.match(/^bytes=(\d*)-(\d*)$/)
  if (!match) return null

  let start = match[1] ? parseInt(match[1], 10) : undefined
  let end = match[2] ? parseInt(match[2], 10) : undefined

  if (start === undefined && end !== undefined) {
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

const respondWithPdf = async (event, url) => {
  const request = event.request
  const rangeHeader = request.headers.get('Range')
  const fullRequest = new Request(url.toString(), {
    method: 'GET',
    credentials: request.credentials,
  })
  const cache = await caches.open(PDF_CACHE)
  const cached = await cache.match(fullRequest)

  if (cached) {
    if (!rangeHeader) return cached
    const fullBody = await cached.arrayBuffer()
    const parsed = parseRange(rangeHeader, fullBody.byteLength)
    if (!parsed) return cached
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

  try {
    const response = await fetch(request)
    if (response.ok && !rangeHeader) {
      await cache.put(fullRequest, response.clone())
    } else if (response.ok && rangeHeader) {
      // PDF viewers often issue only Range requests. Populate the full cache in
      // the background so the document is actually available after a disconnect.
      event.waitUntil(
        fetch(fullRequest)
          .then(async (fullResponse) => {
            if (fullResponse.ok) await cache.put(fullRequest, fullResponse)
          })
          .catch(() => {})
      )
    }
    return response
  } catch {
    return new Response('PDF 尚未缓存，当前无法离线读取。', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    })
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.origin !== self.location.origin) return

  if (/^\/api\/papers\/[0-9a-f-]+\/pdf$/i.test(url.pathname)) {
    event.respondWith(respondWithPdf(event, url))
    return
  }

  if (url.pathname === '/api/files' || /^\/api\/files\/(?:content|office\/view|image|download)$/.test(url.pathname)) {
    event.respondWith(networkFirst(event, FILE_CACHE))
    return
  }

  if (!url.pathname.startsWith('/api/') && url.pathname !== '/sw.js') {
    event.respondWith(networkFirst(event, APP_CACHE, request.mode === 'navigate'))
  }
})
