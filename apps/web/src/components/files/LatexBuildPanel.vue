<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useApi } from '@/composables/useApi'
import PdfViewer from '@/components/pdf/PdfViewer.vue'
import type { LatexBuild, LatexDiagnostic, LatexEngine } from '@yarc/shared'

const props = withDefaults(defineProps<{
  path: string
  name: string
  sourceFile?: string
  sourceLine?: number
  sourceColumn?: number
  autoStart?: boolean
}>(), {
  autoStart: false,
})

const emit = defineEmits<{
  close: []
  openSource: [position: { file: string; line: number; column: number }]
}>()

const api = useApi()
const engine = ref<LatexEngine>('xelatex')
const build = ref<LatexBuild | null>(null)
const log = ref('')
const loading = ref(false)
const error = ref('')
const syncError = ref('')
const syncLoading = ref(false)
const pdfPage = ref<number | null>(null)
const pdfPosition = ref<{ page: number; x?: number; y?: number } | null>(null)
const pdfHighlight = ref<{ page: number; x: number; y: number; width?: number; height?: number } | null>(null)
const pdfViewer = ref<InstanceType<typeof PdfViewer> | null>(null)
let pollTimer: number | null = null
let requestSequence = 0
let syncedBuildId = ''

const isActive = computed(() => build.value?.status === 'queued' || build.value?.status === 'running')
const statusText = computed(() => {
  switch (build.value?.status) {
    case 'queued': return '排队中'
    case 'running': return '编译中'
    case 'completed': return '编译成功'
    case 'failed': return '编译失败'
    case 'cancelled': return '已取消'
    default: return '尚未编译'
  }
})
const pdfUrl = computed(() => {
  if (!build.value?.pdfAvailable || build.value.status !== 'completed') return ''
  return api.getLatexPdfUrl(build.value.id, build.value.completedAt || build.value.id)
})
const pdfDocumentId = computed(() => build.value ? `latex-${build.value.id}` : '')
const diagnostics = computed<LatexDiagnostic[]>(() => build.value?.diagnostics || [])
const errors = computed(() => diagnostics.value.filter((item) => item.severity === 'error'))
const warnings = computed(() => diagnostics.value.filter((item) => item.severity === 'warning'))

const clearPoll = () => {
  if (pollTimer !== null) {
    window.clearTimeout(pollTimer)
    pollTimer = null
  }
}

const loadLog = async (id: string, sequence: number) => {
  const result = await api.getLatexBuildLog(id)
  if (sequence !== requestSequence) return
  log.value = result.log
  if (build.value) build.value.diagnostics = result.diagnostics
}

const syncToCurrentSource = async (id: string, sequence: number) => {
  if (syncedBuildId === id || !build.value?.synctexAvailable) return
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
    pdfHighlight.value = pdfPage.value && Number.isFinite(x) && Number.isFinite(y)
      ? {
          page: pdfPage.value,
          x,
          y,
          ...(Number.isFinite(Number(result.width)) ? { width: Number(result.width) } : {}),
          ...(Number.isFinite(Number(result.height)) ? { height: Number(result.height) } : {}),
        }
      : null
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
  pdfPage.value = null
  pdfPosition.value = null
  pdfHighlight.value = null
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

const jumpToPdfPage = (attempt = 0) => {
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
  if (attempt < 24) window.setTimeout(() => jumpToPdfPage(attempt + 1), 120)
}

const handlePdfPosition = async (position: { page: number; x: number; y: number }) => {
  const current = build.value
  if (!current?.synctexAvailable || syncLoading.value) return
  syncLoading.value = true
  syncError.value = ''
  pdfHighlight.value = null
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
  void syncToCurrentSource(current.id, requestSequence)
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
  pdfPage.value = null
  pdfPosition.value = null
  pdfHighlight.value = null
  syncedBuildId = ''
  // Changing the active source file must not trigger a new build. The build
  // entry is controlled by the parent, and users can explicitly rebuild from
  // this panel after changing it.
})

onMounted(() => {
  if (props.autoStart) void startBuild()
})

defineExpose({ startBuild })

onBeforeUnmount(() => {
  clearPoll()
  requestSequence += 1
})
</script>

<template>
  <section class="latex-build-panel">
    <header class="latex-build-toolbar">
      <div class="latex-build-title">
        <strong>LaTeX 编译</strong>
        <span class="latex-build-entry">{{ name }}</span>
        <span v-if="build" class="latex-build-status" :class="`status-${build.status}`">{{ statusText }}</span>
      </div>
      <div class="latex-build-actions">
        <label class="latex-engine-select">
          <span>引擎</span>
          <select v-model="engine" :disabled="isActive || loading" aria-label="LaTeX 编译引擎">
            <option value="xelatex">XeLaTeX</option>
            <option value="pdflatex">pdfLaTeX</option>
            <option value="lualatex">LuaLaTeX</option>
          </select>
        </label>
        <button type="button" class="latex-build-button" :disabled="loading || isActive" @click="startBuild">
          {{ loading ? '启动中…' : build?.status === 'completed' ? '重新编译' : '开始编译' }}
        </button>
        <button v-if="isActive" type="button" class="latex-cancel-button" @click="cancelBuild">取消</button>
        <button
          v-if="build?.status === 'completed' && build.synctexAvailable"
          type="button"
          class="latex-sync-button"
          :disabled="syncLoading"
          title="将当前编辑器位置定位到 PDF"
          @click="locateCurrentSource"
        >
          {{ syncLoading ? '定位中…' : '定位当前行' }}
        </button>
        <button type="button" class="latex-close-button" title="返回编辑器" @click="emit('close')">返回编辑器</button>
      </div>
    </header>

    <div v-if="error" class="latex-build-error">{{ error }}</div>
    <div v-if="build?.error" class="latex-build-error">{{ build.error }}</div>
    <div v-if="syncError" class="latex-build-error">{{ syncError }}</div>

    <div v-if="build" class="latex-build-meta">
      <span v-if="build.durationMs !== undefined">耗时 {{ (build.durationMs / 1000).toFixed(1) }} 秒</span>
      <span>{{ build.pdfAvailable ? 'PDF 已生成' : '暂无 PDF' }}</span>
      <span>{{ build.synctexAvailable ? 'SyncTeX 已生成' : '暂无 SyncTeX' }}</span>
      <span v-if="pdfPage">已定位到第 {{ pdfPage }} 页</span>
      <span v-if="errors.length">{{ errors.length }} 个错误</span>
      <span v-if="warnings.length">{{ warnings.length }} 个警告</span>
    </div>

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

    <div v-if="pdfUrl" class="latex-pdf-preview">
      <PdfViewer
        ref="pdfViewer"
        :key="pdfDocumentId"
        :source-url="pdfUrl"
        :document-id="pdfDocumentId"
        :title="`${name} 编译结果`"
        :source-highlight="pdfHighlight"
        @back="emit('close')"
        @pdf-position="handlePdfPosition"
      />
    </div>
    <div v-else-if="isActive" class="latex-build-placeholder">正在等待 TeX Live 编译结果…</div>

    <details class="latex-build-log" :open="!!log && !pdfUrl">
      <summary>编译日志</summary>
      <pre>{{ log || '暂无日志' }}</pre>
    </details>
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
  gap: 12px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-bg-muted);
}

.latex-build-title,
.latex-build-actions,
.latex-build-meta,
.latex-engine-select {
  display: flex;
  align-items: center;
  gap: 8px;
}

.latex-build-title { min-width: 0; color: var(--color-text); }
.latex-build-entry { overflow: hidden; max-width: 260px; color: var(--color-text-secondary); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.latex-build-status { padding: 3px 8px; border-radius: 999px; font-size: 11px; }
.status-completed { color: var(--color-success); background: rgba(34, 197, 94, 0.12); }
.status-failed, .status-cancelled { color: var(--color-error); background: rgba(239, 68, 68, 0.12); }
.status-queued, .status-running { color: var(--color-warning); background: rgba(245, 158, 11, 0.14); }

.latex-build-actions { flex-shrink: 0; }
.latex-engine-select { color: var(--color-text-muted); font-size: 12px; }
.latex-engine-select select,
.latex-build-button,
.latex-cancel-button,
.latex-close-button {
  min-height: 30px;
  padding: 5px 10px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-bg);
  color: var(--color-text);
  font: inherit;
  cursor: pointer;
}
.latex-build-button { border-color: var(--color-primary); background: var(--color-primary); color: white; }
.latex-build-button:disabled { cursor: wait; opacity: 0.65; }
.latex-cancel-button { color: var(--color-error); }
.latex-sync-button { border-color: rgba(var(--color-primary-rgb), 0.35); color: var(--color-primary); }
.latex-sync-button:disabled { cursor: wait; opacity: 0.65; }
.latex-close-button { color: var(--color-text-secondary); }

.latex-build-error {
  margin: 10px 14px 0;
  padding: 8px 10px;
  border: 1px solid rgba(239, 68, 68, 0.28);
  border-radius: 8px;
  color: var(--color-error);
  background: rgba(239, 68, 68, 0.08);
  font-size: 12px;
}

.latex-build-meta {
  flex-wrap: wrap;
  padding: 8px 14px;
  color: var(--color-text-muted);
  font-size: 11px;
}

.latex-diagnostics {
  max-height: 150px;
  overflow: auto;
  padding: 0 14px 8px;
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
  flex: 0 0 auto;
  max-height: 220px;
  margin: 0 14px 14px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  overflow: hidden;
}
.latex-build-log summary { padding: 8px 10px; color: var(--color-text-secondary); background: var(--color-bg-muted); cursor: pointer; font-size: 12px; }
.latex-build-log pre { max-height: 170px; margin: 0; padding: 10px; overflow: auto; color: var(--color-text-secondary); font: 11px/1.55 'JetBrains Mono', monospace; white-space: pre-wrap; }

@media (max-width: 900px) {
  .latex-build-toolbar { align-items: flex-start; flex-direction: column; }
  .latex-build-actions { flex-wrap: wrap; }
}
</style>
