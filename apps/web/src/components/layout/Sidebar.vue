<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { usePaperStore } from '@/stores/paper'
import { useApi } from '@/composables/useApi'
import { confirm } from '@/composables/useConfirm'

const emit = defineEmits<{
  'select-paper': [id: string]
  upload: []
  close: []
}>()

const paperStore = usePaperStore()
const api = useApi()

const query = ref('')
const selectedCategory = ref<string | null>(null)
const categories = ref<any[]>([])

const filteredPapers = computed(() => {
  let list = paperStore.papers
  if (selectedCategory.value) list = list.filter(p => p.categoryId === selectedCategory.value)
  if (query.value) {
    const q = query.value.toLowerCase()
    list = list.filter(p => p.title.toLowerCase().includes(q) || p.authors.some(a => a.toLowerCase().includes(q)))
  }
  return list
})

onMounted(async () => {
  try { categories.value = (await api.getCategories()).categories } catch {}
})

const statusMap: Record<string, string> = { pending: '待处理', processing: '解析中', completed: '已完成', failed: '失败' }

const handleDelete = async (e: Event, id: string) => {
  e.stopPropagation()
  const paper = paperStore.papers.find(p => p.id === id)
  if (!(await confirm({
    title: '删除文献',
    message: `「${paper?.title || '该文献'}」及其解析结果、笔记将一并删除。`,
    confirmText: '删除',
    danger: true,
    icon: 'trash',
  }))) return
  await paperStore.deletePaper(id)
}
</script>

<template>
  <div class="sidebar">
    <!-- Search -->
    <div class="sidebar-search">
      <svg class="search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
      <input v-model="query" placeholder="搜索文献…" class="search-input" />
    </div>

    <!-- Categories -->
    <div class="sidebar-cats">
      <button
        @click="selectedCategory = null"
        class="cat-item"
        :class="{ active: !selectedCategory }"
      >
        <span class="cat-dot" style="background: var(--color-text-muted)" />
        <span>全部</span>
        <span class="cat-count">{{ paperStore.total }}</span>
      </button>
      <button
        v-for="cat in categories"
        :key="cat.id"
        @click="selectedCategory = cat.id"
        class="cat-item"
        :class="{ active: selectedCategory === cat.id }"
      >
        <span class="cat-dot" :style="{ background: cat.color || '#a1a1aa' }" />
        <span>{{ cat.name }}</span>
        <span class="cat-count">{{ cat._count?.papers || 0 }}</span>
      </button>
    </div>

    <!-- Paper list -->
    <div class="sidebar-section-header">
      <span>文献</span>
    </div>
    <TransitionGroup tag="div" name="paper" class="sidebar-list">
      <button
        v-for="paper in filteredPapers"
        :key="paper.id"
        class="paper-item"
        :class="{ active: paperStore.currentPaper?.id === paper.id }"
        @click="emit('select-paper', paper.id)"
      >
        <div class="paper-title">{{ paper.title }}</div>
        <div class="paper-meta">
          {{ paper.authors.slice(0, 2).join(', ') }}{{ paper.year ? ` · ${paper.year}` : '' }}
        </div>
        <div class="paper-footer">
          <span class="badge" :class="`badge-${paper.parseStatus}`">{{ statusMap[paper.parseStatus] || paper.parseStatus }}</span>
          <button class="paper-delete" @click="handleDelete($event, paper.id)" title="删除">✕</button>
        </div>
      </button>

      <div v-if="!filteredPapers.length" key="empty" class="sidebar-empty">
        {{ query ? '无匹配结果' : '暂无文献' }}
      </div>
    </TransitionGroup>

    <!-- Bottom -->
    <div class="sidebar-bottom">
      <router-link to="/search" class="bottom-btn" @click="emit('close')">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
        搜索
      </router-link>
      <router-link to="/settings" class="bottom-btn" @click="emit('close')">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>
        设置
      </router-link>
    </div>
  </div>
</template>

<style scoped>
.sidebar {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.sidebar-search {
  padding: 12px 12px 8px;
  position: relative;
}

.search-icon {
  position: absolute;
  left: 22px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--color-text-muted);
  pointer-events: none;
}

.search-input {
  width: 100%;
  padding: 8px 12px 8px 32px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  background: var(--color-bg-muted);
  color: var(--color-text);
  font-size: 13px;
  transition: border-color var(--transition), background var(--transition);
}

.search-input:focus {
  outline: none;
  border-color: var(--color-primary);
  background: var(--color-bg-card);
}

.search-input::placeholder { color: var(--color-text-muted); }

/* ── Categories ────────────────────────────────────────────────────────────── */

.sidebar-cats {
  padding: 4px 8px;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.cat-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border: none;
  background: transparent;
  border-radius: var(--radius-sm);
  font-size: 13px;
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: background var(--transition), color var(--transition);
  text-align: left;
  width: 100%;
}

.cat-item:hover { background: var(--color-bg-muted); color: var(--color-text); }
.cat-item.active { background: var(--color-primary-soft); color: var(--color-primary); font-weight: 500; }

.cat-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}

.cat-count {
  margin-left: auto;
  font-size: 11px;
  color: var(--color-text-muted);
}

/* ── Section header ──────────────────────────────────────────────────────── */

.sidebar-section-header {
  padding: 10px 14px 6px;
  font-size: 11px;
  font-weight: 600;
  color: var(--color-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

/* ── Paper list ────────────────────────────────────────────────────────────── */

.sidebar-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 8px;
  position: relative;
}
.paper-enter-active, .paper-leave-active, .paper-move { transition: opacity 0.28s ease, transform 0.28s cubic-bezier(0.4, 0, 0.2, 1); }
.paper-enter-from { opacity: 0; transform: translateY(-6px); }
.paper-leave-to { opacity: 0; transform: translateX(-12px); }
.paper-leave-active { position: absolute; left: 8px; right: 8px; z-index: 0; }

.paper-item {
  display: flex;
  flex-direction: column;
  gap: 3px;
  width: 100%;
  padding: 9px 10px;
  border: none;
  background: transparent;
  border-radius: var(--radius-sm);
  cursor: pointer;
  text-align: left;
  transition: background var(--transition), transform var(--transition);
  margin-bottom: 1px;
  position: relative;
}

.paper-item:hover { background: var(--color-bg-muted); transform: translateX(2px); }
.paper-item.active { background: var(--color-primary-soft); }
.paper-item.active .paper-title { color: var(--color-primary); }

.paper-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--color-text);
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.paper-meta {
  font-size: 12px;
  color: var(--color-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.paper-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 2px;
}

.paper-delete {
  opacity: 0;
  border: none;
  background: none;
  color: var(--color-error);
  font-size: 12px;
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 4px;
  transition: opacity var(--transition);
}

.paper-item:hover .paper-delete { opacity: 1; }

.sidebar-empty {
  text-align: center;
  padding: 32px 16px;
  font-size: 13px;
  color: var(--color-text-muted);
}

/* ── Bottom ────────────────────────────────────────────────────────────────── */

.sidebar-bottom {
  padding: 8px;
  border-top: 1px solid var(--color-border);
  display: flex;
  gap: 4px;
}

.bottom-btn {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 8px;
  border: none;
  background: var(--color-bg-muted);
  border-radius: var(--radius-sm);
  font-size: 12px;
  color: var(--color-text-secondary);
  cursor: pointer;
  text-decoration: none;
  transition: background var(--transition), color var(--transition);
}

.bottom-btn:hover { background: var(--color-bg-hover); color: var(--color-text); }
</style>
