import { randomUUID } from 'node:crypto'
import { prisma } from '@yarc/db'
import { cache } from '../lib/cache.js'
import { paperService } from './paper.service.js'
import { mineruService } from './mineru.service.js'
import { embeddingService } from './embedding.service.js'
import { metadataService } from './metadata.service.js'
import { sseHub } from '../lib/sse.js'
import { piService } from './pi.service.js'
import { config } from '../lib/config.js'
import { DEFAULT_SUMMARY_PROMPT, hasPlaceholders, renderTemplate } from '../lib/prompts.js'
import { ensureAgentWorkspace, readAgentSettings, readAgentSummaryPrompt } from '../lib/agent-workspace.js'
import { insertPaperChunkWithEmbedding } from '../lib/pgvector.js'
import {
  buildEmbeddingChunksFromBlocks,
  extractEmbeddingBlocksFromV2,
  loadMineruContentListV2,
  renderSummaryMarkdownFromV2,
} from '../lib/mineru-content-v2.js'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export type JobType = 'parse_pdf' | 'generate_embedding' | 'summarize' | 'enrich_metadata' | 'refresh_metadata' | 'extract_abstract'

export interface JobQueueConcurrency {
  maxConcurrent: number
  maxConcurrentSummaries: number
  maxConcurrentEmbeddings: number
  maxConcurrentParses: number
}

interface Job {
  id: string
  taskId?: string
  type: JobType
  paperId: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  error?: string
}

class JobQueue {
  private queue: Job[] = []
  private knownTaskIds = new Set<string>()
  private knownJobKeys = new Set<string>()
  private running = 0
  private runningSummaries = 0
  private runningEmbeddings = 0
  private runningParses = 0
  private maxConcurrent = 4
  private maxConcurrentSummaries = 1
  private maxConcurrentEmbeddings = 1
  private maxConcurrentParses = 3

  add(type: JobType, paperId: string, options: { persistTask?: boolean; taskId?: string } = {}): Job {
    const persistTask = options.persistTask ?? true
    const taskId = options.taskId || (persistTask ? randomUUID() : undefined)
    const jobKey = `${type}:${paperId}`
    if (this.knownJobKeys.has(jobKey)) {
      return this.queue.find(queuedJob => queuedJob.type === type && queuedJob.paperId === paperId) || {
        id: randomUUID(),
        taskId,
        type,
        paperId,
        status: 'running',
      }
    }
    const job: Job = {
      id: randomUUID(),
      taskId,
      type,
      paperId,
      status: 'pending',
    }
    this.queue.push(job)
    this.knownJobKeys.add(jobKey)
    if (taskId) this.knownTaskIds.add(taskId)
    sseHub.emit({ type: 'paper-status', paperId, jobType: type, status: 'queued', jobId: taskId || job.id, at: new Date().toISOString() })

    if (persistTask) {
      // Create the DB task before processing so the worker can reliably move it
      // from pending -> active -> completed/failed. The generated task id is
      // also stored on the in-memory job so a pending DB task can be cancelled
      // without letting the queued job run later.
      prisma.task.create({
        data: { ...(taskId ? { id: taskId } : {}), paperId, type, status: 'pending' },
      }).then(() => this.process()).catch((err) => {
        const index = this.queue.findIndex(queuedJob => queuedJob.id === job.id)
        if (index >= 0) this.queue.splice(index, 1)
        this.knownJobKeys.delete(jobKey)
        if (taskId) this.knownTaskIds.delete(taskId)
        console.error(err)
        this.process()
      })
      return job
    }

    this.process()
    return job
  }

  async cancelPendingTask(taskId: string, reason = 'Cancelled by user'): Promise<Job | null> {
    const jobIndex = this.queue.findIndex((queuedJob) => queuedJob.taskId === taskId)
    if (jobIndex < 0) return null

    const [job] = this.queue.splice(jobIndex, 1)
    this.knownJobKeys.delete(`${job.type}:${job.paperId}`)
    if (job.taskId) this.knownTaskIds.delete(job.taskId)
    job.status = 'failed'
    job.error = reason
    await this.markPaperJobFailed(job).catch(console.error)
    sseHub.emit({ type: 'paper-status', paperId: job.paperId, jobType: job.type, status: 'failed', error: reason })
    this.process()
    return job
  }

  hasTask(taskId: string): boolean {
    return this.knownTaskIds.has(taskId)
  }

  hasJob(type: JobType, paperId: string): boolean {
    return this.knownJobKeys.has(`${type}:${paperId}`)
  }

  getConcurrency(): JobQueueConcurrency {
    return {
      maxConcurrent: this.maxConcurrent,
      maxConcurrentSummaries: this.maxConcurrentSummaries,
      maxConcurrentEmbeddings: this.maxConcurrentEmbeddings,
      maxConcurrentParses: this.maxConcurrentParses,
    }
  }

  setConcurrency(input: Partial<JobQueueConcurrency>): JobQueueConcurrency {
    const current = this.getConcurrency()
    const clamp = (value: unknown, fallback: number, min: number, max: number) => {
      const parsed = Number(value)
      if (!Number.isFinite(parsed)) return fallback
      return Math.min(Math.max(Math.floor(parsed), min), max)
    }

    this.maxConcurrent = clamp(input.maxConcurrent, current.maxConcurrent, 1, 50)
    this.maxConcurrentSummaries = clamp(input.maxConcurrentSummaries, current.maxConcurrentSummaries, 1, 20)
    this.maxConcurrentEmbeddings = clamp(input.maxConcurrentEmbeddings, current.maxConcurrentEmbeddings, 1, 20)
    this.maxConcurrentParses = clamp(input.maxConcurrentParses, current.maxConcurrentParses, 1, 20)
    for (let i = 0; i < this.maxConcurrent; i++) this.process()
    return this.getConcurrency()
  }

  private async process() {
    if (this.running >= this.maxConcurrent || this.queue.length === 0) return

    const jobIndex = this.queue.findIndex((queuedJob) => {
      if (queuedJob.type === 'summarize') return this.runningSummaries < this.maxConcurrentSummaries
      if (queuedJob.type === 'generate_embedding') return this.runningEmbeddings < this.maxConcurrentEmbeddings
      if (queuedJob.type === 'parse_pdf') return this.runningParses < this.maxConcurrentParses
      return true
    })
    if (jobIndex < 0) return

    const [job] = this.queue.splice(jobIndex, 1)
    this.running++
    if (job.type === 'summarize') this.runningSummaries++
    if (job.type === 'generate_embedding') this.runningEmbeddings++
    if (job.type === 'parse_pdf') this.runningParses++
    job.status = 'running'

    try {
      if (job.taskId) {
        const activated = await prisma.task.updateMany({
          where: { id: job.taskId, status: 'pending' },
          data: { status: 'active' },
        })
        if (activated.count === 0) {
          const current = await prisma.task.findUnique({ where: { id: job.taskId }, select: { status: true } })
          if (current?.status !== 'active') return
        }
      } else {
        await prisma.task.updateMany({
          where: { paperId: job.paperId, type: job.type, status: 'pending' },
          data: { status: 'active' },
        })
      }

      sseHub.emit({ type: 'paper-status', paperId: job.paperId, jobType: job.type, status: 'processing' })

      await this.handleJob(job)
      job.status = 'completed'

      await prisma.task.updateMany({
        where: job.taskId ? { id: job.taskId, status: 'active' } : { paperId: job.paperId, type: job.type, status: 'active' },
        data: { status: 'completed', completedAt: new Date() },
      })

      sseHub.emit({ type: 'paper-status', paperId: job.paperId, jobType: job.type, status: 'completed' })
    } catch (error) {
      job.status = 'failed'
      job.error = (error as Error).message
      console.error(`[JobQueue] ${job.type} failed for ${job.paperId}:`, error)
      await this.markPaperJobFailed(job)

      await prisma.task.updateMany({
        where: job.taskId ? { id: job.taskId, status: 'active' } : { paperId: job.paperId, type: job.type, status: 'active' },
        data: { status: 'failed', error: (error as Error).message, completedAt: new Date() },
      })

      sseHub.emit({ type: 'paper-status', paperId: job.paperId, jobType: job.type, status: 'failed', error: (error as Error).message })
    } finally {
      this.running--
      if (job.type === 'summarize') this.runningSummaries--
      if (job.type === 'generate_embedding') this.runningEmbeddings--
      if (job.type === 'parse_pdf') this.runningParses--
      this.knownJobKeys.delete(`${job.type}:${job.paperId}`)
      if (job.taskId) this.knownTaskIds.delete(job.taskId)
      this.process()
    }
  }

  private async handleJob(job: Job) {
    switch (job.type) {
      case 'parse_pdf':
        return this.handleParsePdf(job.paperId)
      case 'generate_embedding':
        return this.handleGenerateEmbedding(job.paperId)
      case 'summarize':
        return this.handleSummarize(job.paperId)
      case 'enrich_metadata':
        return this.handleEnrichMetadata(job.paperId)
      case 'refresh_metadata':
        return this.handleEnrichMetadata(job.paperId, true)
      case 'extract_abstract':
        return this.handleExtractAbstract(job.paperId)
    }
  }

  private async markPaperJobFailed(job: Job) {
    const error = job.error || 'Job failed'
    if (job.type === 'parse_pdf') {
      const paper = await prisma.paper.findUnique({ where: { id: job.paperId }, select: { metadata: true } })
      await paperService.updateStatus(job.paperId, 'parseStatus', {
        parseStatus: 'failed',
        metadata: {
          ...((paper?.metadata as any) || {}),
          jobError: { type: job.type, message: error, failedAt: new Date().toISOString() },
        },
      })
    } else if (job.type === 'generate_embedding') {
      await paperService.updateStatus(job.paperId, 'embeddingStatus', {
        embeddingStatus: 'failed',
      })
    } else if (job.type === 'summarize') {
      await paperService.updateStatus(job.paperId, 'summaryStatus', {
        summaryStatus: 'failed',
      })
    }
  }

  private async handleParsePdf(paperId: string) {
    const paper = await prisma.paper.findUnique({ where: { id: paperId } })
    if (!paper?.filePath) throw new Error('Paper or PDF not found')

    // Update status to processing
    await paperService.updateStatus(paperId, 'parseStatus', {
      parseStatus: 'processing',
    })

    // Call MinerU and persist both the raw MinerU output and the normalized
    // parse result. The PDF itself has already been stored in data/papers/<id>/ by the
    // upload endpoint before this job is queued.
    const result = await mineruService.parsePdf(paper.filePath, paperId)

    // Clean null characters from text fields (PostgreSQL doesn't support \u0000)
    const cleanText = (s: string) => s.replace(/\u0000/g, '')
    if (result.text) result.text = cleanText(result.text)
    if (result.pages) {
      for (const page of result.pages) {
        if (page.text) page.text = cleanText(page.text)
      }
    }

    const mineruMetadata = (result.metadata || {}) as Record<string, unknown>
    const paperMetadata = (paper.metadata as any) || {}
    const skipMetadataEnrichment = paperMetadata.processing?.skipMetadataEnrichment === true
    const parsedMetadata = metadataService.extractFromParsedContent(result)
    const hasSelectiveReparse = Array.isArray(paperMetadata.processing?.reparseActions)
    const reparseActions = hasSelectiveReparse
      ? paperMetadata.processing.reparseActions.filter((action: unknown): action is 'embedding' | 'metadata' | 'abstract' =>
          action === 'embedding' || action === 'metadata' || action === 'abstract')
      : []

    // A selectively requested MinerU reparse persists only the new MinerU
    // result. Its selected follow-up actions are queued independently below.
    if (hasSelectiveReparse) {
      await paperService.updateStatus(paperId, 'parseStatus', {
        parseStatus: 'completed',
        parseResult: result as any,
        metadata: {
          ...paperMetadata,
          processing: {
            ...(paperMetadata.processing || {}),
            reparseActions: null,
          },
          mineru: mineruMetadata.mineru || mineruMetadata,
          parsedMetadata: {
            source: parsedMetadata.source,
            extracted: parsedMetadata.raw || {},
          },
        },
        parsedAt: new Date(),
      })
      if (reparseActions.includes('embedding')) this.add('generate_embedding', paperId)
      if (reparseActions.includes('metadata')) this.add('refresh_metadata', paperId)
      if (reparseActions.includes('abstract')) this.add('extract_abstract', paperId)
      return
    }

    if (skipMetadataEnrichment) {
      const fieldUpdates: Record<string, unknown> = {}
      if (parsedMetadata.abstract && !paper.abstract) fieldUpdates.abstract = parsedMetadata.abstract

      await paperService.updateStatus(paperId, 'parseStatus', {
        ...fieldUpdates,
        parseStatus: 'completed',
        parseResult: result as any,
        metadata: {
          ...paperMetadata,
          mineru: mineruMetadata.mineru || mineruMetadata,
          ...(parsedMetadata.abstract ? {
            parsedMetadata: {
              source: parsedMetadata.source,
              extracted: { abstract: parsedMetadata.abstract },
            },
          } : {}),
        },
        parsedAt: new Date(),
      })
      this.add('generate_embedding', paperId)
      return
    }

    // 元数据补全链: DOI → Crossref → arXiv → 标题搜索
    let enriched: any = null
    if (parsedMetadata.doi) {
      enriched = await metadataService.lookupByDoi(parsedMetadata.doi)
    }
    if (!enriched && parsedMetadata.arxivId) {
      enriched = await metadataService.lookupByArxivId(parsedMetadata.arxivId)
    }
    if (!enriched && parsedMetadata.title) {
      enriched = await metadataService.lookupByTitle(parsedMetadata.title, parsedMetadata.authors)
    }

    const originalFileTitle = typeof paperMetadata.upload?.originalFileName === 'string'
      ? paperMetadata.upload.originalFileName.replace(/\.pdf$/i, '')
      : undefined
    const storedFileTitle = paper.filePath.split('/').pop()?.replace(/\.pdf$/i, '')
    const isFallbackTitle = !paper.title || paper.title === 'Untitled' || paper.title === originalFileTitle || paper.title === storedFileTitle
    const fieldUpdates: Record<string, unknown> = {}

    if (parsedMetadata.doi && !paper.doi) fieldUpdates.doi = parsedMetadata.doi
    if (parsedMetadata.arxivId && !paper.arxivId) fieldUpdates.arxivId = parsedMetadata.arxivId
    if (parsedMetadata.abstract && !paper.abstract) fieldUpdates.abstract = parsedMetadata.abstract
    if (enriched) {
      if (enriched.title && (isFallbackTitle || paper.title.length < enriched.title.length * 0.6)) fieldUpdates.title = enriched.title
      if (enriched.authors?.length && paper.authors.length === 0) fieldUpdates.authors = enriched.authors
      if (enriched.year && !paper.year) fieldUpdates.year = enriched.year
      if (enriched.abstract && !fieldUpdates.abstract && !paper.abstract) fieldUpdates.abstract = enriched.abstract
      if (enriched.url && !paper.url) fieldUpdates.url = enriched.url
      if (enriched.doi && !paper.doi) fieldUpdates.doi = enriched.doi
    }
    const journal = enriched?.journal || enriched?.venue

    // Update paper with parse result
    await paperService.updateStatus(paperId, 'parseStatus', {
      ...fieldUpdates,
      parseStatus: 'completed',
      parseResult: result as any,
      metadata: {
        ...paperMetadata,
        ...(journal ? { journal } : {}),
        mineru: mineruMetadata.mineru || mineruMetadata,
        parsedMetadata: {
          source: parsedMetadata.source,
          extracted: parsedMetadata.raw || {},
        },
        ...(enriched ? {
          enrichment: {
            ...(((paper.metadata as any)?.enrichment as any) || {}),
            crossref: enriched.raw || {},
            source: enriched.source,
            enrichedAt: new Date().toISOString(),
          },
        } : {}),
      },
      parsedAt: new Date(),
    })

    // Auto-trigger embedding and metadata enrichment
    this.add('generate_embedding', paperId)
    this.add('enrich_metadata', paperId)
  }

  private async generateEmbeddingWithRetry(text: string, attempts = 3): Promise<number[]> {
    let lastError: unknown
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await embeddingService.generate(text)
      } catch (err) {
        lastError = err
        if (attempt >= attempts) break
        const delayMs = attempt * 1000
        console.warn(`[Embedding] API attempt ${attempt}/${attempts} failed; retrying in ${delayMs}ms:`, err)
        await new Promise((resolve) => setTimeout(resolve, delayMs))
      }
    }
    throw lastError
  }

  private async handleGenerateEmbedding(paperId: string) {
    const paper = await prisma.paper.findUnique({ where: { id: paperId } })
    if (!paper?.parseResult) throw new Error('Paper not parsed yet')

    await paperService.updateStatus(paperId, 'embeddingStatus', {
      embeddingStatus: 'processing',
      embeddingProgress: 0,
    })

    const parseResult = paper.parseResult as any
    const contentListV2 = await loadMineruContentListV2(parseResult)
    const embeddingBlocks = extractEmbeddingBlocksFromV2(contentListV2)
    const chunkJobs = buildEmbeddingChunksFromBlocks(embeddingBlocks, { maxChunkSize: 1000, overlap: 200 })

    if (chunkJobs.length === 0) {
      await paperService.updateStatus(paperId, 'embeddingStatus', {
        embeddingStatus: 'failed',
        embeddingProgress: 0,
      })
      throw new Error('No text chunks generated for embedding')
    }

    // Delete existing chunks only after the replacement chunks are known to exist.
    await prisma.paperChunk.deleteMany({ where: { paperId } })

    let processedChunks = 0
    let failedChunks = 0

    for (const [index, chunk] of chunkJobs.entries()) {
      try {
        const embedding = await this.generateEmbeddingWithRetry(chunk.content)
        await insertPaperChunkWithEmbedding({
          paperId,
          content: chunk.content,
          pageNumber: chunk.pageNumber,
          chunkIndex: chunk.chunkIndex,
          embedding,
        })

        processedChunks++
        await paperService.updateStatus(paperId, 'embeddingStatus', {
          embeddingProgress: processedChunks / chunkJobs.length,
        })
      } catch (err) {
        failedChunks++
        console.error(`[Embedding] Failed for chunk ${index} of page ${chunk.pageNumber ?? 'unknown'}:`, err)
      }
    }

    if (processedChunks === 0) {
      await prisma.paperChunk.deleteMany({ where: { paperId } })
      await paperService.updateStatus(paperId, 'embeddingStatus', {
        embeddingStatus: 'failed',
        embeddingProgress: 0,
      })
      throw new Error(`No chunks embedded successfully (${failedChunks}/${chunkJobs.length} failed)`)
    }

    if (failedChunks > 0) {
      await prisma.paperChunk.deleteMany({ where: { paperId } })
      await paperService.updateStatus(paperId, 'embeddingStatus', {
        embeddingStatus: 'failed',
        embeddingProgress: 0,
      })
      throw new Error(`Embedding partially failed: ${failedChunks}/${chunkJobs.length} chunks failed`)
    }

    await paperService.updateStatus(paperId, 'embeddingStatus', {
      embeddingStatus: 'completed',
      embeddingProgress: 1,
      embeddedAt: new Date(),
    })
  }

  private async handleSummarize(paperId: string) {
    const paper = await prisma.paper.findUnique({ where: { id: paperId } })
    if (!paper) throw new Error('Paper not found')

    await paperService.updateStatus(paperId, 'summaryStatus', {
      summaryStatus: 'processing',
    })

    // Build summary input from MinerU content_list_v2. Unlike embedding, the
    // summary input keeps equations/images/tables/algorithms but still removes
    // page headers, footers, page numbers, and references by default.
    const parseResult = paper.parseResult as any
    const contentListV2 = await loadMineruContentListV2(parseResult)
    const fullText = renderSummaryMarkdownFromV2(contentListV2, {
      includeReferences: false,
      includePageFootnotes: false,
      includeImages: true,
      includeEquations: true,
      includeTables: true,
      includeAlgorithms: true,
    })

    if (!fullText.trim()) {
      await paperService.updateStatus(paperId, 'summaryStatus', { summaryStatus: 'failed' })
      throw new Error('No text content to summarize')
    }

    // Load summary prompt from data/.pi/SUMMARY.md; seed it from the old DB setting once.
    let promptTemplate = DEFAULT_SUMMARY_PROMPT
    let summaryModel: string | undefined
    try {
      const setting = await prisma.setting.findUnique({ where: { key: 'summary_prompt' } })
      await ensureAgentWorkspace({
        summaryPrompt: typeof setting?.value === 'string' ? setting.value : DEFAULT_SUMMARY_PROMPT,
      })
      promptTemplate = (await readAgentSummaryPrompt()).trim() || DEFAULT_SUMMARY_PROMPT
      const agentSettings = await readAgentSettings() as any
      const configuredSummaryModel = typeof agentSettings.summaryModel === 'string' ? agentSettings.summaryModel.trim() : ''
      const defaultProvider = typeof agentSettings.defaultProvider === 'string' ? agentSettings.defaultProvider.trim() : ''
      summaryModel = configuredSummaryModel
        ? (configuredSummaryModel.includes('/') || !defaultProvider ? configuredSummaryModel : `${defaultProvider}/${configuredSummaryModel}`)
        : undefined
    } catch { /* keep default */ }

    // Truncate text to fit model context (preserve beginning and end).
    // content_list_v2 rendering removes headers/footers/references; 120k chars
    // covers roughly 95% of the current library while keeping prompts bounded.
    const maxChars = 120_000
    let paperText = fullText
    if (paperText.length > maxChars) {
      const headLen = Math.floor(maxChars * 0.7)
      const tailLen = maxChars - headLen
      paperText = paperText.slice(0, headLen) + '\n\n... [中间部分省略] ...\n\n' + paperText.slice(-tailLen)
    }

    // Build final prompt with paper metadata
    const metaLines = [`标题: ${paper.title}`]
    if (paper.authors.length > 0) metaLines.push(`作者: ${paper.authors.join(', ')}`)
    if (paper.year) metaLines.push(`年份: ${paper.year}`)
    if (paper.doi) metaLines.push(`DOI: ${paper.doi}`)

    // If the template uses {{placeholders}}, render them and send as a single prompt;
    // otherwise keep the legacy behavior (template as system prompt, metadata + text as user).
    let systemPrompt: string
    let userPrompt: string
    if (hasPlaceholders(promptTemplate)) {
      systemPrompt = ''
      userPrompt = renderTemplate(promptTemplate, {
        title: paper.title,
        authors: paper.authors.join(', '),
        year: paper.year ?? '',
        doi: paper.doi ?? '',
        paper_text: paperText,
      })
    } else {
      systemPrompt = promptTemplate
      userPrompt = `${metaLines.join('\n')}\n\n以下是论文全文内容:\n\n${paperText}`
    }

    // Call Pi AI to generate summary
    let summary = ''
    sseHub.emit({
      type: 'paper-status',
      paperId,
      jobType: 'summarize',
      status: 'processing',
      phase: 'ai_generating',
    })

    try {
      for await (const text of piService.complete({
        ...(summaryModel ? { model: summaryModel } : {}),
        systemPrompt,
        prompt: userPrompt,
      })) {
        summary += text
      }
    } catch (err) {
      await paperService.updateStatus(paperId, 'summaryStatus', { summaryStatus: 'failed' })
      throw new Error(`AI summary generation failed: ${(err as Error).message}`)
    }

    summary = summary.trim()
    if (!summary) {
      await paperService.updateStatus(paperId, 'summaryStatus', { summaryStatus: 'failed' })
      throw new Error('AI returned empty summary')
    }

    // Save summary as markdown file and create a note
    const noteDir = join(config.papersDir, paperId, 'notes')
    await mkdir(noteDir, { recursive: true })
    const fileName = `summary-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.md`
    const filePath = join(noteDir, fileName)
    await writeFile(filePath, summary, 'utf-8')

    // Create note record (kind: 'summary') so it appears in the paper's note list
    const note = await prisma.note.create({
      data: {
        paperId,
        title: 'AI 文献总结',
        content: summary,
        kind: 'summary',
        filePath,
      },
    })
    sseHub.emit({
      type: 'notes-changed',
      toolName: 'summarize',
      paperId,
      noteId: note.id,
      at: new Date().toISOString(),
    })

    // Also update paper.summary for quick access
    await paperService.updateStatus(paperId, 'summaryStatus', {
      summaryStatus: 'completed',
      summary,
      summarizedAt: new Date(),
    })
  }

  private async handleEnrichMetadata(paperId: string, refresh = false) {
    const paper = await prisma.paper.findUnique({ where: { id: paperId } })
    if (!paper?.parseResult) throw new Error('A completed MinerU parse is required to refresh metadata')

    // 元数据补全链: DOI → Crossref → arXiv → 标题搜索 (只看第一页)
    const parsed = metadataService.extractFromParsedContent(paper.parseResult as any)
    const updates: Record<string, unknown> = {}
    if (parsed.doi && (refresh || !paper.doi)) updates.doi = parsed.doi
    if (parsed.arxivId && (refresh || !paper.arxivId)) updates.arxivId = parsed.arxivId

    const paperMetadata = (paper.metadata as any) || {}
    const originalFileTitle = typeof paperMetadata.upload?.originalFileName === 'string'
      ? paperMetadata.upload.originalFileName.replace(/\.pdf$/i, '')
      : undefined
    const storedFileTitle = paper.filePath?.split('/').pop()?.replace(/\.pdf$/i, '')
    const isFallbackTitle = !paper.title || paper.title === 'Untitled' || paper.title === originalFileTitle || paper.title === storedFileTitle
    const needsEnrichment = refresh || isFallbackTitle || paper.authors.length === 0 || !paper.year || !paperMetadata.journal

    let enriched: any = null
    if (needsEnrichment) {
      const doi = parsed.doi || paper.doi
      const arxivId = parsed.arxivId || paper.arxivId
      const title = parsed.title || paper.title
      const authors = parsed.authors?.length ? parsed.authors : paper.authors
      if (doi) enriched = await metadataService.lookupByDoi(doi)
      if (!enriched && arxivId) enriched = await metadataService.lookupByArxivId(arxivId)
      if (!enriched && title) enriched = await metadataService.lookupByTitle(title, authors)
    }

    if (enriched) {
      if (enriched.title && (refresh || isFallbackTitle || paper.title.length < enriched.title.length * 0.6)) updates.title = enriched.title
      if (enriched.authors?.length && (refresh || paper.authors.length === 0)) updates.authors = enriched.authors
      if (enriched.year && (refresh || !paper.year)) updates.year = enriched.year
      // The explicit "摘要" action owns abstract replacement. Keep the legacy
      // enrichment behavior for ordinary background jobs only.
      if (!refresh && enriched.abstract && !paper.abstract) updates.abstract = enriched.abstract
      if (enriched.url && (refresh || !paper.url)) updates.url = enriched.url
      if (enriched.doi && (refresh || !paper.doi)) updates.doi = enriched.doi
      const journal = enriched.journal || enriched.venue
      updates.metadata = {
        ...paperMetadata,
        ...(journal ? { journal } : {}),
        enrichment: {
          ...((paperMetadata.enrichment as any) || {}),
          crossref: enriched.raw || {},
          source: enriched.source,
          enrichedAt: new Date().toISOString(),
        },
      }
    }

    if (Object.keys(updates).length > 0) {
      await prisma.paper.update({ where: { id: paperId }, data: updates as any })
      cache.delete(`paper:${paperId}`)
      cache.invalidatePrefix('papers:list')
    }
  }

  private async handleExtractAbstract(paperId: string) {
    const paper = await prisma.paper.findUnique({ where: { id: paperId } })
    if (!paper?.parseResult) throw new Error('A completed MinerU parse is required to extract the abstract')

    const parsed = metadataService.extractFromParsedContent(paper.parseResult as any)
    if (!parsed.abstract) throw new Error('No abstract was found in the MinerU parse result')

    const metadata = (paper.metadata as any) || {}
    await prisma.paper.update({
      where: { id: paperId },
      data: {
        abstract: parsed.abstract,
        metadata: {
          ...metadata,
          parsedMetadata: {
            ...(metadata.parsedMetadata || {}),
            source: parsed.source,
            extracted: {
              ...((metadata.parsedMetadata as any)?.extracted || {}),
              abstract: parsed.abstract,
            },
            abstractRefreshedAt: new Date().toISOString(),
          },
        } as any,
      },
    })
    cache.delete(`paper:${paperId}`)
    cache.invalidatePrefix('papers:list')
  }

  getStats() {
    return {
      pending: this.queue.length,
      running: this.running,
      runningByType: {
        summaries: this.runningSummaries,
        embeddings: this.runningEmbeddings,
        parses: this.runningParses,
      },
      concurrency: this.getConcurrency(),
    }
  }
}

export const jobQueue = new JobQueue()

export const JOB_QUEUE_CONCURRENCY_SETTING_KEY = 'job_queue_concurrency'

const loadPersistedConcurrency = async () => {
  const row = await prisma.setting.findUnique({ where: { key: JOB_QUEUE_CONCURRENCY_SETTING_KEY } })
  if (row?.value && typeof row.value === 'object' && !Array.isArray(row.value)) {
    jobQueue.setConcurrency(row.value as Partial<JobQueueConcurrency>)
  }
}

let reconciliationTimer: ReturnType<typeof setInterval> | null = null
let reconciliationRunning = false

const reconcileIncompleteJobs = async () => {
  if (reconciliationRunning) return
  reconciliationRunning = true
  try {
    const pendingTasks = await prisma.task.findMany({
      where: { status: { in: ['pending', 'active'] } },
      orderBy: { createdAt: 'asc' },
    })

    for (const task of pendingTasks) {
      const type = task.type as JobType
      if (jobQueue.hasTask(task.id) || jobQueue.hasJob(type, task.paperId)) continue
      console.log(`[JobQueue] Recovering task: ${task.type} for paper ${task.paperId}`)
      jobQueue.add(type, task.paperId, { persistTask: false, taskId: task.id })
    }
  } catch (err) {
    console.error('[JobQueue] Failed to reconcile jobs:', err)
  } finally {
    reconciliationRunning = false
  }
}

// Recover incomplete jobs on startup and keep reconciling persisted pending
// tasks. The periodic pass repairs missed enqueue callbacks and tasks moved
// back to pending by retry operations without duplicating known in-memory jobs.
export async function recoverJobs() {
  try {
    await loadPersistedConcurrency()
    await reconcileIncompleteJobs()
    if (reconciliationTimer === null) {
      reconciliationTimer = setInterval(() => { void reconcileIncompleteJobs() }, 5000)
      reconciliationTimer.unref?.()
    }
  } catch (err) {
    console.error('[JobQueue] Failed to recover jobs:', err)
  }
}
