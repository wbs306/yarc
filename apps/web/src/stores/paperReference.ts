import { defineStore } from 'pinia'
import { ref, shallowRef } from 'vue'
import type { PaperReferenceInput, PaperReferenceResolution, SearchPaper } from '@yarc/shared'
import { useApi } from '@/composables/useApi'
import { usePaperStore } from '@/stores/paper'

const cacheKey = (reference: PaperReferenceInput) => JSON.stringify({
  localPaperId: reference.localPaperId || '',
  doi: reference.doi?.toLowerCase() || '',
  arxivId: reference.arxivId?.toLowerCase() || '',
  semanticScholarId: reference.semanticScholarId || '',
  ieeeArticleNumber: reference.ieeeArticleNumber || '',
  title: reference.title?.toLowerCase().replace(/\s+/g, ' ').trim() || '',
  year: reference.year || null,
})

export const usePaperReferenceStore = defineStore('paper-reference', () => {
  const api = useApi()
  const paperStore = usePaperStore()
  const open = ref(false)
  const loading = ref(false)
  const saving = ref(false)
  const error = ref('')
  const reference = ref<PaperReferenceInput | null>(null)
  const resolution = ref<PaperReferenceResolution | null>(null)
  const anchorRect = ref<{ top: number; right: number; bottom: number; left: number; width: number; height: number } | null>(null)
  const anchorElement = shallowRef<HTMLElement | null>(null)
  const cache = new Map<string, PaperReferenceResolution>()

  const resolve = async (
    input: PaperReferenceInput,
    force = false,
    anchor?: { top: number; right: number; bottom: number; left: number; width: number; height: number },
    element?: HTMLElement
  ) => {
    reference.value = input
    if (anchor) anchorRect.value = anchor
    if (element) anchorElement.value = element
    open.value = true
    error.value = ''
    const key = cacheKey(input)
    const cached = !force ? cache.get(key) : null
    if (cached) {
      resolution.value = cached
      return cached
    }

    loading.value = true
    resolution.value = null
    try {
      const response = await api.resolvePaperReferences([{ ...input, key }])
      const result = response.results?.[0]
      if (!result) throw new Error('没有返回论文解析结果')
      resolution.value = result
      cache.set(key, result)
      return result
    } catch (err) {
      error.value = (err as Error).message || '论文引用解析失败'
      resolution.value = {
        status: 'error',
        original: input,
        candidates: [],
        error: error.value,
      }
      return resolution.value
    } finally {
      loading.value = false
    }
  }

  const chooseCandidate = (paper: SearchPaper) => {
    if (!reference.value) return
    const result: PaperReferenceResolution = {
      status: 'resolved',
      matchedBy: paper.source === 'local' ? 'local' : paper.source === 'ieee' ? 'ieee' : 'semantic_scholar',
      confidence: 'exact',
      localPaper: paper.source === 'local' ? paper : null,
      paper,
      candidates: [],
      original: reference.value,
    }
    resolution.value = result
    cache.set(cacheKey(reference.value), result)
  }

  const saveToLibrary = async () => {
    const paper = resolution.value?.paper
    if (!paper || paper.source === 'local') return resolution.value?.localPaper || null
    saving.value = true
    error.value = ''
    try {
      const preflight = await api.resolvePaperReferences([{
        title: paper.title,
        authors: paper.authors,
        year: paper.year,
        doi: paper.doi || undefined,
        arxivId: paper.arxivId || undefined,
        semanticScholarId: paper.source === 'semantic_scholar' ? paper.id : undefined,
      }])
      const existing = preflight.results?.[0]?.localPaper
      if (existing) {
        resolution.value = {
          ...resolution.value!,
          matchedBy: 'local',
          confidence: 'exact',
          localPaper: existing,
          paper: existing,
        }
        if (reference.value) cache.set(cacheKey(reference.value), resolution.value)
        await paperStore.fetchPapers({ limit: 500 })
        return existing
      }

      const response = await api.createPaper({
        title: paper.title,
        abstract: paper.abstract || undefined,
        authors: paper.authors || [],
        year: paper.year || undefined,
        doi: paper.doi || undefined,
        arxivId: paper.arxivId || undefined,
        url: paper.url || undefined,
        metadata: {
          journal: paper.journal || undefined,
          venue: paper.venue || undefined,
          source: paper.source,
          externalId: paper.id,
          citationCount: paper.citationCount ?? undefined,
          referenceCount: paper.referenceCount ?? undefined,
          openAccessPdf: paper.openAccessPdf || undefined,
        },
      })
      const localPaper: SearchPaper = {
        ...paper,
        ...response.paper,
        id: response.paper.id,
        source: 'local',
      }
      resolution.value = {
        ...resolution.value!,
        matchedBy: 'local',
        confidence: 'exact',
        localPaper,
        paper: localPaper,
      }
      if (reference.value) cache.set(cacheKey(reference.value), resolution.value)
      await paperStore.fetchPapers({ limit: 500 })
      return localPaper
    } catch (err) {
      error.value = (err as Error).message || '保存论文失败'
      throw err
    } finally {
      saving.value = false
    }
  }

  const retry = () => reference.value ? resolve(reference.value, true) : Promise.resolve(null)
  const updateAnchorRect = (rect: { top: number; right: number; bottom: number; left: number; width: number; height: number }) => {
    anchorRect.value = rect
  }
  const close = () => {
    open.value = false
    anchorElement.value = null
  }

  return {
    open,
    loading,
    saving,
    error,
    reference,
    resolution,
    anchorRect,
    anchorElement,
    resolve,
    updateAnchorRect,
    chooseCandidate,
    saveToLibrary,
    retry,
    close,
  }
})
