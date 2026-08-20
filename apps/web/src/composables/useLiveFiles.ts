import { ref, type Ref } from 'vue'
import * as Y from 'yjs'
import {
  getOfflineWorkspaceFile,
  putOfflineWorkspaceFile,
  removeOfflineWorkspaceFile,
  type OfflineWorkspaceFileSnapshot,
} from '@/lib/offline-workspace-cache'
import { sha256Text } from '@/lib/sha256'

export interface LiveFileStatus {
  path: string
  dirty: boolean
  saving: boolean
  conflict: boolean
  modified?: string
  savedAt?: string
  clients?: number
  revision?: number
  savedRevision?: number
  sessionEpoch?: string
  contentHash?: string
  diskHash?: string
}

export interface LiveFileClient {
  path: string
  ydoc: Y.Doc
  ytext: Y.Text
  content: Ref<string>
  language: Ref<string>
  modified: Ref<string>
  connected: Ref<boolean>
  ready: Ref<boolean>
  offline: Ref<boolean>
  cachedAt: Ref<number | null>
  serverRevision: Ref<number>
  sessionEpoch: Ref<string>
  draftAvailable: Ref<boolean>
  dirty: Ref<boolean>
  saving: Ref<boolean>
  conflict: Ref<boolean>
  error: Ref<string>
  status: Ref<LiveFileStatus | null>
  flush: () => Promise<void>
  resolveConflict: (strategy: 'use-live' | 'use-disk') => Promise<void>
  syncContent: (content: string) => void
  close: () => void
}

type PendingOperationKind = 'flush' | 'resolve-conflict' | 'replace-content'

type PendingOperation = {
  id: string
  kind: PendingOperationKind
  generation: number
  resolve: () => void
  reject: (error: Error) => void
  timer: number
  sent: boolean
}

const clients = new Map<string, LiveFileClient>()
const RECONNECT_BASE_MS = 500
const RECONNECT_MAX_MS = 15_000
const INITIAL_CONNECTION_TIMEOUT_MS = 5_000
const FLUSH_TIMEOUT_MS = 20_000
const CONFLICT_TIMEOUT_MS = 10_000

const fromBase64 = (value: string) => {
  const binary = window.atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

const toBase64 = (update: Uint8Array) => {
  let binary = ''
  for (const byte of update) binary += String.fromCharCode(byte)
  return window.btoa(binary)
}

const createRequestId = () => {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

const liveFileUrl = (path: string) => {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}/api/files/live?path=${encodeURIComponent(path)}`
}

const isIgnoredOrigin = (origin: unknown) => origin === 'server' || origin === 'cache' || origin === 'recovery'

export function useLiveFiles() {
  const get = (path?: string | null) => (path ? clients.get(path) || null : null)

  const open = async (path: string): Promise<LiveFileClient> => {
    const existing = clients.get(path)
    if (existing) return existing

    const ydoc = new Y.Doc()
    const ytext = ydoc.getText('content')
    const content = ref('')
    const language = ref('plaintext')
    const modified = ref('')
    const connected = ref(false)
    const ready = ref(false)
    const offline = ref(false)
    const cachedAt = ref<number | null>(null)
    const serverRevision = ref(0)
    const sessionEpoch = ref('')
    const draftAvailable = ref(false)
    const dirty = ref(false)
    const saving = ref(false)
    const conflict = ref(false)
    const error = ref('')
    const status = ref<LiveFileStatus | null>(null)

    let ws: WebSocket | null = null
    let closedByClient = false
    let reconnectTimer: number | null = null
    let reconnectCountdownTimer: number | null = null
    let reconnectDeadline = 0
    let reconnectAttempt = 0
    let readyResolve: (() => void) | null = null
    let readySettled = false
    let authoritativeReady = false
    let localDirty = false
    let localChangeGeneration = 0
    let localDraftContent: string | null = null
    let pendingServerContent: string | null = null
    let pendingFlushRequested = false
    let activeFlushId: string | null = null
    let draftTimer: number | null = null
    let statusVersion = 0
    const pendingOperations = new Map<string, PendingOperation>()

    const readyPromise = new Promise<void>((resolve) => {
      readyResolve = resolve
    })

    const resolveReady = () => {
      if (readySettled) return
      readySettled = true
      ready.value = true
      readyResolve?.()
      readyResolve = null
    }

    const sendJson = (message: unknown) => {
      if (ws?.readyState !== WebSocket.OPEN) return false
      try {
        ws.send(JSON.stringify(message))
        return true
      } catch {
        return false
      }
    }

    const clearReconnectCountdown = () => {
      if (reconnectCountdownTimer !== null) {
        window.clearInterval(reconnectCountdownTimer)
        reconnectCountdownTimer = null
      }
      reconnectDeadline = 0
    }

    const scheduleReconnect = (delayOverride?: number) => {
      if (closedByClient || reconnectTimer !== null) return
      if (navigator.onLine === false) {
        offline.value = true
        return
      }
      const delay = delayOverride ?? Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * (2 ** reconnectAttempt))
      reconnectAttempt += 1
      clearReconnectCountdown()
      reconnectDeadline = Date.now() + delay
      const updateCountdown = () => {
        const seconds = Math.max(1, Math.ceil((reconnectDeadline - Date.now()) / 1000))
        error.value = `实时文件连接已断开，${seconds} 秒后重连…`
      }
      updateCountdown()
      reconnectCountdownTimer = window.setInterval(updateCountdown, 250)
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null
        clearReconnectCountdown()
        error.value = '正在重新连接实时文件…'
        connect()
      }, delay)
    }

    const persistLastKnownGood = () => {
      if (!authoritativeReady || offline.value || localDirty || dirty.value || saving.value || conflict.value) return
      const snapshot: Omit<OfflineWorkspaceFileSnapshot, 'cachedAt'> = {
        path,
        content: ytext.toString(),
        language: language.value,
        modified: modified.value,
        kind: 'last-known-good',
        contentHash: status.value?.contentHash,
        serverRevision: serverRevision.value,
        sessionEpoch: sessionEpoch.value,
        savedAt: status.value?.savedAt ? Date.parse(status.value.savedAt) : Date.now(),
      }
      cachedAt.value = Date.now()
      void putOfflineWorkspaceFile(snapshot)
    }

    const persistLocalDraft = () => {
      if (!localDirty) return
      localDraftContent = ytext.toString()
      const snapshot: Omit<OfflineWorkspaceFileSnapshot, 'cachedAt'> = {
        path,
        content: localDraftContent,
        language: language.value,
        modified: modified.value,
        kind: 'local-draft',
        serverRevision: serverRevision.value,
        sessionEpoch: sessionEpoch.value,
      }
      draftAvailable.value = true
      void putOfflineWorkspaceFile(snapshot)
    }

    const scheduleLocalDraft = () => {
      if (draftTimer !== null) window.clearTimeout(draftTimer)
      draftTimer = window.setTimeout(() => {
        draftTimer = null
        persistLocalDraft()
      }, 300)
    }

    const clearLocalDraft = () => {
      localDraftContent = null
      draftAvailable.value = false
      void removeOfflineWorkspaceFile(path, 'local-draft')
    }

    const applyCachedSnapshot = (snapshot: OfflineWorkspaceFileSnapshot) => {
      ydoc.transact(() => {
        if (ytext.length) ytext.delete(0, ytext.length)
        if (snapshot.content) ytext.insert(0, snapshot.content)
      }, 'cache')
      content.value = snapshot.content
      language.value = snapshot.language || 'plaintext'
      modified.value = snapshot.modified || ''
      cachedAt.value = snapshot.cachedAt
      offline.value = true
      resolveReady()
    }

    const failPendingOperations = (reason: Error, includeQueued = true) => {
      for (const [id, operation] of pendingOperations) {
        if (!includeQueued && !operation.sent) continue
        window.clearTimeout(operation.timer)
        operation.reject(reason)
        pendingOperations.delete(id)
      }
      activeFlushId = null
      pendingFlushRequested = false
    }

    const sendNextFlush = () => {
      if (conflict.value || activeFlushId || !pendingFlushRequested || ws?.readyState !== WebSocket.OPEN) return
      const operation = [...pendingOperations.values()].find((item) => item.kind === 'flush' && !item.sent)
      if (!operation) {
        pendingFlushRequested = false
        return
      }
      if (!sendJson({ type: 'flush', requestId: operation.id })) return
      operation.sent = true
      activeFlushId = operation.id
      pendingFlushRequested = false
    }

    const createOperation = (
      kind: PendingOperationKind,
      generation: number,
      message: Record<string, unknown>,
      timeoutMs: number
    ) => new Promise<void>((resolve, reject) => {
      const id = String(message.requestId || createRequestId())
      const timer = window.setTimeout(() => {
        const operation = pendingOperations.get(id)
        if (!operation) return
        pendingOperations.delete(id)
        if (activeFlushId === id) activeFlushId = null
        reject(new Error(kind === 'flush' ? '保存超时' : '冲突处理超时'))
        sendNextFlush()
      }, timeoutMs)
      const operation: PendingOperation = { id, kind, generation, resolve, reject, timer, sent: false }
      pendingOperations.set(id, operation)

      if (kind === 'flush') {
        pendingFlushRequested = true
        sendNextFlush()
      } else if (!sendJson({ ...message, requestId: id })) {
        window.clearTimeout(timer)
        pendingOperations.delete(id)
        reject(new Error('实时文件连接未建立'))
      } else {
        operation.sent = true
      }
    })

    const completeFlushOperation = (msg: any) => {
      const operation = pendingOperations.get(String(msg.requestId || ''))
      if (!operation) return
      pendingOperations.delete(operation.id)
      window.clearTimeout(operation.timer)
      if (activeFlushId === operation.id) activeFlushId = null

      if (msg.conflict) {
        conflict.value = true
        error.value = '文件存在外部修改冲突，请先处理冲突'
        operation.reject(new Error(error.value))
        sendNextFlush()
        return
      }

      if (typeof msg.revision === 'number') serverRevision.value = msg.revision
      if (msg.savedAt) {
        status.value = status.value || {
          path,
          dirty: dirty.value,
          saving: saving.value,
          conflict: conflict.value,
        }
        status.value.savedAt = msg.savedAt
        modified.value = status.value.modified || modified.value
      }

      if (operation.kind !== 'flush' && typeof msg.update === 'string') {
        applyAuthoritativeUpdate(fromBase64(msg.update))
      }
      if (typeof msg.hash === 'string' && status.value) status.value.contentHash = msg.hash

      if (localChangeGeneration <= operation.generation) {
        localDirty = false
        dirty.value = false
        clearLocalDraft()
        persistLastKnownGood()
      } else {
        dirty.value = true
        scheduleLocalDraft()
      }
      saving.value = false
      operation.resolve()
      sendNextFlush()
    }

    const acknowledgeAutosave = async (serverStatus: LiveFileStatus, observedStatusVersion: number) => {
      if (serverStatus.dirty || serverStatus.saving || serverStatus.conflict) return
      if (!localDirty || activeFlushId || pendingServerContent !== null) return
      if (statusVersion !== observedStatusVersion) return
      if (!serverStatus.contentHash) return

      const generation = localChangeGeneration
      const localHash = await sha256Text(ytext.toString())
      if (generation !== localChangeGeneration || statusVersion !== observedStatusVersion) return
      if (!localDirty || activeFlushId || pendingServerContent !== null) return
      if (localHash !== serverStatus.contentHash) return

      // The backend's clean status is an acknowledgement of the debounced
      // autosave. Only clear the local dirty flag when the acknowledged disk
      // content is exactly the current local Yjs content; a newer local edit
      // must remain visible as dirty.
      localDirty = false
      dirty.value = false
      clearLocalDraft()
      persistLastKnownGood()
    }

    const syncText = (nextContent: string, origin: 'server' | 'recovery' = 'server') => {
      if (ytext.toString() === nextContent) return
      ydoc.transact(() => {
        if (ytext.length) ytext.delete(0, ytext.length)
        if (nextContent) ytext.insert(0, nextContent)
      }, origin)
      content.value = nextContent
    }

    const applyAuthoritativeUpdate = (update: Uint8Array) => {
      ydoc.transact(() => {
        if (ytext.length) ytext.delete(0, ytext.length)
      }, 'server')
      Y.applyUpdate(ydoc, update, 'server')
      content.value = ytext.toString()
    }

    const loadOfflineFallback = async () => {
      const cachedSnapshot = await getOfflineWorkspaceFile(path, 'last-known-good')
      if (!cachedSnapshot) return false
      applyCachedSnapshot(cachedSnapshot)
      return true
    }

    const loadCachedDraft = async (serverContent: string) => {
      const draft = await getOfflineWorkspaceFile(path, 'local-draft')
      if (!draft || draft.content === serverContent) {
        if (draft) await removeOfflineWorkspaceFile(path, 'local-draft')
        return
      }
      localDraftContent = draft.content
      draftAvailable.value = true
      conflict.value = true
      error.value = '发现未同步的本地草稿，请选择保留草稿或使用服务端版本。'
    }

    const sendFullLocalStateIfNeeded = () => {
      if (!localDirty || pendingServerContent !== null) return
      if (!sendJson({ type: 'update', update: toBase64(Y.encodeStateAsUpdate(ydoc)) })) {
        scheduleReconnect()
      }
    }

    ytext.observe(() => {
      content.value = ytext.toString()
    })

    ydoc.on('update', (update: Uint8Array, origin: unknown) => {
      if (isIgnoredOrigin(origin)) return
      localChangeGeneration += 1
      localDirty = true
      dirty.value = true
      scheduleLocalDraft()
      if (!sendJson({ type: 'update', update: toBase64(update) })) scheduleReconnect()
    })

    const handleMessage = async (event: MessageEvent) => {
      try {
        const msg = JSON.parse(String(event.data))
        if (msg.type === 'init') {
          const incomingEpoch = String(msg.sessionEpoch || msg.status?.sessionEpoch || '')
          const epochChanged = !!sessionEpoch.value && !!incomingEpoch && incomingEpoch !== sessionEpoch.value
          const serverDoc = new Y.Doc()
          Y.applyUpdate(serverDoc, fromBase64(msg.update), 'server')
          const serverContent = serverDoc.getText('content').toString()
          serverDoc.destroy()

          if (authoritativeReady && epochChanged && localDirty) {
            pendingServerContent = serverContent
            conflict.value = true
            error.value = '实时文件服务端 session 已重建，当前本地修改需要确认是否覆盖服务端版本。'
            failPendingOperations(new Error(error.value))
          } else if (!authoritativeReady || epochChanged) {
            applyAuthoritativeUpdate(fromBase64(msg.update))
            localDirty = false
            dirty.value = false
            pendingServerContent = null
          } else {
            Y.applyUpdate(ydoc, fromBase64(msg.update), 'server')
          }

          authoritativeReady = true
          sessionEpoch.value = incomingEpoch || sessionEpoch.value
          language.value = msg.language || language.value || 'plaintext'
          modified.value = msg.modified || modified.value
          connected.value = true
          offline.value = false
          status.value = msg.status || status.value
          if (msg.status) {
            serverRevision.value = Number(msg.status.revision || msg.revision || 0)
            saving.value = !!msg.status.saving
            if (msg.status.conflict) conflict.value = true
            else if (!localDirty && !pendingServerContent) dirty.value = !!msg.status.dirty
          }
          resolveReady()
          if (pendingServerContent === null) {
            if (!msg.status?.dirty && !msg.status?.saving && !msg.status?.conflict) persistLastKnownGood()
            void loadCachedDraft(serverContent)
          }
          sendFullLocalStateIfNeeded()
          sendNextFlush()
          return
        }

        if (msg.type === 'update' && typeof msg.update === 'string') {
          if (pendingServerContent !== null) return
          Y.applyUpdate(ydoc, fromBase64(msg.update), 'server')
          if (typeof msg.revision === 'number') serverRevision.value = msg.revision
          return
        }

        if (msg.type === 'status' && msg.status) {
          const nextStatus = msg.status as LiveFileStatus
          status.value = nextStatus
          const observedStatusVersion = ++statusVersion
          if (typeof nextStatus.revision === 'number') serverRevision.value = nextStatus.revision
          if (nextStatus.sessionEpoch && !sessionEpoch.value) sessionEpoch.value = nextStatus.sessionEpoch
          saving.value = !!nextStatus.saving
          if (nextStatus.conflict) {
            conflict.value = true
          } else if (nextStatus.dirty) {
            dirty.value = true
          } else if (!localDirty && !activeFlushId && !pendingServerContent) {
            dirty.value = false
          } else if (!activeFlushId && pendingServerContent === null) {
            // Autosaves do not have a request-specific flush-ack. Verify the
            // server's content hash before clearing a local dirty flag.
            void acknowledgeAutosave(nextStatus, observedStatusVersion)
          }
          if (nextStatus.modified) modified.value = nextStatus.modified
          if (!dirty.value && !saving.value && !conflict.value) persistLastKnownGood()
          return
        }

        if (msg.type === 'flush-ack') {
          completeFlushOperation(msg)
          return
        }

        if (msg.type === 'conflict') {
          conflict.value = true
          error.value = msg.message || '文件存在冲突'
          failPendingOperations(new Error(error.value))
          return
        }

        if (msg.type === 'error') {
          error.value = msg.message || '实时文件同步失败'
          const operationError = new Error(error.value)
          if (!readySettled && !authoritativeReady) {
            const loaded = await loadOfflineFallback()
            if (loaded && !ready.value) resolveReady()
          }
          failPendingOperations(operationError)
        }
      } catch (err) {
        error.value = (err as Error).message || '实时文件消息解析失败'
      }
    }

    const reconnectWhenOnline = () => {
      if (closedByClient) return
      scheduleReconnect(0)
    }

    const pauseWhenOffline = () => {
      offline.value = true
      if (!authoritativeReady) void loadOfflineFallback()
      else if (localDirty || dirty.value || saving.value || conflict.value) persistLocalDraft()
      else persistLastKnownGood()
    }

    function connect() {
      if (closedByClient || navigator.onLine === false) {
        offline.value = true
        return
      }
      try { ws?.close() } catch { /* ignore */ }
      ws = new WebSocket(liveFileUrl(path))

      ws.onopen = () => {
        connected.value = true
        reconnectAttempt = 0
        clearReconnectCountdown()
        error.value = ''
      }
      ws.onmessage = (event) => { void handleMessage(event) }
      ws.onerror = () => {
        connected.value = false
        offline.value = true
        if (!authoritativeReady) error.value = '实时文件连接失败，正在显示缓存副本'
        else if (!closedByClient) error.value = '实时文件连接已断开，正在重连…'
      }
      ws.onclose = () => {
        connected.value = false
        offline.value = true
        if (activeFlushId) {
          const operation = pendingOperations.get(activeFlushId)
          if (operation) operation.sent = false
          activeFlushId = null
          pendingFlushRequested = true
        }
        if (!closedByClient) scheduleReconnect()
      }
    }

    const client: LiveFileClient = {
      path,
      ydoc,
      ytext,
      content,
      language,
      modified,
      connected,
      ready,
      offline,
      cachedAt,
      serverRevision,
      sessionEpoch,
      draftAvailable,
      dirty,
      saving,
      conflict,
      error,
      status,
      flush: () => {
        if (conflict.value) return Promise.reject(new Error(error.value || '文件存在冲突，请先处理冲突'))
        if (!localDirty && !dirty.value && !saving.value && !activeFlushId) return Promise.resolve()
        return createOperation('flush', localChangeGeneration, { type: 'flush' }, FLUSH_TIMEOUT_MS)
      },
      resolveConflict: (strategy) => {
        const recoveryContent = strategy === 'use-live'
          ? (localDraftContent ?? ytext.toString())
          : (pendingServerContent ?? ytext.toString())

        if (pendingServerContent !== null || localDraftContent !== null) {
          const operation = createOperation(
            'replace-content',
            localChangeGeneration,
            { type: 'replace-content', content: recoveryContent },
            CONFLICT_TIMEOUT_MS
          )
          return operation.then(() => {
            pendingServerContent = null
            localDraftContent = null
            conflict.value = false
            error.value = ''
          })
        }

        return createOperation(
          'resolve-conflict',
          localChangeGeneration,
          { type: 'resolve-conflict', strategy },
          CONFLICT_TIMEOUT_MS
        ).then(() => {
          conflict.value = false
          error.value = ''
        })
      },
      syncContent: (nextContent) => syncText(nextContent, 'server'),
      close: () => {
        closedByClient = true
        window.removeEventListener('online', reconnectWhenOnline)
        window.removeEventListener('offline', pauseWhenOffline)
        if (draftTimer !== null) {
          window.clearTimeout(draftTimer)
          draftTimer = null
        }
        if (localDirty) persistLocalDraft()
        else if (authoritativeReady) persistLastKnownGood()
        if (reconnectTimer !== null) {
          window.clearTimeout(reconnectTimer)
          reconnectTimer = null
        }
        clearReconnectCountdown()
        failPendingOperations(new Error('实时文件客户端已关闭'))
        try { ws?.close() } catch { /* ignore */ }
        ydoc.destroy()
        clients.delete(path)
      },
    }

    clients.set(path, client)
    window.addEventListener('online', reconnectWhenOnline)
    window.addEventListener('offline', pauseWhenOffline)

    if (navigator.onLine === false) {
      if (await loadOfflineFallback()) return client
      clients.delete(path)
      closedByClient = true
      window.removeEventListener('online', reconnectWhenOnline)
      window.removeEventListener('offline', pauseWhenOffline)
      ydoc.destroy()
      throw new Error('当前处于离线状态，且没有此文件的本地缓存')
    }

    connect()
    const connectedInTime = await Promise.race([
      readyPromise.then(() => true),
      new Promise<boolean>((resolve) => window.setTimeout(() => resolve(false), INITIAL_CONNECTION_TIMEOUT_MS)),
    ])
    if (connectedInTime) return client

    if (await loadOfflineFallback()) return client

    client.close()
    throw new Error('实时文件连接超时，且没有此文件的本地缓存')
  }

  const release = async (path: string) => {
    const client = clients.get(path)
    if (!client) return
    if (!client.conflict.value && (client.dirty.value || client.saving.value) && !client.offline.value) {
      await client.flush().catch(() => undefined)
    }
    client.close()
  }

  const releaseAll = async () => {
    const paths = Array.from(clients.keys())
    await Promise.all(paths.map((path) => release(path)))
  }

  return { clients, get, open, release, releaseAll }
}
