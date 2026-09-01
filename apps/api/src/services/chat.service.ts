import { randomUUID } from 'node:crypto'
import { prisma } from '@yarc/db'
import { conversationService } from './conversation.service.js'
import { piConversationService } from './pi-conversation.service.js'
import { searchService } from './search.service.js'
import { embeddingService } from './embedding.service.js'
import { piService } from './pi.service.js'
import { ensureAgentWorkspace } from '../lib/agent-workspace.js'
import type { ChatRequest, ChatEvent } from '@yarc/shared'

interface ChatContext {
  paperId?: string
  pageNumber?: number
  selectedText?: string
  temporaryPdf?: boolean
  documentTitle?: string
  currentResource?:
    | { type: 'paper'; paperId: string; title: string }
    | { type: 'file'; path: string; name?: string }
}

interface StoredContext {
  paper?: { id: string; title: string; authors: string[]; year?: number | null; doi?: string | null; abstract?: string | null; summary?: string | null }
  page?: number
  selected?: string
  searchSnippets?: Array<{ page: number | null; text: string }>
  fileRefs?: string[]
}

export class ChatService {
  /**
   * Prepare message context for a chat request.
   * Note: With Pi as single source, we no longer persist to PostgreSQL messages table.
   * Pi SDK handles message persistence in JSONL.
   */
  async handleEditBranch(conversationId: string, request: ChatRequest) {
    const { model, context, editMessageId } = request as ChatRequest & { branchId?: string }

    if (model) await conversationService.updateModel(conversationId, model)

    if (editMessageId) {
      // For edit messages, create a new branch via PiConversationService
      const branchId = request.branchId || 'main'
      const result = await piConversationService.createBranchFromEdit(
        conversationId,
        branchId,
        editMessageId,
        request.content,
        context || undefined,
        (request as any).editForkMessageId
      )
      ;(request as any).branchId = result.branchId
      return { branchId: result.branchId, entryId: null, piParentEntryId: result.forkEntryId }
    }

    // For new messages, just return the branch info
    // Pi will handle persistence when we call completeEvents
    return { branchId: request.branchId || 'main', entryId: null, piParentEntryId: null }
  }

  // Process a chat message and yield events.
  async *processMessage(
    conversationId: string,
    request: ChatRequest,
    options: { persistUserMessage?: boolean; cancelledMessageId?: string } = {}
  ): AsyncGenerator<ChatEvent> {
    const { content, model, reasoning_effort, thinking_enabled, context } = request
    let branchId = (request as any).branchId as string | undefined
    const userMessageId = (request as any).userMessageId as string | undefined
    const assistantMessageId = (request as any).assistantMessageId as string | undefined

    if (options.persistUserMessage !== false) {
      const prepared = await this.handleEditBranch(conversationId, request)
      branchId = prepared.branchId
    }

    let persistPreflightFailure = false
    let failedPrompt = content
    try {
      const compactCommand = this.parseCompactCommand(content)
      if (compactCommand) {
        yield* piService.compactEvents({
          conversationId,
          branchId: branchId || 'main',
          assistantMessageId,
          model,
          reasoningEffort: reasoning_effort,
          thinkingEnabled: thinking_enabled,
          customInstructions: compactCommand.customInstructions,
          _cancelled: options.cancelledMessageId,
        })
        return
      }

      persistPreflightFailure = true

      // Build context block and collect stored context for message metadata.
      const { contextBlock } = yield* this.buildContextBlock(content, context, conversationId)

      // Build the final user message: [context] block + pure user message.
      // Pi session already has the full conversation history (messages, tool calls,
      // tool results, compaction) via SessionManager.open(sessionFile), so we
      // only send the current user message.
      const userMessage = this.buildUserMessage(content, contextBlock)
      failedPrompt = userMessage

      // The context block is part of the canonical user message. Do not append
      // a second out-of-band SessionManager entry here: long-lived Runtime
      // Workers own the active Session tree, and external JSONL mutation would
      // leave their in-memory leaf stale.

      // Keep the fallback armed while entering PiService too. Its setup can
      // still throw before it obtains a SessionManager; the persistence helper
      // is idempotent when Pi already wrote part or all of the turn.
      yield* this.callAI(userMessage, model, reasoning_effort, thinking_enabled, conversationId, branchId, userMessageId, assistantMessageId, options.cancelledMessageId)
    } catch (err) {
      const message = `Pi 对话调用失败：${(err as Error).message || '未知错误'}`
      if (persistPreflightFailure) {
        await piService.persistFailedTurn({
          conversationId,
          branchId: branchId || 'main',
          prompt: failedPrompt,
          errorMessage: message,
          model,
        })
      }
      yield { type: 'error', message }
      yield { type: 'done' }
    }
  }

  /**
   * Build a [context]...[/context] block from the current request context.
   * Also emits tool_call/tool_result events for search operations.
   * Returns both the text block and the structured context for metadata storage.
   */
  private async *buildContextBlock(
    userContent: string,
    context?: ChatContext,
    conversationId?: string
  ): AsyncGenerator<ChatEvent, { contextBlock: string; storedContext: StoredContext }> {
    // Ensure agent workspace is initialized (already done at startup, this is just a safety check).
    await ensureAgentWorkspace()

    const lines: string[] = []
    const stored: StoredContext = {}

    // A temporary reader must never inherit a paper bound to the selected
    // conversation: it has no local paper record, only selected PDF text.
    const paperId = context?.temporaryPdf
      ? undefined
      : context?.paperId || (conversationId
        ? (await prisma.conversation.findUnique({ where: { id: conversationId }, select: { paperId: true } }))?.paperId || undefined
        : undefined)

    if (context?.temporaryPdf) {
      lines.push(`temporary_pdf: ${context.documentTitle || '未入库的临时 PDF'}`)
      if (context.pageNumber) {
        stored.page = context.pageNumber
        lines.push(`page: ${context.pageNumber}`)
      }
      if (context.selectedText) {
        stored.selected = context.selectedText
        lines.push(`selected: "${context.selectedText}"`)
      }
    }

    if (paperId) {
      const contextToolId = randomUUID()
      yield {
        type: 'tool_call',
        toolCallId: contextToolId,
        toolName: 'get_paper_context',
        input: JSON.stringify({ paperId, pageNumber: context?.pageNumber || null }),
      }

      const paper = await prisma.paper.findUnique({
        where: { id: paperId },
        select: { title: true, authors: true, abstract: true, summary: true, doi: true, year: true },
      })

      if (paper) {
        stored.paper = { id: paperId, title: paper.title, authors: paper.authors, year: paper.year, doi: paper.doi, abstract: paper.abstract, summary: paper.summary }
        lines.push(`paper: ${paper.title} (id: ${paperId})`)
      }

      if (context?.pageNumber) {
        stored.page = context.pageNumber
        lines.push(`page: ${context.pageNumber}`)
      }

      if (context?.selectedText) {
        stored.selected = context.selectedText
        lines.push(`selected: "${context.selectedText}"`)
      }

      yield {
        type: 'tool_result',
        toolCallId: contextToolId,
        result: paper
          ? `已读取论文上下文：${paper.title}${paper.doi ? `，DOI ${paper.doi}` : ''}`
          : '未找到当前论文记录。',
      }

      // Search for relevant chunks when embeddings are available. This is best-effort.
      const searchToolId = randomUUID()
      yield {
        type: 'tool_call',
        toolCallId: searchToolId,
        toolName: 'search_local_pdf',
        input: JSON.stringify({ query: context?.selectedText || userContent, paperId, topK: 5 }),
      }

      try {
        const queryText = context?.selectedText || userContent
        const embedding = await embeddingService.generate(queryText)
        const results = (await searchService.searchLocal(queryText, embedding, 8, 0.3, paperId))
          .slice(0, 5)

        if (results.length > 0) {
          stored.searchSnippets = results.map((r: any) => ({ page: r.pageNumber || null, text: r.snippet.slice(0, 280) }))
          for (const r of stored.searchSnippets) {
            lines.push(`search: [第${r.page || '?'}页] ${r.text}`)
          }
        }

        yield {
          type: 'tool_result',
          toolCallId: searchToolId,
          result: results.length ? `找到 ${results.length} 个本地相关片段。` : '没有找到可用的本地向量片段。',
        }
        if (results.length > 0) {
          for (const r of results) {
            if (r.pageNumber) yield { type: 'citation', pageNumber: r.pageNumber, text: r.snippet.slice(0, 180) }
          }
        }
      } catch (err) {
        yield {
          type: 'tool_result',
          toolCallId: searchToolId,
          result: `本地检索未运行：${(err as Error).message || '向量服务不可用或论文尚未解析'}`,
        }
      }
    }

    // @current is a request-scoped alias resolved by the frontend at send time.
    // It behaves like @paper for a library paper and @file for a workspace file.
    let currentFileRef: string | null = null
    if (/@current\b/i.test(userContent)) {
      const current = context?.currentResource
      if (!current) throw new Error('使用 @current 时没有提供当前文件或文献库论文上下文')

      if (current.type === 'paper') {
        const paper = await prisma.paper.findUnique({
          where: { id: current.paperId },
          select: { id: true, title: true, authors: true, year: true, doi: true },
        })
        if (!paper) throw new Error(`@current 引用的论文不存在：${current.title || current.paperId}`)
        lines.push(`current_ref: paper ${paper.title} (id: ${paper.id}, ${paper.authors.slice(0, 2).join(', ')}${paper.year ? `, ${paper.year}` : ''}${paper.doi ? `, DOI ${paper.doi}` : ''})`)
      } else {
        currentFileRef = current.path.trim()
        if (!currentFileRef) throw new Error('@current 引用的文件路径为空')
        lines.push(`current_ref: file ${currentFileRef}`)
      }
    }

    // @paper references — resolve the selected title and inject metadata.
    // The UI inserts `@paper ${title} ` and the user usually continues typing
    // the question after it, so a plain /@paper\s+([^@]+)/ match is too greedy.
    // Match against known titles first so `@paper Long Title 请总结` still works.
    const paperRefTails = [...userContent.matchAll(/@paper\s+([^@]*)/gi)].map(match => match[1])
    if (paperRefTails.length) {
      const papers = await prisma.paper.findMany({
        select: { id: true, title: true, authors: true, year: true, doi: true },
      })
      const usedPaperIds = new Set<string>()
      for (const tail of paperRefTails) {
        const matched = this.matchMentionTail(tail, papers, paper => paper.title)
        if (!matched || usedPaperIds.has(matched.id)) continue
        usedPaperIds.add(matched.id)
        lines.push(`ref_paper: ${matched.title} (id: ${matched.id}, ${matched.authors.slice(0, 2).join(', ')}${matched.year ? `, ${matched.year}` : ''}${matched.doi ? `, DOI ${matched.doi}` : ''})`)
      }
    }

    // @file references — inject file paths only; Pi can decide whether to read them.
    const fileRefs: string[] = currentFileRef ? [currentFileRef] : []
    for (const match of userContent.matchAll(/@file\s+([^@\s]+)/gi)) fileRefs.push(match[1])
    const readMatch = userContent.match(/^\s*\/read\s+([^\s]+)/i)
    if (readMatch?.[1]) fileRefs.push(readMatch[1])
    if (fileRefs.length) {
      stored.fileRefs = fileRefs
      for (const path of [...new Set(fileRefs)]) {
        lines.push(`file: ${path}`)
      }
    }

    // @category references — inject category metadata only. Resolve against known
    // names so text after the mention does not become part of the category name.
    const categoryRefTails = [...userContent.matchAll(/@category\s+([^@]*)/gi)].map(match => match[1])
    if (categoryRefTails.length) {
      const categories = await prisma.category.findMany({ select: { id: true, name: true } })
      const usedCategoryIds = new Set<string>()
      for (const tail of categoryRefTails) {
        const category = this.matchMentionTail(tail, categories, cat => cat.name)
        if (!category || usedCategoryIds.has(category.id)) continue
        usedCategoryIds.add(category.id)
        lines.push(`category: ${category.name} (id: ${category.id})`)
      }
    }

    const contextBlock = lines.length ? lines.join('\n') : ''
    console.log('[ChatService] Built context block:', contextBlock.slice(0, 300) || '(empty)')
    return { contextBlock, storedContext: stored }
  }

  private matchMentionTail<T>(tail: string, candidates: T[], getName: (item: T) => string): T | null {
    const normalizedTail = this.normalizeMentionText(tail)
    if (!normalizedTail) return null

    let best: { item: T; length: number } | null = null
    for (const item of candidates) {
      const name = getName(item).trim()
      const normalizedName = this.normalizeMentionText(name)
      if (!normalizedName) continue
      if (
        normalizedTail === normalizedName ||
        normalizedTail.startsWith(`${normalizedName} `) ||
        normalizedTail.startsWith(`${normalizedName}\n`)
      ) {
        if (!best || normalizedName.length > best.length) best = { item, length: normalizedName.length }
      }
    }
    if (best) return best.item

    // Fallback for manually typed short mentions such as `@paper transformer`.
    for (const item of candidates) {
      const normalizedName = this.normalizeMentionText(getName(item))
      if (normalizedName.includes(normalizedTail)) return item
    }
    return null
  }

  private normalizeMentionText(value: string): string {
    return value
      .trim()
      .replace(/\s+/g, ' ')
      .toLowerCase()
  }

  private parseCompactCommand(content: string): { customInstructions?: string } | null {
    const match = content.match(/^\s*\/compact(?:\s+([\s\S]*?))?\s*$/i)
    if (!match) return null
    const customInstructions = match[1]?.trim()
    return customInstructions ? { customInstructions } : {}
  }

  /**
   * Build the final prompt to send to Pi.
   * Context is prepended to the last user message; history messages are pure text.
   */
  private buildUserMessage(lastUserContent: string, contextBlock: string): string {
    if (!contextBlock) return lastUserContent
    return `[context]\n${contextBlock}\n[/context]\n\n${lastUserContent}`
  }

  private async *callAI(
    userMessage: string,
    model?: string,
    reasoningEffort?: string,
    thinkingEnabled?: boolean,
    conversationId?: string,
    branchId?: string,
    userMessageId?: string,
    assistantMessageId?: string,
    cancelledMessageId?: string
  ): AsyncGenerator<ChatEvent> {
    let emittedText = false
    let emittedError = false

    // Pi session already has full conversation history (messages, tool calls,
    // tool results, compaction) via its persistent SessionManager. We only
    // send the current user message; Pi rebuilds the rest internally.
    for await (const event of piService.completeEvents({
      conversationId,
      branchId,
      userMessageId,
      assistantMessageId,
      model,
      prompt: userMessage,
      reasoningEffort,
      thinkingEnabled,
      _cancelled: cancelledMessageId,
    })) {
      if (event.type === 'text') emittedText = true
      if (event.type === 'error') emittedError = true
      yield event
    }

    if (!emittedText && !emittedError) {
      yield { type: 'text', content: 'Pi 没有返回内容。' }
    }
    yield { type: 'done' }
  }
}

export const chatService = new ChatService()
