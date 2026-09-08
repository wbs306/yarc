import { ref, type Ref } from 'vue'
import * as Y from 'yjs'

export interface ProjectLiveFileStatus {
  path: string
  dirty: boolean
  saving: boolean
  conflict: boolean
  modified?: string
  savedAt?: string
  revision?: number
  savedRevision?: number
  sessionEpoch?: string
}

export interface ProjectLiveFileClient {
  projectId: string
  path: string
  content: Ref<string>
  language: Ref<string>
  connected: Ref<boolean>
  ready: Ref<boolean>
  dirty: Ref<boolean>
  saving: Ref<boolean>
  conflict: Ref<boolean>
  error: Ref<string>
  status: Ref<ProjectLiveFileStatus | null>
  syncContent: (content: string) => void
  flush: () => Promise<void>
  resolveConflict: (strategy: 'use-live' | 'use-disk') => Promise<void>
  close: () => void
}

const clients = new Map<string, ProjectLiveFileClient>()
const keyFor = (projectId: string, path: string) => `${projectId}:${path}`
const requestId = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`

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

const socketUrl = (projectId: string, path: string) => {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}/api/projects/${encodeURIComponent(projectId)}/files/live?path=${encodeURIComponent(path)}`
}

export function useProjectLiveFiles() {
  const get = (projectId: string, path: string) => clients.get(keyFor(projectId, path)) || null

  const open = async (projectId: string, path: string): Promise<ProjectLiveFileClient> => {
    const key = keyFor(projectId, path)
    const existing = clients.get(key)
    if (existing) return existing

    const ydoc = new Y.Doc()
    const ytext = ydoc.getText('content')
    const content = ref('')
    const language = ref('plaintext')
    const connected = ref(false)
    const ready = ref(false)
    const dirty = ref(false)
    const saving = ref(false)
    const conflict = ref(false)
    const error = ref('')
    const status = ref<ProjectLiveFileStatus | null>(null)
    const pending = new Map<string, { resolve: () => void; reject: (error: Error) => void; timer: number }>()

    let ws: WebSocket | null = null
    let closed = false
    let reconnectTimer: number | null = null
    let reconnectAttempt = 0
    let sessionEpoch = ''
    let pendingServerContent: string | null = null
    let localDirty = false

    const replaceText = (next: string, origin: string) => {
      if (ytext.toString() === next) return
      ydoc.transact(() => {
        if (ytext.length) ytext.delete(0, ytext.length)
        if (next) ytext.insert(0, next)
      }, origin)
      content.value = next
    }

    const failPending = (message: string) => {
      for (const operation of pending.values()) {
        window.clearTimeout(operation.timer)
        operation.reject(new Error(message))
      }
      pending.clear()
    }

    const send = (message: unknown) => {
      if (ws?.readyState !== WebSocket.OPEN) return false
      ws.send(JSON.stringify(message))
      return true
    }

    const scheduleReconnect = () => {
      if (closed || reconnectTimer !== null) return
      const delay = Math.min(10_000, 300 * (2 ** reconnectAttempt++))
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null
        connect()
      }, delay)
    }

    const operation = (message: Record<string, unknown>, timeout = 20_000) => new Promise<void>((resolve, reject) => {
      const id = requestId()
      if (!send({ ...message, requestId: id })) return reject(new Error('Project LiveFile 未连接'))
      const timer = window.setTimeout(() => {
        pending.delete(id)
        reject(new Error('Project LiveFile 操作超时'))
      }, timeout)
      pending.set(id, { resolve, reject, timer })
    })

    ytext.observe(() => { content.value = ytext.toString() })
    ydoc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === 'server') return
      localDirty = true
      dirty.value = true
      if (!send({ type: 'update', update: toBase64(update) })) scheduleReconnect()
    })

    const handleMessage = (event: MessageEvent) => {
      let message: any
      try { message = JSON.parse(String(event.data)) } catch { return }
      if (message.type === 'init' && typeof message.update === 'string') {
        const serverDoc = new Y.Doc()
        Y.applyUpdate(serverDoc, fromBase64(message.update), 'server')
        const serverContent = serverDoc.getText('content').toString()
        serverDoc.destroy()
        const nextEpoch = String(message.sessionEpoch || message.status?.sessionEpoch || '')
        const changedEpoch = !!sessionEpoch && !!nextEpoch && sessionEpoch !== nextEpoch
        if (localDirty && changedEpoch && serverContent !== ytext.toString()) {
          pendingServerContent = serverContent
          conflict.value = true
          error.value = '工作区已切换或恢复，当前本地修改需要先选择保留本地或使用磁盘版本。'
        } else {
          replaceText(serverContent, 'server')
          localDirty = false
          dirty.value = false
          conflict.value = false
          pendingServerContent = null
        }
        sessionEpoch = nextEpoch
        language.value = message.language || language.value
        status.value = message.status || null
        ready.value = true
        return
      }
      if (message.type === 'update' && typeof message.update === 'string') {
        Y.applyUpdate(ydoc, fromBase64(message.update), 'server')
        return
      }
      if (message.type === 'status') {
        status.value = message.status || null
        saving.value = !!message.status?.saving
        conflict.value = !!message.status?.conflict || conflict.value
        if (!message.status?.dirty && !message.status?.saving && !message.status?.conflict && !pendingServerContent) {
          localDirty = false
          dirty.value = false
        }
        return
      }
      if (message.type === 'conflict') {
        conflict.value = true
        error.value = message.message || '文件存在外部修改冲突'
        return
      }
      if (message.type === 'workspace-reset') {
        error.value = message.reason ? `工作区已更新：${message.reason}` : '工作区已更新，正在重新载入文件'
        try { ws?.close() } catch {}
        return
      }
      if (message.type === 'flush-ack') {
        const item = pending.get(String(message.requestId || ''))
        if (!item) return
        pending.delete(String(message.requestId))
        window.clearTimeout(item.timer)
        if (message.conflict) {
          conflict.value = true
          item.reject(new Error('文件存在冲突'))
        } else {
          localDirty = false
          dirty.value = false
          saving.value = false
          conflict.value = false
          if (typeof message.update === 'string') {
            const serverDoc = new Y.Doc()
            Y.applyUpdate(serverDoc, fromBase64(message.update), 'server')
            replaceText(serverDoc.getText('content').toString(), 'server')
            serverDoc.destroy()
          }
          item.resolve()
        }
        return
      }
      if (message.type === 'error') error.value = message.message || 'Project LiveFile error'
    }

    const connect = () => {
      if (closed) return
      try { ws?.close() } catch {}
      ws = new WebSocket(socketUrl(projectId, path))
      ws.onopen = () => {
        connected.value = true
        reconnectAttempt = 0
        error.value = ''
      }
      ws.onmessage = handleMessage
      ws.onerror = () => { error.value = 'Project LiveFile 连接错误' }
      ws.onclose = () => {
        connected.value = false
        failPending('Project LiveFile 连接已断开')
        if (!closed) scheduleReconnect()
      }
    }

    const client: ProjectLiveFileClient = {
      projectId,
      path,
      content,
      language,
      connected,
      ready,
      dirty,
      saving,
      conflict,
      error,
      status,
      syncContent(next) { replaceText(next, 'client') },
      async flush() {
        saving.value = true
        try { await operation({ type: 'flush' }) }
        finally { saving.value = false }
      },
      async resolveConflict(strategy) {
        if (pendingServerContent !== null) {
          if (strategy === 'use-disk') {
            replaceText(pendingServerContent, 'server')
            localDirty = false
            dirty.value = false
            conflict.value = false
            pendingServerContent = null
            return
          }
          pendingServerContent = null
          conflict.value = false
          await operation({ type: 'replace-content', content: ytext.toString() })
          return
        }
        await operation({ type: 'resolve-conflict', strategy })
      },
      close() {
        if (closed) return
        closed = true
        if (reconnectTimer !== null) window.clearTimeout(reconnectTimer)
        failPending('Project LiveFile 已关闭')
        try { ws?.close() } catch {}
        ydoc.destroy()
        clients.delete(key)
      },
    }

    clients.set(key, client)
    connect()
    return client
  }

  return { get, open }
}
