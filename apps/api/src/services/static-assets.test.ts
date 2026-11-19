import assert from 'node:assert/strict'
import test from 'node:test'
import { gunzipSync } from 'node:zlib'
import { Hono } from 'hono'
import { staticCompression } from '../lib/static-compression.js'

const source = 'const workbench = "YARC"\n'.repeat(1000)
const setup = () => {
  const app = new Hono()
  app.use('/assets/*', staticCompression)
  app.get('/assets/app.js', c => {
    c.header('Content-Type', 'application/javascript')
    c.header('Content-Length', String(Buffer.byteLength(source)))
    c.header('Cache-Control', 'public, max-age=31536000, immutable')
    c.header('Vary', 'Origin')
    if (c.req.header('Range')) {
      c.header('Content-Length', '10')
      c.header('Content-Range', `bytes 0-9/${Buffer.byteLength(source)}`)
      return c.body(source.slice(0, 10), 206)
    }
    return c.body(source)
  })
  app.get('/api/events', c => c.body(source, 200, { 'Content-Type': 'text/event-stream' }))
  return app
}

test('static scripts are compressed with correct cache variation and length', async () => {
  const res = await setup().request('/assets/app.js', { headers: { 'Accept-Encoding': 'gzip, br' } })
  assert.equal(res.headers.get('Content-Encoding'), 'gzip')
  assert.equal(res.headers.get('Vary'), 'Origin, Accept-Encoding')
  assert.equal(res.headers.get('Content-Length'), null)
  assert.match(res.headers.get('Cache-Control')!, /immutable/)
  const compressed = Buffer.from(await res.arrayBuffer())
  assert.ok(compressed.byteLength < Buffer.byteLength(source) / 2)
  assert.equal(gunzipSync(compressed).toString(), source)
})

test('identity clients and HEAD retain the original representation metadata', async () => {
  const app = setup()
  for (const method of ['GET', 'HEAD']) {
    const res = await app.request('/assets/app.js', { method, headers: { 'Accept-Encoding': method === 'HEAD' ? 'gzip' : 'gzip;q=0' } })
    assert.equal(res.headers.get('Content-Encoding'), null)
    assert.equal(res.headers.get('Content-Length'), String(Buffer.byteLength(source)))
    assert.equal(res.headers.get('Vary'), 'Origin, Accept-Encoding')
    assert.equal(await res.text(), method === 'HEAD' ? '' : source)
  }
})

test('range responses and API event streams are never compressed', async () => {
  const app = setup()
  const range = await app.request('/assets/app.js', { headers: { 'Accept-Encoding': 'gzip', Range: 'bytes=0-9' } })
  assert.equal(range.status, 206)
  assert.equal(range.headers.get('Content-Encoding'), null)
  assert.equal(range.headers.get('Content-Length'), '10')
  assert.equal(range.headers.get('Content-Range'), `bytes 0-9/${Buffer.byteLength(source)}`)
  assert.equal(await range.text(), source.slice(0, 10))
  const api = await app.request('/api/events', { headers: { 'Accept-Encoding': 'gzip' } })
  assert.equal(api.headers.get('Content-Encoding'), null)
  assert.equal(await api.text(), source)
})
