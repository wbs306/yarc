import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import type { TestContext } from 'node:test'
import { mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const testRoot = await mkdtemp(join(tmpdir(), 'yarc-import-job-test-'))
const globalRoot = join(testRoot, 'data')
const projectA = join(globalRoot, 'projects', 'a')
const projectB = join(globalRoot, 'projects', 'b')
const externalPdf = join(testRoot, 'external paper 中文.pdf')
const pdf = Buffer.from('%PDF-1.7\nexternal fixture\n')
process.env.DATA_DIR = globalRoot

const { ImportJobService } = await import('./import-job.service.js')
const { paperService } = await import('./paper.service.js')
const { searchService } = await import('./search.service.js')
const { withAgentWorkspaceCwd } = await import('../lib/agent-workspace.js')
const { cache } = await import('../lib/cache.js')

before(async () => {
  await mkdir(projectA, { recursive: true })
  await mkdir(projectB, { recursive: true })
  await writeFile(externalPdf, pdf)
  await writeFile(join(globalRoot, 'paper.pdf'), '%PDF-1.7\nglobal\n')
  await writeFile(join(projectA, 'paper.pdf'), '%PDF-1.7\nproject a\n')
  await writeFile(join(projectB, 'paper.pdf'), '%PDF-1.7\nproject b\n')
  await writeFile(join(testRoot, 'not-pdf.txt'), 'not a PDF')
  const oversized = await open(join(testRoot, 'oversized.pdf'), 'w')
  try {
    await oversized.truncate(50 * 1024 * 1024 + 1)
  } finally {
    await oversized.close()
  }
})

after(async () => {
  cache.destroy()
  await rm(testRoot, { recursive: true, force: true })
})

const mockImport = (t: TestContext) => {
  const originalImport = paperService.importFromSearchResult.bind(paperService)
  return t.mock.method(paperService, 'importFromSearchResult', async (paper: unknown, buffer: Buffer) => {
    // Exercise the real signature validation for invalid content. It rejects
    // before any file/database writes; valid fixture imports remain mocked.
    if (buffer.subarray(0, 5).toString('utf8') !== '%PDF-') {
      return originalImport(paper, buffer)
    }
    return { id: 'fixture-paper' }
  })
}

const waitForJob = async (job: { status: string }) => {
  const deadline = Date.now() + 3000
  while (job.status === 'queued' || job.status === 'running') {
    assert.ok(Date.now() < deadline, 'import job did not finish')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

const startImport = (source: string, workspaceCwd = projectA) => new ImportJobService().create({
  papers: [{ title: 'Fixture', source: 'local', pdfPath: source }],
  workspaceCwd,
})

describe('ImportJobService PDF source resolution', () => {
  it('imports absolute paths and encoded file URLs outside the project/data workspace', async (t) => {
    const imported = mockImport(t)
    for (const source of [externalPdf, pathToFileURL(externalPdf).href]) {
      const job = startImport(source)
      await waitForJob(job)
      assert.equal(job.completed, 1)
      assert.deepEqual(job.errors, [])
    }
    assert.equal(imported.mock.calls.length, 2)
    for (const call of imported.mock.calls) assert.deepEqual(call.arguments[1], pdf)
  })

  it('keeps same-name relative files scoped to each queued project', async (t) => {
    const imported = mockImport(t)
    const jobs = [startImport('paper.pdf', projectA), startImport('paper.pdf', projectB)]
    await Promise.all(jobs.map(waitForJob))
    assert.deepEqual(jobs.map(job => job.completed), [1, 1])
    const contents = imported.mock.calls.map(call => (call.arguments[1] as Buffer).toString('utf8')).sort()
    assert.deepEqual(contents, ['%PDF-1.7\nproject a\n', '%PDF-1.7\nproject b\n'])
  })

  it('captures the contextual workspace and defaults ordinary imports to DATA_DIR', async (t) => {
    const imported = mockImport(t)
    const service = new ImportJobService()
    const params = { papers: [{ title: 'Fixture', source: 'local', pdfPath: 'paper.pdf' }] }
    const contextual = withAgentWorkspaceCwd(projectA, () => service.create(params))
    const global = service.create(params)
    await Promise.all([waitForJob(contextual), waitForJob(global)])
    assert.equal(contextual.completed, 1)
    assert.equal(global.completed, 1)
    const contents = imported.mock.calls.map(call => (call.arguments[1] as Buffer).toString('utf8')).sort()
    assert.deepEqual(contents, ['%PDF-1.7\nglobal\n', '%PDF-1.7\nproject a\n'])
  })

  it('supports parent-relative external paths without initializing Pi configuration', async (t) => {
    mockImport(t)
    const job = startImport('../../../external paper 中文.pdf')
    await waitForJob(job)
    assert.equal(job.completed, 1)
    const { stat } = await import('node:fs/promises')
    await assert.rejects(stat(join(globalRoot, '.pi')), { code: 'ENOENT' })
  })

  it('delegates HTTP and HTTPS URLs to the existing downloader', async (t) => {
    mockImport(t)
    const downloaded = t.mock.method(searchService, 'downloadPdf', async () => pdf)
    for (const source of ['http://example.test/paper.pdf', 'https://example.test/download?id=1']) {
      const job = new ImportJobService().create({ papers: [{ title: 'Fixture', source: 'local', pdfUrl: source }] })
      await waitForJob(job)
      assert.equal(job.completed, 1)
      assert.equal(downloaded.mock.calls.at(-1)?.arguments[0], source)
    }
  })

  it('preserves base64 imports', async (t) => {
    const imported = mockImport(t)
    const job = new ImportJobService().create({
      papers: [{ title: 'Fixture', source: 'local', pdfBase64: pdf.toString('base64') }],
    })
    await waitForJob(job)
    assert.equal(job.completed, 1)
    assert.deepEqual(imported.mock.calls[0]?.arguments[1], pdf)
  })

  it('reports missing files, directories, oversized files and unsupported protocols', async (t) => {
    const imported = mockImport(t)
    const downloaded = t.mock.method(searchService, 'downloadPdf', async () => pdf)
    for (const [source, expected] of [
      [join(testRoot, 'missing.pdf'), /ENOENT/],
      [projectA, /Local PDF path is not a file/],
      [join(testRoot, 'oversized.pdf'), /File exceeds 50MB limit/],
      ['ftp://example.test/paper.pdf', /Unsupported PDF source protocol: ftp:/],
      ['data:application/pdf;base64,JVBERi0=', /Unsupported PDF source protocol: data:/],
      ['file://remote-host/paper.pdf', /File URL host/],
      ['   ', /No PDF source available/],
    ] as const) {
      const job = startImport(source)
      await waitForJob(job)
      assert.equal(job.failed, 1, source)
      assert.match(job.errors[0]?.message || '', expected)
    }
    assert.equal(imported.mock.calls.length, 0)
    assert.equal(downloaded.mock.calls.length, 0)
  })

  it('still rejects non-PDF content before persisting a library paper', async (t) => {
    mockImport(t)
    const job = startImport(join(testRoot, 'not-pdf.txt'))
    await waitForJob(job)
    assert.equal(job.failed, 1)
    assert.match(job.errors[0]?.message || '', /not a valid PDF/)
  })

  it('reports HTTP download failure through the import job', async (t) => {
    const imported = mockImport(t)
    t.mock.method(searchService, 'downloadPdf', async () => null)
    const job = startImport('https://example.test/missing.pdf')
    await waitForJob(job)
    assert.equal(job.failed, 1)
    assert.match(job.errors[0]?.message || '', /PDF download failed/)
    assert.equal(imported.mock.calls.length, 0)
  })
})
