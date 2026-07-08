import { ref, type Ref } from 'vue'
import * as Y from 'yjs'

export interface LiveFileStatus {
  path: string
  dirty: boolean
  saving: boolean
  conflict: boolean
  modified?: string
  savedAt?: string
  clients?: number
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

const clients = new Map<string, LiveFileClient>()
const RECONNECT_BASE_MS = 500
const RECONNECT_MAX_MS = 15_000

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

const liveFileUrl = (path: string) => {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}/api/files/live?path=${encodeURIComponent(path)}`
}

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
    const dirty = ref(false)
    const saving = ref(false)
    const conflict = ref(false)
    const error = ref('')
    const status = ref<LiveFileStatus | null>(null)

    let ws: WebSocket | null = null
    let closedByClient = false
    let reconnectTimer: number | null = null
    let reconnectAttempt = 0
    let pendingFlushRequested = false
    let readyResolve: (() => void) | null = null
    let readyReject: ((err: Error) => void) | null = null
    let pendingFlushResolve: (() => void) | null = null
    let pendingFlushReject: ((err: Error) => void) | null = null

    const readyPromise = new Promise<void>((resolve, reject) => {
      readyResolve = resolve
      readyReject = reject
    })

    const clearPendingFlush = (err?: Error) => {
      if (err) pendingFlushReject?.(err)
      else pendingFlushResolve?.()
      pendingFlushResolve = null
      pendingFlushReject = null
    }

    const sendJson = (message: unknown) => {
      if (ws?.readyState !== WebSocket.OPEN) return false
      ws.send(JSON.stringify(message))
      return true
    }

    const sendFullLocalStateIfNeeded = () => {
      if (!dirty.value) return
      sendJson({ type: 'update', update: toBase64(Y.encodeStateAsUpdate(ydoc)) })
    }

    const requestFlush = () => {
      pendingFlushRequested = true
      if (sendJson({ type: 'flush' })) pendingFlushRequested = false
    }

    const scheduleReconnect = () => {
      if (closedByClient || reconnectTimer !== null) return
      const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * (2 ** reconnectAttempt))
      reconnectAttempt += 1
      error.value = `实时文件连接已断开，${Math.round(delay / 1000) || 1} 秒后重连…`
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null
        connect()
      }, delay)
    }

    ytext.observe(() => {
      content.value = ytext.toString()
    })

    ydoc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === 'server') return
      dirty.value = true
      if (!sendJson({ type: 'update', update: toBase64(update) })) {
        // The next successful connection sends the full local Y.Doc state, so
        // edits made while offline are preserved without queuing every update.
        scheduleReconnect()
      }
    })

    const handleMessage = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(String(event.data))
        if (msg.type === 'init') {
          const hadLocalDirty = dirty.value
          language.value = msg.language || 'plaintext'
          modified.value = msg.modified || ''
          Y.applyUpdate(ydoc, fromBase64(msg.update), 'server')
          content.value = ytext.toString()
          if (msg.status) {
            status.value = msg.status
            dirty.value = !!msg.status.dirty || hadLocalDirty
            saving.value = !!msg.status.saving
            conflict.value = !!msg.status.conflict
          }
          ready.value = true
          readyResolve?.()
          readyResolve = null
          if (hadLocalDirty) sendFullLocalStateIfNeeded()
          if (pendingFlushRequested) requestFlush()
          return
        }
        if (msg.type === 'update' && typeof msg.update === 'string') {
          Y.applyUpdate(ydoc, fromBase64(msg.update), 'server')
          content.value = ytext.toString()
          return
        }
        if (msg.type === 'status' && msg.status) {
          status.value = msg.status
          dirty.value = !!msg.status.dirty
          saving.value = !!msg.status.saving
          conflict.value = !!msg.status.conflict
          if (msg.status.modified) modified.value = msg.status.modified
          if (!dirty.value && !saving.value && !conflict.value) clearPendingFlush()
          if (conflict.value) clearPendingFlush(new Error('文件存在冲突，请先处理冲突'))
          return
        }
        if (msg.type === 'conflict') {
          conflict.value = true
          error.value = msg.message || '文件存在冲突'
          clearPendingFlush(new Error(error.value))
          return
        }
        if (msg.type === 'error') {
          error.value = msg.message || '实时文件同步失败'
          if (!ready.value) {
            readyReject?.(new Error(error.value))
            readyReject = null
          }
          clearPendingFlush(new Error(error.value))
        }
      } catch (err) {
        error.value = (err as Error).message || '实时文件消息解析失败'
      }
    }

    function connect() {
      if (closedByClient) return
      try { ws?.close() } catch { /* ignore */ }
      ws = new WebSocket(liveFileUrl(path))

      ws.onopen = () => {
        connected.value = true
        reconnectAttempt = 0
        error.value = ''
      }
      ws.onmessage = handleMessage
      ws.onerror = () => {
        connected.value = false
        if (!closedByClient) {
          error.value = '实时文件连接失败，准备重连…'
        }
      }
      ws.onclose = () => {
        connected.value = false
        if (!closedByClient) {
          // Keep pending flush promises open across reconnects. After init, the
          // client resends dirty local state and any requested flush.
          scheduleReconnect()
        }
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
      dirty,
      saving,
      conflict,
      error,
      status,
      flush: () => {
        if (conflict.value) return Promise.reject(new Error('文件存在冲突，请先处理冲突'))
        requestFlush()
        if (!dirty.value && !saving.value && !pendingFlushRequested) return Promise.resolve()
        return new Promise<void>((resolve, reject) => {
          pendingFlushResolve = resolve
          pendingFlushReject = reject
          window.setTimeout(() => {
            if (pendingFlushReject === reject) clearPendingFlush(new Error('保存超时'))
          }, 20_000)
        })
      },
      resolveConflict: (strategy) => {
        if (!sendJson({ type: 'resolve-conflict', strategy })) return Promise.reject(new Error('实时文件连接未建立'))
        return new Promise<void>((resolve, reject) => {
          pendingFlushResolve = resolve
          pendingFlushReject = reject
          window.setTimeout(() => {
            if (pendingFlushReject === reject) clearPendingFlush(new Error('冲突处理超时'))
          }, 10_000)
        })
      },
      syncContent: (nextContent) => {
        const current = ytext.toString()
        if (current === nextContent) return
        ydoc.transact(() => {
          ytext.delete(0, ytext.length)
          ytext.insert(0, nextContent)
        }, 'server')
        content.value = nextContent
      },
      close: () => {
        closedByClient = true
        if (reconnectTimer !== null) {
          window.clearTimeout(reconnectTimer)
          reconnectTimer = null
        }
        try { ws?.close() } catch { /* ignore */ }
        ydoc.destroy()
        clients.delete(path)
      },
    }

    clients.set(path, client)
    connect()
    try {
      await readyPromise
      return client
    } catch (err) {
      clients.delete(path)
      closedByClient = true
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer)
      try { (ws as WebSocket | null)?.close() } catch { /* ignore */ }
      ydoc.destroy()
      throw err
    }
  }

  const release = async (path: string) => {
    const client = clients.get(path)
    if (!client) return
    // Do not block tab close on a flush acknowledgement. Every local edit has
    // already been sent as a Yjs update; the backend also flushes when the socket
    // detaches, so waiting here only makes the close button feel stuck if a status
    // message is delayed or lost.
    if (!client.conflict.value && (client.dirty.value || client.saving.value)) {
      void client.flush().catch(() => {})
    }
    client.close()
  }

  const releaseAll = async () => {
    const paths = Array.from(clients.keys())
    await Promise.all(paths.map((path) => release(path)))
  }

  return { clients, get, open, release, releaseAll }
}
