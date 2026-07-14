<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useRouter } from 'vue-router'
import type { SearchPaper } from '@yarc/shared'
import ImportToLibraryDialog from '@/components/search/ImportToLibraryDialog.vue'
import { usePaperReferenceStore } from '@/stores/paperReference'

const router = useRouter()
const store = usePaperReferenceStore()
const { open, loading, saving, error, reference, resolution, anchorRect, anchorElement } = storeToRefs(store)
const searchTitle = ref('')
const showImport = ref(false)
const importPapers = ref<SearchPaper[]>([])
const popoverRef = ref<HTMLElement | null>(null)
const viewportWidth = ref(window.innerWidth)
const viewportHeight = ref(window.innerHeight)

watch(reference, value => { searchTitle.value = value?.title || '' }, { immediate: true })

const paper = computed(() => resolution.value?.localPaper || resolution.value?.paper || null)
const candidates = computed(() => resolution.value?.candidates || [])
const isLocal = computed(() => paper.value?.source === 'local' || !!resolution.value?.localPaper)
const sourceLabel = computed(() => ({
  local: '本地文献库',
  semantic_scholar: 'Semantic Scholar',
  ieee: 'IEEE Xplore',
} as Record<string, string>)[paper.value?.source || ''] || paper.value?.source || '未知')
const pdfUrl = computed(() => paper.value?.pdfUrl || paper.value?.openAccessPdf?.url || null)

const popoverStyle = computed(() => {
  const margin = 12
  const gap = 8
  const width = Math.min(560, viewportWidth.value - margin * 2)
  const rect = anchorRect.value
  if (!rect) {
    return { width: `${width}px`, left: `${Math.max(margin, (viewportWidth.value - width) / 2)}px`, top: '72px', maxHeight: `calc(100vh - ${margin * 2}px)` }
  }

  const below = viewportHeight.value - rect.bottom - margin - gap
  const above = rect.top - margin - gap
  const requiredBelowSpace = Math.min(440, viewportHeight.value * 0.65)
  const placeBelow = below >= requiredBelowSpace || above < 240
  const availableHeight = Math.max(180, Math.min(560, placeBelow ? below : above))
  const centeredLeft = rect.left + rect.width / 2 - width / 2
  const left = Math.min(viewportWidth.value - width - margin, Math.max(margin, centeredLeft))
  const top = placeBelow
    ? rect.bottom + gap
    : Math.max(margin, rect.top - availableHeight - gap)

  return {
    width: `${width}px`,
    left: `${left}px`,
    top: `${top}px`,
    maxHeight: `${availableHeight}px`,
  }
})

const openLocalPaper = () => {
  const local = resolution.value?.localPaper || (paper.value?.source === 'local' ? paper.value : null)
  if (!local?.id) return
  store.close()
  void router.push(`/paper/${local.id}`)
}

const openExternal = () => {
  const url = paper.value?.url || reference.value?.url
  if (url) window.open(url, '_blank', 'noopener,noreferrer')
}

const save = async () => {
  try { await store.saveToLibrary() } catch { /* store exposes the error */ }
}

const startImport = () => {
  if (!paper.value || paper.value.source === 'local') return
  importPapers.value = [{ ...paper.value, pdfUrl: pdfUrl.value || paper.value.url }]
  showImport.value = true
}

const searchAgain = () => {
  const title = searchTitle.value.trim()
  if (!title) return
  void store.resolve({ title, rawText: title }, true)
}

const close = () => store.close()
const onDocumentPointerDown = (event: PointerEvent) => {
  if (!popoverRef.value?.contains(event.target as Node)) close()
}
const onDocumentKeydown = (event: KeyboardEvent) => { if (event.key === 'Escape') close() }
let anchorRaf = 0
const updateAnchorPosition = () => {
  anchorRaf = 0
  const anchor = anchorElement.value
  if (!anchor?.isConnected) return
  const rect = anchor.getBoundingClientRect()
  const isVisible = rect.bottom > 0 && rect.top < viewportHeight.value && rect.right > 0 && rect.left < viewportWidth.value
  if (!isVisible) {
    close()
    return
  }
  store.updateAnchorRect({
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    left: rect.left,
    width: rect.width,
    height: rect.height,
  })
}
const scheduleAnchorPosition = () => {
  cancelAnimationFrame(anchorRaf)
  anchorRaf = requestAnimationFrame(updateAnchorPosition)
}
const onViewportChange = () => {
  viewportWidth.value = window.innerWidth
  viewportHeight.value = window.innerHeight
  scheduleAnchorPosition()
}
const onDocumentScroll = (event: Event) => {
  // Chat/tool output auto-scrolls in a separate pane; only close when the
  // scrolling container can actually move the clicked Markdown reference.
  const target = event.target
  const anchor = anchorElement.value
  if (!anchor?.isConnected || popoverRef.value?.contains(target as Node)) return
  if (target === document || target === window || (target instanceof Node && target.contains(anchor))) close()
}

watch(open, async value => {
  if (value) {
    onViewportChange()
    await nextTick()
    document.addEventListener('pointerdown', onDocumentPointerDown)
    document.addEventListener('keydown', onDocumentKeydown)
    document.addEventListener('scroll', onDocumentScroll, true)
    window.addEventListener('resize', onViewportChange)
  } else {
    cancelAnimationFrame(anchorRaf)
    document.removeEventListener('pointerdown', onDocumentPointerDown)
    document.removeEventListener('keydown', onDocumentKeydown)
    document.removeEventListener('scroll', onDocumentScroll, true)
    window.removeEventListener('resize', onViewportChange)
  }
})

onBeforeUnmount(() => {
  cancelAnimationFrame(anchorRaf)
  document.removeEventListener('pointerdown', onDocumentPointerDown)
  document.removeEventListener('keydown', onDocumentKeydown)
  document.removeEventListener('scroll', onDocumentScroll, true)
  window.removeEventListener('resize', onViewportChange)
})
</script>

<template>
  <Teleport to="body">
    <Transition name="paper-popover">
      <section v-if="open" ref="popoverRef" class="paper-reference-popover" :style="popoverStyle" role="dialog" aria-label="论文引用">
        <header class="reference-header">
          <strong>论文引用</strong>
          <button type="button" title="关闭" @click="close">×</button>
        </header>

        <div class="paper-reference-dialog">
          <div v-if="loading" class="reference-state">
            <span class="reference-spinner" />
            <strong>正在解析论文引用…</strong>
            <small>优先匹配本地文献库，必要时查询外部来源。</small>
          </div>

          <template v-else-if="resolution?.status === 'ambiguous'">
            <div class="reference-heading">
              <strong>找到多个可能匹配的论文</strong>
              <small>请选择与 Markdown 引用对应的论文。</small>
            </div>
            <div class="candidate-list">
              <button v-for="candidate in candidates" :key="`${candidate.source}:${candidate.id}`" class="candidate-card" @click="store.chooseCandidate(candidate)">
                <span class="candidate-title">{{ candidate.title }}</span>
                <span class="candidate-meta">
                  {{ candidate.authors?.slice(0, 3).join(', ') || '作者未知' }}
                  <template v-if="candidate.year"> · {{ candidate.year }}</template>
                </span>
                <span class="candidate-source">{{ candidate.source === 'local' ? '本地文献库' : candidate.source === 'ieee' ? 'IEEE Xplore' : 'Semantic Scholar' }}</span>
              </button>
            </div>
          </template>

          <template v-else-if="paper">
            <div class="reference-badges">
              <span class="reference-badge" :class="{ local: isLocal }">{{ isLocal ? '本地论文' : '外部论文 · 尚未保存' }}</span>
              <span class="reference-badge muted">{{ sourceLabel }}</span>
            </div>
            <h3 class="reference-title">{{ paper.title }}</h3>
            <p class="reference-authors">{{ paper.authors?.join(', ') || '作者未知' }}</p>
            <div class="reference-grid">
              <div v-if="paper.year"><span>年份</span><strong>{{ paper.year }}</strong></div>
              <div v-if="paper.journal || paper.venue"><span>期刊/会议</span><strong>{{ paper.journal || paper.venue }}</strong></div>
              <div v-if="paper.doi"><span>DOI</span><strong>{{ paper.doi }}</strong></div>
              <div v-if="paper.arxivId"><span>arXiv</span><strong>{{ paper.arxivId }}</strong></div>
              <div v-if="paper.citationCount !== undefined && paper.citationCount !== null"><span>引用次数</span><strong>{{ paper.citationCount }}</strong></div>
            </div>
            <div v-if="paper.abstract" class="reference-abstract">
              <strong>摘要</strong>
              <p>{{ paper.abstract }}</p>
            </div>
          </template>

          <template v-else>
            <div class="reference-state not-found">
              <strong>{{ resolution?.status === 'error' ? '解析论文引用失败' : '没有找到可靠匹配' }}</strong>
              <small>{{ error || resolution?.error || '可以修改论文标题后重新搜索。' }}</small>
            </div>
            <div class="reference-search">
              <input v-model="searchTitle" placeholder="输入完整论文标题" @keydown.enter="searchAgain" />
              <button :disabled="!searchTitle.trim()" @click="searchAgain">重新搜索</button>
            </div>
          </template>

          <p v-if="error && paper" class="reference-error">{{ error }}</p>
        </div>

        <footer class="reference-footer">
          <button v-if="paper && !isLocal && pdfUrl" class="reference-action" @click="startImport">导入 PDF</button>
          <button v-if="paper && !isLocal" class="reference-action" :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存题录' }}</button>
          <button v-if="paper?.url || reference?.url" class="reference-action" @click="openExternal">查看原文</button>
          <button v-if="isLocal" class="reference-action primary" @click="openLocalPaper">{{ paper?.filePath ? '打开论文' : '查看本地记录' }}</button>
        </footer>
      </section>
    </Transition>
  </Teleport>

  <ImportToLibraryDialog v-model="showImport" :papers="importPapers" @started="store.close()" />
</template>

<style scoped>
.paper-reference-popover { position: fixed; z-index: 1200; display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--color-border); border-radius: 14px; background: var(--color-bg-card); color: var(--color-text); box-shadow: 0 18px 50px rgba(15, 23, 42, .2), 0 4px 14px rgba(15, 23, 42, .1); transform-origin: top center; }
.reference-header { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px 8px 16px; border-bottom: 1px solid var(--color-border); flex-shrink: 0; }
.reference-header strong { font-size: 13px; }
.reference-header button { width: 26px; height: 26px; border: 0; border-radius: 6px; background: transparent; color: var(--color-text-muted); font-size: 20px; line-height: 1; cursor: pointer; }
.reference-header button:hover { background: var(--color-bg-muted); color: var(--color-text); }
.paper-reference-dialog { min-height: 130px; padding: 14px 16px; overflow-y: auto; overscroll-behavior: contain; }
.reference-state { display: flex; min-height: 140px; flex-direction: column; align-items: center; justify-content: center; gap: 8px; color: var(--color-text-secondary); text-align: center; }
.reference-state strong { color: var(--color-text); font-size: 14px; }
.reference-state small { max-width: 400px; line-height: 1.5; }
.reference-spinner { width: 22px; height: 22px; border: 2px solid var(--color-border); border-top-color: var(--color-primary); border-radius: 50%; animation: reference-spin .8s linear infinite; }
@keyframes reference-spin { to { transform: rotate(360deg); } }
.reference-heading { display: flex; flex-direction: column; gap: 4px; margin-bottom: 10px; }
.reference-heading small { color: var(--color-text-muted); font-size: 12px; }
.candidate-list { display: flex; flex-direction: column; gap: 7px; }
.candidate-card { display: flex; flex-direction: column; gap: 4px; padding: 10px 12px; border: 1px solid var(--color-border); border-radius: var(--radius); background: var(--color-bg); color: var(--color-text); text-align: left; cursor: pointer; }
.candidate-card:hover { border-color: rgba(var(--color-primary-rgb), .4); background: rgba(var(--color-primary-rgb), .05); }
.candidate-title { font-weight: 600; line-height: 1.4; }
.candidate-meta { color: var(--color-text-secondary); font-size: 12px; }
.candidate-source { color: var(--color-text-muted); font-size: 11px; }
.reference-badges { display: flex; gap: 6px; margin-bottom: 8px; }
.reference-badge { padding: 2px 7px; border-radius: 999px; background: rgba(245, 158, 11, .12); color: var(--color-warning); font-size: 10px; font-weight: 600; }
.reference-badge.local { background: rgba(34, 197, 94, .12); color: var(--color-success); }
.reference-badge.muted { background: var(--color-bg-muted); color: var(--color-text-muted); }
.reference-title { margin: 0; font-size: 17px; line-height: 1.4; }
.reference-authors { margin: 5px 0 13px; color: var(--color-text-secondary); font-size: 12px; }
.reference-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 7px 16px; }
.reference-grid div { display: flex; min-width: 0; flex-direction: column; gap: 1px; }
.reference-grid span { color: var(--color-text-muted); font-size: 10px; }
.reference-grid strong { overflow-wrap: anywhere; font-size: 12px; font-weight: 500; }
.reference-abstract { margin-top: 14px; }
.reference-abstract > strong { font-size: 13px; }
.reference-abstract p { margin: 6px 0 0; color: var(--color-text-secondary); font-size: 14px; line-height: 1.75; cursor: text; user-select: text; }
.reference-search { display: flex; gap: 8px; }
.reference-search input { flex: 1; min-width: 0; padding: 8px 10px; border: 1px solid var(--color-border); border-radius: var(--radius-sm); background: var(--color-bg); color: var(--color-text); }
.reference-search button { padding: 7px 10px; border: 0; border-radius: var(--radius-sm); background: var(--color-primary); color: #fff; cursor: pointer; }
.reference-search button:disabled { opacity: .5; cursor: not-allowed; }
.reference-error { margin: 10px 0 0; color: var(--color-error); font-size: 12px; }
.reference-footer { display: flex; justify-content: flex-end; gap: 6px; padding: 9px 12px; border-top: 1px solid var(--color-border); background: var(--color-bg-card); flex-shrink: 0; }
.reference-action { padding: 6px 9px; border: 1px solid var(--color-border); border-radius: var(--radius-sm); background: var(--color-bg); color: var(--color-text-secondary); font-size: 11px; cursor: pointer; }
.reference-action:hover:not(:disabled) { border-color: rgba(var(--color-primary-rgb), .4); color: var(--color-primary); }
.reference-action.primary { border-color: var(--color-primary); background: var(--color-primary); color: #fff; }
.reference-action:disabled { opacity: .5; cursor: not-allowed; }
.paper-popover-enter-active, .paper-popover-leave-active { transition: opacity .12s ease, transform .12s ease; }
.paper-popover-enter-from, .paper-popover-leave-to { opacity: 0; transform: translateY(-3px) scale(.985); }
@media (max-width: 640px) { .reference-grid { grid-template-columns: 1fr; } }
</style>
