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
    const { content, model, reasoning_effort, context } = request
    const branchId = (request as any).branchId as string | undefined
    const userMessageId = (request as any).userMessageId as string | undefined
    const assistantMessageId = (request as any).assistantMessageId as string | undefined

    if (options.persistUserMessage !== false) {
      await this.handleEditBranch(conversationId, request)
    }

    try {
      const compactCommand = this.parseCompactCommand(content)
      if (compactCommand) {
        yield* piService.compactEvents({
          conversationId,
          branchId: branchId || 'main',
          assistantMessageId,
          model,
          reasoningEffort: reasoning_effort,
          customInstructions: compactCommand.customInstructions,
          _cancelled: options.cancelledMessageId,
        })
        return
      }

      // Build context block and collect stored context for message metadata.
      const { contextBlock } = yield* this.buildContextBlock(content, context, conversationId)

      // Build the final user message: [context] block + pure user message.
      // Pi session already has the full conversation history (messages, tool calls,
      // tool results, compaction) via SessionManager.open(sessionFile), so we
      // only send the current user message.
      const userMessage = this.buildUserMessage(content, contextBlock)

      // Store context as CustomEntry in Pi session
      if (context && branchId) {
        await piConversationService.appendContextEntry(conversationId, branchId, context)
      }

      yield* this.callAI(userMessage, model, reasoning_effort, conversationId, branchId, userMessageId, assistantMessageId, options.cancelledMessageId)
    } catch (err) {
      yield {
        type: 'error',
        message: `Pi 对话调用失败：${(err as Error).message || '未知错误'}`,
      }
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

    // Resolve paperId: prefer explicit context, fall back to conversation's bound paperId.
    const paperId = context?.paperId || (conversationId
      ? (await prisma.conversation.findUnique({ where: { id: conversationId }, select: { paperId: true } }))?.paperId || undefined
      : undefined)

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
    const fileRefs: string[] = []
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
