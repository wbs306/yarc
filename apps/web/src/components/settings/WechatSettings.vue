<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { useApi } from '@/composables/useApi'

const api = useApi()

interface WechatStatus {
  runtimePluginExists: boolean
  runtimePluginPath: string
  storageDir: string
  storageExists: boolean
  bridgeLoaded: boolean
  diagnostics: string[]
  status: {
    loaded: boolean
    connected: boolean
    loginState: string
    accountId: string | null
    userId: string | null
    activeUserId: string | null
    isStreaming: boolean
    lastQrUrl: string | null
    lastError: string | null
    updatedAt: string
  } | null
}

const status = ref<WechatStatus | null>(null)
const loading = ref(false)
const actionLoading = ref('')
const error = ref('')

const loginStateLabels: Record<string, string> = {
  idle: '未连接',
  connecting: '连接中…',
  qr_waiting: '等待扫码',
  scanned: '已扫码待确认',
  connected: '已连接',
  disconnected: '已断开',
  expired: '已过期',
  error: '错误',
}

const loginStateClass: Record<string, string> = {
  idle: 'muted',
  connecting: 'info',
  qr_waiting: 'warning',
  scanned: 'info',
  connected: 'success',
  disconnected: 'muted',
  expired: 'warning',
  error: 'error',
}

const fetchStatus = async () => {
  loading.value = true
  error.value = ''
  try {
    status.value = await api.getWechatStatus()
  } catch (err) {
    error.value = (err as Error).message || '加载失败'
  } finally {
    loading.value = false
  }
}

const doLogin = async (force = false) => {
  actionLoading.value = 'login'
  error.value = ''
  try {
    const result = await api.loginWechat(force)
    if (result.status) {
      // Update local status
      if (status.value) status.value.status = result.status
    }
  } catch (err) {
    error.value = (err as Error).message || '登录失败'
  } finally {
    actionLoading.value = ''
  }
}

const doLogout = async () => {
  actionLoading.value = 'logout'
  error.value = ''
  try {
    const result = await api.logoutWechat()
    if (result.status && status.value) {
      status.value.status = result.status
    }
  } catch (err) {
    error.value = (err as Error).message || '断开失败'
  } finally {
    actionLoading.value = ''
  }
}

const doReconnect = async () => {
  actionLoading.value = 'reconnect'
  error.value = ''
  try {
    const result = await api.reconnectWechat(true)
    if (result.status && status.value) {
      status.value.status = result.status
    }
  } catch (err) {
    error.value = (err as Error).message || '重连失败'
  } finally {
    actionLoading.value = ''
  }
}

const doInit = async () => {
  actionLoading.value = 'init'
  error.value = ''
  try {
    await api.initWechatExtension()
    await fetchStatus()
  } catch (err) {
    error.value = (err as Error).message || '初始化失败'
  } finally {
    actionLoading.value = ''
  }
}

// Listen for SSE wechat-status events
const onWechatSseEvent = (e: Event) => {
  const detail = (e as CustomEvent).detail
  if (!detail?.status) return
  if (status.value) {
    status.value.status = detail.status
  }
}

onMounted(() => {
  fetchStatus()
  window.addEventListener('yarc-wechat-status', onWechatSseEvent)
})

onBeforeUnmount(() => {
  window.removeEventListener('yarc-wechat-status', onWechatSseEvent)
})
</script>

<template>
  <div class="wechat-settings">
    <div class="wechat-header">
      <h4>微信接入 / WeChat</h4>
      <button class="refresh-btn" :disabled="loading" @click="fetchStatus">
        {{ loading ? '加载中…' : '刷新状态' }}
      </button>
    </div>

    <div v-if="error" class="wechat-error">{{ error }}</div>

    <div v-if="!status" class="wechat-loading">加载中…</div>

    <template v-else>
      <!-- Plugin status -->
      <div class="wechat-section">
        <div class="section-title">插件状态</div>
        <div class="status-grid">
          <div class="status-row">
            <span class="status-label">运行时插件</span>
            <span :class="['status-value', status.runtimePluginExists ? 'ok' : 'warn']">
              {{ status.runtimePluginExists ? '✓ 已安装' : '✗ 未安装' }}
            </span>
          </div>
          <div class="status-row">
            <span class="status-label">Bridge 已加载</span>
            <span :class="['status-value', status.bridgeLoaded ? 'ok' : 'muted']">
              {{ status.bridgeLoaded ? '✓ 是' : '未加载' }}
            </span>
          </div>
          <div class="status-row">
            <span class="status-label">凭据存储</span>
            <span class="status-value path" :title="status.storageDir">
              {{ status.storageDir }}
              <span v-if="status.storageExists" class="storage-ok">✓</span>
            </span>
          </div>
        </div>
      </div>

      <!-- Diagnostics -->
      <div v-if="status.diagnostics.length" class="wechat-section">
        <div class="section-title">诊断</div>
        <ul class="diagnostics-list">
          <li v-for="(diag, i) in status.diagnostics" :key="i">{{ diag }}</li>
        </ul>
      </div>

      <!-- Login status -->
      <div v-if="status.status" class="wechat-section">
        <div class="section-title">连接状态</div>
        <div class="status-grid">
          <div class="status-row">
            <span class="status-label">状态</span>
            <span :class="['status-badge', loginStateClass[status.status.loginState] || 'muted']">
              {{ loginStateLabels[status.status.loginState] || status.status.loginState }}
            </span>
          </div>
          <div v-if="status.status.accountId" class="status-row">
            <span class="status-label">账号</span>
            <span class="status-value">{{ status.status.accountId }}</span>
          </div>
          <div v-if="status.status.userId" class="status-row">
            <span class="status-label">用户</span>
            <span class="status-value">{{ status.status.userId }}</span>
          </div>
          <div v-if="status.status.lastError" class="status-row">
            <span class="status-label">错误</span>
            <span class="status-value error">{{ status.status.lastError }}</span>
          </div>
        </div>

        <!-- QR Code -->
        <div v-if="status.status.lastQrUrl && status.status.loginState === 'qr_waiting'" class="qr-section">
          <div class="qr-title">请使用微信扫描二维码</div>
          <div class="qr-hint">在终端也可看到二维码（如需复制 URL：{{ status.status.lastQrUrl }}）</div>
        </div>
      </div>

      <!-- Actions -->
      <div class="wechat-actions">
        <button
          v-if="!status.bridgeLoaded"
          class="action-btn primary"
          :disabled="!status.runtimePluginExists || !!actionLoading"
          @click="doInit"
        >
          {{ actionLoading === 'init' ? '初始化中…' : '初始化插件' }}
        </button>
        <template v-else>
          <button
            v-if="!status.status?.connected"
            class="action-btn primary"
            :disabled="!!actionLoading"
            @click="doLogin(false)"
          >
            {{ actionLoading === 'login' ? '登录中…' : '启动登录' }}
          </button>
          <button
            v-if="status.status?.connected"
            class="action-btn danger"
            :disabled="!!actionLoading"
            @click="doLogout"
          >
            {{ actionLoading === 'logout' ? '断开中…' : '断开连接' }}
          </button>
          <button
            class="action-btn"
            :disabled="!!actionLoading"
            @click="doReconnect"
          >
            {{ actionLoading === 'reconnect' ? '重连中…' : '强制重新登录' }}
          </button>
        </template>
      </div>

      <!-- Install instructions -->
      <div v-if="!status.runtimePluginExists" class="wechat-hint">
        <div class="hint-title">安装说明</div>
        <div class="hint-text">
          请在上方「插件管理」中安装 WeChat 插件，或手动放置到 <code>data/.pi/agent/extensions/wechat</code>。
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.wechat-settings {
  padding: 22px;
  border: 1px solid color-mix(in srgb, var(--color-border) 88%, transparent);
  border-radius: 13px;
  background: color-mix(in srgb, var(--color-bg-muted) 34%, var(--color-bg-card));
}
.wechat-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 20px;
}
.wechat-header h4 {
  margin: 0;
  font-size: 16px;
  font-weight: 650;
  letter-spacing: -0.01em;
}
.refresh-btn {
  min-height: 34px;
  padding: 6px 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg);
  color: var(--color-text-secondary);
  font-size: 12px;
  cursor: pointer;
}
.refresh-btn:hover { border-color: var(--color-primary); color: var(--color-primary); }
.refresh-btn:disabled { opacity: 0.5; cursor: default; }
.wechat-error {
  padding: 8px 12px;
  margin-bottom: 12px;
  background: rgba(239,68,68,0.08);
  border: 1px solid rgba(239,68,68,0.2);
  border-radius: var(--radius-sm);
  color: var(--color-error);
  font-size: 12px;
}
.wechat-loading { color: var(--color-text-muted); font-size: 13px; }
.wechat-section {
  margin-bottom: 18px;
  padding: 16px;
  border: 1px solid var(--color-border);
  border-radius: 11px;
  background: var(--color-bg-card);
}
.section-title {
  font-size: 11.5px;
  font-weight: 650;
  color: var(--color-text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-bottom: 8px;
}
.status-grid { display: flex; flex-direction: column; gap: 10px; }
.status-row { display: flex; align-items: flex-start; gap: 14px; font-size: 13px; }
.status-label { color: var(--color-text-muted); min-width: 96px; }
.status-value { color: var(--color-text); }
.status-value.ok { color: #16a34a; }
.status-value.warn { color: #b45309; }
.status-value.error { color: var(--color-error); }
.status-value.muted { color: var(--color-text-muted); }
.status-value.path { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 11px; word-break: break-all; display: flex; align-items: center; gap: 4px; }
.storage-ok { color: #16a34a; font-size: 12px; }
.status-badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
}
.status-badge.success { background: rgba(34,197,94,0.12); color: #16a34a; }
.status-badge.warning { background: rgba(245,158,11,0.12); color: #b45309; }
.status-badge.error { background: rgba(239,68,68,0.12); color: #ef4444; }
.status-badge.info { background: rgba(59,130,246,0.12); color: #3b82f6; }
.status-badge.muted { background: var(--color-bg-muted); color: var(--color-text-muted); }
.diagnostics-list {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
  color: var(--color-text-secondary);
}
.diagnostics-list li + li { margin-top: 4px; }
.qr-section {
  margin-top: 12px;
  padding: 12px;
  background: var(--color-bg-muted);
  border-radius: var(--radius-sm);
  text-align: center;
}
.qr-title { font-size: 13px; font-weight: 600; margin-bottom: 4px; }
.qr-hint { font-size: 11px; color: var(--color-text-muted); word-break: break-all; }
.wechat-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 9px;
  margin-top: 18px;
}
.action-btn {
  min-height: 36px;
  padding: 8px 15px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg);
  color: var(--color-text-secondary);
  font-size: 13px;
  cursor: pointer;
}
.action-btn:hover { border-color: var(--color-primary); color: var(--color-primary); }
.action-btn:disabled { opacity: 0.5; cursor: default; }
.action-btn.primary {
  background: var(--color-primary);
  border-color: var(--color-primary);
  color: white;
}
.action-btn.primary:hover { background: var(--color-primary-hover); }
.action-btn.danger {
  border-color: var(--color-error);
  color: var(--color-error);
}
.action-btn.danger:hover { background: rgba(239,68,68,0.08); }
.wechat-hint {
  margin-top: 16px;
  padding: 10px 12px;
  background: var(--color-primary-soft);
  border-radius: var(--radius-sm);
  font-size: 12px;
}
.hint-title { font-weight: 600; margin-bottom: 4px; color: var(--color-primary); }
.hint-text { color: var(--color-text-secondary); line-height: 1.5; }
.hint-text code {
  background: rgba(0,0,0,0.06);
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 11px;
}

@media (max-width: 640px) {
  .wechat-settings { padding: 18px; }
  .wechat-header { align-items: flex-start; }
  .status-row { flex-direction: column; gap: 4px; }
  .status-label { min-width: 0; }
  .wechat-actions .action-btn { flex: 1 1 140px; }
}
</style>
