import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TemporaryPdfService } from './temporary-pdf.service.js'

const services: TemporaryPdfService[] = []
const tempDirs: string[] = []

afterEach(async () => {
  for (const service of services.splice(0)) {
    // The service's cleanup timer is intentionally unref'd; dropping it is
    // sufficient for the isolated test process.
    void service
  }
  for (const directory of tempDirs.splice(0)) await rm(directory, { recursive: true, force: true })
})

const createService = async (options: {
  parseText?: string
  parsePages?: Array<{ page: number; text: string }>
  parseDelayMs?: number
  downloadDelayMs?: number
} = {}) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'yarc-temporary-pdf-'))
  tempDirs.push(dataDir)
  let downloads = 0
  let parses = 0
  const service = new TemporaryPdfService({
    dataDir,
    downloadPdf: async () => {
      downloads++
      if (options.downloadDelayMs) await new Promise(resolve => setTimeout(resolve, options.downloadDelayMs))
      return Buffer.from('%PDF-test')
    },
    parsePdfToDirectory: async (_pdfPath, _outputDir) => {
      parses++
      if (options.parseDelayMs) await new Promise(resolve => setTimeout(resolve, options.parseDelayMs))
      return {
        text: options.parseText ?? '# Parsed paper\n',
        ...(options.parsePages ? { pages: options.parsePages } : {}),
      }
    },
    maxFileSize: 1024 * 1024,
  })
  services.push(service)
  return { service, dataDir, counters: { get downloads() { return downloads }, get parses() { return parses } } }
}

describe('TemporaryPdfService agent preview lifecycle', () => {
  it('waits for parsing and only returns a readable path after atomic completion', async () => {
    const { service, dataDir, counters } = await createService({ parseDelayMs: 20 })

    const document = await service.ensureReady('https://example.com/paper.pdf', 'Test paper', { timeoutMs: 1000 })

    assert.equal(document.status, 'ready')
    assert.ok(document.path)
    assert.equal(counters.downloads, 1)
    assert.equal(counters.parses, 1)
    assert.equal(await readFile(join(dataDir, document.path!), 'utf8'), '# Parsed paper\n')
  })

  it('deduplicates concurrent parsing and reports timeout without exposing a path', async () => {
    const { service, counters } = await createService({ parseDelayMs: 50 })

    const first = await service.create('https://example.com/concurrent.pdf')
    const [timedOut, ready] = await Promise.all([
      service.waitForReady(first.id, { timeoutMs: 1 }),
      service.waitForReady(first.id, { timeoutMs: 1000 }),
    ])

    assert.equal(timedOut.status, 'parsing')
    assert.equal(timedOut.timedOut, true)
    assert.equal(timedOut.path, undefined)
    assert.equal(ready.status, 'ready')
    assert.ok(ready.path)
    assert.equal(counters.downloads, 1)
    assert.equal(counters.parses, 1)
  })

  it('persists parsed pages and caches temporary readable views', async () => {
    const { service, dataDir } = await createService({
      parsePages: [
        { page: 1, text: 'first page' },
        { page: 2, text: 'second page' },
      ],
    })

    const document = await service.ensureReady('https://example.com/pages.pdf', 'Pages paper', { timeoutMs: 1000 })
    assert.deepEqual(await service.getPages(document.id), [
      { page: 1, text: 'first page' },
      { page: 2, text: 'second page' },
    ])

    const viewPath = await service.createView(document.id, '[page 2]\nsecond page', { mode: 'pages', startPage: 2, endPage: 2 })
    assert.equal(await readFile(join(dataDir, viewPath), 'utf8'), '[page 2]\nsecond page')
    assert.equal(await service.createView(document.id, '[page 2]\nsecond page', { mode: 'pages', startPage: 2, endPage: 2 }), viewPath)
  })

  it('records a failed parse without returning a path', async () => {
    const { service } = await createService({ parseText: '  ' })

    const document = await service.ensureReady('https://example.com/empty.pdf', undefined, { timeoutMs: 1000 })

    assert.equal(document.status, 'failed')
    assert.equal(document.path, undefined)
    assert.match(document.error || '', /MinerU 未返回可读取的正文/)
  })
})
