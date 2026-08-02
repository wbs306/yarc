<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { copyToClipboard } from '@/lib/clipboard'
import { useChatStore } from '@/stores/chat'
import { useThemeStore } from '@/stores/theme'
import { usePaperStore } from '@/stores/paper'
import { confirm } from '@/composables/useConfirm'
import ModelSelector from './ModelSelector.vue'
import ReasoningEffort from './ReasoningEffort.vue'
import AgentInteractionHost from '@/components/agent/AgentInteractionHost.vue'
import MarkdownContent from '@/components/markdown/MarkdownContent.vue'
import type { CurrentChatResource } from '@yarc/shared'

const props = defineProps<{ currentResource?: CurrentChatResource | null; currentResourceNotice?: string }>()
const emit = defineEmits<{ close: [] }>()
const chatStore = useChatStore()
const theme = useThemeStore()
const paperStore = usePaperStore()
const currentModelReasoning = computed(() => chatStore.models.find(m => m.id === chatStore.currentModel)?.reasoning)
const currentModelLevels = computed(() => chatStore.models.find(m => m.id === chatStore.currentModel)?.thinkingLevels)

const inputText = ref('')
const editingMessageId = ref('')
const container = ref<HTMLDivElement>()
const textareaRef = ref<HTMLTextAreaElement>()
const modelSelectorRef = ref<{ openDropdown: () => void }>()

// Sent-message history (up-arrow recall)
const sentHistory = ref<string[]>([])
const historyIndex = ref(-1)  // -1 = not navigating
const historyDraft = ref('')  // saved draft when entering history mode
const historyDraftSelection = ref<{ start: number; end: number } | null>(null)

// Auto-resize textarea
const autoResize = () => {
  const el = textareaRef.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, 200) + 'px'
}

watch(inputText, () => nextTick(autoResize))

const commandOptions = [
  // Web-native session commands
  { trigger: '/model', label: '/model [name]', hint: '打开或切换模型' },
  { trigger: '/thinking', label: '/thinking [level]', hint: '切换思考级别' },
  { trigger: '/compact', label: '/compact [instructions]', hint: '压缩上下文' },
  { trigger: '/new', label: '/new', hint: '新对话' },
  { trigger: '/btw ', label: '/btw <question>', hint: '基于当前上下文侧问' },
  // Agent-intent commands
  { trigger: '/help', label: '/help', hint: '查看 Agent 可用命令' },
  { trigger: '/files', label: '/files', hint: '列出 data 工作区文件' },
  { trigger: '/read ', label: '/read <path>', hint: '读取工作区文件' },
  { trigger: '/write ', label: '/write <path>', hint: '创建或改写工作区文件' },
  { trigger: '/edit ', label: '/edit <path>', hint: '编辑工作区文件' },
  { trigger: '/search ', label: '/search <query>', hint: '搜索论文' },
  { trigger: '/list ', label: '/list papers', hint: '列出论文或分类' },
  { trigger: '@current ', label: '@current', hint: '引用当前文件或论文' },
  { trigger: '@file ', label: '@file <path>', hint: '引用工作区文件' },
  { trigger: '@paper ', label: '@paper', hint: '引用论文' },
  { trigger: '@category ', label: '@category <name>', hint: '引用分类' },
]

// Paper picker for @paper command
const paperPickerOpen = ref(false)
const paperPickerQuery = ref('')
const ctxExpandedSet = ref(new Set<string>())
const toggleCtxExpanded = (msgId: string) => {
  if (ctxExpandedSet.value.has(msgId)) ctxExpandedSet.value.delete(msgId)
  else ctxExpandedSet.value.add(msgId)
}
const contextItems = (msg: any): Array<{ type: string; label: string; detail?: string }> => msg.metadata?.context?.injected || []
const contextSummary = (msg: any) => {
  const items = contextItems(msg)
  if (items.length) {
    const counts = items.reduce<Record<string, number>>((acc, item) => {
      acc[item.type] = (acc[item.type] || 0) + 1
      return acc
    }, {})
    const parts = [
      counts.paper ? `论文 ${counts.paper}` : '',
      counts.file ? `文件 ${counts.file}` : '',
      counts.category ? `分类 ${counts.category}` : '',
      counts.search ? `检索片段 ${counts.search}` : '',
    ].filter(Boolean)
    return parts.length ? `已注入上下文 · ${parts.join(' · ')}` : `已注入上下文 · ${items.length}项`
  }
  const ctx = msg.metadata?.context
  if (!ctx) return ''
  const parts = [ctx.temporaryPdf ? '临时 PDF 上下文' : '论文上下文']
  if (ctx.pageNumber) parts.push(`第${ctx.pageNumber}页`)
  if (ctx.selectedText) parts.push('已选中文本')
  return parts.join(' · ')
}
const contextIcon = (type: string) => ({ paper: '📄', file: '📎', category: '🏷️', search: '🔎' } as Record<string, string>)[type] || 'ℹ️'
const paperPickerResults = computed(() => {
  const q = paperPickerQuery.value.trim().toLowerCase()
  const all = paperStore.papers
  const currentPaperId = chatStore.pdfContext?.paperId
  const sorted = [...all].sort((a, b) => {
    if (a.id === currentPaperId) return -1
    if (b.id === currentPaperId) return 1
    return a.title.localeCompare(b.title)
  })
  if (!q) return sorted.slice(0, 10)
  return sorted.filter(p => p.title.toLowerCase().includes(q) || p.authors.some(a => a.toLowerCase().includes(q))).slice(0, 10)
})

const currentPaperTitle = computed(() => {
  const pid = chatStore.pdfContext?.paperId
  if (!pid) return null
  return paperStore.papers.find(p => p.id === pid)?.title || pid
})

const selectPaper = (paper: { id: string; title: string }) => {
  paperPickerOpen.value = false
  
  // Find the last @paper command in the input
  const atPaperRegex = /@paper\s+([^@]*?)$/i
  const match = inputText.value.match(atPaperRegex)
  
  if (match) {
    // Replace only the @paper command part
    const before = inputText.value.substring(0, match.index!)
    const after = inputText.value.substring(match.index! + match[0].length)
    inputText.value = before + `@paper ${paper.title} ` + after
  } else {
    // Fallback: replace entire input
    inputText.value = `@paper ${paper.title} `
  }
  
  nextTick(() => {
    const el = document.querySelector('.chat-textarea') as HTMLTextAreaElement | null
    el?.focus()
  })
}

const fileTreeCache = ref<Array<{ path: string; type: 'file' | 'directory' }>>([])
const categoriesCache = ref<Array<{ id: string; name: string }>>([])
const dismissedSuggestionText = ref('')

const flattenFileTree = (nodes: any[]): Array<{ path: string; type: 'file' | 'directory' }> => {
  const items: Array<{ path: string; type: 'file' | 'directory' }> = []
  const walk = (list: any[]) => {
    for (const node of list || []) {
      if (!node?.path || (node.type !== 'file' && node.type !== 'directory')) continue
      items.push({ path: node.path, type: node.type })
      if (node.type === 'directory' && Array.isArray(node.children)) walk(node.children)
    }
  }
  walk(nodes)
  return items
}

const loadFileTree = async () => {
  if (fileTreeCache.value.length) return
  try {
    const api = (await import('@/composables/useApi')).useApi()
    const res = await api.getFileTree()
    fileTreeCache.value = flattenFileTree(res.files || [])
  } catch {}
}

const loadCategories = async () => {
  if (categoriesCache.value.length) return
  try {
    const api = (await import('@/composables/useApi')).useApi()
    const res = await api.getCategories()
    categoriesCache.value = (res.categories || []).map((c: any) => ({ id: c.id, name: c.name }))
  } catch {}
}

interface SuggestionItem {
  label: string
  insert: string
  hint: string
  type: 'command' | 'current' | 'file' | 'paper' | 'category'
  matchStart: number
  matchEnd: number
}

const suggestions = computed<SuggestionItem[]>(() => {
  const text = inputText.value
  if (!text || text === dismissedSuggestionText.value) return []

  // Find the last @command in the input
  const atCommandRegex = /@(file|paper|category)(\s+[^@]*?)?$/i
  const atCommandMatch = text.match(atCommandRegex)
  
  if (atCommandMatch) {
    const command = atCommandMatch[1].toLowerCase()
    const partial = (atCommandMatch[2] || '').trim().toLowerCase()
    const matchStart = atCommandMatch.index!
    const matchEnd = matchStart + atCommandMatch[0].length
    
    if (command === 'file') {
      return fileTreeCache.value
        .filter(item => item.path.toLowerCase().includes(partial))
        .slice(0, 8)
        .map(item => ({ 
          label: item.path, 
          insert: `@file ${item.path} `, 
          hint: item.type === 'directory' ? '目录' : '文件', 
          type: 'file' as const,
          matchStart,
          matchEnd
        }))
    }
    
    if (command === 'paper') {
      const currentPaperId = chatStore.pdfContext?.paperId
      const sorted = [...paperStore.papers].sort((a, b) => {
        if (a.id === currentPaperId) return -1
        if (b.id === currentPaperId) return 1
        return 0
      })
      return sorted
        .filter(p => p.title.toLowerCase().includes(partial) || p.authors.some(a => a.toLowerCase().includes(partial)))
        .slice(0, 8)
        .map(p => ({
          label: p.title + (p.id === currentPaperId ? ' (当前)' : ''),
          insert: `@paper ${p.title} `,
          hint: p.authors.slice(0, 2).join(', ') + (p.year ? ` · ${p.year}` : ''),
          type: 'paper' as const,
          matchStart,
          matchEnd
        }))
    }
    
    if (command === 'category') {
      return categoriesCache.value
        .filter(c => c.name.toLowerCase().includes(partial))
        .slice(0, 8)
        .map(c => ({ 
          label: c.name, 
          insert: `@category ${c.name} `, 
          hint: '分类', 
          type: 'category' as const,
          matchStart,
          matchEnd
        }))
    }
  }

  // Standalone @ at end of input — show command options
  const atMatch = text.match(/@(\w*)$/)
  if (atMatch) {
    const prefix = atMatch[1].toLowerCase()
    const matchStart = atMatch.index!
    const matchEnd = matchStart + atMatch[0].length
    const items: SuggestionItem[] = []
    if ('current'.startsWith(prefix) || !prefix) items.push({ label: '@current', insert: '@current ', hint: props.currentResource ? `引用当前${props.currentResource.type === 'paper' ? '论文' : '文件'}` : props.currentResourceNotice || '当前没有可引用内容', type: 'current', matchStart, matchEnd })
    if ('file'.startsWith(prefix) || !prefix) items.push({ label: '@file', insert: '@file ', hint: '引用工作区文件', type: 'file', matchStart, matchEnd })
    if ('paper'.startsWith(prefix) || !prefix) items.push({ label: '@paper', insert: '@paper ', hint: '引用论文', type: 'paper', matchStart, matchEnd })
    if ('category'.startsWith(prefix) || !prefix) items.push({ label: '@category', insert: '@category ', hint: '引用分类', type: 'category', matchStart, matchEnd })
    return items
  }

  // Slash commands at start of input
  const slashMatch = text.match(/^\/(\w*)$/)
  if (slashMatch) {
    const prefix = slashMatch[1].toLowerCase()
    const matchStart = slashMatch.index!
    const matchEnd = matchStart + slashMatch[0].length
    return commandOptions
      .filter(o => o.trigger.slice(1).startsWith(prefix))
      .map(o => ({ label: o.label, insert: o.trigger, hint: o.hint, type: 'command' as const, matchStart, matchEnd }))
      .slice(0, 6)
  }

  return []
})

const selectedSuggestion = ref(0)
watch(suggestions, () => { selectedSuggestion.value = 0 })

const applySuggestion = (item: SuggestionItem) => {
  // Replace only the matched @command part, preserving the rest of the input.
  // Suppress the palette for the completed value so the next Enter sends it
  // instead of selecting the same suggestion repeatedly.
  const before = inputText.value.substring(0, item.matchStart)
  const after = inputText.value.substring(item.matchEnd)
  const nextText = before + item.insert + after
  dismissedSuggestionText.value = nextText
  inputText.value = nextText
  selectedSuggestion.value = 0
  nextTick(() => {
    const el = document.querySelector('.chat-textarea') as HTMLTextAreaElement | null
    el?.focus()
  })
}

const applySelectedSuggestion = () => {
  const items = suggestions.value
  if (!items.length) return false
  applySuggestion(items[selectedSuggestion.value] || items[0])
  return true
}

// Preload data when @ is typed
watch(inputText, (val) => {
  if (dismissedSuggestionText.value && val !== dismissedSuggestionText.value) dismissedSuggestionText.value = ''
  if (val.includes('@file')) loadFileTree()
  if (val.includes('@category')) loadCategories()
  if (val.includes('@paper') && !paperStore.papers.length) paperStore.fetchPapers()
})

// Clear file tree cache when files change
const onFilesChanged = () => {
  fileTreeCache.value = []
}

onMounted(() => {
  window.addEventListener('yarc-files-changed', onFilesChanged)
})

onBeforeUnmount(() => {
  window.removeEventListener('yarc-files-changed', onFilesChanged)
})

const autoScroll = ref(true)
const convMenuOpen = ref(false)
const renamingConvId = ref<string | null>(null)
const renameText = ref('')

// ── Fork info: which messages have branch switches ─────────────────────────

interface ForkInfo {
  hasFork: boolean
  children: Array<{ branchId: string; branchName: string }>
  currentIndex: number
}

const getBranchById = (branchId: string | null) => branchId ? chatStore.branches.find(b => b.id === branchId) || null : null

const getActiveBranchPath = (branchId: string | null) => {
  const path = new Set<string>()
  let cur = getBranchById(branchId)
  while (cur) {
    path.add(cur.id)
    cur = getBranchById(cur.parentBranchId)
  }
  return path
}

const messageForkInfo = computed(() => {
  const result = new Map<string, ForkInfo>()
  const activePath = getActiveBranchPath(chatStore.currentBranchId)

  // Build fork points: forkMessageId -> child branches (from branch structure)
  const forkPoints = new Map<string, Array<{ branchId: string; branchName: string; parentBranchId: string | null }>>()
  for (const b of chatStore.branches) {
    if (b.forkMessageId) {
      const arr = forkPoints.get(b.forkMessageId) || []
      arr.push({ branchId: b.id, branchName: b.branchName, parentBranchId: b.parentBranchId })
      forkPoints.set(b.forkMessageId, arr)
    }
  }

  // Determine fork info for each message in the current view
  for (const msg of chatStore.messages) {
    if (msg.role !== 'user') continue

    const forkAnchorId = typeof msg.metadata?.forkFromMessageId === 'string'
      ? msg.metadata.forkFromMessageId
      : msg.id
    const childBranches = forkPoints.get(forkAnchorId) || []
    if (!childBranches.length) continue

    const parentBranchId = childBranches[0]?.parentBranchId || null
    const variants: Array<{ branchId: string; branchName: string }> = [
      ...(parentBranchId ? [{ branchId: parentBranchId, branchName: 'original' }] : []),
      ...childBranches.map(({ branchId, branchName }) => ({ branchId, branchName })),
    ]

    let currentIndex = variants.findIndex(variant => variant.branchId === chatStore.currentBranchId)
    if (currentIndex < 0) currentIndex = variants.findIndex((variant, index) => index > 0 && activePath.has(variant.branchId))
    if (currentIndex < 0) currentIndex = variants.findIndex(variant => activePath.has(variant.branchId))
    result.set(msg.id, {
      hasFork: true,
      children: variants,
      currentIndex,
    })
  }

  return result
})

const getForkInfo = (messageId: string): ForkInfo => {
  return messageForkInfo.value.get(messageId) || { hasFork: false, children: [], currentIndex: -1 }
}

const getForkDisplayIndex = (messageId: string) => {
  const info = getForkInfo(messageId)
  return info.currentIndex >= 0 ? info.currentIndex + 1 : 1
}

const switchToBranch = (messageId: string, direction: number) => {
  const info = getForkInfo(messageId)
  const baseIndex = info.currentIndex >= 0 ? info.currentIndex : 0
  const nextIdx = baseIndex + direction
  if (nextIdx < 0 || nextIdx >= info.children.length) return
  void chatStore.switchBranch(info.children[nextIdx].branchId)
}

// ── Scroll ─────────────────────────────────────────────────────────────────

let scrollRaf = 0
const scheduleScroll = () => {
  cancelAnimationFrame(scrollRaf)
  scrollRaf = requestAnimationFrame(() => nextTick(maybeScroll))
}
const isNearBottom = () => {
  if (!container.value) return true
  return container.value.scrollHeight - container.value.scrollTop - container.value.clientHeight < 8
}
const maybeScroll = () => {
  if (autoScroll.value && container.value) {
    requestAnimationFrame(() => { container.value!.scrollTop = container.value!.scrollHeight })
  }
}
const scrollBottom = () => {
  autoScroll.value = true
  if (container.value) requestAnimationFrame(() => { container.value!.scrollTop = container.value!.scrollHeight })
}
const onScroll = () => { autoScroll.value = isNearBottom() }
const streamLayoutVersion = computed(() => (chatStore.messages || []).map((msg: any) => [
  msg.id,
  msg.content?.length || 0,
  Array.isArray(msg.metadata?.segments) ? msg.metadata.segments.length : 0,
  (msg.toolCalls || []).map((tool: any) => `${tool.id}:${tool.result?.length || 0}`).join(','),
].join(':')).join('|'))

watch(() => chatStore.messages?.length ?? 0, (newLen, oldLen) => {
  scheduleScroll()
  if (oldLen === 0 && newLen > 0) nextTick(scrollBottom)
}, { flush: 'post' })
watch(streamLayoutVersion, () => scheduleScroll(), { flush: 'post' })
watch(() => chatStore.pendingPrompt, (p) => {
  if (p) { inputText.value = p; chatStore.pendingPrompt = ''; scheduleScroll() }
})

// ── Conversation menu ───────────────────────────────────────────────────────

const startRename = (convId: string) => {
  const conv = chatStore.conversations.find(c => c.id === convId)
  if (!conv) return
  renamingConvId.value = convId
  renameText.value = conv.title
}
const commitRename = () => {
  if (renamingConvId.value && renameText.value.trim()) void chatStore.renameConversation(renamingConvId.value, renameText.value)
  renamingConvId.value = null; renameText.value = ''
}
const deleteConv = async (convId: string) => {
  const conv = chatStore.conversations.find(c => c.id === convId)
  if (await confirm({
    title: '删除对话',
    message: `「${conv?.title || '新对话'}」将被永久删除，包括其中的全部消息。`,
    confirmText: '删除',
    danger: true,
    icon: 'trash',
  })) {
    void chatStore.deleteConversation(convId)
    convMenuOpen.value = false
  }
}

const headerRef = ref<HTMLDivElement>()
const onDocClick = (e: MouseEvent) => {
  if (!headerRef.value?.contains(e.target as Node)) { convMenuOpen.value = false; if (renamingConvId.value) commitRename() }
}
watch(convMenuOpen, (open) => {
  if (open) document.addEventListener('mousedown', onDocClick)
  else document.removeEventListener('mousedown', onDocClick)
})

// ── Send / Edit ─────────────────────────────────────────────────────────────

const resetComposer = () => {
  inputText.value = ''
  if (textareaRef.value) textareaRef.value.style.height = 'auto'
}

const handleWebSlashCommand = async (text: string): Promise<boolean> => {
  if (/^\/new\s*$/i.test(text)) {
    resetComposer()
    await chatStore.createConversation()
    return true
  }

  const modelMatch = text.match(/^\/model(?:\s+([\s\S]+?))?\s*$/i)
  if (modelMatch) {
    resetComposer()
    const query = modelMatch[1]?.trim()
    if (!query) {
      if (!chatStore.models.length) chatStore.chatError = '当前没有可用模型'
      else await nextTick(() => modelSelectorRef.value?.openDropdown())
      return true
    }

    const normalized = query.toLowerCase()
    const exact = chatStore.models.find(model =>
      model.id.toLowerCase() === normalized || model.name.toLowerCase() === normalized
    )
    const matches = exact ? [exact] : chatStore.models.filter(model =>
      model.id.toLowerCase().includes(normalized) || model.name.toLowerCase().includes(normalized)
    )
    if (matches.length === 1) {
      chatStore.setCurrentModel(matches[0].id)
      chatStore.chatError = ''
    } else if (!matches.length) {
      chatStore.chatError = `没有找到模型：${query}`
    } else {
      chatStore.chatError = `模型名称不唯一：${matches.slice(0, 5).map(model => model.id).join('、')}`
    }
    return true
  }

  const thinkingMatch = text.match(/^\/thinking(?:\s+([\s\S]+?))?\s*$/i)
  if (thinkingMatch) {
    resetComposer()
    if (!currentModelReasoning.value) {
      chatStore.chatError = '当前模型不支持思考级别设置'
      return true
    }

    const levels = currentModelLevels.value?.length
      ? currentModelLevels.value
      : ['off', 'low', 'medium', 'high', 'xhigh']
    const requested = thinkingMatch[1]?.trim().toLowerCase()
    if (!requested) {
      const currentIndex = levels.indexOf(chatStore.reasoningEffort)
      chatStore.setReasoningEffort(levels[(currentIndex + 1 + levels.length) % levels.length])
      chatStore.chatError = ''
      return true
    }

    const aliases: Record<string, string> = { minimal: 'low', max: 'xhigh', xhigh: 'max' }
    const target = levels.find(level => level.toLowerCase() === requested)
      || levels.find(level => level.toLowerCase() === aliases[requested])
    if (!target) {
      chatStore.chatError = `无效思考级别：${requested}；可选 ${levels.join('、')}`
    } else {
      chatStore.setReasoningEffort(target)
      chatStore.chatError = ''
    }
    return true
  }

  return false
}

const send = async () => {
  const text = inputText.value.trim()
  if (!text || chatStore.isStreaming) return

  if (await handleWebSlashCommand(text)) return

  const referencesCurrent = /@current\b/i.test(text)
  if (referencesCurrent && !props.currentResource) {
    chatStore.chatError = props.currentResourceNotice || '当前没有可引用的文件或文献库论文'
    return
  }

  const btwMatch = text.match(/^\/btw(?:\s+([\s\S]+))?$/i)
  if (btwMatch) {
    const question = (btwMatch[1] || '').trim()
    if (!question) {
      chatStore.chatError = '请输入 /btw 后面的侧问内容'
      return
    }
    inputText.value = ''
    if (textareaRef.value) textareaRef.value.style.height = 'auto'
    try { await chatStore.askBtw(question) }
    catch (err) { chatStore.chatError = (err as Error).message || '侧问失败' }
    return
  }

  // Push to sent history (deduplicate consecutive)
  if (!sentHistory.value.length || sentHistory.value[sentHistory.value.length - 1] !== text) {
    sentHistory.value.push(text)
  }
  historyIndex.value = -1
  historyDraft.value = ''
  historyDraftSelection.value = null
  autoScroll.value = true
  const editMessageId = editingMessageId.value || undefined
  const editingMsg = editMessageId ? chatStore.messages.find(m => m.id === editMessageId) : null
  const editForkMessageId = typeof editingMsg?.metadata?.forkFromMessageId === 'string'
    ? editingMsg.metadata.forkFromMessageId
    : editMessageId
  inputText.value = ''
  editingMessageId.value = ''
  // Reset textarea height
  if (textareaRef.value) textareaRef.value.style.height = 'auto'
  const sendPromise = chatStore.sendMessage(text, {
    editMessageId,
    editForkMessageId,
    currentResource: referencesCurrent ? props.currentResource || undefined : undefined,
  })
  await nextTick()
  scrollBottom()
  await sendPromise
}

const beginEdit = (msg: any) => {
  if (chatStore.isStreaming || msg.role !== 'user') return
  editingMessageId.value = msg.id
  inputText.value = msg.content
}
const cancelEdit = () => { editingMessageId.value = ''; inputText.value = '' }
const copiedMsgId = ref('')
let copyTimer = 0
const copyText = async (text: string) => {
  try { await copyToClipboard(text) } catch (err) { console.error('Copy failed:', err) }
}
const copyMessage = async (msg: any) => {
  try { await copyToClipboard(msg.content) } catch (err) { console.error('Copy failed:', err) }
  copiedMsgId.value = msg.id
  clearTimeout(copyTimer)
  copyTimer = window.setTimeout(() => { copiedMsgId.value = '' }, 1500)
}
const textareaSelection = () => {
  const el = textareaRef.value
  return {
    start: el?.selectionStart ?? inputText.value.length,
    end: el?.selectionEnd ?? inputText.value.length,
  }
}

const setTextareaSelection = (start: number, end = start) => {
  nextTick(() => textareaRef.value?.setSelectionRange(start, end))
}

const onKeydown = (e: KeyboardEvent) => {
  if (e.key === 'Tab') {
    if (suggestions.value.length) { e.preventDefault(); applySelectedSuggestion() }
    return
  }
  if (e.key === 'ArrowDown' && suggestions.value.length) {
    e.preventDefault()
    selectedSuggestion.value = (selectedSuggestion.value + 1) % suggestions.value.length
    return
  }
  if (e.key === 'ArrowUp' && suggestions.value.length) {
    e.preventDefault()
    selectedSuggestion.value = (selectedSuggestion.value - 1 + suggestions.value.length) % suggestions.value.length
    return
  }
  // Sent-message history navigation (only when no suggestions visible).
  // Let the textarea keep normal multi-line cursor movement unless the caret is
  // already at the very beginning, or we are already browsing message history.
  if (e.key === 'ArrowUp' && !suggestions.value.length && sentHistory.value.length) {
    const selection = textareaSelection()
    const canEnterHistory = historyIndex.value >= 0 || (selection.start === 0 && selection.end === 0)
    if (!canEnterHistory) return

    e.preventDefault()
    if (historyIndex.value === -1) {
      historyDraft.value = inputText.value
      historyDraftSelection.value = selection
      historyIndex.value = sentHistory.value.length - 1
    } else if (historyIndex.value > 0) {
      historyIndex.value--
    } else {
      return  // already at oldest
    }
    inputText.value = sentHistory.value[historyIndex.value]
    setTextareaSelection(inputText.value.length)
    return
  }
  if (e.key === 'ArrowDown' && !suggestions.value.length && historyIndex.value >= 0) {
    e.preventDefault()
    if (historyIndex.value < sentHistory.value.length - 1) {
      historyIndex.value++
      inputText.value = sentHistory.value[historyIndex.value]
      setTextareaSelection(inputText.value.length)
    } else {
      // Exit history mode, restore draft and caret selection.
      const selection = historyDraftSelection.value
      historyIndex.value = -1
      inputText.value = historyDraft.value
      historyDraft.value = ''
      historyDraftSelection.value = null
      setTextareaSelection(selection?.start ?? inputText.value.length, selection?.end ?? selection?.start ?? inputText.value.length)
    }
    return
  }
  // Any other key resets history navigation (except modifiers)
  if (historyIndex.value >= 0 && !['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) {
    historyIndex.value = -1
    historyDraft.value = ''
    historyDraftSelection.value = null
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    if (suggestions.value.length) { e.preventDefault(); applySelectedSuggestion(); return }
    e.preventDefault(); send()
  }
  if (e.key === 'Escape' && suggestions.value.length) {
    inputText.value = ''
  }
  if (e.key === 'c' && e.ctrlKey && !window.getSelection()?.toString()) {
    inputText.value = ''
  }
}

// ── Markdown ────────────────────────────────────────────────────────────────


const messageSegments = (msg: any) => {
  const stored = Array.isArray(msg.metadata?.segments) ? msg.metadata.segments.filter(Boolean) : []
  if (stored.length) {
    if (!stored.some((s: any) => s.type === 'text' || s.type === 'error') && msg.content) {
      return [...stored, { type: msg.content.startsWith('❌') ? 'error' : 'text', text: msg.content }]
    }
    return stored
  }
  const fallback = []
  if (msg.content) fallback.push({ type: msg.content.startsWith('❌') ? 'error' : 'text', text: msg.content })
  for (const tc of (msg.toolCalls || [])) fallback.push({ type: 'tool', toolCallId: tc.id })
  return fallback.length ? fallback : []
}

const toolForSegment = (msg: any, seg: any) => (msg.toolCalls || []).find((tc: any) => tc.id === seg.toolCallId)
// The provider does not expose its tokenizer here; use a conservative
// character-based estimate while tool JSON is still being streamed.
const toolInputTokens = (tc: any) => Math.max(1, Math.ceil(Array.from(String(tc?.inputText || '')).length / 4))
const formatToolInputTokens = (tc: any) => {
  const tokens = toolInputTokens(tc)
  if (tokens < 1000) return `${tokens} tokens`
  const units = ['k', 'm', 'b', 't']
  let value = tokens
  let unit = ''
  for (const nextUnit of units) {
    value /= 1000
    unit = nextUnit
    if (value < 1000 || nextUnit === units[units.length - 1]) break
  }
  const formatted = value >= 100 ? Math.round(value).toString() : value.toFixed(1).replace(/\.0$/, '')
  return `${formatted}${unit} tokens`
}
const isSubagentTool = (tc: any) => tc?.name === 'subagent'
const subagentMode = (tc: any) => {
  const input = tc?.input || {}
  if (Array.isArray(input.chain)) return 'chain'
  if (Array.isArray(input.tasks)) return 'parallel'
  return input.agent ? 'single' : (input.action || 'subagent')
}
const subagentItems = (tc: any): Array<{ label: string; detail: string }> => {
  const input = tc?.input || {}
  if (Array.isArray(input.tasks)) return input.tasks.map((task: any, i: number) => ({ label: task.agent || `task ${i + 1}`, detail: task.task || task.action || '' }))
  if (Array.isArray(input.chain)) return input.chain.map((step: any, i: number) => {
    if (Array.isArray(step.parallel)) return { label: `parallel ${i + 1}`, detail: step.parallel.map((p: any) => p.agent).filter(Boolean).join(', ') }
    return { label: step.agent || step.phase || `step ${i + 1}`, detail: step.task || '' }
  })
  return [{ label: input.agent || input.action || 'subagent', detail: input.task || '' }]
}
const subagentRunId = (tc: any) => {
  const result = String(tc?.result || '')
  // Match run ID in square brackets: [abc123]
  const bracketMatch = result.match(/\[([a-zA-Z0-9_-]{6,})\]/)
  if (bracketMatch) return bracketMatch[1]
  // Fallback: match "run id:" or "id:" prefix
  const prefixMatch = result.match(/(?:run id|id|运行 ID)[:：]?\s*([a-zA-Z0-9_-]{6,})/i)
  return prefixMatch?.[1] || ''
}
const extractRunId = subagentRunId

const subagentResultExpanded = ref(new Set<string>())
const toggleSubagentResult = (id: string) => {
  if (!id) return
  if (subagentResultExpanded.value.has(id)) subagentResultExpanded.value.delete(id)
  else subagentResultExpanded.value.add(id)
}

const subagentStatus = (tc: any) => {
  // Check live status from activeSubagentRuns first
  const runId = extractRunId(tc)
  if (runId && chatStore.activeSubagentRuns[runId]) {
    const live = chatStore.activeSubagentRuns[runId]
    if (live.status === 'completed') return 'completed'
    if (live.status === 'failed') return 'failed'
    if (live.status === 'running') return 'running'
  }
  // Parse from result text (only explicit terminal states)
  const result = String(tc?.result || '')
  if (result.includes('failed') || result.includes('❌')) return 'failed'
  if (result.includes('cancelled') || result.includes('🛑')) return 'cancelled'
  if (result.includes('needs_attention') || result.includes('⚠')) return 'needs_attention'
  // Sync runs: has result text but no async marker → completed immediately
  if (result.trim() && !result.includes('Async:')) return 'completed'
  // Async run with no live tracking data yet → pending (don't assume running)
  if (result.includes('Async:')) return 'pending'
  if (result.trim()) return 'completed'
  return 'unknown'
}

const subagentStatusLabel = (tc: any) => {
  const status = subagentStatus(tc)
  return { completed: '✅ 完成', failed: '❌ 失败', running: '⏳ 运行中', cancelled: '🛑 已取消', needs_attention: '⚠ 需关注', pending: '⏳ 加载中…', unknown: '' }[status] || ''
}

const subagentAction = async (runId: string, action: string) => {
  try {
    const api = (await import('@/composables/useApi')).useApi()
    const result = await api.subagentAction(runId, action, {
      conversationId: chatStore.currentConvId,
      branchId: chatStore.currentBranchId,
    })
    // Show result as notification or add to message
    if (result.result) {
      chatStore.chatError = ''
      // For status action, show as a notification
      window.dispatchEvent(new CustomEvent('yarc-sse-event', {
        detail: {
          type: 'agent_interaction_request',
          requestId: `subagent-${runId}-${Date.now()}`,
          conversationId: chatStore.currentConvId,
          streamMessageId: '',
          kind: 'notification',
          title: `Subagent ${action}`,
          message: result.result.slice(0, 500),
          payload: { message: result.result, notifyType: 'info' },
          createdAt: new Date().toISOString(),
        },
      }))
    }
  } catch (err) {
    chatStore.chatError = (err as Error).message || `subagent ${action} 失败`
  }
}

const appendStepPrompt = async (runId: string) => {
  const agent = window.prompt('Agent 名称（如 worker, reviewer）：')
  if (!agent) return
  const task = window.prompt('任务描述：')
  if (!task) return
  try {
    const api = (await import('@/composables/useApi')).useApi()
    const result = await api.subagentAction(runId, 'append-step', {
      conversationId: chatStore.currentConvId,
      branchId: chatStore.currentBranchId,
      agent,
      task,
    })
    if (result.result) {
      window.dispatchEvent(new CustomEvent('yarc-sse-event', {
        detail: {
          type: 'agent_interaction_request',
          requestId: `subagent-${runId}-${Date.now()}`,
          conversationId: chatStore.currentConvId,
          streamMessageId: '',
          kind: 'notification',
          title: '追加步骤',
          message: result.result.slice(0, 500),
          payload: { message: result.result, notifyType: 'info' },
          createdAt: new Date().toISOString(),
        },
      }))
    }
  } catch (err) {
    chatStore.chatError = (err as Error).message || '追加步骤失败'
  }
}

const formatToolName = (tc: any): string => {
  if (!tc) return ''
  const name: string = tc.name || ''
  // Detect skill reads: tool 'read' with path matching */skills/<name>/SKILL.md
  if (name === 'read') {
    const raw = tc.input?.path || tc.input?.file_path || ''
    const m = String(raw).match(/skills\/([^/]+)\/SKILL\.md$/)
    if (m) return `📖 Skill: ${m[1]}`
  }
  return name
}
const isPlaceholderSegment = (seg: any) => !!seg.placeholder
// Same lifetime as the stop button: visible for the whole active stream (isStreaming),
// not only before the first text/tool segment appears.
const isStreamingMsg = (msg: any) => chatStore.isStreaming && chatStore.streamingMessageId === msg.id

const currentConvTitle = computed(() => chatStore.conversations.find(c => c.id === chatStore.currentConvId)?.title || '新对话')

const formatTokenCount = (value: number | null | undefined) => {
  if (value === null || value === undefined) return '?'
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`
  return String(value)
}
const contextUsageLabel = computed(() => {
  const usage = chatStore.currentContextUsage
  if (!usage) return ''
  const tokens = formatTokenCount(usage.tokens)
  const windowSize = usage.contextWindow ? formatTokenCount(usage.contextWindow) : ''
  const percent = usage.percent === null || usage.percent === undefined ? '' : ` · ${usage.percent.toFixed(1)}%`
  return windowSize ? `${tokens}/${windowSize}${percent}` : tokens
})
const contextUsageTitle = computed(() => {
  const usage = chatStore.currentContextUsage
  if (!usage) return ''
  const tokenText = usage.tokens === null ? '未知' : usage.tokens.toLocaleString()
  const windowText = usage.contextWindow ? usage.contextWindow.toLocaleString() : '未知'
  const percentText = usage.percent === null || usage.percent === undefined ? '未知' : `${usage.percent.toFixed(2)}%`
  return `当前分支上下文 token：${tokenText} / ${windowText}（${percentText}）`
})

// Extract session state from the latest assistant message that has it
const sessionState = computed(() => {
  const msgs = chatStore.messages
  if (!msgs?.length) return null
  for (let i = msgs.length - 1; i >= 0; i--) {
    const state = msgs[i].metadata?.sessionState
    if (state?.model) return state
  }
  return null
})
</script>

<template>
  <div class="chat" :class="{ 'bg-active': !!theme.backgroundImage }">
    <AgentInteractionHost />
    <aside v-if="chatStore.btwPanelOpen" class="btw-panel">
      <header class="btw-header">
        <div>
          <strong>/btw 侧问</strong>
          <span>不写入主对话</span>
        </div>
        <button class="icon-mini" title="清空" @click="chatStore.clearBtwItems()">清空</button>
        <button class="icon-mini" title="关闭" @click="chatStore.btwPanelOpen = false">✕</button>
      </header>
      <div class="btw-list">
        <article v-for="item in chatStore.btwItems" :key="item.id" class="btw-item">
          <div class="btw-question">{{ item.question }}</div>
          <div v-if="item.loading" class="btw-loading">
            <span>Agent 正在侧问中…</span>
            <button v-if="item.runId" class="btw-cancel-btn" @click="chatStore.cancelBtw(item.runId)">取消</button>
          </div>
          <div v-else-if="item.error" class="btw-error">❌ {{ item.error }}</div>
          <div v-else-if="item.cancelled" class="btw-cancelled">已取消</div>
          <details v-if="item.thinking" class="btw-thinking"><summary>思考记录</summary><pre>{{ item.thinking }}</pre></details>
          <MarkdownContent v-if="item.answer" class="btw-answer" :content="item.answer" />
          <div v-if="!item.loading && item.answer && !item.error" class="btw-actions">
            <button class="btw-action-btn" @click="chatStore.insertBtwAnswer(item.runId || item.id)" title="插入输入框">📋 插入</button>
            <button class="btw-action-btn" @click="chatStore.sendBtwAsMainMessage(item.runId || item.id)" title="作为主消息发送">💬 发送</button>
            <button class="btw-action-btn" @click="copyText(item.answer)" title="复制">📄 复制</button>
          </div>
        </article>
        <div v-if="!chatStore.btwItems.length" class="btw-empty">暂无侧问。输入 /btw 问题 即可开始。</div>
      </div>
    </aside>
    <!-- Header -->
    <div ref="headerRef" class="chat-header">
      <div class="conv-selector">
        <div v-if="chatStore.uiHeaderLines.length" class="ui-header-banner">
          <span v-for="(line, i) in chatStore.uiHeaderLines" :key="i">{{ line }}</span>
        </div>
        <button class="conv-trigger" @click="convMenuOpen = !convMenuOpen">
          <span class="conv-trigger-title">{{ currentConvTitle }}</span>
          <svg class="conv-trigger-chevron" :class="{ open: convMenuOpen }" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
        </button>
        <Transition name="dropdown">
          <div v-if="convMenuOpen" class="conv-dropdown">
            <div class="conv-dropdown-header">
              <span class="conv-dropdown-title">对话列表</span>
              <button class="conv-new-btn" @click="chatStore.createConversation(); convMenuOpen = false">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              </button>
            </div>
            <TransitionGroup tag="div" name="conv" class="conv-list">
              <div v-for="c in chatStore.conversations" :key="c.id" class="conv-item" :class="{ active: c.id === chatStore.currentConvId }" @click="chatStore.selectConversation(c.id); convMenuOpen = false">
                <div class="conv-item-info" v-if="renamingConvId !== c.id">
                  <span class="conv-item-title">{{ c.title }}</span>
                  <span class="conv-item-time">{{ new Date(c.updatedAt).toLocaleDateString() }}</span>
                </div>
                <div class="conv-item-rename" v-else @click.stop>
                  <input v-model="renameText" class="conv-rename-input" @keydown.enter="commitRename" @keydown.escape="renamingConvId = null" @blur="commitRename" autofocus />
                </div>
                <div class="conv-item-actions" v-if="renamingConvId !== c.id" @click.stop>
                  <button class="conv-action-btn" @click="startRename(c.id)"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg></button>
                  <button class="conv-action-btn danger" @click="deleteConv(c.id)"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
                </div>
              </div>
              <div v-if="!chatStore.conversations.length" key="empty" class="conv-list-empty">暂无对话</div>
            </TransitionGroup>
          </div>
        </Transition>
      </div>
      <div class="chat-header-actions">
        <div v-if="contextUsageLabel" class="session-state">
          <span class="state-context" :title="contextUsageTitle">CTX {{ contextUsageLabel }}</span>
        </div>
        <button class="tb-btn" @click="chatStore.createConversation()" title="新对话"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></button>
        <button class="tb-btn" @click="emit('close')" title="关闭"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      </div>
    </div>

    <!-- Messages -->
    <div class="chat-messages-wrap">
    <!-- UI Context widgets (above) -->
    <template v-for="(widget, key) in chatStore.uiWidgets" :key="key">
      <div v-if="widget.placement === 'above' && widget.lines.length" class="ui-widget">
        <span v-for="(line, i) in widget.lines" :key="i">{{ line }}</span>
      </div>
    </template>
    <div ref="container" class="chat-messages" @scroll="onScroll">
      <div v-if="!chatStore.messages?.length" class="chat-empty">
        <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="empty-icon"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>
        <p>开始新对话</p>
      </div>

      <div v-for="msg in chatStore.messages" :key="msg.id" class="msg" :class="msg.role">
        <div v-if="msg.metadata?.context" class="msg-context" @click="toggleCtxExpanded(msg.id)">
          <span class="msg-context-summary">🧩 {{ contextSummary(msg) }}</span>
          <span class="msg-context-toggle">{{ ctxExpandedSet.has(msg.id) ? '▾' : '▸' }}</span>
        </div>
        <div v-if="ctxExpandedSet.has(msg.id) && msg.metadata?.context" class="msg-context-detail">
          <template v-if="contextItems(msg).length">
            <div v-for="(item, idx) in contextItems(msg)" :key="idx" class="ctx-item-line">
              <span class="ctx-item-icon">{{ contextIcon(item.type) }}</span>
              <span>{{ item.label }}</span>
            </div>
          </template>
          <template v-else>
            <div v-if="msg.metadata.context.paperId">论文: {{ msg.metadata.context.paperId }}</div>
            <div v-if="msg.metadata.context.selectedText">选中: "{{ msg.metadata.context.selectedText }}"</div>
          </template>
        </div>
        <details v-if="msg.metadata?.thinking" class="msg-thinking"><summary>💭 思考记录</summary><div>{{ msg.metadata.thinking }}</div></details>

        <!-- Compaction summary -->
        <details v-if="msg.metadata?.isCompaction" class="msg-compaction">
          <summary>📦 上下文已压缩</summary>
          <div>{{ msg.metadata.compactionSummary }}</div>
        </details>

        <!-- Error message -->
        <div v-if="msg.metadata?.isError && msg.metadata?.errorMessage" class="msg-error">
          ❌ {{ msg.metadata.errorMessage }}
        </div>

        <!-- Stop reason indicator (only for non-standard stops) -->
        <div v-if="msg.metadata?.stopReason && !['stop', 'toolUse'].includes(msg.metadata.stopReason)" class="msg-stop-reason">
          <template v-if="msg.metadata.stopReason === 'error'">⚠️ 生成出错</template>
          <template v-else-if="msg.metadata.stopReason === 'length'">✂️ 达到长度限制</template>
          <template v-else-if="msg.metadata.stopReason === 'aborted'">🛑 已中止</template>
          <template v-else>⏹️ {{ msg.metadata.stopReason }}</template>
        </div>

        <template v-for="(seg, i) in messageSegments(msg)" :key="`${msg.id}-${i}`">
          <details v-if="seg.type === 'tool' && toolForSegment(msg, seg)" class="msg-tool" :class="{ subagent: isSubagentTool(toolForSegment(msg, seg)) }" :open="isSubagentTool(toolForSegment(msg, seg)) || chatStore.toolsExpanded">
            <summary>🔧 {{ formatToolName(toolForSegment(msg, seg)) }}<span v-if="toolForSegment(msg, seg)?.inputText" class="tool-progress"> · {{ formatToolInputTokens(toolForSegment(msg, seg)) }}</span></summary>
            <template v-if="isSubagentTool(toolForSegment(msg, seg))">
              <div class="subagent-card">
                <div class="subagent-meta">
                  <span class="subagent-mode">{{ subagentMode(toolForSegment(msg, seg)) }}</span>
                  <span v-if="subagentRunId(toolForSegment(msg, seg))" class="subagent-run-id">Run: {{ subagentRunId(toolForSegment(msg, seg)) }}</span>
                  <span class="subagent-status-badge" :class="subagentStatus(toolForSegment(msg, seg))">{{ subagentStatusLabel(toolForSegment(msg, seg)) }}</span>
                  <span v-if="subagentStatus(toolForSegment(msg, seg)) === 'running' && chatStore.activeSubagentRuns[subagentRunId(toolForSegment(msg, seg))]?.currentTool" class="subagent-current-tool">
                    🔧 {{ chatStore.activeSubagentRuns[subagentRunId(toolForSegment(msg, seg))].currentTool }}
                  </span>
                </div>
                <ol class="subagent-tree">
                  <li v-for="(item, idx) in subagentItems(toolForSegment(msg, seg))" :key="idx">
                    <strong>{{ item.label }}</strong>
                    <small v-if="item.detail">{{ item.detail }}</small>
                  </li>
                </ol>
                <div v-if="toolForSegment(msg, seg)?.result" class="tool-result subagent-result" :class="{ collapsed: !subagentResultExpanded.has(toolForSegment(msg, seg)?.id) }" @click="toggleSubagentResult(toolForSegment(msg, seg)?.id)">
                  {{ toolForSegment(msg, seg)?.result }}
                </div>
                <div v-if="subagentRunId(toolForSegment(msg, seg))" class="subagent-controls">
                  <button class="subagent-ctrl-btn" @click="subagentAction(subagentRunId(toolForSegment(msg, seg)), 'status')" title="查看状态">🔄 状态</button>
                  <button class="subagent-ctrl-btn" @click="subagentAction(subagentRunId(toolForSegment(msg, seg)), 'interrupt')" title="中断">⏸ 中断</button>
                  <button class="subagent-ctrl-btn" @click="subagentAction(subagentRunId(toolForSegment(msg, seg)), 'resume')" title="恢复">▶ 恢复</button>
                  <button v-if="subagentMode(toolForSegment(msg, seg)) === 'chain'" class="subagent-ctrl-btn" @click="appendStepPrompt(subagentRunId(toolForSegment(msg, seg)))" title="追加步骤">➕ 追加步骤</button>
                </div>
              </div>
            </template>
            <template v-else>
              <div v-if="!toolForSegment(msg, seg)?.inputText" class="tool-input">{{ JSON.stringify(toolForSegment(msg, seg)?.input) }}</div>
              <div v-if="toolForSegment(msg, seg)?.result" class="tool-result">{{ toolForSegment(msg, seg)?.result }}</div>
            </template>
          </details>
          <MarkdownContent v-else-if="seg.type === 'error'" class="msg-body error" :content="seg.text || ''" />
          <MarkdownContent v-else-if="seg.type === 'compaction'" class="msg-body compaction" :content="seg.text || ''" />
          <MarkdownContent v-else class="msg-body" :class="{ placeholder: isPlaceholderSegment(seg) }" :content="seg.text || ''" />
        </template>

        <div v-if="isStreamingMsg(msg)" class="typing-indicator"><span /><span /><span /></div>

        <div v-if="msg.metadata?.citations?.length" class="msg-cites">
          <button v-for="(c, i) in msg.metadata.citations" :key="i" class="cite-btn">📖 第{{ c.pageNumber }}页</button>
        </div>

        <!-- User actions: branch switcher (left) + copy & edit (right) -->
        <div v-if="msg.role === 'user'" class="msg-actions">
          <div v-if="!msg.metadata?.pending && getForkInfo(msg.id).hasFork" class="branch-switcher">
            <button @click="switchToBranch(msg.id, -1)" :disabled="getForkDisplayIndex(msg.id) <= 1">‹</button>
            <span>{{ getForkDisplayIndex(msg.id) }}/{{ getForkInfo(msg.id).children.length }}</span>
            <button @click="switchToBranch(msg.id, 1)" :disabled="getForkDisplayIndex(msg.id) >= getForkInfo(msg.id).children.length">›</button>
          </div>
          <span class="msg-actions-right">
            <button class="msg-action-btn" @click="copyMessage(msg)" title="复制">
              <svg v-if="copiedMsgId !== msg.id" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
              <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
            </button>
            <button v-if="!msg.metadata?.pending" class="msg-action-btn" @click="beginEdit(msg)" title="修改">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>
            </button>
          </span>
        </div>
        <!-- Assistant actions: copy (left) -->
        <div v-else-if="msg.role === 'assistant' && (msg.content || msg.toolCalls?.length)" class="msg-actions">
          <button class="msg-action-btn" @click="copyMessage(msg)" title="复制">
            <svg v-if="copiedMsgId !== msg.id" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
          </button>
        </div>
      </div>

      <!-- Placeholder dots only before stream_start attaches an assistant message -->
      <div v-if="chatStore.isStreaming && !chatStore.messages?.some(m => isStreamingMsg(m))" class="msg assistant">
        <div class="typing-indicator"><span /><span /><span /></div>
      </div>
      <div style="min-height: 32px" />

    </div>
    <Transition name="fade">
      <button v-if="!autoScroll" class="scroll-bottom-btn" @click="scrollBottom" style="left: auto; right: 12px;">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
      </button>
    </Transition>
    </div>

    <!-- Input -->
    <div class="chat-input-area">
      <div v-if="Object.keys(chatStore.uiStatus).length" class="ui-status-bar">
        <template v-for="(statusText, statusKey) in chatStore.uiStatus" :key="statusKey">
          <span v-if="statusText" class="ui-status-item">
            <strong>{{ statusKey }}:</strong> {{ statusText }}
          </span>
        </template>
      </div>
      <!-- UI Context widgets (below) -->
      <template v-for="(widget, key) in chatStore.uiWidgets" :key="key">
        <div v-if="widget.placement === 'below' && widget.lines.length" class="ui-widget">
          <span v-for="(line, i) in widget.lines" :key="i">{{ line }}</span>
        </div>
      </template>
      <div v-if="chatStore.pdfContext" class="context-badge">
        <span>📄 {{ chatStore.pdfContext.documentTitle || currentPaperTitle || (chatStore.pdfContext.temporaryPdf ? '临时 PDF' : '论文') }} · 第{{ chatStore.pdfContext.pageNumber }}页</span>
        <button @click="chatStore.pdfContext = null">✕</button>
      </div>
      <div v-if="props.currentResourceNotice" class="context-badge">
        <span>⏳ {{ props.currentResourceNotice }}</span>
      </div>
      <div v-if="chatStore.chatError" class="chat-error">
        <span>{{ chatStore.chatError }}</span>
        <button @click="chatStore.chatError = ''">✕</button>
      </div>
      <div v-if="editingMessageId" class="edit-badge">
        <span>修改消息后将创建新分支</span>
        <button @click="cancelEdit">取消</button>
      </div>
      <div v-if="suggestions.length && !paperPickerOpen" class="command-palette">
        <button
          v-for="(item, i) in suggestions"
          :key="item.label + item.insert"
          type="button"
          class="command-option"
          :class="{ active: i === selectedSuggestion }"
          @click="applySuggestion(item)"
        >
          <span :class="`suggestion-${item.type}`">{{ item.label }}</span>
          <small>{{ item.hint }}</small>
        </button>
      </div>
      <div v-if="paperPickerOpen" class="paper-picker">
        <input v-model="paperPickerQuery" placeholder="搜索论文…" class="paper-picker-input" autofocus @keydown.escape="paperPickerOpen = false" />
        <div class="paper-picker-list">
          <button v-for="p in paperPickerResults" :key="p.id" class="paper-picker-item" @click="selectPaper(p)">
            <span class="paper-picker-title">
              {{ p.title }}
              <span v-if="p.id === chatStore.pdfContext?.paperId" class="paper-picker-current">当前</span>
            </span>
            <span class="paper-picker-meta">{{ p.authors.slice(0, 2).join(', ') }}{{ p.year ? ` · ${p.year}` : '' }}</span>
          </button>
          <div v-if="!paperPickerResults.length" class="paper-picker-empty">未找到论文</div>
        </div>
      </div>

      <div class="input-row">
        <textarea ref="textareaRef" v-model="inputText" @keydown="onKeydown" placeholder="输入消息…" rows="1" class="chat-textarea" />
        <button v-if="chatStore.isStreaming" class="send-btn stop" @click="chatStore.stopStreaming()"><span>■</span></button>
        <button v-else class="send-btn" :disabled="!inputText.trim()" @click="send">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
        </button>
      </div>
      <div class="input-footer">
        <ModelSelector ref="modelSelectorRef" :model-value="chatStore.currentModel" :models="chatStore.models" :disabled="!chatStore.models.length" @update:model-value="chatStore.setCurrentModel($event)" />
        <ReasoningEffort v-if="currentModelReasoning" :model-value="chatStore.reasoningEffort" :levels="currentModelLevels" @update:model-value="chatStore.setReasoningEffort($event)" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.chat { position: relative; display: flex; flex-direction: column; height: 100%; min-height: 0; }
.btw-panel { position: absolute; top: 52px; right: 12px; bottom: 92px; z-index: 35; width: min(420px, calc(100% - 24px)); display: flex; flex-direction: column; border: 1px solid var(--color-border); border-radius: var(--radius); background: var(--color-bg-card); box-shadow: 0 18px 60px rgba(0,0,0,0.18); overflow: hidden; }
.btw-header { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--color-border); background: var(--color-bg-muted); }
.btw-header div { flex: 1; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.btw-header strong { font-size: 13px; }
.btw-header span { font-size: 11px; color: var(--color-text-muted); }
.icon-mini { padding: 4px 8px; border: 1px solid var(--color-border); border-radius: var(--radius-sm); background: var(--color-bg-card); color: var(--color-text-secondary); cursor: pointer; font-size: 12px; }
.icon-mini:hover { color: var(--color-primary); border-color: var(--color-primary); }
.btw-list { flex: 1; min-height: 0; overflow: auto; padding: 10px; display: flex; flex-direction: column; gap: 10px; }
.btw-item { padding: 10px 12px; border: 1px solid var(--color-border); border-radius: var(--radius-sm); background: var(--color-bg); }
.btw-question { font-size: 13px; font-weight: 600; line-height: 1.45; margin-bottom: 8px; }
.btw-loading, .btw-empty { color: var(--color-text-muted); font-size: 12px; display: flex; align-items: center; gap: 8px; }
.btw-error { color: var(--color-error); font-size: 12px; }
.btw-cancelled { color: var(--color-text-muted); font-size: 12px; font-style: italic; }
.btw-cancel-btn { padding: 3px 8px; border: 1px solid var(--color-error); background: transparent; color: var(--color-error); border-radius: var(--radius-sm); font-size: 11px; cursor: pointer; }
.btw-cancel-btn:hover { background: rgba(239,68,68,0.1); }
.btw-actions { display: flex; gap: 6px; margin-top: 8px; }
.btw-action-btn { padding: 4px 8px; border: 1px solid var(--color-border); background: var(--color-bg-card); color: var(--color-text-secondary); border-radius: var(--radius-sm); font-size: 11px; cursor: pointer; }
.btw-action-btn:hover { color: var(--color-primary); border-color: var(--color-primary); }
.btw-thinking { margin-bottom: 8px; font-size: 12px; color: var(--color-text-muted); }
.btw-thinking pre { white-space: pre-wrap; overflow-wrap: anywhere; margin: 6px 0 0; padding: 8px; background: var(--color-bg-muted); border-radius: var(--radius-sm); }
.btw-answer { font-size: 13px; line-height: 1.6; color: var(--color-text); }
.btw-answer :deep(p) { margin: 0 0 8px; }
.btw-answer :deep(p:last-child) { margin-bottom: 0; }
.chat-header { height: 44px; display: flex; align-items: center; justify-content: space-between; gap: 6px; padding: 0 8px; border-bottom: 1px solid var(--color-border); flex-shrink: 0; position: relative; z-index: 20; }
.chat-header-actions { display: flex; gap: 2px; flex-shrink: 0; }
.conv-selector { flex: 1; min-width: 0; }
.conv-trigger { display: flex; align-items: center; gap: 6px; padding: 7px 8px; border: none; background: transparent; color: var(--color-text); cursor: pointer; border-radius: var(--radius-sm); width: 100%; }
.conv-trigger:hover { background: var(--color-bg-muted); }
.conv-trigger-title { flex: 1; min-width: 0; font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; }
.conv-trigger-chevron { flex-shrink: 0; transition: transform 0.15s; opacity: 0.5; }
.conv-trigger-chevron.open { transform: rotate(180deg); }
.conv-dropdown { position: absolute; top: calc(100% + 4px); left: 8px; width: 84%; max-height: 600px; background: var(--color-bg-card); border: 1px solid var(--color-border); border-radius: var(--radius); box-shadow: 0 8px 24px rgba(0,0,0,0.12); display: flex; flex-direction: column; overflow: hidden; z-index: 50; box-sizing: border-box; }
.conv-dropdown-header { display: flex; align-items: center; justify-content: space-between; margin: 4px 4px 0; padding: 8px 10px; border-radius: var(--radius-sm); }
.conv-dropdown-title { font-size: 12px; font-weight: 600; color: var(--color-text-secondary); text-transform: uppercase; letter-spacing: 0.04em; }
.conv-new-btn { width: 24px; height: 24px; display: flex; align-items: center; justify-content: center; border: 1px solid var(--color-border); background: var(--color-bg); color: var(--color-text-secondary); border-radius: var(--radius-sm); cursor: pointer; }
.conv-new-btn:hover { color: var(--color-primary); border-color: var(--color-primary); }
.conv-list { overflow-y: auto; padding: 4px; flex: 1; position: relative; }
.conv-enter-active, .conv-leave-active, .conv-move { transition: opacity 0.26s ease, transform 0.26s cubic-bezier(0.4, 0, 0.2, 1); }
.conv-enter-from { opacity: 0; transform: translateY(-6px); }
.conv-leave-to { opacity: 0; transform: translateX(-12px); }
.conv-leave-active { position: absolute; left: 4px; right: 4px; }
.conv-item { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: var(--radius-sm); cursor: pointer; transition: background var(--transition), transform var(--transition); }
.conv-item:hover { background: var(--color-bg-muted); transform: translateX(2px); }
.conv-item.active { background: var(--color-primary-soft); }
.conv-item-info { flex: 1; min-width: 0; }
.conv-item-title { display: block; font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.conv-item-time { display: block; font-size: 11px; color: var(--color-text-muted); margin-top: 1px; }
.conv-item-rename { flex: 1; min-width: 0; }
.conv-rename-input { width: 100%; padding: 3px 6px; border: 1px solid var(--color-primary); border-radius: var(--radius-sm); background: var(--color-bg); color: var(--color-text); font-size: 13px; outline: none; }
.conv-item-actions { display: flex; gap: 2px; opacity: 0; transition: opacity 0.15s; }
.conv-item:hover .conv-item-actions { opacity: 1; }
.conv-action-btn { width: 22px; height: 22px; display: flex; align-items: center; justify-content: center; border: none; background: transparent; color: var(--color-text-muted); border-radius: var(--radius-sm); cursor: pointer; }
.conv-action-btn:hover { background: var(--color-bg-muted); color: var(--color-text); }
.conv-action-btn.danger:hover { color: var(--color-error); }
.conv-list-empty { padding: 20px 12px; text-align: center; font-size: 13px; color: var(--color-text-muted); }
.dropdown-enter-active { transition: all 0.15s; }
.dropdown-leave-active { transition: all 0.1s; }
.dropdown-enter-from, .dropdown-leave-to { opacity: 0; transform: translateY(-4px); }
.tb-btn { width: 30px; height: 30px; display: flex; align-items: center; justify-content: center; border: none; background: transparent; color: var(--color-text-secondary); border-radius: var(--radius-sm); cursor: pointer; }
.tb-btn:hover { background: var(--color-bg-muted); color: var(--color-text); }

.session-state { display: flex; align-items: center; gap: 6px; margin-right: 8px; }
.state-model { font-size: 11px; color: var(--color-text-muted); padding: 2px 8px; background: var(--color-bg-muted); border-radius: 999px; max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.state-thinking { font-size: 10px; color: var(--color-primary); padding: 2px 6px; background: rgba(99,102,241,0.1); border-radius: 999px; }
.state-context { font-size: 10px; color: var(--color-text-secondary); padding: 2px 6px; background: var(--color-bg-muted); border-radius: 999px; white-space: nowrap; }
.chat-messages-wrap { position: relative; flex: 1; min-height: 0; }
.chat-messages { position: absolute; inset: 0; overflow-y: auto; overflow-x: hidden; padding: 16px; display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.scroll-bottom-btn { position: absolute; bottom: 8px; left: 12px; width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; border: 1px solid var(--color-border); background: var(--color-bg-card); color: var(--color-text-secondary); border-radius: 50%; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,0.1); z-index: 5; transition: opacity 0.15s; }
.scroll-bottom-btn:hover { color: var(--color-primary); border-color: var(--color-primary); }
.fade-enter-active, .fade-leave-active { transition: opacity 0.15s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }

.chat-empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; color: var(--color-text-muted); }
.chat-empty .empty-icon { opacity: 0.4; }
.chat-empty p { font-size: 14px; color: var(--color-text-secondary); }
.msg { width: 88%; max-width: 88%; position: relative; min-width: 0; }
.msg > .msg-body, .msg > .msg-tool, .msg > .msg-thinking { margin-top: 6px; }
.msg > .msg-body:first-child, .msg > .msg-tool:first-child { margin-top: 0; }
.msg-body { width: fit-content; max-width: 100%; min-width: 0; box-sizing: border-box; overflow-wrap: anywhere; word-break: break-word; white-space: normal; }
.msg-body :deep(p), .msg-body :deep(li), .msg-body :deep(blockquote), .msg-body :deep(a) { max-width: 100%; overflow-wrap: anywhere; word-break: break-word; }
.msg-body :deep(img), .msg-body :deep(video), .msg-body :deep(iframe) { max-width: 100%; height: auto; }
.msg-body :deep(pre) { max-width: 100%; overflow-x: auto; }
.msg-body :deep(table) { max-width: 100%; overflow-x: auto; }
/* KaTeX display math is intentionally unbroken; keep its scrollbar inside the bubble. */
.msg-body :deep(.katex-display) { max-width: 100%; overflow-x: auto; overflow-y: hidden; }
.msg-body :deep(.katex-display > .katex) { width: max-content; max-width: none; min-width: max-content; }
.msg-body :deep(.katex), .msg-body :deep(.katex *) { overflow-wrap: normal; word-break: normal; }
@keyframes msg-in { from { opacity: 0; transform: translateY(4px); } }
/* Only animate the typing indicator, not regular messages */
.msg.user { align-self: flex-end; display: flex; flex-direction: column; align-items: flex-end; }
.msg.user .msg-body { background: var(--color-primary); color: white; border-radius: var(--radius) var(--radius) 4px var(--radius); padding: 10px 14px; display: inline-block; max-width: 100%; }
.msg-actions { display: flex; align-items: center; gap: 8px; margin-top: 4px; }
.msg-actions-right { display: flex; align-items: center; gap: 4px; margin-left: auto; }
.msg-action-btn { width: 24px; height: 24px; display: flex; align-items: center; justify-content: center; border: 1px solid var(--color-border); background: var(--color-bg-card); color: var(--color-text-muted); border-radius: var(--radius-sm); cursor: pointer; }
.msg-action-btn:hover { color: var(--color-primary); border-color: var(--color-primary); background: var(--color-primary-soft); }
.msg-action-btn svg { width: 12px; height: 12px; }
.branch-switcher { display: flex; align-items: center; gap: 4px; padding: 2px 8px; background: var(--color-bg-muted); border: 1px solid var(--color-border); border-radius: var(--radius-sm); font-size: 11px; color: var(--color-text-muted); }
.branch-switcher button { width: 20px; height: 20px; display: flex; align-items: center; justify-content: center; background: transparent; border: none; color: var(--color-primary); cursor: pointer; font-size: 14px; border-radius: 3px; }
.branch-switcher button:disabled { color: var(--color-text-muted); cursor: default; opacity: 0.4; }
.branch-switcher button:hover:not(:disabled) { background: var(--color-primary-soft); }
.branch-switcher span { font-weight: 500; color: var(--color-text-secondary); }
.msg.assistant { align-self: flex-start; }
.msg.assistant .msg-body { background: var(--color-bg-muted); color: var(--color-text); border-radius: var(--radius) var(--radius) var(--radius) 4px; padding: 10px 14px; border: 1px solid var(--color-border); }
.msg.assistant .msg-body.placeholder { color: var(--color-text-muted); font-style: italic; }
.msg.assistant .msg-body.error { color: var(--color-error); border-color: rgba(239,68,68,0.35); background: rgba(239,68,68,0.08); }
.msg.assistant .msg-body :deep(p) { margin: 0 0 8px; line-height: 1.6; }
.msg.assistant .msg-body :deep(p:last-child) { margin-bottom: 0; }
.msg.assistant .msg-body :deep(h1), .msg.assistant .msg-body :deep(h2), .msg.assistant .msg-body :deep(h3) { font-size: 14px; font-weight: 600; margin: 10px 0 6px; }
.msg.assistant .msg-body :deep(ul), .msg.assistant .msg-body :deep(ol) { padding-left: 18px; margin: 6px 0; }
.msg.assistant .msg-body :deep(code) { background: rgba(0,0,0,0.06); padding: 1px 4px; border-radius: 3px; font-size: 12px; }
.msg.assistant .msg-body :deep(pre) { background: rgba(0,0,0,0.06); padding: 8px 10px; border-radius: var(--radius-sm); overflow-x: auto; margin: 6px 0; overflow-wrap: normal; word-break: normal; }
.msg.assistant .msg-body :deep(pre code) { background: none; padding: 0; overflow-wrap: normal; word-break: normal; }
.msg.assistant .msg-body :deep(blockquote) { border-left: 3px solid var(--color-border); padding-left: 10px; margin: 6px 0; color: var(--color-text-secondary); }
.msg.assistant .msg-body :deep(a) { color: var(--color-primary); text-decoration: underline; }
.msg.assistant .msg-body :deep(table) { border-collapse: collapse; margin: 6px 0; font-size: 12px; }
.msg.assistant .msg-body :deep(th), .msg.assistant .msg-body :deep(td) { border: 1px solid var(--color-border); padding: 4px 8px; }
.msg-context { font-size: 11px; color: var(--color-text-muted); margin-bottom: 4px; padding: 2px 8px; background: var(--color-bg-muted); border-radius: 4px; display: inline-flex; align-items: center; gap: 4px; cursor: pointer; user-select: none; }
.msg-context:hover { background: var(--color-bg-hover); }
.msg-context-toggle { font-size: 10px; opacity: 0.6; }
.msg-context-detail { font-size: 11px; color: var(--color-text-secondary); margin-bottom: 6px; padding: 6px 10px; background: var(--color-bg-muted); border-radius: var(--radius-sm); border-left: 2px solid var(--color-border); white-space: pre-wrap; overflow-wrap: anywhere; }
.ctx-item-line { display: flex; align-items: flex-start; gap: 6px; line-height: 1.45; }
.ctx-item-line + .ctx-item-line { margin-top: 4px; }
.ctx-item-icon { flex: 0 0 auto; }
.msg-thinking, .msg-tool, .msg-compaction { font-size: 12px; margin-bottom: 6px; }
.msg-thinking summary, .msg-tool summary, .msg-compaction summary { cursor: pointer; color: var(--color-text-muted); font-size: 12px; }
.msg-tool .tool-progress { color: var(--color-text-secondary); font-variant-numeric: tabular-nums; }
.msg-thinking > div, .msg-tool > div, .msg-compaction > div { margin-top: 4px; padding: 8px 10px; background: var(--color-bg-muted); border-radius: var(--radius-sm); font-size: 12px; color: var(--color-text-secondary); white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; }
.msg-tool .tool-result { border-left: 2px solid var(--color-primary); opacity: 0.9; }
.msg-tool.subagent > div { border-left: 2px solid #8b5cf6; }
.subagent-card { display: flex; flex-direction: column; gap: 8px; }
.subagent-meta { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.subagent-meta span { padding: 2px 7px; border-radius: 999px; background: rgba(139,92,246,0.12); color: #7c3aed; font-size: 11px; }
.subagent-mode { font-weight: 600; }
.subagent-run-id { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 10px; }
.subagent-current-tool { font-size: 10px; color: #6366f1; background: rgba(99,102,241,0.08); animation: pulse-status 2s ease-in-out infinite; }
.subagent-status-badge.completed { background: rgba(34,197,94,0.12); color: #16a34a; }
.subagent-status-badge.failed { background: rgba(239,68,68,0.12); color: #ef4444; }
.subagent-status-badge.running { background: rgba(59,130,246,0.12); color: #3b82f6; animation: pulse-status 2s ease-in-out infinite; }
.subagent-status-badge.cancelled { background: rgba(156,163,175,0.12); color: #6b7280; }
.subagent-status-badge.needs_attention { background: rgba(245,158,11,0.12); color: #b45309; }
.subagent-status-badge.pending { background: rgba(156,163,175,0.08); color: #9ca3af; animation: pulse-status 2s ease-in-out infinite; }
@keyframes pulse-status { 0%, 100% { opacity: 1; } 50% { opacity: 0.6; } }
.subagent-tree { margin: 0; padding-left: 18px; }
.subagent-tree li + li { margin-top: 6px; }
.subagent-tree strong { display: block; color: var(--color-text); font-size: 12px; }
.subagent-tree small { display: block; color: var(--color-text-secondary); line-height: 1.45; }
.subagent-result { max-height: 360px; overflow: auto; cursor: pointer; }
.subagent-result.collapsed { max-height: 120px; position: relative; }
.subagent-result.collapsed::after { content: '▼ 展开'; position: absolute; bottom: 0; left: 0; right: 0; padding: 4px 8px; background: linear-gradient(transparent, var(--color-bg-muted)); font-size: 11px; color: var(--color-text-muted); text-align: center; }
.subagent-controls { display: flex; gap: 6px; margin-top: 4px; }
.subagent-ctrl-btn { padding: 4px 10px; border: 1px solid var(--color-border); background: var(--color-bg-card); color: var(--color-text-secondary); border-radius: var(--radius-sm); font-size: 11px; cursor: pointer; }
.subagent-ctrl-btn:hover { color: var(--color-primary); border-color: var(--color-primary); background: var(--color-primary-soft); }
.msg-compaction summary { color: var(--color-text-muted); }
.msg-compaction > div { background: var(--color-bg-muted); border-left: 3px solid var(--color-text-muted); }
.msg-error { font-size: 13px; color: #ef4444; padding: 8px 12px; background: #fef2f2; border-radius: var(--radius-sm); margin-bottom: 6px; border-left: 3px solid #ef4444; }
.msg-stop-reason { font-size: 11px; color: var(--color-text-muted); margin-top: 4px; padding: 4px 8px; background: var(--color-bg-muted); border-radius: var(--radius-sm); display: inline-block; }
.msg-body.error { color: #ef4444; }
.msg-body.compaction { color: var(--color-text-muted); font-style: italic; }
.msg-cites { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
.cite-btn { padding: 3px 8px; border: none; background: var(--color-bg-muted); border-radius: 4px; font-size: 11px; color: var(--color-primary); cursor: pointer; }
.cite-btn:hover { background: var(--color-primary-soft); }
.typing-indicator { display: flex; gap: 4px; padding: 12px 14px; }
.typing-indicator span { width: 6px; height: 6px; border-radius: 50%; background: var(--color-text-muted); animation: blink 1.4s infinite both; }
.typing-indicator span:nth-child(2) { animation-delay: 0.2s; }
.typing-indicator span:nth-child(3) { animation-delay: 0.4s; }
@keyframes blink { 0%,80%,100% { opacity: 0.3; } 40% { opacity: 1; } }
.chat-input-area { padding: 14px 14px 12px; border-top: 1px solid rgba(128,128,128,0.25); flex-shrink: 0; background: var(--color-bg-muted); }
.context-badge, .chat-error, .edit-badge { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 10px; margin-bottom: 8px; border-radius: var(--radius-sm); font-size: 12px; }
.context-badge { background: var(--color-primary-soft); color: var(--color-primary); }
.chat-error { background: rgba(239,68,68,0.10); border: 1px solid rgba(239,68,68,0.20); color: var(--color-error); }
.edit-badge { background: rgba(245,158,11,0.12); border: 1px solid rgba(245,158,11,0.24); color: #b45309; }
.context-badge span, .chat-error span, .edit-badge span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.context-badge button, .chat-error button, .edit-badge button { border: none; background: none; color: inherit; cursor: pointer; font-size: 12px; opacity: 0.7; }
.context-badge button:hover, .chat-error button:hover, .edit-badge button:hover { opacity: 1; }
.command-palette { display: flex; flex-direction: column; gap: 2px; margin-bottom: 8px; padding: 4px; border: 1px solid var(--color-border); border-radius: var(--radius); background: var(--color-bg-card); box-shadow: var(--shadow); }
.command-option { display: flex; align-items: center; justify-content: space-between; gap: 8px; width: 100%; padding: 6px 8px; border: none; border-radius: var(--radius-sm); background: transparent; color: var(--color-text); cursor: pointer; text-align: left; }
.command-option:hover, .command-option.active { background: var(--color-bg-muted); }
.command-option span { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 12px; font-weight: 600; }
.command-option .suggestion-file { color: var(--color-primary); }
.command-option .suggestion-paper { color: #f59e0b; }
.command-option .suggestion-category { color: #22c55e; }
.command-option small { color: var(--color-text-muted); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.paper-picker { margin-bottom: 8px; border: 1px solid var(--color-border); border-radius: var(--radius); background: var(--color-bg-card); box-shadow: var(--shadow); overflow: hidden; }
.paper-picker-input { width: 100%; padding: 8px 10px; border: none; border-bottom: 1px solid var(--color-border); background: transparent; color: var(--color-text); font-size: 13px; outline: none; box-sizing: border-box; }
.paper-picker-input::placeholder { color: var(--color-text-muted); }
.paper-picker-list { max-height: 240px; overflow-y: auto; }
.paper-picker-item { display: flex; flex-direction: column; gap: 2px; width: 100%; padding: 8px 10px; border: none; background: transparent; cursor: pointer; text-align: left; color: var(--color-text); }
.paper-picker-item:hover { background: var(--color-bg-muted); }
.paper-picker-title { font-size: 13px; font-weight: 500; line-height: 1.3; display: flex; align-items: center; gap: 6px; }
.paper-picker-current { font-size: 10px; padding: 1px 5px; background: var(--color-primary-soft); color: var(--color-primary); border-radius: 999px; font-weight: 600; flex-shrink: 0; }
.paper-picker-meta { font-size: 11px; color: var(--color-text-muted); }
.paper-picker-empty { padding: 16px; text-align: center; font-size: 12px; color: var(--color-text-muted); }
.input-row { display: flex; gap: 8px; align-items: flex-end; }
.chat-textarea { flex: 1; padding: 8px 12px; border: 1px solid var(--color-border); border-radius: var(--radius); background: var(--color-bg-card); color: var(--color-text); font-size: 13px; resize: none; min-height: 38px; max-height: 200px; font-family: inherit; box-shadow: 0 1px 3px rgba(0,0,0,0.06); overflow-y: auto; }
.chat-textarea:focus { outline: none; border-color: var(--color-primary); }
.chat-textarea::placeholder { color: var(--color-text-muted); }
.send-btn { width: 38px; height: 38px; display: flex; align-items: center; justify-content: center; border: none; background: var(--color-primary); color: white; border-radius: var(--radius); cursor: pointer; flex-shrink: 0; }
.send-btn:hover { background: var(--color-primary-hover); }
.send-btn:disabled { opacity: 0.4; cursor: default; }
.send-btn.stop { background: var(--color-error); font-size: 12px; }
.input-footer { margin-top: 8px; display: flex; align-items: center; gap: 8px; }
.input-footer > :first-child { flex: 1; min-width: 0; }
.input-footer > :last-child { flex-shrink: 0; }
.chat.bg-active, .chat.bg-active .chat-header, .chat.bg-active .chat-messages, .chat.bg-active .chat-input-area, .chat.bg-active .chat-textarea { background: transparent !important; }
@media (max-width: 768px) {
  .chat-messages { padding: 12px; }
  .chat-input-area { padding: 10px 10px calc(10px + env(safe-area-inset-bottom, 0px)); }
  .chat-textarea { font-size: 16px; }
  .conv-dropdown { left: 8px; width: 84%; }
}

/* UI Context bridge styles */
.ui-header-banner { display: flex; flex-direction: column; gap: 2px; padding: 6px 10px; margin-bottom: 4px; background: var(--color-primary-soft); border-radius: var(--radius-sm); font-size: 12px; color: var(--color-primary); border: 1px solid rgba(99,102,241,0.2); }
.ui-widget { padding: 8px 14px; display: flex; flex-direction: column; gap: 2px; font-size: 12px; color: var(--color-text-secondary); background: var(--color-bg-muted); border-bottom: 1px solid var(--color-border); }
.ui-status-bar { display: flex; flex-wrap: wrap; gap: 8px; padding: 4px 0; margin-bottom: 6px; font-size: 11px; color: var(--color-text-muted); }
.ui-status-item strong { font-weight: 600; }
</style>
