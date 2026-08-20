/**
 * PiConversationService - Pi JSONL 作为唯一数据源的对话服务
 * 
 * 替代 conversationService 的消息读取功能，
 * 从 Pi SessionManager 的 JSONL 文件读取消息。
 */

import { prisma } from '@yarc/db'
import { writeFile } from 'node:fs/promises'
import {
  type SessionEntry,
  type SessionMessageEntry,
  type CompactionEntry,
  SessionManager,
} from '@earendil-works/pi-coding-agent'
import { getAllPiSessionMetadata } from '../lib/pi-metadata.js'

// Types from pi-ai (re-defined locally to avoid import issues)
type StopReason = 'stop' | 'length' | 'toolUse' | 'error' | 'aborted' | 'pending'

// ── Types ────────────────────────────────────────────────────────────────────

export interface ConversationMessage {
  id: string
  parentId: string | null
  role: 'user' | 'assistant' | 'system' | 'toolResult'
  content: string
  thinking?: string
  toolCalls?: Array<{
    id: string
    name: string
    input: Record<string, any>
    result?: string
    isError?: boolean
    searchResults?: Record<string, unknown>
  }>
  segments?: Array<{
    type: 'text' | 'tool' | 'error' | 'thinking' | 'compaction'
    text?: string
    toolCallId?: string
  }>
  context?: {
    paperId?: string
    pageNumber?: number
    selectedText?: string
    temporaryPdf?: boolean
    documentTitle?: string
    currentResource?:
      | { type: 'paper'; paperId: string; title: string }
      | { type: 'file'; path: string; name?: string }
    injected?: Array<{ type: 'paper' | 'file' | 'category' | 'search' | 'other'; label: string; detail?: string }>
    raw?: string
  }
  forkFromMessageId?: string
  // Pi 独有元数据
  model?: string
  provider?: string
  usage?: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    totalTokens: number
    cost: {
      input: number
      output: number
      cacheRead: number
      cacheWrite: number
      total: number
    }
  }
  stopReason?: StopReason
  responseId?: string
  errorMessage?: string
  // 状态标记
  isCompaction?: boolean
  compactionSummary?: string
  isError?: boolean
  timestamp: string
}

export interface BranchInfo {
  id: string
  branchName: string
  parentBranchId: string | null
  forkMessageId: string | null
  sessionFile?: string
  leafEntryId?: string
}

// ── Service ──────────────────────────────────────────────────────────────────

export class PiConversationService {

  // ── Session File Resolution ──────────────────────────────────────────────

  /**
   * Get the session file path for a conversation branch.
   */
  async getSessionFile(conversationId: string, branchId?: string): Promise<string | null> {
    const sessions = await getAllPiSessionMetadata(conversationId)

    if (!sessions || Object.keys(sessions).length === 0) return null

    // If branchId specified, get that branch's session file
    if (branchId && sessions[branchId]?.sessionFile) {
      return sessions[branchId].sessionFile
    }

    // Otherwise, get main branch session file
    const mainSessionFile = await this.getMainBranchSessionFile(conversationId)
    if (mainSessionFile) {
      return mainSessionFile
    }

    // Fallback: return first available session file
    const firstSession = Object.values(sessions)[0] as any
    return firstSession?.sessionFile || null
  }

  /**
   * Get the main branch session file for a conversation.
   */
  private async getMainBranchSessionFile(conversationId: string): Promise<string | null> {
    const sessions = await getAllPiSessionMetadata(conversationId)
    return sessions?.main?.sessionFile || null
  }

  // ── Branch Operations ───────────────────────────────────────────────────

  /**
   * List all branches for a conversation.
   * Returns at least one 'main' branch even if no sessions exist yet.
   */
  async listBranches(conversationId: string): Promise<BranchInfo[]> {
    const sessions = await getAllPiSessionMetadata(conversationId)

    const branches: BranchInfo[] = []

    // Always include main branch
    branches.push({
      id: 'main',
      branchName: 'main',
      parentBranchId: null,
      forkMessageId: null,
      sessionFile: sessions.main?.sessionFile,
      leafEntryId: sessions.main?.leafEntryId || undefined,
    })

    // Add other branches (edit branches)
    for (const [branchId, info] of Object.entries(sessions) as [string, any][]) {
      if (branchId === 'main') continue
      branches.push({
        id: branchId,
        branchName: branchId.startsWith('edit-') ? `edit-${branchId.slice(5, 13)}` : branchId,
        parentBranchId: info.parentBranchId || null,
        forkMessageId: info.forkMessageId || null,
        sessionFile: info.sessionFile,
        leafEntryId: info.leafEntryId || undefined,
      })
    }

    return branches
  }

  /**
   * Get messages for a branch.
   */
  async getBranchMessages(conversationId: string, branchId: string): Promise<ConversationMessage[]> {
    const sessionFile = await this.getSessionFile(conversationId, branchId)
    if (!sessionFile) return []

    try {
      const sm = SessionManager.open(sessionFile)
      const branch = sm.getBranch()
      const branchMeta = await this.getBranchMeta(conversationId, branchId)
      return this.entriesToMessages(branch, branchMeta)
    } catch (err) {
      console.error('[PiConversationService] Failed to read branch messages:', err)
      return []
    }
  }

  /**
   * Get messages for a branch, excluding streaming messages.
   */
  async getMessagesForContext(conversationId: string, branchId?: string): Promise<ConversationMessage[]> {
    const branch = branchId
      ? await this.getBranchMessages(conversationId, branchId)
      : await this.getMainBranchMessages(conversationId)

    // Filter out in-progress streaming messages
    return branch.filter((m) => !m.isError || m.content)
  }

  /**
   * Get messages for the main branch.
   */
  async getMainBranchMessages(conversationId: string): Promise<ConversationMessage[]> {
    const mainSessionFile = await this.getMainBranchSessionFile(conversationId)
    if (!mainSessionFile) return []
    
    try {
      const sm = SessionManager.open(mainSessionFile)
      const branch = sm.getBranch()
      return this.entriesToMessages(branch)
    } catch (err) {
      console.error('[PiConversationService] Failed to read main branch messages:', err)
      return []
    }
  }

  /**
   * Switch to a different branch and return its messages.
   */
  async switchBranch(conversationId: string, branchId: string): Promise<ConversationMessage[]> {
    return this.getBranchMessages(conversationId, branchId)
  }

  // ── Branch Creation ─────────────────────────────────────────────────────

  /**
   * Create a new branch by editing a message.
   */
  async createBranchFromEdit(
    conversationId: string,
    sourceBranchId: string,
    editEntryId: string,
    _newContent: string,
    _context?: ConversationMessage['context'],
    forkDisplayMessageId?: string
  ): Promise<{ branchId: string; forkEntryId: string | null; sessionFile: string }> {
    const sessionFile = await this.getSessionFile(conversationId, sourceBranchId)
    if (!sessionFile) throw new Error('Session file not found')

    const sm = SessionManager.open(sessionFile)

    // To edit a user turn, fork from its parent so the original user message
    // and its assistant reply are excluded. Editing the root user is special:
    // there is no parent entry, so create a materialized empty child session.
    const resolvedEditEntryId = editEntryId
    const entry = sm.getEntry(resolvedEditEntryId)
    if (!entry) throw new Error(`Entry not found: ${editEntryId}`)
    if (entry.type !== 'message' || entry.message.role !== 'user') {
      throw new Error(`Only user messages can be edited: ${editEntryId}`)
    }

    const forkEntryId = entry.parentId
    let newSessionFile: string
    if (forkEntryId) {
      const branchedSessionFile = sm.createBranchedSession(forkEntryId)
      if (!branchedSessionFile) throw new Error('Failed to create branch')
      newSessionFile = branchedSessionFile
    } else {
      const rootSession = SessionManager.create(sm.getCwd(), sm.getSessionDir(), {
        parentSession: sessionFile,
      })
      const rootSessionFile = rootSession.getSessionFile()
      const header = rootSession.getHeader()
      if (!rootSessionFile || !header) throw new Error('Failed to create root edit branch')

      // SessionManager defers writing a new file until the first assistant
      // message. Materialize the public header now so PiService can reopen this
      // exact empty session before it appends the edited root prompt.
      await writeFile(rootSessionFile, `${JSON.stringify(header)}\n`, { flag: 'wx' })
      newSessionFile = rootSessionFile
    }

    const newBranchId = `edit-${Date.now()}`
    await this.saveSessionInfo(conversationId, newBranchId, newSessionFile, forkEntryId, {
      parentBranchId: sourceBranchId,
      forkMessageId: forkDisplayMessageId || resolvedEditEntryId,
      forkParentEntryId: forkEntryId,
    })

    return { branchId: newBranchId, forkEntryId, sessionFile: newSessionFile }
  }

  // ── Context Management ──────────────────────────────────────────────────

  /**
   * Append context entry to a session.
   */
  async appendContextEntry(
    conversationId: string,
    branchId: string,
    context: ConversationMessage['context']
  ): Promise<void> {
    const sessionFile = await this.getSessionFile(conversationId, branchId)
    if (!sessionFile) return

    const sm = SessionManager.open(sessionFile)
    sm.appendCustomEntry('yarc-context', context)
  }

  // ── Session Info Management ─────────────────────────────────────────────

  /**
   * Save session info to conversations metadata.
   */
  async saveSessionInfo(
    conversationId: string,
    branchId: string,
    sessionFile: string,
    leafEntryId?: string | null,
    branchMeta: { parentBranchId?: string | null; forkMessageId?: string | null; forkParentEntryId?: string | null } = {}
  ): Promise<void> {
    const conv = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { metadata: true },
    })
    const meta = { ...((conv?.metadata || {}) as Record<string, unknown>) } as any
    if (!meta.pi) meta.pi = {}
    if (!meta.pi.sessions) meta.pi.sessions = {}

    meta.pi.sessions[branchId] = {
      sessionFile,
      leafEntryId,
      parentBranchId: branchMeta.parentBranchId ?? meta.pi.sessions[branchId]?.parentBranchId ?? null,
      forkMessageId: branchMeta.forkMessageId ?? meta.pi.sessions[branchId]?.forkMessageId ?? null,
      forkParentEntryId: branchMeta.forkParentEntryId ?? meta.pi.sessions[branchId]?.forkParentEntryId ?? null,
      updatedAt: new Date().toISOString(),
    }

    await prisma.conversation.update({
      where: { id: conversationId },
      data: { metadata: meta as any },
    })
  }

  /**
   * Get the leaf entry ID for a branch.
   */
  async getLeafEntryId(conversationId: string, branchId: string): Promise<string | null> {
    const branchMeta = await this.getBranchMeta(conversationId, branchId)
    return branchMeta?.leafEntryId || null
  }

  private async getBranchMeta(conversationId: string, branchId: string): Promise<any | null> {
    const conv = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { metadata: true },
    })
    const meta = (conv?.metadata || {}) as any
    return meta?.pi?.sessions?.[branchId] || null
  }

  // ── Entry to Message Conversion ─────────────────────────────────────────

  /**
   * Convert session entries to ConversationMessage array.
   */
  private entriesToMessages(entries: SessionEntry[], branchMeta?: any): ConversationMessage[] {
    const messages: ConversationMessage[] = []
    const toolResultMap = new Map<string, { text: string; details?: unknown }>() // toolCallId -> result
    const forkMessageId = typeof branchMeta?.forkMessageId === 'string'
      ? branchMeta.forkMessageId
      : null
    const hasForkParentMetadata = !!branchMeta && Object.prototype.hasOwnProperty.call(branchMeta, 'forkParentEntryId')
    const forkParentEntryId = typeof branchMeta?.forkParentEntryId === 'string'
      ? branchMeta.forkParentEntryId
      : null
    let forkParentSeen = hasForkParentMetadata && forkParentEntryId === null
    let forkMapped = false

    // First pass: collect tool results
    for (const entry of entries) {
      if (entry.type === 'message') {
        const msg = (entry as SessionMessageEntry).message
        if (msg.role === 'toolResult') {
          const toolResult = msg as any
          const resultText = this.extractToolResultContent(toolResult)
          toolResultMap.set(toolResult.toolCallId, { text: resultText, details: toolResult.details })
        }
      }
    }

    // Second pass: convert messages. A yarc-context custom entry may sit
    // between the fork parent and edited user, so map by branch order rather
    // than requiring the user's direct parentId to equal forkParentEntryId.
    for (const entry of entries) {
      const isForkParent = !forkParentSeen && entry.id === forkParentEntryId
      if (isForkParent) forkParentSeen = true

      const message = this.entryToMessage(entry, toolResultMap)
      if (message) {
        if (message.role === 'user' && forkMessageId && forkParentSeen && !isForkParent && !forkMapped) {
          message.forkFromMessageId = forkMessageId
          forkMapped = true
        }
        messages.push(message)
      }
    }

    // Pi keeps provider-error assistant entries from every automatic retry in
    // JSONL even though it removes them from the active agent context. Hide an
    // error when a later assistant exists before the next user; this removes
    // intermediate retry failures and keeps only the final failure when all
    // retries are exhausted.
    return messages.filter((message, index) => {
      if (message.role !== 'assistant' || !message.isError) return true
      for (let next = index + 1; next < messages.length; next++) {
        if (messages[next].role === 'user') break
        if (messages[next].role === 'assistant') return false
      }
      return true
    })
  }

  /**
   * Convert a single entry to ConversationMessage.
   */
  private entryToMessage(
    entry: SessionEntry,
    toolResultMap: Map<string, { text: string; details?: unknown }>
  ): ConversationMessage | null {
    // Handle compaction entries
    if (entry.type === 'compaction') {
      const compaction = entry as CompactionEntry
      return {
        id: entry.id,
        parentId: entry.parentId,
        role: 'system',
        content: '',
        isCompaction: true,
        compactionSummary: compaction.summary,
        segments: [{ type: 'compaction', text: compaction.summary }],
        timestamp: entry.timestamp,
      }
    }

    // Handle custom entries (context)
    if (entry.type === 'custom' && entry.customType === 'yarc-context') {
      // Context is attached to the next message
      return null
    }

    // Handle message entries
    if (entry.type !== 'message') return null

    const msgEntry = entry as SessionMessageEntry
    const msg = msgEntry.message

    // Handle user messages
    if (msg.role === 'user') {
      const userMsg = msg as any
      const content = this.extractUserContent(userMsg)
      const parsed = this.parseInjectedContext(content)
      return {
        id: msgEntry.id,
        parentId: msgEntry.parentId,
        role: 'user',
        content: parsed.content,
        context: parsed.context,
        timestamp: msgEntry.timestamp,
      }
    }

    // Handle assistant messages
    if (msg.role === 'assistant') {
      return this.convertAssistantMessage(msgEntry, toolResultMap)
    }

    // Handle tool result messages (skip, they're attached to assistant messages)
    if (msg.role === 'toolResult') {
      return null
    }

    return null
  }

  /**
   * Convert assistant message to ConversationMessage.
   */
  private convertAssistantMessage(
    msgEntry: SessionMessageEntry,
    toolResultMap: Map<string, { text: string; details?: unknown }>
  ): ConversationMessage {
    const msg = msgEntry.message as any

    let textContent = ''
    let thinkingContent = ''
    const toolCalls: ConversationMessage['toolCalls'] = []
    const segments: ConversationMessage['segments'] = []

    for (const block of msg.content) {
      if (block.type === 'text') {
        textContent += block.text
        segments.push({ type: 'text', text: block.text })
      } else if (block.type === 'thinking') {
        thinkingContent += block.thinking
        segments.push({ type: 'thinking', text: block.thinking })
      } else if (block.type === 'toolCall') {
        const toolCall: NonNullable<ConversationMessage['toolCalls']>[number] = {
          id: block.id,
          name: block.name,
          input: block.arguments,
          result: toolResultMap.get(block.id)?.text,
        }
        if (block.name === 'yarc_search_papers') {
          const details = toolResultMap.get(block.id)?.details as Record<string, any> | undefined
          if ((details?.action === 'search' || !details?.action) && Array.isArray(details?.papers)) toolCall.searchResults = {
            toolCallId: block.id,
            query: String(details.query || block.arguments?.query || ''),
            source: details.source || block.arguments?.source || 'semantic_scholar',
            field: details.field || block.arguments?.field || 'all',
            page: Number(details.page || block.arguments?.page || 1),
            limit: Number(details.limit || block.arguments?.limit || details.papers.length || 20),
            total: Number(details.total || details.papers.length || 0),
            totalPages: Number(details.totalPages || 0),
            hasNextPage: Boolean(details.hasNextPage || false),
            nextPage: details.nextPage ?? null,
            papers: details.papers,
            earlyAccess: Boolean(details.earlyAccess || block.arguments?.earlyAccess || false),
            publication: details.publication || block.arguments?.publication,
          }
        }
        toolCalls.push(toolCall)
        segments.push({ type: 'tool', toolCallId: block.id })
      }
    }

    // Aborted assistant turns are persisted by Pi without always carrying an
    // errorMessage. Keep them visible after a branch reload instead of
    // replacing the live `Request aborted` event with an empty message.
    const errorMessage = msg.errorMessage || (msg.stopReason === 'aborted' ? 'Request aborted' : undefined)
    const isError = msg.stopReason === 'error' || msg.stopReason === 'aborted' || !!errorMessage
    if (isError && errorMessage) {
      segments.push({ type: 'error', text: errorMessage })
    }

    return {
      id: msgEntry.id,
      parentId: msgEntry.parentId,
      role: 'assistant',
      content: textContent,
      thinking: thinkingContent || undefined,
      toolCalls: toolCalls.length ? toolCalls : undefined,
      segments: segments.length ? segments : undefined,
      model: msg.model,
      provider: msg.provider,
      usage: msg.usage,
      stopReason: msg.stopReason,
      responseId: msg.responseId,
      errorMessage,
      isError,
      timestamp: msgEntry.timestamp,
    }
  }

  /**
   * Extract text content from user message.
   */
  private extractUserContent(msg: any): string {
    if (typeof msg.content === 'string') {
      return msg.content
    }
    if (!Array.isArray(msg.content)) return ''
    return msg.content
      .filter((block: any) => block.type === 'text')
      .map((block: any) => block.text || '')
      .join('')
  }

  private parseInjectedContext(content: string): { content: string; context?: ConversationMessage['context'] } {
    const match = content.match(/^\[context\]\n([\s\S]*?)\n\[\/context\]\n*\n?([\s\S]*)$/)
    if (!match) return { content }

    const raw = match[1].trim()
    const injected = raw
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => {
        if (line.startsWith('ref_paper: ')) return { type: 'paper' as const, label: line.replace(/^ref_paper:\s*/, '') }
        if (line.startsWith('file: ')) return { type: 'file' as const, label: line.replace(/^file:\s*/, '') }
        if (line.startsWith('category: ')) return { type: 'category' as const, label: line.replace(/^category:\s*/, '') }
        if (line.startsWith('search: ')) return { type: 'search' as const, label: line.replace(/^search:\s*/, '') }
        return { type: 'other' as const, label: line }
      })

    return {
      content: match[2] || '',
      context: raw ? { injected, raw } : undefined,
    }
  }

  /**
   * Extract tool result content.
   */
  private extractToolResultContent(msg: any): string {
    if (!Array.isArray(msg.content)) return ''
    return msg.content
      .filter((block: any) => block.type === 'text')
      .map((block: any) => block.text || '')
      .join('')
  }
}

// Singleton instance
export const piConversationService = new PiConversationService()
