import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

const worker = await readFile(new URL('../../public/sw.js', import.meta.url), 'utf8')
const origin = 'https://yarc.test'

type WorkerEvent = {
  request?: Request
  data?: { type: string; assets: unknown[] }
  waitUntil: (promise: Promise<unknown>) => void
  respondWith: (promise: Promise<Response>) => void
}

function setup(fetch: (request: Request | string, init?: RequestInit) => Promise<Response>) {
  const handlers = new Map<string, (event: WorkerEvent) => void>()
  const stores = new Map<string, Map<string, Response>>()
  const key = (request: Request | string) => new URL(typeof request === 'string' ? request : request.url, origin).href
  const open = async (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map())
    const store = stores.get(name)!
    return {
      put: async (request: Request | string, response: Response) => { store.set(key(request), response.clone()) },
      match: async (request: Request | string) => store.get(key(request))?.clone(),
    }
  }
  runInNewContext(worker, {
    self: { location: { origin }, addEventListener: (name: string, handler: (event: WorkerEvent) => void) => handlers.set(name, handler), skipWaiting: () => {} },
    caches: { open }, fetch, Response, Request, URL,
  })
  const dispatch = async (name: string, request?: Request, data?: WorkerEvent['data']) => {
    const pending: Promise<unknown>[] = []
    let response: Promise<Response> | undefined
    handlers.get(name)!({ request, data, waitUntil: task => { pending.push(task) }, respondWith: task => { response = task } })
    const result = await response
    await Promise.all(pending)
    return result
  }
  return { dispatch, open, stores }
}

test('installation precaches only entry/static dependencies, not lazy features or font/WASM variants', async () => {
  const requests: string[] = []
  const manifest = {
    'index.html': { isEntry: true, file: 'assets/index-a.js', css: ['assets/index-a.css'], imports: ['_shared'], dynamicImports: ['pdf'], assets: ['assets/font.woff2'] },
    _shared: { file: 'assets/shared-a.js', imports: ['index.html'] },
    pdf: { file: 'assets/pdf-a.js', assets: ['assets/pdf.wasm'], css: ['assets/pdf.css'] },
  }
  const { dispatch, stores } = setup(async request => {
    const path = String(request)
    requests.push(path)
    return new Response(path === '/.vite/manifest.json' ? JSON.stringify(manifest) : 'asset')
  })
  await dispatch('install')
  assert.deepEqual(requests.sort(), ['/', '/.vite/manifest.json', '/assets/index-a.css', '/assets/index-a.js', '/assets/shared-a.js'].sort())
  assert.equal(stores.get('yarc-app-v4')?.size, 4)
})

test('post-route warming caches only visited same-origin assets and preserves existing entries', async () => {
  const requested: string[] = []
  const { dispatch, open } = setup(async request => {
    requested.push(String(request))
    return new Response('opened before activation')
  })
  const data = { type: 'cache-visited-assets', assets: [`${origin}/assets/page-hash.js`, `${origin}/assets/page-hash.js`, 'https://untrusted.test/assets/a.js', `${origin}/api/files`, null] }
  await dispatch('message', undefined, data)
  await dispatch('message', undefined, data)
  assert.deepEqual(requested, [`${origin}/assets/page-hash.js`])
  assert.equal(await (await (await open('yarc-app-v4')).match('/assets/page-hash.js'))?.text(), 'opened before activation')
})

test('visited immutable assets use the cache without contacting the network again', async () => {
  let calls = 0
  const { dispatch } = setup(async () => { calls++; return new Response('visited asset') })
  const request = new Request(`${origin}/assets/editor-hash.js`)
  assert.equal(await (await dispatch('fetch', request))?.text(), 'visited asset')
  assert.equal(await (await dispatch('fetch', request))?.text(), 'visited asset')
  assert.equal(calls, 1)
})

test('navigation still checks for updates and falls back to cached shell offline', async () => {
  let calls = 0
  const { dispatch, open } = setup(async () => { calls++; throw new Error('offline') })
  const cache = await open('yarc-app-v4')
  await cache.put('/', new Response('cached shell'))
  const request = new Request(`${origin}/projects/demo`)
  Object.defineProperty(request, 'mode', { value: 'navigate' })
  assert.equal(await (await dispatch('fetch', request))?.text(), 'cached shell')
  assert.equal(calls, 1)
})

test('previously cached PDFs still serve byte ranges without a network request', async () => {
  const { dispatch, open } = setup(async () => { throw new Error('unexpected network') })
  const url = `${origin}/api/papers/aaaa-bbbb/pdf`
  const cache = await open('yarc-pdf-v1')
  await cache.put(url, new Response('0123456789'))
  const response = await dispatch('fetch', new Request(url, { headers: { Range: 'bytes=2-5' } }))
  assert.equal(response?.status, 206)
  assert.equal(response?.headers.get('Content-Range'), 'bytes 2-5/10')
  assert.equal(await response?.text(), '2345')
})
