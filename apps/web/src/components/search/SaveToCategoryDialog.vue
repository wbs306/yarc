<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import type { SearchPaper } from '@yarc/shared'
import { useApi } from '@/composables/useApi'
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
  (e: 'saved', count: number): void
}>()

const loading = ref(false)
const saving = ref(false)
const categories = ref<Category[]>([])
const selectedCategoryId = ref('')
const createNewCategory = ref(false)
const newCategoryName = ref('')
const api = useApi()

const categoryOptions = computed(() => {
  const result: { value: string; label: string }[] = []
  const flatten = (cats: Category[], level = 0) => {
    for (const cat of cats) {
      result.push({ value: cat.id, label: '  '.repeat(level) + cat.name })
      if (cat.children?.length) {
        flatten(cat.children, level + 1)
      }
    }
  }
  flatten(categories.value)
  return result
})

const canSave = computed(() => {
  if (saving.value) return false
  if (createNewCategory.value) return newCategoryName.value.trim().length > 0
  return selectedCategoryId.value.length > 0
})

const loadCategories = async () => {
  loading.value = true
  try {
    const data = await api.getSearchCategories()
    categories.value = data.categories || []
  } catch (err) {
    console.error('Failed to load search categories:', err)
  } finally {
    loading.value = false
  }
}

const savePapers = async () => {
  if (!canSave.value) return
  
  saving.value = true
  try {
    let categoryId = selectedCategoryId.value
    
    // Create new category if needed
    if (createNewCategory.value && newCategoryName.value.trim()) {
      const data = await api.createSearchCategory({ name: newCategoryName.value.trim() })
      categoryId = data.category?.id
    }
    
    if (!categoryId) {
      alert('请选择或创建一个分类')
      return
    }
    
    // Save each paper
    let savedCount = 0
    for (const paper of props.papers) {
      try {
        // Pass all available fields from the search result
        await api.addPaperToSearchCategory(categoryId!, {
          id: paper.id || `paper-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          title: paper.title,
          abstract: paper.abstract,
          authors: paper.authors,
          year: paper.year,
          url: paper.url,
          doi: paper.doi,
          arxivId: paper.arxivId,
          journal: paper.journal,
          venue: paper.venue,
          source: paper.source,
          // Pass extra fields if available
          ...(paper.citationCount !== undefined && { citationCount: paper.citationCount }),
          ...(paper.referenceCount !== undefined && { referenceCount: paper.referenceCount }),
          ...(paper.publicationDate && { publicationDate: paper.publicationDate }),
          ...(paper.publicationTypes && { publicationTypes: paper.publicationTypes }),
          ...(paper.fieldsOfStudy && { fieldsOfStudy: paper.fieldsOfStudy }),
          ...(paper.openAccessPdf && { openAccessPdf: paper.openAccessPdf }),
          ...(paper.tldr && { tldr: paper.tldr }),
          ...(paper.articleNumber && { articleNumber: paper.articleNumber }),
          ...(paper.publicationNumber && { publicationNumber: paper.publicationNumber }),
          ...(paper.contentType && { contentType: paper.contentType }),
        })
        savedCount++
      } catch (err) {
        console.error(`Failed to save paper "${paper.title}":`, err)
      }
    }
    
    emit('saved', savedCount)
    emit('update:modelValue', false)
  } catch (err) {
    console.error('Failed to save papers:', err)
    alert('保存失败: ' + (err as Error).message)
  } finally {
    saving.value = false
  }
}

onMounted(() => {
  loadCategories()
})
</script>

<template>
  <Modal
    :modelValue="modelValue"
    @update:modelValue="emit('update:modelValue', $event)"
    title="保存到搜索收藏"
  >
    <div class="save-dialog">
      <!-- Papers preview -->
      <div class="papers-preview">
        <div class="preview-header">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
          <span>将保存 {{ papers.length }} 篇论文</span>
        </div>
        <div class="papers-list">
          <div v-for="paper in papers.slice(0, 3)" :key="paper.id" class="paper-item">
            <span class="paper-title">{{ paper.title }}</span>
            <span class="paper-year">{{ paper.year }}</span>
          </div>
          <div v-if="papers.length > 3" class="more-papers">
            还有 {{ papers.length - 3 }} 篇...
          </div>
        </div>
      </div>

      <!-- Category selection -->
      <div class="category-section">
        <Checkbox v-model="createNewCategory" label="创建新分类" />
        
        <div v-if="createNewCategory" class="new-category-input">
          <input
            v-model="newCategoryName"
            type="text"
            placeholder="输入分类名称"
            class="modern-input"
          />
        </div>
        
        <div v-else class="category-select">
          <Select
            v-model="selectedCategoryId"
            :options="categoryOptions"
            placeholder="选择分类"
          />
        </div>
      </div>
    </div>

    <template #footer>
      <button class="btn btn-ghost" @click="emit('update:modelValue', false)">取消</button>
      <button class="btn btn-primary" @click="savePapers" :disabled="!canSave">
        {{ saving ? '保存中...' : '保存' }}
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.save-dialog {
  display: flex;
  flex-direction: column;
  gap: 20px;
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
  gap: 6px;
}

.paper-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 10px;
  background: var(--color-bg-card);
  border-radius: 6px;
  border: 1px solid var(--color-border);
}

.paper-title {
  font-size: 13px;
  color: var(--color-text);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.paper-year {
  font-size: 12px;
  color: var(--color-text-muted);
  margin-left: 12px;
  flex-shrink: 0;
}

.more-papers {
  font-size: 12px;
  color: var(--color-text-muted);
  text-align: center;
  padding: 4px;
}

.category-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.new-category-input {
  margin-top: 4px;
}

.modern-input {
  width: 100%;
  padding: 10px 14px;
  border: 1.5px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-bg);
  color: var(--color-text);
  font-size: 14px;
  font-family: inherit;
  transition: all 0.2s ease;
  box-sizing: border-box;
}

.modern-input:focus {
  outline: none;
  border-color: var(--color-primary);
  box-shadow: 0 0 0 3px var(--color-primary-soft);
}

.modern-input::placeholder {
  color: var(--color-text-muted);
}

.category-select {
  margin-top: 4px;
}

.btn {
  padding: 9px 18px;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
  font-family: inherit;
}

.btn-ghost {
  border: 1px solid var(--color-border);
  background: var(--color-bg);
  color: var(--color-text-secondary);
}

.btn-ghost:hover {
  background: var(--color-bg-muted);
  border-color: var(--color-border-hover);
}

.btn-primary {
  border: none;
  background: var(--color-primary);
  color: white;
}

.btn-primary:hover:not(:disabled) {
  background: var(--color-primary-hover);
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
}

.btn-primary:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>
