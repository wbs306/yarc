const DATABASE_NAME = 'yarc-offline-workspace'
const DATABASE_VERSION = 2
const STORE_NAME = 'snapshots'
const TREE_KEY = 'tree'

export type OfflineWorkspaceFileKind = 'last-known-good' | 'local-draft'

export interface OfflineWorkspaceFileSnapshot {
  path: string
  content: string
  language: string
  modified: string
  cachedAt: number
  kind: OfflineWorkspaceFileKind
  contentHash?: string
  serverRevision?: number
  sessionEpoch?: string
  savedAt?: number
}

export interface OfflineWorkspaceTreeSnapshot {
  files: unknown[]
  cachedAt: number
}

export interface OfflinePdfSnapshot {
  blob: Blob
  cachedAt: number
}

export interface OfflineOfficeViewSnapshot {
  content: string
  cachedAt: number
}

const writeQueues = new Map<string, Promise<void>>()

const openDatabase = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
  const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
  request.onupgradeneeded = () => {
    if (!request.result.objectStoreNames.contains(STORE_NAME)) {
      request.result.createObjectStore(STORE_NAME)
    }
  }
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(request.error || new Error('无法打开离线缓存'))
})

const readSnapshot = async <T>(key: string): Promise<T | null> => {
  try {
    const database = await openDatabase()
    return await new Promise<T | null>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readonly')
      const request = transaction.objectStore(STORE_NAME).get(key)
      request.onsuccess = () => resolve((request.result as T | undefined) || null)
      request.onerror = () => reject(request.error || new Error('无法读取离线缓存'))
      transaction.oncomplete = () => database.close()
      transaction.onerror = () => database.close()
    })
  } catch {
    return null
  }
}

const queueWrite = (key: string, operation: () => Promise<void>) => {
  const previous = writeQueues.get(key) || Promise.resolve()
  const next = previous.catch(() => undefined).then(operation)
  writeQueues.set(key, next)
  return next.finally(() => {
    if (writeQueues.get(key) === next) writeQueues.delete(key)
  })
}

const writeSnapshot = async (key: string, value: unknown): Promise<void> => {
  await queueWrite(key, async () => {
    try {
      const database = await openDatabase()
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, 'readwrite')
        transaction.objectStore(STORE_NAME).put(value, key)
        transaction.oncomplete = () => {
          database.close()
          resolve()
        }
        transaction.onerror = () => {
          database.close()
          reject(transaction.error || new Error('无法写入离线缓存'))
        }
      })
    } catch {
      // Offline reading is an enhancement. Private browsing or quota limits must
      // not prevent the regular workspace from working.
    }
  })
}

const deleteSnapshot = async (key: string): Promise<void> => {
  await queueWrite(key, async () => {
    try {
      const database = await openDatabase()
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, 'readwrite')
        transaction.objectStore(STORE_NAME).delete(key)
        transaction.oncomplete = () => {
          database.close()
          resolve()
        }
        transaction.onerror = () => {
          database.close()
          reject(transaction.error || new Error('无法删除离线缓存'))
        }
      })
    } catch {
      // Cache cleanup must never block the regular workspace.
    }
  })
}

const fileCacheKey = (path: string, kind: OfflineWorkspaceFileKind) => `file:${path}:${kind}`

export const getOfflineWorkspaceFile = async (
  path: string,
  kind: OfflineWorkspaceFileKind = 'last-known-good'
): Promise<OfflineWorkspaceFileSnapshot | null> => {
  const current = await readSnapshot<OfflineWorkspaceFileSnapshot>(fileCacheKey(path, kind))
  if (current) return { ...current, kind: current.kind || kind }

  // Read snapshots written by the pre-v2 cache as last-known-good content. They
  // are never used to seed an online Y.Doc; this fallback is only for offline UI.
  if (kind !== 'last-known-good') return null
  const legacy = await readSnapshot<Omit<OfflineWorkspaceFileSnapshot, 'kind'>>(`file:${path}`)
  return legacy ? { ...legacy, kind } : null
}

export const putOfflineWorkspaceFile = (
  snapshot: Omit<OfflineWorkspaceFileSnapshot, 'cachedAt'>
) => writeSnapshot(fileCacheKey(snapshot.path, snapshot.kind), {
  ...snapshot,
  cachedAt: Date.now(),
})

export const removeOfflineWorkspaceFile = (path: string, kind: OfflineWorkspaceFileKind) =>
  deleteSnapshot(fileCacheKey(path, kind))

export const getOfflineWorkspaceTree = () =>
  readSnapshot<OfflineWorkspaceTreeSnapshot>(TREE_KEY)

export const putOfflineWorkspaceTree = (files: unknown[]) =>
  writeSnapshot(TREE_KEY, { files, cachedAt: Date.now() })

export const getOfflinePdf = (sourceUrl: string) =>
  readSnapshot<OfflinePdfSnapshot>(`pdf:${sourceUrl}`)

export const putOfflinePdf = (sourceUrl: string, blob: Blob) =>
  writeSnapshot(`pdf:${sourceUrl}`, { blob, cachedAt: Date.now() })

export const getOfflineOfficeView = (path: string, mode: string) =>
  readSnapshot<OfflineOfficeViewSnapshot>(`office:${path}:${mode}`)

export const putOfflineOfficeView = (path: string, mode: string, content: string) =>
  writeSnapshot(`office:${path}:${mode}`, { content, cachedAt: Date.now() })
