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
  paused: false,
  url: '',
  username: '',
  remotePath: 'yarc-data',
  direction: 'bidirectional',
  syncAll: true,
  selectedPaths: [],
  excludePatterns: [],
  scheduleEnabled: false,
  intervalMinutes: 60,
  syncOnLocalChange: false,
  propagateLocalDeletions: false,
  localChangeDebounceSeconds: 10,
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
const pausing = ref(false)
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
  if (status.value.phase === 'paused') return '已暂停'
  if (status.value.phase === 'pending') return '等待自动同步'
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

const togglePaused = async () => {
  pausing.value = true
  message.value = ''
  error.value = ''
  try {
    const resuming = status.value.phase === 'paused'
    if (resuming) {
      // Resume only after persisting the latest selection and exclusion rules,
      // so files changed while paused cannot be synced with stale settings.
      if (!await saveSettings(true)) return
      if (!config.value.enabled) {
        message.value = '设置已保存，WebDAV 同步已关闭'
        return
      }
    }
    const result = await syncStore.setPaused(!resuming)
    config.value.paused = result.config.paused
    protectedPatterns.value = [...result.protectedPatterns]
    message.value = result.config.paused ? 'WebDAV 同步已暂停' : 'WebDAV 同步已恢复'
  } catch (err) {
    error.value = (err as Error).message || '同步暂停状态修改失败'
  } finally {
    pausing.value = false
  }
}

const syncNow = async () => {
  syncing.value = true
  message.value = ''
  error.value = ''
  try {
    if (!await saveSettings(true)) return
    const result = await syncStore.syncNow()
    message.value = `同步完成：上传 ${result.uploaded}，下载 ${result.downloaded}，删除远端 ${result.deleted}，跳过 ${result.skipped}，冲突 ${result.conflicts}，失败 ${result.failed}`
  } catch (err) {
    error.value = (err as Error).message || 'WebDAV 同步失败'
  } finally {
    syncing.value = false
  }
}

watch(() => config.value.syncAll, (syncAll) => {
  if (!syncAll && !files.value.length && !filesLoading.value) void loadFiles()
})

watch(() => config.value.direction, (direction) => {
  if (direction === 'download') {
    config.value.syncOnLocalChange = false
    config.value.propagateLocalDeletions = false
  }
})

watch(() => status.value.phase, (phase) => {
  if (phase === 'paused') config.value.paused = true
  else if (['idle', 'pending', 'success', 'error'].includes(phase)) config.value.paused = false
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
          <div class="status-actions">
            <span class="status-badge"><span class="status-dot" />{{ statusLabel }}</span>
            <button
              v-if="status.enabled"
              class="pause-btn"
              :class="{ resume: status.phase === 'paused' }"
              :disabled="pausing || saving || testing || syncing || status.running"
              @click="togglePaused"
            >
              {{ pausing ? '处理中…' : status.phase === 'paused' ? '恢复同步' : '暂停同步' }}
            </button>
          </div>
        </div>
        <div class="card-body">
          <div v-if="status.running" class="progress-track">
            <span :style="{ width: `${progressPercent}%` }" />
          </div>
          <div class="status-grid">
            <div><span>上次同步</span><strong>{{ formatDateTime(status.lastSyncAt) }}</strong></div>
            <div><span>下次定时同步</span><strong>{{ status.scheduled ? formatDateTime(status.nextSyncAt) : '未计划' }}</strong></div>
            <div><span>本地变化</span><strong>{{ status.watchingLocalChanges ? (status.pendingLocalChanges ? `${status.pendingLocalChanges} 项待同步` : '监听中') : '未监听' }}</strong></div>
            <div><span>进度</span><strong>{{ status.running ? `${status.processed} / ${status.total}` : '—' }}</strong></div>
          </div>
          <div v-if="status.lastResult" class="result-summary">
            最近结果：上传 {{ status.lastResult.uploaded }} · 下载 {{ status.lastResult.downloaded }} ·
            删除远端 {{ status.lastResult.deleted ?? 0 }} · 跳过 {{ status.lastResult.skipped }} ·
            冲突 {{ status.lastResult.conflicts }} · 失败 {{ status.lastResult.failed }}
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
            <span><strong>启用 WebDAV 同步</strong><small>启用后可手动同步，也可按间隔或本地文件变化自动同步。</small></span>
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
            <button class="btn secondary" :disabled="saving || syncing || testing || pausing || status.running" @click="testConnection">
              {{ testing ? '测试中…' : '测试连接' }}
            </button>
          </div>
        </div>
      </section>

      <section class="settings-card">
        <div class="card-header">
          <h3>同步范围与方向</h3>
          <p>本地同步根目录固定为 <code>data/</code>。默认不传播删除；开启下方选项后，仅会删除此前成功同步且远端未变化的文件。</p>
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

          <label class="switch-row deletion-switch">
            <span><strong>同步本地删除到远端</strong><small>开启后，仅删除此前成功同步且远端没有变化的文件；远端独有文件和删除冲突会保留。</small></span>
            <input v-model="config.propagateLocalDeletions" type="checkbox" :disabled="config.direction === 'download'" />
          </label>
          <p v-if="config.direction === 'download'" class="deletion-note">仅下载模式不会执行远端删除。</p>
          <p v-else class="deletion-note warning">这是破坏性操作；开启后，自动同步也会将符合条件的本地删除同步到远端。</p>

          <div class="scope-panel" :class="{ expanded: !config.syncAll }">
            <label class="switch-row scope-switch">
              <span><strong>同步整个 data/</strong><small>关闭后，仅同步下方选中的文件或目录。</small></span>
              <input v-model="config.syncAll" type="checkbox" />
            </label>

            <div v-if="!config.syncAll" class="file-selection">
              <div class="webdav-selection-toolbar">
                <div><strong>选择文件或目录</strong><span>已选择 {{ selectedCount }} 项；选择目录会包含全部后代。</span></div>
                <div class="selection-actions">
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
            <small>这些路径包含运行状态、认证信息或可重新生成的依赖，不会出现在选择树中，也不能通过自定义规则启用；其余 .pi 配置仍可监听和同步。</small>
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
          <h3>自动同步</h3>
          <p>可以同时启用固定间隔同步和本地文件变化同步，两种方式共用同一个同步队列。</p>
        </div>
        <div class="card-body auto-sync-options">
          <div class="auto-sync-row">
            <label class="switch-row">
              <span><strong>启用定时同步</strong><small>服务运行期间按固定间隔执行；手动同步后重新计时。</small></span>
              <input v-model="config.scheduleEnabled" type="checkbox" />
            </label>
            <label class="field interval-field">
              <span>同步间隔</span>
              <div class="number-with-unit"><input v-model.number="config.intervalMinutes" type="number" min="5" max="10080" /><span>分钟</span></div>
            </label>
          </div>
          <div class="auto-sync-row">
            <label class="switch-row">
              <span><strong>本地变化后同步</strong><small>监听选中范围内的新建和修改；开启上方选项后，也会将本地删除纳入自动同步。</small></span>
              <input v-model="config.syncOnLocalChange" type="checkbox" :disabled="config.direction === 'download'" />
            </label>
            <label class="field interval-field" :class="{ disabled: config.direction === 'download' }">
              <span>静默等待</span>
              <div class="number-with-unit"><input v-model.number="config.localChangeDebounceSeconds" type="number" min="2" max="300" :disabled="config.direction === 'download'" /><span>秒</span></div>
            </label>
          </div>
          <p v-if="config.direction === 'download'" class="auto-sync-note">仅下载模式不会启用本地变化同步，避免本地编辑触发远端覆盖。</p>
          <p v-else class="auto-sync-note">连续写入会合并且不会无限推迟；WebDAV 自身下载产生的文件事件会被忽略，避免循环同步。</p>
        </div>
      </section>

      <div v-if="message" class="feedback success">{{ message }}</div>
      <div v-if="error" class="feedback error">{{ error }}</div>

      <div class="footer-actions">
        <span>“立即同步”会先保存当前表单。远端删除仅在启用“同步本地删除到远端”且满足安全条件时执行。</span>
        <div>
          <button class="btn secondary" :disabled="saving || syncing || testing || pausing || status.running" @click="saveSettings(false)">
            {{ saving && !syncing ? '保存中…' : '保存设置' }}
          </button>
          <button class="btn primary" :disabled="saving || syncing || testing || pausing || status.running || !config.enabled || status.phase === 'paused'" @click="syncNow">
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
.status-actions { display: flex; align-items: center; gap: 8px; }
.status-badge { display: inline-flex; align-items: center; gap: 7px; padding: 5px 10px; border-radius: 999px; background: var(--color-bg-muted); color: var(--color-text-secondary); font-size: 12px; white-space: nowrap; }
.pause-btn { min-height: 28px; padding: 0 10px; border: 1px solid var(--color-border); border-radius: 7px; background: var(--color-bg-card); color: var(--color-text-secondary); font-size: 11px; font-weight: 600; cursor: pointer; }
.pause-btn:hover:not(:disabled) { border-color: #f59e0b; color: #d97706; }
.pause-btn.resume { border-color: color-mix(in srgb, #22c55e 35%, var(--color-border)); color: #16a34a; }
.pause-btn.resume:hover:not(:disabled) { border-color: #22c55e; color: #15803d; }
.pause-btn:disabled { opacity: .5; cursor: not-allowed; }
.status-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--color-text-muted); }
.phase-syncing .status-dot,
.phase-testing .status-dot { background: var(--color-primary); animation: pulse 1s ease-in-out infinite; }
.phase-pending .status-dot { background: #f59e0b; animation: pulse 1.4s ease-in-out infinite; }
.phase-paused .status-dot { background: #f59e0b; }
.phase-success .status-dot { background: #22c55e; }
.phase-error .status-dot { background: #ef4444; }
.progress-track { height: 5px; overflow: hidden; border-radius: 99px; background: var(--color-bg-muted); margin-bottom: 16px; }
.progress-track span { display: block; height: 100%; border-radius: inherit; background: var(--color-primary); transition: width 180ms ease; }
.status-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
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
.deletion-switch { margin-bottom: 6px; padding: 11px 13px; border: 1px solid color-mix(in srgb, #ef4444 24%, var(--color-border)); border-radius: 8px; background: color-mix(in srgb, #ef4444 4%, var(--color-bg)); }
.deletion-note { margin: 0 0 14px; color: var(--color-text-muted); font-size: 10px; line-height: 1.5; }
.deletion-note.warning { color: #b45309; }
.scope-panel { overflow: hidden; border: 1px solid var(--color-border); border-radius: 8px; background: var(--color-bg); }
.scope-panel.expanded { border-color: color-mix(in srgb, var(--color-primary) 28%, var(--color-border)); }
.scope-switch { min-height: 62px; padding: 11px 13px; }
.file-selection { border-top: 1px solid var(--color-border); background: var(--color-bg-card); }
.webdav-selection-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 12px; border-bottom: 1px solid var(--color-border); background: var(--color-bg-muted); }
.selection-actions { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
.webdav-selection-toolbar > div:first-child { display: grid; gap: 2px; }
.webdav-selection-toolbar strong { color: var(--color-text); font-size: 12px; }
.webdav-selection-toolbar span { color: var(--color-text-muted); font-size: 10px; }
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
.auto-sync-options { display: grid; gap: 16px; }
.auto-sync-row { display: grid; grid-template-columns: minmax(0, 1fr) 180px; align-items: end; gap: 20px; padding-bottom: 16px; border-bottom: 1px solid var(--color-border); }
.auto-sync-row:last-of-type { padding-bottom: 0; border-bottom: none; }
.auto-sync-note { margin: 0; color: var(--color-text-muted); font-size: 10px; line-height: 1.55; }
.field.disabled { opacity: .55; }
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
  .auto-sync-row { grid-template-columns: 1fr; }
  .full-width { grid-column: auto; }
  .status-header { align-items: flex-start; }
  .status-actions { align-items: flex-end; flex-direction: column; }
  .footer-actions { align-items: flex-start; flex-direction: column; }
  .footer-actions > div { width: 100%; }
  .footer-actions .btn { flex: 1; }
}
</style>
