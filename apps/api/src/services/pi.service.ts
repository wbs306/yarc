import { prisma } from '@yarc/db'
import { randomUUID } from 'node:crypto'
import { access, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { searchService } from './search.service.js'
import { searchCategoryService } from './search-category.service.js'
import { categoryService } from './category.service.js'
import { paperService } from './paper.service.js'
import { jobQueue } from './job-queue.service.js'
import { importJobService } from './import-job.service.js'
import { noteService } from './note.service.js'
import { rankingService } from './ranking.service.js'
import { chatStreamControl } from '../lib/chat-stream-control.js'
import { sseHub } from '../lib/sse.js'
import { config } from '../lib/config.js'
import { applyAgentWorkspaceEnv, ensureAgentWorkspace, readAgentSettings } from '../lib/agent-workspace.js'
import { getPiSessionMetadata, savePiSessionMetadata } from '../lib/pi-metadata.js'
import { DEFAULT_CHAT_SYSTEM_PROMPT } from '../lib/prompts.js'
import { agentInteractionRegistry } from '../lib/agent-interaction-registry.js'
import { loadMineruContentListV2, renderSummaryMarkdownFromV2 } from '../lib/mineru-content-v2.js'
import type { AgentInteractionResponse, ChatEvent } from '@yarc/shared'

const DEFAULT_THINKING_LEVELS = ['off', 'low', 'medium', 'high', 'xhigh'] as const
const PI_THINKING_LEVEL_ORDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

const orderThinkingLevels = (levels: Iterable<string>): string[] => {
  const order = new Map<string, number>(PI_THINKING_LEVEL_ORDER.map((level, index) => [level, index]))
  return [...new Set(levels)].sort((a, b) => {
    const aOrder = order.get(a)
    const bOrder = order.get(b)
    if (aOrder != null && bOrder != null) return aOrder - bOrder
    if (aOrder != null) return -1
    if (bOrder != null) return 1
    return a.localeCompare(b)
  })
}

export class PiService {
  private piModule: any = null
  private modelRuntime: any = null
  private initialized = false

  private async refreshPiState() {
    if (!this.piModule) return
    const { ModelRuntime } = this.piModule
    const agentWorkspace = await ensureAgentWorkspace()
    this.modelRuntime = await ModelRuntime.create({
      authPath: join(agentWorkspace.agentDir, 'auth.json'),
      modelsPath: join(agentWorkspace.agentDir, 'models.json'),
      modelsStorePath: join(agentWorkspace.agentDir, 'models-store.json'),
    })
  }

  // ── Pi session persistence ──────────────────────────────────────────────

  private async fileExists(path: string): Promise<boolean> {
    try { await access(path); return true } catch { return false }
  }

  /** Read Pi session metadata from Conversation.metadata.pi.sessions[branchId]. */
  /** Save Pi session file path and leaf entry ID to Conversation.metadata.pi.sessions[branchId]. */
  private async savePiSessionInfo(
    conversationId: string,
    branchId: string,
    session: any
  ): Promise<void> {
    try {
      const sessionFile = session.sessionFile
      if (!sessionFile) return

      await savePiSessionMetadata(conversationId, branchId, {
        sessionFile,
        sessionId: session.sessionId,
        leafEntryId: session.sessionManager?.getLeafId?.() || null,
        model: session.model?.id || null,
        thinkingLevel: session.thinkingLevel || null,
        updatedAt: new Date().toISOString(),
      })
    } catch (err) {
      console.warn('[PiService] savePiSessionInfo failed:', err)
    }
  }

  /**
   * Delete Pi session files associated with a conversation.
   * Called when a conversation is deleted to clean up disk.
   */
  async deleteSessionFiles(metadata: Record<string, unknown> | null | undefined): Promise<void> {
    const piSessions = (metadata as any)?.pi?.sessions
    if (!piSessions || typeof piSessions !== 'object') return

    const { unlink } = await import('node:fs/promises')
    for (const [branchId, info] of Object.entries(piSessions) as Array<[string, any]>) {
      const sessionFile = info?.sessionFile
      if (!sessionFile) continue
      try {
        if (await this.fileExists(sessionFile)) {
          await unlink(sessionFile)
          console.log(`[PiService] Deleted session file for branch ${branchId}: ${sessionFile}`)
        }
      } catch (err) {
        console.warn(`[PiService] Failed to delete session file ${sessionFile}:`, err)
      }
    }
  }

  /**
   * Resolve a SessionManager for a conversation branch.
   * - If Conversation.metadata.pi.sessions[branchId].sessionFile exists and the file is on disk,
   *   reopens the existing session (preserves Pi agent history, tool calls, compaction).
   * - Otherwise creates a new persistent session.
   * - Falls back to SessionManager.inMemory() when Pi is unavailable.
   */
  private async resolveSessionManager(
    conversationId: string | undefined,
    branchId: string | undefined,
    cwd: string
  ): Promise<any> {
    const { SessionManager } = this.piModule
    const sessionDir = join(config.dataDir, '.pi', 'agent', 'sessions')
    await mkdir(sessionDir, { recursive: true })

    if (!conversationId || !branchId) {
      return SessionManager.inMemory(cwd)
    }

    try {
      const info = await getPiSessionMetadata(conversationId, branchId)
      const sessionFile = info?.sessionFile
      if (sessionFile && await this.fileExists(sessionFile)) {
        console.log(`[PiService] Reopening Pi session: ${sessionFile}`)
        return SessionManager.open(sessionFile, sessionDir, cwd)
      }
    } catch (err) {
      console.warn('[PiService] Failed to open existing session, creating new:', err)
    }

    console.log('[PiService] Creating new Pi session for branch', branchId)
    return SessionManager.create(cwd, sessionDir)
  }

  /**
   * Phase 2: Fork a Pi session for an edited-message branch.
   *
   * When a user edits a YARC message and creates a new branch, this method
   * forks the corresponding Pi session so the new branch gets its own session
   * file that shares history up to the fork point.
   *
   * @returns The new session file path, or null if forking is not possible
   *          (e.g. old data without Pi entry mapping).
   */
  async forkSessionForBranch(
    conversationId: string,
    sourceBranchId: string,
    forkFromParentEntryId: string
  ): Promise<string | null> {
    await this.initPi()
    if (!this.piModule) return null

    try {
      const info = await getPiSessionMetadata(conversationId, sourceBranchId)
      if (!info?.sessionFile || !(await this.fileExists(info.sessionFile))) return null

      const { SessionManager } = this.piModule
      const agentWorkspace = await ensureAgentWorkspace()
      const sessionDir = join(config.dataDir, '.pi', 'agent', 'sessions')
      await mkdir(sessionDir, { recursive: true })

      const sm = SessionManager.open(info.sessionFile, sessionDir, agentWorkspace.cwd)
      sm.branch(forkFromParentEntryId)
      const newSessionFile = sm.createBranchedSession(forkFromParentEntryId)
      return newSessionFile || null
    } catch (err) {
      console.warn('[PiService] forkSessionForBranch failed:', err)
      return null
    }
  }

  /** Filter models by enabledModels patterns from Pi settings. Returns all models if no patterns configured. */
  private async filterByEnabledModels<T extends { id: string; model?: string }>(models: T[]): Promise<T[]> {
    try {
      const settings = await readAgentSettings()
      const patterns: string[] = settings.enabledModels
      if (!Array.isArray(patterns) || patterns.length === 0) return models
      const matches = (modelId: string, modelModel: string) =>
        patterns.some((pattern: string) => {
          if (pattern === modelId) return true
          const regex = new RegExp('^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$')
          return regex.test(modelId) || regex.test(modelModel)
        })
      return models.filter(m => matches(m.id, m.model || m.id))
    } catch {
      return models
    }
  }

  private async initPi() {
    applyAgentWorkspaceEnv()
    if (this.initialized) return

    try {
      this.piModule = await import('@earendil-works/pi-coding-agent')
      await this.refreshPiState()
      this.initialized = true
      console.log('[PiService] Pi SDK loaded successfully')
    } catch (err) {
      console.warn('[PiService] Pi SDK not available:', err)
      this.initialized = true
    }
  }

  async reload(reason = 'manual'): Promise<{ reloaded: boolean; reason: string }> {
    await this.initPi()

    if (!this.piModule) {
      return { reloaded: false, reason }
    }

    await this.refreshPiState()
    sseHub.emit({
      type: 'pi-config-changed',
      reason,
      at: new Date().toISOString(),
    })
    return { reloaded: true, reason }
  }

  async getConversationContextUsage(
    conversationId: string,
    branchId = 'main'
  ): Promise<{ tokens: number | null; contextWindow: number; percent: number | null; model?: string } | null> {
    await this.initPi()
    if (!this.piModule) return null
    await this.refreshPiState()

    const { createAgentSession, DefaultResourceLoader, SessionManager } = this.piModule
    const agentWorkspace = await ensureAgentWorkspace()
    const sessionDir = join(config.dataDir, '.pi', 'agent', 'sessions')

    const [conv, info] = await Promise.all([
      prisma.conversation.findUnique({ where: { id: conversationId }, select: { model: true } }),
      getPiSessionMetadata(conversationId, branchId),
    ])
    if (!conv) return null

    const modelId = conv.model || info?.model || undefined
    let model: any = undefined
    if (modelId) {
      const parts = modelId.split('/')
      if (parts.length === 2) model = this.modelRuntime?.getModel(parts[0], parts[1])
      if (!model) {
        const available = await this.modelRuntime?.getAvailable()
        model = available?.find((m: any) => m.id === modelId)
      }
    }

    const sessionFile = info?.sessionFile
    if (!sessionFile || !(await this.fileExists(sessionFile))) {
      const contextWindow = Number(model?.contextWindow || 0)
      return {
        tokens: 0,
        contextWindow,
        percent: contextWindow > 0 ? 0 : null,
        model: model?.id || modelId,
      }
    }

    let session: any
    try {
      const resourceLoader = new DefaultResourceLoader({
        cwd: agentWorkspace.cwd,
        agentDir: agentWorkspace.agentDir,
        agentsFilesOverride: (base: { agentsFiles: Array<{ path: string; content: string }> }) => ({
          agentsFiles: base.agentsFiles.filter((file) => file.path !== agentWorkspace.legacyAgentsMd),
        }),
        systemPromptOverride: (baseSystemPrompt?: string) => baseSystemPrompt?.trim() || DEFAULT_CHAT_SYSTEM_PROMPT,
      })
      await resourceLoader.reload()

      const sessionManager = SessionManager.open(sessionFile, sessionDir, agentWorkspace.cwd)
      const result = await createAgentSession({
        sessionManager,
        modelRuntime: this.modelRuntime,
        ...(model ? { model } : {}),
        resourceLoader,
      })
      session = result.session

      const usage = session.getContextUsage?.()
      const contextWindow = Number(usage?.contextWindow ?? session.model?.contextWindow ?? model?.contextWindow ?? 0)
      const tokens = usage?.tokens ?? 0
      return {
        tokens,
        contextWindow,
        percent: usage?.percent ?? (contextWindow > 0 && tokens !== null ? (tokens / contextWindow) * 100 : null),
        model: session.model?.id || model?.id || modelId,
      }
    } catch (err) {
      console.warn('[PiService] getConversationContextUsage failed:', err)
      return null
    } finally {
      await session?.dispose?.()
    }
  }

  /**
   * Initialize a lightweight Pi session for extension loading.
   * This is used at startup to trigger extension loading (e.g., WeChat auto-reconnect).
   * The session is kept alive in memory so extensions can maintain connections.
   */
  async initForExtensions(): Promise<void> {
    await this.initPi()
    if (!this.piModule) {
      console.warn('[PiService] Pi SDK not available, cannot init for extensions')
      return
    }
    if (this._extensionSession) return
    await this.refreshPiState()

    const { createAgentSession, DefaultResourceLoader, SessionManager } = this.piModule
    const agentWorkspace = await ensureAgentWorkspace()

    let resourceLoader: any
    try {
      resourceLoader = new DefaultResourceLoader({
        cwd: agentWorkspace.cwd,
        agentDir: agentWorkspace.agentDir,
        agentsFilesOverride: (base: { agentsFiles: Array<{ path: string; content: string }> }) => ({
          agentsFiles: base.agentsFiles.filter((file) => file.path !== agentWorkspace.legacyAgentsMd),
        }),
        systemPromptOverride: () => DEFAULT_CHAT_SYSTEM_PROMPT,
      })
      await resourceLoader.reload()
    } catch (err) {
      console.warn('[PiService] ResourceLoader error for extension init:', err)
      return
    }

    const sessionManager = SessionManager.inMemory(agentWorkspace.cwd)

    try {
      const { session } = await createAgentSession({
        sessionManager,
        modelRuntime: this.modelRuntime,
        resourceLoader,
      })

      // Keep session alive so extensions can maintain connections
      this._extensionSession = session
      console.log('[PiService] Extension session initialized', !!this._extensionSession)
    } catch (err) {
      console.warn('[PiService] Extension session creation failed:', err)
    }
  }

  // Reference to keep-alive session for extensions
  private _extensionSession: any = null

  async reloadExtensions(reason = 'manual'): Promise<{ reloaded: boolean; reason: string }> {
    await this.initPi()
    if (!this.piModule) return { reloaded: false, reason }

    if (this._extensionSession?.reload) {
      try {
        await this._extensionSession.reload()
      } catch (err) {
        console.warn('[PiService] Extension reload failed, recreating session:', err)
        await this._extensionSession?.dispose?.().catch(() => {})
        this._extensionSession = null
        await this.refreshPiState()
        await this.initForExtensions()
        if (!this._extensionSession) throw new Error('Extension session recreation failed')
      }
    }

    sseHub.emit({
      type: 'pi-config-changed',
      reason: `extensions:${reason}`,
      at: new Date().toISOString(),
    })
    return { reloaded: true, reason }
  }

  /**
   * Build YARC tools with direct service access (no HTTP, no auth bypass).
   * Tools call the same services used by the authenticated API routes.
   *
   * New unified tool system:
   * 1. yarc_search_papers - Search local/IEEE/Semantic Scholar
   * 2. yarc_categories - Manage categories (list/create/update/delete)
   * 3. yarc_papers - Manage papers (list/save/classify/update/delete), including PDF imports from base64/URL/local path
   * 4. yarc_system - Inspect backend status and enqueue maintenance jobs
   * 5. yarc_notes - Manage notes (list/create/update/delete/sync)
   */
  private async createYarcTools(interactionContext?: {
    conversationId?: string
    streamMessageId?: string
    emit?: (event: ChatEvent) => void
  }) {
    if (!this.piModule) return []

    const { defineTool } = this.piModule
    const { Type } = await import('typebox')

    const askQuestionOptionSchema = Type.Object({
      label: Type.String(),
      description: Type.String(),
      preview: Type.Optional(Type.String()),
    })

    const askUserQuestionSchema = Type.Object({
      questions: Type.Array(Type.Object({
        question: Type.String(),
        header: Type.String(),
        options: Type.Array(askQuestionOptionSchema, { minItems: 2, maxItems: 4 }),
        multiSelect: Type.Optional(Type.Boolean()),
      }), { minItems: 1, maxItems: 4 }),
    })

    const paperSchema = Type.Object({
      id: Type.Optional(Type.String()),
      title: Type.String(),
      authors: Type.Optional(Type.Array(Type.String())),
      year: Type.Optional(Type.Number()),
      abstract: Type.Optional(Type.String()),
      doi: Type.Optional(Type.String()),
      arxivId: Type.Optional(Type.String()),
      url: Type.Optional(Type.String()),
      pdfUrl: Type.Optional(Type.String({ description: 'PDF source URL. Can be HTTP(S), file://, or a local path inside the agent data workspace when importPdf=true.' })),
      pdfPath: Type.Optional(Type.String({ description: 'Local PDF path inside the agent data workspace when importPdf=true.' })),
      pdfBase64: Type.Optional(Type.String({ description: 'Base64-encoded PDF content when importPdf=true.' })),
      file: Type.Optional(Type.String({ description: 'Deprecated alias for pdfBase64.' })),
      fileName: Type.Optional(Type.String({ description: 'Original PDF file name for base64/local imports.' })),
      journal: Type.Optional(Type.String()),
      venue: Type.Optional(Type.String()),
      source: Type.Optional(Type.Union([
        Type.Literal('local'),
        Type.Literal('ieee'),
        Type.Literal('semantic_scholar'),
      ])),
      // IEEE specific fields
      articleNumber: Type.Optional(Type.String()),
      publicationNumber: Type.Optional(Type.String()),
      contentType: Type.Optional(Type.String()),
      provider: Type.Optional(Type.String()),
      isEarlyAccess: Type.Optional(Type.Boolean()),
      // Semantic Scholar specific fields
      citationCount: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
      referenceCount: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
      publicationDate: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      publicationTypes: Type.Optional(Type.Array(Type.String())),
      fieldsOfStudy: Type.Optional(Type.Array(Type.String())),
      openAccessPdf: Type.Optional(Type.Any()),
      tldr: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      // Local search specific fields
      similarity: Type.Optional(Type.Number()),
      pageNumber: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    })

    const normalizeSearchPaper = (paper: any, fallbackSource: 'ieee' | 'semantic_scholar' | 'local' = 'semantic_scholar') => ({
      id: String(paper.id || paper.paperId || paper.doi || paper.url || paper.title),
      title: String(paper.title || 'Untitled'),
      abstract: paper.abstract || undefined,
      authors: Array.isArray(paper.authors) ? paper.authors : [],
      year: typeof paper.year === 'number' ? paper.year : undefined,
      url: paper.url || undefined,
      doi: paper.doi || undefined,
      arxivId: paper.arxivId || undefined,
      journal: paper.journal || undefined,
      venue: paper.venue || undefined,
      source: paper.source || fallbackSource,
      // Include all extra fields
      articleNumber: paper.articleNumber,
      publicationNumber: paper.publicationNumber,
      contentType: paper.contentType,
      citationCount: paper.citationCount,
      referenceCount: paper.referenceCount,
      publicationDate: paper.publicationDate,
      publicationTypes: paper.publicationTypes,
      fieldsOfStudy: paper.fieldsOfStudy,
      openAccessPdf: paper.openAccessPdf,
      tldr: paper.tldr,
      similarity: paper.similarity,
      pageNumber: paper.pageNumber,
    })

    const findCategoryByName = async (name: string) => {
      const normalized = name.trim().toLowerCase()
      if (!normalized) return null
      const categories = await prisma.category.findMany()
      return categories.find(c => c.name.trim().toLowerCase() === normalized) || null
    }

    const findOrCreateCategory = async (name: string, parentId?: string | null) => {
      const existing = await findCategoryByName(name)
      if (existing) return existing
      return categoryService.create({ name: name.trim(), parentId: parentId || null })
    }

    const findSearchCategoryByName = (name: string) => {
      const normalized = name.trim().toLowerCase()
      return searchCategoryService.getCategories().find(c => c.name.trim().toLowerCase() === normalized) || null
    }

    const findOrCreateSearchCategory = (name: string, parentId?: string | null) => {
      const existing = findSearchCategoryByName(name)
      if (existing) return existing
      return searchCategoryService.createCategory(name.trim(), parentId || null)
    }

    const validateAskUserQuestionParams = (params: any): { ok: true; questions: any[] } | { ok: false; message: string } => {
      const questions = params?.questions
      if (!Array.isArray(questions) || questions.length < 1 || questions.length > 4) {
        return { ok: false, message: 'questions must contain 1-4 questions' }
      }

      const reservedLabels = new Set(['other', 'type something.', 'chat about this'])
      for (const [questionIndex, question] of questions.entries()) {
        if (!question || typeof question !== 'object') return { ok: false, message: `question ${questionIndex + 1} must be an object` }
        if (typeof question.question !== 'string' || !question.question.trim()) return { ok: false, message: `question ${questionIndex + 1} question is required` }
        if (typeof question.header !== 'string' || !question.header.trim()) return { ok: false, message: `question ${questionIndex + 1} header is required` }
        if (question.header.length > 16) return { ok: false, message: `question ${questionIndex + 1} header must be at most 16 characters` }
        if (!Array.isArray(question.options) || question.options.length < 2 || question.options.length > 4) return { ok: false, message: `question ${questionIndex + 1} options must contain 2-4 items` }
        const labels = new Set<string>()
        for (const [optionIndex, option] of question.options.entries()) {
          if (!option || typeof option !== 'object') return { ok: false, message: `question ${questionIndex + 1} option ${optionIndex + 1} must be an object` }
          if (typeof option.label !== 'string' || !option.label.trim()) return { ok: false, message: `question ${questionIndex + 1} option ${optionIndex + 1} label is required` }
          if (option.label.length > 60) return { ok: false, message: `question ${questionIndex + 1} option ${optionIndex + 1} label must be at most 60 characters` }
          const normalizedLabel = option.label.trim().toLowerCase()
          if (reservedLabels.has(normalizedLabel)) return { ok: false, message: `question ${questionIndex + 1} option label "${option.label}" is reserved` }
          if (labels.has(normalizedLabel)) return { ok: false, message: `question ${questionIndex + 1} contains duplicate option label "${option.label}"` }
          labels.add(normalizedLabel)
          if (typeof option.description !== 'string') return { ok: false, message: `question ${questionIndex + 1} option ${optionIndex + 1} description is required` }
          if (option.preview !== undefined && typeof option.preview !== 'string') return { ok: false, message: `question ${questionIndex + 1} option ${optionIndex + 1} preview must be a string` }
          if (question.multiSelect && option.preview) return { ok: false, message: `question ${questionIndex + 1} cannot use preview with multiSelect` }
        }
      }
      return { ok: true, questions }
    }

    const normalizeQuestionnaireResponse = (response: AgentInteractionResponse, questions: any[]) => {
      const value = response.value as any
      const rawAnswers = Array.isArray(value?.answers) ? value.answers : []
      const answers = questions.map((question, questionIndex) => {
        const raw = rawAnswers.find((item: any) => item?.questionIndex === questionIndex) || rawAnswers[questionIndex]
        if (response.action === 'cancel') {
          return { questionIndex, question: question.question, kind: 'custom' as const, answer: null, notes: value?.reason || 'cancelled' }
        }
        if (response.action === 'chat') {
          return { questionIndex, question: question.question, kind: 'chat' as const, answer: null, notes: raw?.notes || 'User chose Chat about this' }
        }
        if (raw?.kind === 'multi' || Array.isArray(raw?.selected)) {
          const selected = Array.isArray(raw?.selected) ? raw.selected.map(String) : []
          return { questionIndex, question: question.question, kind: 'multi' as const, answer: selected.join(', ') || null, selected, notes: raw?.notes }
        }
        if (raw?.kind === 'custom') {
          return { questionIndex, question: question.question, kind: 'custom' as const, answer: raw?.answer ? String(raw.answer) : null, notes: raw?.notes }
        }
        const answer = raw?.answer !== undefined && raw?.answer !== null ? String(raw.answer) : null
        const option = answer ? question.options.find((item: any) => item.label === answer) : undefined
        return { questionIndex, question: question.question, kind: 'option' as const, answer, preview: option?.preview, notes: raw?.notes }
      })

      return {
        answers,
        cancelled: response.action === 'cancel',
        ...(response.action === 'chat' ? { chat: true } : {}),
        ...(value?.reason ? { reason: String(value.reason) } : {}),
      }
    }

    const formatQuestionnaireText = (details: ReturnType<typeof normalizeQuestionnaireResponse>) => {
      if (details.cancelled) return `User cancelled the questionnaire${details.reason ? ` (${details.reason})` : ''}.`
      if (details.chat) return 'User chose to chat about the questionnaire before answering.'
      const lines = ['User answered the questionnaire:']
      for (const answer of details.answers as any[]) {
        const value = answer.selected?.length ? answer.selected.join(', ') : answer.answer
        lines.push(`${answer.questionIndex + 1}. ${answer.question}: ${value || '(no answer)'}`)
      }
      return lines.join('\n')
    }

    const limitTargets = (ids: string[], limit: unknown) => {
      const parsedLimit = Number(limit)
      if (!Number.isInteger(parsedLimit) || parsedLimit <= 0) return ids
      return ids.slice(0, parsedLimit)
    }

    const buildSystemStatus = async () => {
      const [paperOverviewRows, taskStatusRows, chunkRows, parseStatuses, embeddingStatuses, summaryStatuses] = await Promise.all([
        prisma.$queryRaw<Array<{
          total: number
          parseCompleted: number
          parsePending: number
          parseProcessing: number
          parseFailed: number
          embeddingCompleted: number
          embeddingPending: number
          embeddingProcessing: number
          embeddingFailed: number
          summaryCompleted: number
          summaryPending: number
          summaryProcessing: number
          summaryFailed: number
          missingSummary: number
        }>>`
          SELECT
            COUNT(*)::int AS "total",
            COUNT(*) FILTER (WHERE parse_status = 'completed')::int AS "parseCompleted",
            COUNT(*) FILTER (WHERE parse_status = 'pending')::int AS "parsePending",
            COUNT(*) FILTER (WHERE parse_status = 'processing')::int AS "parseProcessing",
            COUNT(*) FILTER (WHERE parse_status = 'failed')::int AS "parseFailed",
            COUNT(*) FILTER (WHERE embedding_status = 'completed')::int AS "embeddingCompleted",
            COUNT(*) FILTER (WHERE embedding_status = 'pending')::int AS "embeddingPending",
            COUNT(*) FILTER (WHERE embedding_status = 'processing')::int AS "embeddingProcessing",
            COUNT(*) FILTER (WHERE embedding_status = 'failed')::int AS "embeddingFailed",
            COUNT(*) FILTER (WHERE summary_status = 'completed')::int AS "summaryCompleted",
            COUNT(*) FILTER (WHERE summary_status = 'pending')::int AS "summaryPending",
            COUNT(*) FILTER (WHERE summary_status = 'processing')::int AS "summaryProcessing",
            COUNT(*) FILTER (WHERE summary_status = 'failed')::int AS "summaryFailed",
            COUNT(*) FILTER (WHERE summary IS NULL OR btrim(summary) = '')::int AS "missingSummary"
          FROM papers
        `,
        prisma.task.groupBy({ by: ['type', 'status'], _count: { _all: true } }),
        prisma.$queryRaw<Array<{
          totalChunks: number
          chunksWithEmbedding: number
          papersWithChunks: number
          avgChunksPerPaper: number
          avgChunkChars: number
          maxChunkChars: number
        }>>`
          SELECT
            COUNT(*)::int AS "totalChunks",
            COUNT(*) FILTER (WHERE embedding IS NOT NULL)::int AS "chunksWithEmbedding",
            COUNT(DISTINCT paper_id)::int AS "papersWithChunks",
            CASE WHEN COUNT(DISTINCT paper_id) = 0 THEN 0 ELSE (COUNT(*)::float8 / COUNT(DISTINCT paper_id)) END AS "avgChunksPerPaper",
            COALESCE(AVG(length(content)), 0)::float8 AS "avgChunkChars",
            COALESCE(MAX(length(content)), 0)::int AS "maxChunkChars"
          FROM paper_chunks
        `,
        prisma.paper.groupBy({ by: ['parseStatus'], _count: { _all: true } }),
        prisma.paper.groupBy({ by: ['embeddingStatus'], _count: { _all: true } }),
        prisma.paper.groupBy({ by: ['summaryStatus'], _count: { _all: true } }),
      ])

      const artifactRows = await prisma.paper.findMany({
        where: { parseStatus: 'completed' },
        select: { id: true, parseResult: true },
      })
      let mineruResultJson = 0
      let mineruContentListV2 = 0
      let mineruImages = 0
      for (const paper of artifactRows) {
        const resultPath = (paper.parseResult as any)?.metadata?.mineru?.resultPath || join(config.papersDir, paper.id, 'mineru', 'result.json')
        if (await this.fileExists(resultPath)) mineruResultJson++
        const artifactDir = join(config.papersDir, paper.id, 'mineru', 'artifacts')
        if (
          await this.fileExists(join(artifactDir, 'paper_content_list_v2.json')) ||
          await this.fileExists(join(artifactDir, 'pdf_content_list_v2.json'))
        ) mineruContentListV2++
        if (await this.fileExists(join(artifactDir, 'images'))) mineruImages++
      }

      const overview = paperOverviewRows[0] || {
        total: 0,
        parseCompleted: 0,
        parsePending: 0,
        parseProcessing: 0,
        parseFailed: 0,
        embeddingCompleted: 0,
        embeddingPending: 0,
        embeddingProcessing: 0,
        embeddingFailed: 0,
        summaryCompleted: 0,
        summaryPending: 0,
        summaryProcessing: 0,
        summaryFailed: 0,
        missingSummary: 0,
      }
      const chunks = chunkRows[0] || { totalChunks: 0, chunksWithEmbedding: 0, papersWithChunks: 0, avgChunksPerPaper: 0, avgChunkChars: 0, maxChunkChars: 0 }
      const taskQueue = taskStatusRows.map((row) => ({ type: row.type, status: row.status, count: row._count._all }))
      const queueStats = jobQueue.getStats()
      return {
        papers: overview,
        parseStatuses: Object.fromEntries(parseStatuses.map((row) => [row.parseStatus || 'null', row._count._all])),
        embeddingStatuses: Object.fromEntries(embeddingStatuses.map((row) => [row.embeddingStatus || 'null', row._count._all])),
        summaryStatuses: Object.fromEntries(summaryStatuses.map((row) => [row.summaryStatus || 'null', row._count._all])),
        chunks,
        mineruArtifacts: {
          completedPapers: artifactRows.length,
          resultJson: mineruResultJson,
          contentListV2: mineruContentListV2,
          imagesDir: mineruImages,
        },
        tasks: taskQueue,
        inMemoryQueue: queueStats,
      }
    }

    const selectMaintenanceTargets = async (action: string, scope: string, paperIds?: string[]) => {
      if (scope === 'paperIds') return [...new Set((paperIds || []).filter(Boolean))]
      if (action === 'embeddings') {
        const rows = scope === 'all'
          ? await prisma.$queryRaw<Array<{ id: string }>>`
              SELECT id::text AS id FROM papers WHERE parse_status = 'completed' ORDER BY updated_at DESC
            `
          : await prisma.$queryRaw<Array<{ id: string }>>`
              SELECT p.id::text AS id
              FROM papers p
              LEFT JOIN paper_chunks pc ON pc.paper_id = p.id
              WHERE p.parse_status = 'completed'
              GROUP BY p.id
              HAVING COUNT(pc.id) = 0 OR p.embedding_status IS DISTINCT FROM 'completed'
              ORDER BY p.updated_at DESC
            `
        return rows.map((row) => row.id)
      }
      if (action === 'summaries') {
        const rows = scope === 'all'
          ? await prisma.$queryRaw<Array<{ id: string }>>`
              SELECT id::text AS id FROM papers WHERE parse_status = 'completed' ORDER BY updated_at DESC
            `
          : await prisma.$queryRaw<Array<{ id: string }>>`
              WITH note_flags AS (
                SELECT paper_id, BOOL_OR(kind = 'summary') AS has_summary_note
                FROM notes
                GROUP BY paper_id
              )
              SELECT p.id::text AS id
              FROM papers p
              LEFT JOIN note_flags n ON n.paper_id = p.id
              WHERE p.parse_status = 'completed'
                AND (p.summary IS NULL OR btrim(p.summary) = '')
                AND NOT COALESCE(n.has_summary_note, false)
              ORDER BY p.updated_at DESC
            `
        return rows.map((row) => row.id)
      }
      if (action === 'mineru') {
        const rows = scope === 'all'
          ? await prisma.$queryRaw<Array<{ id: string }>>`
              SELECT id::text AS id FROM papers WHERE file_path IS NOT NULL AND file_path <> '' ORDER BY updated_at DESC
            `
          : await prisma.$queryRaw<Array<{ id: string }>>`
              SELECT id::text AS id
              FROM papers
              WHERE file_path IS NOT NULL AND file_path <> ''
                AND (
                  parse_status IS DISTINCT FROM 'completed'
                  OR parse_result IS NULL
                  OR (parse_result->'metadata'->'mineru') IS NULL
                  OR (parse_result->'metadata'->'mineru'->>'source') IS DISTINCT FROM 'mineru'
                  OR (metadata->'mineru'->>'source') IS DISTINCT FROM 'mineru'
                )
              ORDER BY updated_at DESC
            `
        return rows.map((row) => row.id)
      }
      return []
    }

    const enqueueMaintenance = async (action: string, ids: string[], dryRun: boolean) => {
      const errors: Array<{ id: string; message: string }> = []
      if (dryRun) return { enqueued: 0, errors }
      for (const id of ids) {
        try {
          if (action === 'embeddings') {
            await paperService.updateStatus(id, 'embeddingStatus', { embeddingStatus: 'pending', embeddingProgress: 0 })
            jobQueue.add('generate_embedding', id)
          } else if (action === 'summaries') {
            await paperService.summarize(id)
          } else if (action === 'mineru') {
            await paperService.reparse(id)
          } else {
            throw new Error(`Unknown maintenance action: ${action}`)
          }
        } catch (err) {
          errors.push({ id, message: (err as Error).message })
        }
      }
      return { enqueued: ids.length - errors.length, errors }
    }

    return [
      // ============================================================================
      // Tool 0: ask_user_question (YARC Web-native questionnaire)
      // ============================================================================
      defineTool({
        name: 'ask_user_question',
        label: 'Ask User Question',
        description: 'Ask the user one or more structured questions in the YARC web UI. Use this when you need the user to choose among options, provide custom input, or decide how to proceed.',
        parameters: askUserQuestionSchema,
        async execute(_toolCallId: string, params: any) {
          const validation = validateAskUserQuestionParams(params)
          if (!validation.ok) {
            return {
              content: [{ type: 'text' as const, text: `ask_user_question validation failed: ${validation.message}` }],
              isError: true,
              details: { answers: [], cancelled: true, error: validation.message },
            }
          }

          if (!interactionContext?.conversationId || !interactionContext.streamMessageId || !interactionContext.emit) {
            const error = 'ask_user_question is unavailable outside an active YARC chat stream'
            return { content: [{ type: 'text' as const, text: error }], isError: true, details: { answers: [], cancelled: true, error } }
          }

          try {
            const response = await agentInteractionRegistry.create({
              conversationId: interactionContext.conversationId,
              streamMessageId: interactionContext.streamMessageId,
              kind: 'questionnaire',
              title: 'Agent 需要确认一些问题',
              message: '请选择或输入答案，提交后 Agent 会继续执行。',
              payload: { questions: validation.questions },
              emitRequest: interactionContext.emit,
              emitResolved: interactionContext.emit,
            })
            const details = normalizeQuestionnaireResponse(response, validation.questions)
            return { content: [{ type: 'text' as const, text: formatQuestionnaireText(details) }], details }
          } catch (err) {
            const error = (err as Error).message || 'ask_user_question failed'
            return { content: [{ type: 'text' as const, text: error }], isError: true, details: { answers: [], cancelled: true, error } }
          }
        },
      }),

      // ============================================================================
      // Tool 1: yarc_search_papers
      // ============================================================================
      defineTool({
        name: 'yarc_search_papers',
        label: 'Search Papers',
        description: 'Search for academic papers in the YARC library (local vector database), IEEE Xplore, or Semantic Scholar. Use paperId parameter to limit local search to a specific paper. Results are pushed to the UI search list.',
        parameters: Type.Object({
          query: Type.String({ description: 'Search query (keywords, title, author name, etc.)' }),
          source: Type.Optional(Type.Union([
            Type.Literal('local'),
            Type.Literal('ieee'),
            Type.Literal('semantic_scholar')
          ], { description: 'Search source: "local" for vector search in uploaded PDFs, "ieee" for IEEE Xplore, "semantic_scholar" for Semantic Scholar (default)' })),
          paperId: Type.Optional(Type.String({ description: 'Limit search to a specific paper (local source only)' })),
          field: Type.Optional(Type.Union([
            Type.Literal('all'),
            Type.Literal('title'),
            Type.Literal('author'),
            Type.Literal('year'),
            Type.Literal('abstract'),
            Type.Literal('journal'),
            Type.Literal('venue')
          ])),
          page: Type.Optional(Type.Number()),
          limit: Type.Optional(Type.Number()),
          yearFrom: Type.Optional(Type.Number()),
          yearTo: Type.Optional(Type.Number()),
          earlyAccess: Type.Optional(Type.Boolean({ description: 'IEEE only: return Early Access Articles' })),
          publication: Type.Optional(Type.String({ description: 'IEEE only: top venue alias or exact publication title, e.g. tmc, tpds, twc, ton, jsac' })),
        }),
        async execute(_toolCallId: string, params: any) {
          try {
            const { query, source = 'semantic_scholar', field = 'all', page = 1, limit = 20, yearFrom, yearTo, earlyAccess, publication, paperId } = params
            let results
            if (source === 'local') {
              results = await searchService.searchLocalHybrid(query, field, limit, (page - 1) * limit, 0.5, paperId)
            } else if (source === 'ieee') {
              results = await searchService.searchIEEE(query, field, page, limit, yearFrom, yearTo, { earlyAccess, publication })
            } else {
              results = await searchService.searchSemanticScholar(query, field, page, limit, yearFrom, yearTo)
            }
            const papers = results.papers || []
            const total = Number(results.total || papers.length || 0)
            const effectivePage = Number(results.page || page || 1)
            const effectiveLimit = Number(results.limit || limit || papers.length || 20)
            const totalPages = effectiveLimit > 0 ? Math.ceil(total / effectiveLimit) : 0
            const hasNextPage = totalPages > 0 && effectivePage < totalPages
            const nextPage = hasNextPage ? effectivePage + 1 : null
            let text = `Found ${total} papers. Showing page ${effectivePage} of ${totalPages}, ${papers.length} result(s) on this page. These results have been sent to the UI search list.\n`
            if (hasNextPage) {
              text += `More results are available: call yarc_search_papers again with the same query/source/field and page=${nextPage}, limit=${effectiveLimit}. You can also increase limit if the source allows it.\n`
            } else {
              text += 'No next page is available for this search.\n'
            }
            if (papers.length > 10) {
              text += `The tool returned ${papers.length} result(s) for this page; the summary below lists the first 10.\n`
            }
            text += '\n'
            for (const p of papers.slice(0, 10)) {
              const authors = p.authors?.slice(0, 3).join(', ') || 'Unknown'
              const venue = p.venue || p.journal || ''
              text += `**${p.title}**\nAuthors: ${authors}\nYear: ${p.year || 'N/A'}${venue ? ` | Venue: ${venue}` : ''}\n`
              if (p.abstract) text += `Abstract: ${p.abstract.slice(0, 180)}...\n`
              text += `ID: ${p.id || p.paperId || 'N/A'}\n\n`
            }
            return { content: [{ type: 'text' as const, text }], details: { papers, total, page: effectivePage, limit: effectiveLimit, totalPages, hasNextPage, nextPage, query, source, field, earlyAccess, publication } }
          } catch (err) {
            return { content: [{ type: 'text' as const, text: `Search failed: ${(err as Error).message}` }], isError: true, details: {} }
          }
        },
      }),

      // ============================================================================
      // NEW Tool 2: yarc_categories (unified category management)
      // ============================================================================
      defineTool({
        name: 'yarc_categories',
        label: 'Manage Categories',
        description: 'Unified category management. Actions: list (show tree), create (new category), update (rename/move, supports batch), delete (remove, supports batch). Use type="library" for papers or type="search" for search collections.',
        parameters: Type.Object({
          action: Type.Union([
            Type.Literal('list'),
            Type.Literal('create'),
            Type.Literal('update'),
            Type.Literal('delete')
          ], { description: 'Action: list, create, update, or delete' }),
          type: Type.Optional(Type.Union([
            Type.Literal('library'),
            Type.Literal('search')
          ], { description: 'Category type: "library" (default) or "search"' })),
          name: Type.Optional(Type.String({ description: 'Category name (required for create)' })),
          parentId: Type.Optional(Type.String({ description: 'Parent category ID (for create/update)' })),
          color: Type.Optional(Type.String({ description: 'Color code (library only)' })),
          id: Type.Optional(Type.String({ description: 'Category ID (single operation)' })),
          ids: Type.Optional(Type.Array(Type.String(), { description: 'Category IDs (batch operation)' })),
        }),
        async execute(_toolCallId: string, params: any) {
          try {
            const action = params.action
            const categoryType = params.type || 'library'

            if (action === 'list') {
              if (categoryType === 'search') {
                const categories = searchCategoryService.getCategoryTree()
                let text = 'Search categories:\n\n'
                const flatten = (cats: any[], level = 0) => {
                  for (const cat of cats) {
                    text += `${'  '.repeat(level)}- **${cat.name}** (${cat.papers?.length || 0} papers) [ID: ${cat.id}]\n`
                    if (cat.children?.length) flatten(cat.children, level + 1)
                  }
                }
                flatten(categories)
                return { content: [{ type: 'text' as const, text }], details: { categories, type: categoryType } }
              } else {
                const categories = await prisma.category.findMany({ include: { _count: { select: { papers: true } } }, orderBy: { name: 'asc' } })
                let text = 'Library categories:\n\n'
                for (const cat of categories) text += `- **${cat.name}** (${cat._count.papers} papers) [ID: ${cat.id}]${cat.parentId ? ` parent=${cat.parentId}` : ''}\n`
                return { content: [{ type: 'text' as const, text }], details: { categories, type: categoryType } }
              }
            }

            if (action === 'create') {
              if (!params.name) return { content: [{ type: 'text' as const, text: 'name is required for create' }], isError: true, details: {} }
              if (categoryType === 'search') {
                const category = findOrCreateSearchCategory(params.name, params.parentId)
                return { content: [{ type: 'text' as const, text: `Search category ready: ${category.name}. ID: ${category.id}` }], details: { category, type: categoryType } }
              } else {
                const existing = await findCategoryByName(params.name)
                if (existing) return { content: [{ type: 'text' as const, text: `Category exists: ${existing.name}. ID: ${existing.id}` }], details: { category: existing, type: categoryType } }
                const category = await categoryService.create({ name: params.name, parentId: params.parentId, color: params.color })
                return { content: [{ type: 'text' as const, text: `Category "${params.name}" created. ID: ${category.id}` }], details: { category, type: categoryType } }
              }
            }

            if (action === 'update') {
              const categoryIds: string[] = []
              if (params.id) categoryIds.push(params.id)
              if (params.ids && Array.isArray(params.ids)) categoryIds.push(...params.ids)
              if (categoryIds.length === 0) return { content: [{ type: 'text' as const, text: 'id or ids required for update' }], isError: true, details: {} }

              if (categoryType === 'search') {
                const results = []
                for (const id of categoryIds) {
                  const updates: any = {}
                  if (params.name !== undefined) updates.name = params.name
                  if (params.parentId !== undefined) updates.parentId = params.parentId
                  const category = searchCategoryService.updateCategory(id, updates)
                  results.push(category)
                }
                const text = categoryIds.length === 1 ? `Search category updated: ${results[0].name}` : `${categoryIds.length} search categories updated`
                return { content: [{ type: 'text' as const, text }], details: { categories: results, type: categoryType } }
              } else {
                const data: any = {}
                if (params.name !== undefined) data.name = params.name
                if (params.parentId !== undefined) data.parentId = params.parentId
                if (params.color !== undefined) data.color = params.color
                const categories = []
                for (const id of categoryIds) {
                  categories.push(await categoryService.update(id, data))
                }
                const text = categoryIds.length === 1 ? `Category updated` : `${categories.length} categories updated`
                return { content: [{ type: 'text' as const, text }], details: { categoryIds, categories, type: categoryType } }
              }
            }

            if (action === 'delete') {
              const categoryIds: string[] = []
              if (params.id) categoryIds.push(params.id)
              if (params.ids && Array.isArray(params.ids)) categoryIds.push(...params.ids)
              if (categoryIds.length === 0) return { content: [{ type: 'text' as const, text: 'id or ids required for delete' }], isError: true, details: {} }

              if (categoryType === 'search') {
                let totalPapers = 0
                for (const id of categoryIds) {
                  const category = searchCategoryService.getCategory(id)
                  if (category) {
                    totalPapers += category.papers.length
                    searchCategoryService.deleteCategory(id)
                  }
                }
                const text = categoryIds.length === 1 ? `Search category deleted. ${totalPapers} papers removed.` : `${categoryIds.length} categories deleted. ${totalPapers} papers removed.`
                return { content: [{ type: 'text' as const, text }], details: { categoryIds, totalPapers, type: categoryType } }
              } else {
                const result = await categoryService.deleteMany(categoryIds)
                const text = `${result.deleted} categor${result.deleted === 1 ? 'y' : 'ies'} deleted. ${result.papersUncategorized} papers uncategorized.${result.missing ? ` ${result.missing} not found.` : ''}`
                return { content: [{ type: 'text' as const, text }], details: { categoryIds, ...result, type: categoryType } }
              }
            }

            return { content: [{ type: 'text' as const, text: 'Invalid action' }], isError: true, details: {} }
          } catch (err) {
            return { content: [{ type: 'text' as const, text: `Failed: ${(err as Error).message}` }], isError: true, details: {} }
          }
        },
      }),

      // ============================================================================
      // NEW Tool 3: yarc_papers (unified paper management)
      // ============================================================================
      defineTool({
        name: 'yarc_papers',
        label: 'Manage Papers',
        description: 'Unified paper management. Actions: list (query papers), read (read local parsed PDF content), save (batch save to library/search), classify (batch move to category), update (batch update metadata), delete (batch delete with cascade). Use type="library" for uploaded PDFs or type="search" for search collections.',
        parameters: Type.Object({
          action: Type.Union([
            Type.Literal('list'),
            Type.Literal('read'),
            Type.Literal('save'),
            Type.Literal('classify'),
            Type.Literal('update'),
            Type.Literal('delete')
          ], { description: 'Action: list, read, save, classify, update, or delete' }),
          type: Type.Optional(Type.Union([Type.Literal('library'), Type.Literal('search')], { description: 'Paper type: "library" (default) or "search"' })),
          // For list
          categoryId: Type.Optional(Type.String({ description: 'Filter by category ID' })),
          query: Type.Optional(Type.String({ description: 'Search query' })),
          page: Type.Optional(Type.Number()),
          limit: Type.Optional(Type.Number()),
          includeAbstract: Type.Optional(Type.Boolean()),
          // For read
          mode: Type.Optional(Type.Union([
            Type.Literal('metadata'),
            Type.Literal('summary'),
            Type.Literal('pages'),
            Type.Literal('chunks'),
            Type.Literal('full_text'),
          ], { description: 'For action=read: metadata, summary, pages, chunks, or full_text' })),
          startPage: Type.Optional(Type.Number({ description: 'For action=read mode=pages: start page' })),
          endPage: Type.Optional(Type.Number({ description: 'For action=read mode=pages: end page' })),
          maxChars: Type.Optional(Type.Number({ description: 'For action=read: maximum returned characters; capped at 40000' })),
          // For save
          papers: Type.Optional(Type.Array(paperSchema, { description: 'Papers to save (batch)' })),
          category: Type.Optional(Type.String({ description: 'Category name (auto-create)' })),
          parentCategory: Type.Optional(Type.String({ description: 'Parent category name' })),
          importPdf: Type.Optional(Type.Boolean({ description: 'For save type=library: import PDFs server-side from each paper pdfBase64/file, pdfPath, pdfUrl, openAccessPdf.url, or url' })),
          requirePdf: Type.Optional(Type.Boolean({ description: 'For importPdf: skip papers whose PDF import fails (default true)' })),
          extractMetadata: Type.Optional(Type.Boolean({ description: 'For importPdf: extract/enrich metadata from the PDF; default false to preserve provided metadata and go directly to MinerU + embedding' })),
          removeFromSearchCategory: Type.Optional(Type.Object({
            categoryId: Type.String({ description: 'Search category ID to remove from' }),
            paperIds: Type.Array(Type.String(), { description: 'Search paper IDs to remove' })
          }, { description: 'Remove papers from search category after saving to library' })),
          // For classify
          paperIds: Type.Optional(Type.Array(Type.String(), { description: 'Paper IDs (batch)' })),
          // For update
          paperId: Type.Optional(Type.String({ description: 'Paper ID (single)' })),
          title: Type.Optional(Type.String()),
          authors: Type.Optional(Type.Array(Type.String())),
          year: Type.Optional(Type.Number()),
          abstract: Type.Optional(Type.String()),
          doi: Type.Optional(Type.String()),
          arxivId: Type.Optional(Type.String()),
          url: Type.Optional(Type.String()),
        }),
        async execute(_toolCallId: string, params: any) {
          try {
            const action = params.action
            const paperType = params.type || 'library'
            const rankingsFor = async (paper: any) => {
              const meta = (paper.metadata || {}) as any
              const name = paper.journal || paper.venue || meta.journal || meta.venue || ''
              return name ? await rankingService.getRankingsWithCustom(name) : { ccf: null, sci: null }
            }

            // === LIST ===
            if (action === 'list') {
              if (paperType === 'search') {
                if (!params.categoryId) return { content: [{ type: 'text' as const, text: 'categoryId required for type="search"' }], isError: true, details: {} }
                const papers = await Promise.all(searchCategoryService.getPapers(params.categoryId).map(async (p: any) => ({
                  ...p,
                  rankings: await rankingsFor(p),
                })))
                let text = `Search category contains ${papers.length} papers:\n\n`
                for (const p of papers.slice(0, 50)) {
                  const ranks = [p.rankings?.ccf, p.rankings?.sci].filter(Boolean).join('/') || 'unranked'
                  text += `- **${p.title}** (${p.year || 'N/A'}) [${p.source}] rank=${ranks} ID: ${p.id}\n`
                }
                return { content: [{ type: 'text' as const, text }], details: { papers, total: papers.length, type: paperType } }
              } else {
                const { categoryId, query, page = 1, limit = 50, includeAbstract = false } = params
                const where: any = {}
                if (categoryId) where.categoryId = categoryId
                if (query) where.OR = [{ title: { contains: query, mode: 'insensitive' } }, { abstract: { contains: query, mode: 'insensitive' } }]
                const skip = (page - 1) * limit
                const [rawPapers, total] = await Promise.all([
                  prisma.paper.findMany({ where, select: { id: true, title: true, authors: true, year: true, abstract: includeAbstract, categoryId: true, metadata: true }, orderBy: { createdAt: 'desc' }, skip, take: limit }),
                  prisma.paper.count({ where }),
                ])
                const papers = await Promise.all(rawPapers.map(async (p: any) => {
                  const meta = (p.metadata || {}) as any
                  const journal = meta.journal || null
                  const venue = meta.venue || null
                  return { ...p, journal, venue, rankings: await rankingsFor({ ...p, journal, venue }) }
                }))
                let text = `Library contains ${total} matching papers:\n\n`
                for (const p of papers) {
                  const authors = p.authors?.slice(0, 2).join(', ') || 'Unknown'
                  const ranks = [p.rankings?.ccf, p.rankings?.sci].filter(Boolean).join('/') || 'unranked'
                  text += `- **${p.title}** (${p.year || 'N/A'}) - ${authors} rank=${ranks} [ID: ${p.id}]${p.categoryId ? ` cat=${p.categoryId}` : ' uncategorized'}\n`
                  if (includeAbstract && p.abstract) text += `  Abstract: ${p.abstract.slice(0, 260)}...\n`
                }
                return { content: [{ type: 'text' as const, text }], details: { papers, total, type: paperType } }
              }
            }

            // === READ ===
            if (action === 'read') {
              if (paperType !== 'library') return { content: [{ type: 'text' as const, text: 'read is only available for type="library" local papers' }], isError: true, details: { type: paperType } }
              const paperId = String(params.paperId || '').trim()
              if (!paperId) return { content: [{ type: 'text' as const, text: 'paperId is required for read' }], isError: true, details: {} }

              const mode = params.mode || 'metadata'
              const maxChars = Math.min(Math.max(Number(params.maxChars || 12000), 1000), 40000)
              const truncate = (text: string) => {
                const normalized = text.trim()
                if (normalized.length <= maxChars) return { text: normalized, truncated: false }
                return { text: `${normalized.slice(0, maxChars).trim()}\n\n[truncated: content exceeded ${maxChars} chars]`, truncated: true }
              }

              const paper = await prisma.paper.findUnique({
                where: { id: paperId },
                select: {
                  id: true,
                  title: true,
                  authors: true,
                  year: true,
                  doi: true,
                  arxivId: true,
                  abstract: true,
                  summary: true,
                  parseStatus: true,
                  embeddingStatus: true,
                  metadata: true,
                  parseResult: true,
                },
              })
              if (!paper) return { content: [{ type: 'text' as const, text: `Paper not found: ${paperId}` }], isError: true, details: {} }

              const meta = (paper.metadata || {}) as any
              const header = [
                `Title: ${paper.title}`,
                paper.authors?.length ? `Authors: ${paper.authors.join(', ')}` : '',
                paper.year ? `Year: ${paper.year}` : '',
                paper.doi ? `DOI: ${paper.doi}` : '',
                paper.arxivId ? `arXiv: ${paper.arxivId}` : '',
                meta.journal || meta.venue ? `Venue: ${meta.journal || meta.venue}` : '',
                `ID: ${paper.id}`,
              ].filter(Boolean).join('\n')

              if (mode === 'metadata') {
                const text = `${header}\nParse: ${paper.parseStatus}; Embedding: ${paper.embeddingStatus}${paper.abstract ? `\n\nAbstract:\n${paper.abstract}` : ''}`
                return { content: [{ type: 'text' as const, text }], details: { paper, mode, type: paperType } }
              }

              if (mode === 'summary') {
                if (!paper.summary) return { content: [{ type: 'text' as const, text: `${header}\n\nNo saved summary is available for this paper.` }], details: { paperId, mode, available: false, type: paperType } }
                const out = truncate(paper.summary)
                return { content: [{ type: 'text' as const, text: `${header}\n\n${out.text}` }], details: { paperId, mode, truncated: out.truncated, type: paperType } }
              }

              if (mode === 'chunks') {
                const take = Math.min(Math.max(Number(params.limit || 20), 1), 100)
                const chunks = await prisma.paperChunk.findMany({
                  where: {
                    paperId,
                    ...(params.page ? { pageNumber: Number(params.page) } : {}),
                  },
                  select: { content: true, pageNumber: true, chunkIndex: true },
                  orderBy: [{ pageNumber: 'asc' }, { chunkIndex: 'asc' }],
                  take,
                })
                if (!chunks.length) return { content: [{ type: 'text' as const, text: `${header}\n\nNo chunks found for this paper/page.` }], details: { paperId, mode, chunks: [], type: paperType } }
                const body = chunks.map((chunk) => `[page ${chunk.pageNumber ?? '?'} chunk ${chunk.chunkIndex ?? '?'}]\n${chunk.content}`).join('\n\n')
                const out = truncate(body)
                return { content: [{ type: 'text' as const, text: `${header}\n\n${out.text}` }], details: { paperId, mode, count: chunks.length, truncated: out.truncated, type: paperType } }
              }

              if (!paper.parseResult) {
                return { content: [{ type: 'text' as const, text: `${header}\n\nParsed content is unavailable. Parse status: ${paper.parseStatus}` }], isError: true, details: { paperId, mode, type: paperType } }
              }

              if (mode === 'pages') {
                const parseResult = paper.parseResult as any
                const pages = Array.isArray(parseResult.pages) ? parseResult.pages : []
                const startPage = Number(params.page || params.startPage || 1)
                const endPage = Number(params.page || params.endPage || startPage)
                const selected = pages.filter((page: any) => Number(page.page || page.pageNumber) >= startPage && Number(page.page || page.pageNumber) <= endPage)
                if (!selected.length) return { content: [{ type: 'text' as const, text: `${header}\n\nNo parsed page text found for page range ${startPage}-${endPage}.` }], details: { paperId, mode, startPage, endPage, type: paperType } }
                const body = selected.map((page: any) => `[page ${page.page || page.pageNumber || '?'}]\n${page.text || page.content || page.md || ''}`).join('\n\n')
                const out = truncate(body)
                return { content: [{ type: 'text' as const, text: `${header}\n\n${out.text}` }], details: { paperId, mode, startPage, endPage, truncated: out.truncated, type: paperType } }
              }

              if (mode === 'full_text') {
                let body = ''
                try {
                  const contentListV2 = await loadMineruContentListV2(paper.parseResult)
                  body = renderSummaryMarkdownFromV2(contentListV2, {
                    includeReferences: false,
                    includePageFootnotes: false,
                    includeImages: true,
                    includeEquations: true,
                    includeTables: true,
                    includeAlgorithms: true,
                  })
                } catch {
                  const parseResult = paper.parseResult as any
                  body = String(parseResult.text || parseResult.full_text || parseResult.markdown || '')
                }
                if (!body.trim()) return { content: [{ type: 'text' as const, text: `${header}\n\nNo full text could be rendered from parseResult.` }], isError: true, details: { paperId, mode, type: paperType } }
                const out = truncate(body)
                return { content: [{ type: 'text' as const, text: `${header}\n\n${out.text}` }], details: { paperId, mode, truncated: out.truncated, type: paperType } }
              }

              return { content: [{ type: 'text' as const, text: `Invalid read mode: ${mode}` }], isError: true, details: { type: paperType } }
            }

            // === SAVE ===
            if (action === 'save') {
              if (!params.papers || !Array.isArray(params.papers) || params.papers.length === 0) {
                return { content: [{ type: 'text' as const, text: 'papers array is required for save' }], isError: true, details: {} }
              }

              let categoryId: string | undefined
              if (params.category) {
                if (paperType === 'search') {
                  const cat = findOrCreateSearchCategory(params.category, params.parentCategory ? findOrCreateSearchCategory(params.parentCategory).id : undefined)
                  categoryId = cat.id
                } else {
                  const parentCat = params.parentCategory ? await findOrCreateCategory(params.parentCategory) : undefined
                  const cat = await findOrCreateCategory(params.category, parentCat?.id)
                  categoryId = cat.id
                }
              } else {
                categoryId = params.categoryId
              }

              if (paperType === 'search') {
                if (!categoryId) return { content: [{ type: 'text' as const, text: 'category or categoryId required for type="search"' }], isError: true, details: {} }
                const normalized = params.papers.map((p: any) => normalizeSearchPaper(p, p?.source || 'semantic_scholar'))
                const saved = searchCategoryService.addPapers(categoryId, normalized)
                return { content: [{ type: 'text' as const, text: `Saved ${saved.length} papers to search category.` }], details: { papers: saved, categoryId, type: paperType } }
              } else {
                const savedPapers = []
                const errors: Array<{ title?: string; message: string }> = []
                const importPdf = !!params.importPdf
                const requirePdf = params.requirePdf !== false
                const extractMetadata = params.extractMetadata === true

                if (importPdf) {
                  const job = importJobService.create({
                    papers: params.papers,
                    categoryId,
                    requirePdf,
                    extractMetadata,
                  })
                  return {
                    content: [{ type: 'text' as const, text: `Started background PDF import job ${job.id} for ${job.total} papers. Progress is shown in the top search bar.` }],
                    details: { job, type: paperType },
                  }
                }

                for (const p of params.papers) {
                  const paper = await prisma.paper.create({
                    data: {
                      title: p.title,
                      authors: p.authors || [],
                      year: p.year,
                      abstract: p.abstract,
                      doi: p.doi,
                      arxivId: p.arxivId,
                      url: p.url,
                      categoryId,
                      metadata: {
                        venue: p.venue,
                        journal: p.journal,
                        source: p.source,
                        provider: p.provider,
                        importPdfError: errors.find((e) => e.title === p.title)?.message,
                      }
                    }
                  })
                  savedPapers.push(paper)
                }

                // Auto-remove from search category if specified
                if (params.removeFromSearchCategory?.categoryId && params.removeFromSearchCategory?.paperIds?.length) {
                  for (const searchPaperId of params.removeFromSearchCategory.paperIds) {
                    searchCategoryService.removePaper(params.removeFromSearchCategory.categoryId, searchPaperId)
                  }
                }

                const failedText = errors.length ? ` Failed/skipped ${errors.length}.` : ''
                return { content: [{ type: 'text' as const, text: `Saved ${savedPapers.length} papers to library.${failedText}` }], details: { papers: savedPapers, errors, type: paperType } }
              }
            }

            // === CLASSIFY ===
            if (action === 'classify') {
              if (!params.paperIds || !Array.isArray(params.paperIds) || params.paperIds.length === 0) {
                return { content: [{ type: 'text' as const, text: 'paperIds array is required for classify' }], isError: true, details: {} }
              }

              let categoryId: string | undefined
              if (params.category) {
                const parentCat = params.parentCategory ? await findOrCreateCategory(params.parentCategory) : undefined
                const cat = await findOrCreateCategory(params.category, parentCat?.id)
                categoryId = cat.id
              } else {
                categoryId = params.categoryId
              }

              if (!categoryId) return { content: [{ type: 'text' as const, text: 'category or categoryId required for classify' }], isError: true, details: {} }

              const result = await paperService.updateCategory(params.paperIds, categoryId)
              const text = `${result.updated} paper(s) moved to category ${categoryId}${result.missing ? ` (${result.missing} not found)` : ''}`
              return { content: [{ type: 'text' as const, text }], details: { paperIds: params.paperIds, categoryId, ...result } }
            }

            // === UPDATE ===
            if (action === 'update') {
              const paperIds: string[] = []
              if (params.paperId) paperIds.push(params.paperId)
              if (params.paperIds && Array.isArray(params.paperIds)) paperIds.push(...params.paperIds)
              if (paperIds.length === 0) return { content: [{ type: 'text' as const, text: 'paperId or paperIds required for update' }], isError: true, details: {} }

              const data: any = {}
              if (params.title !== undefined) data.title = params.title
              if (params.authors !== undefined) data.authors = params.authors
              if (params.year !== undefined) data.year = params.year
              if (params.abstract !== undefined) data.abstract = params.abstract
              if (params.doi !== undefined) data.doi = params.doi
              if (params.arxivId !== undefined) data.arxivId = params.arxivId
              if (params.url !== undefined) data.url = params.url

              await prisma.paper.updateMany({ where: { id: { in: paperIds } }, data })
              const text = paperIds.length === 1 ? `Paper updated` : `${paperIds.length} papers updated`
              return { content: [{ type: 'text' as const, text }], details: { paperIds, count: paperIds.length } }
            }

            // === DELETE ===
            if (action === 'delete') {
              const paperIds: string[] = []
              if (params.paperId) paperIds.push(params.paperId)
              if (params.paperIds && Array.isArray(params.paperIds)) paperIds.push(...params.paperIds)
              if (paperIds.length === 0) return { content: [{ type: 'text' as const, text: 'paperId or paperIds required for delete' }], isError: true, details: {} }

              if (paperType === 'search') {
                if (!params.categoryId) return { content: [{ type: 'text' as const, text: 'categoryId required for type="search" delete' }], isError: true, details: {} }
                for (const id of paperIds) {
                  searchCategoryService.removePaper(params.categoryId, id)
                }
                return { content: [{ type: 'text' as const, text: `${paperIds.length} papers deleted from search category.` }], details: { paperIds, count: paperIds.length, type: paperType } }
              } else {
                const result = await paperService.deleteMany(paperIds)
                const text = `${result.deleted} paper(s) deleted (including PDF directories).${result.missing ? ` ${result.missing} not found.` : ''}`
                return { content: [{ type: 'text' as const, text }], details: { paperIds, ...result, type: paperType } }
              }
            }

            return { content: [{ type: 'text' as const, text: 'Invalid action' }], isError: true, details: {} }
          } catch (err) {
            return { content: [{ type: 'text' as const, text: `Failed: ${(err as Error).message}` }], isError: true, details: {} }
          }
        },
      }),

      // ============================================================================
      // Tool: yarc_system (backend status and maintenance)
      // ============================================================================
      defineTool({
        name: 'yarc_system',
        label: 'YARC System',
        description: 'Inspect YARC backend status and enqueue maintenance jobs. Use action="status" to read paper/queue/MinerU/vector status. Use action="maintenance" to enqueue re-MinerU parsing, re-embedding, or re-summarization jobs; use dryRun=true first for broad scopes.',
        parameters: Type.Object({
          action: Type.Union([Type.Literal('status'), Type.Literal('maintenance')], { description: 'status reads backend status; maintenance enqueues maintenance jobs' }),
          maintenanceAction: Type.Optional(Type.Union([
            Type.Literal('embeddings'),
            Type.Literal('mineru'),
            Type.Literal('summaries'),
          ], { description: 'Maintenance action: embeddings, mineru, or summaries' })),
          scope: Type.Optional(Type.Union([
            Type.Literal('needed'),
            Type.Literal('all'),
            Type.Literal('paperIds'),
          ], { description: 'Target scope for maintenance. needed is default; all must be explicit; paperIds uses paperIds.' })),
          paperIds: Type.Optional(Type.Array(Type.String(), { description: 'Explicit paper IDs when scope="paperIds"' })),
          limit: Type.Optional(Type.Number({ description: 'Optional maximum number of matched targets to enqueue' })),
          dryRun: Type.Optional(Type.Boolean({ description: 'If true, only reports matched targets without enqueueing jobs' })),
        }),
        async execute(_toolCallId: string, params: any) {
          try {
            const action = params?.action
            if (action === 'status') {
              const status = await buildSystemStatus()
              const paper = status.papers
              const chunks = status.chunks
              const parsePending = Number(status.parseStatuses.pending || 0)
              const parseProcessing = Number(status.parseStatuses.processing || 0)
              const embeddingPending = Number(status.embeddingStatuses.pending || 0)
              const embeddingProcessing = Number(status.embeddingStatuses.processing || 0)
              const lines = [
                `YARC backend status: ${paper.total} papers`,
                `Parse: completed=${paper.parseCompleted}, pending=${paper.parsePending}, processing=${paper.parseProcessing}, failed=${paper.parseFailed}`,
                `Embedding: completed=${paper.embeddingCompleted}, pending=${paper.embeddingPending}, processing=${paper.embeddingProcessing}, failed=${paper.embeddingFailed}`,
                `Summary: completed=${paper.summaryCompleted}, pending=${paper.summaryPending}, processing=${paper.summaryProcessing}, failed=${paper.summaryFailed}, missing=${paper.missingSummary}`,
                `Chunks: total=${chunks.totalChunks}, papersWithChunks=${chunks.papersWithChunks}, avgChunksPerPaper=${Number(chunks.avgChunksPerPaper).toFixed(1)}, avgChunkChars=${Number(chunks.avgChunkChars).toFixed(0)}`,
                `MinerU artifacts: completedPapers=${status.mineruArtifacts.completedPapers}, contentListV2=${status.mineruArtifacts.contentListV2}, imagesDir=${status.mineruArtifacts.imagesDir}`,
                `In-memory queue: pending=${status.inMemoryQueue.pending}, running=${status.inMemoryQueue.running}`,
              ]
              if (parsePending || parseProcessing || embeddingPending || embeddingProcessing) {
                lines.push(`Active backlog: parse=${parseProcessing} running/${parsePending} pending, embedding=${embeddingProcessing} running/${embeddingPending} pending`)
              }
              return { content: [{ type: 'text' as const, text: lines.join('\n') }], details: status }
            }

            if (action === 'maintenance') {
              const maintenanceAction = params?.maintenanceAction
              if (!['embeddings', 'mineru', 'summaries'].includes(maintenanceAction)) {
                return { content: [{ type: 'text' as const, text: 'maintenanceAction must be embeddings, mineru, or summaries' }], isError: true, details: {} }
              }
              const scope = params?.scope === 'all' || params?.scope === 'paperIds' ? params.scope : 'needed'
              if (scope === 'paperIds' && (!Array.isArray(params.paperIds) || params.paperIds.length === 0)) {
                return { content: [{ type: 'text' as const, text: 'paperIds are required when scope="paperIds"' }], isError: true, details: {} }
              }
              const matchedIds = await selectMaintenanceTargets(maintenanceAction, scope, params.paperIds)
              const ids = limitTargets(matchedIds, params?.limit)
              const dryRun = params?.dryRun === true
              const result = await enqueueMaintenance(maintenanceAction, ids, dryRun)
              const text = dryRun
                ? `Dry run: ${maintenanceAction} matched ${matchedIds.length} paper(s), limited to ${ids.length}. No jobs enqueued.`
                : `Enqueued ${result.enqueued}/${ids.length} ${maintenanceAction} maintenance job(s) (matched ${matchedIds.length}).${result.errors.length ? ` Errors: ${result.errors.length}` : ''}`
              return {
                content: [{ type: 'text' as const, text }],
                details: {
                  action: maintenanceAction,
                  scope,
                  dryRun,
                  matched: matchedIds.length,
                  limitedTo: ids.length,
                  enqueued: result.enqueued,
                  targetIds: ids,
                  errors: result.errors,
                },
                ...(result.errors.length ? { isError: result.enqueued === 0 } : {}),
              }
            }

            return { content: [{ type: 'text' as const, text: 'Invalid action; use status or maintenance' }], isError: true, details: {} }
          } catch (err) {
            return { content: [{ type: 'text' as const, text: `yarc_system failed: ${(err as Error).message}` }], isError: true, details: {} }
          }
        },
      }),

      // ============================================================================
      // NEW Tool 5: yarc_notes (unified note management)
      // ============================================================================
      defineTool({
        name: 'yarc_notes',
        label: 'Manage Notes',
        description: 'Unified note management. Actions: list, create, update, delete, and sync. sync imports existing linked Markdown files into database notes and accepts paperId or paperIds.',
        parameters: Type.Object({
          action: Type.Union([
            Type.Literal('list'),
            Type.Literal('create'),
            Type.Literal('update'),
            Type.Literal('delete'),
            Type.Literal('sync')
          ], { description: 'Action: list, create, update, delete, or sync' }),
          // For list/create/sync
          paperId: Type.Optional(Type.String({ description: 'Paper ID (required for list/create; sync accepts this or paperIds)' })),
          paperIds: Type.Optional(Type.Array(Type.String(), { maxItems: 100, description: 'Paper IDs for sync (maximum 100)' })),
          // For create (single)
          title: Type.Optional(Type.String({ description: 'Note title' })),
          content: Type.Optional(Type.String({ description: 'Note content' })),
          pageNumber: Type.Optional(Type.Number({ description: 'Page number reference' })),
          kind: Type.Optional(Type.String({ description: 'Note kind. For list, filters returned notes by kind (e.g., summary only). For create, sets the note kind (e.g., note, summary, organized).' })),
          // For create (batch)
          notes: Type.Optional(Type.Array(Type.Object({
            paperId: Type.String(),
            title: Type.String(),
            content: Type.Optional(Type.String()),
            pageNumber: Type.Optional(Type.Number()),
            kind: Type.Optional(Type.String()),
          }), { description: 'Array of notes to create (batch)' })),
          // For update/delete
          noteId: Type.Optional(Type.String({ description: 'Note ID (single operation)' })),
          noteIds: Type.Optional(Type.Array(Type.String(), { description: 'Note IDs (batch operation)' })),
        }),
        async execute(_toolCallId: string, params: any) {
          try {
            const action = params.action

            // === SYNC ===
            if (action === 'sync') {
              const paperIds = [
                ...(params.paperId ? [String(params.paperId)] : []),
                ...(Array.isArray(params.paperIds) ? params.paperIds.map(String) : []),
              ]
              const uniquePaperIds = [...new Set(paperIds)]
              if (uniquePaperIds.length === 0) {
                return { content: [{ type: 'text' as const, text: 'paperId or paperIds is required for sync' }], isError: true, details: {} }
              }
              if (uniquePaperIds.length > 100) {
                return { content: [{ type: 'text' as const, text: 'At most 100 paper IDs can be synced at once' }], isError: true, details: {} }
              }
              const result = await noteService.syncFromFiles(uniquePaperIds)
              const text = `Note file sync checked ${result.matched} linked notes: ${result.synced} updated, ${result.unchanged} unchanged, ${result.missing} missing, ${result.failed} failed.`
              return { content: [{ type: 'text' as const, text }], details: result }
            }

            // === LIST ===
            if (action === 'list') {
              if (!params.paperId) return { content: [{ type: 'text' as const, text: 'paperId is required for list' }], isError: true, details: {} }
              const notes = await noteService.listByPaper(params.paperId, { kind: params.kind })
              let text = params.kind
                ? `Paper has ${notes.length} ${params.kind} notes:\n\n`
                : `Paper has ${notes.length} notes:\n\n`
              for (const note of notes.slice(0, 50)) {
                text += `- **${note.title || '(untitled)'}** [${note.kind}] ID: ${note.id}`
                if (note.pageNumber) text += ` page=${note.pageNumber}`
                text += `\n${String(note.content || note.highlightText || '').slice(0, 240)}\n`
              }
              return { content: [{ type: 'text' as const, text }], details: { notes, count: notes.length } }
            }

            // === CREATE ===
            if (action === 'create') {
              const notesToCreate: any[] = []

              // Batch mode
              if (params.notes && Array.isArray(params.notes)) {
                notesToCreate.push(...params.notes)
              }
              // Single mode
              else if (params.paperId && params.title) {
                notesToCreate.push({
                  paperId: params.paperId,
                  title: params.title,
                  content: params.content,
                  pageNumber: params.pageNumber,
                  kind: params.kind || 'note',
                })
              }

              if (notesToCreate.length === 0) {
                return { content: [{ type: 'text' as const, text: 'notes array or (paperId + title) required for create' }], isError: true, details: {} }
              }

              const created = []
              for (const n of notesToCreate) {
                const note = await noteService.create({
                  paperId: n.paperId,
                  title: n.title,
                  content: n.content,
                  pageNumber: n.pageNumber,
                  kind: n.kind || 'note'
                })
                created.push(note)
              }

              const text = created.length === 1 ? `Note created. ID: ${created[0].id}` : `${created.length} notes created.`
              return { content: [{ type: 'text' as const, text }], details: { notes: created, count: created.length } }
            }

            // === UPDATE ===
            if (action === 'update') {
              const noteIds: string[] = []
              if (params.noteId) noteIds.push(params.noteId)
              if (params.noteIds && Array.isArray(params.noteIds)) noteIds.push(...params.noteIds)
              if (noteIds.length === 0) return { content: [{ type: 'text' as const, text: 'noteId or noteIds required for update' }], isError: true, details: {} }

              const updates: any = {}
              if (params.title !== undefined) updates.title = params.title
              if (params.content !== undefined) updates.content = params.content
              if (params.pageNumber !== undefined) updates.pageNumber = params.pageNumber

              const updated = []
              for (const id of noteIds) {
                const note = await noteService.update(id, updates)
                updated.push(note)
              }

              const text = noteIds.length === 1 ? `Note updated. ID: ${updated[0].id}` : `${noteIds.length} notes updated.`
              return { content: [{ type: 'text' as const, text }], details: { notes: updated, count: updated.length } }
            }

            // === DELETE ===
            if (action === 'delete') {
              const noteIds: string[] = []
              if (params.noteId) noteIds.push(params.noteId)
              if (params.noteIds && Array.isArray(params.noteIds)) noteIds.push(...params.noteIds)
              if (noteIds.length === 0) return { content: [{ type: 'text' as const, text: 'noteId or noteIds required for delete' }], isError: true, details: {} }

              for (const id of noteIds) {
                await prisma.note.delete({ where: { id } })
              }

              const text = noteIds.length === 1 ? `Note deleted.` : `${noteIds.length} notes deleted.`
              return { content: [{ type: 'text' as const, text }], details: { noteIds, count: noteIds.length } }
            }

            return { content: [{ type: 'text' as const, text: 'Invalid action' }], isError: true, details: {} }
          } catch (err) {
            return { content: [{ type: 'text' as const, text: `Failed: ${(err as Error).message}` }], isError: true, details: {} }
          }
        },
      }),

    ]
  }

  private createWebUIContext(input: {
    conversationId?: string
    streamMessageId?: string
    emit: (event: ChatEvent) => void
  }): any {
    const unavailable = async <T>(fallback: T): Promise<T> => fallback
    const emitNotification = (message: string, notifyType: 'info' | 'warning' | 'error' = 'info') => {
      if (!input.conversationId || !input.streamMessageId) return
      input.emit({
        type: 'agent_interaction_request',
        requestId: randomUUID(),
        conversationId: input.conversationId,
        streamMessageId: input.streamMessageId,
        kind: 'notification',
        title: notifyType === 'error' ? 'Agent 错误' : notifyType === 'warning' ? 'Agent 提醒' : 'Agent 通知',
        message,
        payload: { message, notifyType },
        createdAt: new Date().toISOString(),
      })
    }

    const requestDialog = async (
      kind: 'confirm' | 'select' | 'input',
      payload: Record<string, unknown>,
      timeoutMs?: number
    ): Promise<AgentInteractionResponse | null> => {
      if (!input.conversationId || !input.streamMessageId) return null
      return agentInteractionRegistry.create({
        conversationId: input.conversationId,
        streamMessageId: input.streamMessageId,
        kind,
        title: typeof payload.title === 'string' ? payload.title : undefined,
        message: typeof payload.message === 'string' ? payload.message : undefined,
        payload,
        timeoutMs,
        emitRequest: input.emit,
        emitResolved: input.emit,
      })
    }

    return {
      select: async (title: string, options: string[], opts?: { timeout?: number }) => {
        const response = await requestDialog('select', {
          title,
          options: options.map((value) => ({ value, label: value })),
          multi: false,
        }, opts?.timeout)
        if (!response || response.action !== 'submit') return undefined
        const value = response.value as any
        return typeof value === 'string' ? value : typeof value?.value === 'string' ? value.value : undefined
      },
      confirm: async (title: string, message: string, opts?: { timeout?: number }) => {
        const response = await requestDialog('confirm', { title, message }, opts?.timeout)
        if (!response || response.action !== 'submit') return false
        const value = response.value as any
        return typeof value === 'boolean' ? value : !!value?.confirmed
      },
      input: async (title: string, placeholder?: string, opts?: { timeout?: number }) => {
        const response = await requestDialog('input', { title, placeholder, multiline: false }, opts?.timeout)
        if (!response || response.action !== 'submit') return undefined
        const value = response.value as any
        return typeof value === 'string' ? value : typeof value?.value === 'string' ? value.value : undefined
      },
      editor: async (title: string, prefill?: string) => {
        const response = await requestDialog('input', { title, multiline: true, defaultValue: prefill || '' })
        if (!response || response.action !== 'submit') return undefined
        const value = response.value as any
        return typeof value === 'string' ? value : typeof value?.value === 'string' ? value.value : undefined
      },
      notify: emitNotification,
      onTerminalInput: () => () => {},
      setStatus: (key: string, text: string | undefined) => {
        input.emit({ type: 'agent_ui_status', key, text: text || '', conversationId: input.conversationId, streamMessageId: input.streamMessageId })
      },
      setWorkingMessage: () => {},
      setWorkingVisible: () => {},
      setWorkingIndicator: () => {},
      setHiddenThinkingLabel: () => {},
      setWidget: (key: string, lines?: string[], placement?: 'above' | 'below') => {
        input.emit({ type: 'agent_ui_widget', key, lines: lines || [], placement: placement || 'above', conversationId: input.conversationId })
      },
      setFooter: (text?: string) => {
        input.emit({ type: 'agent_ui_footer', text: text || '', conversationId: input.conversationId })
      },
      setHeader: (lines?: string[]) => {
        input.emit({ type: 'agent_ui_header', lines: lines || [], conversationId: input.conversationId })
      },
      setTitle: (title: string) => {
        input.emit({ type: 'agent_ui_title', title, conversationId: input.conversationId })
      },
      custom: async () => undefined,
      pasteToEditor: (text: string) => {
        input.emit({ type: 'agent_ui_editor_paste', text, conversationId: input.conversationId })
      },
      setEditorText: (text: string) => {
        input.emit({ type: 'agent_ui_editor_set_text', text, conversationId: input.conversationId })
      },
      getEditorText: () => '',
      addAutocompleteProvider: () => {},
      setEditorComponent: () => {},
      getEditorComponent: () => undefined,
      get theme() { return undefined },
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: (themeName: string) => {
        input.emit({ type: 'agent_ui_theme_request', theme: themeName, conversationId: input.conversationId })
        return { success: true }
      },
      getToolsExpanded: () => false,
      setToolsExpanded: (expanded: boolean) => {
        input.emit({ type: 'agent_ui_tools_expanded', expanded, conversationId: input.conversationId })
      },
      getWorkingMessage: () => undefined,
      getWorkingVisible: () => false,
      waitForInput: () => unavailable(undefined),
    }
  }

  async answerSideQuestion(options: {
    conversationId: string
    branchId?: string
    model?: string
    reasoningEffort?: string
    question: string
    abortSignal?: AbortSignal
    onEvent?: (event: ChatEvent) => void
  }): Promise<{ answer: string; thinking?: string; events: ChatEvent[] }> {
    await this.initPi()
    if (!this.piModule) {
      return { answer: 'Pi SDK 不可用。', thinking: undefined, events: [] }
    }
    await this.refreshPiState()

    const { createAgentSession, DefaultResourceLoader } = this.piModule
    const agentWorkspace = await ensureAgentWorkspace()

    // Resolve model
    let model: any = undefined
    if (options.model) {
      const parts = options.model.split('/')
      if (parts.length === 2) model = this.modelRuntime?.getModel(parts[0], parts[1])
      if (!model) {
        const available = await this.modelRuntime?.getAvailable()
        model = available?.find((m: any) => m.id === options.model)
      }
    }

    // Build resource loader
    let resourceLoader: any
    try {
      resourceLoader = new DefaultResourceLoader({
        cwd: agentWorkspace.cwd,
        agentDir: agentWorkspace.agentDir,
        agentsFilesOverride: (base: { agentsFiles: Array<{ path: string; content: string }> }) => ({
          agentsFiles: base.agentsFiles.filter((file) => file.path !== agentWorkspace.legacyAgentsMd),
        }),
        systemPromptOverride: () => DEFAULT_CHAT_SYSTEM_PROMPT,
      })
      await resourceLoader.reload()
    } catch (err) {
      console.warn('[PiService] ResourceLoader error for side question:', err)
      return { answer: 'ResourceLoader 初始化失败。', thinking: undefined, events: [] }
    }

    // Reuse conversation's Pi session file for full context (history, tool calls, compaction).
    // This gives the side question the same knowledge the main agent has.
    // We do NOT pass conversationId/branchId to completeEvents to avoid
    // saving the side-question turn back to the main session metadata.
    const sessionManager = await this.resolveSessionManager(
      options.conversationId,
      options.branchId,
      agentWorkspace.cwd
    )

    let session: any
    try {
      const result = await createAgentSession({
        sessionManager,
        modelRuntime: this.modelRuntime,
        ...(model ? { model } : {}),
        resourceLoader,
      })
      session = result.session
    } catch (err) {
      console.warn('[PiService] Side question session creation failed:', err)
      return { answer: 'Session 创建失败。', thinking: undefined, events: [] }
    }

    const effort = options.reasoningEffort || 'off'
    session.setThinkingLevel(effort)

    const sidePrompt = [
      'You are answering a side question (not part of the main conversation).',
      'Use your conversation history and tool context to answer. Do not modify the main conversation state.',
      'Answer directly and concisely unless the user asks for detail.',
      '',
      `Side question: ${options.question}`,
    ].join('\n')

    const events: ChatEvent[] = []
    let answer = ''
    let thinking = ''
    try {
      const queue: ChatEvent[] = []
      let resolve: (() => void) | null = null

      const push = (event: ChatEvent) => {
        queue.push(event)
        if (resolve) { resolve(); resolve = null }
      }

      const unsubscribe = session.subscribe((event: any) => {
        if (event.type === 'message_update') {
          const update = event.assistantMessageEvent
          if (update?.type === 'text_delta' && update.delta) push({ type: 'text', content: String(update.delta) })
          else if (update?.type === 'thinking_delta' && update.delta) push({ type: 'thinking', content: String(update.delta) })
          else if (update?.type === 'error') push({ type: 'error', message: update.error?.errorMessage || 'Pi error' })
        } else if (event.type === 'agent_end') {
          push({ type: 'done' })
        }
      })

      const promptPromise = session.prompt(sidePrompt).catch((err: Error) => {
        push({ type: 'error', message: err.message })
        push({ type: 'done' })
      })

      while (true) {
        if (options.abortSignal?.aborted) { session.abort(); break }
        if (queue.length === 0) await new Promise<void>(r => { resolve = r })
        while (queue.length > 0) {
          const evt = queue.shift()!
          if (evt.type === 'text') answer += evt.content
          if (evt.type === 'thinking') thinking += evt.content
          events.push(evt)
          options.onEvent?.(evt)
          if (evt.type === 'done') { unsubscribe(); await promptPromise; return { answer: answer.trim() || 'Pi 没有返回内容。', thinking: thinking || undefined, events } }
        }
      }

      unsubscribe()
      await promptPromise
    } catch (err) {
      console.warn('[PiService] Side question error:', err)
    } finally {
      // Do NOT save session info — side questions are ephemeral.
      await session.dispose()
    }

    return { answer: answer.trim() || 'Pi 没有返回内容。', thinking: thinking || undefined, events }
  }

  async *compactEvents(options: {
    conversationId?: string
    branchId?: string
    assistantMessageId?: string
    model?: string
    reasoningEffort?: string
    customInstructions?: string
    _cancelled?: string
  }): AsyncGenerator<ChatEvent> {
    await this.initPi()

    if (!this.piModule) {
      yield { type: 'error', message: 'Pi SDK not available' }
      yield { type: 'done' }
      return
    }
    await this.refreshPiState()

    const { createAgentSession, DefaultResourceLoader } = this.piModule
    const agentWorkspace = await ensureAgentWorkspace()

    let model: any = undefined
    if (options.model) {
      const parts = options.model.split('/')
      if (parts.length === 2) model = this.modelRuntime?.getModel(parts[0], parts[1])
      if (!model) {
        const available = await this.modelRuntime?.getAvailable()
        model = available?.find((item: any) => item.id === options.model)
      }
    }

    let resourceLoader: any
    try {
      resourceLoader = new DefaultResourceLoader({
        cwd: agentWorkspace.cwd,
        agentDir: agentWorkspace.agentDir,
        agentsFilesOverride: (base: { agentsFiles: Array<{ path: string; content: string }> }) => ({
          agentsFiles: base.agentsFiles.filter((file) => file.path !== agentWorkspace.legacyAgentsMd),
        }),
        systemPromptOverride: (baseSystemPrompt?: string) => baseSystemPrompt?.trim() || DEFAULT_CHAT_SYSTEM_PROMPT,
      })
      await resourceLoader.reload()
    } catch (err) {
      console.error('[PiService] ResourceLoader error for compaction:', err)
      yield { type: 'error', message: `ResourceLoader init failed: ${(err as Error).message}` }
      yield { type: 'done' }
      return
    }

    const sessionManager = await this.resolveSessionManager(
      options.conversationId,
      options.branchId,
      agentWorkspace.cwd
    )

    let session: any
    try {
      const result = await createAgentSession({
        sessionManager,
        modelRuntime: this.modelRuntime,
        ...(model ? { model } : {}),
        resourceLoader,
      })
      session = result.session
    } catch (err) {
      console.error('[PiService] Compaction session creation failed:', err)
      yield { type: 'error', message: `Session creation failed: ${(err as Error).message}` }
      yield { type: 'done' }
      return
    }

    session.setThinkingLevel(options.reasoningEffort || 'off')
    let unregisterAbortHandler: (() => void) | null = null

    try {
      if (options._cancelled) {
        unregisterAbortHandler = chatStreamControl.registerAbortHandler(options._cancelled, () => {
          session.abortCompaction?.()
        })
      }

      yield { type: 'compaction_start' }
      console.log('[PiService] Sending /compact to Pi SDK', options.customInstructions ? 'with custom instructions' : '')

      const result = await session.compact(options.customInstructions)
      if (options._cancelled && chatStreamControl.isCancelled(options._cancelled)) return

      yield {
        type: 'compaction_complete',
        summary: result.summary,
        tokensBefore: result.tokensBefore,
        estimatedTokensAfter: result.estimatedTokensAfter,
      }

      const contextWindow = Number(session.model?.contextWindow || 0)
      const tokens = typeof result.estimatedTokensAfter === 'number' ? result.estimatedTokensAfter : null
      yield {
        type: 'context_usage',
        tokens,
        contextWindow,
        percent: contextWindow > 0 && tokens !== null ? (tokens / contextWindow) * 100 : null,
        model: session.model?.id,
      }
      yield { type: 'done' }
    } catch (err) {
      if (!(options._cancelled && chatStreamControl.isCancelled(options._cancelled))) {
        yield { type: 'error', message: `上下文压缩失败：${(err as Error).message || '未知错误'}` }
        yield { type: 'done' }
      }
    } finally {
      if (options.conversationId && options.branchId) {
        await this.savePiSessionInfo(options.conversationId, options.branchId, session)
      }
      unregisterAbortHandler?.()
      agentInteractionRegistry.cancelByStream(options.assistantMessageId || '', 'session_disposed')
      await session.dispose()
    }
  }

  async *completeEvents(options: {
    conversationId?: string
    branchId?: string
    userMessageId?: string
    assistantMessageId?: string
    model?: string
    systemPrompt?: string
    prompt: string
    reasoningEffort?: string
    _cancelled?: string  // messageId to check for cancellation
  }): AsyncGenerator<ChatEvent> {
    await this.initPi()

    if (!this.piModule) {
      yield { type: 'error', message: 'Pi SDK not available' }
      yield { type: 'done' }
      return
    }
    await this.refreshPiState()

    const { createAgentSession, DefaultResourceLoader } = this.piModule
    let emitInteractionEvent: ((event: ChatEvent) => void) | null = null
    const yarcTools = await this.createYarcTools({
      conversationId: options.conversationId,
      streamMessageId: options.assistantMessageId,
      emit: (event) => emitInteractionEvent?.(event),
    })
    const enabledTools = this.filterChatTools(yarcTools)
    const agentWorkspace = await ensureAgentWorkspace()

    // Resolve model: use requested model or fall back to first available
    let model: any = undefined
    if (options.model) {
      const parts = options.model.split('/')
      if (parts.length === 2) {
        model = this.modelRuntime?.getModel(parts[0], parts[1])
      }
      if (!model) {
        const available = await this.modelRuntime?.getAvailable()
        model = available?.find((m: any) => m.id === options.model)
      }
    }

    // Keep Pi scoped to YARC's data directory so paper parse output, notes,
    // project .pi resources, and skills all live under one runtime root.
    let resourceLoader: any
    try {
      resourceLoader = new DefaultResourceLoader({
        cwd: agentWorkspace.cwd,
        agentDir: agentWorkspace.agentDir,
        agentsFilesOverride: (base: { agentsFiles: Array<{ path: string; content: string }> }) => ({
          agentsFiles: base.agentsFiles.filter((file) => file.path !== agentWorkspace.legacyAgentsMd),
        }),
        systemPromptOverride: (baseSystemPrompt?: string) => {
          if (options.systemPrompt !== undefined) return options.systemPrompt
          return baseSystemPrompt?.trim() || DEFAULT_CHAT_SYSTEM_PROMPT
        },
      })
      await resourceLoader.reload()
    } catch (err) {
      console.error('[PiService] ResourceLoader error:', err)
      yield { type: 'error', message: `ResourceLoader init failed: ${(err as Error).message}` }
      yield { type: 'done' }
      return
    }

    // Resolve session manager: reopen existing persistent session or create new one.
    const sessionManager = await this.resolveSessionManager(
      options.conversationId,
      options.branchId,
      agentWorkspace.cwd
    )

    let session: any
    try {
      const result = await createAgentSession({
        sessionManager,
        modelRuntime: this.modelRuntime,
        ...(model ? { model } : {}),
        customTools: enabledTools,
        resourceLoader,
      })
      session = result.session
    } catch (err) {
      console.error('[PiService] createAgentSession error:', err)
      yield { type: 'error', message: `Session creation failed: ${(err as Error).message}` }
      yield { type: 'done' }
      return
    }

    // Apply reasoning effort / thinking level. Always set it explicitly so
    // Pi's default or a reopened session's previous level (often `medium`) does
    // not override the chat box selector. `off` is a real user choice.
    const effort = options.reasoningEffort || 'off'
    session.setThinkingLevel(effort)

    let unregisterAbortHandler: (() => void) | null = null

    try {
      const queue: ChatEvent[] = []
      let resolve: (() => void) | null = null

      const push = (event: ChatEvent) => {
        queue.push(event)
        if (resolve) { resolve(); resolve = null }
      }
      emitInteractionEvent = push

      if (options._cancelled) {
        unregisterAbortHandler = chatStreamControl.registerAbortHandler(options._cancelled, () => {
          session.abort()
          if (resolve) { resolve(); resolve = null }
        })
      }

      // Bind a Web/RPC-style UI context so Pi extensions using ctx.ui.confirm/select/input/notify
      // can interact through YARC instead of failing with no_ui. ctx.ui.custom remains degraded.
      try {
        await session.bindExtensions?.({
          uiContext: this.createWebUIContext({
            conversationId: options.conversationId,
            streamMessageId: options.assistantMessageId,
            emit: push,
          }),
          mode: 'rpc',
          onError: (err: any) => console.warn('[PiService] extension error:', err),
        })
      } catch (err) {
        console.warn('[PiService] Web UIContext binding failed:', err)
      }

      // Emit session state so frontend can display current model/thinking
      try {
        const available = await this.filterByEnabledModels(await this.modelRuntime?.getAvailable() || [])
        push({
          type: 'session_state',
          model: session.model?.id || '',
          thinkingLevel: session.thinkingLevel || 'off',
          models: (available || []).map((m: any) => ({ id: m.id, name: m.name, reasoning: m.reasoning })),
        })
      } catch { /* ignore */ }

      const toolContext = new Map<string, { name: string; args: any }>()
      let agentEnded = false
      const pushContextUsage = () => {
        try {
          const usage = session.getContextUsage?.()
          const contextWindow = Number(usage?.contextWindow ?? session.model?.contextWindow ?? 0)
          const tokens = usage?.tokens ?? null
          push({
            type: 'context_usage',
            tokens,
            contextWindow,
            percent: usage?.percent ?? (contextWindow > 0 && tokens !== null ? (tokens / contextWindow) * 100 : null),
            model: session.model?.id,
          })
        } catch { /* non-fatal */ }
      }

      const unsubscribe = session.subscribe((event: any) => {
        if (event.type === 'message_update') {
          const update = event.assistantMessageEvent
          if (update?.type === 'text_delta' && update.delta) {
            push({ type: 'text', content: String(update.delta) })
          } else if (update?.type === 'thinking_delta' && update.delta) {
            push({ type: 'thinking', content: String(update.delta) })
          } else if (update?.type === 'toolcall_delta' && update.delta) {
            // Pi AI exposes provider tool-input streaming as toolcall_delta.
            // Forward it before tool_execution_start so long write calls are
            // visible while the model is still generating their arguments.
            const block = update.partial?.content?.[update.contentIndex]
            const toolCallId = String(block?.type === 'toolCall' ? block.id : '')
              || `${options.assistantMessageId || 'tool'}:${update.contentIndex}`
            const toolName = block?.type === 'toolCall' ? String(block.name || '') : undefined
            push({
              type: 'tool_call_delta',
              toolCallId,
              ...(toolName ? { toolName } : {}),
              inputDelta: String(update.delta),
            })
          } else if (update?.type === 'error') {
            push({ type: 'error', message: update.error?.errorMessage || 'Pi error' })
          }
        } else if (event.type === 'tool_execution_start') {
          const toolCallId = String(event.toolCallId || '')
          const toolName = String(event.toolName || 'tool')
          const args = event.args || {}
          toolContext.set(toolCallId, { name: toolName, args })
          this.emitAgentToolEvent('started', toolName, args, undefined, false)
          push({
            type: 'tool_call',
            toolCallId,
            toolName,
            input: JSON.stringify(args),
          })
          pushContextUsage()
        } else if (event.type === 'tool_execution_end') {
          const toolCallId = String(event.toolCallId || '')
          const ctx = toolContext.get(toolCallId)
          push({
            type: 'tool_result',
            toolCallId,
            result: this.formatToolResult(event.result, event.isError),
          })
          pushContextUsage()
          if (ctx) this.emitAgentToolEvent(event.isError ? 'failed' : 'completed', ctx.name, ctx.args, event.result, !!event.isError)
          if (ctx?.name === 'yarc_search_papers' && !event.isError) {
            const details = event.result?.details || {}
            if (Array.isArray(details.papers)) {
              push({
                type: 'search_results',
                query: String(details.query || ctx.args?.query || ''),
                source: details.source || ctx.args?.source || 'semantic_scholar',
                field: details.field || ctx.args?.field || 'all',
                page: Number(details.page || ctx.args?.page || 1),
                limit: Number(details.limit || ctx.args?.limit || details.papers.length || 20),
                total: Number(details.total || details.papers.length || 0),
                totalPages: Number(details.totalPages || 0),
                hasNextPage: Boolean(details.hasNextPage || false),
                nextPage: details.nextPage ?? null,
                papers: details.papers,
                earlyAccess: Boolean(details.earlyAccess || ctx.args?.earlyAccess || false),
                publication: details.publication || ctx.args?.publication,
              })
            }
          }
        } else if (event.type === 'agent_end') {
          agentEnded = true
          push({ type: 'done' })
        } else if (event.type === 'message_end') {
          // Phase 2: Track assistant entry ID for Pi ↔ YARC message mapping.
          // After Pi writes the assistant message to the session JSONL,
          // the leaf ID is the assistant entry. Emit a mapping event so the
          // caller can write it to Message.metadata.pi.entryId.
          const msg = event.message
          if (
            msg?.role === 'assistant' &&
            options.conversationId &&
            options.assistantMessageId &&
            session.sessionFile
          ) {
            try {
              const entryId = session.sessionManager?.getLeafId?.()
              if (entryId) {
                push({
                  type: 'pi_assistant_entry',
                  conversationId: options.conversationId,
                  messageId: options.assistantMessageId,
                  entryId,
                  sessionFile: session.sessionFile,
                })
              }
            } catch { /* non-fatal */ }
          }
        }
      })

      // Fire the prompt (non-blocking for the yield loop below).
      // The SDK appends the user message to the session JSONL synchronously
      // at the start of prompt(), so getLeafId() returns the user entry ID
      // immediately after the call begins.
      console.log('[PiService] Sending prompt to agent:', options.prompt.slice(0, 200) + (options.prompt.length > 200 ? '...' : ''))
      const promptPromise = session.prompt(options.prompt)
        .then(() => {
          // Registered extension slash commands may finish without starting an
          // agent turn, so they do not emit agent_end. Close the web stream once
          // the SDK command handler itself has completed.
          if (!agentEnded) push({ type: 'done' })
        })
        .catch((err: Error) => {
          push({ type: 'error', message: err.message })
          push({ type: 'done' })
        })

      // Phase 2: Emit user entry ID mapping right after prompt starts.
      // At this point the SDK has already written the user message to JSONL.
      if (
        options.conversationId &&
        options.userMessageId &&
        session.sessionFile
      ) {
        try {
          const entryId = session.sessionManager?.getLeafId?.()
          if (entryId) {
            push({
              type: 'pi_user_entry',
              conversationId: options.conversationId,
              messageId: options.userMessageId,
              entryId,
              sessionFile: session.sessionFile,
            })
          }
        } catch { /* non-fatal */ }
      }

      // Yield events as they arrive
      while (true) {
        // Check for cancellation at the start of each loop iteration
        if (options._cancelled && chatStreamControl.isCancelled(options._cancelled)) {
          session.abort()
          unregisterAbortHandler?.()
          unregisterAbortHandler = null
          unsubscribe()
          await promptPromise
          return
        }

        if (queue.length === 0) {
          await new Promise<void>(r => { resolve = r })
        }
        while (queue.length > 0) {
          const evt = queue.shift()!
          yield evt
          if (evt.type === 'done') {
            unregisterAbortHandler?.()
            unregisterAbortHandler = null
            unsubscribe()
            await promptPromise
            return
          }
        }
      }
    } finally {
      // Persist the Pi session file path so the next turn reopens this session.
      if (options.conversationId && options.branchId) {
        await this.savePiSessionInfo(options.conversationId, options.branchId, session)
      }
      unregisterAbortHandler?.()
      agentInteractionRegistry.cancelByStream(options.assistantMessageId || '', 'session_disposed')
      emitInteractionEvent = null
      await session.dispose()
    }
  }

  private filterChatTools(tools: any[]) {
    const setting = config.piChatTools.trim()
    if (!setting || setting === 'all') return tools
    if (setting === 'none') return []

    const allowed = new Set(
      setting
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean)
    )
    return tools.filter((tool: any) => allowed.has(tool.name))
  }

  private emitAgentToolEvent(
    status: 'started' | 'completed' | 'failed',
    toolName: string,
    args: any,
    result?: any,
    isError?: boolean
  ) {
    if (!toolName.startsWith('yarc_')) return

    const details = result?.details || {}
    const message = status === 'started'
      ? `${toolName} started`
      : this.formatToolResult(result, isError).slice(0, 600)
    const paperId = details.paper?.id || details.note?.paperId || details.papers?.[0]?.id || details.changedPaperIds?.[0] || args?.paperId || args?.paperIds?.[0]

    sseHub.emit({
      type: 'agent-action',
      status,
      toolName,
      paperId,
      message,
      at: new Date().toISOString(),
    })

    if (status !== 'completed' || isError) return

    // yarc_search_papers
    if (toolName === 'yarc_search_papers' && Array.isArray(details.papers)) {
      sseHub.emit({
        type: 'search-results',
        query: String(details.query || args?.query || ''),
        source: details.source || args?.source || 'semantic_scholar',
        field: details.field || args?.field || 'all',
        page: Number(details.page || args?.page || 1),
        limit: Number(details.limit || args?.limit || details.papers.length || 20),
        total: Number(details.total || details.papers.length || 0),
        totalPages: Number(details.totalPages || 0),
        hasNextPage: Boolean(details.hasNextPage || false),
        nextPage: details.nextPage ?? null,
        papers: details.papers,
        at: new Date().toISOString(),
      })
      return
    }

    // yarc_categories
    if (toolName === 'yarc_categories') {
      const categoryType = details.type || args?.type || 'library'
      const action = args?.action || 'unknown'

      if (categoryType === 'search') {
        sseHub.emit({
          type: 'search-categories-changed',
          toolName,
          action,
          categoryId: details.category?.id || details.categoryId || details.categoryIds?.[0] || args?.categoryId || args?.id,
          at: new Date().toISOString(),
        })
      } else {
        sseHub.emit({ type: 'categories-changed', toolName, action, at: new Date().toISOString() })
        sseHub.emit({ type: 'library-changed', toolName, at: new Date().toISOString() })
      }
      return
    }

    // yarc_papers
    if (toolName === 'yarc_papers') {
      const paperType = details.type || args?.type || 'library'
      const action = args?.action || 'unknown'

      if (action === 'save') {
        if (paperType === 'search') {
          sseHub.emit({
            type: 'search-categories-changed',
            toolName,
            categoryId: details.categoryId || args?.categoryId,
            at: new Date().toISOString(),
          })
        } else {
          const paperIds = details.papers?.map((p: any) => p.id).filter(Boolean) || []
          sseHub.emit({ type: 'library-changed', toolName, paperIds, at: new Date().toISOString() })
          sseHub.emit({ type: 'categories-changed', toolName, at: new Date().toISOString() })
        }
      } else if (action === 'classify' || action === 'update') {
        const paperIds = details.paperIds || args?.paperIds || []
        sseHub.emit({ type: 'library-changed', toolName, paperIds, at: new Date().toISOString() })
        sseHub.emit({ type: 'categories-changed', toolName, at: new Date().toISOString() })
      } else if (action === 'delete') {
        const paperIds = details.paperIds || args?.paperIds || []
        if (paperType === 'search') {
          sseHub.emit({
            type: 'search-categories-changed',
            toolName,
            categoryId: args?.categoryId,
            at: new Date().toISOString(),
          })
        } else {
          sseHub.emit({ type: 'library-changed', toolName, paperIds, at: new Date().toISOString() })
        }
      }
      return
    }

    // yarc_notes
    if (toolName === 'yarc_notes') {
      const action = args?.action || 'unknown'
      if (action === 'sync') {
        const changedPaperIds = Array.isArray(details.changedPaperIds) ? details.changedPaperIds : []
        for (const changedPaperId of changedPaperIds) {
          sseHub.emit({
            type: 'notes-changed',
            toolName,
            action,
            paperId: changedPaperId,
            noteIds: Array.isArray(details.items)
              ? details.items.filter((item: any) => item.paperId === changedPaperId && item.status === 'synced').map((item: any) => item.noteId)
              : [],
            at: new Date().toISOString(),
          })
        }
        return
      }

      const noteIds = details.notes?.map((n: any) => n.id).filter(Boolean) || details.noteIds || args?.noteIds || []
      const paperIdFromNotes = details.notes?.[0]?.paperId || args?.paperId

      sseHub.emit({
        type: 'notes-changed',
        toolName,
        action,
        paperId: paperIdFromNotes,
        noteIds,
        at: new Date().toISOString(),
      })
      return
    }
  }

  private formatToolResult(result: any, isError?: boolean): string {
    if (typeof result === 'string') return result.slice(0, 4000)
    const content = Array.isArray(result?.content)
      ? result.content.map((item: any) => (item?.type === 'text' ? item.text : '')).filter(Boolean).join('\n')
      : ''
    if (content) return content.slice(0, 4000)
    const text = JSON.stringify(result ?? { isError: !!isError })
    return text.length > 4000 ? `${text.slice(0, 4000)}…` : text
  }

  /**
   * Return the Pi runtime's advertised thinking levels for the settings UI.
   *
   * Pi does not expose a standalone runtime constant for these levels; model
   * metadata is its public capability source. The YARC defaults make a new
   * custom model immediately configurable with the usual five controls, while
   * runtime-advertised levels such as `minimal` and `max` are added dynamically.
   */
  async listThinkingLevels(): Promise<{ levels: string[]; defaultLevels: string[] }> {
    try {
      await this.initPi()
      const models = this.modelRuntime ? await this.modelRuntime.getAvailable() : []
      const runtimeLevels = models.flatMap((model: any) => Object.keys(model.thinkingLevelMap || {}))
      return {
        // Pi 0.83 exposes this canonical set through its SDK model metadata;
        // include all current levels so a custom model can opt into `max` even
        // before another configured model advertises it.
        levels: orderThinkingLevels([...PI_THINKING_LEVEL_ORDER, ...runtimeLevels]),
        defaultLevels: [...DEFAULT_THINKING_LEVELS],
      }
    } catch (err) {
      console.warn('[PiService] Failed to read Pi thinking levels:', err)
      return { levels: [...PI_THINKING_LEVEL_ORDER], defaultLevels: [...DEFAULT_THINKING_LEVELS] }
    }
  }

  async listModels(force = false): Promise<any> {
    try {
      await this.initPi()
      if (force) {
        await this.modelRuntime?.refresh({ allowNetwork: true, force: true })
      }
    } catch (err) {
      console.error('[PiService] listModels reload/init failed:', err)
    }

    if (!this.modelRuntime) {
      return { models: [], source: 'unavailable' }
    }

    try {
      const allModels = await this.modelRuntime.getAvailable()
      const enabledModels = await this.filterByEnabledModels(allModels)
      const models = enabledModels
        .map((m: any) => ({
          id: m.id,
          name: m.name || m.id,
          provider: m.provider,
          reasoning: m.reasoning ?? false,
          contextWindow: m.contextWindow,
          maxTokens: m.maxTokens,
          cost: m.cost,
          // Pi uses null to mean hidden/unsupported. YARC starts with its
          // five default controls and adds explicitly mapped Pi levels (such
          // as `minimal` or `max`), independent of JSON insertion order.
          thinkingLevels: m.reasoning
            ? orderThinkingLevels([
              ...DEFAULT_THINKING_LEVELS.filter(level => m.thinkingLevelMap?.[level] !== null),
              ...Object.entries(m.thinkingLevelMap || {})
                .filter(([, value]) => value !== null)
                .map(([level]) => level),
            ])
            : undefined,
        }))
        .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))

      return {
        models,
        source: 'pi',
      }
    } catch (err) {
      console.warn('[PiService] Failed to list models:', err)
      return { models: [], source: 'error' }
    }
  }

  async *complete(options: any): AsyncGenerator<string> {
    for await (const event of this.completeEvents(options)) {
      if (event.type === 'text') yield event.content || ''
    }
  }
}

export const piService = new PiService()
