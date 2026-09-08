<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import type { Paper } from '@/stores/paper'
import { useChatStore } from '@/stores/chat'
import { useNoteStore, type Note } from '@/stores/note'
import { usePdfUrl } from '@/composables/useApi'
import { getOfflinePdf, putOfflinePdf } from '@/lib/offline-workspace-cache'
import { copyToClipboard } from '@/lib/clipboard'
import pdfiumWasmUrl from '@embedpdf/pdfium/pdfium.wasm?url'

import { usePdfiumEngine } from '@embedpdf/engines/vue'
import { EmbedPDF } from '@embedpdf/core/vue'
import { createPluginRegistration, type PluginRegistry } from '@embedpdf/core'

import { DocumentManagerPluginPackage, DocumentContent } from '@embedpdf/plugin-document-manager/vue'
import { ViewportPluginPackage, Viewport } from '@embedpdf/plugin-viewport/vue'
import { ScrollPluginPackage, Scroller, ScrollStrategy } from '@embedpdf/plugin-scroll/vue'
import { RenderLayer, RenderPluginPackage } from '@embedpdf/plugin-render/vue'
import { TilingLayer, TilingPluginPackage } from '@embedpdf/plugin-tiling/vue'
import { InteractionManagerPluginPackage, GlobalPointerProvider, PagePointerProvider } from '@embedpdf/plugin-interaction-manager/vue'
import { SelectionLayer, SelectionPluginPackage } from '@embedpdf/plugin-selection/vue'
import { ZoomPluginPackage, ZoomMode, ZoomGestureWrapper, MarqueeZoom } from '@embedpdf/plugin-zoom/vue'
import { PanPluginPackage } from '@embedpdf/plugin-pan/vue'
import { SearchPluginPackage, SearchLayer } from '@embedpdf/plugin-search/vue'
import { FullscreenPluginPackage } from '@embedpdf/plugin-fullscreen/vue'
import { ThumbnailPluginPackage, ThumbnailsPane, ThumbImg } from '@embedpdf/plugin-thumbnail/vue'
import { SpreadPluginPackage, SpreadMode } from '@embedpdf/plugin-spread/vue'

const props = defineProps<{
  paper?: Paper
  sourceUrl?: string
  documentId?: string
  title?: string
  sourceHighlight?: { page: number; x: number; y: number; width?: number; height?: number } | null
  showBackButton?: boolean
}>()

const emit = defineEmits<{
  (e: 'back'): void
  (e: 'showDetails'): void
  (e: 'pdf-position', position: { page: number; x: number; y: number }): void
}>()

// ── 状态 ─────────────────────────────────────────────────────────────────────

const chatStore = useChatStore()
const noteStore = useNoteStore()

const activeDocId = ref('')
const currentPage = ref(1)
const totalPages = ref(0)
const pendingGoToPage = ref<number | null>(null)
const pendingGoToPosition = ref<{ page: number; x: number; y: number } | null>(null)
const loadingDocument = ref(false)
const documentError = ref('')
const flashingNoteId = ref('')
const selectionMode = ref(false)
const activeHighlight = ref<{
  note: Note
  pageIndex: number
  x: number
  y: number
} | null>(null)

const zoomLevel = ref(1)
const showPreviewStrip = ref(true)
const viewerRootRef = ref<HTMLElement | null>(null)
const viewportWrapRef = ref<HTMLElement | null>(null)

const MIN_ZOOM = 0.35
const MAX_ZOOM = 5
const WHEEL_ZOOM_COMMIT_DELAY = 70
const WHEEL_ZOOM_MAX_PREVIEW_MS = 140
const BUTTON_ZOOM_COMMIT_DELAY = 45
const BUTTON_ZOOM_MAX_PREVIEW_MS = 90
const BUTTON_ZOOM_STEP = 1.1

let wheelZoomTimer: number | null = null
let wheelZoomInitialLevel = 1
let wheelZoomPreviewScale = 1
let wheelZoomCenter: { vx: number; vy: number } | null = null
let wheelZoomGestureRect: DOMRect | null = null
let wheelZoomViewportRect: DOMRect | null = null
let wheelZoomStartedAt = 0

const clampZoom = (zoom: number) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom))

const getWheelZoomDeltaPx = (event: WheelEvent) => {
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) return event.deltaY * 16
  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) return event.deltaY * window.innerHeight
  return event.deltaY
}

const getWheelZoomFactor = (event: WheelEvent) => {
  // Normalize mouse-wheel notches and high-resolution trackpad deltas to avoid
  // EmbedPDF's default 2x / 0.1x jumps on common deltaY≈100 wheel events.
  const factor = Math.exp(-getWheelZoomDeltaPx(event) * 0.0015)
  return Math.max(0.88, Math.min(1.14, factor))
}

const getZoomGestureElement = () => viewportWrapRef.value?.querySelector<HTMLElement>('.zoom-gesture') || null
const getViewportElement = () => viewportWrapRef.value?.querySelector<HTMLElement>('.pdf-viewport') || viewportWrapRef.value

const resetWheelZoomPreview = () => {
  const el = getZoomGestureElement()
  if (el) {
    el.style.transform = 'none'
    el.style.transformOrigin = '0 0'
    el.style.willChange = ''
  }
  wheelZoomPreviewScale = 1
  wheelZoomCenter = null
  wheelZoomGestureRect = null
  wheelZoomViewportRect = null
  wheelZoomStartedAt = 0
}

const commitWheelZoomPreview = () => {
  if (wheelZoomTimer !== null) {
    window.clearTimeout(wheelZoomTimer)
    wheelZoomTimer = null
  }

  const zoom = getDocZoom()
  const targetZoom = clampZoom(wheelZoomInitialLevel * wheelZoomPreviewScale)
  const delta = targetZoom - wheelZoomInitialLevel
  const center = wheelZoomCenter || undefined

  if (zoom && Math.abs(delta) > 0.001) {
    zoom.requestZoomBy?.(delta, center)
  }

  resetWheelZoomPreview()
}

const cleanupWheelZoomPreview = () => {
  if (wheelZoomTimer !== null) {
    window.clearTimeout(wheelZoomTimer)
    wheelZoomTimer = null
  }
  resetWheelZoomPreview()
}

const getWheelDeltaPx = (event: WheelEvent, delta: number) => {
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) return delta * 16
  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) return delta * window.innerHeight
  return delta
}

const handleHorizontalWheel = (event: WheelEvent) => {
  if (!event.shiftKey || event.ctrlKey || event.metaKey) return false

  // Viewport is rendered by EmbedPDF and receives its own wheel listeners. Use
  // the known root class instead of inferring overflow styles from its children.
  const target = event.target
  const viewport = target instanceof Element
    ? target.closest<HTMLElement>('.pdf-viewport')
    : null
  if (!viewport || viewport.scrollWidth <= viewport.clientWidth) return false

  // Browsers disagree on whether Shift + wheel is reported through deltaX or
  // deltaY. Trackpads can report both, with one being only a tiny incidental
  // movement. Use the dominant axis so those small values do not make the page
  // appear to stop before its right edge.
  const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY)
    ? event.deltaX
    : event.deltaY
  if (!delta) return false

  const maxScrollLeft = Math.max(0, viewport.scrollWidth - viewport.clientWidth)
  const nextScrollLeft = Math.max(
    0,
    Math.min(maxScrollLeft, viewport.scrollLeft + getWheelDeltaPx(event, delta)),
  )

  event.preventDefault()
  event.stopPropagation()
  viewport.scrollLeft = nextScrollLeft
  return true
}

const applyZoomPreview = (targetZoom: number, clientX: number, clientY: number) => {
  const zoom = getDocZoom()
  const gestureEl = getZoomGestureElement()
  const viewportEl = getViewportElement()
  if (!zoom || !gestureEl || !viewportEl) return false

  if (wheelZoomTimer === null) {
    wheelZoomInitialLevel = zoom.getState?.()?.currentZoomLevel || zoomLevel.value || 1
    wheelZoomPreviewScale = 1
    wheelZoomGestureRect = gestureEl.getBoundingClientRect()
    wheelZoomViewportRect = viewportEl.getBoundingClientRect()
    wheelZoomStartedAt = performance.now()
  } else {
    window.clearTimeout(wheelZoomTimer)
    wheelZoomTimer = null
  }

  const clampedTarget = clampZoom(targetZoom)
  wheelZoomPreviewScale = clampedTarget / wheelZoomInitialLevel
  zoomLevel.value = clampedTarget

  const gestureRect = wheelZoomGestureRect || gestureEl.getBoundingClientRect()
  const viewportRect = wheelZoomViewportRect || viewportEl.getBoundingClientRect()
  const originX = clientX - gestureRect.left
  const originY = clientY - gestureRect.top

  wheelZoomCenter = {
    vx: clientX - viewportRect.left,
    vy: clientY - viewportRect.top,
  }

  gestureEl.style.willChange = 'transform'
  gestureEl.style.transformOrigin = `${originX}px ${originY}px`
  gestureEl.style.transform = `scale(${wheelZoomPreviewScale})`
  return true
}

const scheduleZoomPreviewCommit = (delay: number, maxPreviewMs: number) => {
  if (performance.now() - wheelZoomStartedAt >= maxPreviewMs) {
    commitWheelZoomPreview()
  } else {
    wheelZoomTimer = window.setTimeout(commitWheelZoomPreview, delay)
  }
}

const handlePreviewWheelZoom = (e: WheelEvent) => {
  if (!e.ctrlKey && !e.metaKey) return false

  e.preventDefault()
  e.stopPropagation()
  ;(e as any).stopImmediatePropagation?.()

  const currentTarget = wheelZoomTimer === null
    ? (getDocZoom()?.getState?.()?.currentZoomLevel || zoomLevel.value || 1)
    : wheelZoomInitialLevel * wheelZoomPreviewScale
  const targetZoom = currentTarget * getWheelZoomFactor(e)
  if (applyZoomPreview(targetZoom, e.clientX, e.clientY)) {
    scheduleZoomPreviewCommit(WHEEL_ZOOM_COMMIT_DELAY, WHEEL_ZOOM_MAX_PREVIEW_MS)
  }
  return true
}

const handleWheelZoom = (e: WheelEvent) => {
  if (handleHorizontalWheel(e)) return
  handlePreviewWheelZoom(e)
}

// Cleanup function for wheel listener
let wheelListenerCleanup: (() => void) | null = null

const cleanupWheelListener = () => {
  if (wheelListenerCleanup) {
    wheelListenerCleanup()
    wheelListenerCleanup = null
  }
}

// Setup wheel zoom when viewport is ready
watch(viewportWrapRef, (viewportWrap, oldViewportWrap) => {
  // Remove old listener
  if (oldViewportWrap) {
    oldViewportWrap.removeEventListener('wheel', handleWheelZoom, true)
  }
  
  cleanupWheelListener()
  
  if (viewportWrap) {
    // Capture before EmbedPDF's internal wheel handlers so Shift + wheel can
    // always be converted to horizontal viewport scrolling.
    viewportWrap.addEventListener('wheel', handleWheelZoom, { capture: true, passive: false })

    wheelListenerCleanup = () => {
      viewportWrap.removeEventListener('wheel', handleWheelZoom, true)
    }
  }
})

const highlightColors = [
  { name: '黄', value: 'yellow', background: 'rgba(250, 204, 21, 0.24)', border: 'rgba(250, 204, 21, 0.55)' },
  { name: '蓝', value: 'blue', background: 'rgba(59, 130, 246, 0.16)', border: 'rgba(59, 130, 246, 0.45)' },
  { name: '绿', value: 'green', background: 'rgba(34, 197, 94, 0.18)', border: 'rgba(34, 197, 94, 0.5)' },
  { name: '粉', value: 'pink', background: 'rgba(236, 72, 153, 0.16)', border: 'rgba(236, 72, 153, 0.45)' },
] as const

const isTemporaryDocument = computed(() => !!props.sourceUrl)
const canAnnotate = computed(() => !!props.paper?.id && !isTemporaryDocument.value)
const canAskAI = computed(() => !!props.paper?.id || isTemporaryDocument.value)
const documentTitle = computed(() => props.title || props.paper?.title || '临时 PDF')
const showBackButton = computed(() => props.showBackButton !== false)
const pdfSourceUrl = computed(() => props.sourceUrl || (props.paper?.id ? usePdfUrl(props.paper.id) : ''))
const cachedPdfUrl = ref('')
const pdfOfflineCopy = ref(false)
let cachedPdfObjectUrl = ''
let pdfCacheSequence = 0

const releaseCachedPdfUrl = () => {
  if (cachedPdfObjectUrl) URL.revokeObjectURL(cachedPdfObjectUrl)
  cachedPdfObjectUrl = ''
  cachedPdfUrl.value = ''
}

const activateCachedPdf = async () => {
  const sourceUrl = pdfSourceUrl.value
  if (!sourceUrl || cachedPdfUrl.value) return !!cachedPdfUrl.value
  const snapshot = await getOfflinePdf(sourceUrl)
  if (!snapshot?.blob.size || sourceUrl !== pdfSourceUrl.value) return false
  cachedPdfObjectUrl = URL.createObjectURL(snapshot.blob)
  cachedPdfUrl.value = cachedPdfObjectUrl
  pdfOfflineCopy.value = true
  return true
}

const cachePdfInBrowser = async (sourceUrl: string) => {
  try {
    const existing = await getOfflinePdf(sourceUrl)
    if (existing?.blob.size) return
    const response = await fetch(sourceUrl, { credentials: 'include' })
    if (!response.ok) return
    const blob = await response.blob()
    if (blob.size) await putOfflinePdf(sourceUrl, blob)
  } catch {
    // The visible reader keeps its own request. A failed background cache must
    // not interrupt it when the EasyTier route is temporarily unavailable.
  }
}

const preparePdfCache = async () => {
  const sourceUrl = pdfSourceUrl.value
  const sequence = ++pdfCacheSequence
  releaseCachedPdfUrl()
  pdfOfflineCopy.value = false
  if (!sourceUrl) return

  const snapshot = await getOfflinePdf(sourceUrl)
  if (sequence !== pdfCacheSequence) return
  if (navigator.onLine === false) {
    if (snapshot?.blob.size) await activateCachedPdf()
    return
  }
  if (!snapshot?.blob.size) void cachePdfInBrowser(sourceUrl)
}

const pdfUrl = computed(() => cachedPdfUrl.value || pdfSourceUrl.value)
const currentDocumentId = computed(() => props.documentId || (props.paper?.id ? `paper-${props.paper.id}` : ''))

const handlePdfOffline = () => { void activateCachedPdf() }
const handlePdfOnline = () => {
  if (!pdfOfflineCopy.value) return
  releaseCachedPdfUrl()
  pdfOfflineCopy.value = false
}

watch(pdfSourceUrl, () => { void preparePdfCache() }, { immediate: true })

const isTouchDevice = typeof window !== 'undefined'
  && (window.matchMedia('(pointer: coarse)').matches || window.innerWidth < 768)

// Use the bundled local PDFium WASM instead of the EmbedPDF CDN default.
// Use direct mode for both desktop and mobile: desktop Chrome can fetch the PDF
// and worker bundle successfully while the worker document task still remains
// pending, which leaves the UI stuck at "加载 PDF…". Direct mode removes that
// worker-communication failure point and keeps EmbedPDF as the renderer.
const { engine, isLoading, error: engineError } = usePdfiumEngine({
  wasmUrl: pdfiumWasmUrl,
  worker: false,
  fontFallback: null,
})

type Unsubscribe = () => void

// PDFium's direct engine needs a complete byte source for temporary remote
// documents. The proxy still supports ranges for future consumers; a separate
// background fetch persists a full blob for offline fallback when no Service
// Worker is available (such as direct HTTP/EasyTier access).
const documentLoadMode = computed(() => (isTouchDevice || isTemporaryDocument.value) ? 'full-fetch' as const : 'auto' as const)
const embedPdfKey = computed(() => `${currentDocumentId.value || 'no-document'}:${pdfUrl.value}`)

const plugins = computed(() => {
  const url = pdfUrl.value
  const documentId = currentDocumentId.value

  return [
    createPluginRegistration(DocumentManagerPluginPackage, {
      maxDocuments: 1,
      // Let EmbedPDF open the selected paper as part of plugin initialization.
      // This is more reliable on mobile than waiting for the scoped slot state
      // and then opening the document from outside.
      initialDocuments: url && documentId ? [{
        url,
        documentId,
        autoActivate: true,
        mode: documentLoadMode.value,
        requestOptions: { credentials: 'include' as RequestCredentials },
      }] : [],
    }),
    createPluginRegistration(ViewportPluginPackage, { viewportGap: 10 }),
    createPluginRegistration(ScrollPluginPackage, { defaultStrategy: ScrollStrategy.Vertical, defaultPageGap: 12 }),
    createPluginRegistration(RenderPluginPackage),
    createPluginRegistration(TilingPluginPackage, { tileSize: 768, overlapPx: 2.5, extraRings: 0 }),
    createPluginRegistration(InteractionManagerPluginPackage),
    createPluginRegistration(ZoomPluginPackage, {
      defaultZoomLevel: ZoomMode.FitWidth,
      minZoom: 0.35,
      maxZoom: 5,
      zoomStep: 1.1,
    }),
    createPluginRegistration(PanPluginPackage),
    createPluginRegistration(SpreadPluginPackage, { defaultSpreadMode: SpreadMode.None }),
    createPluginRegistration(SelectionPluginPackage, { toleranceFactor: 0.8, minSelectionDragDistance: 2 }),
    createPluginRegistration(SearchPluginPackage),
    createPluginRegistration(FullscreenPluginPackage),
    createPluginRegistration(ThumbnailPluginPackage, {
      width: 112,
      gap: 10,
      labelHeight: 18,
      imagePadding: 3,
    }),
  ]
})

// ── EmbedPDF registry / document lifecycle ─────────────────────────────────

let registryRef: PluginRegistry | null = null
let zoomUnsub: Unsubscribe | null = null
let scrollUnsub: Unsubscribe | null = null
let layoutUnsub: Unsubscribe | null = null
let documentUnsubs: Unsubscribe[] = []
let pendingOpenTimer: number | null = null
let openSequence = 0

const getPluginProvides = (id: string): any => registryRef?.getPlugin(id)?.provides?.()
const getDocumentManager = () => getPluginProvides('document-manager')
const getDocZoom = () => activeDocId.value ? getPluginProvides('zoom')?.forDocument?.(activeDocId.value) : null
const getDocScroll = () => activeDocId.value ? getPluginProvides('scroll')?.forDocument?.(activeDocId.value) : null
const getSelectionScope = () => activeDocId.value ? getPluginProvides('selection')?.forDocument?.(activeDocId.value) : null
const getSelectionCapability = () => getPluginProvides('selection')
const getDocPan = () => activeDocId.value ? getPluginProvides('pan')?.forDocument?.(activeDocId.value) : null
const getInteractionScope = () => activeDocId.value ? getPluginProvides('interaction-manager')?.forDocument?.(activeDocId.value) : null

const cleanupZoomListener = () => {
  zoomUnsub?.()
  zoomUnsub = null
}

const cleanupScrollListener = () => {
  scrollUnsub?.()
  layoutUnsub?.()
  scrollUnsub = null
  layoutUnsub = null
}

const setupZoomListener = () => {
  cleanupZoomListener()
  
  // Ensure we have an active document
  if (!activeDocId.value) return
  
  const docZoom = getDocZoom()
  if (!docZoom) {
    // Retry after a short delay if zoom provider is not ready yet
    setTimeout(() => {
      if (activeDocId.value) setupZoomListener()
    }, 100)
    return
  }

  // Get initial state and update immediately
  try {
    const state = docZoom.getState?.()
    if (state?.currentZoomLevel !== undefined) {
      zoomLevel.value = state.currentZoomLevel
    }
  } catch (err) {
    console.warn('[YARC] Failed to get initial zoom state:', err)
  }

  // Subscribe to future changes
  try {
    zoomUnsub = docZoom.onStateChange?.((newState: any) => {
      if (newState?.currentZoomLevel !== undefined) {
        zoomLevel.value = newState.currentZoomLevel
      }
    }) || null
  } catch (err) {
    console.warn('[YARC] Failed to subscribe to zoom changes:', err)
  }
}

const updateScrollState = () => {
  const docScroll = getDocScroll()
  if (!docScroll) return
  currentPage.value = docScroll.getCurrentPage?.() || currentPage.value || 1
  totalPages.value = docScroll.getTotalPages?.() || totalPages.value || 0
}

const setupScrollListener = () => {
  cleanupScrollListener()
  const docScroll = getDocScroll()
  const scrollCapability = getPluginProvides('scroll')
  if (!docScroll) return

  updateScrollState()
  scrollUnsub = docScroll.onPageChange?.((event: any) => {
    currentPage.value = event.pageNumber
    totalPages.value = event.totalPages
  }) || null

  layoutUnsub = scrollCapability?.onLayoutReady?.((event: any) => {
    if (event.documentId !== activeDocId.value) return
    currentPage.value = event.pageNumber
    totalPages.value = event.totalPages
  }) || null
}

const syncDocumentStateFromManager = () => {
  const docManager = getDocumentManager()
  if (!docManager) return

  const expectedId = currentDocumentId.value
  const activeId = docManager.getActiveDocumentId?.()
  const openIds: string[] = docManager.getDocumentOrder?.() || []
  const documentId = activeId || (expectedId && openIds.includes(expectedId) ? expectedId : openIds[0])
  if (!documentId) return

  activeDocId.value = documentId
  const state = docManager.getDocumentState?.(documentId)
  loadingDocument.value = state?.status === 'loading'
  documentError.value = state?.status === 'error' ? (state.error || 'PDF 加载失败') : ''

  if (activeId !== documentId) {
    try { docManager.setActiveDocument?.(documentId) } catch {}
  }

  setupZoomListener()
  setupScrollListener()
  applySelectionMode()
}

const bindDocumentEvents = () => {
  documentUnsubs.forEach((unsub) => unsub())
  documentUnsubs = []

  const docManager = getDocumentManager()
  if (!docManager) return

  const opened = docManager.onDocumentOpened?.((state: any) => {
    if (state.id !== activeDocId.value) return
    loadingDocument.value = false
    documentError.value = ''
    setupZoomListener()
    setupScrollListener()
    applySelectionMode()
  })

  const errored = docManager.onDocumentError?.((event: any) => {
    if (event.documentId !== activeDocId.value) return
    loadingDocument.value = false
    documentError.value = event.message || 'PDF 加载失败'
    // EasyTier connections can fail while the browser itself still reports
    // online. Fall back to a full PDF blob cached by the page in that case.
    void activateCachedPdf()
  })

  const activeChanged = docManager.onActiveDocumentChanged?.((event: any) => {
    if (!event.currentDocumentId) return
    activeDocId.value = event.currentDocumentId
    setupZoomListener()
    setupScrollListener()
    applySelectionMode()
  })

  for (const unsub of [opened, errored, activeChanged]) {
    if (typeof unsub === 'function') documentUnsubs.push(unsub)
  }
}

const clearPendingOpen = () => {
  if (pendingOpenTimer !== null) {
    window.clearTimeout(pendingOpenTimer)
    pendingOpenTimer = null
  }
}

const openDoc = async (url: string): Promise<boolean> => {
  const documentId = currentDocumentId.value
  if (!url || !documentId) return false

  activeDocId.value = documentId
  loadingDocument.value = true
  documentError.value = ''

  const docManager = getDocumentManager()
  if (!docManager?.openDocumentUrl) return false

  currentPage.value = 1
  totalPages.value = 0
  cleanupZoomListener()
  cleanupScrollListener()

  try {
    const openIds: string[] = docManager.getDocumentOrder?.() || []
    for (const id of openIds) {
      if (id !== documentId) docManager.closeDocument?.(id)
    }

    if (docManager.isDocumentOpen?.(documentId)) {
      docManager.setActiveDocument?.(documentId)
      const state = docManager.getDocumentState?.(documentId)
      loadingDocument.value = state?.status === 'loading'
      documentError.value = state?.status === 'error' ? (state.error || 'PDF 加载失败') : ''
      setupZoomListener()
      setupScrollListener()
      applySelectionMode()
      return true
    }

    const task = docManager.openDocumentUrl({
      url,
      documentId,
      autoActivate: true,
      mode: documentLoadMode.value,
      requestOptions: { credentials: 'include' },
    })

    task?.wait?.(
      (result: any) => {
        if (currentDocumentId.value !== documentId) return
        const openedId = result?.documentId || documentId
        activeDocId.value = openedId
        docManager.setActiveDocument?.(openedId)
        loadingDocument.value = false
        documentError.value = ''
        setupZoomListener()
        setupScrollListener()
        applySelectionMode()
      },
      (error: any) => {
        if (currentDocumentId.value !== documentId) return
        loadingDocument.value = false
        documentError.value = error?.reason?.message || error?.message || 'PDF 加载失败'
      }
    )

    return true
  } catch (err) {
    loadingDocument.value = false
    documentError.value = (err as Error).message || 'PDF 加载失败'
    return true
  }
}

const scheduleOpenCurrentDoc = (delay = 0) => {
  clearPendingOpen()
  const sequence = ++openSequence

  const run = async (attempt = 0) => {
    if (sequence !== openSequence) return

    const url = pdfUrl.value
    const documentId = currentDocumentId.value
    if (!url || !documentId) {
      loadingDocument.value = false
      return
    }

    activeDocId.value = documentId
    loadingDocument.value = true
    documentError.value = ''

    const opened = await openDoc(url)
    if (opened || sequence !== openSequence) return

    if (attempt < 30) {
      const retryDelay = Math.min(1000, 80 + attempt * 80)
      pendingOpenTimer = window.setTimeout(() => run(attempt + 1), retryDelay)
    } else {
      loadingDocument.value = false
      documentError.value = 'PDF 插件未完成初始化，请刷新页面重试'
    }
  }

  pendingOpenTimer = window.setTimeout(() => run(), delay)
}

const onInitialized = async (registry: PluginRegistry) => {
  registryRef = registry
  bindDocumentEvents()
  syncDocumentStateFromManager()
  if (pdfUrl.value) scheduleOpenCurrentDoc(120)
}

watch([pdfUrl, currentDocumentId], ([url, documentId]) => {
  openSequence++
  clearPendingOpen()
  clearActiveHighlight()
  cleanupZoomListener()
  cleanupScrollListener()
  cleanupWheelZoomPreview()
  documentUnsubs.forEach((unsub) => unsub())
  documentUnsubs = []
  registryRef = null
  activeDocId.value = documentId || ''
  currentPage.value = 1
  totalPages.value = 0
  documentError.value = ''
  loadingDocument.value = !!url

  // The EmbedPDF component is keyed by documentId and will remount for a new
  // paper. Keeping PdfViewer mounted while the list is shown preserves the
  // current document for back-and-reopen without reloading it.
})

onBeforeUnmount(() => {
  openSequence++
  clearPendingOpen()
  cleanupZoomListener()
  cleanupScrollListener()
  cleanupWheelZoomPreview()
  cleanupWheelListener()
  documentUnsubs.forEach((unsub) => unsub())
  document.removeEventListener('keydown', handlePdfCopyKeydown, true)
  window.removeEventListener('offline', handlePdfOffline)
  window.removeEventListener('online', handlePdfOnline)
  releaseCachedPdfUrl()
  pdfContentEl.value?.removeEventListener('scroll', onPdfScroll, true)
})

// Toolbar slides away as you read forward (scroll down) and returns the moment
// you scroll back up. EmbedPDF scrolls an inner element; a capture-phase listener
// catches it from the ancestor (scroll doesn't bubble, but capture still reaches it).
const pdfContentEl = ref<HTMLElement | null>(null)
const toolbarHidden = ref(false)
let lastPdfScrollTop = 0
const onPdfScroll = (e: Event) => {
  const el = e.target as HTMLElement | null
  if (!el || typeof el.scrollTop !== 'number') return
  const st = el.scrollTop
  if (st < 40) toolbarHidden.value = false
  else if (st > lastPdfScrollTop + 8) toolbarHidden.value = true
  else if (st < lastPdfScrollTop - 8) toolbarHidden.value = false
  lastPdfScrollTop = st
}

const isEditableCopyTarget = (target: EventTarget | null) => {
  const el = target as HTMLElement | null
  return !!el?.closest?.('input, textarea, select, [contenteditable="true"]')
}

const hasPdfSelection = () => {
  try {
    return (getSelectionScope()?.getFormattedSelection?.() || []).length > 0
  } catch {
    return false
  }
}

const handlePdfCopyKeydown = (event: KeyboardEvent) => {
  if (event.key.toLowerCase() !== 'c' || (!event.ctrlKey && !event.metaKey) || event.altKey) return
  if (!viewerRootRef.value || viewerRootRef.value.offsetParent === null) return
  if (isEditableCopyTarget(event.target) || !hasPdfSelection()) return

  event.preventDefault()
  event.stopPropagation()
  void copyText().catch((err) => console.error('[YARC] PDF copy failed', err))
}

onMounted(() => {
  document.addEventListener('keydown', handlePdfCopyKeydown, true)
  window.addEventListener('offline', handlePdfOffline)
  window.addEventListener('online', handlePdfOnline)
  pdfContentEl.value?.addEventListener('scroll', onPdfScroll, { capture: true, passive: true })
})

// ── 翻页与缩放 ────────────────────────────────────────────────────────────────

const goToPage = (page: number) => {
  if (!Number.isFinite(page)) return
  const requested = Math.max(1, Math.round(page))
  if (!totalPages.value) {
    pendingGoToPage.value = requested
    return
  }
  const target = Math.min(totalPages.value, requested)
  pendingGoToPage.value = null
  pendingGoToPosition.value = null
  currentPage.value = target
  getDocScroll()?.scrollToPage?.({ pageNumber: target, behavior: 'smooth', alignY: 0 })
}

const goToPosition = (page: number, x: number, y: number) => {
  if (!Number.isFinite(page) || !Number.isFinite(x) || !Number.isFinite(y)) return
  const requested = Math.max(1, Math.round(page))
  const position = { page: requested, x, y }
  if (!totalPages.value) {
    pendingGoToPosition.value = position
    return
  }
  const target = Math.min(totalPages.value, requested)
  pendingGoToPage.value = null
  pendingGoToPosition.value = null
  currentPage.value = target
  getDocScroll()?.scrollToPage?.({
    pageNumber: target,
    pageCoordinates: { x, y },
    behavior: 'smooth',
    alignX: 50,
    alignY: 50,
  })
}

watch(totalPages, (pages) => {
  if (pages <= 0) return
  if (pendingGoToPosition.value) {
    const position = pendingGoToPosition.value
    goToPosition(position.page, position.x, position.y)
  } else if (pendingGoToPage.value) {
    goToPage(pendingGoToPage.value)
  }
})

const previewToolbarZoom = (factor: number) => {
  const zoom = getDocZoom()
  if (!zoom) return

  const currentTarget = wheelZoomTimer === null
    ? (zoom.getState?.()?.currentZoomLevel || zoomLevel.value || 1)
    : wheelZoomInitialLevel * wheelZoomPreviewScale
  const targetZoom = clampZoom(currentTarget * factor)
  const viewportRect = getViewportElement()?.getBoundingClientRect()

  if (!viewportRect || !applyZoomPreview(
    targetZoom,
    viewportRect.left + viewportRect.width / 2,
    viewportRect.top + viewportRect.height / 2,
  )) {
    zoom.requestZoom?.(targetZoom)
    return
  }

  scheduleZoomPreviewCommit(BUTTON_ZOOM_COMMIT_DELAY, BUTTON_ZOOM_MAX_PREVIEW_MS)
}

const zoomIn = () => previewToolbarZoom(BUTTON_ZOOM_STEP)
const zoomOut = () => previewToolbarZoom(1 / BUTTON_ZOOM_STEP)
const fitWidth = () => {
  cleanupWheelZoomPreview()
  getDocZoom()?.requestZoom?.(ZoomMode.FitWidth)
}
const fitPage = () => {
  cleanupWheelZoomPreview()
  getDocZoom()?.requestZoom?.(ZoomMode.FitPage)
}

const applySelectionMode = () => {
  const documentId = activeDocId.value
  if (!documentId) return

  const selection = getSelectionCapability()
  // Enable text selection for both the default pointer mode and pan mode.
  // Phones often stay in pan mode for scrolling; explicitly enabling both avoids
  // a silent no-op when the active interaction mode differs between browsers.
  selection?.enableForMode?.('pointerMode', { enableSelection: true, showSelectionRects: true, enableMarquee: false }, documentId)
  selection?.enableForMode?.('panMode', { enableSelection: true, showSelectionRects: true, enableMarquee: false }, documentId)

  if (selectionMode.value) {
    getDocPan()?.disablePan?.()
    getInteractionScope()?.activateDefaultMode?.()
  } else {
    clearSelection()
    // Keep desktop in the default pointer mode so normal mouse text selection
    // works without first toggling a tool. Touch devices still use pan mode for
    // reliable one-finger document scrolling.
    if (isTouchDevice) getDocPan()?.enablePan?.()
    else getDocPan()?.disablePan?.()
  }
}

const toggleSelectionMode = () => {
  selectionMode.value = !selectionMode.value
  applySelectionMode()
}

watch(selectionMode, () => applySelectionMode())

// ── 划词菜单动作 ──────────────────────────────────────────────────────────────

const clearSelection = () => getSelectionScope()?.clear?.()

const clearActiveHighlight = () => {
  activeHighlight.value = null
}

type EmbedPdfSelectionRect = {
  origin: { x: number; y: number }
  size: { width: number; height: number }
}

type EmbedPdfSelectionInfo = {
  text: string
  pageNumber: number
  highlightRect: {
    source: 'embedpdf'
    selections: Array<{
      pageIndex: number
      rect: EmbedPdfSelectionRect
      segmentRects: EmbedPdfSelectionRect[]
    }>
  }
}

const getSelectedInfo = async (): Promise<EmbedPdfSelectionInfo | null> => {
  const scope = getSelectionScope()
  if (!scope) return null

  const formatted = scope.getFormattedSelection?.() || []
  const first = formatted[0]

  let text = ''
  try {
    const task = scope.getSelectedText?.()
    const lines = await task?.toPromise?.()
    text = Array.isArray(lines) ? lines.join('\n').trim() : ''
  } catch {
    text = ''
  }

  if (!text || !first) return null

  return {
    text,
    pageNumber: first.pageIndex + 1,
    highlightRect: {
      source: 'embedpdf',
      selections: formatted.map((item: any) => ({
        pageIndex: item.pageIndex,
        rect: item.rect,
        segmentRects: item.segmentRects || [item.rect],
      })),
    },
  }
}

type SelectionTextLineLayout = {
  pageIndex: number
  x: number
  y: number
  width: number
  height: number
}

const medianNumber = (values: number[], fallback = 0) => {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b)
  if (!sorted.length) return fallback
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

const getSelectionLineLayouts = (selections: EmbedPdfSelectionInfo['highlightRect']['selections']) => {
  const lines: SelectionTextLineLayout[] = []

  for (const selection of selections) {
    for (const rect of selection.segmentRects?.length ? selection.segmentRects : [selection.rect]) {
      const x = Number(rect.origin?.x || 0)
      const y = Number(rect.origin?.y || 0)
      const width = Number(rect.size?.width || 0)
      const height = Number(rect.size?.height || 0)
      const previous = lines[lines.length - 1]
      const sameVisualLine = previous && previous.pageIndex === selection.pageIndex && Math.abs(previous.y - y) <= Math.max(2, previous.height * 0.45, height * 0.45)

      if (sameVisualLine) {
        const left = Math.min(previous.x, x)
        const top = Math.min(previous.y, y)
        const right = Math.max(previous.x + previous.width, x + width)
        const bottom = Math.max(previous.y + previous.height, y + height)
        previous.x = left
        previous.y = top
        previous.width = right - left
        previous.height = bottom - top
      } else {
        lines.push({ pageIndex: selection.pageIndex, x, y, width, height })
      }
    }
  }

  return lines
}

const shouldPreserveParagraphBreak = (
  previousLine: string,
  currentLine: string,
  previousLayout: SelectionTextLineLayout | undefined,
  currentLayout: SelectionTextLineLayout | undefined,
  layouts: SelectionTextLineLayout[],
) => {
  if (!previousLine.trim() || !currentLine.trim()) return true
  if (!previousLayout || !currentLayout) return false
  if (previousLayout.pageIndex !== currentLayout.pageIndex) return true

  const medianHeight = medianNumber(layouts.map((item) => item.height), Math.max(previousLayout.height, currentLayout.height, 1))
  const gaps = layouts.slice(1).map((item, index) => {
    const before = layouts[index]
    if (before.pageIndex !== item.pageIndex) return 0
    return Math.max(0, Math.abs(item.y - before.y) - Math.max(item.height, before.height))
  })
  const medianGap = medianNumber(gaps.filter((gap) => gap > 0), medianHeight * 0.25)
  const verticalGap = Math.max(0, Math.abs(currentLayout.y - previousLayout.y) - Math.max(currentLayout.height, previousLayout.height))
  if (verticalGap > Math.max(medianHeight * 0.7, medianGap * 1.8)) return true

  const leftEdge = Math.min(...layouts.map((item) => item.x))
  const indentThreshold = Math.max(medianHeight * 0.8, 6)
  const previousIndent = previousLayout.x - leftEdge
  const currentIndent = currentLayout.x - leftEdge

  return currentIndent > indentThreshold && currentIndent - previousIndent > indentThreshold * 0.5
}

const mergeCopiedTextLines = (previous: string, current: string) => {
  if (/[A-Za-z][\-‐‑‒–—]$/.test(previous) && /^[a-z]/.test(current)) {
    return previous.replace(/[\-‐‑‒–—]$/, '') + current
  }
  return `${previous} ${current}`
}

const normalizePdfCopiedText = (info: EmbedPdfSelectionInfo) => {
  const lines = info.text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())

  if (lines.length <= 1) return info.text.trim()

  const layouts = getSelectionLineLayouts(info.highlightRect.selections)
  const output: string[] = []
  let currentParagraph = ''

  lines.forEach((line, index) => {
    if (!line) {
      if (currentParagraph) {
        output.push(currentParagraph)
        currentParagraph = ''
      }
      return
    }

    if (!currentParagraph) {
      currentParagraph = line
      return
    }

    const paragraphBreak = shouldPreserveParagraphBreak(
      lines[index - 1] || '',
      line,
      layouts[index - 1],
      layouts[index],
      layouts,
    )

    if (paragraphBreak) {
      output.push(currentParagraph)
      currentParagraph = line
    } else {
      currentParagraph = mergeCopiedTextLines(currentParagraph, line)
    }
  })

  if (currentParagraph) output.push(currentParagraph)
  return output.join('\n').trim()
}

const askAI = async () => {
  const info = await getSelectedInfo()
  if (!info || !canAskAI.value) return
  const normalizedText = normalizePdfCopiedText(info)
  chatStore.pdfContext = isTemporaryDocument.value
    ? {
        temporaryPdf: true,
        documentTitle: documentTitle.value,
        pageNumber: info.pageNumber,
        selectedText: normalizedText,
      }
    : {
        paperId: props.paper!.id,
        pageNumber: info.pageNumber,
        selectedText: normalizedText,
      }
  window.dispatchEvent(new CustomEvent('yarc-open-chat'))
  clearSelection()
}

const addNote = async () => {
  const info = await getSelectedInfo()
  if (!info || !canAnnotate.value || !props.paper?.id) return
  const normalizedText = normalizePdfCopiedText(info)
  await noteStore.createNote({
    paperId: props.paper.id,
    content: normalizedText,
    pageNumber: info.pageNumber,
    highlightText: normalizedText,
    highlightRect: info.highlightRect,
    kind: 'note',
  })
  clearSelection()
}

const addHighlight = async () => {
  const info = await getSelectedInfo()
  if (!info || !canAnnotate.value || !props.paper?.id) return
  await noteStore.createNote({
    paperId: props.paper.id,
    content: '',
    pageNumber: info.pageNumber,
    highlightText: info.text,
    highlightRect: info.highlightRect,
    kind: 'highlight',
  })
  clearSelection()
}

const copyText = async () => {
  const info = await getSelectedInfo()
  if (!info) return
  await copyToClipboard(normalizePdfCopiedText(info))
  clearSelection()
}

type SelectionMenuAction = 'ask' | 'note' | 'highlight' | 'copy'
let lastMenuActionAt = 0

const swallowMenuEvent = (event: Event) => {
  event.preventDefault()
  event.stopPropagation()
  ;(event as any).stopImmediatePropagation?.()
}

const runSelectionMenuAction = (action: SelectionMenuAction, event: Event) => {
  swallowMenuEvent(event)

  // Touch browsers usually emit touchend/pointerup and then a synthetic click.
  // Run the action on the earliest event, then drop the follow-up duplicate.
  const now = performance.now()
  if (now - lastMenuActionAt < 350) return
  lastMenuActionAt = now

  const actions: Record<SelectionMenuAction, () => Promise<void>> = {
    ask: askAI,
    note: addNote,
    highlight: addHighlight,
    copy: copyText,
  }

  void actions[action]().catch((err) => {
    console.error('[YARC] selection menu action failed', err)
  })
}

// Mobile browsers do not reliably synthesize PDF text selection from a native
// long-press inside canvas/WASM render layers. EmbedPDF already supports
// double-click word selection, so on touch devices a steady long-press dispatches
// a synthetic dblclick to the page pointer provider. Dragging still scrolls/pans
// because the timer is cancelled once the finger moves beyond a small threshold.
let longPressTimer: number | null = null
let longPressStart: { x: number; y: number; target: HTMLElement } | null = null

type LongPressSourceEvent = PointerEvent | TouchEvent

const clearLongPressTimer = () => {
  if (longPressTimer !== null) {
    window.clearTimeout(longPressTimer)
    longPressTimer = null
  }
  longPressStart = null
}

const getLongPressPoint = (event: LongPressSourceEvent) => {
  const target = event.currentTarget as HTMLElement | null
  if (!target) return null

  if ('pointerType' in event) {
    if (event.pointerType === 'mouse') return null
    return { x: event.clientX, y: event.clientY, target }
  }

  const touch = event.touches[0] || event.changedTouches[0]
  if (!touch) return null
  return { x: touch.clientX, y: touch.clientY, target }
}

const dispatchSyntheticDoubleClick = (target: HTMLElement, x: number, y: number) => {
  const hit = document.elementFromPoint(x, y) as HTMLElement | null
  const targets = [hit, target].filter((item, index, arr): item is HTMLElement => !!item && arr.indexOf(item) === index)

  for (const item of targets) {
    for (const type of ['mousedown', 'mouseup', 'click', 'dblclick']) {
      item.dispatchEvent(new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        view: window,
      }))
    }
  }
}

const beginLongPressSelection = (event: LongPressSourceEvent) => {
  if (!isTouchDevice) return
  const point = getLongPressPoint(event)
  if (!point) return

  clearLongPressTimer()
  longPressStart = point
  longPressTimer = window.setTimeout(() => {
    if (!longPressStart) return
    const { x, y, target } = longPressStart
    longPressTimer = null
    longPressStart = null
    dispatchSyntheticDoubleClick(target, x, y)
    navigator.vibrate?.(12)
  }, 520)
}

const moveLongPressSelection = (event: LongPressSourceEvent) => {
  if (!longPressStart) return
  const point = getLongPressPoint(event)
  if (!point) return
  const dx = point.x - longPressStart.x
  const dy = point.y - longPressStart.y
  if (Math.sqrt(dx * dx + dy * dy) > 12) clearLongPressTimer()
}

// ── 笔记高亮回显 ──────────────────────────────────────────────────────────────

const getNoteRectsForPage = (note: Note, pageIndex: number): EmbedPdfSelectionRect[] => {
  const data = note.highlightRect as any
  if (!data) return []

  if (data.source === 'embedpdf' && Array.isArray(data.selections)) {
    return data.selections
      .filter((item: any) => item.pageIndex === pageIndex)
      .flatMap((item: any) => item.segmentRects || [item.rect])
      .filter(Boolean)
  }

  // 兼容旧版 PdfViewer.vue 保存的 {x,y,w,h,page} / {x,y,width,height,page} 结构。
  const pageNumber = pageIndex + 1
  const storedPage = data.page ?? data.pageNumber ?? note.pageNumber
  if (storedPage && storedPage !== pageNumber) return []

  const x = data.x ?? data.left ?? data.origin?.x
  const y = data.y ?? data.top ?? data.origin?.y
  const width = data.w ?? data.width ?? data.size?.width
  const height = data.h ?? data.height ?? data.size?.height
  if (![x, y, width, height].every((v) => typeof v === 'number')) return []

  return [{ origin: { x, y }, size: { width, height } }]
}

const pageNotes = (pageIndex: number) => canAnnotate.value
  ? noteStore.notes.filter((note) => getNoteRectsForPage(note, pageIndex).length > 0)
  : []

const getHighlightColor = (note: Note) => {
  const storedColor = (note.highlightRect as any)?.color
  const fallback = note.kind === 'note' ? 'blue' : 'yellow'
  return highlightColors.find((color) => color.value === storedColor)
    || highlightColors.find((color) => color.value === fallback)!
}

const highlightStyle = (rect: EmbedPdfSelectionRect, note: Note) => {
  const scale = zoomLevel.value || 1
  const color = getHighlightColor(note)
  return {
    left: `${rect.origin.x * scale}px`,
    top: `${rect.origin.y * scale}px`,
    width: `${rect.size.width * scale}px`,
    height: `${rect.size.height * scale}px`,
    background: color.background,
    borderColor: color.border,
  }
}

const openHighlightMenu = (note: Note, pageIndex: number, event: MouseEvent | PointerEvent) => {
  event.preventDefault()
  event.stopPropagation()
  clearSelection()

  const page = (event.currentTarget as HTMLElement).closest('.pdf-page') as HTMLElement | null
  if (!page) return

  const pageRect = page.getBoundingClientRect()
  activeHighlight.value = {
    note,
    pageIndex,
    x: Math.min(Math.max(event.clientX - pageRect.left, 90), pageRect.width - 90),
    y: Math.max(event.clientY - pageRect.top, 8),
  }
}

const askFromHighlight = () => {
  const note = activeHighlight.value?.note
  if (!note || !canAnnotate.value || !props.paper?.id || !note.highlightText) return
  chatStore.pdfContext = {
    paperId: props.paper.id,
    pageNumber: note.pageNumber || activeHighlight.value!.pageIndex + 1,
    selectedText: note.highlightText,
  }
  window.dispatchEvent(new CustomEvent('yarc-open-chat'))
  clearActiveHighlight()
}

const copyHighlight = async () => {
  const text = activeHighlight.value?.note.highlightText
  if (!text) return
  await copyToClipboard(text)
  clearActiveHighlight()
}

const changeHighlightColor = async (color: string) => {
  const note = activeHighlight.value?.note
  if (!note) return
  const highlightRect = { ...(note.highlightRect || {}), color }
  await noteStore.updateNote(note.id, { highlightRect })
  clearActiveHighlight()
}

const getNoteTarget = (note: Note) => {
  const pageNumber = note.pageNumber
  if (!pageNumber) return null

  const pageIndex = pageNumber - 1
  const rects = getNoteRectsForPage(note, pageIndex)
  if (!rects.length) return { pageNumber }

  const bounds = rects.reduce((acc, rect) => {
    const left = rect.origin.x
    const top = rect.origin.y
    const right = rect.origin.x + rect.size.width
    const bottom = rect.origin.y + rect.size.height
    return {
      left: Math.min(acc.left, left),
      top: Math.min(acc.top, top),
      right: Math.max(acc.right, right),
      bottom: Math.max(acc.bottom, bottom),
    }
  }, {
    left: Number.POSITIVE_INFINITY,
    top: Number.POSITIVE_INFINITY,
    right: Number.NEGATIVE_INFINITY,
    bottom: Number.NEGATIVE_INFINITY,
  })

  return {
    pageNumber,
    pageCoordinates: {
      x: (bounds.left + bounds.right) / 2,
      y: (bounds.top + bounds.bottom) / 2,
    },
  }
}

const handlePdfDoubleClick = (page: { pageIndex: number; width: number; height: number }, event: MouseEvent) => {
  const element = event.currentTarget as HTMLElement | null
  if (!element || !page.width || !page.height) return
  const rect = element.getBoundingClientRect()
  if (!rect.width || !rect.height) return

  emit('pdf-position', {
    page: page.pageIndex + 1,
    x: Math.max(0, Math.min(page.width, ((event.clientX - rect.left) / rect.width) * page.width)),
    y: Math.max(0, Math.min(page.height, ((event.clientY - rect.top) / rect.height) * page.height)),
  })
}

const scrollToNote = (note: Note) => {
  const target = getNoteTarget(note)
  if (!target) return

  currentPage.value = target.pageNumber
  clearActiveHighlight()
  getDocScroll()?.scrollToPage?.({
    pageNumber: target.pageNumber,
    pageCoordinates: target.pageCoordinates,
    behavior: 'smooth',
    alignX: 50,
    alignY: 50,
  })

  flashingNoteId.value = note.id
  window.setTimeout(() => {
    if (flashingNoteId.value === note.id) flashingNoteId.value = ''
  }, 1400)
}

defineExpose({ scrollToNote, goToPage, goToPosition })
</script>

<template>
  <div ref="viewerRootRef" class="pdf-viewer" :class="{ 'selection-mode': selectionMode }">
    <div class="pdf-toolbar" :class="{ hidden: toolbarHidden }">
      <div class="pdf-toolbar-left">
        <button v-if="showBackButton" class="tb-btn back-btn" @click="$emit('back')" title="返回文献列表">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/>
          </svg>
        </button>
        <span class="pdf-title">{{ documentTitle }}<small v-if="isTemporaryDocument">临时阅读</small><small v-if="pdfOfflineCopy">离线副本</small></span>
      </div>
      <div class="pdf-toolbar-right">
        <button v-if="canAnnotate" class="tb-btn info-btn" @click="$emit('showDetails')" title="论文详情">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>
          </svg>
        </button>
        <div class="tb-sep" />
        <div class="page-nav">
          <button class="tb-btn" @click="goToPage(currentPage - 1)" :disabled="currentPage <= 1">◀</button>
          <input v-model.number="currentPage" type="number" :min="1" :max="totalPages || 1" class="page-input" @change="goToPage(currentPage)" />
          <span class="page-total">/ {{ totalPages || '—' }}</span>
          <button class="tb-btn" @click="goToPage(currentPage + 1)" :disabled="!totalPages || currentPage >= totalPages">▶</button>
        </div>
        <div class="tb-sep" />
        <button class="tb-btn" @click="zoomOut" title="缩小">−</button>
        <span class="zoom-label">{{ Math.round(zoomLevel * 100) }}%</span>
        <button class="tb-btn" @click="zoomIn" title="放大">+</button>
        <button class="tb-btn fit-btn" @click="fitWidth" title="适合宽度">宽</button>
        <button class="tb-btn fit-btn" @click="fitPage" title="适合整页">页</button>
        <button
          class="tb-btn preview-toggle-btn"
          :class="{ active: showPreviewStrip }"
          :aria-pressed="showPreviewStrip"
          title="显示或隐藏页面预览条"
          @click="showPreviewStrip = !showPreviewStrip"
        >缩</button>
        <div class="tb-sep" />
        <button class="tb-btn" :class="{ active: selectionMode }" @click="toggleSelectionMode" title="划词模式">选</button>
      </div>
    </div>

    <div class="pdf-content" ref="pdfContentEl">
      <div v-if="selectionMode" class="selection-mode-hint">
        划词模式：用手指拖过文字进行选择；完成后可点“选”退出。
      </div>
      <div v-if="engineError" class="pdf-empty pdf-error">
        <div class="pdf-empty-stack">
          <strong>PDF 引擎加载失败</strong>
          <span>{{ engineError.message || '当前手机浏览器无法初始化 PDFium 引擎' }}</span>
          <a v-if="pdfUrl" class="pdf-fallback-link" :href="pdfUrl" target="_blank" rel="noopener">打开原始 PDF</a>
        </div>
      </div>
      <div v-else-if="isLoading || !engine" class="pdf-empty">加载 PDF 引擎…</div>

      <EmbedPDF v-else :key="embedPdfKey" :engine="engine" :plugins="plugins" :on-initialized="onInitialized">
        <template #default="{ pluginsReady, activeDocumentId }">
          <div v-if="!pluginsReady" class="pdf-empty">加载 PDF 插件…</div>
          <div v-else-if="!activeDocumentId && pdfUrl" class="pdf-empty">
            <div class="pdf-empty-stack">
              <strong>正在打开 PDF…</strong>
              <span>已选择文献，正在把 PDF 加载到阅读器。</span>
              <a class="pdf-fallback-link" :href="pdfUrl" target="_blank" rel="noopener">打开原始 PDF</a>
            </div>
          </div>
          <div v-else-if="!activeDocumentId" class="pdf-empty">
            <div class="pdf-empty-stack">
              <strong>当前文献没有 PDF 地址</strong>
              <span>请确认这篇文献已经上传或关联 PDF 文件。</span>
            </div>
          </div>

          <DocumentContent v-else :documentId="activeDocumentId">
            <template #default="{ isLoaded, isLoading: isDocLoading, isError, documentState }">
              <div v-if="isDocLoading || (loadingDocument && !isLoaded)" class="pdf-empty">加载 PDF…</div>
              <div v-else-if="isError || documentError" class="pdf-empty pdf-error">
                <div class="pdf-empty-stack">
                  <strong>PDF 加载失败</strong>
                  <span>{{ documentError || documentState?.error || 'PDF 加载失败' }}</span>
                  <a v-if="pdfUrl" class="pdf-fallback-link" :href="pdfUrl" target="_blank" rel="noopener">打开原始 PDF</a>
                </div>
              </div>

              <div v-else-if="isLoaded" ref="viewportWrapRef" class="pdf-viewport-wrap">
                <aside v-if="showPreviewStrip" class="pdf-preview-strip" aria-label="PDF 页面预览">
                  <ThumbnailsPane :documentId="activeDocumentId" class="pdf-thumbnail-list">
                    <template #default="{ meta }">
                      <button
                        type="button"
                        class="pdf-thumbnail"
                        :class="{ active: currentPage === meta.pageIndex + 1 }"
                        :style="{ top: `${meta.top}px`, height: `${meta.wrapperHeight}px` }"
                        :aria-label="`跳转到第 ${meta.pageIndex + 1} 页`"
                        :aria-current="currentPage === meta.pageIndex + 1 ? 'page' : undefined"
                        @click="goToPage(meta.pageIndex + 1)"
                      >
                        <ThumbImg
                          :documentId="activeDocumentId"
                          :meta="meta"
                          :style="{ width: `${meta.width}px`, height: `${meta.height}px` }"
                          :alt="`第 ${meta.pageIndex + 1} 页缩略图`"
                        />
                        <span>{{ meta.pageIndex + 1 }}</span>
                      </button>
                    </template>
                  </ThumbnailsPane>
                </aside>

                <GlobalPointerProvider :documentId="activeDocumentId">
                  <Viewport :documentId="activeDocumentId" class="pdf-viewport">
                    <ZoomGestureWrapper :documentId="activeDocumentId" :enableWheel="false" class="zoom-gesture">
                      <Scroller :documentId="activeDocumentId" class="pdf-scroller">
                        <template #default="{ page }">
                          <div
                            class="pdf-page"
                            :style="{ width: page.width + 'px', height: page.height + 'px' }"
                            @dblclick="handlePdfDoubleClick(page, $event)"
                          >
                            <div
                              v-if="sourceHighlight && sourceHighlight.page === page.pageIndex + 1"
                              class="source-position-highlight"
                              :style="{
                                left: `${sourceHighlight.x}px`,
                                top: `${sourceHighlight.y}px`,
                                width: `${Math.max(1, sourceHighlight.width || 1)}px`,
                                height: `${Math.max(4, sourceHighlight.height || 4)}px`,
                              }"
                              aria-hidden="true"
                            />
                            <PagePointerProvider
                              :documentId="activeDocumentId"
                              :page-index="page.pageIndex"
                              class="pdf-pointer-layer"
                              @pointerdown.capture="beginLongPressSelection"
                              @pointermove.capture="moveLongPressSelection"
                              @pointerup.capture="clearLongPressTimer"
                              @pointercancel.capture="clearLongPressTimer"
                              @touchstart.capture="beginLongPressSelection"
                              @touchmove.capture="moveLongPressSelection"
                              @touchend.capture="clearLongPressTimer"
                              @touchcancel.capture="clearLongPressTimer"
                              @click="clearActiveHighlight"
                              @contextmenu.prevent
                            >
                              <RenderLayer :documentId="activeDocumentId" :page-index="page.pageIndex" class="pdf-layer" />
                              <TilingLayer :documentId="activeDocumentId" :page-index="page.pageIndex" class="pdf-layer" />
                              <SearchLayer :documentId="activeDocumentId" :page-index="page.pageIndex" />
                              <MarqueeZoom :documentId="activeDocumentId" :page-index="page.pageIndex" />

                              <div v-if="canAnnotate" class="note-highlight-layer">
                                <template v-for="note in pageNotes(page.pageIndex)" :key="note.id">
                                  <div
                                    v-for="(rect, idx) in getNoteRectsForPage(note, page.pageIndex)"
                                    :key="`${note.id}-${idx}`"
                                    class="note-highlight"
                                    :class="{ flash: flashingNoteId === note.id, active: activeHighlight?.note.id === note.id }"
                                    :style="highlightStyle(rect, note)"
                                    role="button"
                                    title="操作高亮"
                                    @pointerdown.stop
                                    @click="openHighlightMenu(note, page.pageIndex, $event)"
                                  />
                                </template>

                                <div
                                  v-if="activeHighlight && activeHighlight.pageIndex === page.pageIndex"
                                  class="highlight-popup"
                                  :style="{ left: `${activeHighlight.x}px`, top: `${activeHighlight.y}px` }"
                                  @pointerdown.stop.prevent
                                  @mousedown.stop.prevent
                                  @touchstart.stop.prevent
                                  @click.stop.prevent
                                >
                                  <button type="button" @click="askFromHighlight">提问</button>
                                  <button type="button" @click="copyHighlight">复制</button>
                                  <span class="highlight-color-list">
                                    <button
                                      v-for="color in highlightColors"
                                      :key="color.value"
                                      type="button"
                                      class="highlight-color"
                                      :class="{ active: getHighlightColor(activeHighlight.note).value === color.value }"
                                      :title="`改为${color.name}色`"
                                      :style="{ background: color.background, borderColor: color.border }"
                                      @click="changeHighlightColor(color.value)"
                                    />
                                  </span>
                                </div>
                              </div>

                              <SelectionLayer :documentId="activeDocumentId" :page-index="page.pageIndex" background="rgba(99, 102, 241, 0.25)">
                                <template #selection-menu="{ rect, menuWrapperProps, placement }">
                                  <div v-bind="menuWrapperProps">
                                    <div
                                      class="sel-popup"
                                      :style="{ top: placement.suggestTop ? '-44px' : `${rect.size.height + 6}px` }"
                                      @pointerdown.stop.prevent
                                      @mousedown.stop.prevent
                                      @touchstart.stop.prevent
                                      @click.stop.prevent
                                    >
                                      <button
                                        v-if="canAskAI"
                                        type="button"
                                        @pointerdown.capture="swallowMenuEvent"
                                        @mousedown.capture="swallowMenuEvent"
                                        @touchstart.capture="swallowMenuEvent"
                                        @pointerup.capture="runSelectionMenuAction('ask', $event)"
                                        @touchend.capture="runSelectionMenuAction('ask', $event)"
                                        @click.capture="runSelectionMenuAction('ask', $event)"
                                      >🤖 提问</button>
                                      <button
                                        v-if="canAnnotate"
                                        type="button"
                                        @pointerdown.capture="swallowMenuEvent"
                                        @mousedown.capture="swallowMenuEvent"
                                        @touchstart.capture="swallowMenuEvent"
                                        @pointerup.capture="runSelectionMenuAction('note', $event)"
                                        @touchend.capture="runSelectionMenuAction('note', $event)"
                                        @click.capture="runSelectionMenuAction('note', $event)"
                                      >📝 笔记</button>
                                      <button
                                        v-if="canAnnotate"
                                        type="button"
                                        @pointerdown.capture="swallowMenuEvent"
                                        @mousedown.capture="swallowMenuEvent"
                                        @touchstart.capture="swallowMenuEvent"
                                        @pointerup.capture="runSelectionMenuAction('highlight', $event)"
                                        @touchend.capture="runSelectionMenuAction('highlight', $event)"
                                        @click.capture="runSelectionMenuAction('highlight', $event)"
                                      >🖍️ 高亮</button>
                                      <button
                                        type="button"
                                        @pointerdown.capture="swallowMenuEvent"
                                        @mousedown.capture="swallowMenuEvent"
                                        @touchstart.capture="swallowMenuEvent"
                                        @pointerup.capture="runSelectionMenuAction('copy', $event)"
                                        @touchend.capture="runSelectionMenuAction('copy', $event)"
                                        @click.capture="runSelectionMenuAction('copy', $event)"
                                      >📋 复制</button>
                                    </div>
                                  </div>
                                </template>
                              </SelectionLayer>
                            </PagePointerProvider>
                          </div>
                        </template>
                      </Scroller>
                    </ZoomGestureWrapper>
                  </Viewport>
                </GlobalPointerProvider>
              </div>
            </template>
          </DocumentContent>
        </template>
      </EmbedPDF>
    </div>
  </div>
</template>

<style scoped>
.pdf-viewer { display: flex; flex-direction: column; height: 100%; }
.pdf-toolbar {
  height: 44px; display: flex; align-items: center; justify-content: space-between;
  padding: 0 12px; border-bottom: 1px solid var(--color-border);
  background: var(--color-bg-card); flex-shrink: 0; gap: 8px;
  overflow: hidden;
  transition: height var(--transition), opacity var(--transition), border-color var(--transition);
}
.pdf-toolbar.hidden {
  height: 0;
  opacity: 0;
  border-bottom-color: transparent;
  pointer-events: none;
}
.pdf-toolbar-left { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; }
.pdf-toolbar-right { display: flex; align-items: center; gap: 4px; }
.pdf-title { font-size: 13px; color: var(--color-text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 0; }
.pdf-title small { margin-left: 7px; color: var(--color-text-muted); font-size: 11px; font-weight: 500; }

.page-nav { display: flex; align-items: center; gap: 2px; }
.tb-btn {
  min-width: 30px; height: 30px; display: flex; align-items: center; justify-content: center;
  border: none; background: transparent; color: var(--color-text-secondary);
  border-radius: var(--radius-sm); cursor: pointer; font-size: 13px;
  transition: background var(--transition), color var(--transition), opacity var(--transition);
}
.tb-btn:hover { background: var(--color-bg-muted); color: var(--color-text); }
.tb-btn:disabled { opacity: 0.35; cursor: default; }
.tb-btn.active { color: var(--color-primary); background: var(--color-primary-soft); }
.fit-btn { font-size: 12px; }
.page-input {
  width: 38px; text-align: center; font-size: 12px; padding: 2px;
  border: 1px solid var(--color-border); border-radius: 4px;
  background: var(--color-bg-muted); color: var(--color-text);
  -moz-appearance: textfield;
}
.page-input::-webkit-inner-spin-button { -webkit-appearance: none; }
.page-total, .zoom-label { font-size: 12px; color: var(--color-text-muted); min-width: 36px; text-align: center; }
.tb-sep { width: 1px; height: 18px; background: var(--color-border); margin: 0 2px; }

.back-btn {
  color: var(--color-text-secondary);
}
.back-btn:hover {
  color: var(--color-primary);
  background: var(--color-primary-soft);
}

.info-btn {
  color: var(--color-text-secondary);
}
.info-btn:hover {
  color: var(--color-primary);
  background: var(--color-primary-soft);
}

.pdf-content { flex: 1; overflow: hidden; background: var(--color-bg-muted); position: relative; }
.pdf-viewport-wrap { height: 100%; display: flex; min-width: 0; }
.pdf-viewport {
  flex: 1;
  min-width: 0;
  background-color: var(--color-bg-muted);
  overscroll-behavior: contain;
  /* EmbedPDF sets overflow inline; explicitly retain native horizontal
     scrolling without reserving extra gutter space from the document area. */
  overflow-x: auto !important;
}
.pdf-preview-strip {
  width: 136px;
  flex: 0 0 136px;
  padding: 8px 6px;
  border-right: 1px solid var(--color-border);
  background: var(--color-bg-card);
}
.pdf-thumbnail-list { height: 100%; scrollbar-width: thin; scrollbar-color: var(--color-border-hover) transparent; }
.pdf-thumbnail {
  position: absolute;
  left: 50%;
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 122px;
  padding: 3px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  font-size: 11px;
  line-height: 15px;
  cursor: pointer;
  transform: translateX(-50%);
}
.pdf-thumbnail:hover { background: var(--color-bg-muted); color: var(--color-text); }
.pdf-thumbnail.active { border-color: var(--color-primary); background: var(--color-primary-soft); color: var(--color-primary); }
.pdf-thumbnail img { display: block; max-width: 112px; object-fit: contain; border: 1px solid var(--color-border); background: white; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12); }
.selection-mode .pdf-viewport,
.selection-mode .pdf-pointer-layer {
  touch-action: none;
  cursor: text;
}
.selection-mode-hint {
  position: absolute;
  left: 50%;
  top: 10px;
  transform: translateX(-50%);
  z-index: 12;
  max-width: calc(100% - 24px);
  padding: 7px 12px;
  border-radius: 999px;
  background: rgba(var(--color-bg-card-rgb), 0.96);
  border: 1px solid var(--color-border);
  box-shadow: var(--shadow-md);
  color: var(--color-text-secondary);
  font-size: 12px;
  line-height: 1.35;
  text-align: center;
  pointer-events: none;
}
.zoom-gesture { min-width: 100%; }
/*
 * EmbedPDF sizes the vertical scroller to its calculated page width. At higher
 * zoom levels the rendered right edge can extend slightly beyond that measured
 * scroll range, leaving part of the PDF's right margin unreachable. A positioned
 * end buffer expands only the scrollable overflow area: it does not change the
 * page size, layout, or text-selection coordinates. Keep it proportional to the
 * rendered PDF width so EmbedPDF's zoom anchor and the effective scroll range
 * scale together instead of producing a horizontal jump after zooming out.
 */
.pdf-scroller::after {
  content: '';
  position: absolute;
  top: 0;
  left: 100%;
  width: 8%;
  height: 1px;
  pointer-events: none;
}
.pdf-empty { display: flex; align-items: center; justify-content: center; height: 100%; color: var(--color-text-muted); padding: 24px; text-align: center; }
.pdf-empty-stack { display: flex; flex-direction: column; align-items: center; gap: 8px; max-width: 420px; line-height: 1.5; }
.pdf-error { color: var(--color-error); }
.pdf-fallback-link {
  display: inline-flex; align-items: center; justify-content: center;
  min-height: 36px; padding: 0 14px; margin-top: 4px;
  border-radius: var(--radius); background: var(--color-primary); color: white;
  text-decoration: none; font-size: 13px; font-weight: 600;
}
.pdf-page {
  position: relative;
  background: white;
  box-shadow: var(--shadow-md);
  border-radius: var(--radius-sm);
  overflow: hidden;
}
.pdf-layer { pointer-events: none; }
.pdf-pointer-layer { -webkit-touch-callout: none; user-select: none; }
.source-position-highlight {
  position: absolute;
  z-index: 8;
  border: 1px solid rgba(var(--color-primary-rgb), 0.72);
  border-radius: 3px;
  background: rgba(var(--color-primary-rgb), 0.18);
  box-shadow: 0 0 0 3px rgba(var(--color-primary-rgb), 0.08);
  pointer-events: none;
}
.note-highlight-layer { position: absolute; inset: 0; pointer-events: none; z-index: 6; }
.note-highlight {
  position: absolute;
  border: 1.5px solid;
  border-radius: 3px;
  pointer-events: auto;
  cursor: pointer;
  mix-blend-mode: multiply;
  transition: background 0.2s ease, box-shadow 0.2s ease;
}
.note-highlight:hover,
.note-highlight.active {
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-primary) 30%, transparent);
}
.note-highlight.flash {
  background: rgba(99, 102, 241, 0.42) !important;
  box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.22);
}
.highlight-popup {
  position: absolute;
  display: flex;
  align-items: center;
  gap: 3px;
  padding: 4px;
  pointer-events: auto;
  transform: translate(-50%, calc(-100% - 8px));
  background: var(--color-bg-card);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-md);
  white-space: nowrap;
  z-index: 20;
}
.highlight-popup > button {
  height: 28px;
  padding: 0 8px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--color-text);
  cursor: pointer;
}
.highlight-popup > button:hover { background: var(--color-bg-muted); }
.highlight-color-list {
  display: flex;
  align-items: center;
  gap: 4px;
  padding-left: 6px;
  border-left: 1px solid var(--color-border);
}
.highlight-color-list .highlight-color {
  width: 18px;
  height: 18px;
  padding: 0;
  border: 1.5px solid;
  border-radius: 50%;
  cursor: pointer;
}
.highlight-color-list .highlight-color.active {
  box-shadow: 0 0 0 2px var(--color-bg-card), 0 0 0 3px var(--color-text-muted);
}

@media (max-width: 768px) {
  .pdf-toolbar { padding: 0 8px; }
  .pdf-title { display: none; }
  .page-nav, .preview-toggle-btn { display: none; }
  .pdf-preview-strip { display: none; }
  .selection-mode-hint { top: 8px; font-size: 11px; }
}
</style>

<style>
.sel-popup {
  position: absolute; left: 50%; transform: translateX(-50%);
  display: flex; gap: 2px; padding: 4px;
  background: var(--color-bg-card); border: 1px solid var(--color-border);
  border-radius: var(--radius); box-shadow: 0 4px 16px rgba(0,0,0,0.12);
  pointer-events: auto; cursor: default; white-space: nowrap; z-index: 1000;
}
.sel-popup button {
  padding: 5px 10px; border: none; background: transparent;
  cursor: pointer; font-size: 12px; border-radius: var(--radius-sm);
  color: var(--color-text); transition: background 0.15s;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  pointer-events: auto;
}
.sel-popup button:hover { background: var(--color-bg-muted); }
.sel-popup button:active { background: var(--color-primary-soft); color: var(--color-primary); }
</style>
