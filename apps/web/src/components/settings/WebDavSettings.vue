<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type {
  WebDavSyncConfig,
  WebDavSyncDirection,
  WebDavSyncTreeNode,
} from '@yarc/shared'
import { useApi } from '@/composables/useApi'
import { useWebDavSyncStore } from '@/stores/webdavSync'
import WebDavTreeNode from './WebDavTreeNode.vue'

const api = useApi()
const syncStore = useWebDavSyncStore()

const defaultConfig = (): WebDavSyncConfig => ({
  enabled: false,
  url: '',
  username: '',
  remotePath: 'yarc-data',
  direction: 'bidirectional',
  syncAll: true,
  selectedPaths: [],
  excludePatterns: [],
  scheduleEnabled: false,
  intervalMinutes: 60,
  timeoutSeconds: 30,
})

const config = ref<WebDavSyncConfig>(defaultConfig())
const password = ref('')
const hasPassword = ref(false)
const clearPassword = ref(false)
const excludeText = ref('')
const protectedPatterns = ref<string[]>([])
const files = ref<WebDavSyncTreeNode[]>([])
const loading = ref(true)
const filesLoading = ref(false)
const saving = ref(false)
const testing = ref(false)
const syncing = ref(false)
const message = ref('')
const error = ref('')

const directionOptions: Array<{ value: WebDavSyncDirection; label: string; description: string }> = [
  { value: 'bidirectional', label: '双向同步', description: '根据上次同步记录判断变化；双方都修改时跳过并报告冲突。' },
  { value: 'upload', label: '仅上传', description: '以本地 data/ 为准，新增或更新远端文件。' },
  { value: 'download', label: '仅下载', description: '以远端为准，新增或更新本地文件。' },
]

const selectedDirection = computed(() => directionOptions.find(item => item.value === config.value.direction)!)
const status = computed(() => syncStore.status)
const selectedCount = computed(() => config.value.selectedPaths.length)
const progressPercent = computed(() => status.value.total > 0
  ? Math.round(status.value.processed / status.value.total * 100)
  : 0)

const statusLabel = computed(() => {
  if (status.value.phase === 'syncing') return '同步中'
  if (status.value.phase === 'testing') return '测试连接中'
  if (status.value.phase === 'error') return '同步异常'
  if (status.value.phase === 'success') return '同步完成'
  if (status.value.phase === 'disabled') return '未启用'
  return '等待同步'
})

const parsePatterns = () => [...new Set(excludeText.value
  .split('\n')
  .map(line => line.trim())
  .filter(line => line && !line.startsWith('#')))]

const currentConfig = (): WebDavSyncConfig => ({
  ...config.value,
  selectedPaths: [...config.value.selectedPaths],
  excludePatterns: parsePatterns(),
})

const formatDateTime = (value: string | null) => {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

const loadFiles = async () => {
  filesLoading.value = true
  try {
    const result = await api.getWebDavFiles()
    files.value = result.files
  } catch (err) {
    error.value = (err as Error).message || 'data/ 文件列表加载失败'
  } finally {
    filesLoading.value = false
  }
}

const load = async () => {
  loading.value = true
  error.value = ''
  syncStore.initialize()
  try {
    const result = await api.getWebDavConfig()
    config.value = {
      ...result.config,
      selectedPaths: [...result.config.selectedPaths],
      excludePatterns: [...result.config.excludePatterns],
    }
    excludeText.value = result.config.excludePatterns.join('\n')
    hasPassword.value = result.hasPassword
    protectedPatterns.value = [...result.protectedPatterns]
    if (!config.value.syncAll) await loadFiles()
  } catch (err) {
    error.value = (err as Error).message || 'WebDAV 设置加载失败'
  } finally {
    loading.value = false
  }
}

const togglePath = (path: string, selected: boolean) => {
  const next = new Set(config.value.selectedPaths)
  if (selected) {
    for (const existing of next) {
      if (existing.startsWith(`${path}/`)) next.delete(existing)
    }
    next.add(path)
  } else {
    next.delete(path)
  }
  config.value.selectedPaths = [...next].sort((a, b) => a.localeCompare(b))
}

const saveSettings = async (quiet = false) => {
  saving.value = true
  error.value = ''
  if (!quiet) message.value = ''
  try {
    const next = currentConfig()
    const result = await api.updateWebDavConfig({
      config: next,
      ...(password.value && !clearPassword.value ? { password: password.value } : {}),
      clearPassword: clearPassword.value,
    })
    config.value = {
      ...result.config,
      selectedPaths: [...result.config.selectedPaths],
      excludePatterns: [...result.config.excludePatterns],
    }
    excludeText.value = result.config.excludePatterns.join('\n')
    hasPassword.value = result.hasPassword
    protectedPatterns.value = [...result.protectedPatterns]
    password.value = ''
    clearPassword.value = false
    await syncStore.refreshStatus().catch(() => {})
    if (!quiet) message.value = 'WebDAV 同步设置已保存'
    return true
  } catch (err) {
    error.value = (err as Error).message || '设置保存失败'
    return false
  } finally {
    saving.value = false
  }
}

const testConnection = async () => {
  testing.value = true
  message.value = ''
  error.value = ''
  try {
    const result = await api.testWebDavConnection({
      config: currentConfig(),
      ...(clearPassword.value ? { password: '' } : password.value ? { password: password.value } : {}),
    })
    message.value = `${result.message}，延迟 ${result.latencyMs} ms`
    await syncStore.refreshStatus().catch(() => {})
  } catch (err) {
    error.value = (err as Error).message || 'WebDAV 连接测试失败'
  } finally {
    testing.value = false
  }
}

const syncNow = async () => {
  syncing.value = true
  message.value = ''
  error.value = ''
  try {
    if (!await saveSettings(true)) return
    const result = await syncStore.syncNow()
    message.value = `同步完成：上传 ${result.uploaded}，下载 ${result.downloaded}，跳过 ${result.skipped}，冲突 ${result.conflicts}，失败 ${result.failed}`
  } catch (err) {
    error.value = (err as Error).message || 'WebDAV 同步失败'
  } finally {
    syncing.value = false
  }
}

watch(() => config.value.syncAll, (syncAll) => {
  if (!syncAll && !files.value.length && !filesLoading.value) void loadFiles()
})

onMounted(() => {
  void load()
})
</script>

<template>
  <div class="webdav-settings">
    <div v-if="loading" class="loading-state">正在加载 WebDAV 同步设置…</div>

    <template v-else>
      <section class="settings-card status-card" :class="`phase-${status.phase}`">
        <div class="card-header status-header">
          <div>
            <h3>同步状态</h3>
            <p>{{ status.message }}</p>
          </div>
          <span class="status-badge"><span class="status-dot" />{{ statusLabel }}</span>
        </div>
        <div class="card-body">
          <div v-if="status.running" class="progress-track">
            <span :style="{ width: `${progressPercent}%` }" />
          </div>
          <div class="status-grid">
            <div><span>上次同步</span><strong>{{ formatDateTime(status.lastSyncAt) }}</strong></div>
            <div><span>下次同步</span><strong>{{ status.scheduled ? formatDateTime(status.nextSyncAt) : '未计划' }}</strong></div>
            <div><span>进度</span><strong>{{ status.running ? `${status.processed} / ${status.total}` : '—' }}</strong></div>
          </div>
          <div v-if="status.lastResult" class="result-summary">
            最近结果：上传 {{ status.lastResult.uploaded }} · 下载 {{ status.lastResult.downloaded }} ·
            跳过 {{ status.lastResult.skipped }} · 冲突 {{ status.lastResult.conflicts }} · 失败 {{ status.lastResult.failed }}
          </div>
          <div v-if="status.lastResult?.errors.length" class="error-list">
            <div v-for="item in status.lastResult.errors.slice(0, 8)" :key="`${item.action}:${item.path}`">
              <code>{{ item.path }}</code><span>{{ item.message }}</span>
            </div>
          </div>
        </div>
      </section>

      <section class="settings-card">
        <div class="card-header">
          <h3>WebDAV 连接</h3>
          <p>连接信息保存在服务端；已保存的密码不会返回浏览器。测试连接会确认可访问性，并在需要时创建远端目录。</p>
        </div>
        <div class="card-body form-grid">
          <label class="switch-row full-width">
            <span><strong>启用 WebDAV 同步</strong><small>启用后可手动同步，也可设置定时同步。</small></span>
            <input v-model="config.enabled" type="checkbox" />
          </label>

          <label class="field full-width">
            <span>WebDAV 地址</span>
            <input v-model.trim="config.url" type="url" placeholder="https://example.com/remote.php/dav/files/username" autocomplete="url" />
          </label>
          <label class="field">
            <span>用户名</span>
            <input v-model="config.username" type="text" autocomplete="username" />
          </label>
          <label class="field">
            <span>远端目录</span>
            <input v-model="config.remotePath" type="text" placeholder="yarc-data" />
          </label>
          <label class="field full-width">
            <span>密码 / 应用密码</span>
            <input
              v-model="password"
              type="password"
              :disabled="clearPassword"
              :placeholder="hasPassword ? '留空则保留已保存密码' : '输入 WebDAV 密码或应用密码'"
              autocomplete="new-password"
            />
          </label>
          <label v-if="hasPassword" class="clear-password full-width">
            <input v-model="clearPassword" type="checkbox" />
            保存时清除服务端已保存的密码
          </label>
          <label class="field compact-field">
            <span>请求超时</span>
            <div class="number-with-unit"><input v-model.number="config.timeoutSeconds" type="number" min="5" max="300" /><span>秒</span></div>
          </label>
          <div class="connection-actions full-width">
            <button class="btn secondary" :disabled="saving || syncing || testing || status.running" @click="testConnection">
              {{ testing ? '测试中…' : '测试连接' }}
            </button>
          </div>
        </div>
      </section>

      <section class="settings-card">
        <div class="card-header">
          <h3>同步范围与方向</h3>
          <p>本地同步根目录固定为 <code>data/</code>。同步不会删除本地或远端文件。</p>
        </div>
        <div class="card-body">
          <div class="direction-grid">
            <button
              v-for="option in directionOptions"
              :key="option.value"
              class="direction-option"
              :class="{ active: config.direction === option.value }"
              @click="config.direction = option.value"
            >
              <strong>{{ option.label }}</strong>
              <span>{{ option.description }}</span>
            </button>
          </div>
          <p class="selection-note">当前模式：{{ selectedDirection.label }}。双向首次遇到同名且内容不同的文件时，会根据修改时间判断；无法安全判断时报告冲突并跳过。</p>

          <label class="switch-row scope-switch">
            <span><strong>同步整个 data/</strong><small>关闭后，仅同步下方选中的文件或目录。</small></span>
            <input v-model="config.syncAll" type="checkbox" />
          </label>

          <div v-if="!config.syncAll" class="file-selection">
            <div class="selection-toolbar">
              <div><strong>选择文件</strong><span>已选择 {{ selectedCount }} 项；选择目录会包含全部后代。</span></div>
              <div>
                <button class="link-btn" :disabled="filesLoading" @click="loadFiles">刷新</button>
                <button class="link-btn" :disabled="!selectedCount" @click="config.selectedPaths = []">清空</button>
              </div>
            </div>
            <div v-if="config.selectedPaths.length" class="selected-paths">
              <span v-for="path in config.selectedPaths" :key="path"><code>{{ path }}</code><button @click="togglePath(path, false)">×</button></span>
            </div>
            <div class="file-tree">
              <div v-if="filesLoading" class="loading-state compact">正在扫描 data/…</div>
              <div v-else-if="!files.length" class="empty-state">data/ 下没有可选择的文件。</div>
              <template v-else>
                <WebDavTreeNode
                  v-for="node in files"
                  :key="node.path"
                  :node="node"
                  :selected-paths="config.selectedPaths"
                  @toggle="togglePath"
                />
              </template>
            </div>
          </div>
        </div>
      </section>

      <section class="settings-card">
        <div class="card-header">
          <h3>排除规则</h3>
          <p>每行一个通配规则，排除优先于文件选择。支持 <code>*</code>、<code>?</code> 和 <code>**</code>。</p>
        </div>
        <div class="card-body">
          <div v-if="protectedPatterns.length" class="protected-patterns">
            <strong>系统始终排除</strong>
            <span v-for="pattern in protectedPatterns" :key="pattern"><code>{{ pattern }}</code></span>
            <small>这些目录包含运行状态、认证信息或可重新生成的依赖，不会出现在选择树中，也不能通过自定义规则启用。</small>
          </div>
          <textarea
            v-model="excludeText"
            class="pattern-input"
            rows="7"
            spellcheck="false"
            placeholder="例如：\n*.tmp\n.cache\npapers/**/images/*\nfiles/private/**"
          />
          <div class="pattern-help">
            <span><code>*.tmp</code> 匹配任意目录下的临时文件</span>
            <span><code>papers/private/**</code> 排除整个目录树</span>
            <span>以 <code>#</code> 开头的行作为注释忽略</span>
          </div>
        </div>
      </section>

      <section class="settings-card">
        <div class="card-header">
          <h3>定时同步</h3>
          <p>服务运行期间按固定间隔执行；修改间隔后从保存时重新计时。</p>
        </div>
        <div class="card-body schedule-row">
          <label class="switch-row">
            <span><strong>启用定时同步</strong><small>仅在 WebDAV 同步总开关启用时生效。</small></span>
            <input v-model="config.scheduleEnabled" type="checkbox" />
          </label>
          <label class="field interval-field">
            <span>同步间隔</span>
            <div class="number-with-unit"><input v-model.number="config.intervalMinutes" type="number" min="5" max="10080" /><span>分钟</span></div>
          </label>
        </div>
      </section>

      <div v-if="message" class="feedback success">{{ message }}</div>
      <div v-if="error" class="feedback error">{{ error }}</div>

      <div class="footer-actions">
        <span>“立即同步”会先保存当前表单。同步过程不传播删除操作。</span>
        <div>
          <button class="btn secondary" :disabled="saving || syncing || testing || status.running" @click="saveSettings(false)">
            {{ saving && !syncing ? '保存中…' : '保存设置' }}
          </button>
          <button class="btn primary" :disabled="saving || syncing || testing || status.running || !config.enabled" @click="syncNow">
            {{ syncing || status.phase === 'syncing' ? '同步中…' : '立即同步' }}
          </button>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.webdav-settings { display: grid; gap: 16px; padding-bottom: 24px; }
.settings-card { border: 1px solid var(--color-border); border-radius: var(--radius); background: var(--color-bg-card); overflow: hidden; }
.card-header { padding: 18px 20px 14px; border-bottom: 1px solid var(--color-border); }
.card-header h3 { margin: 0; color: var(--color-text); font-size: 15px; }
.card-header p { margin: 5px 0 0; color: var(--color-text-muted); font-size: 12px; line-height: 1.55; }
.card-header code,
.card-body code { padding: 1px 5px; border-radius: 4px; background: var(--color-bg-muted); color: var(--color-text-secondary); font-size: 11px; }
.card-body { padding: 18px 20px; }
.status-header { display: flex; align-items: center; justify-content: space-between; gap: 14px; }
.status-badge { display: inline-flex; align-items: center; gap: 7px; padding: 5px 10px; border-radius: 999px; background: var(--color-bg-muted); color: var(--color-text-secondary); font-size: 12px; white-space: nowrap; }
.status-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--color-text-muted); }
.phase-syncing .status-dot,
.phase-testing .status-dot { background: var(--color-primary); animation: pulse 1s ease-in-out infinite; }
.phase-success .status-dot { background: #22c55e; }
.phase-error .status-dot { background: #ef4444; }
.progress-track { height: 5px; overflow: hidden; border-radius: 99px; background: var(--color-bg-muted); margin-bottom: 16px; }
.progress-track span { display: block; height: 100%; border-radius: inherit; background: var(--color-primary); transition: width 180ms ease; }
.status-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.status-grid > div { display: grid; gap: 4px; padding: 10px 12px; border-radius: 8px; background: var(--color-bg-muted); }
.status-grid span { color: var(--color-text-muted); font-size: 11px; }
.status-grid strong { color: var(--color-text-secondary); font-size: 12px; overflow: hidden; text-overflow: ellipsis; }
.result-summary { margin-top: 12px; color: var(--color-text-secondary); font-size: 12px; }
.error-list { display: grid; gap: 6px; margin-top: 12px; padding: 10px 12px; border-radius: 8px; background: color-mix(in srgb, #ef4444 8%, transparent); }
.error-list > div { display: flex; gap: 8px; align-items: baseline; color: #dc2626; font-size: 11px; }
.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px 16px; }
.full-width { grid-column: 1 / -1; }
.field { display: grid; gap: 6px; color: var(--color-text-secondary); font-size: 12px; font-weight: 600; }
.field input,
.pattern-input { width: 100%; box-sizing: border-box; border: 1px solid var(--color-border); border-radius: 7px; background: var(--color-bg); color: var(--color-text); font: inherit; font-weight: 400; outline: none; }
.field input { height: 36px; padding: 0 10px; }
.field input:focus,
.pattern-input:focus { border-color: var(--color-primary); box-shadow: 0 0 0 2px var(--color-primary-soft); }
.field input:disabled { opacity: .55; cursor: not-allowed; }
.switch-row { display: flex; align-items: center; justify-content: space-between; gap: 20px; color: var(--color-text); }
.switch-row > span { display: grid; gap: 3px; }
.switch-row strong { font-size: 13px; }
.switch-row small { color: var(--color-text-muted); font-size: 11px; font-weight: 400; line-height: 1.45; }
.switch-row input { width: 38px; height: 20px; accent-color: var(--color-primary); flex: 0 0 auto; }
.clear-password { display: flex; align-items: center; gap: 7px; color: var(--color-text-muted); font-size: 11px; }
.clear-password input { accent-color: #ef4444; }
.number-with-unit { display: flex; align-items: center; gap: 7px; }
.number-with-unit input { min-width: 0; }
.number-with-unit span { color: var(--color-text-muted); font-size: 11px; font-weight: 400; }
.connection-actions { display: flex; justify-content: flex-start; }
.btn { min-height: 34px; padding: 0 14px; border-radius: 7px; border: 1px solid transparent; font-size: 12px; font-weight: 600; cursor: pointer; }
.btn:disabled { opacity: .5; cursor: not-allowed; }
.btn.primary { background: var(--color-primary); color: white; }
.btn.secondary { border-color: var(--color-border); background: var(--color-bg-card); color: var(--color-text-secondary); }
.btn.secondary:hover:not(:disabled) { border-color: var(--color-primary); color: var(--color-primary); }
.direction-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.direction-option { display: grid; gap: 5px; padding: 12px; text-align: left; border: 1px solid var(--color-border); border-radius: 8px; background: var(--color-bg); color: var(--color-text-secondary); cursor: pointer; }
.direction-option strong { color: var(--color-text); font-size: 12px; }
.direction-option span { font-size: 11px; line-height: 1.5; color: var(--color-text-muted); }
.direction-option.active { border-color: var(--color-primary); background: var(--color-primary-soft); }
.selection-note { margin: 10px 0 16px; color: var(--color-text-muted); font-size: 11px; line-height: 1.55; }
.scope-switch { padding-top: 14px; border-top: 1px solid var(--color-border); }
.file-selection { margin-top: 14px; border: 1px solid var(--color-border); border-radius: 8px; overflow: hidden; }
.selection-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 12px; border-bottom: 1px solid var(--color-border); }
.selection-toolbar > div:first-child { display: grid; gap: 2px; }
.selection-toolbar strong { color: var(--color-text); font-size: 12px; }
.selection-toolbar span { color: var(--color-text-muted); font-size: 10px; }
.link-btn { border: none; background: transparent; color: var(--color-primary); font-size: 11px; cursor: pointer; }
.link-btn:disabled { opacity: .5; cursor: not-allowed; }
.selected-paths { display: flex; flex-wrap: wrap; gap: 6px; padding: 9px 12px; border-bottom: 1px solid var(--color-border); background: var(--color-bg-muted); }
.selected-paths > span { display: inline-flex; align-items: center; gap: 4px; max-width: 100%; }
.selected-paths code { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.selected-paths button { border: none; background: transparent; color: var(--color-text-muted); cursor: pointer; }
.file-tree { max-height: 360px; overflow: auto; padding: 7px; }
.empty-state,
.loading-state { padding: 24px; color: var(--color-text-muted); text-align: center; font-size: 12px; }
.loading-state.compact { padding: 14px; }
.protected-patterns { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-bottom: 12px; padding: 10px 11px; border-radius: 7px; background: var(--color-bg-muted); color: var(--color-text-secondary); font-size: 11px; }
.protected-patterns strong { margin-right: 2px; font-size: 11px; }
.protected-patterns small { flex-basis: 100%; color: var(--color-text-muted); font-size: 10px; line-height: 1.5; }
.pattern-input { resize: vertical; min-height: 130px; padding: 10px 11px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.6; }
.pattern-help { display: flex; flex-wrap: wrap; gap: 8px 18px; margin-top: 9px; color: var(--color-text-muted); font-size: 10px; }
.schedule-row { display: grid; grid-template-columns: minmax(0, 1fr) 180px; align-items: end; gap: 20px; }
.feedback { padding: 10px 12px; border-radius: 7px; font-size: 12px; }
.feedback.success { background: color-mix(in srgb, #22c55e 10%, transparent); color: #16a34a; }
.feedback.error { background: color-mix(in srgb, #ef4444 10%, transparent); color: #dc2626; }
.footer-actions { position: sticky; bottom: 0; z-index: 2; display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 14px; border: 1px solid var(--color-border); border-radius: 9px; background: color-mix(in srgb, var(--color-bg-card) 94%, transparent); backdrop-filter: blur(10px); }
.footer-actions > span { color: var(--color-text-muted); font-size: 10px; }
.footer-actions > div { display: flex; gap: 8px; flex-shrink: 0; }
@keyframes pulse { 50% { opacity: .35; transform: scale(.85); } }
@media (max-width: 760px) {
  .form-grid,
  .direction-grid,
  .status-grid,
  .schedule-row { grid-template-columns: 1fr; }
  .full-width { grid-column: auto; }
  .footer-actions { align-items: flex-start; flex-direction: column; }
  .footer-actions > div { width: 100%; }
  .footer-actions .btn { flex: 1; }
}
</style>
