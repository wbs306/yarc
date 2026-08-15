import { readFile, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sseHub } from '../lib/sse.js'
import { ensureAgentWorkspace } from '../lib/agent-workspace.js'
import { paperService } from './paper.service.js'
import { searchService } from './search.service.js'
import { ieeeXploreService } from './ieee-xplore.service.js'
import { searchCategoryService } from './search-category.service.js'

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
  removeFromSearchCategory?: {
    categoryId: string
    paperIds: string[]
  }
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
    removeFromSearchCategory?: {
      categoryId: string
      paperIds: string[]
    }
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
      removeFromSearchCategory: params.removeFromSearchCategory,
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
      const resolved = await this.resolveImportPaper(paper)
      const importPaper = resolved.paper
      if (resolved.warning) {
        job.warnings.push({ id: paper.id, title: paper.title, message: resolved.warning })
      }

      try {
        this.emit(job, 'import-job-item-started', { paper: this.paperSummary(importPaper) })
        const pdfBuffer = await this.resolvePdfBuffer(importPaper)
        if (!pdfBuffer) throw new Error('PDF download failed')
        const imported = await paperService.importFromSearchResult(
          importPaper,
          pdfBuffer,
          job.categoryId,
          job.extractMetadata
        )
        job.results.push(imported)
        this.removeImportedSearchPaper(job, paper.id || importPaper.id)
        job.completed += 1
        this.emit(job, 'import-job-item-completed', {
          paper: this.paperSummary(importPaper),
          importedPaperId: imported.id,
        })
      } catch (err) {
        const message = (err as Error).message
        job.pdfFailed += 1

        if (!job.requirePdf) {
          try {
            const fallback = await paperService.create({
              title: importPaper.title || 'Untitled',
              abstract: importPaper.abstract,
              authors: importPaper.authors || [],
              year: importPaper.year,
              doi: importPaper.doi,
              arxivId: importPaper.arxivId,
              url: importPaper.url,
              categoryId: job.categoryId,
              metadata: {
                source: importPaper.source || 'external',
                provider: importPaper.provider,
                journal: importPaper.journal,
                venue: importPaper.venue,
                importPdfError: message,
              },
            })
            job.results.push(fallback)
            this.removeImportedSearchPaper(job, paper.id || importPaper.id)
            job.completed += 1
            job.metadataOnly += 1
            job.warnings.push({ id: importPaper.id, title: importPaper.title, message: `PDF download failed; saved metadata only: ${message}` })
            this.emit(job, 'import-job-item-completed', {
              paper: this.paperSummary(importPaper),
              importedPaperId: fallback.id,
              metadataOnly: true,
              warning: message,
            })
          } catch (fallbackErr) {
            const fallbackMessage = `Metadata fallback failed after PDF download failed (${message}): ${(fallbackErr as Error).message}`
            job.failed += 1
            job.errors.push({ id: importPaper.id, title: importPaper.title, message: fallbackMessage })
            this.emit(job, 'import-job-item-failed', { paper: this.paperSummary(importPaper), error: fallbackMessage })
          }
        } else {
          job.failed += 1
          job.errors.push({ id: importPaper.id, title: importPaper.title, message })
          this.emit(job, 'import-job-item-failed', { paper: this.paperSummary(importPaper), error: message })
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

  private async resolveImportPaper(paper: any): Promise<{ paper: any; warning?: string }> {
    if (paper?.source === 'ieee') {
      const articleNumber = this.ieeeArticleNumber(paper)
      if (!articleNumber) {
        return { paper, warning: 'IEEE 文章编号不可用，已使用搜索结果中的摘要导入。' }
      }

      try {
        const details = await ieeeXploreService.fetchArticleAbstract(articleNumber)
        const detailedPaper = details.papers[0]
        if (!detailedPaper?.abstract) {
          return { paper, warning: 'IEEE 文章详情未提供完整摘要，已使用搜索结果中的摘要导入。' }
        }

        return {
          paper: {
            ...paper,
            ...detailedPaper,
            title: detailedPaper.title || paper.title,
            authors: detailedPaper.authors.length ? detailedPaper.authors : paper.authors,
            year: detailedPaper.year ?? paper.year,
            abstract: detailedPaper.abstract,
            url: detailedPaper.url || paper.url,
            pdfUrl: detailedPaper.pdfUrl || paper.pdfUrl,
            doi: detailedPaper.doi || paper.doi,
            journal: detailedPaper.journal || paper.journal,
            venue: detailedPaper.venue || paper.venue,
            articleNumber,
          },
        }
      } catch (err) {
        return { paper, warning: `无法加载 IEEE 文章详情的完整摘要，已使用搜索结果中的摘要导入：${(err as Error).message}` }
      }
    }

    if (paper?.source !== 'semantic_scholar') return { paper }

    const rawPaperId = String(paper.paperId || paper.id || '').trim()
    if (!rawPaperId) return { paper }
    const paperId = rawPaperId.replace(/^S2:/i, '')
    if (!paperId) return { paper }

    try {
      const detailedPaper = await searchService.fetchSemanticScholarPaper(paperId)
      return {
        paper: {
          ...paper,
          ...detailedPaper,
          title: detailedPaper.title || paper.title,
          authors: detailedPaper.authors.length ? detailedPaper.authors : paper.authors,
          year: detailedPaper.year ?? paper.year,
          abstract: detailedPaper.abstract ?? paper.abstract,
          url: detailedPaper.url || paper.url,
          pdfUrl: detailedPaper.pdfUrl || paper.pdfUrl,
          doi: detailedPaper.doi || paper.doi,
          arxivId: detailedPaper.arxivId || paper.arxivId,
          journal: detailedPaper.journal || paper.journal,
          venue: detailedPaper.venue || paper.venue,
          paperId,
        },
      }
    } catch (err) {
      return { paper, warning: `无法加载 Semantic Scholar 文章详情，已使用搜索结果中的元数据导入：${(err as Error).message}` }
    }
  }

  private ieeeArticleNumber(paper: any): string | null {
    for (const value of [paper?.articleNumber, paper?.id, paper?.url]) {
      const text = String(value || '').trim()
      const articleNumber = text.match(/(?:arnumber=|\/document\/)(\d{4,20})/i)?.[1] || (/^\d{4,20}$/.test(text) ? text : null)
      if (articleNumber) return articleNumber
    }
    return null
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

    const source = paper?.pdfUrl || paper?.openAccessPdf?.url || paper?.pdfPath || (
      typeof paper?.url === 'string' && /\.pdf(?:[?#]|$)/i.test(paper.url) ? paper.url : undefined
    )
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

  private removeImportedSearchPaper(job: ImportJob, paperId: unknown) {
    const categoryId = job.removeFromSearchCategory?.categoryId
    const sourcePaperId = String(paperId || '').trim()
    if (!categoryId || !sourcePaperId || !job.removeFromSearchCategory?.paperIds.includes(sourcePaperId)) return
    try {
      searchCategoryService.removePaper(categoryId, sourcePaperId)
    } catch (err) {
      job.warnings.push({ id: sourcePaperId, message: `导入成功，但无法从搜索收藏移除：${(err as Error).message}` })
    }
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
