<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { ProjectHistorySettings } from '@yarc/shared'

const route = useRoute()
const router = useRouter()
const projectId = String(route.params.id || '')
const projectName = ref('Project')
const loading = ref(true)
const saving = ref(false)
const error = ref('')
const saved = ref(false)
const includeText = ref('')
const excludeText = ref('')
const settings = ref<ProjectHistorySettings>({
  enabled: true,
  include: ['**/*.tex', '**/*.bib', '**/*.sty', '**/*.cls', '**/*.bst'],
  exclude: [],
  idleDebounceSeconds: 30,
  maxIntervalSeconds: 120,
  retentionDays: 180,
  maxStorageMb: 512,
})

const request = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(url, {
    credentials: 'include',
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data?.error?.message || data?.message || `Request failed (${response.status})`)
  return data as T
}

const syncPatternText = () => {
  includeText.value = settings.value.include.join('\n')
  excludeText.value = settings.value.exclude.join('\n')
}

const parsePatterns = (value: string) => value
  .split(/\r?\n/)
  .map(item => item.trim())
  .filter(Boolean)

const load = async () => {
  loading.value = true
  error.value = ''
  try {
    const [projectData, historyData] = await Promise.all([
      request<{ project: { name: string } }>(`/api/projects/${projectId}`),
      request<{ settings: ProjectHistorySettings }>(`/api/projects/${projectId}/history/settings`),
    ])
    projectName.value = projectData.project.name
    settings.value = { ...historyData.settings }
    syncPatternText()
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    loading.value = false
  }
}

const save = async () => {
  saving.value = true
  saved.value = false
  error.value = ''
  try {
    const payload: ProjectHistorySettings = {
      ...settings.value,
      include: parsePatterns(includeText.value),
      exclude: parsePatterns(excludeText.value),
    }
    const data = await request<{ settings: ProjectHistorySettings }>(`/api/projects/${projectId}/history/settings`, {
      method: 'PUT',
      body: JSON.stringify({ settings: payload }),
    })
    settings.value = { ...data.settings }
    syncPatternText()
    saved.value = true
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    saving.value = false
  }
}

onMounted(load)
</script>

<template>
  <main class="settings-page">
    <header>
      <button class="ghost" @click="router.push(`/projects/${projectId}`)">← {{ projectName }}</button>
      <div>
        <p class="eyebrow">Project Settings</p>
        <h1>Writing History</h1>
        <p>配置自动写作历史。Git 仍只由用户显式提交；这里的设置不会自动创建 Git commit。</p>
      </div>
    </header>

    <p v-if="error" class="error">{{ error }}</p>
    <div v-if="loading" class="empty">加载中…</div>

    <form v-else class="card" @submit.prevent="save">
      <label class="check"><input v-model="settings.enabled" type="checkbox" /> 启用 Writing History</label>

      <div class="grid two">
        <label>Idle debounce（秒）<input v-model.number="settings.idleDebounceSeconds" type="number" min="1" max="3600" /></label>
        <label>Max interval（秒）<input v-model.number="settings.maxIntervalSeconds" type="number" min="1" max="86400" /></label>
        <label>Retention（天）<input v-model.number="settings.retentionDays" type="number" min="1" max="3650" /></label>
        <label>最大存储（MB）<input v-model.number="settings.maxStorageMb" type="number" min="1" max="102400" /></label>
      </div>

      <div class="grid two">
        <label>Include patterns<textarea v-model="includeText" rows="7" spellcheck="false" /><small>每行一个 glob。默认跟踪 tex / bib / sty / cls / bst。</small></label>
        <label>Exclude patterns<textarea v-model="excludeText" rows="7" spellcheck="false" /><small>每行一个 glob；匹配项不会进入 Writing History。</small></label>
      </div>

      <div class="actions">
        <button class="primary" type="submit" :disabled="saving">{{ saving ? '保存中…' : '保存 Writing History 设置' }}</button>
        <span v-if="saved" class="saved">已保存</span>
      </div>
    </form>
  </main>
</template>

<style scoped>
.settings-page{min-height:100vh;max-width:980px;margin:0 auto;padding:36px;color:var(--text-primary,#e8e8e8)}
header{display:flex;gap:20px;align-items:flex-start;margin-bottom:28px}header>div{flex:1}.eyebrow{font-size:12px;text-transform:uppercase;letter-spacing:.12em;opacity:.55;margin:0 0 7px}h1{margin:0 0 8px;font-size:28px}header p:last-child{margin:0;opacity:.62;line-height:1.5}.card{display:grid;gap:22px;padding:22px;border:1px solid rgba(127,127,127,.22);border-radius:12px;background:rgba(127,127,127,.06)}.grid{display:grid;gap:14px}.two{grid-template-columns:repeat(2,minmax(0,1fr))}label{display:grid;gap:7px;font-size:13px}.check{display:flex;align-items:center;gap:8px}.check input{width:auto}input,textarea{box-sizing:border-box;width:100%;background:transparent;color:inherit;border:1px solid rgba(127,127,127,.3);border-radius:7px;padding:9px}textarea{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;resize:vertical}small{opacity:.55;line-height:1.4}.actions{display:flex;align-items:center;gap:12px}.primary,.ghost{border-radius:8px;padding:9px 14px;cursor:pointer}.primary{border:0;background:var(--accent-color,#6d7cff);color:white}.primary:disabled{opacity:.55;cursor:default}.ghost{background:transparent;color:inherit;border:1px solid rgba(127,127,127,.25)}.saved{color:#67c23a;font-size:13px}.error{padding:10px 12px;border-radius:8px;background:rgba(210,60,60,.14);color:#e66}.empty{padding:60px;text-align:center;opacity:.55}
@media(max-width:720px){.settings-page{padding:20px}.two{grid-template-columns:1fr}header{flex-direction:column}}
</style>
