import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { WebDavSyncResult, WebDavSyncStatus } from '@yarc/shared'
import { useApi } from '@/composables/useApi'

const defaultStatus = (): WebDavSyncStatus => ({
  enabled: false,
  scheduled: false,
  phase: 'disabled',
  running: false,
  message: 'WebDAV 同步未启用',
  currentPath: null,
  processed: 0,
  total: 0,
  lastSyncAt: null,
  lastSuccessAt: null,
  nextSyncAt: null,
  lastError: null,
  lastResult: null,
})

export const useWebDavSyncStore = defineStore('webdav-sync', () => {
  const api = useApi()
  const status = ref<WebDavSyncStatus>(defaultStatus())
  const loading = ref(false)
  let initialized = false
  let pendingRefresh: Promise<WebDavSyncStatus> | null = null

  const applyStatus = (next: WebDavSyncStatus) => {
    status.value = { ...next }
  }

  const refreshStatus = () => {
    if (pendingRefresh) return pendingRefresh
    loading.value = true
    pendingRefresh = api.getWebDavStatus()
      .then((result) => {
        applyStatus(result.status)
        return result.status
      })
      .finally(() => {
        loading.value = false
        pendingRefresh = null
      })
    return pendingRefresh
  }

  const onStatusEvent = (event: Event) => {
    const next = (event as CustomEvent<{ status?: WebDavSyncStatus }>).detail?.status
    if (next) applyStatus(next)
  }

  const initialize = () => {
    if (!initialized) {
      initialized = true
      window.addEventListener('yarc-webdav-sync-status', onStatusEvent)
    }
    // App.vue may initialize before login succeeds. Refresh on later calls too
    // so the top-bar state is populated after entering the authenticated app.
    void refreshStatus().catch(() => {})
  }

  const syncNow = async (): Promise<WebDavSyncResult> => {
    const result = await api.runWebDavSync()
    status.value = { ...status.value, lastResult: result.result }
    await refreshStatus().catch(() => {})
    return result.result
  }

  return {
    status,
    loading,
    initialize,
    refreshStatus,
    applyStatus,
    syncNow,
  }
})
