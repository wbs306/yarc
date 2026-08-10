<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useThemeStore, type ThemeMode } from '@/stores/theme'
import { usePrefsStore } from '@/stores/prefs'
import { useApi } from '@/composables/useApi'
import { confirm } from '@/composables/useConfirm'
import Select from '@/components/ui/Select.vue'
import WechatSettings from './WechatSettings.vue'
import ExtensionsSettings from './ExtensionsSettings.vue'
import WebDavSettings from './WebDavSettings.vue'

const theme = useThemeStore()
const prefs = usePrefsStore()
const api = useApi()

const { activeTab } = defineProps<{ activeTab: string}>()
const models = ref<any[]>([])
const modelsSource = ref('')
const modelsError = ref('')
const enabledModels = ref<string[]>([])
const enabledModelsLoading = ref(false)

const pdfCacheDays = ref(2)
const pdfCacheSaved = ref(false)
const noteSyncRunning = ref(false)
const noteSyncMessage = ref('')
const noteSyncError = ref('')
const summaryPrompt = ref('')
const summaryPromptLoading = ref(false)
const summaryPromptSaved = ref(false)
const summaryPromptError = ref('')

const customBgUrl = ref('')
const newPattern = ref('')
const bgImages = ref<Array<{ src: string; thumb: string }>>([])
const selectedBgImages = ref<string[]>([])
const bgUploadInput = ref<HTMLInputElement | null>(null)
const bgUploading = ref(false)
const bgDeleting = ref(false)
const bgUploadError = ref('')

// Agent settings
const agentMd = ref('')
const agentMdLoading = ref(false)
const agentMdSaved = ref(false)
const agentMdError = ref('')
const systemPrompt = ref('')
const systemPromptLoading = ref(false)
const systemPromptSaved = ref(false)
const systemPromptError = ref('')
const skills = ref<Array<{ name: string; description: string; enabled: boolean }>>([])
const skillsLoading = ref(false)

// Collapsible prompt sections
const expandSummaryPrompt = ref(false)
const expandSystemPrompt = ref(false)
const expandAgentMd = ref(false)
const expandSkills = ref(false)

// Custom providers/models (models.json)
type ProviderModel = {
  id: string; name?: string; api?: string; reasoning?: boolean;
  thinkingLevelMap?: Record<string, string | null>;
  input?: string[]; contextWindow?: number; maxTokens?: number;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  compat?: Record<string, any>;
}
type Provider = { baseUrl: string; api: string; apiKey?: string; models: ProviderModel[]; compat?: Record<string, any> }
type ModelCatalogEntry = { id: string; name: string; provider: string; contextWindow: number; maxTokens: number; reasoning: boolean; input: string[] }
type ModelCatalogResponse = { models?: ModelCatalogEntry[]; source?: string }
const customProviders = ref<Record<string, Provider>>({})
const customModelsLoading = ref(false)
const customModelsSaving = ref(false)
const customModelsError = ref('')
const piThinkingLevels = ref<string[]>(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
const THINKING_LEVEL_LABELS: Record<string, string> = {
  off: '关',
  minimal: '极低',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '超高',
  max: '极高',
}
const thinkingLevelLabel = (level: string) => THINKING_LEVEL_LABELS[level] || level
const addingThinkingLevelsFor = ref<ProviderModel | null>(null)
const pendingThinkingLevels = ref<string[]>([])
const editingProvider = ref('')
const showAddProvider = ref(false)
const newProvider = ref<{ id: string; baseUrl: string; api: string; apiKey: string; compat?: Record<string, any> }>({ id: '', baseUrl: '', api: 'openai-completions', apiKey: '' })
const newProviderModels = ref<ProviderModel[]>([])
const editingNewModel = ref<number | null>(null)
const newModel = ref<{ providerId: string; id: string; name: string; reasoning: boolean }>({ providerId: '', id: '', name: '', reasoning: false })
const showAddModel = ref('')  // provider id
const apiOptions = ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai']
// Fetched models from API for a provider
const fetchedModels = ref<Array<{ id: string; name?: string; provider?: string; reasoning?: boolean; contextWindow?: number; maxTokens?: number; input?: string[] }>>([])
const fetchedModelsLoading = ref(false)
const showFetchedModels = ref('')  // provider id or '__new__'
const editingModel = ref<{ providerId: string; modelIndex: number } | null>(null)
const modelCatalog = ref<ModelCatalogEntry[]>([])
const catalogLoaded = ref(false)
const catalogSource = ref('')
const catalogRefreshing = ref(false)

// Saving any Pi config makes the server reload Pi and broadcast
// `pi-config-changed`. Without this guard the echo of our own save would
// re-fetch and replace the form state mid-edit, which re-creates the inputs
// (flicker, lost focus, broken Tab navigation).
let selfSaveUntil = 0
const markSelfSave = () => { selfSaveUntil = Date.now() + 3000 }
const isSelfSaveEcho = () => Date.now() < selfSaveUntil

const loadCustomModels = async () => {
  const initial = !Object.keys(customProviders.value).length
  if (initial) customModelsLoading.value = true
  customModelsError.value = ''
  try {
    const res = await api.getPiModels()
    const next = res.providers || {}
    // Only swap the object when it actually differs, so editing inputs keep
    // their DOM nodes (and focus) across background refreshes.
    if (JSON.stringify(next) !== JSON.stringify(customProviders.value)) {
      customProviders.value = next
    }
  } catch (err) {
    customModelsError.value = (err as Error).message || '加载失败'
  } finally {
    customModelsLoading.value = false
  }
}

const loadPiThinkingLevels = async () => {
  try {
    const result = await api.getPiThinkingLevels()
    if (result.levels.length) piThinkingLevels.value = result.levels
  } catch (err) {
    console.warn('Failed to load Pi thinking levels:', err)
  }
}

const saveCustomModels = async () => {
  markSelfSave()
  customModelsSaving.value = true
  customModelsError.value = ''
  try {
    await api.updatePiModels(customProviders.value)
  } catch (err) {
    customModelsError.value = (err as Error).message || '保存失败'
  } finally {
    markSelfSave()
    customModelsSaving.value = false
  }
}

const addProvider = async () => {
  const id = newProvider.value.id.trim()
  if (!id || customProviders.value[id]) return
  customProviders.value[id] = {
    baseUrl: newProvider.value.baseUrl.trim(),
    api: newProvider.value.api,
    apiKey: newProvider.value.apiKey.trim() || undefined,
    models: [...newProviderModels.value],
    ...(newProvider.value.compat && Object.keys(newProvider.value.compat).length > 0 ? { compat: { ...newProvider.value.compat } } : {}),
  }
  newProvider.value = { id: '', baseUrl: '', api: 'openai-completions', apiKey: '' }
  newProviderModels.value = []
  editingNewModel.value = null
  showAddProvider.value = false
  editingProvider.value = id  // Auto-open editing
  await saveCustomModels()
}

const addNewProviderModel = () => {
  const id = newModel.value.id.trim()
  if (!id) return
  newProviderModels.value.push({
    id,
    name: newModel.value.name.trim() || id,
    reasoning: newModel.value.reasoning || false,
    input: ['text'],
    contextWindow: 128000,
    maxTokens: 16384,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  })
  newModel.value = { providerId: '', id: '', name: '', reasoning: false }
  editingNewModel.value = newProviderModels.value.length - 1
}

const applyFetchedModelCatalog = (catalog?: ModelCatalogResponse) => {
  if (!catalog?.models) return
  modelCatalog.value = catalog.models
  catalogSource.value = catalog.source || ''
  catalogLoaded.value = true
}

const fetchModelsForNewProvider = async () => {
  const providerId = newProvider.value.id.trim()
  const baseUrl = newProvider.value.baseUrl.trim()
  if (!providerId || !baseUrl) return
  fetchedModelsLoading.value = true
  showFetchedModels.value = '__new__'
  fetchedModels.value = []
  try {
    const res = await api.fetchProviderModels(baseUrl, newProvider.value.apiKey.trim() || undefined, newProvider.value.api)
    applyFetchedModelCatalog(res.catalog)
    if (!catalogLoaded.value) await loadModelCatalog()
    fetchedModels.value = enrichWithCatalog(res.models || []).sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id))
  } catch (err) {
    console.error('Failed to fetch models:', err)
    fetchedModels.value = []
  } finally {
    fetchedModelsLoading.value = false
  }
}

const addFetchedModelToNew = (model: { id: string; name?: string; reasoning?: boolean; contextWindow?: number; maxTokens?: number; input?: string[] }) => {
  const modelId = model.id.includes('/') ? model.id.split('/').slice(1).join('/') : model.id
  if (newProviderModels.value.some(m => m.id === modelId)) return

  newProviderModels.value.push({
    id: modelId,
    name: model.name || modelId,
    reasoning: model.reasoning ?? false,
    input: filterInput(model.input),
    contextWindow: model.contextWindow || 128000,
    maxTokens: model.maxTokens || 16384,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  })
  // Auto-expand the edit form for the newly added model
  editingNewModel.value = newProviderModels.value.length - 1
}

const removeProvider = async (id: string) => {
  delete customProviders.value[id]
  await saveCustomModels()
}

const addModel = async (providerId: string) => {
  const id = newModel.value.id.trim()
  if (!id) return
  const provider = customProviders.value[providerId]
  if (!provider) return
  provider.models.push({
    id,
    name: newModel.value.name.trim() || undefined,
    reasoning: newModel.value.reasoning || undefined,
  })
  newModel.value = { providerId: '', id: '', name: '', reasoning: false }
  showAddModel.value = ''
  // Auto-expand the edit form for the newly added model
  editingModel.value = { providerId, modelIndex: provider.models.length - 1 }
  await saveCustomModels()
}

const removeModel = async (providerId: string, modelId: string) => {
  const provider = customProviders.value[providerId]
  if (!provider) return
  provider.models = provider.models.filter(m => m.id !== modelId)
  await saveCustomModels()
}

const toggleEditModel = (providerId: string, modelIndex: number) => {
  if (editingModel.value?.providerId === providerId && editingModel.value?.modelIndex === modelIndex) {
    editingModel.value = null
  } else {
    editingModel.value = { providerId, modelIndex }
  }
}

const toggleModelInput = (model: ProviderModel, type: string, event: Event) => {
  if (type !== 'text' && type !== 'image') return
  const checked = (event.target as HTMLInputElement).checked
  if (!model.input) model.input = ['text']
  if (checked && !model.input.includes(type)) model.input.push(type)
  else if (!checked) model.input = model.input.filter(t => t !== type)
}

const ensureCost = (model: ProviderModel) => {
  if (!model.cost) model.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
}

const thinkingLevelEntries = (model: ProviderModel): Array<[string, string | null]> => {
  const map = model.thinkingLevelMap || {}
  const order = new Map(piThinkingLevels.value.map((level, index) => [level, index]))
  return Object.entries(map).sort(([a], [b]) => {
    const aOrder = order.get(a)
    const bOrder = order.get(b)
    if (aOrder != null && bOrder != null) return aOrder - bOrder
    if (aOrder != null) return -1
    if (bOrder != null) return 1
    return a.localeCompare(b)
  })
}

const openThinkingLevelPicker = (model: ProviderModel) => {
  addingThinkingLevelsFor.value = model
  pendingThinkingLevels.value = []
}

const addThinkingLevels = async (model: ProviderModel) => {
  const selected = pendingThinkingLevels.value.filter(level => !(level in (model.thinkingLevelMap || {})))
  if (selected.length) {
    model.thinkingLevelMap = { ...model.thinkingLevelMap, ...Object.fromEntries(selected.map(level => [level, level])) }
    await saveCustomModels()
  }
  addingThinkingLevelsFor.value = null
  pendingThinkingLevels.value = []
}

const setThinkingLevelMap = (model: ProviderModel, level: string, value: string) => {
  const v = value.trim()
  if (!v) {
    removeThinkingLevel(model, level)
    return
  }
  model.thinkingLevelMap = { ...model.thinkingLevelMap, [level]: v }
  saveCustomModels()
}

const removeThinkingLevel = (model: ProviderModel, level: string) => {
  if (!model.thinkingLevelMap) return
  delete model.thinkingLevelMap[level]
  if (Object.keys(model.thinkingLevelMap).length === 0) delete model.thinkingLevelMap
  saveCustomModels()
}

// ── Compat config ──
const filterInput = (input: string[] | undefined): string[] => {
  return (input || ['text']).filter(i => i === 'text' || i === 'image')
}
type CompatField = {
  key: string
  label: string
  type: 'boolean' | 'select' | 'json'
  desc?: string
  options?: Array<{ value: string; label: string }>
  group: 'openai' | 'anthropic' | 'routing'
}

const COMPAT_FIELDS: CompatField[] = [
  // OpenAI (openai-completions / openai-responses)
  { key: 'supportsDeveloperRole', label: 'Developer Role', type: 'boolean', desc: '使用 developer 角色（否则用 system）', group: 'openai' },
  { key: 'supportsReasoningEffort', label: 'Reasoning Effort', type: 'boolean', desc: '支持 reasoning_effort 参数', group: 'openai' },
  { key: 'supportsUsageInStreaming', label: 'Streaming Usage', type: 'boolean', desc: '支持 stream_options.include_usage', group: 'openai' },
  { key: 'supportsStore', label: 'Store', type: 'boolean', desc: '支持 store 字段', group: 'openai' },
  { key: 'supportsStrictMode', label: 'Strict Mode', type: 'boolean', desc: '工具定义中支持 strict 字段', group: 'openai' },
  { key: 'supportsLongCacheRetention', label: 'Long Cache', type: 'boolean', desc: '支持长时间缓存保留', group: 'openai' },
  { key: 'maxTokensField', label: 'Max Tokens 字段', type: 'select', desc: '使用哪个字段名', options: [
    { value: '', label: '默认' },
    { value: 'max_completion_tokens', label: 'max_completion_tokens' },
    { value: 'max_tokens', label: 'max_tokens' },
  ], group: 'openai' },
  { key: 'thinkingFormat', label: 'Thinking 格式', type: 'select', desc: '思考参数格式', options: [
    { value: '', label: '默认' },
    { value: 'reasoning_effort', label: 'reasoning_effort' },
    { value: 'openai', label: 'openai' },
    { value: 'openrouter', label: 'openrouter' },
    { value: 'deepseek', label: 'deepseek' },
    { value: 'together', label: 'together' },
    { value: 'zai', label: 'zai' },
    { value: 'qwen', label: 'qwen' },
    { value: 'chat-template', label: 'chat-template' },
    { value: 'qwen-chat-template', label: 'qwen-chat-template' },
    { value: 'string-thinking', label: 'string-thinking' },
    { value: 'ant-ling', label: 'ant-ling' },
  ], group: 'openai' },
  { key: 'requiresToolResultName', label: 'Tool Result Name', type: 'boolean', desc: '工具结果消息需包含 name', group: 'openai' },
  { key: 'requiresAssistantAfterToolResult', label: 'Assistant After Tool', type: 'boolean', desc: '工具结果后插入 assistant 消息', group: 'openai' },
  { key: 'requiresThinkingAsText', label: 'Thinking as Text', type: 'boolean', desc: '将思考块转为纯文本', group: 'openai' },
  { key: 'requiresReasoningContentOnAssistantMessages', label: 'Reasoning on Assistant', type: 'boolean', desc: '重放的 assistant 消息包含 reasoning_content', group: 'openai' },
  // Anthropic (anthropic-messages)
  { key: 'supportsEagerToolInputStreaming', label: 'Eager Tool Streaming', type: 'boolean', desc: '支持 per-tool eager_input_streaming', group: 'anthropic' },
  { key: 'supportsCacheControlOnTools', label: 'Cache on Tools', type: 'boolean', desc: '工具定义支持 cache_control', group: 'anthropic' },
  { key: 'sendSessionAffinityHeaders', label: 'Session Affinity', type: 'boolean', desc: '发送 x-session-affinity 头', group: 'anthropic' },
  { key: 'forceAdaptiveThinking', label: 'Adaptive Thinking', type: 'boolean', desc: '强制使用自适应思考模式', group: 'anthropic' },
  { key: 'allowEmptySignature', label: 'Empty Signature', type: 'boolean', desc: '允许空思考签名（代理兼容）', group: 'anthropic' },
  // Routing (complex objects — always available)
  { key: 'openRouterRouting', label: 'OpenRouter 路由', type: 'json', desc: 'OpenRouter provider 路由配置', group: 'routing' },
  { key: 'vercelGatewayRouting', label: 'Vercel Gateway 路由', type: 'json', desc: 'Vercel AI Gateway 路由配置', group: 'routing' },
  { key: 'chatTemplateKwargs', label: 'Chat Template Kwargs', type: 'json', desc: 'chat_template_kwargs 参数', group: 'routing' },
  { key: 'cacheControlFormat', label: 'Cache Control 格式', type: 'select', desc: '缓存控制格式', options: [
    { value: '', label: '默认' },
    { value: 'anthropic', label: 'anthropic' },
  ], group: 'routing' },
]

/** Return compat fields relevant for the given API type */
const getCompatFieldsForApi = (api: string): CompatField[] => {
  const isOpenai = api === 'openai-completions' || api === 'openai-responses'
  const isAnthropic = api === 'anthropic-messages'
  return COMPAT_FIELDS.filter(f => {
    if (f.group === 'openai') return isOpenai
    if (f.group === 'anthropic') return isAnthropic
    return true // routing group always visible
  })
}

const getCompatValue = (compat: Record<string, any> | undefined, key: string): any => {
  if (!compat) return undefined
  return compat[key]
}

const setCompatField = (obj: { compat?: Record<string, any> }, key: string, value: any) => {
  if (!obj.compat) obj.compat = {}
  if (value === undefined || value === '' || value === null) {
    delete obj.compat[key]
    if (Object.keys(obj.compat).length === 0) delete obj.compat
  } else {
    obj.compat[key] = value
  }
  saveCustomModels()
}

const setProviderCompatField = (provId: string, key: string, value: any) => {
  const prov = customProviders.value[provId]
  if (!prov) return
  setCompatField(prov, key, value)
}

const setModelCompatField = (model: ProviderModel, key: string, value: any) => {
  setCompatField(model, key, value)
}

const setNewProviderCompatField = (key: string, value: any) => {
  if (!newProvider.value.compat) newProvider.value.compat = {}
  if (value === undefined || value === '' || value === null) {
    delete newProvider.value.compat[key]
    if (Object.keys(newProvider.value.compat).length === 0) delete newProvider.value.compat
  } else {
    newProvider.value.compat[key] = value
  }
}

const setNewModelCompatField = (model: ProviderModel, key: string, value: any) => {
  setCompatField(model, key, value)
}

const setNewProviderCompatJsonField = (key: string, text: string) => {
  if (!newProvider.value.compat) newProvider.value.compat = {}
  const parsed = parseCompatText(text)
  if (parsed) newProvider.value.compat[key] = parsed
  else delete newProvider.value.compat[key]
  if (Object.keys(newProvider.value.compat).length === 0) delete newProvider.value.compat
}

// Keep JSON textarea helpers for complex fields
const compatToText = (compat: Record<string, any> | undefined): string => {
  if (!compat || Object.keys(compat).length === 0) return ''
  return JSON.stringify(compat, null, 2)
}

const parseCompatText = (text: string): Record<string, any> | undefined => {
  const trimmed = text.trim()
  if (!trimmed) return undefined
  try {
    const obj = JSON.parse(trimmed)
    if (obj && typeof obj === 'object' && !Array.isArray(obj) && Object.keys(obj).length > 0) return obj
    return undefined
  } catch {
    return undefined
  }
}

const updateProviderCompatJson = (provId: string, key: string, text: string) => {
  const prov = customProviders.value[provId]
  if (!prov) return
  if (!prov.compat) prov.compat = {}
  const parsed = parseCompatText(text)
  if (parsed) prov.compat[key] = parsed
  else delete prov.compat[key]
  if (Object.keys(prov.compat).length === 0) delete prov.compat
  saveCustomModels()
}

const updateModelCompatJson = (model: ProviderModel, key: string, text: string) => {
  if (!model.compat) model.compat = {}
  const parsed = parseCompatText(text)
  if (parsed) model.compat[key] = parsed
  else delete model.compat[key]
  if (Object.keys(model.compat).length === 0) delete model.compat
  saveCustomModels()
}

const fetchModelsForProvider = async (providerId: string) => {
  const provider = customProviders.value[providerId]
  if (!provider?.baseUrl) return
  fetchedModelsLoading.value = true
  showFetchedModels.value = providerId
  fetchedModels.value = []
  try {
    const res = await api.fetchProviderModels(provider.baseUrl, provider.apiKey, provider.api)
    applyFetchedModelCatalog(res.catalog)
    if (!catalogLoaded.value) await loadModelCatalog()
    console.log('[FetchModels] Catalog loaded:', modelCatalog.value.length, 'models')
    console.log('[FetchModels] Provider returned:', res.models?.length, 'models')
    fetchedModels.value = enrichWithCatalog(res.models || []).sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id))
    console.log('[FetchModels] Enriched:', fetchedModels.value.length, 'models, first:', fetchedModels.value[0])
  } catch (err) {
    console.error('[FetchModels] Failed:', err)
    fetchedModels.value = []
  } finally {
    fetchedModelsLoading.value = false
  }
}

const addFetchedModel = async (providerId: string, model: { id: string; name?: string; reasoning?: boolean; contextWindow?: number; maxTokens?: number; input?: string[] }) => {
  const provider = customProviders.value[providerId]
  if (!provider) return
  const modelId = model.id.includes('/') ? model.id.split('/').slice(1).join('/') : model.id
  if (provider.models.some(m => m.id === modelId)) return

  provider.models.push({
    id: modelId,
    name: model.name || modelId,
    reasoning: model.reasoning ?? false,
    input: filterInput(model.input),
    contextWindow: model.contextWindow || 128000,
    maxTokens: model.maxTokens || 16384,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  })
  // Auto-expand the edit form for the newly added model
  editingModel.value = { providerId, modelIndex: provider.models.length - 1 }
  await saveCustomModels()
}

const loadModelCatalog = async () => {
  if (catalogLoaded.value) return
  try {
    const res = await api.fetchModelCatalog()
    modelCatalog.value = res.models || []
    catalogSource.value = res.source || ''
    catalogLoaded.value = true
  } catch (err) {
    console.warn('[Catalog] Failed to load:', err)
  }
}

const refreshModelCatalog = async () => {
  catalogRefreshing.value = true
  try {
    const res = await api.refreshModelCatalog()
    modelCatalog.value = res.models || []
    catalogSource.value = res.source || ''
    catalogLoaded.value = true
  } catch (err) {
    console.warn('[Catalog] Refresh failed:', err)
  } finally {
    catalogRefreshing.value = false
  }
}

const enrichWithCatalog = <T extends { id: string }>(models: T[]): Array<T & { contextWindow?: number; maxTokens?: number; reasoning?: boolean; input?: string[] }> => {
  return models.map(m => {
    const rawId = m.id
    const stripped = rawId.includes('/') ? rawId.split('/').slice(1).join('/') : rawId
    // Normalize: strip Ollama-style size tags like ':latest', ':7b', ':13b' etc.
    const normalized = stripped.replace(/:[\w.-]+$/, '')

    // Try exact match, then stripped, then normalized, then by name
    const catalog = modelCatalog.value.find(c => {
      const cid = c.id.toLowerCase()
      return (
        cid === rawId.toLowerCase() ||
        cid === stripped.toLowerCase() ||
        cid === normalized.toLowerCase() ||
        cid.endsWith('/' + stripped.toLowerCase()) ||
        cid.endsWith('/' + normalized.toLowerCase()) ||
        c.name?.toLowerCase() === rawId.toLowerCase() ||
        c.name?.toLowerCase() === normalized.toLowerCase()
      )
    })

    if (catalog) {
      return { ...m, contextWindow: catalog.contextWindow, maxTokens: catalog.maxTokens, reasoning: catalog.reasoning, input: filterInput(catalog.input) }
    }
    return m
  })
}

// Pi settings.json
type PiSettings = {
  // Model & Thinking
  defaultProvider?: string
  defaultModel?: string
  summaryModel?: string
  hideThinkingBlock?: boolean
  thinkingBudgets?: Record<string, number>
  // Network
  httpProxy?: string
  // Warnings
  warnings?: { anthropicExtraUsage?: boolean }
  // Compaction
  compaction: { enabled: boolean; reserveTokens: number; keepRecentTokens: number }
  // Branch Summary
  branchSummary?: { reserveTokens?: number; skipPrompt?: boolean }
  // Retry
  retry: { enabled: boolean; maxRetries: number; baseDelayMs?: number; provider: { timeoutMs?: number; maxRetries?: number; maxRetryDelayMs?: number } }
  // Message Delivery
  steeringMode?: string
  followUpMode?: string
  transport?: string
  httpIdleTimeoutMs?: number
  websocketConnectTimeoutMs?: number
  // Images (sent to LLM)
  images: { autoResize?: boolean; blockImages?: boolean }
  // Shell (bash tool execution)
  shellPath?: string
  shellCommandPrefix?: string
  npmCommand?: string[]
  // Sessions
  sessionDir?: string
  // Model Cycling
  enabledModels?: string[]
  // Telemetry
  enableInstallTelemetry?: boolean
}
const piSettings = ref<PiSettings>({
  compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
  retry: { enabled: true, maxRetries: 3, provider: {} },
  images: {},
})
const piSettingsLoading = ref(false)
const piSettingsSaving = ref(false)
const piSettingsError = ref('')
const loadPiSettings = async () => {
  piSettingsLoading.value = true
  piSettingsError.value = ''
  try {
    const res = await api.getPiSettings()
    const s = res.settings || {}
    piSettings.value = {
      ...s,
      compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000, ...s.compaction },
      retry: { enabled: true, maxRetries: 3, baseDelayMs: 2000, ...s.retry, provider: { timeoutMs: 3600000, maxRetries: 0, maxRetryDelayMs: 60000, ...s.retry?.provider } },
      warnings: { anthropicExtraUsage: true, ...s.warnings },
      images: { autoResize: true, blockImages: false, ...s.images },
    }
  } catch (err) {
    piSettingsError.value = (err as Error).message || '加载失败'
  } finally {
    piSettingsLoading.value = false
  }
}

const savePiSettings = async () => {
  markSelfSave()
  piSettingsSaving.value = true
  piSettingsError.value = ''
  try {
    // Deep clone to strip Vue reactivity, then remove empty nested objects
    const raw = JSON.parse(JSON.stringify(piSettings.value))
    // Remove defaultThinkingLevel - reasoning effort is now per-conversation
    delete raw.defaultThinkingLevel
    // Remove empty nested objects that Pi doesn't need
    if (raw.retry?.provider && Object.keys(raw.retry.provider).length === 0) delete raw.retry.provider
    if (raw.warnings && Object.keys(raw.warnings).length === 0) delete raw.warnings
    if (raw.images && Object.keys(raw.images).length === 0) delete raw.images
    if (raw.terminal && Object.keys(raw.terminal).length === 0) delete raw.terminal
    if (raw.markdown && Object.keys(raw.markdown).length === 0) delete raw.markdown
    await api.updatePiSettings(raw)
  } catch (err) {
    piSettingsError.value = (err as Error).message || '保存失败'
  } finally {
    markSelfSave()
    piSettingsSaving.value = false
  }
}

// Auth.json
type AuthEntry = { type: 'api_key' | 'oauth'; hasKey: boolean; expires?: number }
const authEntries = ref<Record<string, AuthEntry>>({})
const authLoading = ref(false)
const authSaving = ref(false)
const authError = ref('')
const newAuth = ref<{ provider: string; key: string }>({ provider: '', key: '' })
const newAuthCustomId = ref('')
const editingAuth = ref('')
const editingAuthKey = ref('')

const builtinProviders = [
  { id: 'anthropic', name: 'Anthropic' },
  { id: 'openai', name: 'OpenAI' },
  { id: 'google', name: 'Google Gemini' },
  { id: 'deepseek', name: 'DeepSeek' },
  { id: 'openrouter', name: 'OpenRouter' },
  { id: 'nvidia', name: 'NVIDIA NIM' },
  { id: 'mistral', name: 'Mistral' },
  { id: 'groq', name: 'Groq' },
  { id: 'cerebras', name: 'Cerebras' },
  { id: 'xai', name: 'xAI' },
  { id: 'together', name: 'Together AI' },
  { id: 'fireworks', name: 'Fireworks' },
  { id: 'huggingface', name: 'Hugging Face' },
  { id: 'xiaomi', name: 'Xiaomi MiMo' },
  { id: 'kimi-coding', name: 'Kimi For Coding' },
  { id: 'zai', name: 'ZAI' },
]

const loadAuth = async () => {
  authLoading.value = true
  authError.value = ''
  try {
    const res = await api.getPiAuth()
    authEntries.value = {}
    for (const [k, v] of Object.entries(res.entries || {})) {
      authEntries.value[k] = {
        type: (v.type === 'oauth' ? 'oauth' : 'api_key') as 'api_key' | 'oauth',
        hasKey: !!v.hasKey,
        expires: v.expires,
      }
    }
  } catch (err) {
    authError.value = (err as Error).message || '加载失败'
  } finally {
    authLoading.value = false
  }
}

const saveAuth = async (entries: Record<string, any>) => {
  markSelfSave()
  authSaving.value = true
  authError.value = ''
  try {
    const res = await api.updatePiAuth(entries) as { entries: Record<string, { type?: string; hasKey?: boolean; expires?: number }> }
    authEntries.value = {}
    for (const [k, v] of Object.entries(res.entries || {})) {
      authEntries.value[k] = {
        type: (v.type === 'oauth' ? 'oauth' : 'api_key') as 'api_key' | 'oauth',
        hasKey: !!v.hasKey,
        expires: v.expires,
      }
    }
  } catch (err) {
    authError.value = (err as Error).message || '保存失败'
  } finally {
    markSelfSave()
    authSaving.value = false
  }
}

const addAuth = async () => {
  let provider = newAuth.value.provider
  if (provider === '__custom__') provider = newAuthCustomId.value.trim()
  const key = newAuth.value.key.trim()
  if (!provider || !key) return
  await saveAuth({ [provider]: { type: 'api_key', key } })
  newAuth.value = { provider: '', key: '' }
  newAuthCustomId.value = ''
  editingAuth.value = ''
}

const removeAuth = async (provider: string) => {
  await saveAuth({ [provider]: null })
}

// Prompt defaults (shown in textareas / used by 恢复默认)
const promptDefaults = ref<{ summary_prompt: string; system_prompt: string }>({ summary_prompt: '', system_prompt: '' })
const summaryVars = ['{{title}}', '{{authors}}', '{{year}}', '{{doi}}', '{{paper_text}}']

// UI scale presets
const customColorHex = ref(theme.primaryColor)

// Mask color shown in the color picker: the chosen color, or the live theme bg
// when set to "auto" (empty). Re-derives on mode flips so the swatch stays right.
const maskColorValue = computed(() => {
  void theme.mode
  if (theme.maskColor) return theme.maskColor
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--color-bg').trim()
  return /^#[0-9a-f]{6}$/i.test(bg) ? bg : '#ffffff'
})

// Literature / search defaults (frontend localStorage — read by the relevant components)
const litSortField = ref('createdAt')
const litSortDir = ref<'asc' | 'desc'>('desc')
const sortFieldOptions = [
  { field: 'createdAt', label: '添加时间' },
  { field: 'year', label: '论文年份' },
  { field: 'title', label: '标题' },
  { field: 'authors', label: '作者' },
  { field: 'journal', label: '期刊/会议' },
]
const sortFieldSelectOptions = computed(() => sortFieldOptions.map(o => ({ value: o.field, label: o.label })))
const searchSourceOptions = [
  { value: 'local', label: '本地库' },
  { value: 'semantic_scholar', label: 'Semantic Scholar' },
  { value: 'ieee', label: 'IEEE' },
]
const litPrefsSaved = ref(false)

// Journal ranking mapping table (built-in + custom)
const rankingEntries = ref<Array<{ name: string; ccf: string | null; sci: string | null; custom?: boolean }>>([])
const rankingSearch = ref('')
const rankingLoading = ref(false)
const rankingSaving = ref(false)
const newRankName = ref('')
const newRankCcf = ref('')
const newRankSci = ref('')
const ccfChoices = ['', 'CCF-A', 'CCF-B', 'CCF-C']
const sciChoices = ['', 'Q1', 'Q2', 'Q3', 'Q4']
const ccfSelectOptions = computed(() => ccfChoices.map(c => ({ value: c, label: c || 'CCF—' })))
const sciSelectOptions = computed(() => sciChoices.map(s => ({ value: s, label: s || 'SCI—' })))
const apiSelectOptions = computed(() => apiOptions.map(a => ({ value: a, label: a })))
const authProviderGroups = computed(() => [{
  label: '内置 Provider',
  options: builtinProviders.map(bp => ({
    value: bp.id,
    label: `${bp.name}${authEntries.value[bp.id] ? ' (已配置)' : ''}`,
    disabled: !!authEntries.value[bp.id],
  })),
}, {
  label: '自定义',
  options: [{ value: '__custom__', label: '其他 Provider…' }],
}])
const sortDirOptions = [
  { value: 'desc', label: '降序' },
  { value: 'asc', label: '升序' },
]
const pageSizeOptions = [
  { value: '10', label: '每页 10 条' },
  { value: '20', label: '每页 20 条' },
  { value: '30', label: '每页 30 条' },
  { value: '50', label: '每页 50 条' },
]
const steeringOptions = [
  { value: '', label: '默认 (one-at-a-time)' },
  { value: 'one-at-a-time', label: 'one-at-a-time' },
  { value: 'all', label: 'all' },
]
const transportOptions = [
  { value: '', label: '默认 (auto)' },
  { value: 'auto', label: 'auto' },
  { value: 'sse', label: 'sse' },
  { value: 'websocket', label: 'websocket' },
]

const modelIdForProvider = (m: any) => String(m.model || (typeof m.id === 'string' && m.id.includes('/') ? m.id.split('/').slice(1).join('/') : m.id || ''))
const fullModelId = (m: any) => {
  const provider = String(m.provider || '')
  const model = modelIdForProvider(m)
  return provider && model ? `${provider}/${model}` : String(m.id || model)
}
const providerSelectOptions = computed(() => {
  const providers = Array.from(new Set(models.value.map((m: any) => String(m.provider || '')).filter(Boolean))).sort()
  const current = piSettings.value.defaultProvider?.trim()
  if (current && !providers.includes(current)) providers.unshift(current)
  return [
    { value: '', label: '使用 Pi 默认' },
    ...providers.map((provider) => ({ value: provider, label: provider })),
  ]
})
const defaultModelSelectOptions = computed(() => {
  const provider = piSettings.value.defaultProvider?.trim()
  const available = provider ? models.value.filter((m: any) => m.provider === provider) : models.value
  const seen = new Set<string>()
  const options = available
    .map((m: any) => {
      const model = modelIdForProvider(m)
      const value = provider ? model : fullModelId(m)
      const label = provider ? (m.name || model) : `${m.provider || 'model'}/${m.name || model}`
      return { value, label }
    })
    .filter((option) => option.value && !seen.has(option.value) && seen.add(option.value))
    .sort((a, b) => a.label.localeCompare(b.label))
  const current = piSettings.value.defaultModel?.trim()
  if (current && !options.some((option) => option.value === current)) options.unshift({ value: current, label: `${current}（当前值）` })
  return [{ value: '', label: '使用 Pi 默认' }, ...options]
})
const summaryModelSelectGroups = computed(() => {
  const groups = Array.from(new Set(models.value.map((m: any) => String(m.provider || '')).filter(Boolean))).sort()
    .map((provider) => {
      const seen = new Set<string>()
      const options = models.value
        .filter((m: any) => m.provider === provider)
        .map((m: any) => {
          const model = modelIdForProvider(m)
          return { value: `${provider}/${model}`, label: m.name || model }
        })
        .filter((option) => option.value && !seen.has(option.value) && seen.add(option.value))
        .sort((a, b) => a.label.localeCompare(b.label))
      return { label: provider, options }
    })
    .filter((group) => group.options.length)
  const current = piSettings.value.summaryModel?.trim()
  const normalizedCurrent = summaryModelSelectValue.value
  if (current && !groups.some((group) => group.options.some((option) => option.value === normalizedCurrent))) {
    groups.unshift({ label: '当前值', options: [{ value: normalizedCurrent || current, label: current }] })
  }
  return [{ label: '默认', options: [{ value: '', label: '使用 Pi 默认模型' }] }, ...groups]
})
const summaryModelSelectValue = computed(() => {
  const value = piSettings.value.summaryModel?.trim() || ''
  if (!value || value.includes('/')) return value
  const provider = piSettings.value.defaultProvider?.trim()
  return provider ? `${provider}/${value}` : value
})
const updateDefaultProvider = (value: string) => {
  piSettings.value.defaultProvider = value || undefined
  const model = piSettings.value.defaultModel?.trim()
  if (value && model?.includes('/')) piSettings.value.defaultModel = model.split('/').slice(1).join('/')
  savePiSettings()
}
const updateDefaultModel = (value: string) => {
  piSettings.value.defaultModel = value || undefined
  savePiSettings()
}
const updateSummaryModel = (value: string) => {
  piSettings.value.summaryModel = value || undefined
  savePiSettings()
}

const colors = ['#6366f1', '#8b5cf6', '#06b6d4', '#22c55e', '#f59e0b', '#ef4444', '#ec4899', '#f97316']

const modeOptions: Array<{ value: ThemeMode; label: string }> = [
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '暗色' },
  { value: 'auto', label: '跟随系统' },
]
const backgroundRotationModeOptions = [
  { value: 'sequential', label: '顺序轮换' },
  { value: 'random', label: '随机轮换' },
]

const loadModels = async (refresh = false) => {
  modelsError.value = ''
  try {
    const res = await api.getModels(refresh)
    models.value = res.models.sort((a: any, b: any) => (a.name || a.model || a.id || '').localeCompare(b.name || b.model || b.id || ''))
    modelsSource.value = res.source || ''
  } catch (err) {
    modelsError.value = (err as Error).message || '模型加载失败'
  }
}

const loadEnabledModels = async () => {
  try {
    const res = await api.getPiEnabledModels()
    enabledModels.value = res.enabledModels || []
  } catch { /* ignore */ }
}

const saveEnabledModels = async () => {
  markSelfSave()
  enabledModelsLoading.value = true
  try {
    await api.updatePiEnabledModels(enabledModels.value)
  } catch { /* ignore */ }
  finally { markSelfSave(); enabledModelsLoading.value = false }
}

const isModelEnabled = (m: any): boolean => {
  const id = m.id || `${m.provider}/${m.model}`
  return enabledModels.value.some(pattern => {
    if (pattern === id) return true
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$')
    return regex.test(id) || regex.test(m.model || '')
  })
}

const toggleModel = (m: any) => {
  const id = m.id || `${m.provider}/${m.model}`
  if (isModelEnabled(m)) {
    enabledModels.value = enabledModels.value.filter(p => p !== id)
  } else {
    enabledModels.value.push(id)
  }
  saveEnabledModels()
}

const addPattern = () => {
  const p = newPattern.value.trim()
  if (!p) return
  if (!enabledModels.value.includes(p)) {
    enabledModels.value.push(p)
    saveEnabledModels()
  }
  newPattern.value = ''
}

const removePattern = (p: string) => {
  enabledModels.value = enabledModels.value.filter(x => x !== p)
  saveEnabledModels()
}

// ── Backend live status ──
const systemStatus = ref<any | null>(null)
const systemStatusLoading = ref(false)
const systemStatusError = ref('')
const pendingQueueTasks = ref<any[]>([])
const pendingQueueLimit = 5000 // Enough to include hundreds of pending tasks; the list itself scrolls internally.
const selectedPendingTaskIds = ref<Set<string>>(new Set())
const cancelTaskRunning = ref('')
const maintenanceRunning = ref('')
const maintenanceMessage = ref('')
const maintenanceError = ref('')
type QueueConcurrency = {
  maxConcurrent: number
  maxConcurrentSummaries: number
  maxConcurrentEmbeddings: number
  maxConcurrentParses: number
}
const defaultQueueConcurrency: QueueConcurrency = {
  maxConcurrent: 4,
  maxConcurrentSummaries: 1,
  maxConcurrentEmbeddings: 1,
  maxConcurrentParses: 3,
}
const queueConcurrency = ref<QueueConcurrency>({ ...defaultQueueConcurrency })
const queueConcurrencyDraft = ref<QueueConcurrency>({ ...defaultQueueConcurrency })
const queueConcurrencySaving = ref(false)
const queueConcurrencySaved = ref(false)
const queueConcurrencyError = ref('')
const pendingQueueTotal = computed(() => {
  const rows = systemStatus.value?.tasks?.byTypeStatus || []
  const total = rows
    .filter((item: any) => item.status === 'pending')
    .reduce((sum: number, item: any) => sum + Number(item.count || 0), 0)
  return total || pendingQueueTasks.value.length
})
const pendingQueueHidden = computed(() => Math.max(0, pendingQueueTotal.value - pendingQueueTasks.value.length))
const queueConcurrencyDirty = computed(() => (
  queueConcurrencyDraft.value.maxConcurrent !== queueConcurrency.value.maxConcurrent ||
  queueConcurrencyDraft.value.maxConcurrentSummaries !== queueConcurrency.value.maxConcurrentSummaries ||
  queueConcurrencyDraft.value.maxConcurrentEmbeddings !== queueConcurrency.value.maxConcurrentEmbeddings ||
  queueConcurrencyDraft.value.maxConcurrentParses !== queueConcurrency.value.maxConcurrentParses
))
const selectedPendingTasks = computed(() => pendingQueueTasks.value.filter((task) => selectedPendingTaskIds.value.has(task.id)))
const allVisiblePendingSelected = computed(() => (
  pendingQueueTasks.value.length > 0 && pendingQueueTasks.value.every((task) => selectedPendingTaskIds.value.has(task.id))
))
const pruneSelectedPendingTasks = () => {
  const visibleIds = new Set(pendingQueueTasks.value.map((task) => task.id))
  selectedPendingTaskIds.value = new Set([...selectedPendingTaskIds.value].filter((id) => visibleIds.has(id)))
}

const applyQueueConcurrency = (value: any) => {
  const next: QueueConcurrency = {
    maxConcurrent: Number(value?.maxConcurrent || defaultQueueConcurrency.maxConcurrent),
    maxConcurrentSummaries: Number(value?.maxConcurrentSummaries || defaultQueueConcurrency.maxConcurrentSummaries),
    maxConcurrentEmbeddings: Number(value?.maxConcurrentEmbeddings || defaultQueueConcurrency.maxConcurrentEmbeddings),
    maxConcurrentParses: Number(value?.maxConcurrentParses || defaultQueueConcurrency.maxConcurrentParses),
  }
  queueConcurrency.value = next
  queueConcurrencyDraft.value = { ...next }
}

const resetQueueConcurrencyDraft = () => {
  queueConcurrencyDraft.value = { ...queueConcurrency.value }
}

const saveQueueConcurrency = async () => {
  queueConcurrencySaving.value = true
  queueConcurrencyError.value = ''
  try {
    const res = await api.updateTaskConcurrency(queueConcurrencyDraft.value)
    applyQueueConcurrency(res.concurrency)
    queueConcurrencySaved.value = true
    setTimeout(() => { queueConcurrencySaved.value = false }, 1500)
    await loadSystemStatus()
  } catch (err) {
    queueConcurrencyError.value = (err as Error).message || '并发设置保存失败'
  } finally {
    queueConcurrencySaving.value = false
  }
}

const loadSystemStatus = async () => {
  systemStatusLoading.value = true
  systemStatusError.value = ''
  queueConcurrencyError.value = ''
  try {
    const [statusRes, tasksRes, concurrencyRes] = await Promise.all([
      api.getSystemStatus(),
      api.getTasks('pending', pendingQueueLimit, 'asc'),
      api.getTaskConcurrency().catch((err) => {
        queueConcurrencyError.value = (err as Error).message || '并发设置加载失败'
        return null
      }),
    ])
    systemStatus.value = statusRes.status
    pendingQueueTasks.value = tasksRes.tasks || []
    if (concurrencyRes?.concurrency) applyQueueConcurrency(concurrencyRes.concurrency)
    pruneSelectedPendingTasks()
  } catch (err) {
    systemStatusError.value = (err as Error).message || '状态加载失败'
  } finally {
    systemStatusLoading.value = false
  }
}

const formatNumber = (value: unknown) => Number(value || 0).toLocaleString()
const formatBytes = (value: unknown) => {
  const bytes = Number(value || 0)
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let n = bytes
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n >= 10 || i === 0 ? n.toFixed(0) : n.toFixed(1)} ${units[i]}`
}
const formatPercent = (value: unknown, total: unknown) => {
  const n = Number(value || 0)
  const d = Number(total || 0)
  if (!d) return '0%'
  return `${Math.round((n / d) * 100)}%`
}
const formatDateTime = (value: unknown) => {
  if (!value) return '—'
  const d = new Date(String(value))
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString()
}
const statusEntries = (record: Record<string, number> | undefined | null) => (
  Object.entries(record || {}).sort(([a], [b]) => a.localeCompare(b))
)
const taskTypeLabel = (type: string) => ({
  parse_pdf: 'PDF 解析',
  generate_embedding: '向量化',
  summarize: '论文总结',
  enrich_metadata: '元数据补全',
  refresh_metadata: '刷新元数据',
  extract_abstract: '提取摘要',
}[type] || type)
const shortId = (id: string) => id ? id.slice(0, 8) : '—'
const togglePendingTaskSelection = (id: string, checked?: boolean) => {
  const next = new Set(selectedPendingTaskIds.value)
  const shouldSelect = checked ?? !next.has(id)
  if (shouldSelect) next.add(id)
  else next.delete(id)
  selectedPendingTaskIds.value = next
}
const toggleAllVisiblePendingTasks = () => {
  if (allVisiblePendingSelected.value) {
    selectedPendingTaskIds.value = new Set()
    return
  }
  selectedPendingTaskIds.value = new Set(pendingQueueTasks.value.map((task) => task.id))
}

const runMaintenance = async (
  action: 'embeddings' | 'mineru' | 'summaries',
  scope: 'needed' | 'all',
  label: string,
  danger = false
) => {
  const confirmed = await confirm({
    title: label,
    message: scope === 'all'
      ? '这会对所有符合条件的论文重新入队，可能耗时很久，并覆盖对应处理结果。确认继续？'
      : '这会把当前缺失、失败或异常的论文重新入队处理。确认继续？',
    confirmText: '开始',
    danger,
    icon: danger ? 'alert' : 'reset',
  })
  if (!confirmed) return

  maintenanceRunning.value = `${action}:${scope}`
  maintenanceMessage.value = ''
  maintenanceError.value = ''
  try {
    const res = await api.runMaintenanceAction(action, { scope })
    maintenanceMessage.value = `已入队 ${res.enqueued}/${res.matched} 个任务${res.errors.length ? `，失败 ${res.errors.length} 个` : ''}`
    await loadSystemStatus()
  } catch (err) {
    maintenanceError.value = (err as Error).message || '操作失败'
  } finally {
    maintenanceRunning.value = ''
  }
}

const cancelQueuedTask = async (task: any) => {
  const title = task?.paper?.title || task?.paperId || '该任务'
  const confirmed = await confirm({
    title: '取消队列任务',
    message: `确定取消「${title}」的${taskTypeLabel(task.type)}队列任务？已开始运行的任务不能在这里取消。`,
    confirmText: '取消任务',
    danger: true,
    icon: 'alert',
  })
  if (!confirmed) return

  cancelTaskRunning.value = task.id
  maintenanceMessage.value = ''
  maintenanceError.value = ''
  try {
    await api.cancelTask(task.id)
    selectedPendingTaskIds.value = new Set([...selectedPendingTaskIds.value].filter((id) => id !== task.id))
    maintenanceMessage.value = '已取消队列任务'
    await loadSystemStatus()
  } catch (err) {
    maintenanceError.value = (err as Error).message || '取消失败'
  } finally {
    cancelTaskRunning.value = ''
  }
}

const cancelSelectedQueuedTasks = async () => {
  const tasks = selectedPendingTasks.value
  if (!tasks.length) return
  const preview = tasks
    .slice(0, 5)
    .map((task) => `「${task?.paper?.title || task?.paperId || shortId(task.id)}」`)
    .join('、')
  const confirmed = await confirm({
    title: '批量取消队列任务',
    message: `将只取消当前勾选的 ${tasks.length} 个待执行任务${preview ? `：${preview}${tasks.length > 5 ? ' 等' : ''}` : ''}。已开始运行的任务不能在这里取消。`,
    confirmText: '取消选中任务',
    danger: true,
    icon: 'alert',
  })
  if (!confirmed) return

  cancelTaskRunning.value = '__batch__'
  maintenanceMessage.value = ''
  maintenanceError.value = ''
  try {
    const results = await Promise.allSettled(tasks.map((task) => api.cancelTask(task.id)))
    const failed = results.filter((result) => result.status === 'rejected').length
    const succeeded = results.length - failed
    selectedPendingTaskIds.value = new Set()
    maintenanceMessage.value = failed
      ? `已取消 ${succeeded} 个任务，失败 ${failed} 个（可能已开始运行或状态变化）`
      : `已取消 ${succeeded} 个队列任务`
    await loadSystemStatus()
  } catch (err) {
    maintenanceError.value = (err as Error).message || '批量取消失败'
  } finally {
    cancelTaskRunning.value = ''
  }
}

// ── Consolidated settings loader (single GET /api/settings call) ──
const allSettingsLoading = ref(false)
const allSettingsError = ref('')

const loadAllSettings = async () => {
  allSettingsLoading.value = true
  allSettingsError.value = ''
  try {
    const res = await api.getSettings()
    const s = res.settings
    // pdf cache
    if (s.pdf_cache_days) pdfCacheDays.value = parseInt(s.pdf_cache_days) || 2
    // prompts
    summaryPrompt.value = typeof s.summary_prompt === 'string' ? s.summary_prompt : (s.summary_prompt ? JSON.stringify(s.summary_prompt) : '')
    systemPrompt.value = typeof s.system_prompt === 'string' ? s.system_prompt : ''
    agentMd.value = typeof s.agent_md === 'string' ? s.agent_md : ''
    skills.value = Array.isArray(s.skills) ? s.skills : []
  } catch (err) {
    allSettingsError.value = (err as Error).message || '设置加载失败'
  } finally {
    allSettingsLoading.value = false
  }
}

const saveSummaryPrompt = async () => {
  markSelfSave()
  summaryPromptLoading.value = true
  summaryPromptError.value = ''
  try {
    const value = summaryPrompt.value.trim()
    await api.updateSetting('summary_prompt', value || null)
    summaryPromptSaved.value = true
    setTimeout(() => { summaryPromptSaved.value = false }, 1500)
  } catch (err) {
    summaryPromptError.value = (err as Error).message || '保存失败'
  } finally {
    markSelfSave()
    summaryPromptLoading.value = false
  }
}

const resetSummaryPrompt = () => {
  summaryPrompt.value = promptDefaults.value.summary_prompt
}

const resetSystemPrompt = () => {
  systemPrompt.value = promptDefaults.value.system_prompt
}

const loadPromptDefaults = async () => {
  try {
    const res = await api.getPromptDefaults()
    promptDefaults.value = res.defaults
  } catch { /* ignore */ }
}

const setPrimaryFromHex = (value: string) => {
  customColorHex.value = value
  if (/^#[0-9a-f]{6}$/i.test(value.trim())) theme.setPrimaryColor(value.trim())
}


// ── Literature / search defaults ──
const loadLitPrefs = () => {
  try {
    const saved = localStorage.getItem('yarc_sort')
    if (saved) {
      const arr = JSON.parse(saved)
      if (Array.isArray(arr) && arr[0]) { litSortField.value = arr[0].field; litSortDir.value = arr[0].direction }
    }
  } catch { /* ignore */ }
}

const flashLitSaved = () => {
  litPrefsSaved.value = true
  setTimeout(() => { litPrefsSaved.value = false }, 1500)
}

const saveSortPref = () => {
  localStorage.setItem('yarc_sort', JSON.stringify([{ field: litSortField.value, direction: litSortDir.value }]))
  flashLitSaved()
}

// search source / page size live in the reactive prefs store (auto-persisted)
const searchSource = computed({ get: () => prefs.searchSource, set: (v) => { prefs.searchSource = v as any; flashLitSaved() } })
const searchPageSize = computed({ get: () => prefs.searchPageSize, set: (v) => { prefs.searchPageSize = Number(v); flashLitSaved() } })
const workspaceAutoSaveOnSwitch = computed({ get: () => prefs.workspaceAutoSaveOnSwitch, set: (v) => { prefs.workspaceAutoSaveOnSwitch = Boolean(v); flashLitSaved() } })

// ── Journal ranking mapping table ──
const loadRankings = async () => {
  rankingLoading.value = true
  try {
    const res = await api.getAllRankings()
    rankingEntries.value = res.entries
  } catch { /* ignore */ }
  finally { rankingLoading.value = false }
}

const filteredRankings = computed(() => {
  const q = rankingSearch.value.toLowerCase().trim()
  const list = q ? rankingEntries.value.filter(e => e.name.toLowerCase().includes(q)) : rankingEntries.value
  return list.slice(0, 200)
})

const persistCustom = async () => {
  rankingSaving.value = true
  try {
    const custom = rankingEntries.value.filter(e => e.custom).map(e => ({ name: e.name, ccf: e.ccf, sci: e.sci }))
    const res = await api.updateCustomRankings(custom)
    // Refresh so built-in + custom merge is reflected consistently.
    await loadRankings()
    return res
  } finally { rankingSaving.value = false }
}

const addCustomRanking = async () => {
  const name = newRankName.value.trim()
  if (!name || (!newRankCcf.value && !newRankSci.value)) return
  const idx = rankingEntries.value.findIndex(e => e.name.toLowerCase() === name.toLowerCase())
  const entry = { name, ccf: newRankCcf.value || null, sci: newRankSci.value || null, custom: true }
  if (idx >= 0) rankingEntries.value[idx] = entry
  else rankingEntries.value.unshift(entry)
  newRankName.value = ''; newRankCcf.value = ''; newRankSci.value = ''
  await persistCustom()
}

const removeCustomRanking = async (name: string) => {
  rankingEntries.value = rankingEntries.value.filter(e => !(e.custom && e.name === name))
  await persistCustom()
}

const resetAllSettings = async () => {
  if (!(await confirm({
    title: '恢复默认设置',
    message: '外观、编辑器、文献与搜索的默认值都将被重置，此操作不可撤销。',
    confirmText: '恢复默认',
    danger: true,
    icon: 'reset',
  }))) return
  theme.resetAll()
  customColorHex.value = theme.primaryColor
  prefs.searchSource = 'semantic_scholar'
  prefs.searchPageSize = 20
  prefs.workspaceAutoSaveOnSwitch = false
  localStorage.removeItem('yarc_sort')
  loadLitPrefs()
}

const savePdfCacheDays = async () => {
  try {
    await api.updateSetting('pdf_cache_days', String(pdfCacheDays.value))
    pdfCacheSaved.value = true
    setTimeout(() => { pdfCacheSaved.value = false }, 1500)
  } catch { /* ignore */ }
}

const syncLinkedNoteFiles = async () => {
  const confirmed = await confirm({
    title: '同步 Markdown 笔记',
    message: '将读取所有已关联的 Markdown 文件，并用文件内容更新数据库笔记。未关联文件的笔记不会处理。确认继续？',
    confirmText: '开始同步',
    icon: 'reset',
  })
  if (!confirmed) return

  noteSyncRunning.value = true
  noteSyncMessage.value = ''
  noteSyncError.value = ''
  try {
    const { result } = await api.syncNotesFromFiles()
    noteSyncMessage.value = `已检查 ${result.matched} 条关联笔记：更新 ${result.synced}，无变化 ${result.unchanged}，文件缺失 ${result.missing}，失败 ${result.failed}`
  } catch (err) {
    noteSyncError.value = (err as Error).message || '笔记同步失败'
  } finally {
    noteSyncRunning.value = false
  }
}

const applyCustomBg = () => {
  const url = customBgUrl.value.trim()
  selectedBgImages.value = []
  theme.setBackgroundRotation([])
  theme.setBackgroundImage(url || '')
}

const hasBackgroundRotation = computed(() => selectedBgImages.value.length >= 2)

const syncSelectedBackgrounds = () => {
  const available = new Set(bgImages.value.map((image) => image.src))
  const rotation = theme.backgroundRotation.filter((src) => available.has(src))
  selectedBgImages.value = rotation.length >= 2 ? rotation : []
}

const selectBackground = (src: string) => {
  // Once checkbox selection has started, thumbnail clicks toggle that image
  // without unexpectedly collapsing the rest back to a single background.
  if (src && selectedBgImages.value.length) {
    toggleBackgroundSelection(src)
    return
  }

  selectedBgImages.value = []
  theme.setBackgroundRotation([])
  theme.setBackgroundImage(src)
}

const toggleBackgroundSelection = (src: string) => {
  const next = selectedBgImages.value.includes(src)
    ? selectedBgImages.value.filter((image) => image !== src)
    : [...selectedBgImages.value, src]
  selectedBgImages.value = next

  if (next.length < 2) {
    theme.setBackgroundRotation([])
    if (next.length === 1) theme.setBackgroundImage(next[0])
    return
  }

  theme.setBackgroundRotation(next)
  if (!next.includes(theme.backgroundImage)) theme.setBackgroundImage(next[0])
}

const selectAllBackgrounds = () => {
  const next = bgImages.value.map((image) => image.src)
  selectedBgImages.value = next
  if (next.length < 2) {
    theme.setBackgroundRotation([])
    return
  }
  theme.setBackgroundRotation(next)
  if (!next.includes(theme.backgroundImage)) theme.setBackgroundImage(next[0])
}

const clearBackgroundSelection = () => {
  selectedBgImages.value = []
  theme.setBackgroundRotation([])
}

const loadBgImages = async () => {
  try {
    const res = await api.getBackgroundImages()
    bgImages.value = (res.images || []).map((img: string | { src: string; thumb?: string }) => {
      if (typeof img === 'string') return { src: img, thumb: img }
      return { src: img.src, thumb: img.thumb || img.src }
    })
    syncSelectedBackgrounds()
  } catch { /* ignore */ }
}

const uploadBackground = async (event: Event) => {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return

  bgUploading.value = true
  bgUploadError.value = ''
  try {
    const res = await api.uploadBackgroundImage(file)
    bgImages.value = [res.image, ...bgImages.value.filter(img => img.src !== res.image.src)]
  } catch (err) {
    bgUploadError.value = (err as Error).message || '背景上传失败'
  } finally {
    bgUploading.value = false
    input.value = ''
  }
}

const deleteSelectedBackgrounds = async () => {
  const images = selectedBgImages.value
  if (!images.length) return

  const confirmed = await confirm({
    title: '删除背景图片',
    message: `将永久删除已选择的 ${images.length} 张背景图片及其缩略图，并从当前轮换列表中移除。确定继续？`,
    confirmText: '删除图片',
    danger: true,
    icon: 'alert',
  })
  if (!confirmed) return

  bgDeleting.value = true
  bgUploadError.value = ''
  try {
    const results = await Promise.allSettled(images.map((src) => api.deleteBackgroundImage(src)))
    const deleted = images.filter((_, index) => results[index].status === 'fulfilled')
    const failed = results.length - deleted.length

    if (deleted.length) {
      bgImages.value = bgImages.value.filter((image) => !deleted.includes(image.src))
      theme.removeBackgroundImages(deleted)
      if (deleted.includes(customBgUrl.value)) customBgUrl.value = ''
      syncSelectedBackgrounds()
    }
    if (failed) bgUploadError.value = `已删除 ${deleted.length} 张背景图片，${failed} 张删除失败`
  } catch (err) {
    bgUploadError.value = (err as Error).message || '背景删除失败'
  } finally {
    bgDeleting.value = false
  }
}

// Agent settings functions
const saveAgentMd = async () => {
  markSelfSave()
  agentMdLoading.value = true
  agentMdError.value = ''
  try {
    await api.updateSetting('agent_md', agentMd.value || null)
    agentMdSaved.value = true
    setTimeout(() => { agentMdSaved.value = false }, 1500)
  } catch (err) {
    agentMdError.value = (err as Error).message || '保存失败'
  } finally {
    markSelfSave()
    agentMdLoading.value = false
  }
}

const saveSystemPrompt = async () => {
  markSelfSave()
  systemPromptLoading.value = true
  systemPromptError.value = ''
  try {
    await api.updateSetting('system_prompt', systemPrompt.value || null)
    systemPromptSaved.value = true
    setTimeout(() => { systemPromptSaved.value = false }, 1500)
  } catch (err) {
    systemPromptError.value = (err as Error).message || '保存失败'
  } finally {
    markSelfSave()
    systemPromptLoading.value = false
  }
}

const onPiConfigChanged = () => {
  // Ignore the echo of our own save; it would clobber the form being edited.
  if (isSelfSaveEcho()) return
  void loadModels()
  void loadEnabledModels()
  void loadAllSettings()
  void loadCustomModels()
  void loadPiThinkingLevels()
}

onMounted(async () => {
  window.addEventListener('yarc-pi-config-changed', onPiConfigChanged)
  await theme.loadRemote()
  customColorHex.value = theme.primaryColor
  await loadPromptDefaults()
  loadLitPrefs()
  void loadRankings()
  await Promise.all([
    loadModels(),
    loadEnabledModels(),
    loadAllSettings(),
    loadBgImages(),
    loadCustomModels(),
    loadPiThinkingLevels(),
    loadPiSettings(),
    loadAuth(),
    loadModelCatalog(),
    loadSystemStatus(),
  ])
  // Show the real defaults in the editors when no override is stored yet.
  if (!summaryPrompt.value) summaryPrompt.value = promptDefaults.value.summary_prompt
  if (!systemPrompt.value) systemPrompt.value = promptDefaults.value.system_prompt
  customBgUrl.value = (theme.backgroundImage && !bgImages.value.some(img => img.src === theme.backgroundImage)) ? theme.backgroundImage : ''
})

onBeforeUnmount(() => {
  window.removeEventListener('yarc-pi-config-changed', onPiConfigChanged)
})
</script>

<template>
  <div class="settings-content">

    <!-- ================================================================
         通用
         ================================================================ -->
    <section v-if="activeTab === 'general'">
      <div class="settings-card">
        <div class="card-header">
          <h3>编辑器</h3>
          <p>代码和文本编辑器的显示设置</p>
        </div>
        <div class="card-body">
          <div class="setting-row">
            <div class="row-info">
              <div class="row-label">编辑器字体大小</div>
              <div class="row-desc">当前 {{ theme.editor.fontSize }}px</div>
            </div>
            <div class="row-control" style="flex: 1; max-width: 200px;">
              <input type="range" :value="theme.editor.fontSize" min="10" max="22" step="1" class="range" @input="theme.setEditorSetting('fontSize', Number(($event.target as HTMLInputElement).value))" />
            </div>
          </div>
          <div class="setting-row">
            <div class="row-info">
              <div class="row-label">Markdown 预览字号</div>
              <div class="row-desc">当前 {{ theme.editor.markdownFontSize }}px，标题按比例缩放</div>
            </div>
            <div class="row-control" style="flex: 1; max-width: 200px;">
              <input type="range" :value="theme.editor.markdownFontSize" min="10" max="24" step="1" class="range" @input="theme.setEditorSetting('markdownFontSize', Number(($event.target as HTMLInputElement).value))" />
            </div>
          </div>
          <div class="setting-row">
            <div class="row-info">
              <div class="row-label">Tab 宽度</div>
            </div>
            <div class="row-control">
              <div class="pill-group">
                <button v-for="n in [2, 4, 8]" :key="n" class="pill" :class="{ active: theme.editor.tabSize === n }" @click="theme.setEditorSetting('tabSize', n)">{{ n }} 空格</button>
              </div>
            </div>
          </div>
          <div class="setting-row">
            <div class="row-info">
              <div class="row-label">自动换行</div>
              <div class="row-desc">长行自动折行显示</div>
            </div>
            <div class="row-control">
              <div class="toggle-track" :class="{ on: theme.editor.lineWrap }" @click="theme.setEditorSetting('lineWrap', !theme.editor.lineWrap)"><div class="toggle-thumb" /></div>
            </div>
          </div>
          <div class="setting-row">
            <div class="row-info">
              <div class="row-label">显示行号</div>
            </div>
            <div class="row-control">
              <div class="toggle-track" :class="{ on: theme.editor.lineNumbers }" @click="theme.setEditorSetting('lineNumbers', !theme.editor.lineNumbers)"><div class="toggle-thumb" /></div>
            </div>
          </div>
          <div class="setting-row">
            <div class="row-info">
              <div class="row-label">切换前自动保存</div>
              <div class="row-desc">关闭时，切换前会询问保存、放弃或取消</div>
            </div>
            <div class="row-control">
              <div class="toggle-track" :class="{ on: workspaceAutoSaveOnSwitch }" @click="workspaceAutoSaveOnSwitch = !workspaceAutoSaveOnSwitch"><div class="toggle-thumb" /></div>
            </div>
          </div>
        </div>
      </div>

      <div class="settings-card">
        <div class="card-header">
          <h3>文献与搜索</h3>
          <p>文献库排序和搜索默认选项</p>
        </div>
        <div class="card-body">
          <div class="setting-row">
            <div class="row-info" style="flex: 0 0 auto;">
              <div class="row-label">默认排序</div>
              <div class="row-desc">下次打开文献库时生效</div>
            </div>
            <div class="row-control" style="flex: 1;">
              <Select :model-value="litSortField" :options="sortFieldSelectOptions" @update:model-value="litSortField = $event; saveSortPref()" />
              <Select :model-value="litSortDir" :options="sortDirOptions" @update:model-value="litSortDir = $event as any; saveSortPref()" />
              <span v-if="litPrefsSaved" class="save-check">✓</span>
            </div>
          </div>
          <div class="setting-row">
            <div class="row-info" style="flex: 0 0 auto;">
              <div class="row-label">默认搜索来源</div>
              <div class="row-desc">即时生效于顶部搜索框</div>
            </div>
            <div class="row-control" style="flex: 1;">
              <Select v-model="searchSource" :options="searchSourceOptions" />
              <Select :model-value="String(searchPageSize)" :options="pageSizeOptions" @update:model-value="searchPageSize = Number($event)" />
              <span v-if="litPrefsSaved" class="save-check">✓</span>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- ================================================================
         AI
         ================================================================ -->
    <section v-if="activeTab === 'ai'">

      <!-- ── Models ── -->
      <div class="settings-card">
        <div class="card-header">
          <div class="card-header-row">
            <div>
              <h3>Pi 模型</h3>
              <p>{{ modelsSource === 'pi-cli' ? '来源: pi --list-models' : modelsSource ? `来源: ${modelsSource}` : '从后端加载可用模型' }}<span v-if="catalogSource"> · 模型目录: {{ catalogSource === 'local' ? '本地缓存' : catalogSource === 'remote' ? 'models.dev' : catalogSource }}</span></p>
            </div>
            <div class="row-control">
              <button class="btn-ghost-sm" :disabled="catalogRefreshing" @click="refreshModelCatalog">{{ catalogRefreshing ? '获取中…' : '获取模型配置' }}</button>
              <button class="btn-ghost" @click="loadModels(true)">刷新</button>
            </div>
          </div>
        </div>
        <div class="card-body">
          <p v-if="modelsError" class="error-text">{{ modelsError }}</p>
          <div v-else-if="!models.length" class="empty-text">暂无可用模型</div>

          <div v-else class="model-grid">
            <div v-for="m in models" :key="m.id" class="model-item" :class="{ disabled: !isModelEnabled(m) }" @click="toggleModel(m)">
              <div class="model-toggle">
                <div class="toggle-track" :class="{ on: isModelEnabled(m) }"><div class="toggle-thumb" /></div>
              </div>
              <div class="model-info">
                <div class="model-name">{{ m.name || m.model || m.id }}</div>
                <div class="model-id">{{ m.provider }} · {{ m.model || m.id }}</div>
                <div class="model-badges">
                  <span v-if="m.contextWindow" class="badge">{{ m.contextWindow >= 1000000 ? (m.contextWindow / 1000000) + 'M' : m.contextWindow >= 1000 ? Math.round(m.contextWindow / 1000) + 'K' : m.contextWindow }} ctx</span>
                  <span v-if="m.maxTokens" class="badge">{{ m.maxTokens >= 1000 ? Math.round(m.maxTokens / 1000) + 'K' : m.maxTokens }} out</span>
                  <span class="badge" :class="m.reasoning ? 'badge-accent' : 'badge-muted'">{{ m.reasoning ? '🧠 思考' : '文本' }}</span>
                  <span v-if="m.images" class="badge">🖼 图片</span>
                </div>
              </div>
            </div>
          </div>

          <div class="setting-group">
            <div class="group-label">
              <span>模式匹配</span>
              <span class="group-hint">通配符批量启用，如 <code>claude-*</code></span>
            </div>
            <div class="pattern-list">
              <div v-for="p in enabledModels" :key="p" class="pattern-tag">
                <code>{{ p }}</code>
                <button class="tag-remove" @click="removePattern(p)">×</button>
              </div>
            </div>
            <div class="input-row">
              <input v-model="newPattern" placeholder="例: claude-*" class="text-input" @keydown.enter="addPattern" />
              <button class="btn-primary-sm" @click="addPattern">添加</button>
            </div>
          </div>
        </div>
      </div>

      <!-- ── Custom Providers ── -->
      <div class="settings-card">
        <div class="card-header">
          <h3>自定义模型源</h3>
          <p>配置 Ollama、vLLM、OpenRouter 等自定义 Provider</p>
        </div>
        <div class="card-body">
          <div v-if="customModelsLoading" class="empty-text">加载中…</div>
          <div v-else-if="customModelsError" class="error-text">{{ customModelsError }}</div>

          <div v-else>
            <div v-for="(prov, provId) in customProviders" :key="provId" class="provider-item">
              <div class="provider-head" :class="{ open: editingProvider === provId }" @click="editingProvider = editingProvider === provId ? '' : String(provId)">
                <span class="provider-avatar">{{ String(provId).slice(0, 1).toUpperCase() }}</span>
                <div class="provider-head-info">
                  <strong>{{ provId }}</strong>
                  <span class="provider-meta">
                    <span class="meta-chip">{{ prov.api }}</span>
                    <span class="meta-chip">{{ prov.models.length }} 个模型</span>
                    <span v-if="prov.baseUrl" class="meta-url">{{ prov.baseUrl }}</span>
                  </span>
                </div>
                <div class="provider-head-actions">
                  <button class="btn-icon danger" title="删除" @click.stop="removeProvider(provId)">🗑</button>
                  <span class="expand-icon" :class="{ open: editingProvider === provId }">▸</span>
                </div>
              </div>

              <div v-if="editingProvider === provId" class="provider-body">
                <div class="provider-config">
                  <div class="field-grid">
                    <div class="field">
                      <label class="field-label">Base URL</label>
                      <input v-model="customProviders[provId].baseUrl" class="text-input" placeholder="http://localhost:11434/v1" @change="saveCustomModels()" />
                    </div>
                    <div class="field">
                      <label class="field-label">API</label>
                      <Select :model-value="customProviders[provId].api" :options="apiSelectOptions" @update:model-value="customProviders[provId].api = $event; saveCustomModels()" />
                    </div>
                    <div class="field field-wide">
                      <label class="field-label">API Key</label>
                      <input v-model="customProviders[provId].apiKey" type="password" class="text-input" placeholder="可选" @change="saveCustomModels()" />
                    </div>
                  </div>
                  <div class="compat-section">
                    <div class="section-label">Compat <span class="section-hint">兼容性配置</span></div>
                    <div class="compat-groups">
                      <template v-for="group in ['openai', 'anthropic', 'routing']" :key="group">
                        <div v-if="getCompatFieldsForApi(customProviders[provId].api).filter(f => f.group === group).some(f => f.type !== 'json' || getCompatValue(customProviders[provId].compat, f.key))" class="compat-group">
                          <div class="compat-group-label">{{ group === 'openai' ? 'OpenAI' : group === 'anthropic' ? 'Anthropic' : '高级' }}</div>
                          <template v-for="field in getCompatFieldsForApi(customProviders[provId].api).filter(f => f.group === group)" :key="field.key">
                            <div v-if="field.type === 'boolean'" class="compat-row">
                              <div class="compat-info">
                                <span class="compat-label">{{ field.label }}</span>
                                <span v-if="field.desc" class="compat-desc">{{ field.desc }}</span>
                              </div>
                              <div class="toggle-track" :class="{ on: getCompatValue(customProviders[provId].compat, field.key) }" @click="setProviderCompatField(String(provId), field.key, !getCompatValue(customProviders[provId].compat, field.key))"><div class="toggle-thumb" /></div>
                            </div>
                            <div v-else-if="field.type === 'select'" class="compat-row">
                              <div class="compat-info">
                                <span class="compat-label">{{ field.label }}</span>
                                <span v-if="field.desc" class="compat-desc">{{ field.desc }}</span>
                              </div>
                              <Select :model-value="getCompatValue(customProviders[provId].compat, field.key) || ''" :options="field.options!" @update:model-value="setProviderCompatField(String(provId), field.key, $event || undefined)" />
                            </div>
                          </template>
                        </div>
                      </template>
                      <div class="compat-group">
                        <div class="compat-group-label">高级（JSON）</div>
                        <template v-for="field in getCompatFieldsForApi(customProviders[provId].api).filter(f => f.type === 'json')" :key="field.key">
                          <div class="compat-json-row">
                            <label class="compat-label">{{ field.label }} <span v-if="field.desc" class="compat-desc">{{ field.desc }}</span></label>
                            <textarea
                              class="code-textarea-sm"
                              :value="compatToText(getCompatValue(customProviders[provId].compat, field.key))"
                              :placeholder="field.key === 'openRouterRouting' ? '{ only: [anthropic] }' : '{}'"
                              rows="2"
                              @change="updateProviderCompatJson(String(provId), field.key, ($event.target as HTMLTextAreaElement).value)"
                            />
                          </div>
                        </template>
                      </div>
                    </div>
                  </div>
                </div>

                <div class="provider-models">
                  <div class="models-header-row">
                    <div class="section-label">模型 <span class="section-count">{{ prov.models.length }}</span></div>
                    <button class="btn-ghost-sm" @click="fetchModelsForProvider(String(provId))">从 API 获取</button>
                  </div>
                  <div class="model-entries">
                    <div v-for="(m, mi) in prov.models" :key="mi" class="model-entry" :class="{ open: editingModel?.providerId === provId && editingModel?.modelIndex === mi }">
                      <div class="model-entry-head" @click="toggleEditModel(String(provId), mi)">
                        <span class="expand-icon sm" :class="{ open: editingModel?.providerId === provId && editingModel?.modelIndex === mi }">▸</span>
                        <span class="model-entry-name">{{ m.name || m.id }}</span>
                        <span class="model-entry-badges">
                          <span v-if="m.contextWindow" class="badge-sm">{{ m.contextWindow >= 1000000 ? (m.contextWindow / 1000000) + 'M' : m.contextWindow >= 1000 ? Math.round(m.contextWindow / 1000) + 'K' : m.contextWindow }}</span>
                          <span v-if="m.input?.includes('image')" class="badge-sm">🖼</span>
                          <span v-if="m.reasoning" class="badge-sm">🧠</span>
                        </span>
                        <button class="tag-remove" @click.stop="removeModel(String(provId), m.id)">×</button>
                      </div>
                      <div v-if="editingModel?.providerId === provId && editingModel?.modelIndex === mi" class="model-edit">
                        <div class="model-edit-grid">
                          <div class="edit-field">
                            <label>ID</label>
                            <input :value="m.id" @change="m.id = ($event.target as HTMLInputElement).value; saveCustomModels()" class="text-input-sm" />
                          </div>
                          <div class="edit-field">
                            <label>Name</label>
                            <input :value="m.name || ''" @change="m.name = ($event.target as HTMLInputElement).value || undefined; saveCustomModels()" class="text-input-sm" />
                          </div>
                          <div class="edit-field">
                            <label>API (覆盖)</label>
                            <Select :model-value="m.api || ''" :options="[{ value: '', label: '使用 Provider 默认' }, ...apiSelectOptions]" @update:model-value="m.api = $event || undefined; saveCustomModels()" />
                          </div>
                          <div class="edit-field">
                            <label>Context Window</label>
                            <input type="number" :value="m.contextWindow || 128000" @change="m.contextWindow = Number(($event.target as HTMLInputElement).value); saveCustomModels()" class="text-input-sm" />
                          </div>
                          <div class="edit-field">
                            <label>Output Tokens</label>
                            <input type="number" :value="m.maxTokens || 16384" @change="m.maxTokens = Number(($event.target as HTMLInputElement).value); saveCustomModels()" class="text-input-sm" />
                          </div>
                          <div class="edit-field">
                            <label>Input</label>
                            <div class="check-row">
                              <label class="check-label"><input type="checkbox" :checked="!m.input || m.input.includes('text')" disabled /> Text</label>
                              <label class="check-label"><input type="checkbox" :checked="m.input?.includes('image')" @change="toggleModelInput(m, 'image', $event); saveCustomModels()" /> Image</label>
                            </div>
                          </div>
                          <div class="edit-field">
                            <label>Reasoning</label>
                            <label class="check-label"><input type="checkbox" :checked="m.reasoning" @change="m.reasoning = ($event.target as HTMLInputElement).checked; saveCustomModels()" /> 支持思考</label>
                          </div>
                          <div class="edit-field" style="grid-column: span 2;">
                            <label>Thinking Level Map</label>
                            <p class="field-hint">未添加等级即使用 Pi 默认映射。添加后默认映射到同名等级，值可按上游 API 要求修改。</p>
                            <div v-if="thinkingLevelEntries(m).length" class="tlm-grid">
                              <template v-for="[level, mappedLevel] in thinkingLevelEntries(m)" :key="level">
                                <span class="tlm-label">{{ thinkingLevelLabel(level) }}（{{ level }}）</span>
                                <div class="tlm-value-row">
                                  <input
                                    class="text-input-sm"
                                    :value="mappedLevel ?? ''"
                                    :placeholder="mappedLevel === null ? '已禁用' : level"
                                    @change="setThinkingLevelMap(m, level, ($event.target as HTMLInputElement).value)"
                                  />
                                  <button class="tag-remove" title="移除此映射并恢复 Pi 默认" @click="removeThinkingLevel(m, level)">×</button>
                                </div>
                              </template>
                            </div>
                            <p v-else class="empty-text">未设置自定义推理映射</p>
                            <div class="tlm-add-row">
                              <button class="btn-ghost-sm" @click="openThinkingLevelPicker(m)">添加推理等级</button>
                              <div v-if="addingThinkingLevelsFor === m" class="tlm-picker">
                                <label v-for="level in piThinkingLevels.filter(level => !(level in (m.thinkingLevelMap || {})))" :key="level" class="check-label">
                                  <input v-model="pendingThinkingLevels" type="checkbox" :value="level" /> {{ thinkingLevelLabel(level) }}（{{ level }}）
                                </label>
                                <span v-if="!piThinkingLevels.some(level => !(level in (m.thinkingLevelMap || {})))" class="empty-text">所有 Pi 等级均已添加</span>
                                <div class="tlm-picker-actions">
                                  <button class="btn-primary-sm" :disabled="!pendingThinkingLevels.length" @click="addThinkingLevels(m)">添加</button>
                                  <button class="btn-ghost-sm" @click="addingThinkingLevelsFor = null; pendingThinkingLevels = []">取消</button>
                                </div>
                              </div>
                            </div>
                          </div>
                          <div class="edit-field">
                            <label>Cost (per M tokens)</label>
                            <div class="cost-grid">
                              <span>输入</span><input type="number" step="0.01" :value="m.cost?.input ?? 0" @change="ensureCost(m); m.cost!.input = Number(($event.target as HTMLInputElement).value); saveCustomModels()" class="text-input-sm" />
                              <span>输出</span><input type="number" step="0.01" :value="m.cost?.output ?? 0" @change="ensureCost(m); m.cost!.output = Number(($event.target as HTMLInputElement).value); saveCustomModels()" class="text-input-sm" />
                              <span>缓存读</span><input type="number" step="0.01" :value="m.cost?.cacheRead ?? 0" @change="ensureCost(m); m.cost!.cacheRead = Number(($event.target as HTMLInputElement).value); saveCustomModels()" class="text-input-sm" />
                              <span>缓存写</span><input type="number" step="0.01" :value="m.cost?.cacheWrite ?? 0" @change="ensureCost(m); m.cost!.cacheWrite = Number(($event.target as HTMLInputElement).value); saveCustomModels()" class="text-input-sm" />
                            </div>
                          </div>
                          <div class="edit-field" style="grid-column: span 2;">
                            <label>Compat <span class="group-hint">(覆盖 provider 设置)</span></label>
                            <div class="compat-inline">
                              <template v-for="field in getCompatFieldsForApi(m.api || customProviders[provId].api)" :key="field.key">
                                <div v-if="field.type === 'boolean'" class="compat-row-sm">
                                  <label class="check-label">
                                    <input type="checkbox" :checked="!!getCompatValue(m.compat, field.key)" @change="setModelCompatField(m, field.key, ($event.target as HTMLInputElement).checked || undefined)" />
                                    {{ field.label }}
                                  </label>
                                </div>
                                <div v-else-if="field.type === 'select'" class="compat-row-sm">
                                  <span class="compat-label-sm">{{ field.label }}</span>
                                  <Select :model-value="getCompatValue(m.compat, field.key) || ''" :options="field.options!" @update:model-value="setModelCompatField(m, field.key, $event || undefined)" />
                                </div>
                              </template>
                              <template v-for="field in getCompatFieldsForApi(m.api || customProviders[provId].api).filter(f => f.type === 'json')" :key="field.key">
                                <div class="compat-json-row">
                                  <label class="compat-label-sm">{{ field.label }}</label>
                                  <textarea
                                    class="code-textarea-sm"
                                    :value="compatToText(getCompatValue(m.compat, field.key))"
                                    placeholder="{}"
                                    rows="2"
                                    @change="updateModelCompatJson(m, field.key, ($event.target as HTMLTextAreaElement).value)"
                                  />
                                </div>
                              </template>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                    <span v-if="!prov.models.length" class="empty-text">暂无模型</span>
                  </div>

                  <div class="add-model-row">
                    <input v-model="newModel.id" class="text-input" placeholder="模型 ID" @keydown.enter="addModel(String(provId))" />
                    <input v-model="newModel.name" class="text-input" placeholder="显示名 (可选)" @keydown.enter="addModel(String(provId))" />
                    <label class="check-label"><input v-model="newModel.reasoning" type="checkbox" /> 推理</label>
                    <button class="btn-primary-sm" :disabled="!newModel.id.trim()" @click="addModel(String(provId))">添加</button>
                  </div>

                  <div v-if="showFetchedModels === provId" class="fetched-panel">
                    <div v-if="fetchedModelsLoading" class="empty-text">获取中…</div>
                    <div v-else-if="!fetchedModels.length" class="empty-text">未找到匹配的模型，请先在 API Keys 页配置凭证</div>
                    <div v-else class="fetched-list">
                      <div v-for="fm in fetchedModels" :key="fm.id" class="fetched-item" :class="{ added: prov.models.some(m => m.id === (fm.id.includes('/') ? fm.id.split('/').slice(1).join('/') : fm.id)) }">
                        <div class="fetched-info">
                          <span class="fetched-name">{{ fm.name || fm.id }}</span>
                          <span class="fetched-meta">
                            <span v-if="fm.contextWindow">{{ fm.contextWindow >= 1000000 ? (fm.contextWindow / 1000000) + 'M' : fm.contextWindow >= 1000 ? Math.round(fm.contextWindow / 1000) + 'K' : fm.contextWindow }} ctx</span>
                            <span v-if="fm.input?.includes('image')">🖼</span>
                            <span v-if="fm.reasoning">🧠</span>
                          </span>
                        </div>
                        <button v-if="!prov.models.some(m => m.id === (fm.id.includes('/') ? fm.id.split('/').slice(1).join('/') : fm.id))" class="btn-ghost-sm" @click="addFetchedModel(String(provId), fm)">添加</button>
                        <span v-else class="added-badge">已添加</span>
                      </div>
                    </div>
                    <button class="btn-ghost" style="margin-top: 8px;" @click="showFetchedModels = ''">关闭</button>
                  </div>
                </div>
              </div>
            </div>

            <button v-if="!showAddProvider" class="btn-add" @click="showAddProvider = true">
              <span class="add-icon">+</span> 添加 Provider
            </button>

            <div v-if="showAddProvider" class="add-provider-form">
              <div class="form-title">新建 Provider</div>
              <div class="field-grid">
                <div class="field">
                  <label class="field-label">Provider ID</label>
                  <input v-model="newProvider.id" class="text-input" placeholder="如 ollama" />
                </div>
                <div class="field">
                  <label class="field-label">API</label>
                  <Select v-model="newProvider.api" :options="apiSelectOptions" />
                </div>
                <div class="field field-wide">
                  <label class="field-label">Base URL</label>
                  <input v-model="newProvider.baseUrl" class="text-input" placeholder="http://localhost:11434/v1" />
                </div>
                <div class="field field-wide">
                  <label class="field-label">API Key</label>
                  <input v-model="newProvider.apiKey" type="password" class="text-input" placeholder="可选" />
                </div>
              </div>
              <div class="compat-section">
                <div class="section-label">Compat <span class="section-hint">兼容性配置</span></div>
                <div class="compat-groups">
                  <template v-for="group in ['openai', 'anthropic', 'routing']" :key="group">
                    <div v-if="getCompatFieldsForApi(newProvider.api).filter(f => f.group === group).some(f => f.type !== 'json' || getCompatValue(newProvider.compat, f.key))" class="compat-group">
                      <div class="compat-group-label">{{ group === 'openai' ? 'OpenAI' : group === 'anthropic' ? 'Anthropic' : '高级' }}</div>
                      <template v-for="field in getCompatFieldsForApi(newProvider.api).filter(f => f.group === group)" :key="field.key">
                        <div v-if="field.type === 'boolean'" class="compat-row">
                          <div class="compat-info">
                            <span class="compat-label">{{ field.label }}</span>
                          </div>
                          <div class="toggle-track" :class="{ on: getCompatValue(newProvider.compat, field.key) }" @click="setNewProviderCompatField(field.key, !getCompatValue(newProvider.compat, field.key))"><div class="toggle-thumb" /></div>
                        </div>
                        <div v-else-if="field.type === 'select'" class="compat-row">
                          <div class="compat-info">
                            <span class="compat-label">{{ field.label }}</span>
                          </div>
                          <Select :model-value="getCompatValue(newProvider.compat, field.key) || ''" :options="field.options!" @update:model-value="setNewProviderCompatField(field.key, $event || undefined)" />
                        </div>
                      </template>
                    </div>
                  </template>
                  <div class="compat-group">
                    <div class="compat-group-label">高级（JSON）</div>
                    <template v-for="field in getCompatFieldsForApi(newProvider.api).filter(f => f.type === 'json')" :key="field.key">
                      <div class="compat-json-row">
                        <label class="compat-label">{{ field.label }} <span v-if="field.desc" class="compat-desc">{{ field.desc }}</span></label>
                        <textarea
                          class="code-textarea-sm"
                          :value="compatToText(getCompatValue(newProvider.compat, field.key))"
                          placeholder="{}"
                          rows="2"
                          @change="setNewProviderCompatJsonField(field.key, ($event.target as HTMLTextAreaElement).value)"
                        />
                      </div>
                    </template>
                  </div>
                </div>
              </div>

              <div class="form-models">
                <div class="models-header-row">
                  <div class="section-label">模型 <span v-if="newProviderModels.length" class="section-count">{{ newProviderModels.length }}</span></div>
                  <button class="btn-ghost-sm" @click="fetchModelsForNewProvider" :disabled="!newProvider.id.trim()">从 API 获取</button>
                </div>
                <div class="model-entries">
                  <div v-for="(m, mi) in newProviderModels" :key="mi" class="model-entry" :class="{ open: editingNewModel === mi }">
                    <div class="model-entry-head" @click="editingNewModel = editingNewModel === mi ? null : mi">
                      <span class="expand-icon sm" :class="{ open: editingNewModel === mi }">▸</span>
                      <span class="model-entry-name">{{ m.name || m.id }}</span>
                      <span class="model-entry-badges">
                        <span v-if="m.contextWindow" class="badge-sm">{{ m.contextWindow >= 1000000 ? (m.contextWindow / 1000000) + 'M' : m.contextWindow >= 1000 ? Math.round(m.contextWindow / 1000) + 'K' : m.contextWindow }}</span>
                        <span v-if="m.input?.includes('image')" class="badge-sm">🖼</span>
                        <span v-if="m.reasoning" class="badge-sm">🧠</span>
                      </span>
                      <button class="tag-remove" @click.stop="newProviderModels.splice(mi, 1); if (editingNewModel === mi) editingNewModel = null">×</button>
                    </div>
                    <div v-if="editingNewModel === mi" class="model-edit">
                      <div class="model-edit-grid">
                        <div class="edit-field">
                          <label>ID</label>
                          <input v-model="m.id" class="text-input-sm" />
                        </div>
                        <div class="edit-field">
                          <label>Name</label>
                          <input v-model="m.name" class="text-input-sm" />
                        </div>
                        <div class="edit-field">
                          <label>Context Window</label>
                          <input type="number" v-model.number="m.contextWindow" class="text-input-sm" />
                        </div>
                        <div class="edit-field">
                          <label>Output Tokens</label>
                          <input type="number" v-model.number="m.maxTokens" class="text-input-sm" />
                        </div>
                        <div class="edit-field">
                          <label>Input</label>
                          <div class="check-row">
                            <label class="check-label"><input type="checkbox" :checked="!m.input || m.input.includes('text')" disabled /> Text</label>
                            <label class="check-label"><input type="checkbox" :checked="m.input?.includes('image')" @change="toggleModelInput(m, 'image', $event)" /> Image</label>
                          </div>
                        </div>
                        <div class="edit-field">
                          <label>Reasoning</label>
                          <label class="check-label"><input type="checkbox" v-model="m.reasoning" /> 支持思考</label>
                        </div>
                        <div class="edit-field" style="grid-column: span 2;">
                          <label>Compat</label>
                          <div class="compat-inline">
                            <template v-for="field in getCompatFieldsForApi(m.api || newProvider.api)" :key="field.key">
                              <div v-if="field.type === 'boolean'" class="compat-row-sm">
                                <label class="check-label">
                                  <input type="checkbox" :checked="!!getCompatValue(m.compat, field.key)" @change="setNewModelCompatField(m, field.key, ($event.target as HTMLInputElement).checked || undefined)" />
                                  {{ field.label }}
                                </label>
                              </div>
                              <div v-else-if="field.type === 'select'" class="compat-row-sm">
                                <span class="compat-label-sm">{{ field.label }}</span>
                                <Select :model-value="getCompatValue(m.compat, field.key) || ''" :options="field.options!" @update:model-value="setNewModelCompatField(m, field.key, $event || undefined)" />
                              </div>
                            </template>
                            <template v-for="field in getCompatFieldsForApi(m.api || newProvider.api).filter(f => f.type === 'json')" :key="field.key">
                              <div class="compat-json-row">
                                <label class="compat-label-sm">{{ field.label }}</label>
                                <textarea
                                  class="code-textarea-sm"
                                  :value="compatToText(getCompatValue(m.compat, field.key))"
                                  placeholder="{}"
                                  rows="2"
                                  @change="updateModelCompatJson(m, field.key, ($event.target as HTMLTextAreaElement).value)"
                                />
                              </div>
                            </template>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                  <span v-if="!newProviderModels.length" class="empty-text">暂无模型</span>
                </div>
                <div class="add-model-row" style="margin-top: 8px;">
                  <input v-model="newModel.id" class="text-input" placeholder="模型 ID" @keydown.enter="addNewProviderModel" />
                  <input v-model="newModel.name" class="text-input" placeholder="显示名 (可选)" @keydown.enter="addNewProviderModel" />
                  <label class="check-label"><input v-model="newModel.reasoning" type="checkbox" /> 推理</label>
                  <button class="btn-ghost-sm" :disabled="!newModel.id.trim()" @click="addNewProviderModel">添加</button>
                </div>

                <div v-if="showFetchedModels === '__new__'" class="fetched-panel">
                  <div v-if="fetchedModelsLoading" class="empty-text">获取中…</div>
                  <div v-else-if="!fetchedModels.length" class="empty-text">未找到匹配的模型</div>
                  <div v-else class="fetched-list">
                    <div v-for="fm in fetchedModels" :key="fm.id" class="fetched-item" :class="{ added: newProviderModels.some(m => m.id === (fm.id.includes('/') ? fm.id.split('/').slice(1).join('/') : fm.id)) }">
                      <div class="fetched-info">
                        <span class="fetched-name">{{ fm.name || fm.id }}</span>
                        <span class="fetched-meta">
                          <span v-if="fm.contextWindow">{{ fm.contextWindow >= 1000000 ? (fm.contextWindow / 1000000) + 'M' : fm.contextWindow >= 1000 ? Math.round(fm.contextWindow / 1000) + 'K' : fm.contextWindow }} ctx</span>
                        </span>
                      </div>
                      <button v-if="!newProviderModels.some(m => m.id === (fm.id.includes('/') ? fm.id.split('/').slice(1).join('/') : fm.id))" class="btn-ghost-sm" @click="addFetchedModelToNew(fm)">添加</button>
                      <span v-else class="added-badge">已添加</span>
                    </div>
                  </div>
                  <button class="btn-ghost" style="margin-top: 8px;" @click="showFetchedModels = ''">关闭</button>
                </div>
              </div>

              <div class="form-actions">
                <button class="btn-primary" :disabled="!newProvider.id.trim()" @click="addProvider">保存</button>
                <button class="btn-ghost" @click="showAddProvider = false; newProviderModels = []; editingNewModel = null; newProvider.compat = undefined">取消</button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- ── API Keys ── -->
      <div class="settings-card">
        <div class="card-header">
          <h3>API Keys</h3>
          <p>管理 Provider 凭证，支持 API Key 和 OAuth</p>
        </div>
        <div class="card-body">
          <div v-if="authLoading" class="empty-text">加载中…</div>
          <div v-else-if="authError" class="error-text">{{ authError }}</div>

          <div v-else>
            <div v-for="(entry, provId) in authEntries" :key="provId" class="auth-item">
              <span class="provider-avatar">{{ String(provId).slice(0, 1).toUpperCase() }}</span>
              <div class="auth-info">
                <strong>{{ builtinProviders.find(bp => bp.id === provId)?.name || provId }}</strong>
                <code class="auth-id">{{ provId }}</code>
              </div>
              <div class="auth-actions">
                <span v-if="entry.type === 'oauth'" class="pill-badge oauth">OAuth</span>
                <span v-else class="pill-badge active">API Key</span>
                <button v-if="editingAuth !== provId" class="btn-icon" title="编辑" @click="editingAuth = String(provId); editingAuthKey = ''">✏️</button>
                <button class="btn-icon danger" title="删除" @click="removeAuth(String(provId))">🗑</button>
              </div>
            </div>

            <div v-if="!Object.keys(authEntries).length" class="empty-text">暂未配置任何凭证</div>

            <div class="auth-form">
              <div class="form-title">{{ editingAuth ? `更新 ${editingAuth} 凭证` : '添加凭证' }}</div>
              <Select v-model="newAuth.provider" :groups="authProviderGroups" placeholder="选择 Provider…" />
              <input v-if="newAuth.provider === '__custom__'" v-model="newAuthCustomId" class="text-input" placeholder="Provider ID" />
              <input v-model="newAuth.key" type="password" class="text-input" :placeholder="authEntries[newAuth.provider]?.type === 'oauth' ? '新的 API Key (替换 OAuth)' : 'API Key'" @keydown.enter="addAuth" />
              <div class="form-actions">
                <button class="btn-primary" :disabled="!newAuth.provider || newAuth.provider === '__custom__' && !newAuthCustomId.trim() || !newAuth.key.trim()" @click="addAuth">{{ editingAuth ? '更新' : '添加' }}</button>
                <button v-if="editingAuth" class="btn-ghost" @click="editingAuth = ''; editingAuthKey = ''; newAuth = { provider: '', key: '' }">取消</button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- ── Prompts ── -->
      <div class="settings-card">
        <div class="card-header">
          <h3>提示词</h3>
          <p>文献总结和对话助手的 Prompt 配置</p>
        </div>
        <div class="card-body">
          <div class="setting-group">
            <div class="group-label collapsible" @click="expandSummaryPrompt = !expandSummaryPrompt">
              <div class="group-label-main">
                <span>文献总结 Prompt</span>
                <span v-if="summaryPromptSaved" class="save-check">✓ 已保存</span>
              </div>
              <span class="expand-icon">{{ expandSummaryPrompt ? '▾' : '▸' }}</span>
            </div>
            <template v-if="expandSummaryPrompt">
              <p class="group-hint">可用变量：<code v-for="v in summaryVars" :key="v">{{ v }}</code>。保存到 <code>SUMMARY.md</code></p>
              <textarea v-model="summaryPrompt" class="code-textarea" placeholder="留空使用默认 Prompt…" rows="16" :disabled="summaryPromptLoading" />
              <div class="form-actions">
                <button class="btn-primary" :disabled="summaryPromptLoading" @click="saveSummaryPrompt">{{ summaryPromptLoading ? '保存中…' : '保存' }}</button>
                <button class="btn-ghost" :disabled="summaryPromptLoading" @click="resetSummaryPrompt">恢复默认</button>
              </div>
              <p v-if="summaryPromptError" class="error-text">{{ summaryPromptError }}</p>
            </template>
          </div>

          <div class="setting-group">
            <div class="group-label collapsible" @click="expandSystemPrompt = !expandSystemPrompt">
              <div class="group-label-main">
                <span>System Prompt</span>
                <span v-if="systemPromptSaved" class="save-check">✓ 已保存</span>
              </div>
              <span class="expand-icon">{{ expandSystemPrompt ? '▾' : '▸' }}</span>
            </div>
            <template v-if="expandSystemPrompt">
              <p class="group-hint">系统指令，完全静态。工具策略请在 AGENTS.md 中配置。保存到 <code>SYSTEM.md</code></p>
              <textarea v-model="systemPrompt" class="code-textarea" placeholder="输入 System Prompt…" rows="16" :disabled="systemPromptLoading" />
              <div class="form-actions">
                <button class="btn-primary" :disabled="systemPromptLoading" @click="saveSystemPrompt">{{ systemPromptLoading ? '保存中…' : '保存' }}</button>
                <button class="btn-ghost" :disabled="systemPromptLoading" @click="resetSystemPrompt">恢复默认</button>
              </div>
              <p v-if="systemPromptError" class="error-text">{{ systemPromptError }}</p>
            </template>
          </div>

          <div class="setting-group">
            <div class="group-label collapsible" @click="expandAgentMd = !expandAgentMd">
              <div class="group-label-main">
                <span>AGENTS.md</span>
                <span v-if="agentMdSaved" class="save-check">✓ 已保存</span>
              </div>
              <span class="expand-icon">{{ expandAgentMd ? '▾' : '▸' }}</span>
            </div>
            <template v-if="expandAgentMd">
              <p class="group-hint">保存到 <code>data/AGENTS.md</code>，由 Pi 自动加载</p>
              <textarea v-model="agentMd" class="code-textarea" placeholder="输入 AGENTS.md 内容…" rows="14" :disabled="agentMdLoading" />
              <div class="form-actions">
                <button class="btn-primary" :disabled="agentMdLoading" @click="saveAgentMd">{{ agentMdLoading ? '保存中…' : '保存' }}</button>
              </div>
              <p v-if="agentMdError" class="error-text">{{ agentMdError }}</p>
            </template>
          </div>

          <div class="setting-group">
            <div class="group-label collapsible" @click="expandSkills = !expandSkills">
              <div class="group-label-main">
                <span>Skills</span>
              </div>
              <span class="expand-icon">{{ expandSkills ? '▾' : '▸' }}</span>
            </div>
            <template v-if="expandSkills">
              <p class="group-hint">技能文件放在 <code>data/.pi/skills</code>，请在文件页编辑</p>
              <div v-if="skillsLoading" class="empty-text">加载中…</div>
              <div v-else class="skills-grid">
                <div v-for="skill in skills" :key="skill.name" class="skill-item">
                  <div class="skill-toggle">
                    <div class="toggle-track" :class="{ on: skill.enabled }"><div class="toggle-thumb" /></div>
                  </div>
                  <div class="skill-info">
                    <div class="skill-name">{{ skill.name }}</div>
                    <div v-if="skill.description" class="skill-desc">{{ skill.description }}</div>
                  </div>
                </div>
                <div v-if="!skills.length" class="empty-text">暂无技能</div>
              </div>
            </template>
          </div>
        </div>
      </div>
    </section>

    <!-- ================================================================
         外观
         ================================================================ -->
    <section v-if="activeTab === 'appearance'">

      <div class="settings-card">
        <div class="card-header">
          <h3>主题</h3>
        </div>
        <div class="card-body">
          <div class="setting-row">
            <div class="row-info">
              <div class="row-label">主题模式</div>
            </div>
            <div class="row-control">
              <div class="pill-group">
                <button v-for="m in modeOptions" :key="m.value" class="pill" :class="{ active: theme.mode === m.value }" @click="theme.setMode(m.value)">{{ m.label }}</button>
              </div>
            </div>
          </div>
          <div class="setting-row">
            <div class="row-info">
              <div class="row-label">主题色</div>
            </div>
            <div class="row-control">
              <div class="color-swatches">
                <button v-for="c in colors" :key="c" @click="theme.setPrimaryColor(c)" class="swatch" :class="{ active: theme.primaryColor === c }" :style="{ background: c }" />
              </div>
            </div>
          </div>
          <div class="setting-row">
            <div class="row-info">
              <div class="row-label">自定义颜色</div>
            </div>
            <div class="row-control">
              <div class="input-row compact">
                <input type="color" class="color-picker" :value="theme.primaryColor" @input="setPrimaryFromHex(($event.target as HTMLInputElement).value)" />
                <input class="text-input" :value="customColorHex" placeholder="#6366f1" @input="setPrimaryFromHex(($event.target as HTMLInputElement).value)" style="max-width: 120px;" />
              </div>
            </div>
          </div>
        </div>
      </div>

      <p v-if="theme.syncError" class="error-text">{{ theme.syncError }}</p>

      <div class="settings-card">
        <div class="card-header">
          <h3>背景</h3>
        </div>
        <div class="card-body">
          <div class="setting-group">
            <div class="group-label">
              <span>选择背景 <span class="group-hint">(单选显示，多选自动开启轮换)</span></span>
              <button class="btn-ghost-sm" :disabled="bgUploading" @click="bgUploadInput?.click()">{{ bgUploading ? '上传中…' : '上传图片' }}</button>
              <input ref="bgUploadInput" type="file" accept="image/jpeg,image/png,image/webp,image/gif" class="hidden" @change="uploadBackground" />
            </div>
            <p v-if="bgUploadError" class="error-text">{{ bgUploadError }}</p>
            <div class="bg-grid" :class="{ 'selection-active': selectedBgImages.length > 0 }">
              <button
                class="bg-thumb"
                :class="{ active: !theme.backgroundImage }"
                :aria-pressed="!theme.backgroundImage"
                @click="selectBackground('')"
              >
                <div class="bg-thumb-empty">无</div>
              </button>
              <div v-for="img in bgImages" :key="img.src" class="bg-thumb-wrap">
                <button
                  class="bg-thumb"
                  :class="{ active: theme.backgroundImage === img.src, 'multi-selected': selectedBgImages.includes(img.src) }"
                  :aria-pressed="theme.backgroundImage === img.src"
                  @click="selectBackground(img.src)"
                >
                  <img :src="img.thumb" loading="lazy" />
                </button>
                <label class="bg-select-checkbox" :class="{ checked: selectedBgImages.includes(img.src) }" :title="selectedBgImages.includes(img.src) ? '取消勾选' : '勾选图片'" @click.stop>
                  <input
                    type="checkbox"
                    :checked="selectedBgImages.includes(img.src)"
                    :aria-label="selectedBgImages.includes(img.src) ? '取消勾选背景图片' : '勾选背景图片'"
                    @change="toggleBackgroundSelection(img.src)"
                  />
                </label>
              </div>
            </div>

            <div class="bg-selection-toolbar">
              <span class="bg-selection-summary">已勾选 {{ selectedBgImages.length }} 张背景图片</span>
              <div v-if="bgImages.length" class="inline-btns">
                <button class="btn-ghost-xs" :disabled="selectedBgImages.length === bgImages.length" @click="selectAllBackgrounds">全选</button>
                <button class="btn-ghost-xs" :disabled="!selectedBgImages.length" @click="clearBackgroundSelection">清空</button>
                <button
                  v-if="selectedBgImages.length"
                  class="btn-ghost-xs danger"
                  :disabled="bgDeleting"
                  @click="deleteSelectedBackgrounds"
                >{{ bgDeleting ? '删除中…' : `删除已选 (${selectedBgImages.length})` }}</button>
              </div>
            </div>

            <div v-if="hasBackgroundRotation" class="rotation-controls">
              <div class="rotation-mode-row">
                <label>轮换方式</label>
                <Select
                  :model-value="theme.backgroundRotationMode"
                  :options="backgroundRotationModeOptions"
                  min-width="140px"
                  @update:model-value="theme.setBackgroundRotationMode"
                />
              </div>
              <label>切换间隔: {{ theme.backgroundInterval < 60 ? theme.backgroundInterval + ' 秒' : Math.round(theme.backgroundInterval / 60) + ' 分钟' }}</label>
              <div class="range-row">
                <input type="range" :value="theme.backgroundInterval" min="10" max="3600" step="10" class="range" @input="theme.setBackgroundInterval(Number(($event.target as HTMLInputElement).value))" />
                <span class="range-value">{{ theme.backgroundInterval < 60 ? theme.backgroundInterval + 's' : Math.round(theme.backgroundInterval / 60) + 'min' }}</span>
              </div>
            </div>
          </div>

          <div class="setting-row">
            <div class="row-info">
              <div class="row-label">自定义 URL</div>
            </div>
            <div class="row-control" style="flex: 1;">
              <div class="input-row" style="flex: 1;">
                <input v-model="customBgUrl" placeholder="输入图片 URL 或路径…" class="text-input" @keydown.enter="applyCustomBg" />
                <button class="btn-primary-sm" @click="applyCustomBg">应用</button>
              </div>
            </div>
          </div>

          <div class="setting-row">
            <div class="row-info">
              <div class="row-label">遮罩颜色</div>
              <div class="row-desc">叠加在背景图之上的颜色</div>
            </div>
            <div class="row-control">
              <div class="input-row compact">
                <input type="color" class="color-picker" :value="maskColorValue" @input="theme.setMaskColor(($event.target as HTMLInputElement).value)" />
                <input class="text-input" :value="theme.maskColor" placeholder="跟随主题" @input="theme.setMaskColor(($event.target as HTMLInputElement).value.trim())" style="max-width: 120px;" />
                <button v-if="theme.maskColor" class="btn-ghost-xs" @click="theme.setMaskColor('')">重置</button>
              </div>
            </div>
          </div>
          <div class="setting-row">
            <div class="row-info">
              <div class="row-label">遮罩不透明度</div>
              <div class="row-desc">{{ theme.maskOpacity }}%</div>
            </div>
            <div class="row-control" style="flex: 1; max-width: 200px;">
              <input type="range" :value="theme.maskOpacity" min="0" max="100" class="range" @input="theme.setMaskOpacity(Number(($event.target as HTMLInputElement).value))" />
            </div>
          </div>
          <div class="setting-row">
            <div class="row-info">
              <div class="row-label">遮罩模糊</div>
              <div class="row-desc">{{ theme.maskBlur }}px</div>
            </div>
            <div class="row-control" style="flex: 1; max-width: 200px;">
              <input type="range" :value="theme.maskBlur" min="0" max="40" class="range" @input="theme.setMaskBlur(Number(($event.target as HTMLInputElement).value))" />
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- ================================================================
         同步
         ================================================================ -->
    <section v-if="activeTab === 'sync'">
      <WebDavSettings />
    </section>

    <!-- ================================================================
         集成
         ================================================================ -->
    <section v-if="activeTab === 'integrations'">
      <div class="settings-card">
        <div class="card-header">
          <h3>第三方集成</h3>
          <p>连接外部服务和插件</p>
        </div>
        <div class="card-body integration-card-body">
          <ExtensionsSettings />
          <div class="integration-secondary">
            <WechatSettings />
          </div>
        </div>
      </div>
    </section>

    <!-- ================================================================
         DATA
         ================================================================ -->
    <section v-if="activeTab === 'data'">

      <div class="settings-card">
        <div class="card-header">
          <h3>期刊 / 会议排名</h3>
          <p>CCF（A/B/C）与 SCI 分区（Q1–Q4）映射</p>
        </div>
        <div class="card-body ranking-card-body">
          <div class="input-row">
            <input v-model="rankingSearch" class="text-input" placeholder="搜索期刊 / 会议名称…" />
          </div>
          <div class="add-rank-row">
            <input v-model="newRankName" class="text-input" placeholder="名称" />
            <Select v-model="newRankCcf" :options="ccfSelectOptions" min-width="80px" />
            <Select v-model="newRankSci" :options="sciSelectOptions" min-width="80px" />
            <button class="btn-primary-sm" :disabled="!newRankName.trim() || (!newRankCcf && !newRankSci) || rankingSaving" @click="addCustomRanking">添加</button>
          </div>
          <div v-if="rankingLoading" class="empty-text">加载中…</div>
          <div v-else class="rank-list">
            <div v-for="e in filteredRankings" :key="e.name" class="rank-item">
              <span class="rank-name">{{ e.name }}</span>
              <span v-if="e.ccf" class="pill-badge ccf">{{ e.ccf }}</span>
              <span v-if="e.sci" class="pill-badge sci">{{ e.sci }}</span>
              <span v-if="e.custom" class="custom-tag">自定义</span>
              <button v-if="e.custom" class="tag-remove" @click="removeCustomRanking(e.name)">×</button>
            </div>
            <div v-if="!filteredRankings.length" class="empty-text">无匹配条目</div>
            <p v-if="rankingEntries.length > 200" class="group-hint">仅显示前 200 条，请用搜索缩小范围。</p>
          </div>
        </div>
      </div>

      <div class="settings-card">
        <div class="card-header">
          <h3>Markdown 笔记同步</h3>
          <p>从已关联的 Markdown 文件导入内容，数据库仍作为前端和 Agent 的笔记数据源。</p>
        </div>
        <div class="card-body">
          <div class="setting-row">
            <div class="row-info">
              <div class="row-label">同步关联笔记</div>
              <div class="row-desc">仅处理已有 filePath 的笔记；文件内容不同时更新数据库。</div>
            </div>
            <div class="row-control">
              <button class="btn-primary-sm" :disabled="noteSyncRunning" @click="syncLinkedNoteFiles">
                {{ noteSyncRunning ? '同步中…' : '立即同步' }}
              </button>
            </div>
          </div>
          <p v-if="noteSyncMessage" class="maintenance-message">{{ noteSyncMessage }}</p>
          <p v-if="noteSyncError" class="error-text">{{ noteSyncError }}</p>
        </div>
      </div>

      <div class="settings-card">
        <div class="card-header">
          <h3>缓存</h3>
        </div>
        <div class="card-body">
          <div class="setting-row">
            <div class="row-info">
              <div class="row-label">PDF 缓存天数</div>
              <div class="row-desc">浏览器缓存 PDF 的时长，0 表示不缓存</div>
            </div>
            <div class="row-control" style="flex: 1; max-width: 220px;">
              <input type="range" v-model.number="pdfCacheDays" min="0" max="7" step="1" class="range" @change="savePdfCacheDays" />
              <span class="range-value">{{ pdfCacheDays === 0 ? '关' : pdfCacheDays + '天' }}</span>
              <span v-if="pdfCacheSaved" class="save-check">✓</span>
            </div>
          </div>
        </div>
      </div>

      <div class="settings-card settings-card-danger">
        <div class="card-header">
          <h3>重置</h3>
        </div>
        <div class="card-body">
          <div class="setting-row">
            <div class="row-info">
              <div class="row-label">恢复默认设置</div>
              <div class="row-desc">恢复外观、编辑器、文献/搜索默认值（不影响提示词与模型）</div>
            </div>
            <div class="row-control">
              <button class="btn-danger" @click="resetAllSettings">重置</button>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- ================================================================
         系统
         ================================================================ -->
    <section v-if="activeTab === 'system'">
      <div class="settings-card backend-status-card">
        <div class="card-header">
          <div class="card-header-row">
            <div>
              <h3>后端状态</h3>
              <p>实时扫描文件系统并聚合当前状态；刷新时即时计算，不写入统计缓存。</p>
            </div>
            <button class="btn-ghost" :disabled="systemStatusLoading" @click="loadSystemStatus">{{ systemStatusLoading ? '刷新中…' : '刷新' }}</button>
          </div>
        </div>
        <div class="card-body">
          <div v-if="systemStatusLoading && !systemStatus" class="empty-text">加载中…</div>
          <div v-else-if="systemStatusError" class="error-text">{{ systemStatusError }}</div>
          <template v-else-if="systemStatus">
            <div class="status-meta">
              生成时间：{{ formatDateTime(systemStatus.generatedAt) }} · {{ systemStatus.note }}
            </div>

            <div class="maintenance-actions">
              <button class="btn-ghost-sm" :disabled="!!maintenanceRunning" @click="runMaintenance('embeddings', 'needed', '补齐/重试向量化')">
                {{ maintenanceRunning === 'embeddings:needed' ? '入队中…' : '补齐/重试向量化' }}
              </button>
              <button class="btn-ghost-sm" :disabled="!!maintenanceRunning" @click="runMaintenance('embeddings', 'all', '全部重新向量化', true)">
                {{ maintenanceRunning === 'embeddings:all' ? '入队中…' : '全部重新向量化' }}
              </button>
              <button class="btn-ghost-sm" :disabled="!!maintenanceRunning" @click="runMaintenance('mineru', 'needed', '重试 MinerU 解析')">
                {{ maintenanceRunning === 'mineru:needed' ? '入队中…' : '重试 MinerU 解析' }}
              </button>
              <button class="btn-ghost-sm" :disabled="!!maintenanceRunning" @click="runMaintenance('mineru', 'all', '全部重新 MinerU 解析', true)">
                {{ maintenanceRunning === 'mineru:all' ? '入队中…' : '全部重新 MinerU' }}
              </button>
              <button class="btn-ghost-sm" :disabled="!!maintenanceRunning" @click="runMaintenance('summaries', 'needed', '生成缺失总结')">
                {{ maintenanceRunning === 'summaries:needed' ? '入队中…' : '生成缺失总结' }}
              </button>
              <button class="btn-ghost-sm" :disabled="!!maintenanceRunning" @click="runMaintenance('summaries', 'all', '全部重新总结', true)">
                {{ maintenanceRunning === 'summaries:all' ? '入队中…' : '全部重新总结' }}
              </button>
            </div>
            <p v-if="maintenanceMessage" class="maintenance-message">{{ maintenanceMessage }}</p>
            <p v-if="maintenanceError" class="maintenance-error">{{ maintenanceError }}</p>

            <div class="status-grid">
              <div class="status-tile">
                <span class="status-label">论文总数</span>
                <strong>{{ formatNumber(systemStatus.papers.total) }}</strong>
                <small>目录 {{ formatNumber(systemStatus.mineru.paperDirs) }} 个</small>
              </div>
              <div class="status-tile warning">
                <span class="status-label">未总结</span>
                <strong>{{ formatNumber(systemStatus.papers.summaryCoverage?.missingSummaryEffective ?? systemStatus.papers.missingSummary) }}</strong>
                <small>含总结性笔记后 · {{ formatPercent(systemStatus.papers.summaryCoverage?.missingSummaryEffective ?? systemStatus.papers.missingSummary, systemStatus.papers.total) }}</small>
              </div>
              <div class="status-tile warning">
                <span class="status-label">未完成解析</span>
                <strong>{{ formatNumber(systemStatus.papers.unparsed) }}</strong>
                <small>失败 {{ formatNumber(systemStatus.papers.parseFailed) }} · 处理中 {{ formatNumber(systemStatus.papers.parseProcessing) }}</small>
              </div>
              <div class="status-tile warning">
                <span class="status-label">未走 MinerU</span>
                <strong>{{ formatNumber(systemStatus.mineru.notMineruParsed) }}</strong>
                <small>缺 result {{ formatNumber(systemStatus.mineru.missingResultJson) }} · fallback {{ formatNumber(systemStatus.mineru.fallbackResults) }}</small>
              </div>
              <div class="status-tile">
                <span class="status-label">Chunks</span>
                <strong>{{ formatNumber(systemStatus.chunks.totalChunks) }}</strong>
                <small>{{ formatNumber(systemStatus.chunks.papersWithChunks) }} 篇有向量</small>
              </div>
              <div class="status-tile">
                <span class="status-label">Chunks 占用</span>
                <strong>{{ formatBytes(systemStatus.chunks.totalBytes) }}</strong>
                <small>表 {{ formatBytes(systemStatus.chunks.tableBytes) }} · 索引 {{ formatBytes(systemStatus.chunks.indexBytes) }}</small>
              </div>
              <div class="status-tile">
                <span class="status-label">PDF 文件</span>
                <strong>{{ formatNumber(systemStatus.storage.pdfFiles) }}</strong>
                <small>{{ formatBytes(systemStatus.storage.pdfBytes) }}</small>
              </div>
              <div class="status-tile">
                <span class="status-label">数据目录</span>
                <strong>{{ formatBytes(systemStatus.storage.dataDir.bytes) }}</strong>
                <small>{{ formatNumber(systemStatus.storage.dataDir.files) }} 文件</small>
              </div>
            </div>

            <div class="status-sections">
              <div class="status-section">
                <h4>论文状态</h4>
                <dl>
                  <template v-for="[key, value] in statusEntries(systemStatus.papers.parseStatus)" :key="`parse-${key}`">
                    <dt>解析 {{ key }}</dt><dd>{{ formatNumber(value) }}</dd>
                  </template>
                  <template v-for="[key, value] in statusEntries(systemStatus.papers.embeddingStatus)" :key="`embedding-${key}`">
                    <dt>向量 {{ key }}</dt><dd>{{ formatNumber(value) }}</dd>
                  </template>
                  <template v-for="[key, value] in statusEntries(systemStatus.papers.summaryStatus)" :key="`summary-${key}`">
                    <dt>总结 {{ key }}</dt><dd>{{ formatNumber(value) }}</dd>
                  </template>
                  <dt>summary 字段为空</dt><dd>{{ formatNumber(systemStatus.papers.missingSummary) }}</dd>
                  <dt>有 summary 字段</dt><dd>{{ formatNumber(systemStatus.papers.summaryCoverage?.paperSummaryFilled) }}</dd>
                  <dt>有总结性笔记</dt><dd>{{ formatNumber(systemStatus.papers.summaryCoverage?.summaryLikeNotePapers) }}</dd>
                  <dt>其中 organized 笔记</dt><dd>{{ formatNumber(systemStatus.papers.summaryCoverage?.organizedNotePapers) }}</dd>
                  <dt>有效已总结</dt><dd>{{ formatNumber(systemStatus.papers.summaryCoverage?.summaryCovered) }}</dd>
                  <dt>状态 completed 但 summary 空</dt><dd>{{ formatNumber(systemStatus.papers.summaryCoverage?.completedWithoutSummaryField) }}</dd>
                  <dt>parseResult 缺失</dt><dd>{{ formatNumber(systemStatus.papers.parseResultMissing) }}</dd>
                  <dt>已解析但无 MinerU 元数据</dt><dd>{{ formatNumber(systemStatus.papers.completedWithoutMineruMetadata) }}</dd>
                  <dt>解析文本字符</dt><dd>{{ formatNumber(systemStatus.papers.totalParsedTextChars) }}</dd>
                </dl>
              </div>

              <div class="status-section">
                <h4>MinerU / 文件</h4>
                <dl>
                  <dt>result.json</dt><dd>{{ formatNumber(systemStatus.mineru.resultJson) }}</dd>
                  <dt>MinerU 原始结果</dt><dd>{{ formatNumber(systemStatus.mineru.rawMineruResults) }}</dd>
                  <dt>pdftotext fallback</dt><dd>{{ formatNumber(systemStatus.mineru.fallbackResults) }}</dd>
                  <dt>result.json 大小</dt><dd>{{ formatBytes(systemStatus.storage.mineruResultBytes) }}</dd>
                  <dt>缺 PDF 文件</dt><dd>{{ formatNumber(systemStatus.storage.missingPdfFile) }}</dd>
                  <dt>papers 目录占用</dt><dd>{{ formatBytes(systemStatus.storage.papersDir.bytes) }}</dd>
                </dl>
                <div class="mini-tags">
                  <span v-for="[key, value] in statusEntries(systemStatus.mineru.backendCounts)" :key="`backend-${key}`">backend {{ key }}: {{ formatNumber(value) }}</span>
                  <span v-for="[key, value] in statusEntries(systemStatus.mineru.statusCounts)" :key="`mineru-status-${key}`">status {{ key }}: {{ formatNumber(value) }}</span>
                </div>
              </div>

              <div class="status-section">
                <h4>向量库</h4>
                <dl>
                  <dt>有 embedding 的 chunks</dt><dd>{{ formatNumber(systemStatus.chunks.chunksWithEmbedding) }}</dd>
                  <dt>无 embedding 的 chunks</dt><dd>{{ formatNumber(systemStatus.chunks.chunksWithoutEmbedding) }}</dd>
                  <dt>无 chunks 的论文</dt><dd>{{ formatNumber(systemStatus.chunks.papersWithoutChunks) }}</dd>
                  <dt>平均 chunks / 篇</dt><dd>{{ Number(systemStatus.chunks.avgChunksPerPaper || 0).toFixed(1) }}</dd>
                  <dt>平均 chunk 字符</dt><dd>{{ Number(systemStatus.chunks.avgChunkChars || 0).toFixed(0) }}</dd>
                  <dt>最大 chunk 字符</dt><dd>{{ formatNumber(systemStatus.chunks.maxChunkChars) }}</dd>
                </dl>
                <div class="mini-tags">
                  <span v-for="dim in systemStatus.chunks.dimensions" :key="`dim-${dim.dimensions}`">{{ dim.dimensions || 'unknown' }} 维: {{ formatNumber(dim.count) }}</span>
                  <span v-for="idx in systemStatus.chunks.indexes" :key="idx.name">{{ idx.name }}: {{ formatBytes(idx.sizeBytes) }}</span>
                </div>
              </div>

              <div class="status-section task-queue-section">
                <h4>任务队列记录</h4>
                <div v-if="!systemStatus.tasks.byTypeStatus.length" class="empty-text">暂无任务记录</div>
                <dl v-else>
                  <template v-for="item in systemStatus.tasks.byTypeStatus" :key="`${item.type}-${item.status}`">
                    <dt>{{ taskTypeLabel(item.type) }} / {{ item.status }}</dt><dd>{{ formatNumber(item.count) }}</dd>
                  </template>
                </dl>

                <div class="queue-concurrency-panel">
                  <div class="queue-concurrency-head">
                    <div>
                      <strong>并发限制</strong>
                      <span>保存后立即影响后续取队列；不会中断已经运行中的任务。</span>
                    </div>
                    <div class="queue-concurrency-actions">
                      <span v-if="queueConcurrencySaved" class="saved-text">已保存</span>
                      <button class="btn-ghost-xs" :disabled="!queueConcurrencyDirty || queueConcurrencySaving" @click="resetQueueConcurrencyDraft">还原</button>
                      <button class="btn-primary-sm" :disabled="!queueConcurrencyDirty || queueConcurrencySaving" @click="saveQueueConcurrency">
                        {{ queueConcurrencySaving ? '保存中…' : '保存并发' }}
                      </button>
                    </div>
                  </div>
                  <div class="queue-concurrency-grid">
                    <label class="queue-concurrency-field">
                      <span>总并发</span>
                      <input v-model.number="queueConcurrencyDraft.maxConcurrent" type="number" min="1" max="50" class="text-input-sm" />
                    </label>
                    <label class="queue-concurrency-field">
                      <span>总结并发</span>
                      <input v-model.number="queueConcurrencyDraft.maxConcurrentSummaries" type="number" min="1" max="20" class="text-input-sm" />
                    </label>
                    <label class="queue-concurrency-field">
                      <span>向量并发</span>
                      <input v-model.number="queueConcurrencyDraft.maxConcurrentEmbeddings" type="number" min="1" max="20" class="text-input-sm" />
                    </label>
                    <label class="queue-concurrency-field">
                      <span>解析并发</span>
                      <input v-model.number="queueConcurrencyDraft.maxConcurrentParses" type="number" min="1" max="20" class="text-input-sm" />
                    </label>
                  </div>
                  <p v-if="queueConcurrencyError" class="maintenance-error queue-concurrency-error">{{ queueConcurrencyError }}</p>
                </div>

                <div class="pending-queue-panel">
                  <div class="pending-queue-header">
                    <div>
                      <span>待执行队列</span>
                      <small>共 {{ formatNumber(pendingQueueTotal) }} 个 · 滚动查看全部 pending 任务</small>
                    </div>
                    <div class="pending-queue-actions">
                      <button class="btn-ghost-xs" :disabled="!pendingQueueTasks.length || !!cancelTaskRunning" @click="toggleAllVisiblePendingTasks">
                        {{ allVisiblePendingSelected ? '取消全选' : '全选全部' }}
                      </button>
                      <button class="btn-danger-sm" :disabled="!selectedPendingTasks.length || !!cancelTaskRunning || !!maintenanceRunning" @click="cancelSelectedQueuedTasks">
                        {{ cancelTaskRunning === '__batch__' ? '取消中…' : `取消选中 (${selectedPendingTasks.length})` }}
                      </button>
                    </div>
                  </div>
                  <div v-if="!pendingQueueTasks.length" class="empty-text pending-queue-empty">暂无待执行任务</div>
                  <template v-else>
                    <div class="pending-queue-list" role="listbox" aria-label="待执行队列任务">
                      <div
                        v-for="task in pendingQueueTasks"
                        :key="task.id"
                        class="pending-queue-item"
                        :class="{ selected: selectedPendingTaskIds.has(task.id) }"
                      >
                        <input
                          type="checkbox"
                          class="pending-queue-check"
                          :checked="selectedPendingTaskIds.has(task.id)"
                          :disabled="!!cancelTaskRunning || !!maintenanceRunning"
                          :aria-label="`选择 ${task.paper?.title || task.paperId || task.id}`"
                          @click.stop
                          @change="togglePendingTaskSelection(task.id, ($event.target as HTMLInputElement).checked)"
                        />
                        <div class="pending-queue-main">
                          <div class="pending-queue-title-row">
                            <strong>{{ taskTypeLabel(task.type) }}</strong>
                            <span class="pending-queue-id">#{{ shortId(task.id) }}</span>
                          </div>
                          <span :title="task.paper?.title || task.paperId">{{ task.paper?.title || `论文 ${shortId(task.paperId)}` }}</span>
                          <small>{{ formatDateTime(task.createdAt) }}</small>
                        </div>
                        <button
                          class="btn-danger-sm"
                          type="button"
                          :disabled="!!cancelTaskRunning || !!maintenanceRunning"
                          @click.stop.prevent="cancelQueuedTask(task)"
                        >
                          {{ cancelTaskRunning === task.id ? '取消中…' : '取消' }}
                        </button>
                      </div>
                    </div>
                    <div v-if="pendingQueueHidden" class="pending-queue-more">
                      还有 {{ formatNumber(pendingQueueHidden) }} 个待执行任务未显示。可刷新同步最新队列状态。
                    </div>
                  </template>
                </div>
              </div>
            </div>
          </template>
        </div>
      </div>

      <div v-if="piSettingsLoading" class="empty-text">加载中…</div>
      <div v-else-if="piSettingsError" class="error-text">{{ piSettingsError }}</div>

      <template v-else>
        <div class="settings-card">
          <div class="card-header">
            <h3>模型与思考</h3>
          </div>
          <div class="card-body">
            <div class="setting-row">
              <div class="row-info">
                <div class="row-label">默认 Provider</div>
              </div>
              <div class="row-control">
                <Select :model-value="piSettings.defaultProvider || ''" :options="providerSelectOptions" min-width="220px" @update:model-value="updateDefaultProvider" />
              </div>
            </div>
            <div class="setting-row">
              <div class="row-info">
                <div class="row-label">默认模型</div>
              </div>
              <div class="row-control">
                <Select :model-value="piSettings.defaultModel || ''" :options="defaultModelSelectOptions" min-width="320px" @update:model-value="updateDefaultModel" />
              </div>
            </div>
            <div class="setting-row">
              <div class="row-info">
                <div class="row-label">总结模型</div>
                <div class="row-desc">用于“生成总结笔记”和批量总结；留空则使用 Pi 默认模型。</div>
              </div>
              <div class="row-control">
                <Select :model-value="summaryModelSelectValue" :groups="summaryModelSelectGroups" min-width="360px" @update:model-value="updateSummaryModel" />
              </div>
            </div>
            <div class="setting-row">
              <div class="row-info">
                <div class="row-label">隐藏思考块</div>
              </div>
              <div class="row-control">
                <div class="toggle-track" :class="{ on: piSettings.hideThinkingBlock }" @click="piSettings.hideThinkingBlock = !piSettings.hideThinkingBlock; savePiSettings()"><div class="toggle-thumb" /></div>
              </div>
            </div>
          </div>
        </div>

        <div class="settings-card">
          <div class="card-header">
            <h3>上下文压缩</h3>
          </div>
          <div class="card-body">
            <div class="setting-row">
              <div class="row-info">
                <div class="row-label">自动压缩</div>
              </div>
              <div class="row-control">
                <div class="toggle-track" :class="{ on: piSettings.compaction.enabled }" @click="piSettings.compaction.enabled = !piSettings.compaction.enabled; savePiSettings()"><div class="toggle-thumb" /></div>
              </div>
            </div>
            <div class="setting-row">
              <div class="row-info">
                <div class="row-label">保留 Tokens</div>
              </div>
              <div class="row-control">
                <input v-model.number="piSettings.compaction.reserveTokens" type="number" class="text-input" style="max-width: 120px;" @change="savePiSettings" />
              </div>
            </div>
            <div class="setting-row">
              <div class="row-info">
                <div class="row-label">最近 Tokens</div>
              </div>
              <div class="row-control">
                <input v-model.number="piSettings.compaction.keepRecentTokens" type="number" class="text-input" style="max-width: 120px;" @change="savePiSettings" />
              </div>
            </div>
          </div>
        </div>

        <div class="settings-card">
          <div class="card-header">
            <h3>重试</h3>
          </div>
          <div class="card-body">
            <div class="setting-row">
              <div class="row-info">
                <div class="row-label">自动重试</div>
              </div>
              <div class="row-control">
                <div class="toggle-track" :class="{ on: piSettings.retry.enabled }" @click="piSettings.retry.enabled = !piSettings.retry.enabled; savePiSettings()"><div class="toggle-thumb" /></div>
              </div>
            </div>
            <div class="setting-row">
              <div class="row-info">
                <div class="row-label">最大次数</div>
              </div>
              <div class="row-control">
                <input v-model.number="piSettings.retry.maxRetries" type="number" class="text-input" style="max-width: 100px;" @change="savePiSettings" />
              </div>
            </div>
            <div class="setting-row">
              <div class="row-info">
                <div class="row-label">基础延迟 (ms)</div>
              </div>
              <div class="row-control">
                <input v-model.number="piSettings.retry.baseDelayMs" type="number" class="text-input" style="max-width: 120px;" @change="savePiSettings" />
              </div>
            </div>
            <div class="setting-row">
              <div class="row-info">
                <div class="row-label">Provider 超时 (ms)</div>
              </div>
              <div class="row-control">
                <input v-model.number="piSettings.retry.provider.timeoutMs" type="number" class="text-input" style="max-width: 140px;" @change="savePiSettings" />
              </div>
            </div>
            <div class="setting-row">
              <div class="row-info">
                <div class="row-label">Provider 重试次数</div>
              </div>
              <div class="row-control">
                <input v-model.number="piSettings.retry.provider.maxRetries" type="number" class="text-input" style="max-width: 100px;" @change="savePiSettings" />
              </div>
            </div>
            <div class="setting-row">
              <div class="row-info">
                <div class="row-label">最大重试延迟 (ms)</div>
              </div>
              <div class="row-control">
                <input v-model.number="piSettings.retry.provider.maxRetryDelayMs" type="number" class="text-input" style="max-width: 120px;" @change="savePiSettings" />
              </div>
            </div>
          </div>
        </div>

        <div class="settings-card">
          <div class="card-header">
            <h3>消息传递</h3>
          </div>
          <div class="card-body">
            <div class="setting-row">
              <div class="row-info">
                <div class="row-label">Steering</div>
              </div>
              <div class="row-control">
                <Select :model-value="piSettings.steeringMode || ''" :options="steeringOptions" @update:model-value="piSettings.steeringMode = $event; savePiSettings()" />
              </div>
            </div>
            <div class="setting-row">
              <div class="row-info">
                <div class="row-label">Follow-up</div>
              </div>
              <div class="row-control">
                <Select :model-value="piSettings.followUpMode || ''" :options="steeringOptions" @update:model-value="piSettings.followUpMode = $event; savePiSettings()" />
              </div>
            </div>
            <div class="setting-row">
              <div class="row-info">
                <div class="row-label">Transport</div>
              </div>
              <div class="row-control">
                <Select :model-value="piSettings.transport || ''" :options="transportOptions" @update:model-value="piSettings.transport = $event; savePiSettings()" />
              </div>
            </div>
          </div>
        </div>

        <div class="settings-card">
          <div class="card-header">
            <h3>网络</h3>
          </div>
          <div class="card-body">
            <div class="setting-row">
              <div class="row-info">
                <div class="row-label">HTTP Proxy</div>
              </div>
              <div class="row-control">
                <input v-model="piSettings.httpProxy" class="text-input" placeholder="http://127.0.0.1:7890" @change="savePiSettings" style="max-width: 240px;" />
              </div>
            </div>
          </div>
        </div>

        <div class="settings-card">
          <div class="card-header">
            <h3>图片与 Shell</h3>
          </div>
          <div class="card-body">
            <div class="setting-row">
              <div class="row-info">
                <div class="row-label">自动缩放图片</div>
                <div class="row-desc">发送给 LLM 前自动压缩</div>
              </div>
              <div class="row-control">
                <div class="toggle-track" :class="{ on: piSettings.images.autoResize }" @click="piSettings.images.autoResize = !piSettings.images.autoResize; savePiSettings()"><div class="toggle-thumb" /></div>
              </div>
            </div>
            <div class="setting-row">
              <div class="row-info">
                <div class="row-label">阻止图片发送</div>
              </div>
              <div class="row-control">
                <div class="toggle-track" :class="{ on: piSettings.images.blockImages }" @click="piSettings.images.blockImages = !piSettings.images.blockImages; savePiSettings()"><div class="toggle-thumb" /></div>
              </div>
            </div>
            <div class="setting-row">
              <div class="row-info">
                <div class="row-label">Shell 路径</div>
              </div>
              <div class="row-control">
                <input v-model="piSettings.shellPath" class="text-input" placeholder="默认" @change="savePiSettings" style="max-width: 200px;" />
              </div>
            </div>
            <div class="setting-row">
              <div class="row-info">
                <div class="row-label">命令前缀</div>
              </div>
              <div class="row-control">
                <input v-model="piSettings.shellCommandPrefix" class="text-input" placeholder="可选" @change="savePiSettings" style="max-width: 200px;" />
              </div>
            </div>
          </div>
        </div>

        <div class="settings-card">
          <div class="card-header">
            <h3>遥测</h3>
          </div>
          <div class="card-body">
            <div class="setting-row">
              <div class="row-info">
                <div class="row-label">安装/更新遥测</div>
              </div>
              <div class="row-control">
                <div class="toggle-track" :class="{ on: piSettings.enableInstallTelemetry }" @click="piSettings.enableInstallTelemetry = !piSettings.enableInstallTelemetry; savePiSettings()"><div class="toggle-thumb" /></div>
              </div>
            </div>
          </div>
        </div>

        <p v-if="piSettingsSaving" class="save-hint">保存中…</p>
      </template>
    </section>

  </div>
</template>

<style scoped>

/* ── Settings Layout ──────────────────────────────────────────────────── */

/* ── Content layout ─────────────────────────────────────────────────────── */
.settings-content {
  display: flex;
  flex-direction: column;
  width: 100%;
  margin: 0 auto;
  container-name: settings;
  container-type: inline-size;
}
.settings-content > section {
  display: grid;
  gap: 24px;
}

/* ── Cards ───────────────────────────────────────────────────────────── */
.settings-card {
  background: color-mix(in srgb, var(--color-bg-card) 96%, var(--color-bg));
  border: 1px solid color-mix(in srgb, var(--color-border) 88%, transparent);
  border-radius: 16px;
  overflow: hidden;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.03), 0 10px 30px rgba(15, 23, 42, 0.035);
}
.settings-card-danger {
  border-color: color-mix(in srgb, var(--color-error) 30%, transparent);
}
.card-header {
  padding: 24px 28px 20px;
}
.card-header h3 {
  font-size: 17px;
  font-weight: 680;
  color: var(--color-text);
  margin: 0 0 6px;
  letter-spacing: -0.02em;
}
.card-header p {
  font-size: 13px;
  color: var(--color-text-muted);
  margin: 0;
  line-height: 1.55;
}
.card-header-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
}
.card-body {
  padding: 0;
}
.card-body > .empty-text,
.card-body > .error-text {
  padding: 14px 28px 22px;
}
.integration-card-body,
.ranking-card-body {
  padding: 0 28px 28px;
}
.integration-secondary { margin-top: 18px; }
.ranking-card-body > .input-row { margin-bottom: 12px; }

/* ── Backend status ─────────────────────────────────────────────────── */
.status-meta {
  padding: 10px 22px 0;
  font-size: 12px;
  color: var(--color-text-muted);
}
.maintenance-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 12px 22px 0;
}
.maintenance-message,
.maintenance-error {
  margin: 8px 22px 0;
  font-size: 12px;
}
.maintenance-message { color: var(--color-success); }
.maintenance-error { color: var(--color-error); }
.status-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 10px;
  padding: 14px 22px;
}
.status-tile {
  border: 1px solid var(--color-border);
  border-radius: 10px;
  background: color-mix(in srgb, var(--color-bg-muted) 55%, transparent);
  padding: 12px;
  min-width: 0;
}
.status-tile.warning {
  border-color: color-mix(in srgb, #f59e0b 38%, var(--color-border));
  background: color-mix(in srgb, #f59e0b 8%, var(--color-bg-card));
}
.status-label {
  display: block;
  font-size: 12px;
  color: var(--color-text-muted);
  margin-bottom: 6px;
}
.status-tile strong {
  display: block;
  font-size: 22px;
  line-height: 1.1;
  color: var(--color-text);
  letter-spacing: -0.02em;
}
.status-tile small {
  display: block;
  margin-top: 6px;
  font-size: 11.5px;
  color: var(--color-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.status-sections {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 12px;
  padding: 0 22px 18px;
}
.status-section {
  border-top: 1px solid var(--color-border);
  padding-top: 12px;
  min-width: 0;
}
.status-section h4 {
  margin: 0 0 8px;
  font-size: 13px;
  color: var(--color-text);
}
.status-section dl {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 6px 12px;
  margin: 0;
  font-size: 12px;
}
.status-section dt {
  color: var(--color-text-muted);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.status-section dd {
  margin: 0;
  color: var(--color-text);
  font-variant-numeric: tabular-nums;
}
.mini-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 10px;
}
.mini-tags span {
  font-size: 11px;
  color: var(--color-text-muted);
  border: 1px solid var(--color-border);
  border-radius: 999px;
  padding: 3px 7px;
  background: var(--color-bg-card);
}
.task-queue-section {
  grid-column: 1 / -1;
}
.queue-concurrency-panel {
  margin-top: 14px;
  border: 1px solid var(--color-border);
  border-radius: 12px;
  padding: 12px 14px;
  background: color-mix(in srgb, var(--color-bg-muted) 34%, transparent);
}
.queue-concurrency-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}
.queue-concurrency-head > div:first-child {
  display: grid;
  gap: 3px;
  min-width: 0;
}
.queue-concurrency-head strong {
  font-size: 13px;
  color: var(--color-text);
}
.queue-concurrency-head span {
  font-size: 11.5px;
  color: var(--color-text-muted);
}
.queue-concurrency-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.queue-concurrency-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
  gap: 10px;
}
.queue-concurrency-field {
  display: grid;
  gap: 6px;
  font-size: 12px;
  color: var(--color-text-secondary);
}
.queue-concurrency-field input {
  width: 100%;
}
.queue-concurrency-error {
  margin: 10px 0 0;
}
.queue-concurrency-actions .saved-text {
  font-size: 12px;
  color: var(--color-success);
}
.pending-queue-panel {
  margin-top: 14px;
  border: 1px solid var(--color-border);
  border-radius: 12px;
  overflow: hidden;
  background: linear-gradient(180deg, color-mix(in srgb, var(--color-bg-muted) 48%, transparent), transparent 72px);
}
.pending-queue-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--color-border);
  font-size: 12px;
  font-weight: 650;
  color: var(--color-text);
}
.pending-queue-header > div:first-child {
  display: grid;
  gap: 2px;
  min-width: 0;
}
.pending-queue-header small {
  font-size: 11px;
  font-weight: 400;
  color: var(--color-text-muted);
}
.pending-queue-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.pending-queue-empty {
  padding: 12px 14px;
}
.pending-queue-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 340px;
  overflow: auto;
  padding: 10px;
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--color-text-muted) 35%, transparent) transparent;
}
.pending-queue-list::-webkit-scrollbar { width: 8px; }
.pending-queue-list::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--color-text-muted) 30%, transparent);
  border-radius: 999px;
}
.pending-queue-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  border: 1px solid color-mix(in srgb, var(--color-border) 82%, transparent);
  border-radius: 10px;
  padding: 10px 12px;
  background: color-mix(in srgb, var(--color-bg-card) 88%, var(--color-bg-muted));
  transition: border-color 0.15s ease, background 0.15s ease, box-shadow 0.15s ease;
}
.pending-queue-item:hover {
  border-color: color-mix(in srgb, var(--color-primary) 36%, var(--color-border));
  background: color-mix(in srgb, var(--color-primary-soft) 42%, var(--color-bg-card));
}
.pending-queue-item.selected {
  border-color: color-mix(in srgb, var(--color-primary) 58%, var(--color-border));
  background: color-mix(in srgb, var(--color-primary-soft) 62%, var(--color-bg-card));
  box-shadow: inset 3px 0 0 var(--color-primary);
}
.pending-queue-check {
  width: 16px;
  height: 16px;
  accent-color: var(--color-primary);
  flex-shrink: 0;
}
.pending-queue-main {
  display: grid;
  gap: 3px;
  min-width: 0;
  flex: 1;
}
.pending-queue-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.pending-queue-main strong {
  font-size: 12px;
  color: var(--color-text);
}
.pending-queue-main span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--color-text-secondary);
}
.pending-queue-main .pending-queue-id {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--color-text-muted);
  font-variant-numeric: tabular-nums;
}
.pending-queue-main small {
  font-size: 11px;
  color: var(--color-text-muted);
}
.pending-queue-more {
  margin: 0 10px 10px;
  padding: 8px 10px;
  border: 1px dashed var(--color-border);
  border-radius: 8px;
  font-size: 12px;
  color: var(--color-text-muted);
  background: color-mix(in srgb, var(--color-bg-muted) 35%, transparent);
}

/* ── Setting Rows ────────────────────────────────────────────────────── */
.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 28px;
  min-height: 70px;
  padding: 16px 28px;
  border-top: 1px solid color-mix(in srgb, var(--color-border) 82%, transparent);
}
.row-info {
  flex: 1 1 46%;
  min-width: 0;
}
.row-label {
  font-size: 14.5px;
  font-weight: 560;
  color: var(--color-text);
  line-height: 1.35;
}
.row-desc {
  font-size: 12.5px;
  color: var(--color-text-muted);
  margin-top: 4px;
  line-height: 1.45;
}
.row-control {
  flex: 0 1 52%;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
}
.row-control :deep(.modern-select) {
  min-width: 132px;
  max-width: 240px;
}
.row-control :deep(.select-display) {
  min-height: 38px;
  padding: 8px 12px;
}

/* ── Setting Groups (with border-top separator) ──────────────────────── */
.setting-group {
  padding: 20px 28px;
  border-top: 1px solid color-mix(in srgb, var(--color-border) 82%, transparent);
}
.group-label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 14px;
  font-weight: 500;
  color: var(--color-text);
  margin-bottom: 10px;
}
.group-label.collapsible {
  cursor: pointer;
  margin-bottom: 0;
  padding: 4px 0;
  user-select: none;
  transition: color 0.15s ease;
}
.group-label.collapsible:hover {
  color: var(--color-primary);
}
.group-label-main {
  display: flex;
  align-items: center;
  gap: 10px;
}
.expand-icon {
  font-size: 12px;
  color: var(--color-text-muted);
  transition: transform 0.2s ease;
}
.group-hint {
  font-size: 12px;
  color: var(--color-text-muted);
  margin: 0 0 10px;
  line-height: 1.5;
}
.group-hint code {
  background: var(--color-bg-muted);
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 11px;
  font-family: 'SF Mono', 'Fira Code', monospace;
}

/* ── Controls ────────────────────────────────────────────────────────── */
.pill-group {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.pill {
  min-height: 36px;
  padding: 7px 15px;
  border: 1px solid var(--color-border);
  border-radius: 20px;
  background: transparent;
  color: var(--color-text-secondary);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
}
.pill:hover {
  background: var(--color-bg-muted);
  border-color: var(--color-border-hover);
  color: var(--color-text);
}
.pill.active {
  border-color: var(--color-primary);
  background: var(--color-primary-soft);
  color: var(--color-primary);
  font-weight: 600;
}

.toggle-track {
  width: 44px;
  height: 24px;
  border-radius: 12px;
  background: var(--color-bg-muted);
  position: relative;
  cursor: pointer;
  border: 1px solid var(--color-border);
  transition: background 0.2s ease, border-color 0.2s ease;
  flex-shrink: 0;
}
.toggle-track.on {
  background: var(--color-primary);
  border-color: var(--color-primary);
}
.toggle-thumb {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: #fff;
  position: absolute;
  top: 2px;
  left: 2px;
  box-shadow: 0 1px 4px rgba(0,0,0,0.2);
  transition: left 0.2s ease, transform 0.15s ease;
}
.toggle-track.on .toggle-thumb { left: 22px; }
.toggle-track:hover .toggle-thumb { transform: scale(1.1); }

.color-swatches {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.swatch {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: 3px solid transparent;
  cursor: pointer;
  transition: transform 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease;
}
.swatch:hover {
  transform: scale(1.15);
  box-shadow: 0 2px 8px rgba(0,0,0,0.15);
}
.swatch.active {
  border-color: var(--color-text);
  transform: scale(1.15);
  box-shadow: 0 2px 12px rgba(0,0,0,0.2);
}

.color-picker {
  width: 36px;
  height: 34px;
  padding: 2px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-bg-card);
  cursor: pointer;
  flex-shrink: 0;
}

.range {
  width: 100%;
  height: 6px;
  border-radius: 3px;
  background: var(--color-bg-muted);
  outline: none;
  -webkit-appearance: none;
}
.range::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--color-primary);
  cursor: pointer;
  box-shadow: 0 2px 6px rgba(0,0,0,0.15);
  transition: transform 0.15s ease;
}
.range::-webkit-slider-thumb:hover { transform: scale(1.2); }
.range-value {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text);
  min-width: 48px;
  text-align: right;
}
.range-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

/* ── Inputs ──────────────────────────────────────────────────────────── */
.input-row {
  display: flex;
  gap: 8px;
  align-items: center;
}
.input-row.compact { gap: 6px; }
.text-input {
  flex: 1;
  min-height: 38px;
  padding: 9px 12px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-bg-card);
  color: var(--color-text);
  font-size: 13px;
  outline: none;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
  min-width: 0;
}
.text-input:focus {
  border-color: var(--color-primary);
  box-shadow: 0 0 0 3px var(--color-primary-soft);
}
.text-input-sm {
  padding: 5px 10px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-bg-card);
  color: var(--color-text);
  font-size: 12px;
  outline: none;
  transition: border-color 0.15s ease;
  width: 100%;
}
.text-input-sm:focus {
  border-color: var(--color-primary);
}
.code-textarea {
  width: 100%;
  min-height: 200px;
  padding: 12px 14px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-bg-card);
  color: var(--color-text);
  font-size: 13px;
  font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
  line-height: 1.6;
  resize: vertical;
  outline: none;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.code-textarea:focus {
  border-color: var(--color-primary);
  box-shadow: 0 0 0 3px var(--color-primary-soft);
}
.code-textarea:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.code-textarea-sm {
  width: 100%;
  min-height: 48px;
  padding: 8px 10px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-bg-card);
  color: var(--color-text);
  font-size: 12px;
  font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
  line-height: 1.5;
  resize: vertical;
  outline: none;
  transition: border-color 0.15s ease;
}
.code-textarea-sm:focus {
  border-color: var(--color-primary);
}
/* ── Compat Editor ── */
.compat-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.compat-groups {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.compat-group {
  border: 1px solid var(--color-border);
  border-radius: 10px;
  padding: 11px 13px;
  background: var(--color-bg-card);
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.compat-group :deep(.modern-select) { min-width: 150px; }
.compat-group-label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--color-text-muted);
  margin-bottom: 2px;
}
.compat-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 3px 0;
}
.compat-info {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.compat-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--color-text);
}
.compat-desc {
  font-size: 11px;
  color: var(--color-text-muted);
}
.compat-json-row {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.compat-inline {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 10px;
  background: var(--color-bg-card);
  border: 1px solid var(--color-border);
  border-radius: 9px;
}
.compat-row-sm {
  display: flex;
  align-items: center;
  gap: 8px;
}
.compat-label-sm {
  font-size: 12px;
  font-weight: 500;
  color: var(--color-text-secondary);
  min-width: 120px;
  flex-shrink: 0;
}
.check-row {
  display: flex;
  gap: 12px;
}
.check-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--color-text);
  cursor: pointer;
}
.hidden { display: none; }

/* ── Buttons ─────────────────────────────────────────────────────────── */
.btn-primary {
  min-height: 38px;
  padding: 8px 17px;
  border: none;
  border-radius: 8px;
  background: var(--color-primary);
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.15s ease;
}
.btn-primary:hover { filter: brightness(1.1); }
.btn-primary:disabled { opacity: 0.5; cursor: default; filter: none; }
.btn-primary-sm {
  min-height: 34px;
  padding: 7px 14px;
  border: none;
  border-radius: 8px;
  background: var(--color-primary);
  color: #fff;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.15s ease;
}
.btn-primary-sm:hover { filter: brightness(1.1); }
.btn-primary-sm:disabled { opacity: 0.5; cursor: default; filter: none; }
.btn-ghost {
  min-height: 38px;
  padding: 8px 16px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: transparent;
  color: var(--color-text-secondary);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.15s ease;
}
.btn-ghost:hover {
  background: var(--color-bg-muted);
  border-color: var(--color-border-hover);
  color: var(--color-text);
}
.btn-ghost-sm {
  min-height: 32px;
  padding: 6px 12px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: transparent;
  color: var(--color-primary);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.15s ease;
}
.btn-ghost-sm:hover {
  border-color: var(--color-primary);
  background: var(--color-primary-soft);
}
.btn-ghost-sm:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-ghost-xs {
  padding: 3px 10px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: transparent;
  color: var(--color-text-secondary);
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
}
.btn-ghost-xs:hover {
  border-color: var(--color-primary);
  color: var(--color-primary);
  background: var(--color-primary-soft);
}
.btn-danger {
  padding: 8px 16px;
  border: 1px solid var(--color-error);
  border-radius: 8px;
  background: transparent;
  color: var(--color-error);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s ease;
}
.btn-danger:hover {
  background: var(--color-error);
  color: #fff;
}
.btn-danger-sm {
  padding: 5px 12px;
  border: 1px solid var(--color-error);
  border-radius: 6px;
  background: transparent;
  color: var(--color-error);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.15s ease;
}
.btn-danger-sm:hover:not(:disabled) {
  background: var(--color-error);
  color: #fff;
}
.btn-danger-sm:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.btn-icon {
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  cursor: pointer;
  border-radius: 6px;
  font-size: 13px;
  transition: background 0.15s ease;
}
.btn-icon:hover { background: var(--color-bg-muted); }
.btn-icon.danger:hover { background: rgba(239,68,68,0.1); }
.btn-add {
  display: flex;
  align-items: center;
  gap: 6px;
  width: calc(100% - 56px);
  padding: 10px 16px;
  border: 1px dashed var(--color-border);
  border-radius: 8px;
  background: transparent;
  color: var(--color-primary);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
  margin: 12px 28px 24px;
}
.btn-add:hover {
  border-color: var(--color-primary);
  background: var(--color-primary-soft);
}
.add-icon {
  font-size: 16px;
  font-weight: 600;
  line-height: 1;
}
.form-actions {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}
.inline-btns {
  display: flex;
  gap: 4px;
}
.expand-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  font-size: 12px;
  color: var(--color-text-muted);
  transition: transform 0.2s ease, color 0.15s ease;
}
.expand-icon.open {
  transform: rotate(90deg);
  color: var(--color-primary);
}
.expand-icon.sm { width: 14px; font-size: 10px; }

/* ── Badges ──────────────────────────────────────────────────────────── */
.badge {
  padding: 2px 8px;
  border-radius: 6px;
  background: var(--color-bg-muted);
  color: var(--color-text-secondary);
  font-size: 11px;
  font-weight: 500;
  white-space: nowrap;
}
.badge-accent {
  background: var(--color-primary-soft);
  color: var(--color-primary);
}
.badge-muted {
  background: var(--color-bg-muted);
  color: var(--color-text-muted);
}
.badge-sm {
  font-size: 10px;
  padding: 1px 6px;
  background: var(--color-bg-muted);
  border: 1px solid var(--color-border);
  border-radius: 4px;
  color: var(--color-text-muted);
  font-weight: 500;
}
.pill-badge {
  padding: 3px 10px;
  border-radius: 20px;
  font-size: 11px;
  font-weight: 600;
}
.pill-badge.active { background: rgba(34,197,94,0.1); color: #22c55e; }
.pill-badge.oauth { background: rgba(99,102,241,0.1); color: #6366f1; }
.pill-badge.ccf { background: rgba(37,99,235,0.1); color: #2563eb; }
.pill-badge.sci { background: rgba(22,163,74,0.1); color: #16a34a; }
.save-check { font-size: 12px; color: #22c55e; font-weight: 600; }
.save-hint { font-size: 12px; color: var(--color-text-muted); margin-top: 8px; }
.error-text { font-size: 13px; color: var(--color-error); }
.empty-text { font-size: 12px; color: var(--color-text-muted); padding: 4px 0; }
.custom-tag { font-size: 11px; color: var(--color-primary); }
.added-badge { font-size: 11px; color: #22c55e; font-weight: 600; }

/* ── Tags & Patterns ─────────────────────────────────────────────────── */
.pattern-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
}
.pattern-tag {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  border-radius: 8px;
  background: var(--color-bg-muted);
  font-size: 12px;
}
.pattern-tag code {
  color: var(--color-primary);
  font-weight: 600;
  font-family: 'SF Mono', 'Fira Code', monospace;
}
.tag-remove {
  border: none;
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  font-size: 13px;
  padding: 0 2px;
  line-height: 1;
  transition: color 0.15s ease;
}
.tag-remove:hover { color: var(--color-error); }

/* ── Model Grid ──────────────────────────────────────────────────────── */
.model-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  padding: 16px 28px 20px;
  border-top: 1px solid color-mix(in srgb, var(--color-border) 82%, transparent);
}
.model-item {
  display: flex;
  align-items: center;
  gap: 14px;
  min-height: 86px;
  padding: 14px 16px;
  background: var(--color-bg-card);
  border: 1px solid color-mix(in srgb, var(--color-primary) 30%, var(--color-border));
  border-radius: 11px;
  cursor: pointer;
  transition: border-color 0.15s ease, box-shadow 0.15s ease, transform 0.15s ease, opacity 0.15s ease;
}
.model-item:hover {
  border-color: color-mix(in srgb, var(--color-primary) 50%, var(--color-border));
  box-shadow: 0 4px 14px rgba(15, 23, 42, 0.06);
  transform: translateY(-1px);
}
.model-item.disabled {
  opacity: 0.6;
  border-color: var(--color-border);
  background: color-mix(in srgb, var(--color-bg-muted) 45%, transparent);
}
.model-item.disabled:hover { opacity: 0.85; }
.model-toggle { flex-shrink: 0; }
.model-info { flex: 1; min-width: 0; }
.model-name {
  font-size: 14px;
  font-weight: 500;
  color: var(--color-text);
  margin-bottom: 2px;
}
.model-id {
  font-size: 12px;
  color: var(--color-text-muted);
  font-family: 'SF Mono', 'Fira Code', monospace;
}
.model-badges {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 6px;
}

/* ── Providers ───────────────────────────────────────────────────────── */
.provider-item {
  border: 1px solid var(--color-border);
  border-radius: 12px;
  overflow: hidden;
  margin: 10px 28px 0;
  background: var(--color-bg-card);
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.provider-item:hover {
  border-color: var(--color-border-hover);
  box-shadow: 0 2px 10px rgba(15, 23, 42, 0.05);
}
.provider-item:has(.provider-body) {
  border-color: color-mix(in srgb, var(--color-primary) 34%, var(--color-border));
  box-shadow: 0 4px 18px rgba(15, 23, 42, 0.06);
}
.provider-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  cursor: pointer;
  transition: background 0.15s ease;
}
.provider-head:hover { background: color-mix(in srgb, var(--color-bg-muted) 60%, transparent); }
.provider-head.open { background: color-mix(in srgb, var(--color-primary) 5%, transparent); }
.provider-avatar {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  border-radius: 9px;
  background: color-mix(in srgb, var(--color-primary) 14%, transparent);
  color: var(--color-primary);
  font-size: 14px;
  font-weight: 700;
}
.provider-head-info {
  display: flex;
  flex-direction: column;
  gap: 3px;
  flex: 1;
  min-width: 0;
}
.provider-head-info strong {
  font-size: 14px;
  font-weight: 620;
  color: var(--color-text);
  letter-spacing: -0.01em;
}
.provider-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  font-size: 11.5px;
  color: var(--color-text-muted);
  min-width: 0;
}
.meta-chip {
  padding: 1px 7px;
  border-radius: 5px;
  background: var(--color-bg-muted);
  color: var(--color-text-secondary);
  font-size: 11px;
  white-space: nowrap;
}
.meta-url {
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.provider-head-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}
.provider-body {
  padding: 16px;
  border-top: 1px solid var(--color-border);
  background: color-mix(in srgb, var(--color-bg-muted) 34%, transparent);
}
.provider-config {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.field-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px 12px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}
.field-wide { grid-column: 1 / -1; }
.field-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--color-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.field :deep(.modern-select) { width: 100%; }
.field :deep(.select-display) { min-height: 38px; }
.section-label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  font-weight: 650;
  color: var(--color-text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.section-hint {
  font-size: 11px;
  font-weight: 400;
  color: var(--color-text-muted);
  text-transform: none;
  letter-spacing: 0;
}
.section-count {
  padding: 1px 7px;
  border-radius: 20px;
  background: var(--color-bg-muted);
  color: var(--color-text-muted);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0;
}
.provider-models { margin-top: 16px; }
.models-header-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}
.model-entries {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.model-entry {
  border: 1px solid var(--color-border);
  border-radius: 9px;
  overflow: hidden;
  background: var(--color-bg-card);
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.model-entry:hover { border-color: var(--color-border-hover); }
.model-entry.open {
  border-color: color-mix(in srgb, var(--color-primary) 40%, var(--color-border));
  box-shadow: 0 2px 10px rgba(15, 23, 42, 0.05);
}
.model-entry-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 12px;
  cursor: pointer;
  transition: background 0.15s ease;
}
.model-entry-head:hover { background: color-mix(in srgb, var(--color-bg-muted) 60%, transparent); }
.model-entry-name {
  flex: 1;
  font-size: 13px;
  font-weight: 500;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.model-entry-badges { display: flex; gap: 4px; }
.model-edit {
  padding: 14px;
  background: color-mix(in srgb, var(--color-bg-muted) 55%, transparent);
  border-top: 1px solid var(--color-border);
}
.model-edit-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.edit-field {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}
.edit-field :deep(.modern-select) { width: 100%; }
.edit-field label {
  font-size: 11px;
  color: var(--color-text-muted);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}
.cost-grid {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 3px 8px;
  align-items: center;
  font-size: 12px;
}
.cost-grid span { font-size: 11px; color: var(--color-text-muted); }
.tlm-grid {
  display: grid;
  grid-template-columns: 56px 1fr;
  gap: 3px 8px;
  align-items: center;
}
.tlm-label {
  font-size: 11px;
  color: var(--color-text-muted);
  font-family: monospace;
}
.tlm-value-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.tlm-value-row .text-input-sm { flex: 1; }
.tlm-add-row { margin-top: 8px; }
.tlm-picker {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 12px;
  margin-top: 8px;
  padding: 8px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg-muted);
}
.tlm-picker .check-label { font-family: monospace; }
.tlm-picker-actions {
  display: flex;
  gap: 6px;
  width: 100%;
}
.add-model-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
  padding: 10px;
  align-items: center;
  border: 1px dashed var(--color-border);
  border-radius: 10px;
  transition: border-color 0.15s ease;
}
.add-model-row:focus-within { border-color: color-mix(in srgb, var(--color-primary) 45%, var(--color-border)); }
.add-model-row .text-input { min-width: 120px; }
.fetched-panel {
  margin-top: 12px;
  padding: 14px;
  background: var(--color-bg-card);
  border: 1px solid var(--color-border);
  border-radius: 11px;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.02);
}
.fetched-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 240px;
  overflow-y: auto;
}
.fetched-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 6px;
  font-size: 13px;
  transition: background 0.15s ease;
}
.fetched-item:hover { background: color-mix(in srgb, var(--color-bg-muted) 65%, transparent); }
.fetched-item.added { opacity: 0.5; }
.fetched-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}
.fetched-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}
.fetched-meta {
  display: flex;
  gap: 8px;
  font-size: 11px;
  color: var(--color-text-muted);
}
.add-provider-form {
  display: flex;
  flex-direction: column;
  gap: 14px;
  margin: 12px 28px 24px;
  padding: 18px;
  background: color-mix(in srgb, var(--color-bg-muted) 50%, transparent);
  border: 1px solid color-mix(in srgb, var(--color-primary) 26%, var(--color-border));
  border-radius: 12px;
}
.form-title {
  font-size: 13px;
  font-weight: 650;
  color: var(--color-text);
  letter-spacing: -0.01em;
}
.form-models { padding-top: 2px; }

/* ── Auth ────────────────────────────────────────────────────────────── */
.auth-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 11px 14px;
  background: var(--color-bg-card);
  border: 1px solid var(--color-border);
  border-radius: 11px;
  margin: 10px 28px 0;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.auth-item:hover {
  border-color: var(--color-border-hover);
  box-shadow: 0 2px 10px rgba(15, 23, 42, 0.05);
}
.auth-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
}
.auth-info strong {
  font-size: 14px;
  font-weight: 620;
  color: var(--color-text);
  letter-spacing: -0.01em;
}
.auth-id {
  font-size: 11px;
  color: var(--color-text-muted);
  font-family: 'SF Mono', 'Fira Code', monospace;
}
.auth-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.auth-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 16px 28px 24px;
  padding: 18px;
  background: color-mix(in srgb, var(--color-bg-muted) 50%, transparent);
  border: 1px solid var(--color-border);
  border-radius: 12px;
}
.auth-form :deep(.modern-select) { width: 100%; }

/* ── Skills ──────────────────────────────────────────────────────────── */
.skills-grid {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 4px;
}
.skill-item {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 10px 14px;
  background: var(--color-bg-muted);
  border: 1px solid var(--color-border);
  border-radius: 10px;
  transition: all 0.15s ease;
}
.skill-item:hover {
  border-color: var(--color-border-hover);
  box-shadow: 0 2px 8px rgba(0,0,0,0.06);
}
.skill-toggle { flex-shrink: 0; }
.skill-info { flex: 1; min-width: 0; }
.skill-name { font-size: 14px; font-weight: 500; color: var(--color-text); }
.skill-desc { font-size: 12px; color: var(--color-text-muted); margin-top: 2px; }

/* ── Background Grid ─────────────────────────────────────────────────── */
.bg-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(90px, 1fr));
  gap: 8px;
}
.bg-thumb-wrap { position: relative; }
.bg-thumb {
  position: relative;
  display: block;
  width: 100%;
  aspect-ratio: 16/10;
  padding: 0;
  border-radius: 8px;
  overflow: hidden;
  border: 2px solid transparent;
  cursor: pointer;
  transition: border-color 0.15s ease, transform 0.15s ease;
}
.bg-thumb:hover {
  border-color: var(--color-border-hover);
  transform: scale(1.03);
}
.bg-thumb.active {
  border-color: var(--color-primary);
  box-shadow: 0 0 0 3px var(--color-primary-soft);
}
.bg-thumb.multi-selected:not(.active) { border-color: color-mix(in srgb, var(--color-primary) 58%, var(--color-border)); }
.bg-thumb img { width: 100%; height: 100%; object-fit: cover; }
.bg-thumb-empty {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--color-bg-muted);
  color: var(--color-text-muted);
  font-size: 12px;
}
.bg-select-checkbox {
  position: absolute;
  top: 5px;
  right: 5px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 5px;
  background: rgba(15, 23, 42, 0.58);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.24);
  cursor: pointer;
  opacity: 0;
  transform: scale(0.84);
  transition: opacity 0.15s ease, transform 0.15s ease;
}
.bg-thumb-wrap:hover .bg-select-checkbox,
.bg-thumb-wrap:focus-within .bg-select-checkbox,
.bg-grid.selection-active .bg-select-checkbox.checked {
  opacity: 1;
  transform: scale(1);
}
.bg-select-checkbox input {
  appearance: none;
  width: 12px;
  height: 12px;
  margin: 0;
  border: 1px solid rgba(255, 255, 255, 0.82);
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.16);
  cursor: pointer;
}
.bg-select-checkbox input:checked {
  border-color: var(--color-primary);
  background: var(--color-primary);
}
.bg-select-checkbox input:checked::after {
  content: '✓';
  display: block;
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  line-height: 12px;
  text-align: center;
}
.bg-select-checkbox input:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 2px; }
.bg-selection-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 30px;
  margin-top: 12px;
}
.bg-selection-summary { font-size: 12px; color: var(--color-text-secondary); }
.btn-ghost-xs.danger { color: var(--color-error); border-color: color-mix(in srgb, var(--color-error) 45%, var(--color-border)); }
.btn-ghost-xs.danger:hover { color: #fff; border-color: var(--color-error); background: var(--color-error); }
.rotation-controls {
  margin-top: 12px;
  padding: 12px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-bg-muted);
}
.rotation-controls label { font-size: 13px; color: var(--color-text-secondary); }
.rotation-mode-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}

/* ── Rankings ────────────────────────────────────────────────────────── */
.add-rank-row {
  display: flex;
  gap: 8px;
  margin: 10px 0;
  flex-wrap: wrap;
}
.add-rank-row .text-input { flex: 1; min-width: 120px; }
.rank-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 360px;
  overflow-y: auto;
  margin-top: 8px;
}
.rank-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-bg-muted);
  font-size: 13px;
  transition: border-color 0.15s ease;
}
.rank-item:hover { border-color: var(--color-border-hover); }
.rank-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── Responsive ──────────────────────────────────────────────────────── */
@container settings (max-width: 760px) {
  .card-header { padding: 22px 22px 18px; }
  .integration-card-body,
  .ranking-card-body { padding: 0 22px 22px; }
  .provider-item { margin-inline: 22px; }
  .btn-add { width: calc(100% - 44px); margin-inline: 22px; }
  .add-provider-form,
  .auth-form { margin-inline: 22px; }
  .auth-item { margin-inline: 22px; }
  .setting-row {
    gap: 20px;
    padding: 15px 22px;
  }
  .setting-group { padding: 18px 22px; }
  .model-grid {
    grid-template-columns: 1fr;
    padding: 14px 22px 18px;
  }
}

@container settings (max-width: 560px) {
  .settings-content > section { gap: 16px; }
  .settings-card { border-radius: 14px; }
  .card-header-row,
  .setting-row {
    flex-direction: column;
    align-items: flex-start;
  }
  .card-header-row { gap: 12px; }
  .setting-row { gap: 12px; }
  .row-info,
  .row-control {
    width: 100%;
    max-width: none !important;
  }
  .row-control {
    justify-content: flex-start;
    flex-wrap: wrap;
  }
  .row-control :deep(.modern-select) {
    max-width: none;
  }
  .input-row { flex-wrap: wrap; width: 100%; }
  .model-edit-grid,
  .field-grid { grid-template-columns: 1fr; }
  .model-edit-grid .edit-field[style*="span 2"] { grid-column: auto !important; }
  .add-model-row .text-input { width: 100%; flex: 1 1 100%; }
}

@media (max-width: 768px) {
  .card-header { padding: 20px 18px 16px; }
  .integration-card-body,
  .ranking-card-body { padding: 0 18px 18px; }
  .setting-row { padding: 15px 18px; }
  .setting-group { padding: 18px; }
  .model-grid { padding: 14px 18px 18px; }
  .provider-item,
  .auth-item { margin-inline: 18px; }
  .btn-add { width: calc(100% - 36px); margin-inline: 18px; }
  .add-provider-form,
  .auth-form { margin-inline: 18px; }
}
</style>
