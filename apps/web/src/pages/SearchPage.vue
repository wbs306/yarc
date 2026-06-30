<script setup lang="ts">
import { ref } from 'vue'
import { useApi } from '@/composables/useApi'

const api = useApi()
const query = ref('')
const source = ref('semantic_scholar')
const field = ref('all')
const results = ref<any[]>([])
const loading = ref(false)
const total = ref(0)

const search = async () => {
  if (!query.value) return
  loading.value = true
  try {
    const res: any = await api.searchExternal(query.value, source.value, field.value)
    results.value = res.papers || []
    total.value = res.total || 0
  } catch (err) { console.error(err) }
  finally { loading.value = false }
}

const importPaper = async (paper: any) => {
  try {
    await api.createPaper({ title: paper.title, abstract: paper.abstract, authors: paper.authors || [], year: paper.year, doi: paper.doi, arxivId: paper.arxivId, url: paper.url })
    alert('已导入到文献库')
  } catch (err) { alert('导入失败: ' + (err as Error).message) }
}
</script>

<template>
  <div class="search-page">
    <header class="page-header">
      <router-link to="/" class="back-link">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
        返回
      </router-link>
      <h1>文献搜索</h1>
    </header>

    <div class="search-body">
      <!-- Search bar -->
      <div class="search-bar">
        <div class="search-input-wrap">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="search-icon"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
          <input v-model="query" @keydown.enter="search" placeholder="搜索论文标题、作者、关键词…" class="search-input" />
        </div>
        <div class="search-filters">
          <select v-model="source">
            <option value="semantic_scholar">Semantic Scholar</option>
            <option value="ieee">IEEE Xplore</option>
          </select>
          <select v-model="field">
            <option value="all">全部字段</option>
            <option value="title">标题</option>
            <option value="author">作者</option>
            <option value="abstract">摘要</option>
          </select>
          <button @click="search" :disabled="loading" class="search-btn">
            {{ loading ? '搜索中…' : '搜索' }}
          </button>
        </div>
      </div>

      <!-- Results -->
      <div class="results">
        <div v-for="paper in results" :key="paper.id" class="result-card">
          <h3>{{ paper.title }}</h3>
          <p class="result-meta">{{ paper.authors?.join(', ') }}{{ paper.year ? ` · ${paper.year}` : '' }}</p>
          <p v-if="paper.abstract" class="result-abstract">{{ paper.abstract }}</p>
          <div class="result-actions">
            <button @click="importPaper(paper)" class="import-btn">导入到库</button>
            <a v-if="paper.url" :href="paper.url" target="_blank" class="link-btn">查看原文</a>
          </div>
        </div>
        <div v-if="!loading && !results.length && query" class="results-empty">未找到相关论文</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.search-page { display: flex; flex-direction: column; height: 100vh; background: var(--color-bg); }

.page-header {
  height: var(--header-height);
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 16px;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-bg-card);
  flex-shrink: 0;
}
.back-link {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  color: var(--color-text-secondary);
  text-decoration: none;
  transition: color var(--transition);
}
.back-link:hover { color: var(--color-primary); }
h1 { font-size: 15px; font-weight: 600; color: var(--color-text); }

.search-body {
  flex: 1;
  overflow-y: auto;
  padding: 24px 24px calc(24px + var(--list-scroll-bottom-gap, 84px));
  scroll-padding-bottom: var(--list-scroll-bottom-gap, 84px);
  max-width: 800px;
  margin: 0 auto;
  width: 100%;
}

.search-bar { margin-bottom: 24px; }
.search-input-wrap { position: relative; margin-bottom: 10px; }
.search-icon { position: absolute; left: 14px; top: 50%; transform: translateY(-50%); color: var(--color-text-muted); pointer-events: none; }
.search-input {
  width: 100%;
  padding: 12px 16px 12px 40px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  background: var(--color-bg-card);
  color: var(--color-text);
  font-size: 15px;
  transition: border-color var(--transition), box-shadow var(--transition);
}
.search-input:focus { outline: none; border-color: var(--color-primary); box-shadow: 0 0 0 3px var(--color-primary-soft); }
.search-input::placeholder { color: var(--color-text-muted); }

.search-filters { display: flex; gap: 8px; flex-wrap: wrap; }
.search-filters select {
  padding: 8px 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg-card);
  color: var(--color-text);
  font-size: 13px;
}
.search-filters select:focus { outline: none; border-color: var(--color-primary); }

.search-btn {
  padding: 8px 20px;
  border: none;
  border-radius: var(--radius-sm);
  background: var(--color-primary);
  color: white;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: background var(--transition);
}
.search-btn:hover { background: var(--color-primary-hover); }
.search-btn:disabled { opacity: 0.6; cursor: default; }

.results { display: flex; flex-direction: column; gap: 12px; }
.result-card {
  padding: 16px;
  background: var(--color-bg-card);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  transition: border-color var(--transition), box-shadow var(--transition);
}
.result-card:hover { border-color: var(--color-border-hover); box-shadow: var(--shadow-sm); }
.result-card h3 { font-size: 15px; font-weight: 600; color: var(--color-text); margin-bottom: 4px; line-height: 1.4; }
.result-meta { font-size: 13px; color: var(--color-text-muted); margin-bottom: 8px; }
.result-abstract { font-size: 13px; color: var(--color-text-secondary); line-height: 1.6; margin-bottom: 12px; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.result-actions { display: flex; gap: 8px; }
.import-btn {
  padding: 6px 14px;
  border: none;
  border-radius: var(--radius-sm);
  background: var(--color-primary);
  color: white;
  font-size: 12px;
  cursor: pointer;
  transition: background var(--transition);
}
.import-btn:hover { background: var(--color-primary-hover); }
.link-btn {
  padding: 6px 14px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-secondary);
  font-size: 12px;
  text-decoration: none;
  transition: background var(--transition), border-color var(--transition);
}
.link-btn:hover { background: var(--color-bg-muted); border-color: var(--color-border-hover); }

.results-empty { text-align: center; padding: 40px; color: var(--color-text-muted); font-size: 14px; }

@media (max-width: 768px) {
  .search-body { padding: 16px; }
  .search-filters { flex-direction: column; }
  .search-filters select, .search-btn { width: 100%; }
}
</style>
