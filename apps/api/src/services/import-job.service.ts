import { readFile, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sseHub } from '../lib/sse.js'
import { ensureAgentWorkspace } from '../lib/agent-workspace.js'
import { paperService } from './paper.service.js'
import { searchService } from './search.service.js'

export type ImportJobStatus = 'queued' | 'running' | 'completed' | 'failed'

export interface ImportJob {
  id: string
  status: ImportJobStatus
  total: number
  completed: number
  failed: number
  pdfFailed: number
  metadataOnly: number
  categoryId?: string
  requirePdf: boolean
  extractMetadata: boolean
  results: any[]
  errors: Array<{ id?: string; title?: string; message: string }>
  warnings: Array<{ id?: string; title?: string; message: string }>
  createdAt: string
  updatedAt: string
}

class ImportJobService {
  private jobs = new Map<string, ImportJob>()
  private maxPdfBytes = 50 * 1024 * 1024

  create(params: {
    papers: any[]
    categoryId?: string
    requirePdf?: boolean
    extractMetadata?: boolean
  }) {
    const job: ImportJob = {
      id: crypto.randomUUID(),
      status: 'queued',
      total: params.papers.length,
      completed: 0,
      failed: 0,
      pdfFailed: 0,
      metadataOnly: 0,
      categoryId: params.categoryId,
      requirePdf: params.requirePdf !== false,
      extractMetadata: params.extractMetadata === true,
      results: [],
      errors: [],
      warnings: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    this.jobs.set(job.id, job)
    this.emit(job, 'import-job-queued')

    setTimeout(() => {
      this.run(job.id, params.papers).catch((err) => {
        const current = this.jobs.get(job.id)
        if (!current) return
        current.status = 'failed'
        current.updatedAt = new Date().toISOString()
        current.errors.push({ message: (err as Error).message })
        this.emit(current, 'import-job-failed')
      })
    }, 0)

    return job
  }

  get(id: string) {
    return this.jobs.get(id) || null
  }

  private async run(jobId: string, papers: any[]) {
    const job = this.jobs.get(jobId)
    if (!job) return
    job.status = 'running'
    job.updatedAt = new Date().toISOString()
    this.emit(job, 'import-job-started')

    for (const paper of papers) {
      try {
        this.emit(job, 'import-job-item-started', { paper: this.paperSummary(paper) })
        const pdfBuffer = await this.resolvePdfBuffer(paper)
        if (!pdfBuffer) throw new Error('PDF download failed')
        const imported = await paperService.importFromSearchResult(
          paper,
          pdfBuffer,
          job.categoryId,
          job.extractMetadata
        )
        job.results.push(imported)
        job.completed += 1
        this.emit(job, 'import-job-item-completed', {
          paper: this.paperSummary(paper),
          importedPaperId: imported.id,
        })
      } catch (err) {
        const message = (err as Error).message
        job.pdfFailed += 1

        if (!job.requirePdf) {
          try {
            const fallback = await paperService.create({
              title: paper.title || 'Untitled',
              abstract: paper.abstract,
              authors: paper.authors || [],
              year: paper.year,
              doi: paper.doi,
              arxivId: paper.arxivId,
              url: paper.url,
              categoryId: job.categoryId,
              metadata: {
                source: paper.source || 'external',
                provider: paper.provider,
                journal: paper.journal,
                venue: paper.venue,
                importPdfError: message,
              },
            })
            job.results.push(fallback)
            job.completed += 1
            job.metadataOnly += 1
            job.warnings.push({ id: paper.id, title: paper.title, message: `PDF download failed; saved metadata only: ${message}` })
            this.emit(job, 'import-job-item-completed', {
              paper: this.paperSummary(paper),
              importedPaperId: fallback.id,
              metadataOnly: true,
              warning: message,
            })
          } catch (fallbackErr) {
            const fallbackMessage = `Metadata fallback failed after PDF download failed (${message}): ${(fallbackErr as Error).message}`
            job.failed += 1
            job.errors.push({ id: paper.id, title: paper.title, message: fallbackMessage })
            this.emit(job, 'import-job-item-failed', { paper: this.paperSummary(paper), error: fallbackMessage })
          }
        } else {
          job.failed += 1
          job.errors.push({ id: paper.id, title: paper.title, message })
          this.emit(job, 'import-job-item-failed', { paper: this.paperSummary(paper), error: message })
        }
      }

      job.updatedAt = new Date().toISOString()
      this.emit(job, 'import-job-progress')
    }

    job.status = 'completed'
    job.updatedAt = new Date().toISOString()
    this.emit(job, 'import-job-completed')
    sseHub.emit({
      type: 'library-changed',
      toolName: 'import-from-search',
      paperIds: job.results.map((paper: any) => paper.id).filter(Boolean),
      at: job.updatedAt,
    })
  }

  private async resolvePdfBuffer(paper: any): Promise<Buffer | null> {
    const base64 = typeof paper?.pdfBase64 === 'string' && paper.pdfBase64.trim()
      ? paper.pdfBase64
      : (typeof paper?.file === 'string' && paper.file.trim() ? paper.file : '')
    if (base64) {
      const buffer = Buffer.from(base64, 'base64')
      if (buffer.length > this.maxPdfBytes) throw new Error('File exceeds 50MB limit')
      return buffer
    }

    const source = paper?.pdfUrl || paper?.openAccessPdf?.url || paper?.pdfPath || paper?.url
    if (!source || typeof source !== 'string') throw new Error('No PDF source available')

    const localBuffer = await this.tryReadLocalPdfSource(source)
    if (localBuffer) return localBuffer
    return searchService.downloadPdf(source)
  }

  private async tryReadLocalPdfSource(source: string): Promise<Buffer | null> {
    const raw = source.trim()
    let parsed: URL | null = null
    try { parsed = new URL(raw) } catch { parsed = null }

    let inputPath = ''
    if (!parsed) {
      inputPath = raw
    } else if (parsed.protocol === 'file:') {
      inputPath = fileURLToPath(parsed)
    } else {
      return null
    }

    const agentWorkspace = await ensureAgentWorkspace()
    const root = resolve(agentWorkspace.cwd)
    const resolvedPath = resolve(isAbsolute(inputPath) ? inputPath : join(root, inputPath))
    const rel = relative(root, resolvedPath)
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`Local PDF paths must be inside the agent data workspace: ${root}`)
    }

    const info = await stat(resolvedPath)
    if (!info.isFile()) throw new Error('Local PDF path is not a file')
    if (info.size > this.maxPdfBytes) throw new Error('File exceeds 50MB limit')
    return readFile(resolvedPath)
  }

  private paperSummary(paper: any) {
    return {
      id: paper?.id,
      title: paper?.title,
      source: paper?.source,
      doi: paper?.doi,
      url: paper?.url,
      pdfUrl: paper?.pdfUrl,
      pdfPath: paper?.pdfPath,
      fileName: paper?.fileName || (typeof paper?.pdfPath === 'string' ? basename(paper.pdfPath) : undefined),
    }
  }

  private emit(job: ImportJob, type: string, extra: Record<string, unknown> = {}) {
    sseHub.emit({
      type,
      jobId: job.id,
      status: job.status,
      total: job.total,
      completed: job.completed,
      failed: job.failed,
      pdfFailed: job.pdfFailed,
      metadataOnly: job.metadataOnly,
      categoryId: job.categoryId,
      errors: job.errors.slice(-5),
      warnings: job.warnings.slice(-5),
      at: job.updatedAt,
      ...extra,
    })
  }
}

export const importJobService = new ImportJobService()
