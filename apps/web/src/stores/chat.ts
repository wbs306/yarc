import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { useApi } from '@/composables/useApi'
import { createClientId } from '@/lib/id'

export interface ChatSegment { type: 'text' | 'tool' | 'error'; text?: string; toolCallId?: string }
export interface Message {
  id: string; conversationId: string; branchId?: string | null; parentId?: string | null
  role: 'user' | 'assistant' | 'system'; content: string; toolCalls: any[] | null
  metadata: Record<string, any> & { segments?: ChatSegment[] }; createdAt: string
}
export interface Conversation { id: string; paperId: string | null; title: string; model: string | null; createdAt: string; updatedAt: string }
export interface ModelInfo { id: string; name: string; provider: string; model?: string; reasoning?: boolean; images?: boolean; contextWindow?: string; maxTokens?: string; thinkingLevels?: string[]; source?: string }
export interface BranchInfo { id: string; branchName: string; parentBranchId: string | null; forkMessageId: string | null }
export type AgentInteractionKind = 'confirm' | 'select' | 'input' | 'questionnaire' | 'notification'
export interface AgentInteractionRequest {
  type: 'agent_interaction_request'
  requestId: string
  conversationId: string
  streamMessageId: string
  kind: AgentInteractionKind
  title?: string
  message?: string
  payload: unknown
  createdAt: string
  timeoutMs?: number
}
export interface AgentInteractionResponse {
  requestId: string
  action: 'submit' | 'cancel' | 'chat'
  value?: unknown
}
export interface BtwItem {
  id: string
  runId?: string
  conversationId: string
  branchId: string | null
  question: string
  answer: string
  thinking?: string
  loading: boolean
  error?: string
  cancelled?: boolean
  createdAt: string
}
export interface ContextUsageInfo { tokens: number | null; contextWindow: number; percent: number | null; model?: string }

const MODEL_KEY = 'yarc-current-model'
const EFFORT_KEY = 'yarc-reasoning-effort'
const BRANCH_KEY = 'yarc-conv-branches'

export const useChatStore = defineStore('chat', () => {
  const api = useApi()

  // Core
  const conversations = ref<Conversation[]>([])
  const currentConvId = ref<string | null>(null)
  const models = ref<ModelInfo[]>([])
  const currentModel = ref(localStorage.getItem(MODEL_KEY) || '')
  const reasoningEffort = ref(localStorage.getItem(EFFORT_KEY) || 'off')
  const modelsError = ref('')
  const chatError = ref('')
  const pendingPrompt = ref('')
  const currentContextUsage = ref<ContextUsageInfo | null>(null)

  // Branches
  const branches = ref<BranchInfo[]>([])
  const currentBranchId = ref<string | null>(null)
  const branchCache = ref<Map<string, Message[]>>(new Map())
  const convBranchPrefs = new Map<string, string>()

  // Streaming
  const isStreaming = ref(false)
  const streamingConvId = ref<string | null>(null)
  const streamingMessageId = ref('')
  const streamingContent = ref('')
  const activeStreams = new Map<string, string>()
  const abortControllers = new Map<string, AbortController>()
  const textQueues = new Map<string, { buf: string; timer: number | null }>()
  const streamReconnectTimers = new Map<string, number>()

  // PDF context
  const pdfContext = ref<{ paperId: string; pageNumber: number; selectedText: string } | null>(null)

  // Agent web-native interactions (ask_user_question, future confirm/select/input)
  const interactions = ref<Record<string, AgentInteractionRequest>>({})
  const activeInteractionId = ref<string | null>(null)

  // UI Context bridge state (from Pi extensions via ctx.ui.*)
  const uiStatus = ref<Record<string, string>>({})
  const uiWidgets = ref<Record<string, { lines: string[]; placement: string }>>({})
  const uiFooterText = ref('')
  const uiHeaderLines = ref<string[]>([])
  const uiTitle = ref('')
  const toolsExpanded = ref(false)

  // Subagent run tracking (real-time status from filesystem watcher)
  interface ActiveSubagentRun {
    runId: string
    messageId: string
    status: 'running' | 'completed' | 'failed'
    currentState?: string
    currentTool?: string
    result?: any
    summary?: string
    error?: string
  }
  const activeSubagentRuns = ref<Record<string, ActiveSubagentRun>>({})
  const SUBAGENT_RUN_ID_RE = /(?:\[)([a-zA-Z0-9_-]{6,})(?:\])|(?:run id|id|运行 ID)[:：]\s*([a-zA-Z0-9_-]{6,})/i

  const extractSubagentRunId = (tc: any): string | null => {
    if (tc?.name !== 'subagent') return null
    const result = String(tc?.result || '')
    const match = result.match(SUBAGENT_RUN_ID_RE)
    return match ? (match[1] || match[2]) : null
  }

  /** Scan current branch messages for subagent tool calls and register them for tracking. */
  const detectSubagentRuns = async () => {
    if (!currentConvId.value) return
    const msgs = branchCache.value.get(currentBranchId.value || '') || messages.value
    let detected = 0
    for (const msg of msgs) {
      if (!msg.toolCalls?.length) continue
      for (const tc of msg.toolCalls) {
        const runId = extractSubagentRunId(tc)
        if (!runId || activeSubagentRuns.value[runId]) continue
        try {
          const res = await api.trackSubagentRun(runId, {
            conversationId: currentConvId.value,
            messageId: msg.id,
            branchId: currentBranchId.value || undefined,
          })
          if (res.run) {
            activeSubagentRuns.value[runId] = {
              runId,
              messageId: msg.id,
              status: (res.run.status === 'complete' ? 'completed' : res.run.status) as 'running' | 'completed' | 'failed',
              currentState: res.run.currentState,
              result: res.run.result,
            }
            detected++
            // Clean up completed runs from tracking after a delay
            if (res.run.status !== 'running') {
              setTimeout(() => { delete activeSubagentRuns.value[runId] }, 30_000)
            }
          }
        } catch (err) {
          console.warn('[SubagentTrack] Failed to track run', runId, (err as Error).message)
        }
      }
    }
    if (detected) console.log(`[SubagentTrack] Detected ${detected} subagent run(s)`)
  }
  const activeInteraction = computed(() => {
    const current = activeInteractionId.value ? interactions.value[activeInteractionId.value] : null
    if (current && current.kind !== 'notification' && (!currentConvId.value || current.conversationId === currentConvId.value)) return current
    const candidates = Object.values(interactions.value)
      .filter((item) => item.kind !== 'notification' && (!currentConvId.value || item.conversationId === currentConvId.value))
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    return candidates[0] || null
  })
  const notificationInteractions = computed(() => Object.values(interactions.value)
    .filter((item) => item.kind === 'notification' && (!currentConvId.value || item.conversationId === currentConvId.value))
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()))

  // /btw side questions. These are intentionally separate from branch messages.
  const btwItems = ref<BtwItem[]>([])
  const btwPanelOpen = ref(false)

  // Track conversations created but never used (no messages sent)
  const pendingEmptyConvs = new Set<string>()

  // ── Computed ──────────────────────────────────────────────────────────

  const messages = computed<Message[]>(() => {
    if (!currentBranchId.value) return []
    return branchCache.value.get(currentBranchId.value) || []
  })

  // ── Helpers ──────────────────────────────────────────────────────────

  /**
   * Convert PiMessage from Pi JSONL to frontend Message format.
   */
  const convertPiMessage = (piMsg: any, convId: string, branchId?: string): Message => {
    // Build segments from content (excluding thinking, which is displayed separately)
    const segments: Array<{ type: 'text' | 'tool' | 'error'; text?: string; toolCallId?: string }> = []
    
    // Add text content segment
    if (piMsg.content) {
      segments.push({ type: 'text', text: piMsg.content })
    }
    
    // Add tool segments if present
    if (piMsg.toolCalls?.length) {
      for (const tc of piMsg.toolCalls) {
        segments.push({ type: 'tool', toolCallId: tc.id })
      }
    }
    
    // Add error segment if present
    if (piMsg.isError && piMsg.errorMessage) {
      segments.push({ type: 'error', text: piMsg.errorMessage })
    }
    
    return {
      id: piMsg.id,
      conversationId: convId,
      branchId: branchId || null,
      parentId: piMsg.parentId || null,
      role: piMsg.role as 'user' | 'assistant' | 'system',
      content: piMsg.content || '',
      toolCalls: piMsg.toolCalls || null,
      metadata: {
        // Pi-specific rich metadata
        thinking: piMsg.thinking,  // Thinking is displayed separately in <details>
        segments: segments.length ? segments : undefined,
        citations: piMsg.citations,
        context: piMsg.context,
        model: piMsg.model,
        provider: piMsg.provider,
        usage: piMsg.usage,
        stopReason: piMsg.stopReason,
        responseId: piMsg.responseId,
        errorMessage: piMsg.errorMessage,
        isError: piMsg.isError,
        isCompaction: piMsg.isCompaction,
        compactionSummary: piMsg.compactionSummary,
        forkFromMessageId: piMsg.forkFromMessageId,
        streamStatus: 'completed',
      },
      createdAt: piMsg.timestamp,
    }
  }

  const cloneMessage = (msg: Message): Message => ({
    ...msg,
    metadata: {
      ...(msg.metadata || {}),
      segments: Array.isArray(msg.metadata?.segments)
        ? msg.metadata.segments.map(seg => ({ ...seg }))
        : msg.metadata?.segments,
    },
    toolCalls: Array.isArray(msg.toolCalls)
      ? msg.toolCalls.map((tc: any) => ({ ...tc }))
      : msg.toolCalls,
  })

  const cloneMessages = (msgs: Message[]) => msgs.map(cloneMessage)

  const setBranchMessages = (branchId: string, msgs: Message[]) => {
    branchCache.value.set(branchId, cloneMessages(msgs))
  }

  const ensureBranchMessages = (branchId: string) => {
    if (!branchCache.value.has(branchId)) branchCache.value.set(branchId, [])
    return branchCache.value.get(branchId)!
  }

  const appendToBranch = (branchId: string, msg: Message) => {
    const arr = ensureBranchMessages(branchId)
    arr.push(cloneMessage(msg))
    branchCache.value.set(branchId, [...arr])
  }

  const loadPrefs = () => {
    try { const s = localStorage.getItem(BRANCH_KEY); if (s) { for (const [k, v] of Object.entries(JSON.parse(s)) as [string, string][]) convBranchPrefs.set(k, v) } } catch {}
  }
  const savePrefs = () => {
    try { const o: Record<string, string> = {}; for (const [k, v] of convBranchPrefs.entries()) o[k] = v; localStorage.setItem(BRANCH_KEY, JSON.stringify(o)) } catch {}
  }
  loadPrefs()

  const setCurrentModel = (m: string) => { currentModel.value = m; if (m) localStorage.setItem(MODEL_KEY, m) }
  const setReasoningEffort = (e: string) => { reasoningEffort.value = e; localStorage.setItem(EFFORT_KEY, e) }
  const ensureModel = () => {
    if (!models.value.length) return
    if (!currentModel.value || !models.value.some(m => m.id === currentModel.value)) {
      setCurrentModel(models.value.find(m => m.id.endsWith('/' + currentModel.value))?.id || models.value[0].id)
    }
  }

  const syncStream = () => {
    const c = currentConvId.value, a = c ? activeStreams.has(c) : false
    isStreaming.value = a; streamingConvId.value = a ? c : null
    streamingMessageId.value = a && c ? (activeStreams.get(c) || '') : ''
    if (!a) streamingContent.value = ''
  }
  const refreshActiveInteraction = () => {
    const current = activeInteractionId.value ? interactions.value[activeInteractionId.value] : null
    if (current && (!currentConvId.value || current.conversationId === currentConvId.value)) return
    activeInteractionId.value = Object.values(interactions.value)
      .filter((item) => item.kind !== 'notification' && (!currentConvId.value || item.conversationId === currentConvId.value))
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0]?.requestId || null
  }
  const dismissInteraction = (requestId: string) => {
    delete interactions.value[requestId]
    if (activeInteractionId.value === requestId) activeInteractionId.value = null
    refreshActiveInteraction()
  }
  const markActive = (c: string, m = '') => { activeStreams.set(c, m); syncStream() }
  const markInactive = (c: string, m?: string) => { const cur = activeStreams.get(c); if (m && cur && cur !== m) return; activeStreams.delete(c); syncStream() }

  const scheduleStreamReconnect = (convId: string, delayMs = 1200) => {
    const old = streamReconnectTimers.get(convId)
    if (old) window.clearTimeout(old)
    const timer = window.setTimeout(() => {
      streamReconnectTimers.delete(convId)
      if (currentConvId.value === convId) attachStream(convId).catch(() => {})
    }, delayMs)
    streamReconnectTimers.set(convId, timer)
  }

  // ── Empty conversation cleanup ───────────────────────────────────────

  /** Delete a conversation from the pending-empty set without triggering UI updates. */
  const deleteEmptyConv = async (id: string) => {
    pendingEmptyConvs.delete(id)
    try { await api.deleteConversation(id) } catch {}
  }

  /** Clean up all pending-empty conversations (called on beforeunload). */
  const cleanupEmptyConvs = () => {
    if (!pendingEmptyConvs.size) return
    for (const id of pendingEmptyConvs) {
      // Use fetch with keepalive for reliable delivery during page unload
      fetch(`/api/conversations/${id}`, { method: 'DELETE', keepalive: true }).catch(() => {})
    }
    pendingEmptyConvs.clear()
  }

  // Register beforeunload handler once
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', cleanupEmptyConvs)
    window.addEventListener('online', () => {
      if (currentConvId.value) scheduleStreamReconnect(currentConvId.value, 0)
    })

    // Listen for /btw SSE events and forward to handleBtwEvent
    const btwEventTypes = ['btw_delta', 'btw_thinking', 'btw_done', 'btw_error', 'btw_cancelled', 'btw_start']
    for (const type of btwEventTypes) {
      window.addEventListener(`yarc-${type}`, ((e: CustomEvent) => {
        handleBtwEvent(e.detail)
      }) as EventListener)
    }

    // Listen for subagent status events
    const subagentEventTypes = ['subagent_started', 'subagent_status', 'subagent_complete', 'subagent_failed']
    for (const type of subagentEventTypes) {
      window.addEventListener(`yarc-${type}`, ((e: CustomEvent) => {
        handleSubagentEvent(e.detail)
      }) as EventListener)
    }
  }

  // ── API calls ──────────────────────────────────────────────────────

  const fetchConversations = async () => {
    const res = await api.getConversations()
    conversations.value = res.conversations || []
    if (conversations.value.length && !currentConvId.value) await selectConversation(conversations.value[0].id)
  }

  const fetchModels = async () => {
    modelsError.value = ''
    try { const r = await api.getModels(); models.value = r.models || []; ensureModel() }
    catch (e) { models.value = []; modelsError.value = (e as Error).message }
  }

  const loadBranches = async (convId: string) => {
    try { const r = await api.getBranches(convId); branches.value = r.branches || [] }
    catch { branches.value = [] }
  }

  /** Load messages for a branch (cache-first) */
  const loadBranchMsgs = async (convId: string, branchId: string, force = false): Promise<Message[]> => {
    if (!force && branchCache.value.has(branchId)) return branchCache.value.get(branchId)!
    try {
      const r = await api.switchBranch(convId, branchId)
      const msgs = (r.messages || []).map((m: any) => convertPiMessage(m, convId, branchId))
      setBranchMessages(branchId, msgs)
      return branchCache.value.get(branchId)!
    } catch { return [] }
  }

  const loadContextUsage = async (convId: string, branchId: string) => {
    try {
      const r = await api.getConversationContextUsage(convId, branchId)
      if (currentConvId.value === convId && currentBranchId.value === branchId) currentContextUsage.value = r.contextUsage
    } catch {
      if (currentConvId.value === convId && currentBranchId.value === branchId) currentContextUsage.value = null
    }
  }

  const selectConversation = async (id: string) => {
    if (!id) return

    // If switching away from an empty conversation, delete it
    if (currentConvId.value && currentConvId.value !== id && pendingEmptyConvs.has(currentConvId.value)) {
      const emptyId = currentConvId.value
      conversations.value = conversations.value.filter(c => c.id !== emptyId)
      deleteEmptyConv(emptyId)
    }

    // Clear branch cache when switching conversations because branch IDs
    // (e.g. 'main') are only unique within a single conversation.
    if (currentConvId.value !== id) branchCache.value.clear()

    currentConvId.value = id

    await loadBranches(id)

    const pref = convBranchPrefs.get(id)
    const main = branches.value.find(b => b.branchName === "main")
    const target = (pref && branches.value.find(b => b.id === pref)?.id) || main?.id || branches.value[0]?.id

    if (target) {
      currentBranchId.value = target
      await loadBranchMsgs(id, target)
      await loadContextUsage(id, target)
    } else {
      currentContextUsage.value = null
    }
    syncStream()
    refreshActiveInteraction()
    await attachStream(id)

    // Detect subagent runs in loaded messages for real-time tracking
    detectSubagentRuns().catch(() => {})
  }

  const switchBranch = async (branchId: string) => {
    if (!currentConvId.value || currentBranchId.value === branchId) return
    convBranchPrefs.set(currentConvId.value, branchId)
    savePrefs()
    if (branchCache.value.has(branchId)) {
      currentBranchId.value = branchId
    } else {
      await loadBranchMsgs(currentConvId.value, branchId)
      currentBranchId.value = branchId
    }
    await loadContextUsage(currentConvId.value, branchId)
  }

  const createConversation = async (paperId?: string) => {
    // If current conversation is empty, delete it first
    if (currentConvId.value && pendingEmptyConvs.has(currentConvId.value)) {
      const emptyId = currentConvId.value
      currentConvId.value = null
      conversations.value = conversations.value.filter(c => c.id !== emptyId)
      deleteEmptyConv(emptyId)
    }

    ensureModel()
    const r = await api.createConversation({ paperId, model: currentModel.value || undefined })
    conversations.value.unshift(r.conversation)
    currentConvId.value = r.conversation.id
    pendingEmptyConvs.add(r.conversation.id)
    branchCache.value.clear()
    await loadBranches(r.conversation.id)
    const main = branches.value.find(b => b.branchName === "main")
    if (main) { currentBranchId.value = main.id; branchCache.value.set(main.id, []) }
    currentContextUsage.value = null
    syncStream()
    return r.conversation
  }

  const renameConversation = async (id: string, title: string) => {
    const t = title.trim(); if (!t) return
    await api.updateConversationTitle(id, t)
    const c = conversations.value.find(x => x.id === id); if (c) { c.title = t; c.updatedAt = new Date().toISOString() }
  }

  const respondInteraction = async (requestId: string, response: AgentInteractionResponse) => {
    // E6: Include conversationId for server-side validation
    const interaction = interactions.value[requestId]
    await api.respondAgentInteraction(requestId, {
      ...response,
      conversationId: interaction?.conversationId,
    })
    delete interactions.value[requestId]
    if (activeInteractionId.value === requestId) activeInteractionId.value = null
    refreshActiveInteraction()
  }

  const askBtw = async (question: string) => {
    const q = question.trim()
    if (!q) return
    if (!currentConvId.value) throw new Error('请先选择一个对话后再使用 /btw')

    const item: BtwItem = {
      id: createClientId(),
      conversationId: currentConvId.value,
      branchId: currentBranchId.value,
      question: q,
      answer: '',
      loading: true,
      createdAt: new Date().toISOString(),
    }
    btwItems.value.unshift(item)
    btwPanelOpen.value = true

    try {
      // Start streaming btw run
      const response = await api.startBtw(currentConvId.value, {
        question: q,
        branchId: currentBranchId.value || undefined,
        model: currentModel.value || undefined,
        reasoningEffort: reasoningEffort.value,
      })
      item.runId = response.runId
    } catch (err) {
      item.error = (err as Error).message || '侧问失败'
      item.loading = false
      btwItems.value = [...btwItems.value]
    }
  }

  /** Handle btw SSE events from the global event stream. */
  const handleBtwEvent = (event: any) => {
    if (!event?.type?.startsWith('btw_')) return
    const runId = event.runId
    if (!runId) return

    const item = btwItems.value.find(i => i.runId === runId)
    if (!item) return

    switch (event.type) {
      case 'btw_delta':
        item.answer += event.content || ''
        btwItems.value = [...btwItems.value]
        break
      case 'btw_thinking':
        item.thinking = (item.thinking || '') + (event.content || '')
        break
      case 'btw_done':
        item.answer = event.answer || item.answer || 'Pi 没有返回内容。'
        item.loading = false
        btwItems.value = [...btwItems.value]
        break
      case 'btw_error':
        item.error = event.error || '侧问失败'
        item.loading = false
        btwItems.value = [...btwItems.value]
        break
      case 'btw_cancelled':
        item.cancelled = true
        item.loading = false
        if (!item.answer) item.answer = '已取消'
        btwItems.value = [...btwItems.value]
        break
    }
  }

  /** Handle subagent SSE events from the global event stream. */
  const handleSubagentEvent = (event: any) => {
    if (!event?.runId) return
    const runId = event.runId

    // Only track events for the current conversation
    if (event.conversationId && event.conversationId !== currentConvId.value) return

    switch (event.type) {
      case 'subagent_started':
        if (!activeSubagentRuns.value[runId]) {
          activeSubagentRuns.value[runId] = {
            runId,
            messageId: event.messageId || '',
            status: 'running',
          }
        }
        break
      case 'subagent_status': {
        const run = activeSubagentRuns.value[runId]
        if (run) {
          run.currentState = event.state
          run.currentTool = event.currentTool
          activeSubagentRuns.value = { ...activeSubagentRuns.value }
        }
        break
      }
      case 'subagent_complete': {
        const run = activeSubagentRuns.value[runId]
        if (run) {
          run.status = 'completed'
          run.summary = event.summary
          run.result = event.result
          activeSubagentRuns.value = { ...activeSubagentRuns.value }
          setTimeout(() => { delete activeSubagentRuns.value[runId] }, 60_000)
        }
        // Send result to conversation with persisted file path
        if (event.conversationId && event.conversationId === currentConvId.value && !isStreaming.value) {
          const agentName = event.agent || 'subagent'
          const resultFile = event.resultFile || ''
          sendMessage(`[子任务完成] ${agentName}（${runId}）已完成。结果文件：${resultFile}。请用 read 查看详情并继续回答。`)
        }
        break
      }
      case 'subagent_failed': {
        const run = activeSubagentRuns.value[runId]
        if (run) {
          run.status = 'failed'
          run.error = event.error
          activeSubagentRuns.value = { ...activeSubagentRuns.value }
          setTimeout(() => { delete activeSubagentRuns.value[runId] }, 60_000)
        }
        break
      }
    }
  }

  const cancelBtw = async (runId: string) => {
    if (!currentConvId.value) return
    try {
      await api.cancelBtw(currentConvId.value, runId)
    } catch {}
    const item = btwItems.value.find(i => i.runId === runId)
    if (item) {
      item.cancelled = true
      item.loading = false
      btwItems.value = [...btwItems.value]
    }
  }

  const insertBtwAnswer = (runId: string) => {
    const item = btwItems.value.find(i => i.runId === runId)
    if (item?.answer) pendingPrompt.value = item.answer
  }

  const sendBtwAsMainMessage = async (runId: string) => {
    const item = btwItems.value.find(i => i.runId === runId)
    if (!item?.answer) return
    await sendMessage(item.answer)
  }

  const clearBtwItems = () => { btwItems.value = [] }

  const deleteConversation = async (id: string) => {
    await api.deleteConversation(id)
    pendingEmptyConvs.delete(id)
    conversations.value = conversations.value.filter(c => c.id !== id)
    for (const [requestId, interaction] of Object.entries(interactions.value)) {
      if (interaction.conversationId === id) delete interactions.value[requestId]
    }
    refreshActiveInteraction()
    branchCache.value.clear()
    if (currentConvId.value === id) {
      currentConvId.value = conversations.value[0]?.id || null
      if (currentConvId.value) await selectConversation(currentConvId.value)
      else { branches.value = []; currentBranchId.value = null }
    }
  }

  // ── Send message ──────────────────────────────────────────────────

  const sendMessage = async (content: string, opts: { editMessageId?: string; editForkMessageId?: string } = {}) => {
    chatError.value = ''
    let assistantMsg: Message | null = null
    let convId = ''
    let shouldReconnect = false

    try {
      if (!currentConvId.value) await createConversation(pdfContext.value?.paperId)
      ensureModel()
      convId = currentConvId.value || ''
      if (!convId) throw new Error('没有可用对话')

      // Conversation will have content, remove from empty tracking
      pendingEmptyConvs.delete(convId)

      if (!opts.editMessageId) {
        // Optimistic: add user message to cache
        const um: Message = { id: createClientId(), conversationId: convId, branchId: currentBranchId.value, role: 'user', content, toolCalls: null, metadata: { pending: true, context: pdfContext.value }, createdAt: new Date().toISOString() }
        if (currentBranchId.value) appendToBranch(currentBranchId.value, um)
      }

      markActive(convId)
      streamingContent.value = ''

      assistantMsg = await streamWs(convId, {
        type: 'chat', content, model: currentModel.value || undefined,
        reasoning_effort: reasoningEffort.value,
        context: pdfContext.value, branchId: currentBranchId.value || undefined,
        ...(opts.editMessageId ? { editMessageId: opts.editMessageId } : {}),
        ...(opts.editForkMessageId ? { editForkMessageId: opts.editForkMessageId } : {}),
      })
    } catch (e) {
      const err = e as Error
      shouldReconnect = err.name !== 'AbortError'
      chatError.value = err.name === 'AbortError' ? '已停止' : (err.message || '发送失败')
    } finally {
      abortControllers.delete(convId)
      if (convId) {
        markInactive(convId)
        if (assistantMsg?.id || shouldReconnect) scheduleStreamReconnect(convId)
        // Auto-title: if conversation still has default title, use first message.
        if (!opts.editMessageId) {
          const conv = conversations.value.find(c => c.id === convId)
          if (conv && conv.title === '新对话') {
            const title = content.slice(0, 30).replace(/\n/g, ' ').trim()
            if (title) {
              conv.title = title
              api.updateConversationTitle(convId, title).catch(() => {})
            }
          }
        }
      } else syncStream()
      pdfContext.value = null
    }
  }

  // ── WebSocket streaming ──────────────────────────────────────────

  const streamWs = async (convId: string, payload: any): Promise<Message | null> => {
    abortControllers.get(convId)?.abort()
    const abort = new AbortController(); abortControllers.set(convId, abort)

    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
      const ws = new WebSocket(`${proto}//${location.host}/api/chat?conversation_id=${convId}`)
      let msg: Message | null = null

      abort.signal.addEventListener('abort', () => { ws.close(); reject(new DOMException('Aborted', 'AbortError')) })
      ws.onopen = () => ws.send(JSON.stringify(payload))

      ws.onmessage = async (ev) => {
        try {
          const d = JSON.parse(ev.data)

          if (d.type === 'stream_start') {
            if (d.branch?.id) {
              const exists = branches.value.findIndex(b => b.id === d.branch.id)
              if (exists >= 0) branches.value[exists] = d.branch
              else branches.value = [...branches.value, d.branch]
            }

            // Switch to new branch if provided
            if (d.branchId) {
              const previousBranchId = currentBranchId.value
              currentBranchId.value = d.branchId
              convBranchPrefs.set(convId, d.branchId)
              savePrefs()

              // Copy the previous branch cache as a temporary placeholder,
              // but deep-clone it so later streaming mutations stay isolated.
              if (previousBranchId && previousBranchId !== d.branchId && !branchCache.value.has(d.branchId)) {
                const previousMessages = branchCache.value.get(previousBranchId) || []
                setBranchMessages(d.branchId, previousMessages)
              }
            }

            // Ensure cache array exists for this branch
            const bid = currentBranchId.value || ''
            ensureBranchMessages(bid)

            // Add/update user message
            if (d.userMessage) {
              const arr = branchCache.value.get(bid)!
              const idx = arr.findIndex(m => m.role === 'user' && m.content === d.userMessage.content && m.id !== d.userMessage.id)
              const next = cloneMessage(d.userMessage)
              if (idx >= 0) arr[idx] = next; else arr.push(next)
              branchCache.value.set(bid, [...arr])
            }

            // Create assistant placeholder and get the cached reference
            // (appendToBranch clones, so we must use the cached copy for live mutations).
            const created: Message = { id: d.messageId, conversationId: convId, branchId: d.branchId, role: 'assistant', content: '', toolCalls: null, metadata: { pending: true, segments: [], streamStatus: 'streaming' }, createdAt: new Date().toISOString() }
            appendToBranch(bid, created)
            msg = branchCache.value.get(bid)!.slice(-1)[0]!
            markActive(convId, created.id)
            return
          }

          if (d.type === 'done') {
            const bid = msg?.branchId || currentBranchId.value
            if (bid) {
              await loadBranchMsgs(convId, bid, true)
              await loadContextUsage(convId, bid)
            }
            await loadBranches(convId)
            // Detect new subagent runs from this turn
            detectSubagentRuns().catch(() => {})
            ws.close(); resolve(msg); return
          }

          // When a new branch is created (edit), the server sends the full
          // message list for the new branch. Use these as the authoritative
          // source — discard any messages copied from the previous branch.
          if (d.type === 'branch_messages' && d.branchId && d.messages) {
            const byId = new Map<string, Message>()
            for (const m of d.messages) byId.set(m.id, convertPiMessage(m, convId, d.branchId))
            const final: Message[] = d.messages.map((m: Message) => byId.get(m.id)!)
            setBranchMessages(d.branchId, final)
            // Note: msg will be set when stream_start arrives
            return
          }

          if (msg) applyEvent(d, msg, convId)

          // Ignore Pi entry mapping events here. The branch reload on `done`
          // replaces all pending in-flight messages with canonical Pi JSONL
          // entries, so temporary IDs never enter edit/fork logic.
        } catch {}
      }

      ws.onerror = () => { if (msg) resolve(msg); else reject(new Error('WebSocket 连接失败')) }
      ws.onclose = (e) => { if (!e.wasClean && !abort.signal.aborted && !msg) reject(new Error('连接断开')); else resolve(msg) }
    })
  }

  // ── Event handling ────────────────────────────────────────────────

  const ensureSeg = (m: Message) => { if (!Array.isArray(m.metadata.segments)) m.metadata.segments = []; return m.metadata.segments }
  const appendSeg = (m: Message, t: string, type: 'text' | 'error' = 'text') => { const s = ensureSeg(m); const l = s[s.length - 1]; if (l?.type === type) l.text += t; else s.push({ type, text: t }) }
  const pushTool = (m: Message, id: string) => { const s = ensureSeg(m); if (!s.some(x => x.type === 'tool' && x.toolCallId === id)) s.push({ type: 'tool', toolCallId: id }) }

  const appendText = (m: Message, t: string, c: string) => { if (c === currentConvId.value) streamingContent.value += t; m.content += t; appendSeg(m, t) }

  const enqueue = (m: Message, t: string, c: string) => {
    const id = m.id; const q = textQueues.get(id) || { buf: '', timer: null }; q.buf += t; textQueues.set(id, q)
    if (q.timer !== null) return
    const tick = () => { const s = textQueues.get(id); if (!s) return; const n = Math.max(1, Math.min(6, Math.ceil(s.buf.length / 18))); const chunk = s.buf.slice(0, n); s.buf = s.buf.slice(n); if (chunk) appendText(m, chunk, c); s.timer = s.buf ? window.setTimeout(tick, 16) : (textQueues.delete(id), null) }
    q.timer = window.setTimeout(tick, 16)
  }

  const applyEvent = (d: any, m: Message, c: string) => {
    switch (d.type) {
      case 'text': enqueue(m, d.content, c); break
      case 'thinking': m.metadata.thinking = (m.metadata.thinking || '') + d.content; break
      case 'tool_call': { if (!m.toolCalls) m.toolCalls = []; let inp = d.input; if (typeof inp === 'string') try { inp = JSON.parse(inp) } catch {}; const ex = m.toolCalls.find((t: any) => t.id === d.toolCallId); if (ex) { ex.name = d.toolName; ex.input = inp } else m.toolCalls.push({ id: d.toolCallId, name: d.toolName, input: inp }); pushTool(m, d.toolCallId); break }
      case 'tool_result': if (m.toolCalls) { const tc = m.toolCalls.find((t: any) => t.id === d.toolCallId); if (tc) tc.result = d.result }; break
      case 'search_results': window.dispatchEvent(new CustomEvent('yarc-agent-search-results', { detail: d })); break
      case 'citation': if (!m.metadata.citations) m.metadata.citations = []; m.metadata.citations.push({ pageNumber: d.pageNumber, text: d.text }); break
      case 'session_state':
        m.metadata.sessionState = { model: d.model, thinkingLevel: d.thinkingLevel };
        if (d.models?.length) m.metadata.availableModels = d.models;
        break;
      case 'context_usage':
        if (c === currentConvId.value) {
          currentContextUsage.value = {
            tokens: d.tokens ?? null,
            contextWindow: Number(d.contextWindow || 0),
            percent: d.percent ?? null,
            model: d.model,
          }
        }
        break;
      case 'agent_interaction_request':
        interactions.value[d.requestId] = d;
        if (d.kind === 'notification') {
          window.setTimeout(() => dismissInteraction(d.requestId), 6000)
        } else if (!currentConvId.value || d.conversationId === currentConvId.value) activeInteractionId.value = d.requestId;
        break;
      case 'agent_interaction_resolved':
        delete interactions.value[d.requestId];
        if (activeInteractionId.value === d.requestId) activeInteractionId.value = null;
        refreshActiveInteraction();
        if (d.reason === 'timeout') chatError.value = 'Agent 交互请求已超时，已按取消处理。';
        break;
      case 'error': { const t = `❌ ${d.message}`; m.content += m.content ? `\n\n${t}` : t; chatError.value = d.message; appendSeg(m, t, 'error'); break }
      // UI Context bridge events
      case 'agent_ui_status': if (d.key) uiStatus.value = { ...uiStatus.value, [d.key]: d.text || '' }; break
      case 'agent_ui_widget': if (d.key) uiWidgets.value = { ...uiWidgets.value, [d.key]: { lines: d.lines || [], placement: d.placement || 'above' } }; break
      case 'agent_ui_footer': uiFooterText.value = d.text || ''; break
      case 'agent_ui_header': uiHeaderLines.value = d.lines || []; break
      case 'agent_ui_title': {
        uiTitle.value = d.title || ''
        if (d.title) document.title = `${d.title} - YARC`
        break
      }
      case 'agent_ui_editor_set_text': if (typeof d.text === 'string') pendingPrompt.value = d.text; break
      case 'agent_ui_editor_paste': if (typeof d.text === 'string') pendingPrompt.value = (pendingPrompt.value || '') + d.text; break
      case 'agent_ui_tools_expanded': toolsExpanded.value = !!d.expanded; break
      case 'agent_ui_theme_request': {
        // Basic theme bridge: emit event for theme store to handle
        window.dispatchEvent(new CustomEvent('yarc-theme-request', { detail: { theme: d.theme } }))
        break
      }
    }
  }

  // ── Stream reconnection ──────────────────────────────────────────

  const attachStream = async (convId: string): Promise<boolean> => {
    if (activeStreams.has(convId)) { syncStream(); return true }

    let r: any
    try { r = await api.getStreamingMessage(convId) }
    catch { syncStream(); return false }

    const sm = r.message as Message | null
    if (!sm?.id) { syncStream(); return false }

    const bid = (sm as any).branchId || currentBranchId.value
    let msgRef: Message = {
      ...cloneMessage(sm),
      content: '',
      toolCalls: null,
      metadata: { ...(sm.metadata || {}), segments: [], streamStatus: 'streaming' },
    }

    if (bid) {
      currentBranchId.value = bid
      const arr = branchCache.value.get(bid) || []
      const idx = arr.findIndex(m => m.id === sm.id)
      if (idx >= 0) arr[idx] = msgRef
      else arr.push(msgRef)
      branchCache.value.set(bid, [...arr])
      msgRef = branchCache.value.get(bid)![idx >= 0 ? idx : arr.length - 1]!
    }

    markActive(convId, sm.id)

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${proto}//${location.host}/api/chat?conversation_id=${convId}`)
    let streamCompleted = false
    ws.onopen = () => ws.send(JSON.stringify({ type: 'attach', messageId: sm.id }))
    ws.onmessage = (ev) => {
      try {
        const d = JSON.parse(ev.data)
        if (d.type === 'done') {
          streamCompleted = true
          // Reload messages and detect subagent runs after reconnected stream completes
          if (bid) loadBranchMsgs(convId, bid, true).then(() => detectSubagentRuns()).catch(() => {})
          ws.close(); return
        }
        if (d.type !== 'stream_start') applyEvent(d, msgRef, convId)
      } catch {}
    }
    ws.onerror = () => { /* onclose handles retry/reload */ }
    ws.onclose = () => {
      markInactive(convId, sm.id)
      if (streamCompleted) {
        if (bid) {
          branchCache.value.delete(bid)
          loadBranchMsgs(convId, bid).then(() => loadContextUsage(convId, bid)).catch(() => {})
        }
      } else if (currentConvId.value === convId) {
        scheduleStreamReconnect(convId, navigator.onLine === false ? 5000 : 1500)
      }
    }
    return true
  }

  const stopStreaming = () => {
    const c = currentConvId.value, m = streamingMessageId.value || (c ? activeStreams.get(c) : '') || ''
    if (c) {
      if (m) api.stopStreamingMessage(c, m).catch(() => {})
      for (const [requestId, interaction] of Object.entries(interactions.value)) {
        if (interaction.streamMessageId === m) delete interactions.value[requestId]
      }
      refreshActiveInteraction()
      abortControllers.get(c)?.abort(); abortControllers.delete(c); markInactive(c, m || undefined)
    }
    syncStream()
  }

  return {
    conversations, currentConvId, messages, models, modelsError, chatError, pendingPrompt, currentContextUsage,
    currentModel, reasoningEffort, isStreaming, streamingConvId, streamingMessageId, streamingContent,
    pdfContext, branches, currentBranchId, branchCache, interactions, activeInteractionId, activeInteraction,
    notificationInteractions, btwItems, btwPanelOpen,
    uiStatus, uiWidgets, uiFooterText, uiHeaderLines, uiTitle, toolsExpanded,
    activeSubagentRuns,
    setCurrentModel, setReasoningEffort, fetchConversations, fetchModels,
    createConversation, renameConversation, deleteConversation, selectConversation,
    sendMessage, stopStreaming, switchBranch, respondInteraction, dismissInteraction,
    askBtw, cancelBtw, insertBtwAnswer, sendBtwAsMainMessage, handleBtwEvent, clearBtwItems,
  }
})
