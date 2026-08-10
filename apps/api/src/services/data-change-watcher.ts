import { watch as watchFs, type FSWatcher } from 'node:fs'
import { lstat, mkdir, readdir } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { config } from '../lib/config.js'
import { isDefaultIgnoredDataPath, normalizeDataRelativePath } from '../lib/data-sync-policy.js'

export type DataChangeKind = 'change' | 'delete'
export type DataChangeSource = 'filesystem' | 'file-service' | 'live-file' | 'webdav'

export interface DataChangeEvent {
  path: string
  kind: DataChangeKind
  source: DataChangeSource
  signature: string | null
  at: string
}

type DataChangeInput = {
  path: string
  kind?: DataChangeKind
  source: Exclude<DataChangeSource, 'filesystem'>
}

type Subscriber = (event: DataChangeEvent) => void | Promise<void>

type RecentSource = {
  signature: string | null
  expiresAt: number
}

const EVENT_SETTLE_MS = 100
const SOURCE_SUPPRESSION_MS = 10_000
const FALLBACK_POLL_INTERVAL_MS = 5_000
const MAX_FALLBACK_ENTRIES = 200_000

export class DataChangeWatcher {
  private rootDir: string
  private directoryWatchers = new Map<string, FSWatcher>()
  private reconcileTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private fallbackTimer: ReturnType<typeof setInterval> | null = null
  private fallbackSnapshot: Map<string, string> | null = null
  private settleTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private subscribers = new Set<Subscriber>()
  private recentSources = new Map<string, RecentSource>()
  private deliveryQueue: Promise<void> = Promise.resolve()
  private started = false
  private fallbackStarting = false
  private fallbackScanning = false

  constructor(rootDir = config.dataDir) {
    this.rootDir = resolve(rootDir)
  }

  subscribe(subscriber: Subscriber) {
    this.subscribers.add(subscriber)
    return () => {
      this.subscribers.delete(subscriber)
      if (!this.subscribers.size) this.stop()
    }
  }

  async start() {
    if (this.started) return
    this.started = true
    await mkdir(this.rootDir, { recursive: true })

    try {
      await this.watchDirectoryTree(this.rootDir)
      if (!this.directoryWatchers.has(this.rootDir)) throw new Error('无法监听 data 根目录')
    } catch (error) {
      await this.switchToFallback(error as Error)
    }
  }

  stop() {
    this.started = false
    this.closeNativeWatchers()
    if (this.fallbackTimer) clearInterval(this.fallbackTimer)
    this.fallbackTimer = null
    this.fallbackSnapshot = null
    for (const timer of this.settleTimers.values()) clearTimeout(timer)
    this.settleTimers.clear()
    for (const timer of this.reconcileTimers.values()) clearTimeout(timer)
    this.reconcileTimers.clear()
    this.recentSources.clear()
  }

  private async watchDirectoryTree(directory: string, emitExistingFiles = false): Promise<void> {
    if (!this.started || this.fallbackTimer) return
    const normalizedDirectory = resolve(directory)
    const relativeDirectory = normalizeDataRelativePath(relative(this.rootDir, normalizedDirectory))
    if (relativeDirectory && isDefaultIgnoredDataPath(relativeDirectory)) return

    const newlyWatched = !this.directoryWatchers.has(normalizedDirectory)
    if (newlyWatched) {
      const watcher = watchFs(normalizedDirectory, { persistent: false }, (eventType, filename) => {
        const path = filename == null
          ? relativeDirectory
          : normalizeDataRelativePath(relativeDirectory ? `${relativeDirectory}/${String(filename)}` : String(filename))
        this.scheduleFilesystemEvent(path)
        if (eventType === 'rename') this.scheduleWatcherReconcile(path)
      })
      watcher.on('error', (error) => {
        void this.switchToFallback(error)
      })
      this.directoryWatchers.set(normalizedDirectory, watcher)
    }

    let entries
    try {
      entries = await readdir(normalizedDirectory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const childAbsolutePath = join(normalizedDirectory, entry.name)
      const childPath = normalizeDataRelativePath(relative(this.rootDir, childAbsolutePath))
      if (isDefaultIgnoredDataPath(childPath)) continue
      if (entry.isDirectory()) {
        await this.watchDirectoryTree(childAbsolutePath, emitExistingFiles)
      } else if (entry.isFile() && emitExistingFiles && newlyWatched) {
        this.scheduleFilesystemEvent(childPath)
      }
    }
  }

  private scheduleWatcherReconcile(path: string) {
    if (path && isDefaultIgnoredDataPath(path)) return
    const previous = this.reconcileTimers.get(path)
    if (previous) clearTimeout(previous)
    const timer = setTimeout(() => {
      this.reconcileTimers.delete(path)
      void this.reconcileWatcherPath(path).catch(error => this.switchToFallback(error as Error))
    }, EVENT_SETTLE_MS)
    timer.unref?.()
    this.reconcileTimers.set(path, timer)
  }

  private async reconcileWatcherPath(path: string) {
    if (!this.started || this.fallbackTimer) return
    const absolutePath = resolve(this.rootDir, path)
    if (absolutePath !== this.rootDir && !absolutePath.startsWith(`${this.rootDir}${sep}`)) return
    if (path && isDefaultIgnoredDataPath(path)) {
      this.closeWatcherSubtree(absolutePath)
      return
    }

    try {
      const info = await lstat(absolutePath)
      if (info.isSymbolicLink() || !info.isDirectory()) {
        this.closeWatcherSubtree(absolutePath)
        return
      }
      await this.watchDirectoryTree(absolutePath, true)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.closeWatcherSubtree(absolutePath)
        return
      }
      throw error
    }
  }

  private closeWatcherSubtree(directory: string) {
    const normalizedDirectory = resolve(directory)
    for (const [watchedPath, watcher] of this.directoryWatchers) {
      if (watchedPath === normalizedDirectory || watchedPath.startsWith(`${normalizedDirectory}${sep}`)) {
        watcher.close()
        this.directoryWatchers.delete(watchedPath)
      }
    }
  }

  private closeNativeWatchers() {
    for (const watcher of this.directoryWatchers.values()) watcher.close()
    this.directoryWatchers.clear()
  }

  private async switchToFallback(error: Error) {
    if (!this.started || this.fallbackTimer || this.fallbackStarting) return
    console.warn('[DataChangeWatcher] native watcher failed, switching to polling:', error.message)
    this.closeNativeWatchers()
    for (const timer of this.reconcileTimers.values()) clearTimeout(timer)
    this.reconcileTimers.clear()
    await this.startFallbackPolling()
  }

  async publish(input: DataChangeInput) {
    const path = normalizeDataRelativePath(input.path)
    if (path.split('/').some(part => part === '..' || part.includes('\0'))) return
    if (path && isDefaultIgnoredDataPath(path)) return
    const signature = input.kind === 'delete' ? null : await this.readSignature(path)
    if (signature === undefined) return
    const kind: DataChangeKind = input.kind || (signature == null ? 'delete' : 'change')
    this.rememberSource(path, signature)
    void this.dispatch({
      path,
      kind,
      source: input.source,
      signature,
      at: new Date().toISOString(),
    })
  }

  private rememberSource(path: string, signature: string | null) {
    this.recentSources.set(path, {
      signature,
      expiresAt: Date.now() + SOURCE_SUPPRESSION_MS,
    })
  }

  private scheduleFilesystemEvent(path: string) {
    if (path.split('/').some(part => part === '..' || part.includes('\0'))) return
    if (path && isDefaultIgnoredDataPath(path)) return
    const previous = this.settleTimers.get(path)
    if (previous) clearTimeout(previous)
    const timer = setTimeout(() => {
      this.settleTimers.delete(path)
      void this.emitFilesystemEvent(path)
    }, EVENT_SETTLE_MS)
    timer.unref?.()
    this.settleTimers.set(path, timer)
  }

  private async emitFilesystemEvent(path: string, knownSignature?: string | null) {
    if (path && isDefaultIgnoredDataPath(path)) return
    const signature = knownSignature === undefined ? await this.readSignature(path) : knownSignature
    if (signature === undefined) return
    const recent = this.recentSources.get(path)
    if (recent) {
      if (recent.expiresAt < Date.now()) this.recentSources.delete(path)
      else if (recent.signature === signature) return
    }

    await this.dispatch({
      path,
      kind: signature == null ? 'delete' : 'change',
      source: 'filesystem',
      signature,
      at: new Date().toISOString(),
    })
  }

  private async readSignature(path: string) {
    if (!path) return 'directory:root'
    const absolutePath = resolve(this.rootDir, path)
    if (absolutePath !== this.rootDir && !absolutePath.startsWith(`${this.rootDir}${sep}`)) return undefined
    try {
      const info = await lstat(absolutePath)
      if (info.isSymbolicLink()) return undefined
      return info.isDirectory()
        ? 'directory'
        : `file:${info.size}:${Math.round(info.mtimeMs)}`
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  private dispatch(event: DataChangeEvent) {
    this.deliveryQueue = this.deliveryQueue
      .then(async () => {
        for (const subscriber of this.subscribers) {
          try {
            await subscriber(event)
          } catch (error) {
            console.warn('[DataChangeWatcher] subscriber failed:', (error as Error).message)
          }
        }
      })
      .catch(() => {})
    return this.deliveryQueue
  }

  private async startFallbackPolling() {
    if (!this.started || this.fallbackStarting || this.fallbackTimer) return
    this.fallbackStarting = true
    try {
      this.fallbackSnapshot = await this.collectSnapshot()
      if (!this.started) return
      this.fallbackTimer = setInterval(() => {
        void this.pollFallback()
      }, FALLBACK_POLL_INTERVAL_MS)
      this.fallbackTimer.unref?.()
    } finally {
      this.fallbackStarting = false
    }
  }

  private async pollFallback() {
    if (!this.started || this.fallbackScanning) return
    this.fallbackScanning = true
    try {
      const next = await this.collectSnapshot()
      const previous = this.fallbackSnapshot
      this.fallbackSnapshot = next
      if (!previous) return

      const changed = new Set<string>()
      for (const [path, signature] of next) {
        if (previous.get(path) !== signature) changed.add(path)
      }
      for (const path of previous.keys()) {
        if (!next.has(path)) changed.add(path)
      }
      for (const path of [...changed].sort()) {
        await this.emitFilesystemEvent(path, next.get(path) ?? null)
      }
    } finally {
      this.fallbackScanning = false
    }
  }

  private async collectSnapshot() {
    const snapshot = new Map<string, string>()
    let count = 0

    const walk = async (directory: string) => {
      if (count >= MAX_FALLBACK_ENTRIES) return
      let entries
      try {
        entries = await readdir(directory, { withFileTypes: true })
      } catch {
        return
      }

      for (const entry of entries) {
        if (count >= MAX_FALLBACK_ENTRIES) break
        if (entry.isSymbolicLink()) continue
        const absolutePath = join(directory, entry.name)
        const path = relative(this.rootDir, absolutePath).split(sep).join('/')
        if (isDefaultIgnoredDataPath(path)) continue
        try {
          const info = await lstat(absolutePath)
          if (info.isSymbolicLink()) continue
          snapshot.set(path, info.isDirectory()
            ? 'directory'
            : `file:${info.size}:${Math.round(info.mtimeMs)}`)
          count += 1
          if (info.isDirectory()) await walk(absolutePath)
        } catch {
          // The next poll will observe files that changed during this scan.
        }
      }
    }

    await walk(this.rootDir)
    if (count >= MAX_FALLBACK_ENTRIES) {
      console.warn(`[DataChangeWatcher] polling snapshot reached ${MAX_FALLBACK_ENTRIES} entries`)
    }
    return snapshot
  }
}

const watcherRegistry = new Map<string, DataChangeWatcher>()

export const getDataChangeWatcher = (rootDir = config.dataDir) => {
  const key = resolve(rootDir)
  let watcher = watcherRegistry.get(key)
  if (!watcher) {
    watcher = new DataChangeWatcher(key)
    watcherRegistry.set(key, watcher)
  }
  return watcher
}

export const dataChangeWatcher = getDataChangeWatcher()
