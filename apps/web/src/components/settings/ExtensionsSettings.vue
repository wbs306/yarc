<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useApi } from '@/composables/useApi'

const api = useApi()

interface Extension {
  id: string
  name: string
  source: string
  type: 'npm' | 'git' | 'local'
  enabled: boolean
  installed: boolean
  description: string | null
  version: string | null
  packageName: string | null
  entryFile: string | null
}

const extensions = ref<Extension[]>([])
const paths = ref<{ extensionsDir: string; npmDir: string }>({ extensionsDir: '', npmDir: '' })
const loading = ref(false)
const error = ref('')
const actionLoading = ref('')

// Install form
const showInstallForm = ref(false)
const installSource = ref('')
const installLoading = ref(false)
const installError = ref('')
const uploadLoading = ref(false)

const typeLabels: Record<string, string> = { npm: 'npm', git: 'Git', local: '本地' }
const typeIcons: Record<string, string> = { npm: '📦', git: '🔗', local: '📁' }

const fetchExtensions = async () => {
  loading.value = true
  error.value = ''
  try {
    const res = await api.getExtensions()
    extensions.value = res.extensions || []
    paths.value = res.paths || { extensionsDir: '', npmDir: '' }
  } catch (err) {
    error.value = (err as Error).message || '加载失败'
  } finally {
    loading.value = false
  }
}

const toggleExtension = async (ext: Extension) => {
  actionLoading.value = ext.id
  error.value = ''
  try {
    if (ext.enabled) {
      await api.disableExtension(ext.id)
    } else {
      await api.enableExtension(ext.id)
    }
    await fetchExtensions()
  } catch (err) {
    error.value = (err as Error).message || '操作失败'
  } finally {
    actionLoading.value = ''
  }
}

const uninstallExtension = async (ext: Extension) => {
  if (!confirm(`确定卸载 "${ext.name}"？${ext.type !== 'local' ? '已安装的文件也会被删除。' : ''}`)) return
  actionLoading.value = ext.id
  error.value = ''
  try {
    await api.uninstallExtension(ext.id)
    await fetchExtensions()
  } catch (err) {
    error.value = (err as Error).message || '卸载失败'
  } finally {
    actionLoading.value = ''
  }
}

const doInstall = async () => {
  if (!installSource.value.trim()) return
  installLoading.value = true
  installError.value = ''
  try {
    await api.installExtension(installSource.value.trim())
    installSource.value = ''
    showInstallForm.value = false
    await fetchExtensions()
  } catch (err) {
    installError.value = (err as Error).message || '安装失败'
  } finally {
    installLoading.value = false
  }
}

const doUpload = async (event: Event) => {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  uploadLoading.value = true
  installError.value = ''
  try {
    const form = new FormData()
    form.append('file', file)
    const res = await fetch('/api/extensions/upload', { method: 'POST', body: form })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error?.message || '上传失败')
    await fetchExtensions()
  } catch (err) {
    installError.value = (err as Error).message || '上传失败'
  } finally {
    uploadLoading.value = false
    input.value = ''
  }
}

const placeholders = [
  'npm:pi-subagents',
  'git:github.com/user/repo',
  '/absolute/path/to/extension',
  './relative/path/to/extension',
]
const placeholder = placeholders[Math.floor(Math.random() * placeholders.length)]

onMounted(fetchExtensions)
</script>

<template>
  <div class="extensions-settings">
    <div class="extensions-header">
      <h4>插件管理</h4>
      <div class="header-actions">
        <button class="ext-btn" :disabled="loading" @click="fetchExtensions">
          {{ loading ? '加载中…' : '刷新' }}
        </button>
        <button class="ext-btn primary" @click="showInstallForm = !showInstallForm">
          {{ showInstallForm ? '取消' : '安装插件' }}
        </button>
      </div>
    </div>

    <div v-if="error" class="ext-error">{{ error }}</div>

    <!-- Install form -->
    <div v-if="showInstallForm" class="install-form">
      <div class="install-field">
        <label>来源</label>
        <input
          v-model="installSource"
          type="text"
          :placeholder="placeholder"
          @keydown.enter="doInstall"
        />
        <div class="install-hint">
          支持：<code>npm:pkg</code>、<code>git:url</code>、<code>/path</code>、<code>./path</code>
        </div>
      </div>
      <div v-if="installError" class="ext-error">{{ installError }}</div>
      <div class="install-actions">
        <button class="ext-btn primary" :disabled="installLoading || !installSource.trim()" @click="doInstall">
          {{ installLoading ? '安装中…' : '安装' }}
        </button>
        <label class="ext-btn" :class="{ disabled: uploadLoading }">
          {{ uploadLoading ? '上传中…' : '上传文件' }}
          <input
            type="file"
            accept=".ts,.js,.zip,.tar.gz,.tgz"
            style="display: none"
            @change="doUpload"
          />
        </label>
      </div>
    </div>

    <!-- Extensions list -->
    <div v-if="!extensions.length && !loading" class="ext-empty">
      暂无已安装的插件。点击「安装插件」添加。
    </div>

    <div class="ext-list">
      <div v-for="ext in extensions" :key="ext.id" class="ext-item" :class="{ disabled: !ext.enabled }">
        <div class="ext-info">
          <div class="ext-name-row">
            <span class="ext-type-badge">{{ typeIcons[ext.type] || '📄' }} {{ typeLabels[ext.type] || ext.type }}</span>
            <span class="ext-name">{{ ext.name }}</span>
            <span v-if="ext.version" class="ext-version">v{{ ext.version }}</span>
            <span :class="['ext-status', ext.enabled && ext.installed ? 'enabled' : 'disabled']">
              {{ !ext.installed ? '未安装' : ext.enabled ? '已启用' : '已停用' }}
            </span>
          </div>
          <div v-if="ext.description" class="ext-desc">{{ ext.description }}</div>
          <div class="ext-meta">
            <span v-if="ext.packageName && ext.packageName !== ext.name" class="ext-meta-item">{{ ext.packageName }}</span>
          </div>
        </div>
        <div class="ext-actions">
          <button
            v-if="ext.installed"
            class="ext-btn"
            :disabled="!!actionLoading"
            @click="toggleExtension(ext)"
          >
            {{ actionLoading === ext.id ? '…' : (ext.enabled ? '停用' : '启用') }}
          </button>
          <button
            class="ext-btn danger"
            :disabled="!!actionLoading"
            @click="uninstallExtension(ext)"
          >
            {{ actionLoading === ext.id ? '…' : '卸载' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.extensions-settings {
  padding: 22px;
  border: 1px solid color-mix(in srgb, var(--color-border) 88%, transparent);
  border-radius: 13px;
  background: color-mix(in srgb, var(--color-bg-muted) 34%, var(--color-bg-card));
}
.extensions-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 20px;
}
.extensions-header h4 {
  margin: 0;
  font-size: 16px;
  font-weight: 650;
  letter-spacing: -0.01em;
}
.header-actions { display: flex; gap: 8px; }

.ext-error {
  padding: 8px 12px;
  margin-bottom: 12px;
  background: rgba(239,68,68,0.08);
  border: 1px solid rgba(239,68,68,0.2);
  border-radius: var(--radius-sm);
  color: var(--color-error);
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
}

.ext-empty { color: var(--color-text-muted); font-size: 13px; padding: 16px 0; }

.install-form {
  padding: 16px;
  margin-bottom: 18px;
  background: var(--color-bg-muted);
  border-radius: var(--radius-sm);
  border: 1px solid var(--color-border);
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.install-field { display: flex; flex-direction: column; gap: 7px; }
.install-field label { font-size: 12px; color: var(--color-text-muted); font-weight: 600; }
.install-field input {
  min-height: 38px;
  padding: 9px 11px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg);
  color: var(--color-text);
  font-size: 13px;
  font-family: ui-monospace, monospace;
}
.install-field input:focus { outline: none; border-color: var(--color-primary); }
.install-hint { font-size: 11px; color: var(--color-text-muted); }
.install-hint code { padding: 1px 4px; background: var(--color-bg); border-radius: 3px; font-size: 10px; }
.install-actions { display: flex; justify-content: flex-end; }

.ext-list { display: flex; flex-direction: column; gap: 10px; }
.ext-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  min-height: 72px;
  padding: 14px 16px;
  border: 1px solid var(--color-border);
  border-radius: 11px;
  background: var(--color-bg-card);
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.ext-item:hover {
  border-color: var(--color-border-hover);
  box-shadow: 0 5px 16px rgba(15, 23, 42, 0.05);
}
.ext-item.disabled { opacity: 0.6; }
.ext-info { flex: 1; min-width: 0; }
.ext-name-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ext-type-badge { font-size: 11px; color: var(--color-text-muted); }
.ext-name { font-weight: 620; font-size: 14px; color: var(--color-text); }
.ext-version { font-size: 11px; color: var(--color-text-muted); font-family: ui-monospace, monospace; }
.ext-status { padding: 1px 7px; border-radius: 999px; font-size: 10px; font-weight: 600; }
.ext-status.enabled { background: rgba(34,197,94,0.12); color: #16a34a; }
.ext-status.disabled { background: rgba(156,163,175,0.12); color: #6b7280; }
.ext-desc { font-size: 12px; color: var(--color-text-secondary); margin-top: 4px; line-height: 1.45; }
.ext-meta { display: flex; gap: 10px; margin-top: 2px; }
.ext-meta-item { font-size: 11px; color: var(--color-text-muted); }

.ext-actions { display: flex; gap: 6px; flex-shrink: 0; }
.ext-btn {
  min-height: 34px;
  padding: 6px 13px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg);
  color: var(--color-text-secondary);
  font-size: 12px;
  cursor: pointer;
}
.ext-btn:hover { border-color: var(--color-primary); color: var(--color-primary); }
.ext-btn.danger:hover { border-color: var(--color-error); color: var(--color-error); }
.ext-btn:disabled { opacity: 0.5; cursor: default; }
.ext-btn.primary { background: var(--color-primary); color: #fff; border-color: var(--color-primary); }
.ext-btn.primary:hover { opacity: 0.9; }

@media (max-width: 640px) {
  .extensions-settings { padding: 18px; }
  .extensions-header,
  .ext-item { align-items: flex-start; }
  .extensions-header,
  .ext-item { flex-direction: column; }
  .header-actions,
  .ext-actions { width: 100%; }
  .header-actions .ext-btn,
  .ext-actions .ext-btn { flex: 1; }
}
</style>
