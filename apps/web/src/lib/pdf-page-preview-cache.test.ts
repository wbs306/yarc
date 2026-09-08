import assert from 'node:assert/strict'
import test from 'node:test'
import { PdfPagePreviewCache } from './pdf-page-preview-cache'

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

const fakeImages = () => {
  let next = 0
  const revoked: string[] = []
  return {
    revoked,
    create: () => `blob:preview-${++next}`,
    revoke: (url: string) => { revoked.push(url) },
    decode: async (_url: string) => {},
  }
}

test('navigation and mounted page share one render and wait for image decoding', async () => {
  const decoded = deferred<void>()
  let renders = 0
  const images = fakeImages()
  const cache = new PdfPagePreviewCache(async () => {
    renders++
    return new Blob(['page'])
  }, 2, { ...images, decode: () => decoded.promise })
  const first = cache.get(20)
  assert.equal(cache.get(20), first)
  let ready = false
  void first.then(() => { ready = true })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(ready, false)
  decoded.resolve()
  assert.equal(await first, 'blob:preview-1')
  assert.equal(await cache.get(20), 'blob:preview-1')
  assert.equal(renders, 1)
  cache.clear()
  assert.deepEqual(images.revoked, ['blob:preview-1'])
})

test('evicts the least recently used preview instead of rendering every page', async () => {
  const rendered: number[] = []
  const images = fakeImages()
  const cache = new PdfPagePreviewCache(async (page) => {
    rendered.push(page)
    return new Blob()
  }, 2, images)
  await cache.get(0)
  await cache.get(10)
  await cache.get(0)
  await cache.get(20)
  assert.deepEqual(images.revoked, ['blob:preview-2'])
  await cache.get(10)
  assert.deepEqual(rendered, [0, 10, 20, 10])
  cache.clear()
})

test('keeps the destination ready while intermediate pages pass through the cache', async () => {
  const images = fakeImages()
  const cache = new PdfPagePreviewCache(async () => new Blob(), 2, images)
  const target = await cache.get(20, true)
  for (let page = 0; page < 20; page++) await cache.get(page)
  assert.equal(await cache.get(20), target)
  assert.equal(images.revoked.includes(target!), false)
  cache.clear()
  assert.equal(images.revoked.includes(target!), true)
})

test('discards a render completed after changing documents', async () => {
  const render = deferred<Blob>()
  const images = fakeImages()
  const cache = new PdfPagePreviewCache(() => render.promise, 2, images)
  const pending = cache.get(0)
  await Promise.resolve()
  cache.clear()
  render.resolve(new Blob())
  assert.equal(await pending, null)
  assert.deepEqual(images.revoked, [])
})

test('revokes an image decoded after changing documents', async () => {
  const decoded = deferred<void>()
  const images = fakeImages()
  const cache = new PdfPagePreviewCache(async () => new Blob(), 2, {
    ...images, decode: () => decoded.promise,
  })
  const pending = cache.get(0)
  await new Promise((resolve) => setTimeout(resolve, 0))
  cache.clear()
  decoded.resolve()
  assert.equal(await pending, null)
  assert.deepEqual(images.revoked, ['blob:preview-1'])
})

test('failed previews do not block navigation and can be retried', async () => {
  let attempts = 0
  const images = fakeImages()
  const cache = new PdfPagePreviewCache(async () => {
    if (++attempts === 1) throw new Error('render failed')
    return new Blob()
  }, 2, images)
  assert.equal(await cache.get(0), null)
  assert.equal(await cache.get(0), 'blob:preview-1')
  cache.clear()
})
