<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import type { IeeeJournalConfig, PaperSource, SearchPaper } from '@yarc/shared'
import Checkbox from '../ui/Checkbox.vue'
import { usePrefsStore } from '@/stores/prefs'
import { useApi } from '@/composables/useApi'

const prefs = usePrefsStore()
const api = useApi()

const props = defineProps<{ autofocus?: boolean }>()

interface SearchFilters {
  source: PaperSource
  field: 'all' | 'title' | 'author' | 'year' | 'journal'
  yearFrom?: number
  yearTo?: number
  journalId?: string
  ieeeSort: 'relevance' | 'newest'
  sortBy: 'relevance' | 'year_desc' | 'year_asc' | 'title_asc'
}

type SearchResult = SearchPaper & { saved?: boolean }

const emit = defineEmits<{
  (e: 'select', paper: SearchResult): void
  (e: 'save', papers: SearchResult[]): void
  (e: 'importPdf', papers: SearchResult[]): void
  (e: 'readPdf', paper: SearchResult): void
}>()

const isExpanded = ref(false)
const dropdownRef = ref<HTMLDivElement>()
const dropdownStyle = ref<Record<string, string>>({})

const updateDropdownStyle = () => {
  if (!containerRef.value) return
  const rect = containerRef.value.getBoundingClientRect()
  dropdownStyle.value = {
    position: 'fixed',
    top: rect.bottom + 'px',
    left: rect.left + 'px',
    width: rect.width + 'px',
  }
}
const query = ref('')
const loading = ref(false)
const results = ref<SearchResult[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = computed(() => prefs.searchPageSize)
const searchInput = ref<HTMLInputElement>()
const containerRef = ref<HTMLDivElement>()

const filters = ref<SearchFilters>({
  source: prefs.searchSource,
  field: 'all',
  ieeeSort: 'relevance',
  sortBy: 'relevance'
})

const ieeeJournals = ref<IeeeJournalConfig[]>([])
const ieeeJournalsError = ref('')

const loadIeeeJournals = async () => {
  try {
    const response = await api.getIeeeJournalBrowserPreferences()
    ieeeJournals.value = response.preferences.journals || []
  } catch (err) {
    ieeeJournalsError.value = (err as Error).message || '无法加载已配置 IEEE 期刊'
  }
}

// Keep the search box source and the saved default in sync both ways.
watch(() => prefs.searchSource, (v) => { if (filters.value.source !== v) filters.value.source = v })
watch(() => filters.value.source, (v) => { prefs.searchSource = v })

const selectedPapers = ref<Set<string>>(new Set())
const expandedAbstracts = ref<Set<string>>(new Set())
const savableResults = computed(() => results.value.filter((paper) => paper.source !== 'local'))
const hasSavableResults = computed(() => savableResults.value.length > 0)
const allSavableSelected = computed(() =>
  savableResults.value.length > 0 && savableResults.value.every((paper) => selectedPapers.value.has(paper.id))
)

const cleanAbstract = (abstract?: string | null) =>
  abstract?.replace(/^\s*(?:abstract|摘要)?\s*[\-–—:：]+\s*/i, '').trim() || ''

const isAbstractExpanded = (paperId: string) => expandedAbstracts.value.has(paperId)

const toggleAbstract = (e: Event, paperId: string) => {
  e.stopPropagation()
  const next = new Set(expandedAbstracts.value)
  if (next.has(paperId)) next.delete(paperId)
  else next.add(paperId)
  expandedAbstracts.value = next
}

const sources = [
  { id: 'semantic_scholar', label: 'Semantic Scholar', icon: '🔬' },
  { id: 'ieee', label: 'IEEE Xplore', icon: '⚡' },
  { id: 'local', label: '本地文献', icon: '📁' }
]

const fields = [
  { id: 'all', label: '全部' },
  { id: 'title', label: '标题' },
  { id: 'author', label: '作者' },
  { id: 'year', label: '年份' },
  { id: 'journal', label: '期刊' }
]

const sortOptions = [
  { id: 'relevance', label: '相关性' },
  { id: 'year_desc', label: '最新' },
  { id: 'year_asc', label: '最早' },
  { id: 'title_asc', label: '标题' }
]

const canSearch = computed(() => !!query.value.trim())

const expand = (focusInput = true) => {
  isExpanded.value = true
  updateDropdownStyle()
  if (!focusInput) return
  nextTick(() => {
    searchInput.value?.focus()
  })
}

const handleSearchMainClick = (e: MouseEvent) => {
  expand(e.target !== searchInput.value)
}

const handleClickOutside = (e: MouseEvent) => {
  const target = e.target as Node
  const inContainer = containerRef.value?.contains(target)
  const inDropdown = dropdownRef.value?.contains(target)
  if (!inContainer && !inDropdown) {
    isExpanded.value = false
  }
}

const applyAgentSearchResults = (event: Event) => {
  const detail = (event as CustomEvent).detail || {}
  query.value = detail.query || query.value
  const source = detail.source
  if (source === 'local' || source === 'ieee' || source === 'semantic_scholar') filters.value.source = source
  const field = detail.field
  if (field === 'all' || field === 'title' || field === 'author' || field === 'year' || field === 'journal') filters.value.field = field
  page.value = Number(detail.page || 1)
  results.value = Array.isArray(detail.papers) ? detail.papers : []
  total.value = Number(detail.total || results.value.length)
  selectedPapers.value.clear()
  expandedAbstracts.value.clear()
  expand(false)
}

const search = async () => {
  if (!canSearch.value) return
  isExpanded.value = true
  
  loading.value = true
  try {
    const params = new URLSearchParams({
      q: query.value,
      source: filters.value.source,
      field: filters.value.field,
      page: page.value.toString(),
      limit: pageSize.value.toString()
    })
    
    if (filters.value.yearFrom) params.append('year_from', filters.value.yearFrom.toString())
    if (filters.value.yearTo) params.append('year_to', filters.value.yearTo.toString())
    if (filters.value.source === 'ieee') {
      params.append('ieee_mode', 'search')
      params.append('sort', filters.value.ieeeSort)
      if (filters.value.journalId) params.append('journal_id', filters.value.journalId)
    }
    
    const res = await fetch(`/api/search?${params}`)
    const data = await res.json()
    
    results.value = data.papers || []
    total.value = data.total || 0
    selectedPapers.value.clear()
    expandedAbstracts.value.clear()
  } catch (err) {
    console.error('Search failed:', err)
    results.value = []
    total.value = 0
  } finally {
    loading.value = false
  }
}

const toggleSelectPaper = (paperId: string) => {
  const paper = results.value.find((item) => item.id === paperId)
  if (!paper || paper.source === 'local') return
  if (selectedPapers.value.has(paperId)) {
    selectedPapers.value.delete(paperId)
  } else {
    selectedPapers.value.add(paperId)
  }
}

const selectAll = () => {
  const savableIds = savableResults.value.map((paper) => paper.id)
  if (savableIds.length > 0 && savableIds.every((id) => selectedPapers.value.has(id))) {
    savableIds.forEach((id) => selectedPapers.value.delete(id))
  } else {
    savableIds.forEach((id) => selectedPapers.value.add(id))
  }
}

const saveSelected = () => {
  const selected = savableResults.value.filter(paper => selectedPapers.value.has(paper.id))
  if (!selected.length) return
  emit('save', selected)
  selectedPapers.value.clear()
}

const saveSingle = (paper: SearchResult) => {
  if (paper.source === 'local') return
  emit('save', [paper])
}

const importSelectedPdfs = () => {
  const selected = savableResults.value.filter(paper => selectedPapers.value.has(paper.id))
  if (!selected.length) return
  emit('importPdf', selected)
}

const importSinglePdf = (paper: SearchResult) => {
  if (paper.source === 'local') return
  emit('importPdf', [paper])
}

const temporaryPdfSource = (paper: SearchResult) => paper.pdfUrl || paper.openAccessPdf?.url || null

const readPdf = (paper: SearchResult) => {
  if (temporaryPdfSource(paper)) emit('readPdf', paper)
}

const handleKeydown = (e: KeyboardEvent) => {
  if (e.key === 'Enter') {
    page.value = 1
    search()
  }
  if (e.key === 'Escape') {
    if (query.value) {
      query.value = ''
      results.value = []
      total.value = 0
    } else {
      isExpanded.value = false
    }
  }
}

const nextPage = () => { if (page.value * pageSize.value < total.value) { page.value++; search() } }
const prevPage = () => { if (page.value > 1) { page.value--; search() } }
const totalPages = computed(() => Math.ceil(total.value / pageSize.value))

const sortedResults = computed(() => {
  const sorted = [...results.value]
  switch (filters.value.sortBy) {
    case 'year_desc': sorted.sort((a, b) => (b.year || 0) - (a.year || 0)); break
    case 'year_asc': sorted.sort((a, b) => (a.year || 0) - (b.year || 0)); break
    case 'title_asc': sorted.sort((a, b) => a.title.localeCompare(b.title)); break
  }
  return sorted
})

interface ImportJobStatus {
  jobId: string
  status: string
  total: number
  completed: number
  failed: number
  at?: string
}

interface ImportedPaperProcessing {
  paperId: string
  jobId?: string
  title?: string
  parseStatus: string
  embeddingStatus: string
  failed: boolean
  at?: string
}

interface PaperTaskStatus {
  paperId: string
  status: string
  failed: boolean
  at?: string
}

const terminalJobStatuses = new Set(['completed', 'failed'])
const importJobs = ref<Record<string, ImportJobStatus>>({})
const importedPaperProcessing = ref<Record<string, ImportedPaperProcessing>>({})
const summaryTasks = ref<Record<string, PaperTaskStatus>>({})
const activeImportJobs = computed(() => Object.values(importJobs.value)
  .filter((job) => !terminalJobStatuses.has(job.status))
)
const isPaperProcessingDone = (paper: ImportedPaperProcessing) =>
  paper.parseStatus === 'failed' || (terminalJobStatuses.has(paper.parseStatus) && terminalJobStatuses.has(paper.embeddingStatus))
const activeImportedPaperProcessing = computed(() => Object.values(importedPaperProcessing.value)
  .filter((paper) => !isPaperProcessingDone(paper))
)
const activeProcessingJobIds = computed(() => new Set(
  activeImportedPaperProcessing.value.map((paper) => paper.jobId).filter((jobId): jobId is string => !!jobId)
))
const visibleImportedPaperProcessing = computed(() => Object.values(importedPaperProcessing.value)
  .filter((paper) => paper.jobId ? activeProcessingJobIds.value.has(paper.jobId) : !isPaperProcessingDone(paper))
)
const processingDoneCount = computed(() => visibleImportedPaperProcessing.value
  .filter((paper) => isPaperProcessingDone(paper)).length
)
const processingFailedCount = computed(() => visibleImportedPaperProcessing.value
  .filter((paper) => paper.failed).length
)
const activeSummaryTasks = computed(() => Object.values(summaryTasks.value)
  .filter((task) => !terminalJobStatuses.has(task.status))
)
const summaryDoneCount = computed(() => Object.values(summaryTasks.value)
  .filter((task) => terminalJobStatuses.has(task.status)).length
)
const summaryFailedCount = computed(() => Object.values(summaryTasks.value)
  .filter((task) => task.failed).length
)
const activeTaskSummary = computed(() => {
  if (activeImportJobs.value.length) {
    return {
      label: '导入',
      title: 'PDF 正在导入，后续会继续排队解析和生成向量',
      completed: activeImportJobs.value.reduce((sum, job) => sum + job.completed, 0),
      total: activeImportJobs.value.reduce((sum, job) => sum + job.total, 0),
      failed: activeImportJobs.value.reduce((sum, job) => sum + job.failed, 0),
    }
  }
  if (activeImportedPaperProcessing.value.length) {
    return {
      label: '队列',
      title: 'PDF 已入库，正在排队/执行 MinerU 解析和向量生成',
      completed: processingDoneCount.value,
      total: visibleImportedPaperProcessing.value.length,
      failed: processingFailedCount.value,
    }
  }
  if (activeSummaryTasks.value.length) {
    return {
      label: '总结',
      title: '论文总结任务正在后台队列中执行；LLM 总结已限制为单任务并发',
      completed: summaryDoneCount.value,
      total: Object.keys(summaryTasks.value).length,
      failed: summaryFailedCount.value,
    }
  }
  return null
})
const latestFinishedImportJob = computed(() => Object.values(importJobs.value)
  .filter((job) => terminalJobStatuses.has(job.status))
  .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))[0]
)
const latestFinishedFailedCount = computed(() => {
  const job = latestFinishedImportJob.value
  if (!job) return 0
  const paperFailures = Object.values(importedPaperProcessing.value)
    .filter((paper) => paper.jobId === job.jobId && paper.failed)
    .length
  return job.failed + paperFailures
})
const latestFinishedSummary = computed(() => {
  const values = Object.values(summaryTasks.value)
  if (!values.length || values.some((task) => !terminalJobStatuses.has(task.status))) return null
  return {
    total: values.length,
    completed: values.filter((task) => task.status === 'completed').length,
    failed: values.filter((task) => task.failed).length,
    at: values.map((task) => task.at || '').sort().at(-1),
  }
})

const dismissImportJobStatus = (jobId?: string) => {
  if (!jobId) return
  const nextJobs = { ...importJobs.value }
  delete nextJobs[jobId]
  importJobs.value = nextJobs
  importedPaperProcessing.value = Object.fromEntries(
    Object.entries(importedPaperProcessing.value).filter(([, paper]) => paper.jobId !== jobId)
  )
}

const applyImportJobEvent = (event: Event) => {
  const detail = (event as CustomEvent).detail || {}
  const jobId = String(detail.jobId || '')
  if (!jobId) return
  importJobs.value = {
    ...importJobs.value,
    [jobId]: {
      jobId,
      status: String(detail.status || 'running'),
      total: Number(detail.total || 0),
      completed: Number(detail.completed || 0),
      failed: Number(detail.failed || 0),
      at: String(detail.at || new Date().toISOString()),
    },
  }
}

const applyImportJobItemCompleted = (event: Event) => {
  const detail = (event as CustomEvent).detail || {}
  const paperId = String(detail.importedPaperId || '')
  if (!paperId || detail.metadataOnly) return
  const jobId = String(detail.jobId || '') || undefined
  const paper = detail.paper || {}
  importedPaperProcessing.value = {
    ...importedPaperProcessing.value,
    [paperId]: {
      paperId,
      jobId,
      title: typeof paper.title === 'string' ? paper.title : undefined,
      parseStatus: 'queued',
      embeddingStatus: 'queued',
      failed: false,
      at: String(detail.at || new Date().toISOString()),
    },
  }
}

const dismissSummaryStatus = () => {
  summaryTasks.value = {}
}

const applyPaperStatusEvent = (event: Event) => {
  const detail = (event as CustomEvent).detail || {}
  const paperId = String(detail.paperId || '')
  if (!paperId) return

  const status = String(detail.status || '')
  const at = String(detail.at || new Date().toISOString())
  if (detail.jobType === 'summarize') {
    if (status === 'queued' && !activeSummaryTasks.value.length && Object.keys(summaryTasks.value).length) {
      summaryTasks.value = {}
    }
    const currentSummary = summaryTasks.value[paperId]
    summaryTasks.value = {
      ...summaryTasks.value,
      [paperId]: {
        paperId,
        status,
        failed: currentSummary?.failed || status === 'failed',
        at,
      },
    }
  }

  const current = importedPaperProcessing.value[paperId]
  if (!current) return

  const next = { ...current, at }
  if (detail.jobType === 'parse_pdf') next.parseStatus = status
  if (detail.jobType === 'generate_embedding') next.embeddingStatus = status
  if (status === 'failed') next.failed = true
  importedPaperProcessing.value = { ...importedPaperProcessing.value, [paperId]: next }
}

watch(isExpanded, (val) => {
  if (val) {
    updateDropdownStyle()
    nextTick(() => document.addEventListener('mousedown', handleClickOutside))
    window.addEventListener('resize', updateDropdownStyle)
  } else {
    document.removeEventListener('mousedown', handleClickOutside)
    window.removeEventListener('resize', updateDropdownStyle)
  }
})

onMounted(() => {
  window.addEventListener('yarc-agent-search-results', applyAgentSearchResults)
  window.addEventListener('yarc-import-job-queued', applyImportJobEvent)
  window.addEventListener('yarc-import-job-started', applyImportJobEvent)
  window.addEventListener('yarc-import-job-progress', applyImportJobEvent)
  window.addEventListener('yarc-import-job-completed', applyImportJobEvent)
  window.addEventListener('yarc-import-job-failed', applyImportJobEvent)
  window.addEventListener('yarc-import-job-item-completed', applyImportJobItemCompleted)
  window.addEventListener('yarc-paper-status', applyPaperStatusEvent)
  void loadIeeeJournals()
  if (props.autofocus) nextTick(() => searchInput.value?.focus())
})

onUnmounted(() => {
  document.removeEventListener('mousedown', handleClickOutside)
  window.removeEventListener('resize', updateDropdownStyle)
  window.removeEventListener('yarc-agent-search-results', applyAgentSearchResults)
  window.removeEventListener('yarc-import-job-queued', applyImportJobEvent)
  window.removeEventListener('yarc-import-job-started', applyImportJobEvent)
  window.removeEventListener('yarc-import-job-progress', applyImportJobEvent)
  window.removeEventListener('yarc-import-job-completed', applyImportJobEvent)
  window.removeEventListener('yarc-import-job-failed', applyImportJobEvent)
  window.removeEventListener('yarc-import-job-item-completed', applyImportJobItemCompleted)
  window.removeEventListener('yarc-paper-status', applyPaperStatusEvent)
})
</script>

<template>
  <div ref="containerRef" class="search-container" :class="{ expanded: isExpanded }">
    <!-- Main Input -->
    <div class="search-main" @click="handleSearchMainClick">
      <div class="search-icon-wrap">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <circle cx="11" cy="11" r="8" />
          <path d="M21 21l-4.35-4.35" />
        </svg>
      </div>
      <input
        ref="searchInput"
        v-model="query"
        @keydown="handleKeydown"
        @focus="expand(false)"
        placeholder="搜索论文标题、作者、关键词..."
        class="search-input"
      />
      <div class="search-actions">
        <div v-if="activeTaskSummary" class="import-status active" :title="activeTaskSummary.title">
          <span class="status-dot spinning"></span>
          <span class="status-text">{{ activeTaskSummary.label }}</span>
          <strong>{{ activeTaskSummary.completed }}/{{ activeTaskSummary.total }}</strong>
          <span v-if="activeTaskSummary.failed" class="status-failed">
            失败 {{ activeTaskSummary.failed }}
          </span>
        </div>
        <div v-else-if="latestFinishedImportJob" class="import-status done" title="最近一次 PDF 导入/解析队列已结束">
          <span class="status-dot"></span>
          <span class="status-text">完成</span>
          <strong>{{ latestFinishedImportJob.completed }}/{{ latestFinishedImportJob.total }}</strong>
          <span v-if="latestFinishedFailedCount" class="status-failed">失败 {{ latestFinishedFailedCount }}</span>
          <button
            type="button"
            class="import-status-close"
            title="关闭导入状态"
            aria-label="关闭导入状态"
            @mousedown.stop.prevent
            @click.stop.prevent="dismissImportJobStatus(latestFinishedImportJob.jobId)"
          >×</button>
        </div>
        <div v-else-if="latestFinishedSummary" class="import-status done" title="最近一次论文总结队列已结束">
          <span class="status-dot"></span>
          <span class="status-text">总结完成</span>
          <strong>{{ latestFinishedSummary.completed }}/{{ latestFinishedSummary.total }}</strong>
          <span v-if="latestFinishedSummary.failed" class="status-failed">失败 {{ latestFinishedSummary.failed }}</span>
          <button
            type="button"
            class="import-status-close"
            title="关闭总结状态"
            aria-label="关闭总结状态"
            @mousedown.stop.prevent
            @click.stop.prevent="dismissSummaryStatus"
          >×</button>
        </div>
        <button v-if="isExpanded && query" class="clear-btn" @mousedown.prevent="query = ''; results = []; total = 0">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
        <button v-if="query" class="search-btn" @mousedown.stop @click.stop.prevent="search" :disabled="loading || !canSearch">
          <svg v-if="!loading" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
          </svg>
          <span v-else class="spinner"></span>
        </button>
      </div>
    </div>

    <!-- Dropdown — Teleport 到 body 避免被 header 裁剪 -->
    <Teleport to="body">
    <div v-if="isExpanded" ref="dropdownRef" class="search-dropdown" :style="dropdownStyle">
      <!-- Source Tabs -->
      <div class="source-tabs desktop-only">
        <button
          v-for="s in sources"
          :key="s.id"
          class="source-tab"
          :class="{ active: filters.source === s.id }"
          @mousedown.prevent="filters.source = s.id as any"
        >
          <span class="source-icon">{{ s.icon }}</span>
          <span>{{ s.label }}</span>
        </button>
      </div>

      <!-- Filters Bar -->
      <div class="filters-bar">
        <!-- 桌面端: pill 按钮 -->
        <div class="filter-pills desktop-only">
          <span class="filter-label">字段</span>
          <button
            v-for="f in fields"
            :key="f.id"
            class="pill"
            :class="{ active: filters.field === f.id }"
            @mousedown.prevent="filters.field = f.id as any"
          >{{ f.label }}</button>
        </div>
        <div v-if="filters.source !== 'ieee'" class="filter-pills desktop-only">
          <span class="filter-label">排序</span>
          <button
            v-for="s in sortOptions"
            :key="s.id"
            class="pill"
            :class="{ active: filters.sortBy === s.id }"
            @mousedown.prevent="filters.sortBy = s.id as any"
          >{{ s.label }}</button>
        </div>
        <!-- 移动端: 下拉选择 -->
        <div class="filter-selects mobile-only">
          <select v-model="filters.source" class="filter-select">
            <option v-for="s in sources" :key="s.id" :value="s.id">{{ s.icon }} {{ s.label }}</option>
          </select>
          <select v-model="filters.field" class="filter-select">
            <option v-for="f in fields" :key="f.id" :value="f.id">{{ f.label }}</option>
          </select>
          <select v-if="filters.source !== 'ieee'" v-model="filters.sortBy" class="filter-select">
            <option v-for="s in sortOptions" :key="s.id" :value="s.id">{{ s.label }}</option>
          </select>
          <select v-else v-model="filters.ieeeSort" class="filter-select">
            <option value="relevance">相关度</option>
            <option value="newest">最新</option>
          </select>
        </div>
        <div v-if="filters.source !== 'ieee'" class="year-filter">
          <span class="filter-label">年份</span>
          <input v-model.number="filters.yearFrom" type="number" placeholder="起始" class="year-input" />
          <span class="year-sep">—</span>
          <input v-model.number="filters.yearTo" type="number" placeholder="结束" class="year-input" />
        </div>
        <template v-if="filters.source === 'ieee'">
          <select v-model="filters.journalId" class="filter-select" title="IEEE 搜索范围">
            <option value="">全 IEEE</option>
            <option v-for="journal in ieeeJournals" :key="journal.id" :value="journal.id">{{ journal.displayName }}</option>
          </select>
          <div class="filter-pills desktop-only">
            <span class="filter-label">IEEE 排序</span>
            <button class="pill" :class="{ active: filters.ieeeSort === 'relevance' }" @mousedown.prevent="filters.ieeeSort = 'relevance'">相关度</button>
            <button class="pill" :class="{ active: filters.ieeeSort === 'newest' }" @mousedown.prevent="filters.ieeeSort = 'newest'">最新</button>
          </div>
          <span v-if="ieeeJournalsError" class="filter-error">{{ ieeeJournalsError }}</span>
        </template>
      </div>

      <!-- Results -->
      <div v-if="results.length > 0" class="results-container">
        <div class="results-header">
          <span class="results-info">找到 <strong>{{ total }}</strong> 篇论文</span>
          <div v-if="hasSavableResults" class="results-actions">
            <button class="text-btn" @mousedown.prevent="selectAll">
              {{ allSavableSelected ? '取消全选' : '全选' }}
            </button>
            <button class="primary-btn" @mousedown.prevent="saveSelected" :disabled="selectedPapers.size === 0">
              保存选中 ({{ selectedPapers.size }})
            </button>
            <button class="primary-btn" @mousedown.prevent="importSelectedPdfs" :disabled="selectedPapers.size === 0">
              导入PDF
            </button>
          </div>
        </div>

        <div class="results-list">
          <div v-for="paper in sortedResults" :key="paper.id" class="result-card" :class="{ selected: selectedPapers.has(paper.id) }">
            <div v-if="paper.source !== 'local'" class="card-check">
              <Checkbox :modelValue="selectedPapers.has(paper.id)" @update:modelValue="toggleSelectPaper(paper.id)" />
            </div>
            <div class="card-body">
              <h4 class="card-title" @mousedown.prevent="$emit('select', paper)">{{ paper.title }}</h4>
              <div class="card-meta">
                <span v-if="paper.authors?.length" class="meta-item">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                  {{ paper.authors.slice(0, 2).join(', ') }}{{ paper.authors.length > 2 ? ' 等' : '' }}
                </span>
                <span v-if="paper.year" class="meta-item">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
                  {{ paper.year }}
                </span>
                <span v-if="paper.journal || paper.venue" class="meta-item venue">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
                  {{ paper.journal || paper.venue }}
                </span>
                <span v-if="paper.isEarlyAccess" class="meta-item early-access">Early Access</span>
              </div>
              <div v-if="paper.abstract" class="card-abstract-wrap">
                <p class="card-abstract" :class="{ expanded: isAbstractExpanded(paper.id) }">{{ cleanAbstract(paper.abstract) }}</p>
                <button class="abstract-toggle" @mousedown.stop @click.stop="toggleAbstract($event, paper.id)">
                  {{ isAbstractExpanded(paper.id) ? '收起' : '展开' }}
                </button>
              </div>
              <div class="card-actions">
                <button v-if="paper.source !== 'local'" class="action-chip save" @mousedown.prevent="saveSingle(paper)">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
                  保存
                </button>
                <a v-if="paper.url" :href="paper.url" target="_blank" class="action-chip">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                  原文
                </a>
                <button v-if="paper.source !== 'local'" class="action-chip save" @mousedown.prevent="importSinglePdf(paper)">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v12"/><polyline points="7 10 12 15 17 10"/><path d="M5 21h14"/></svg>
                  入库PDF
                </button>
                <button v-if="temporaryPdfSource(paper)" class="action-chip pdf" @mousedown.prevent="readPdf(paper)">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4v14a4 4 0 0 0-4-4H2"/><path d="M21 18a1 1 0 0 0 1-1V4a1 1 0 0 0-1-1h-5a4 4 0 0 0-4 4v14a4 4 0 0 1 4-4h5"/></svg>
                  阅读 PDF
                </button>
              </div>
            </div>
          </div>
        </div>

        <div v-if="totalPages > 1" class="pagination">
          <button class="page-btn" @mousedown.prevent="prevPage" :disabled="page === 1">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
          <span class="page-info">{{ page }} / {{ totalPages }}</span>
          <button class="page-btn" @mousedown.prevent="nextPage" :disabled="page >= totalPages">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
          </button>
        </div>
      </div>

      <div v-if="!query && !loading && results.length === 0" class="empty-state">
        <p>输入关键词后按 Enter 搜索</p>
      </div>

      <div v-else-if="query && !loading && results.length === 0" class="empty-state">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.4"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
        <p>未找到相关论文</p>
        <span>尝试不同的关键词或调整筛选条件</span>
      </div>

      <div v-else-if="loading && results.length === 0" class="loading-state">
        <div class="loading-spinner"></div>
        <p>正在搜索...</p>
      </div>
    </div>
    </Teleport>
  </div>
</template>

<style scoped>

/* ── Toggle ──────────────────────────────────────────────────────────────── */
.desktop-only { display: flex; }
.mobile-only { display: none; }

@media (max-width: 768px) {
  .desktop-only { display: none !important; }
  .mobile-only { display: flex !important; }
}

.filter-selects {
  gap: 6px;
  padding: 0 2px;
}

.filter-select {
  flex: 1;
  min-width: 0;
  padding: 6px 28px 6px 10px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-bg);
  color: var(--color-text);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  appearance: none;
  -webkit-appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg width='10' height='6' viewBox='0 0 10 6' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1L5 5L9 1' stroke='%239ca3af' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 8px center;
  transition: border-color 0.15s;
}

.filter-select:focus {
  outline: none;
  border-color: var(--color-primary);
}

.filter-select:active {
  background-color: var(--color-bg-muted);
}

/* ── Container ───────────────────────────────────────────────────────────── */

.search-container {
  position: relative;
  width: 640px;
  max-width: 100%;
}

.import-status {
  display: flex;
  align-items: center;
  gap: 5px;
  max-width: 170px;
  padding: 3px 8px;
  border-radius: 999px;
  border: 1px solid var(--color-border);
  background: var(--color-bg-muted);
  color: var(--color-text-secondary);
  font-size: 11px;
  white-space: nowrap;
  flex-shrink: 0;
}

.import-status.active {
  border-color: rgba(37, 99, 235, 0.25);
}

.import-status.done {
  border-color: rgba(34, 197, 94, 0.25);
}

.status-dot {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: #22c55e;
}

.status-dot.spinning {
  background: #2563eb;
  animation: pulse-dot 1s ease-in-out infinite;
}

.status-failed {
  color: #dc2626;
}

.import-status-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  margin-left: 1px;
  padding: 0;
  border: none;
  border-radius: 999px;
  background: transparent;
  color: var(--color-text-muted);
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
}

.import-status-close:hover {
  background: rgba(15, 23, 42, 0.08);
  color: var(--color-text);
}

@keyframes pulse-dot {
  0%, 100% { opacity: 0.35; transform: scale(0.8); }
  50% { opacity: 1; transform: scale(1); }
}

/* Main Input */
.search-main {
  display: flex;
  align-items: center;
  background: var(--color-bg);
  border: 1.5px solid var(--color-border);
  border-radius: 10px;
  transition: all 0.2s ease;
  overflow: hidden;
}

.search-main:hover {
  border-color: var(--color-primary);
  box-shadow: 0 0 0 3px var(--color-primary-soft);
}

.search-container.expanded .search-main {
  border-color: var(--color-primary);
  border-radius: 10px 10px 0 0;
  box-shadow: 0 0 0 3px var(--color-primary-soft);
}

.search-icon-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 4px 0 14px;
  color: var(--color-text-muted);
}

.search-container.expanded .search-icon-wrap {
  color: var(--color-primary);
}

.search-input {
  flex: 1;
  padding: 8px 8px;
  border: none;
  outline: none;
  background: transparent;
  color: var(--color-text);
  font-size: 14px;
  font-family: inherit;
  min-width: 0;
}

.search-input::placeholder {
  color: var(--color-text-muted);
}

.search-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  padding-right: 6px;
}

.clear-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  background: var(--color-bg-muted);
  color: var(--color-text-muted);
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.clear-btn:hover {
  background: var(--color-border);
  color: var(--color-text);
}

.search-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: none;
  background: var(--color-primary);
  color: white;
  border-radius: 7px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.search-btn:hover:not(:disabled) {
  background: var(--color-primary-hover);
  transform: scale(1.05);
}

.search-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.spinner {
  width: 16px;
  height: 16px;
  border: 2px solid rgba(255,255,255,0.3);
  border-top-color: white;
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}

@keyframes spin { to { transform: rotate(360deg); } }

/* Dropdown */
.search-dropdown {
  background: var(--color-bg-card);
  border: 1.5px solid var(--color-primary);
  border-top: none;
  border-radius: 0 0 10px 10px;
  box-shadow: 0 12px 40px rgba(0,0,0,0.15);
  z-index: 1000;
  animation: dropdownIn 0.2s ease;
  max-height: calc(100vh - 100px);
  overflow-y: auto;
  overflow-x: hidden;
  scroll-padding-bottom: var(--list-scroll-bottom-gap, 84px);
}

@keyframes dropdownIn {
  from { opacity: 0; transform: translateY(-8px); }
  to { opacity: 1; transform: translateY(0); }
}

/* Source Tabs */
.source-tabs {
  display: flex;
  gap: 4px;
  padding: 10px 12px;
  background: var(--color-bg-muted);
  border-bottom: 1px solid var(--color-border);
}

.source-tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 14px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--color-text-secondary);
  border-radius: 7px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
}

.source-tab:hover {
  background: var(--color-bg-card);
  color: var(--color-text);
}

.source-tab.active {
  background: var(--color-bg-card);
  border-color: var(--color-primary);
  color: var(--color-primary);
  box-shadow: 0 1px 3px rgba(0,0,0,0.08);
}

.source-icon {
  font-size: 14px;
}

/* Filters Bar */
.filters-bar {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--color-border);
  flex-wrap: wrap;
}

.filter-pills {
  display: flex;
  align-items: center;
  gap: 4px;
}

.filter-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--color-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-right: 4px;
}

.pill {
  padding: 4px 10px;
  border: 1px solid var(--color-border);
  background: var(--color-bg);
  color: var(--color-text-secondary);
  border-radius: 20px;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.pill:hover {
  border-color: var(--color-primary);
  color: var(--color-primary);
}

.filter-error {
  color: #dc2626;
  font-size: 11px;
}

.pill.active {
  background: var(--color-primary);
  border-color: var(--color-primary);
  color: white;
}

.year-filter {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
}

.year-input {
  width: 65px;
  padding: 4px 8px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-bg);
  color: var(--color-text);
  font-size: 12px;
  font-family: inherit;
  text-align: center;
}

.year-input:focus {
  outline: none;
  border-color: var(--color-primary);
}

.year-sep {
  color: var(--color-text-muted);
  font-size: 12px;
}

/* Results */
.results-container {
  max-height: min(640px, calc(100vh - 260px));
  overflow-y: auto;
  scroll-padding-bottom: var(--list-scroll-bottom-gap, 84px);
}

.results-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 14px;
  background: var(--color-bg-muted);
  border-bottom: 1px solid var(--color-border);
  position: sticky;
  top: 0;
  z-index: 10;
}

.results-info {
  font-size: 12px;
  color: var(--color-text-muted);
}

.results-info strong {
  color: var(--color-primary);
  font-weight: 600;
}

.results-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.text-btn {
  padding: 5px 10px;
  border: none;
  background: transparent;
  color: var(--color-primary);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  border-radius: 5px;
}

.text-btn:hover {
  background: var(--color-primary-soft);
}

.primary-btn {
  padding: 5px 12px;
  border: none;
  background: var(--color-primary);
  color: white;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
}

.primary-btn:hover:not(:disabled) {
  background: var(--color-primary-hover);
}

.primary-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Result Cards */
.results-list {
  padding: 6px 6px calc(6px + var(--list-scroll-bottom-gap, 84px));
}

.result-card {
  display: flex;
  gap: 10px;
  padding: 12px;
  border-radius: 8px;
  transition: all 0.15s ease;
  margin-bottom: 4px;
}

.result-card:hover {
  background: var(--color-bg-muted);
}

.result-card.selected {
  background: var(--color-primary-soft);
}

.card-check {
  padding-top: 2px;
}

.card-check input {
  width: 16px;
  height: 16px;
  cursor: pointer;
  accent-color: var(--color-primary);
}

.card-body {
  flex: 1;
  min-width: 0;
}

.card-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text);
  margin: 0 0 6px;
  cursor: pointer;
  line-height: 1.4;
}

.card-title:hover {
  color: var(--color-primary);
}

.card-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 6px;
}

.meta-item {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--color-text-muted);
}

.meta-item.venue {
  color: var(--color-text-secondary);
  font-weight: 500;
}

.meta-item.early-access {
  padding: 1px 6px;
  border-radius: 999px;
  background: rgba(245, 158, 11, 0.12);
  color: #d97706;
  font-weight: 600;
}

.card-abstract-wrap {
  margin: 0 0 8px;
}

.card-abstract {
  font-size: 12px;
  color: var(--color-text-secondary);
  line-height: 1.5;
  margin: 0;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.card-abstract.expanded {
  display: block;
  overflow: visible;
}

.abstract-toggle {
  margin-top: 4px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--color-primary);
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
}

.abstract-toggle:hover {
  text-decoration: underline;
}

.card-actions {
  display: flex;
  gap: 6px;
}

.action-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border: 1px solid var(--color-border);
  background: var(--color-bg);
  color: var(--color-text-secondary);
  border-radius: 6px;
  font-size: 11px;
  cursor: pointer;
  text-decoration: none;
  transition: all 0.15s ease;
}

.action-chip:hover {
  border-color: var(--color-primary);
  color: var(--color-primary);
  background: var(--color-primary-soft);
}

.action-chip.save:hover {
  background: var(--color-primary);
  border-color: var(--color-primary);
  color: white;
}

.action-chip.pdf {
  background: var(--color-primary);
  border-color: var(--color-primary);
  color: white;
}

.action-chip.pdf:hover {
  background: var(--color-primary-hover);
}

/* Pagination */
.pagination {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 12px;
  padding: 12px;
  border-top: 1px solid var(--color-border);
}

.page-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: 1px solid var(--color-border);
  background: var(--color-bg);
  color: var(--color-text-secondary);
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.page-btn:hover:not(:disabled) {
  border-color: var(--color-primary);
  color: var(--color-primary);
}

.page-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.page-info {
  font-size: 12px;
  color: var(--color-text-muted);
  font-weight: 500;
}

/* Empty & Loading States */
.empty-state,
.loading-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 32px;
  text-align: center;
}

.empty-state p {
  font-size: 14px;
  font-weight: 500;
  color: var(--color-text);
  margin: 0;
}

.empty-state span {
  font-size: 12px;
  color: var(--color-text-muted);
}

.loading-spinner {
  width: 28px;
  height: 28px;
  border: 3px solid var(--color-border);
  border-top-color: var(--color-primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

.loading-state p {
  font-size: 13px;
  color: var(--color-text-muted);
  margin: 0;
}

/* ── Mobile ──────────────────────────────────────────────────────────────── */

@media (max-width: 768px) {
  .search-container { flex: 1; min-width: 0; }

  /* 源标签: 紧凑横排, 可滚动 */
  .source-tabs { padding: 6px 8px; gap: 3px; overflow-x: auto; flex-wrap: nowrap; -webkit-overflow-scrolling: touch; }
  .source-tab { padding: 5px 8px; font-size: 12px; white-space: nowrap; flex-shrink: 0; }

  /* 筛选栏 */
  .filters-bar { flex-direction: column; gap: 8px; padding: 8px 10px; }
  .filter-pills { flex-wrap: wrap; gap: 3px; }
  .pill { padding: 3px 7px; font-size: 11px; }
  .filter-selects { flex-wrap: wrap; gap: 6px; }
  .filter-select { min-width: calc(50% - 3px); flex: unset; }
  .year-filter { gap: 4px; width: 100%; }
  .year-input { flex: 1; min-width: 0; padding: 6px 8px; font-size: 12px; border-radius: 8px; }

  /* 结果卡片: 纵向紧凑 */
  .result-card { padding: 8px; gap: 6px; }
  .card-title { font-size: 13px; line-height: 1.35; }
  .card-meta { font-size: 11px; }
  .card-actions { flex-wrap: wrap; gap: 4px; }
  .card-actions .text-btn { font-size: 11px; padding: 3px 6px; }

  /* 操作栏 */
  .results-header { padding: 6px 8px; flex-wrap: wrap; gap: 6px; }
  .results-actions { gap: 6px; }
  .action-bar { padding: 6px 8px; gap: 6px; }
  .action-bar .primary-btn { font-size: 12px; padding: 6px 10px; }

  /* 分页 */
  .pagination { padding: 6px 8px; gap: 8px; font-size: 12px; }
}

@media (max-width: 480px) {
  .search-icon-wrap { padding: 0 2px 0 10px; }
  .search-input { font-size: 13px; padding: 6px; }
}
</style>
