import { createHash } from 'node:crypto'
import { access, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
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
}

type TemporaryPdfEntry = TemporaryPdfDocument & {
  absoluteDir: string
  lastAccessedAt: number
  cleanupTimer?: ReturnType<typeof setTimeout>
  cleanupRequested?: boolean
}

const TEMPORARY_PDF_DIR = 'temporary-pdfs'
const CLEANUP_GRACE_MS = 30_000
const MAX_IDLE_MS = 2 * 60 * 60 * 1000
const STALE_DISK_MS = 24 * 60 * 60 * 1000

export class TemporaryPdfService {
  private entries = new Map<string, TemporaryPdfEntry>()
  private initialized = false

  constructor() {
    const timer = setInterval(() => void this.cleanupIdleEntries(), 10 * 60 * 1000)
    timer.unref()
  }

  async create(sourceUrl: string, title?: string): Promise<TemporaryPdfDocument> {
    await this.initialize()
    const normalizedUrl = sourceUrl.trim()
    const id = createHash('sha256').update(normalizedUrl).digest('hex').slice(0, 24)
    const existing = this.entries.get(id)
    if (existing?.status === 'failed') {
      await this.removeEntry(id)
    } else if (existing) {
      existing.lastAccessedAt = Date.now()
      existing.cleanupRequested = false
      if (existing.cleanupTimer) {
        clearTimeout(existing.cleanupTimer)
        delete existing.cleanupTimer
      }
      return this.toDocument(existing)
    }

    const absoluteDir = join(this.rootDir(), id)
    const relativePath = relative(config.dataDir, join(absoluteDir, 'content.md')).replace(/\\/g, '/')
    const entry: TemporaryPdfEntry = {
      id,
      title: title?.trim() || '临时 PDF',
      sourceUrl: normalizedUrl,
      status: 'parsing',
      absoluteDir,
      lastAccessedAt: Date.now(),
    }
    this.entries.set(id, entry)

    try {
      await access(join(absoluteDir, 'content.md'))
      entry.status = 'ready'
      entry.path = relativePath
    } catch {
      void this.parse(entry, relativePath)
    }

    return this.toDocument(entry)
  }

  get(id: string): TemporaryPdfDocument | null {
    const entry = this.entries.get(id)
    if (!entry) return null
    entry.lastAccessedAt = Date.now()
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

  private rootDir() {
    return resolve(config.dataDir, TEMPORARY_PDF_DIR)
  }

  private async initialize() {
    if (this.initialized) return
    this.initialized = true
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
  }

  private async parse(entry: TemporaryPdfEntry, relativePath: string) {
    try {
      await mkdir(entry.absoluteDir, { recursive: true })
      const pdf = await searchService.downloadPdf(entry.sourceUrl)
      if (!pdf) throw new Error('无法下载临时 PDF')
      if (pdf.length > config.maxFileSize) throw new Error(`临时 PDF 超过 ${Math.round(config.maxFileSize / 1024 / 1024)}MB 限制`)

      const pdfPath = join(entry.absoluteDir, 'source.pdf')
      await writeFile(pdfPath, pdf)
      const result = await mineruService.parsePdfToDirectory(pdfPath, join(entry.absoluteDir, 'mineru'))
      if (!result.text.trim()) throw new Error('MinerU 未返回可读取的正文')

      await writeFile(join(entry.absoluteDir, 'content.md'), result.text, 'utf-8')
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
    }
  }
}

export const temporaryPdfService = new TemporaryPdfService()
