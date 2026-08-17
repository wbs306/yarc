import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import {
  WebDavClient,
  isExcludedPath,
  isSafeToDeleteRemoteFile,
  isSelectedPath,
  normalizeWebDavConfig,
  shouldSyncPath,
  shouldTraverseSyncDirectory,
} from './webdav-sync.service.js'

const directories = new Set(['/dav/'])
const files = new Map<string, { data: Buffer; modified: number }>()
const propfindRequests: string[] = []
const deleteRequests: string[] = []
let server: ReturnType<typeof createServer>
let baseUrl = ''

const xmlEscape = (value: string) => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')

const collectBody = async (request: IncomingMessage) => {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

const sendMultistatus = (response: ServerResponse, paths: string[]) => {
  const entries = paths.map(path => {
    const file = files.get(path)
    const directory = directories.has(path)
    return `<d:response><d:href>${xmlEscape(path)}</d:href><d:propstat><d:prop>`
      + `<d:resourcetype>${directory ? '<d:collection/>' : ''}</d:resourcetype>`
      + `<d:getcontentlength>${file?.data.byteLength || 0}</d:getcontentlength>`
      + `<d:getlastmodified>${new Date(file?.modified || Date.now()).toUTCString()}</d:getlastmodified>`
      + `<d:getetag>"${file ? `${file.data.byteLength}-${file.modified}` : ''}"</d:getetag>`
      + '</d:prop></d:propstat></d:response>'
  }).join('')
  response.writeHead(207, { 'Content-Type': 'application/xml' })
  response.end(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${entries}</d:multistatus>`)
}

before(async () => {
  server = createServer(async (request, response) => {
    const path = new URL(request.url || '/', 'http://localhost').pathname
    if (request.headers.authorization !== `Basic ${Buffer.from('tester:secret').toString('base64')}`) {
      response.writeHead(401)
      response.end('Unauthorized')
      return
    }

    if (request.method === 'MKCOL') {
      if (directories.has(path)) response.writeHead(405)
      else {
        directories.add(path.endsWith('/') ? path : `${path}/`)
        response.writeHead(201)
      }
      response.end()
      return
    }

    if (request.method === 'PROPFIND') {
      propfindRequests.push(path)
      const directoryPath = path.endsWith('/') ? path : `${path}/`
      if (!directories.has(directoryPath) && !files.has(path)) {
        response.writeHead(404)
        response.end()
        return
      }
      if (request.headers.depth === '0') {
        sendMultistatus(response, [directories.has(directoryPath) ? directoryPath : path])
        return
      }
      const children = [directoryPath]
      for (const directory of directories) {
        if (directory === directoryPath || !directory.startsWith(directoryPath)) continue
        const remainder = directory.slice(directoryPath.length).replace(/\/$/, '')
        if (remainder && !remainder.includes('/')) children.push(directory)
      }
      for (const filePath of files.keys()) {
        if (!filePath.startsWith(directoryPath)) continue
        const remainder = filePath.slice(directoryPath.length)
        if (remainder && !remainder.includes('/')) children.push(filePath)
      }
      sendMultistatus(response, children)
      return
    }

    if (request.method === 'PUT') {
      const data = await collectBody(request)
      const modifiedSeconds = Number(request.headers['x-oc-mtime'])
      const modified = Number.isFinite(modifiedSeconds) ? modifiedSeconds * 1000 : Date.now()
      files.set(path, { data, modified })
      response.writeHead(201, {
        ETag: `"${data.byteLength}-${modified}"`,
        'Last-Modified': new Date(modified).toUTCString(),
      })
      response.end()
      return
    }

    if (request.method === 'DELETE') {
      deleteRequests.push(path)
      if (!files.has(path)) {
        response.writeHead(404)
      } else {
        files.delete(path)
        response.writeHead(204)
      }
      response.end()
      return
    }

    if (request.method === 'GET') {
      const file = files.get(path)
      if (!file) {
        response.writeHead(404)
        response.end()
        return
      }
      response.writeHead(200, {
        'Content-Length': file.data.byteLength,
        'Last-Modified': new Date(file.modified).toUTCString(),
      })
      response.end(file.data)
      return
    }

    response.writeHead(405)
    response.end()
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Mock WebDAV server did not start')
  baseUrl = `http://127.0.0.1:${address.port}/dav`
})

after(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
})

describe('WebDAV path selection and exclusions', () => {
  it('supports directory selection with exclusion patterns taking priority', () => {
    assert.equal(isSelectedPath('papers/a/file.pdf', false, ['papers/a']), true)
    assert.equal(isSelectedPath('papers/b/file.pdf', false, ['papers/a']), false)
    assert.equal(isExcludedPath('papers/a/cache/result.tmp', ['**/*.tmp']), true)
    assert.equal(isExcludedPath('papers/a/.cache/index.json', ['.cache']), true)
    assert.equal(isExcludedPath('papers/private/a.pdf', ['papers/private/**']), true)
    assert.equal(shouldSyncPath('papers/a/file.pdf', {
      syncAll: false,
      selectedPaths: ['papers/a'],
      excludePatterns: ['**/*.tmp'],
    }), true)
    assert.equal(shouldSyncPath('papers/a/draft.tmp', {
      syncAll: false,
      selectedPaths: ['papers/a'],
      excludePatterns: ['**/*.tmp'],
    }), false)
    assert.equal(shouldSyncPath('.pi/agent/auth.json', {
      syncAll: true,
      selectedPaths: [],
      excludePatterns: [],
    }), false)
    assert.equal(shouldSyncPath('.pi/agent/sessions/run.jsonl', {
      syncAll: true,
      selectedPaths: [],
      excludePatterns: [],
    }), false)
    assert.equal(shouldSyncPath('.pi/agent/settings.json', {
      syncAll: true,
      selectedPaths: [],
      excludePatterns: [],
    }), true)
    assert.equal(shouldSyncPath('works/demo/node_modules/pkg/index.js', {
      syncAll: true,
      selectedPaths: [],
      excludePatterns: [],
    }), false)
    assert.equal(shouldSyncPath('works/demo/src/index.ts', {
      syncAll: true,
      selectedPaths: [],
      excludePatterns: [],
    }), true)
    assert.equal(shouldTraverseSyncDirectory('papers', false, ['works/demo', 'generated/result.md']), false)
    assert.equal(shouldTraverseSyncDirectory('works', false, ['works/demo', 'generated/result.md']), true)
    assert.equal(shouldTraverseSyncDirectory('works/demo', false, ['works/demo', 'generated/result.md']), true)
    assert.equal(shouldTraverseSyncDirectory('works/demo/src', false, ['works/demo', 'generated/result.md']), true)
    assert.equal(shouldTraverseSyncDirectory('generated', false, ['works/demo', 'generated/result.md']), true)
    assert.equal(shouldTraverseSyncDirectory('generated/other', false, ['works/demo', 'generated/result.md']), false)
    assert.deepEqual(normalizeWebDavConfig({
      selectedPaths: ['papers/a/file.pdf', 'papers/a', 'notes/todo.md'],
    }).selectedPaths, ['notes/todo.md', 'papers/a'])
    assert.equal(normalizeWebDavConfig({ enabled: false, paused: true }).paused, false)
    assert.equal(normalizeWebDavConfig({ enabled: true, paused: true }).paused, true)
    assert.equal(normalizeWebDavConfig({
      direction: 'download',
      syncOnLocalChange: true,
    }).syncOnLocalChange, false)
    assert.equal(normalizeWebDavConfig({
      direction: 'download',
      propagateLocalDeletions: true,
    }).propagateLocalDeletions, false)
    assert.equal(normalizeWebDavConfig({
      direction: 'upload',
      propagateLocalDeletions: true,
    }).propagateLocalDeletions, true)
    assert.equal(normalizeWebDavConfig({
      direction: 'upload',
      syncOnLocalChange: true,
      localChangeDebounceSeconds: 1,
    }).localChangeDebounceSeconds, 2)
    const remote = { path: 'notes/delete.md', size: 4, modified: 1_000, etag: 'etag' }
    assert.equal(isSafeToDeleteRemoteFile({ local: '4:1000', remote: '4:1000:etag' }, remote), true)
    assert.equal(isSafeToDeleteRemoteFile({ local: '4:1000', remote: '4:1000:changed' }, remote), false)
    assert.equal(isSafeToDeleteRemoteFile(undefined, remote), false)
    assert.throws(
      () => normalizeWebDavConfig({ url: 'https://user:secret@example.com/dav' }),
      /不要把凭据写在 WebDAV 地址中/,
    )
  })
})

describe('WebDavClient', () => {
  it('tests a connection and uploads, lists, and downloads a nested file', async () => {
    const client = new WebDavClient({
      url: baseUrl,
      username: 'tester',
      remotePath: 'sync-root',
      timeoutSeconds: 5,
    }, 'secret')

    await client.test()
    assert.equal(directories.has('/dav/sync-root/'), true)

    const modified = Date.now() - 10_000
    const uploaded = await client.upload('notes/example.md', new TextEncoder().encode('# synced\n'), modified)

    const remoteFiles = await client.list()
    const listed = remoteFiles.get('notes/example.md')
    assert.equal(remoteFiles.has('notes/example.md'), true)
    assert.equal(listed?.size, 9)
    assert.equal(uploaded.modified, listed?.modified)
    assert.equal(uploaded.etag, listed?.etag)

    const downloaded = await client.download('notes/example.md')
    assert.equal(new TextDecoder().decode(downloaded), '# synced\n')
  })

  it('deletes a remote file when requested', async () => {
    const client = new WebDavClient({
      url: baseUrl,
      username: 'tester',
      remotePath: 'sync-root',
      timeoutSeconds: 5,
    }, 'secret')

    await client.upload('delete/example.md', new TextEncoder().encode('delete me'), Date.now())
    deleteRequests.length = 0
    await client.deleteFile('delete/example.md')

    assert.deepEqual(deleteRequests, ['/dav/sync-root/delete/example.md'])
    assert.equal(files.has('/dav/sync-root/delete/example.md'), false)
  })

  it('only traverses selected remote directory branches', async () => {
    const client = new WebDavClient({
      url: baseUrl,
      username: 'tester',
      remotePath: 'sync-root',
      timeoutSeconds: 5,
    }, 'secret')

    await client.upload('selected/inside.md', new TextEncoder().encode('selected'), Date.now())
    await client.upload('unselected/outside.md', new TextEncoder().encode('unselected'), Date.now())
    propfindRequests.length = 0

    const remoteFiles = await client.list({
      syncAll: false,
      selectedPaths: ['selected'],
      excludePatterns: [],
    })

    assert.deepEqual([...remoteFiles.keys()], ['selected/inside.md'])
    assert.equal(propfindRequests.some(path => path.endsWith('/selected/')), true)
    assert.equal(propfindRequests.some(path => path.endsWith('/unselected/')), false)
  })

  it('streams file uploads, hashes, and downloads without buffering the whole file', async () => {
    const client = new WebDavClient({
      url: baseUrl,
      username: 'tester',
      remotePath: 'sync-root',
      timeoutSeconds: 5,
    }, 'secret')
    const directory = await mkdtemp(join(tmpdir(), 'yarc-webdav-test-'))
    const source = join(directory, 'source.bin')
    const destination = join(directory, 'destination.bin')
    const data = Buffer.alloc(256 * 1024, 0x5a)

    try {
      await writeFile(source, data)
      await client.uploadFile('stream/example.bin', source, data.byteLength, Date.now() - 5_000)
      assert.equal(await client.hash('stream/example.bin'), createHash('sha256').update(data).digest('hex'))

      await client.downloadTo('stream/example.bin', destination)
      assert.deepEqual(await readFile(destination), data)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
