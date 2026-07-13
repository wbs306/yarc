<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import type { SearchPaper } from '@yarc/shared'
import { useApi } from '@/composables/useApi'
import { usePaperStore } from '@/stores/paper'
import Modal from '../ui/Modal.vue'
import Select from '../ui/Select.vue'
import Checkbox from '../ui/Checkbox.vue'

interface Category {
  id: string
  name: string
  parentId?: string | null
  children?: Category[]
}

const props = defineProps<{
  papers: SearchPaper[]
  modelValue: boolean
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
  (e: 'started', job: any): void
}>()

const api = useApi()
const paperStore = usePaperStore()
const loading = ref(false)
const importing = ref(false)
const categories = ref<Category[]>([])
const selectedCategoryId = ref('')
const createNewCategory = ref(false)
const newCategoryName = ref('')
const requirePdf = ref(true)
const jobPollTimers = new Map<string, number>()

const categoryOptions = computed(() => {
  const result: { value: string; label: string }[] = [
    { value: '', label: '未分类' },
  ]
  const flatten = (cats: Category[], level = 0) => {
    for (const cat of cats) {
      result.push({ value: cat.id, label: '  '.repeat(level) + cat.name })
      if (cat.children?.length) flatten(cat.children, level + 1)
    }
  }
  flatten(categories.value)
  return result
})

const canImport = computed(() => {
  if (importing.value) return false
  if (!props.papers.length) return false
  if (createNewCategory.value) return newCategoryName.value.trim().length > 0
  return true
})

const loadCategories = async () => {
  loading.value = true
  try {
    const data = await api.getCategories()
    categories.value = data.categories || []
  } catch (err) {
    console.error('Failed to load categories:', err)
  } finally {
    loading.value = false
  }
}

const dispatchImportJobStatus = (job: any) => {
  if (!job?.id) return
  const detail = {
    jobId: job.id,
    status: job.status || 'running',
    total: Number(job.total || 0),
    completed: Number(job.completed || 0),
    failed: Number(job.failed || 0),
    categoryId: job.categoryId,
    errors: job.errors || [],
    warnings: job.warnings || [],
    at: job.updatedAt || new Date().toISOString(),
  }
  window.dispatchEvent(new CustomEvent(`yarc-import-job-${job.status === 'failed' ? 'failed' : job.status === 'completed' ? 'completed' : 'progress'}`, { detail }))
}

const trackImportJob = (jobId: string) => {
  let attempts = 0
  const poll = async () => {
    attempts += 1
    try {
      const response = await api.getImportJob(jobId)
      const job = response.job
      dispatchImportJobStatus(job)
      if (job?.status === 'completed' || job?.status === 'failed') {
        jobPollTimers.delete(jobId)
        await paperStore.fetchPapers({ limit: 500 }).catch(() => {})
        window.dispatchEvent(new CustomEvent('yarc-library-changed', {
          detail: { source: 'import-job-poll', jobId, paperIds: (job.results || []).map((paper: any) => paper.id).filter(Boolean) },
        }))
        return
      }
    } catch {
      // A transient polling failure should not hide a server-side job that may
      // still be running; retry until the component is torn down.
    }
    if (attempts >= 900) {
      jobPollTimers.delete(jobId)
      return
    }
    const timer = window.setTimeout(poll, 1000)
    jobPollTimers.set(jobId, timer)
  }
  void poll()
}

const importPapers = async () => {
  if (!canImport.value) return
  importing.value = true
  try {
    let categoryId = selectedCategoryId.value || undefined
    if (createNewCategory.value && newCategoryName.value.trim()) {
      const data = await api.createCategory({ name: newCategoryName.value.trim() })
      categoryId = data.category?.id
    }

    const result = await api.importPapersFromSearch({
      papers: props.papers,
      categoryId,
      requirePdf: requirePdf.value,
      extractMetadata: false,
    })

    // The server emits the queued SSE event before this HTTP response returns,
    // so a reconnecting or briefly suspended tab can miss it. Replay the
    // initial state locally to guarantee that the top-bar progress indicator
    // appears for every accepted import job.
    if (result.job?.id) {
      window.dispatchEvent(new CustomEvent('yarc-import-job-queued', {
        detail: {
          jobId: result.job.id,
          status: result.job.status || 'queued',
          total: Number(result.job.total || props.papers.length),
          completed: Number(result.job.completed || 0),
          failed: Number(result.job.failed || 0),
          categoryId: result.job.categoryId,
          at: result.job.updatedAt || new Date().toISOString(),
        },
      }))
      trackImportJob(result.job.id)
    }

    emit('started', result.job)
    emit('update:modelValue', false)
  } catch (err) {
    console.error('Failed to import papers:', err)
    alert('导入失败: ' + (err as Error).message)
  } finally {
    importing.value = false
  }
}

onMounted(() => {
  loadCategories()
})

onBeforeUnmount(() => {
  for (const timer of jobPollTimers.values()) window.clearTimeout(timer)
  jobPollTimers.clear()
})
</script>

<template>
  <Modal
    :modelValue="modelValue"
    @update:modelValue="emit('update:modelValue', $event)"
    title="导入 PDF 到文献库"
  >
    <div class="import-dialog">
      <div class="papers-preview">
        <div class="preview-header">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
          <span>将下载并导入 {{ papers.length }} 篇论文 PDF</span>
        </div>
        <div class="papers-list">
          <div v-for="paper in papers.slice(0, 3)" :key="paper.id" class="paper-item">
            <span class="paper-title">{{ paper.title }}</span>
            <span class="paper-year">{{ paper.year }}</span>
          </div>
          <div v-if="papers.length > 3" class="more-papers">还有 {{ papers.length - 3 }} 篇...</div>
        </div>
      </div>

      <div class="category-section">
        <Checkbox v-model="createNewCategory" label="创建新分类" />

        <div v-if="createNewCategory" class="new-category-input">
          <input v-model="newCategoryName" type="text" placeholder="输入分类名称" class="modern-input" />
        </div>

        <div v-else class="category-select">
          <Select v-model="selectedCategoryId" :options="categoryOptions" placeholder="选择分类（默认未分类）" />
        </div>
      </div>

      <div class="option-row">
        <Checkbox v-model="requirePdf" label="仅导入 PDF 下载成功的论文" />
        <p class="hint">取消后，PDF 下载失败时会保存元数据到文献库。</p>
      </div>

      <p v-if="loading" class="hint">正在加载分类...</p>
    </div>

    <template #footer>
      <button class="btn btn-ghost" @click="emit('update:modelValue', false)">取消</button>
      <button class="btn btn-primary" @click="importPapers" :disabled="!canImport">
        {{ importing ? '导入中...' : '导入' }}
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.import-dialog {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.papers-preview {
  padding: 14px;
  background: var(--color-bg-muted);
  border-radius: 10px;
  border: 1px solid var(--color-border);
}

.preview-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text-secondary);
}

.papers-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.paper-item {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 10px;
  background: var(--color-bg);
  border-radius: 8px;
  font-size: 13px;
}

.paper-title {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.paper-year {
  color: var(--color-text-muted);
}

.more-papers,
.hint {
  font-size: 12px;
  color: var(--color-text-muted);
}

.category-section,
.option-row {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.modern-input {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-bg);
  color: var(--color-text);
  font: inherit;
}
</style>
