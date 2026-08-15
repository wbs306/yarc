import { createHash } from 'node:crypto'
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { config } from '../lib/config.js'
import { mineruService } from './mineru.service.js'
import { searchService } from './search.service.js'

export type TemporaryPdfStatus = 'parsing' | 'ready' | 'failed'

export interface TemporaryPdfDocument {
  id: string
  title: string
  sourceUrl: string
  status: TemporaryPdfStatus
  path?: string
  error?: string
  timedOut?: boolean
  expiresAt?: string
}

type TemporaryPdfEntry = TemporaryPdfDocument & {
  absoluteDir: string
  lastAccessedAt: number
  parsePromise?: Promise<void>
  cleanupTimer?: ReturnType<typeof setTimeout>
  cleanupRequested?: boolean
}

export interface TemporaryPdfWaitOptions {
  timeoutMs?: number
  retryFailed?: boolean
}

const TEMPORARY_PDF_DIR = 'temporary-pdfs'
const CLEANUP_GRACE_MS = 30_000
const MAX_IDLE_MS = 2 * 60 * 60 * 1000
const STALE_DISK_MS = 24 * 60 * 60 * 1000
const DEFAULT_WAIT_TIMEOUT_MS = 180_000

type TemporaryPdfDependencies = {
  downloadPdf?: (url: string) => Promise<Buffer | null>
  parsePdfToDirectory?: (pdfPath: string, outputDir: string) => Promise<{ text: string }>
  dataDir?: string
  maxFileSize?: number
}

export class TemporaryPdfService {
  private entries = new Map<string, TemporaryPdfEntry>()
  private initialized = false
  private initializePromise: Promise<void> | null = null
  private readonly downloadPdf: (url: string) => Promise<Buffer | null>
  private readonly parsePdfToDirectory: (pdfPath: string, outputDir: string) => Promise<{ text: string }>
  private readonly dataDir: string
  private readonly maxFileSize: number

  constructor(dependencies: TemporaryPdfDependencies = {}) {
    this.downloadPdf = dependencies.downloadPdf || ((url) => searchService.downloadPdf(url))
    this.parsePdfToDirectory = dependencies.parsePdfToDirectory || ((pdfPath, outputDir) => mineruService.parsePdfToDirectory(pdfPath, outputDir))
    this.dataDir = resolve(dependencies.dataDir || config.dataDir)
    this.maxFileSize = dependencies.maxFileSize || config.maxFileSize

    const timer = setInterval(() => void this.cleanupIdleEntries(), 10 * 60 * 1000)
    timer.unref()
  }

  /**
   * Start parsing if needed, but do not wait for MinerU. This is retained for
   * the browser reader API, which polls the document status.
   */
  async create(sourceUrl: string, title?: string, options: { retryFailed?: boolean } = {}): Promise<TemporaryPdfDocument> {
    await this.initialize()
    const normalizedUrl = sourceUrl.trim()
    if (!normalizedUrl) throw new Error('临时 PDF URL 不能为空')

    const id = this.idFor(normalizedUrl)
    const existing = this.entries.get(id)
    if (existing?.status === 'failed' && options.retryFailed) {
      await this.removeEntry(id)
    } else if (existing) {
      this.touch(existing)
      return this.toDocument(existing)
    }

    const absoluteDir = join(this.rootDir(), id)
    const relativePath = relative(this.dataDir, join(absoluteDir, 'content.md')).replace(/\\/g, '/')
    const entry: TemporaryPdfEntry = {
      id,
      title: title?.trim() || '临时 PDF',
      sourceUrl: normalizedUrl,
      status: 'parsing',
      absoluteDir,
      lastAccessedAt: Date.now(),
    }
    this.entries.set(id, entry)

    const contentPath = join(absoluteDir, 'content.md')
    try {
      const info = await stat(contentPath)
      if (info.isFile() && info.size > 0) {
        entry.status = 'ready'
        entry.path = relativePath
        return this.toDocument(entry)
      }
      await rm(absoluteDir, { recursive: true, force: true })
    } catch {
      // The content file is absent; start a new parse below.
    }

    entry.parsePromise = this.parse(entry, relativePath)
    void entry.parsePromise.catch(() => {
      // parse() records failures on the entry. Keep create() fire-and-forget
      // callers from producing an unhandled rejection.
    })
    return this.toDocument(entry)
  }

  /**
   * Start or reuse a parse and wait until the Markdown file is complete. The
   * timeout only affects this caller; MinerU parsing continues in the entry.
   */
  async ensureReady(
    sourceUrl: string,
    title?: string,
    options: TemporaryPdfWaitOptions = {}
  ): Promise<TemporaryPdfDocument> {
    const document = await this.create(sourceUrl, title, { retryFailed: options.retryFailed })
    return this.waitForReady(document.id, options)
  }

  /**
   * Wait for an existing temporary document. A ready result is the only result
   * that may contain a readable path.
   */
  async waitForReady(id: string, options: TemporaryPdfWaitOptions = {}): Promise<TemporaryPdfDocument> {
    await this.initialize()
    const entry = this.entries.get(id)
    if (!entry) throw new Error('临时 PDF 不存在或已过期')

    this.touch(entry)
    if (entry.status === 'failed' && options.retryFailed) {
      const sourceUrl = entry.sourceUrl
      const title = entry.title
      await this.removeEntry(id)
      const restarted = await this.create(sourceUrl, title)
      return this.waitForReady(restarted.id, { ...options, retryFailed: false })
    }
    if (entry.status !== 'parsing' || !entry.parsePromise) return this.toDocument(entry)

    const timeoutMs = Math.max(0, Number(options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS))
    if (timeoutMs === 0) return { ...this.toDocument(entry), timedOut: true }

    let timeout: ReturnType<typeof setTimeout> | undefined
    const timeoutPromise = new Promise<'timeout'>(resolveTimeout => {
      timeout = setTimeout(() => resolveTimeout('timeout'), timeoutMs)
      timeout?.unref?.()
    })
    const result = await Promise.race([entry.parsePromise.then(() => 'parsed' as const), timeoutPromise])
    if (timeout) clearTimeout(timeout)
    if (result === 'timeout' && entry.status === 'parsing') {
      return { ...this.toDocument(entry), timedOut: true }
    }
    return this.toDocument(entry)
  }

  get(id: string): TemporaryPdfDocument | null {
    const entry = this.entries.get(id)
    if (!entry) return null
    this.touch(entry)
    return this.toDocument(entry)
  }

  scheduleCleanup(id: string): boolean {
    const entry = this.entries.get(id)
    if (!entry) return false
    if (entry.status === 'parsing') {
      entry.cleanupRequested = true
      return true
    }
    if (entry.cleanupTimer) clearTimeout(entry.cleanupTimer)
    entry.cleanupTimer = setTimeout(() => void this.removeEntry(id), CLEANUP_GRACE_MS)
    entry.cleanupTimer.unref()
    return true
  }

  private idFor(sourceUrl: string) {
    return createHash('sha256').update(sourceUrl).digest('hex').slice(0, 24)
  }

  private touch(entry: TemporaryPdfEntry) {
    entry.lastAccessedAt = Date.now()
    entry.cleanupRequested = false
    if (entry.cleanupTimer) {
      clearTimeout(entry.cleanupTimer)
      delete entry.cleanupTimer
    }
  }

  private rootDir() {
    return resolve(this.dataDir, TEMPORARY_PDF_DIR)
  }

  private async initialize() {
    if (this.initialized) return
    if (this.initializePromise) return this.initializePromise

    this.initializePromise = (async () => {
      const root = this.rootDir()
      await mkdir(root, { recursive: true })
      const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
      const cutoff = Date.now() - STALE_DISK_MS
      await Promise.all(entries
        .filter(entry => entry.isDirectory())
        .map(async entry => {
          const path = join(root, entry.name)
          const info = await stat(path).catch(() => null)
          if (info && info.mtimeMs < cutoff) await rm(path, { recursive: true, force: true })
        }))
      this.initialized = true
    })()

    try {
      await this.initializePromise
    } finally {
      this.initializePromise = null
    }
  }

  private async parse(entry: TemporaryPdfEntry, relativePath: string) {
    try {
      await mkdir(entry.absoluteDir, { recursive: true })
      const pdf = await this.downloadPdf(entry.sourceUrl)
      if (!pdf) throw new Error('无法下载临时 PDF')
      if (pdf.length > this.maxFileSize) throw new Error(`临时 PDF 超过 ${Math.round(this.maxFileSize / 1024 / 1024)}MB 限制`)

      const pdfPath = join(entry.absoluteDir, 'source.pdf')
      await writeFile(pdfPath, pdf)
      const result = await this.parsePdfToDirectory(pdfPath, join(entry.absoluteDir, 'mineru'))
      if (!result.text.trim()) throw new Error('MinerU 未返回可读取的正文')

      // Never expose a partially written content.md. The ready state is set
      // only after the complete temporary file has been renamed into place.
      const temporaryContentPath = join(entry.absoluteDir, `.content-${process.pid}-${Date.now()}.tmp`)
      const contentPath = join(entry.absoluteDir, 'content.md')
      await writeFile(temporaryContentPath, result.text, 'utf-8')
      await rename(temporaryContentPath, contentPath)
      entry.status = 'ready'
      entry.path = relativePath
      delete entry.error
    } catch (err) {
      entry.status = 'failed'
      entry.error = (err as Error).message || '临时 PDF 解析失败'
      delete entry.path
    }

    if (entry.cleanupRequested) await this.removeEntry(entry.id)
  }

  private async cleanupIdleEntries() {
    const cutoff = Date.now() - MAX_IDLE_MS
    const ids = [...this.entries.values()]
      .filter(entry => entry.lastAccessedAt < cutoff)
      .map(entry => entry.id)
    for (const id of ids) this.scheduleCleanup(id)
  }

  private async removeEntry(id: string) {
    const entry = this.entries.get(id)
    if (!entry) return
    if (entry.cleanupTimer) clearTimeout(entry.cleanupTimer)
    this.entries.delete(id)
    await rm(entry.absoluteDir, { recursive: true, force: true })
  }

  private toDocument(entry: TemporaryPdfEntry): TemporaryPdfDocument {
    return {
      id: entry.id,
      title: entry.title,
      sourceUrl: entry.sourceUrl,
      status: entry.status,
      path: entry.path,
      error: entry.error,
      expiresAt: new Date(entry.lastAccessedAt + MAX_IDLE_MS).toISOString(),
    }
  }
}

export const temporaryPdfService = new TemporaryPdfService()
