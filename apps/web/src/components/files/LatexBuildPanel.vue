<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useApi } from '@/composables/useApi'
import PdfViewer from '@/components/pdf/PdfViewer.vue'
import type { LatexBuild, LatexDiagnostic, LatexEngine, LatexSyncTexRect } from '@yarc/shared'

const props = withDefaults(defineProps<{
  path: string
  name: string
  sourceFile?: string
  sourceLine?: number
  sourceColumn?: number
  autoStart?: boolean
  engine?: LatexEngine
}>(), {
  autoStart: false,
  engine: 'xelatex',
})

const emit = defineEmits<{
  close: []
  openSource: [position: { file: string; line: number; column: number }]
  status: [state: { active: boolean; loading: boolean; completed: boolean; synctexAvailable: boolean }]
  'update:engine': [engine: LatexEngine]
}>()

const api = useApi()
const engine = computed({
  get: () => props.engine || 'xelatex',
  set: (value: LatexEngine) => emit('update:engine', value),
})
const build = ref<LatexBuild | null>(null)
const log = ref('')
const loading = ref(false)
const error = ref('')
const syncError = ref('')
const syncLoading = ref(false)
const buildInfoOpen = ref(false)
const pdfPage = ref<number | null>(null)
const pdfPosition = ref<{ page: number; x?: number; y?: number } | null>(null)
const pdfHighlights = ref<LatexSyncTexRect[]>([])
const pdfViewer = ref<InstanceType<typeof PdfViewer> | null>(null)
let pollTimer: number | null = null
let pdfHighlightTimer: number | null = null
let pendingPdfHighlights: LatexSyncTexRect[] = []
let requestSequence = 0
let syncedBuildId = ''

const isActive = computed(() => build.value?.status === 'queued' || build.value?.status === 'running')
const pdfUrl = computed(() => {
  if (!build.value?.pdfAvailable || build.value.status !== 'completed') return ''
  return api.getLatexPdfUrl(build.value.id, build.value.completedAt || build.value.id)
})
const pdfDocumentId = computed(() => build.value ? `latex-${build.value.id}` : '')
const diagnostics = computed<LatexDiagnostic[]>(() => build.value?.diagnostics || [])
const errors = computed(() => diagnostics.value.filter((item) => item.severity === 'error'))
const warnings = computed(() => diagnostics.value.filter((item) => item.severity === 'warning'))
const latexErrorCount = computed(() => errors.value.length
  + (error.value ? 1 : 0)
  + (build.value?.error ? 1 : 0)
  + (syncError.value ? 1 : 0))
const latexWarningCount = computed(() => warnings.value.length)
const hasBuildInfo = computed(() => !!build.value || !!log.value || !!error.value || !!syncError.value)

const emitBuildStatus = () => {
  emit('status', {
    active: isActive.value,
    loading: loading.value,
    completed: build.value?.status === 'completed',
    synctexAvailable: !!build.value?.synctexAvailable,
  })
}

watch([build, loading], emitBuildStatus, { immediate: true })

const clearPoll = () => {
  if (pollTimer !== null) {
    window.clearTimeout(pollTimer)
    pollTimer = null
  }
}

const clearPdfHighlight = () => {
  pendingPdfHighlights = []
  if (pdfHighlightTimer !== null) {
    window.clearTimeout(pdfHighlightTimer)
    pdfHighlightTimer = null
  }
  pdfHighlights.value = []
}

const flashPdfHighlight = (rectangles: LatexSyncTexRect[]) => {
  clearPdfHighlight()
  pdfHighlights.value = rectangles
  pdfHighlightTimer = window.setTimeout(() => {
    pdfHighlightTimer = null
    pdfHighlights.value = []
  }, 2200)
}

const handlePdfNavigationComplete = () => {
  // Start the animation only after arrival, including an already-visible target.
  // flashPdfHighlight clears the pending state so completion cannot replay it.
  if (pendingPdfHighlights.length) flashPdfHighlight(pendingPdfHighlights)
}

const loadLog = async (id: string, sequence: number) => {
  const result = await api.getLatexBuildLog(id)
  if (sequence !== requestSequence) return
  log.value = result.log
  if (build.value) build.value.diagnostics = result.diagnostics
}

const syncToCurrentSource = async (id: string, sequence: number, highlight = false) => {
  if (syncedBuildId === id || !build.value?.synctexAvailable) return
  clearPdfHighlight()
  syncedBuildId = id
  syncLoading.value = true
  syncError.value = ''
  try {
    const result = await api.getLatexSyncTex(id, {
      direction: 'forward',
      file: props.sourceFile || props.name,
      line: props.sourceLine || 1,
      column: props.sourceColumn || 1,
    })
    if (sequence !== requestSequence) return
    const page = Number(result.page)
    const x = Number(result.x)
    const y = Number(result.y)
    pdfPage.value = Number.isFinite(page) && page > 0 ? Math.round(page) : null
    pdfPosition.value = pdfPage.value
      ? {
          page: pdfPage.value,
          ...(Number.isFinite(x) ? { x } : {}),
          ...(Number.isFinite(y) ? { y } : {}),
        }
      : null
    // Draw each matched line separately instead of dropping all but the first
    // or merging boxes across columns/pages into one oversized rectangle.
    // Automatic post-build synchronization is quiet; only explicit location
    // requests should flash after arrival.
    pendingPdfHighlights = highlight ? (result.rectangles || []) : []
    if (pdfPage.value) jumpToPdfPage()
    else syncError.value = 'SyncTeX 未返回 PDF 页码'
  } catch (err) {
    if (sequence === requestSequence) syncError.value = (err as Error).message || 'SyncTeX 定位失败'
  } finally {
    if (sequence === requestSequence) syncLoading.value = false
  }
}

const pollBuild = async (id: string, sequence: number) => {
  try {
    const result = await api.getLatexBuild(id)
    if (sequence !== requestSequence) return
    build.value = result.build
    await loadLog(id, sequence)
    if (sequence !== requestSequence) return
    if (result.build.status === 'completed' && result.build.synctexAvailable) {
      await syncToCurrentSource(id, sequence)
    }
    if (sequence !== requestSequence) return
    if (result.build.status === 'queued' || result.build.status === 'running') {
      pollTimer = window.setTimeout(() => { void pollBuild(id, sequence) }, 700)
    }
  } catch (err) {
    if (sequence !== requestSequence) return
    error.value = (err as Error).message || '读取编译状态失败'
  }
}

const startBuild = async () => {
  if (loading.value || isActive.value) return
  clearPoll()
  const sequence = ++requestSequence
  loading.value = true
  error.value = ''
  log.value = ''
  syncError.value = ''
  buildInfoOpen.value = false
  pdfPage.value = null
  pdfPosition.value = null
  clearPdfHighlight()
  syncedBuildId = ''
  try {
    const result = await api.compileLatex(props.path, engine.value)
    if (sequence !== requestSequence) return
    build.value = result.build
    await pollBuild(result.build.id, sequence)
  } catch (err) {
    if (sequence === requestSequence) error.value = (err as Error).message || '启动 LaTeX 编译失败'
  } finally {
    if (sequence === requestSequence) loading.value = false
  }
}

const cancelBuild = async () => {
  const current = build.value
  if (!current || !isActive.value) return
  error.value = ''
  try {
    const result = await api.cancelLatexBuild(current.id)
    build.value = result.build
    await loadLog(current.id, requestSequence)
  } catch (err) {
    error.value = (err as Error).message || '取消编译失败'
  }
}

const jumpToPdfPage = () => {
  const position = pdfPosition.value
  if (!position) return
  if (position.x !== undefined && position.y !== undefined && pdfViewer.value?.goToPosition) {
    pdfViewer.value.goToPosition(position.page, position.x, position.y)
    return
  }
  if (pdfViewer.value?.goToPage) {
    pdfViewer.value.goToPage(position.page)
    return
  }
}

// Hand the pending position to the viewer as soon as it mounts, rather than
// polling every 120 ms (and potentially giving up before a large PDF is ready).
watch(pdfViewer, (viewer) => {
  if (viewer) jumpToPdfPage()
}, { flush: 'post' })

const handlePdfPosition = async (position: { page: number; x: number; y: number }) => {
  const current = build.value
  if (!current?.synctexAvailable || syncLoading.value) return
  syncLoading.value = true
  syncError.value = ''
  clearPdfHighlight()
  try {
    const result = await api.getLatexSyncTex(current.id, {
      direction: 'backward',
      page: position.page,
      x: position.x,
      y: position.y,
    })
    const file = typeof result.file === 'string' ? result.file : ''
    const line = Number(result.line)
    const column = Number(result.column)
    if (!file || !Number.isFinite(line) || line < 1) {
      syncError.value = 'SyncTeX 未返回可定位的源文件位置'
      return
    }
    emit('openSource', {
      file,
      line: Math.round(line),
      column: Number.isFinite(column) && column > 0 ? Math.round(column) : 1,
    })
  } catch (err) {
    syncError.value = (err as Error).message || 'PDF 反向定位失败'
  } finally {
    syncLoading.value = false
  }
}

const locateCurrentSource = () => {
  const current = build.value
  if (!current?.synctexAvailable) return
  syncedBuildId = ''
  void syncToCurrentSource(current.id, requestSequence, true)
}

const formatLocation = (diagnostic: LatexDiagnostic) => {
  if (!diagnostic.file && diagnostic.line === undefined) return ''
  return `${diagnostic.file || '源文件'}${diagnostic.line === undefined ? '' : `:${diagnostic.line}`}`
}

watch(() => props.path, () => {
  clearPoll()
  requestSequence += 1
  build.value = null
  log.value = ''
  error.value = ''
  syncError.value = ''
  buildInfoOpen.value = false
  pdfPage.value = null
  pdfPosition.value = null
  clearPdfHighlight()
  syncedBuildId = ''
  // Changing the active source file must not trigger a new build. The build
  // entry is controlled by the parent, and users can explicitly rebuild from
  // this panel after changing it.
})

onMounted(() => {
  if (props.autoStart) void startBuild()
})

defineExpose({ startBuild, cancelBuild, locateCurrentSource })

onBeforeUnmount(() => {
  clearPoll()
  clearPdfHighlight()
  requestSequence += 1
})
</script>

<template>
  <section class="latex-build-panel">
    <div class="latex-build-toolbar">
      <div v-if="build" class="latex-build-meta">
        <span v-if="build.durationMs !== undefined">耗时 {{ (build.durationMs / 1000).toFixed(1) }} 秒</span>
        <span>{{ build.pdfAvailable ? 'PDF 已生成' : '暂无 PDF' }}</span>
        <span>{{ build.synctexAvailable ? 'SyncTeX 已生成' : '暂无 SyncTeX' }}</span>
        <span v-if="pdfPage">已定位到第 {{ pdfPage }} 页</span>
      </div>
      <button
        v-if="hasBuildInfo"
        type="button"
        class="latex-build-info-toggle"
        :class="{ active: buildInfoOpen, 'has-errors': latexErrorCount > 0, 'has-warnings': latexWarningCount > 0 }"
        :aria-expanded="buildInfoOpen"
        aria-controls="latex-build-info-panel"
        @click="buildInfoOpen = !buildInfoOpen"
      >
        <span>编译信息</span>
        <span class="latex-build-info-badges" aria-hidden="true">
          <span v-if="latexErrorCount" class="latex-build-count error">{{ latexErrorCount }}</span>
          <span v-if="latexWarningCount" class="latex-build-count warning">{{ latexWarningCount }}</span>
        </span>
      </button>
    </div>

    <div v-if="buildInfoOpen" id="latex-build-info-panel" class="latex-build-info-panel">
      <div v-if="error" class="latex-build-error">{{ error }}</div>
      <div v-if="build?.error" class="latex-build-error">{{ build.error }}</div>
      <div v-if="syncError" class="latex-build-error">{{ syncError }}</div>

      <div v-if="diagnostics.length" class="latex-diagnostics" aria-label="LaTeX 诊断信息">
        <div
          v-for="(diagnostic, index) in diagnostics"
          :key="`${diagnostic.severity}-${diagnostic.file}-${diagnostic.line}-${index}`"
          class="latex-diagnostic"
          :class="`diagnostic-${diagnostic.severity}`"
        >
          <span class="latex-diagnostic-kind">{{ diagnostic.severity === 'error' ? '错误' : diagnostic.severity === 'warning' ? '警告' : '信息' }}</span>
          <span v-if="formatLocation(diagnostic)" class="latex-diagnostic-location">{{ formatLocation(diagnostic) }}</span>
          <span>{{ diagnostic.message }}</span>
        </div>
      </div>

      <div v-if="log" class="latex-build-log">
        <div class="latex-build-log-title">编译日志</div>
        <pre>{{ log }}</pre>
      </div>
      <div v-if="!error && !build?.error && !syncError && !diagnostics.length && !log" class="latex-build-info-empty">暂无编译信息</div>
    </div>

    <div v-if="pdfUrl" class="latex-pdf-preview">
      <PdfViewer
        ref="pdfViewer"
        :key="pdfDocumentId"
        :source-url="pdfUrl"
        :document-id="pdfDocumentId"
        :title="`${name} 编译结果`"
        :source-highlights="pdfHighlights"
        :show-back-button="false"
        @pdf-position="handlePdfPosition"
        @navigation-complete="handlePdfNavigationComplete"
        @navigation-cancelled="clearPdfHighlight"
      />
    </div>
    <div v-else-if="isActive" class="latex-build-placeholder">正在等待 TeX Live 编译结果…</div>

  </section>
</template>

<style scoped>
.latex-build-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: rgba(var(--color-bg-rgb), 0.72);
}

.latex-build-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex: 0 0 auto;
  padding: 8px 14px;
}

.latex-build-error {
  margin: 0 0 8px;
  padding: 8px 10px;
  border: 1px solid rgba(239, 68, 68, 0.28);
  border-radius: 8px;
  color: var(--color-error);
  background: rgba(239, 68, 68, 0.08);
  font-size: 12px;
}

.latex-build-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 12px;
  min-width: 0;
  color: var(--color-text-muted);
  font-size: 11px;
}

.latex-build-info-toggle {
  position: relative;
  flex: 0 0 auto;
  min-height: 28px;
  padding: 4px 10px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-bg);
  color: var(--color-text-secondary);
  font-size: 12px;
  cursor: pointer;
}
.latex-build-info-toggle:hover,
.latex-build-info-toggle.active {
  border-color: rgba(var(--color-primary-rgb), 0.42);
  background: rgba(var(--color-primary-rgb), 0.10);
  color: var(--color-primary);
}
.latex-build-info-toggle.has-errors { border-color: rgba(239, 68, 68, 0.42); }
.latex-build-info-toggle.has-warnings:not(.has-errors) { border-color: rgba(245, 158, 11, 0.42); }
.latex-build-info-badges {
  position: absolute;
  top: -7px;
  right: -7px;
  display: flex;
  gap: 2px;
  pointer-events: none;
}
.latex-build-count {
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border: 2px solid var(--color-bg-card);
  border-radius: 999px;
  color: white;
  font-size: 10px;
  font-weight: 700;
  line-height: 12px;
  text-align: center;
}
.latex-build-count.error { background: var(--color-error); }
.latex-build-count.warning { background: var(--color-warning); }

.latex-build-info-panel {
  flex: 0 0 auto;
  max-height: min(42vh, 360px);
  margin: 0 14px 10px;
  padding: 10px;
  overflow: auto;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-bg-muted);
}

.latex-diagnostics {
  max-height: 150px;
  margin: 0 0 8px;
  overflow: auto;
  padding: 0;
}
.latex-diagnostic {
  display: flex;
  align-items: baseline;
  gap: 7px;
  padding: 4px 7px;
  border-radius: 6px;
  color: var(--color-text-secondary);
  font-size: 12px;
}
.diagnostic-error { background: rgba(239, 68, 68, 0.08); }
.diagnostic-warning { background: rgba(245, 158, 11, 0.08); }
.latex-diagnostic-kind { flex: 0 0 auto; font-weight: 600; }
.diagnostic-error .latex-diagnostic-kind { color: var(--color-error); }
.diagnostic-warning .latex-diagnostic-kind { color: var(--color-warning); }
.latex-diagnostic-location { flex: 0 0 auto; color: var(--color-primary); font-family: 'JetBrains Mono', monospace; font-size: 11px; }

.latex-pdf-preview {
  flex: 1;
  min-height: 240px;
  margin: 0 14px 10px;
  overflow: hidden;
  border: 1px solid var(--color-border);
  border-radius: 10px;
  background: var(--color-bg-muted);
}
.latex-pdf-preview :deep(.pdf-viewer) { height: 100%; min-height: 420px; }
.latex-build-placeholder {
  display: grid;
  flex: 1;
  min-height: 220px;
  place-items: center;
  color: var(--color-text-muted);
  font-size: 13px;
}

.latex-build-log {
  max-height: 220px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  overflow: hidden;
  background: var(--color-bg-card);
}
.latex-build-log-title {
  padding: 8px 10px;
  color: var(--color-text-secondary);
  background: var(--color-bg-muted);
  font-size: 12px;
}
.latex-build-log pre { max-height: 170px; margin: 0; padding: 10px; overflow: auto; color: var(--color-text-secondary); font: 11px/1.55 'JetBrains Mono', monospace; white-space: pre-wrap; }
.latex-build-info-empty { color: var(--color-text-muted); font-size: 12px; }

</style>
