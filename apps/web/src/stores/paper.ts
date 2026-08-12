import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useApi } from '@/composables/useApi'

export interface Paper {
  id: string
  title: string
  abstract: string | null
  authors: string[]
  year: number | null
  doi: string | null
  arxivId: string | null
  url: string | null
  filePath: string | null
  fileSize: number | null
  categoryId: string | null
  parseStatus: string
  embeddingStatus: string
  embeddingProgress: number
  summaryStatus: string
  summary: string | null
  tags: string[]
  journal?: string
  venue?: string
  rankings?: { ccf: string | null; sci: string | null }
  createdAt: string
  updatedAt: string
  // Search result fields
  citationCount?: number
  referenceCount?: number
  publicationDate?: string
  publicationTypes?: string[]
  fieldsOfStudy?: string[]
  openAccessPdf?: { url: string; status: string } | null
  tldr?: { text: string } | null
  articleNumber?: string
  publicationNumber?: string
  contentType?: string
}

export const usePaperStore = defineStore('paper', () => {
  const api = useApi()

  const papers = ref<Paper[]>([])
  const currentPaper = ref<Paper | null>(null)
  const currentPage = ref(1)
  const totalPages = ref(0)
  const scale = ref(1.0)
  const loading = ref(false)
  const total = ref(0)

  // SSE connection for real-time updates
  let evtSource: EventSource | null = null

  // Text selection context
  const selection = ref<{
    text: string
    pageNumber: number
    position: { x: number; y: number }
  } | null>(null)

  const fetchPapers = async (params?: { category?: string; q?: string; field?: string; page?: number; limit?: number }) => {
    loading.value = true
    try {
      const res = await api.getPapers(params)
      papers.value = res.papers
      total.value = res.total
    } finally {
      loading.value = false
    }
  }

  const fetchPaper = async (id: string) => {
    loading.value = true
    try {
      const res = await api.getPaper(id)
      currentPaper.value = res.paper
    } finally {
      loading.value = false
    }
  }

  const deletePaper = async (id: string) => {
    await api.deletePaper(id)
    papers.value = papers.value.filter((p) => p.id !== id)
    if (currentPaper.value?.id === id) {
      currentPaper.value = null
    }
  }

  /** Start SSE connection (idempotent) */
  const connectSSE = () => {
    if (evtSource) return
    evtSource = new EventSource('/api/events')
    evtSource.onmessage = (e) => {
      try {
        const evt = JSON.parse(e.data)
        window.dispatchEvent(new CustomEvent('yarc-sse-event', { detail: evt }))
        if (evt.type) window.dispatchEvent(new CustomEvent(`yarc-${evt.type}`, { detail: evt }))
        // Search results are rendered with the originating tool call in the chat;
        // the SSE event only carries the library-wide realtime notification.
        if (evt.type === 'paper-status' && evt.paperId) {
          refreshPaperStatus(evt.paperId)
        }
        if (evt.type === 'library-changed') {
          fetchPapers({ limit: 500 }).catch(() => {})
        }
      } catch { /* ignore parse errors */ }
    }
    evtSource.onerror = () => {
      evtSource?.close()
      evtSource = null
      // Reconnect after 3s
      setTimeout(connectSSE, 3000)
    }
  }

  /** Fetch fresh status for one paper and update local state */
  const refreshPaperStatus = async (paperId: string) => {
    try {
      const res = await api.getPaper(paperId)
      const updated = res.paper as Paper
      const idx = papers.value.findIndex(p => p.id === paperId)
      if (idx >= 0) {
        papers.value[idx] = { ...papers.value[idx], ...updated }
      }
      if (currentPaper.value?.id === paperId) {
        currentPaper.value = { ...currentPaper.value, ...updated }
      }
    } catch { /* ignore */ }
  }

  return {
    papers,
    currentPaper,
    currentPage,
    totalPages,
    scale,
    loading,
    total,
    selection,
    fetchPapers,
    fetchPaper,
    deletePaper,
    connectSSE,
  }
})
