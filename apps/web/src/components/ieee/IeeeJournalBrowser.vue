<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { IeeeBrowseMode, IeeeJournalConfig, SearchPaper } from '@yarc/shared'
import { useApi } from '@/composables/useApi'

const props = defineProps<{
  journals: IeeeJournalConfig[]
  selectedJournalId: string
  defaultRankingKeywords: string
}>()

const emit = defineEmits<{
  (e: 'select-journal', id: string): void
}>()

const api = useApi()
const mode = ref<IeeeBrowseMode>('early_access')
const rankingKeywords = ref('')
const papers = ref<SearchPaper[]>([])
const total = ref(0)
const page = ref(0)
const loading = ref(false)
const loadingMore = ref(false)
const error = ref('')
const fetchedAt = ref('')
const cached = ref(false)
const rankingInitialized = ref(false)
const fullAbstracts = ref<Record<string, string>>({})
const loadingAbstracts = ref<Set<string>>(new Set())
const abstractErrors = ref<Record<string, string>>({})

const selectedJournal = computed(() => props.journals.find(journal => journal.id === props.selectedJournalId) || null)

const normalize = (value: unknown) => String(value ?? '')
  .normalize('NFKC')
  .toLocaleLowerCase()
  .replace(/[\p{P}\p{S}_]+/gu, ' ')
  .replace(/\s+/g, ' ')
  .trim()

const keywords = computed(() => normalize(rankingKeywords.value).split(' ').filter(Boolean))
const searchText = (paper: SearchPaper) => normalize([
  paper.title,
  paper.authors?.join(' '),
  paper.abstract,
  paper.doi,
].filter(Boolean).join(' '))

const relevance = (paper: SearchPaper) => {
  const text = searchText(paper)
  return keywords.value.reduce((score, keyword) => score + (text.split(keyword).length - 1), 0)
}

const fullDate = (paper: SearchPaper) => {
  const value = String(paper.publicationDate || '')
  if (!/^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(value)) return null
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : null
}

const visiblePapers = computed(() => papers.value
  .map((paper, index) => ({ paper, index }))
  .filter(({ paper }) => keywords.value.every(keyword => searchText(paper).includes(keyword)))
  .sort((a, b) => {
    const dateA = fullDate(a.paper)
    const dateB = fullDate(b.paper)
    if (dateA !== null && dateB !== null) {
      if (dateA !== dateB) return dateB - dateA
      return relevance(b.paper) - relevance(a.paper) || a.index - b.index
    }
    if (dateA !== null) return -1
    if (dateB !== null) return 1
    return a.index - b.index
  })
  .map(({ paper }) => paper))

const displayDate = (paper: SearchPaper) => paper.publicationDate || (paper.year ? String(paper.year) : '日期未提供')
const articleUrl = (paper: SearchPaper) => paper.url || (paper.articleNumber ? `https://ieeexplore.ieee.org/document/${paper.articleNumber}/` : null)
const articleKey = (paper: SearchPaper) => paper.articleNumber || paper.id
const displayedAbstract = (paper: SearchPaper) => fullAbstracts.value[articleKey(paper)] || paper.abstract || ''

const loadFullAbstract = async (paper: SearchPaper) => {
  const articleNumber = paper.articleNumber || (String(paper.id).match(/^\d{4,20}$/) ? String(paper.id) : '')
  if (!articleNumber || loadingAbstracts.value.has(articleNumber)) return
  const nextLoading = new Set(loadingAbstracts.value)
  nextLoading.add(articleNumber)
  loadingAbstracts.value = nextLoading
  const nextErrors = { ...abstractErrors.value }
  delete nextErrors[articleNumber]
  abstractErrors.value = nextErrors
  try {
    const response = await api.getIeeeArticleAbstract(articleNumber)
    const abstract = response.papers[0]?.abstract
    if (!abstract) throw new Error('IEEE 未提供完整摘要')
    fullAbstracts.value = { ...fullAbstracts.value, [articleNumber]: abstract }
  } catch (err) {
    abstractErrors.value = { ...abstractErrors.value, [articleNumber]: (err as Error).message || '完整摘要加载失败' }
  } finally {
    const doneLoading = new Set(loadingAbstracts.value)
    doneLoading.delete(articleNumber)
    loadingAbstracts.value = doneLoading
  }
}

const hasMore = computed(() => papers.value.length < total.value)

const loadDirectory = async (refresh = false, append = false) => {
  if (!props.selectedJournalId || loading.value || loadingMore.value) return
  const nextPage = append ? page.value + 1 : 1
  if (append) loadingMore.value = true
  else {
    loading.value = true
    error.value = ''
  }
  try {
    const response = await api.searchIeee({
      mode: mode.value,
      journalId: props.selectedJournalId,
      page: nextPage,
      limit: 20,
      refresh,
    })
    const nextPapers = response.papers || []
    papers.value = append
      ? [...papers.value, ...nextPapers.filter(paper => !papers.value.some(existing => articleKey(existing) === articleKey(paper)))]
      : nextPapers
    total.value = response.total || papers.value.length
    page.value = response.page || nextPage
    fetchedAt.value = response.ieee?.fetchedAt || ''
    cached.value = !!response.ieee?.cached
  } catch (err) {
    if (!append) papers.value = []
    error.value = (err as Error).message || '加载 IEEE 期刊目录失败'
  } finally {
    loading.value = false
    loadingMore.value = false
  }
}

const loadNextDirectoryPage = () => {
  if (hasMore.value) void loadDirectory(false, true)
}

const onDirectoryScroll = (event: Event) => {
  const element = event.target as HTMLElement
  if (element.scrollTop + element.clientHeight >= element.scrollHeight - 160) loadNextDirectoryPage()
}

watch(() => props.defaultRankingKeywords, (value) => {
  if (!rankingInitialized.value) {
    rankingKeywords.value = value || ''
    rankingInitialized.value = true
  }
}, { immediate: true })

watch(() => props.selectedJournalId, (id, previous) => {
  if (!id || id === previous) return
  void loadDirectory()
}, { immediate: true })

watch(mode, () => { if (props.selectedJournalId) void loadDirectory() })
</script>

<template>
  <div class="ieee-browser">
    <div class="library-header ieee-library-header">
      <div class="library-header-titles">
        <h1>{{ selectedJournal?.displayName || 'IEEE 期刊目录' }}</h1>
        <p>{{ selectedJournal?.publicationTitle || '请从左侧添加并选择一个期刊' }}</p>
      </div>
      <div v-if="selectedJournal" class="header-actions">
        <div class="mode-tabs" role="tablist" aria-label="目录类型">
          <button :class="{ active: mode === 'early_access' }" role="tab" :aria-selected="mode === 'early_access'" @click="mode = 'early_access'">Early Access</button>
          <button :class="{ active: mode === 'current_issue' }" role="tab" :aria-selected="mode === 'current_issue'" @click="mode = 'current_issue'">Current Issue</button>
        </div>
        <button class="secondary-btn" :disabled="loading || loadingMore" @click="loadDirectory(true)">{{ loading ? '加载中…' : '刷新' }}</button>
      </div>
    </div>

    <div v-if="selectedJournal" class="library-search ieee-filter">
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
      <input v-model="rankingKeywords" placeholder="目录关键词过滤 / 排序：多个词需同时命中" />
      <span class="filter-count">显示 {{ visiblePapers.length }} / 已加载 {{ papers.length }} / 共 {{ total }}</span>
    </div>

    <div v-if="!selectedJournal && !loading" class="library-empty">
      请从左侧点击加号添加 IEEE 期刊，然后选择期刊浏览目录。
    </div>
    <div v-else-if="error" class="library-empty error-state">
      <strong>无法加载目录</strong><span>{{ error }}</span>
      <button class="secondary-btn" @click="loadDirectory(true)">重试</button>
    </div>
    <div v-else-if="loading && !papers.length" class="library-empty">正在加载 {{ selectedJournal?.displayName }} 目录…</div>
    <div v-else-if="!visiblePapers.length" class="library-empty">
      {{ papers.length ? '没有匹配的目录文章；清空关键词即可恢复已加载目录。' : '此目录暂无文章。' }}
    </div>

    <div v-else class="paper-table ieee-paper-table" @scroll="onDirectoryScroll">
      <div class="directory-status">
        <span>{{ mode === 'current_issue' ? 'Current Issue' : 'Early Access' }}</span>
        <span v-if="fetchedAt">{{ cached ? '缓存' : '已获取' }}于 {{ new Date(fetchedAt).toLocaleString() }}</span>
      </div>
      <article v-for="paper in visiblePapers" :key="paper.articleNumber || paper.id" class="paper-row ieee-paper-row">
        <div class="paper-row-main">
          <h3>{{ paper.title || 'IEEE 未提供标题' }}</h3>
          <p class="paper-authors">{{ paper.authors?.join(', ') || '未知作者' }}</p>
          <div class="paper-meta">
            <span class="paper-venue">{{ paper.journal || paper.venue || selectedJournal?.publicationTitle }}</span>
            <span class="paper-date">{{ displayDate(paper) }}</span>
            <span v-if="paper.doi" class="paper-date">DOI: {{ paper.doi }}</span>
            <span v-if="paper.isEarlyAccess" class="early-access">Early Access</span>
          </div>
          <div v-if="paper.abstract || paper.articleNumber" class="paper-abstract-wrap">
            <p v-if="displayedAbstract(paper)" class="paper-abstract expanded">{{ displayedAbstract(paper) }}</p>
            <div class="abstract-load-row">
              <button
                v-if="!fullAbstracts[articleKey(paper)]"
                class="abstract-load-button"
                :disabled="loadingAbstracts.has(articleKey(paper))"
                @click="loadFullAbstract(paper)"
              >{{ loadingAbstracts.has(articleKey(paper)) ? '正在加载完整摘要…' : '加载完整摘要' }}</button>
              <span v-else class="abstract-complete">已加载完整摘要</span>
              <span v-if="abstractErrors[articleKey(paper)]" class="abstract-error">{{ abstractErrors[articleKey(paper)] }}</span>
            </div>
          </div>
        </div>
        <div class="paper-row-side">
          <a v-if="articleUrl(paper)" :href="articleUrl(paper)!" target="_blank" rel="noopener noreferrer" class="paper-action-link">在 IEEE Xplore 打开 ↗</a>
        </div>
      </article>
      <div v-if="loadingMore" class="directory-more-state">正在加载下一页…</div>
      <button v-else-if="hasMore" class="directory-more-button" @click="loadNextDirectoryPage">继续加载（{{ papers.length }} / {{ total }}）</button>
      <div v-else class="directory-more-state">已加载全部 {{ total }} 篇目录文章</div>
    </div>
  </div>
</template>

<style scoped>
.ieee-browser { height: 100%; min-height: 0; display: flex; flex-direction: column; color: var(--color-text); }
.library-header { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 24px 28px 16px; }
.library-header h1 { margin: 0; font-size: 24px; font-weight: 700; color: var(--color-text); letter-spacing: -.03em; }
.library-header p { margin: 4px 0 0; color: var(--color-text-muted); font-size: 13px; }
.header-actions { display: flex; align-items: center; gap: 12px; flex-shrink: 0; }
.secondary-btn { padding: 8px 16px; border: 1px solid var(--color-border); background: var(--color-bg-card); color: var(--color-text); border-radius: var(--radius-sm); font: inherit; font-size: 13px; cursor: pointer; transition: all var(--transition); }
.secondary-btn:hover:not(:disabled) { background: var(--color-bg-muted); border-color: var(--color-primary); }
.secondary-btn:disabled { opacity: .55; cursor: wait; }
.library-search { display: flex; align-items: center; gap: 10px; margin: 0 28px 16px; padding: 10px 12px; border: 1px solid var(--color-border); border-radius: var(--radius); background: var(--color-bg-card); color: var(--color-text-muted); }
.library-search input { flex: 1; min-width: 0; border: none; outline: none; background: transparent; color: var(--color-text); font: inherit; font-size: 14px; }
.paper-table { flex: 1; min-height: 0; overflow-y: auto; padding: 8px 28px calc(28px + var(--list-scroll-bottom-gap, 84px)); scroll-padding-bottom: var(--list-scroll-bottom-gap, 84px); }
.paper-row { display: flex; align-items: stretch; justify-content: space-between; gap: 20px; width: 100%; box-sizing: border-box; padding: 16px 18px; margin-bottom: 10px; border: 1px solid var(--color-border); border-radius: var(--radius); background: var(--color-bg-card); text-align: left; transition: transform var(--transition), box-shadow var(--transition), border-color var(--transition); }
.paper-row:hover { transform: translateY(-1px); border-color: var(--color-primary); box-shadow: var(--shadow); }
.paper-row-main { flex: 1; min-width: 0; }
.paper-row-main h3 { margin: 0; font-size: 15px; font-weight: 650; color: var(--color-text); line-height: 1.45; word-break: break-word; overflow-wrap: break-word; }
.paper-authors { margin: 5px 0 0; color: var(--color-text-muted); font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.paper-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 6px; color: var(--color-text-muted); font-size: 12px; }
.paper-venue { color: var(--color-text-secondary); font-weight: 500; }
.paper-abstract-wrap { margin-top: 8px; }
.paper-abstract { margin: 0; color: var(--color-text-secondary); font-size: 15px; white-space: pre-wrap; }
.abstract-load-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 7px; }
.abstract-load-button { padding: 0; border: none; background: transparent; color: var(--color-primary); font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; }
.abstract-load-button:hover:not(:disabled) { text-decoration: underline; }
.abstract-load-button:disabled { color: var(--color-text-muted); cursor: wait; }
.abstract-complete { color: var(--color-text-muted); font-size: 12px; }
.abstract-error { color: var(--color-danger); font-size: 12px; }
.paper-row-side { width: 150px; flex-shrink: 0; display: flex; flex-direction: column; align-items: flex-end; }
.library-empty { display: flex; flex: 1; flex-direction: column; justify-content: center; align-items: center; padding: 48px 28px; color: var(--color-text-muted); font-size: 14px; text-align: center; }
.ieee-library-header { padding-bottom: 14px; }
.mode-tabs { display: flex; align-items: center; padding: 2px; gap: 2px; border-radius: var(--radius-sm); background: var(--color-bg-muted); }
.mode-tabs button { padding: 6px 10px; border: none; border-radius: calc(var(--radius-sm) - 2px); background: transparent; color: var(--color-text-muted); font: inherit; font-size: 12px; cursor: pointer; }
.mode-tabs button.active { background: var(--color-bg-card); color: var(--color-primary); box-shadow: 0 1px 2px rgba(0, 0, 0, .08); }
.ieee-filter { margin-bottom: 8px; }
.filter-count { flex: 0 0 auto; padding-left: 8px; color: var(--color-text-muted); font-size: 12px; }
.ieee-paper-table { padding-top: 0; }
.directory-status { display: flex; justify-content: space-between; gap: 12px; padding: 6px 2px 10px; color: var(--color-text-muted); font-size: 12px; }
.directory-more-state { padding: 12px 0 4px; color: var(--color-text-muted); font-size: 13px; text-align: center; }
.directory-more-button { display: block; width: 100%; margin: 4px 0; padding: 9px 12px; border: 1px solid var(--color-border); border-radius: var(--radius-sm); background: var(--color-bg-card); color: var(--color-primary); font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; }
.directory-more-button:hover { border-color: var(--color-primary); background: var(--color-primary-soft); }
.ieee-paper-row { cursor: default; }
.ieee-paper-row:hover { transform: none; }
.early-access { display: inline-flex; align-items: center; padding: 2px 6px; border-radius: 999px; background: rgba(245, 158, 11, .14); color: #c46b00; font-size: 11px; font-weight: 700; }
.paper-action-link { color: var(--color-primary); font-size: 12px; font-weight: 600; text-decoration: none; white-space: nowrap; }
.paper-action-link:hover { text-decoration: underline; }
.error-state { gap: 8px; }.error-state strong { color: var(--color-danger); }.error-state span { color: var(--color-text-secondary); }
@media (max-width: 720px) { .ieee-library-header { align-items: flex-start; flex-direction: column; gap: 12px; }.paper-row-side { width: auto; align-items: flex-start; margin-top: 10px; }.ieee-paper-row { flex-direction: column; gap: 0; } }
</style>
