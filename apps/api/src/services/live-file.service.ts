import { access, readFile, stat } from 'node:fs/promises'
import { basename, extname, relative, resolve, sep } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import * as Y from 'yjs'
import DiffMatchPatch from 'diff-match-patch'
import { atomicWriteTextFile } from '../lib/atomic-file.js'
import { config } from '../lib/config.js'
import { AppError } from '../lib/errors.js'
import { sseHub } from '../lib/sse.js'
import { getDataChangeWatcher } from './data-change-watcher.js'

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonl', '.yaml', '.yml', '.toml', '.csv', '.tsv',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.css', '.scss', '.html', '.xml',
  '.py', '.r', '.jl', '.m', '.c', '.h', '.cc', '.cpp', '.hpp', '.sh', '.zsh', '.fish', '.sql', '.log',
  '.bib', '.tex', '.sty', '.cls', '.bst', '.ini', '.cfg', '.conf', '.env.example',
])
const TEXT_FILE_NAMES = new Set(['.gitignore', '.gitattributes', 'Dockerfile', 'Makefile'])
const MAX_TEXT_FILE_SIZE = 2 * 1024 * 1024
const AUTOSAVE_DELAY_MS = 800
const RETIRE_CLEAN_DELAY_MS = 30_000
const RETIRE_CONFLICT_DELAY_MS = 10 * 60_000
const dmp = new DiffMatchPatch()
dmp.Diff_Timeout = 1

type LiveFileSource = 'client' | 'api' | 'agent' | 'disk' | 'conflict'
type LiveFileOrigin = { source: LiveFileSource; clientId?: string }
type ChangeRange = { start: number; end: number }
type LiveSocket = { send(data: string): void; close?: () => void }
interface LiveClient { id: string; ws: LiveSocket }

export interface LiveFlushResult {
  revision: number
  hash: string
  savedAt?: string
  conflict: boolean
}

export interface LiveFileServiceOptions {
  rootDir?: string
  workspaceKind?: 'global' | 'project'
  projectId?: string
  beforeWrite?: (path: string, source: LiveFileSource) => Promise<void>
  afterWrite?: (path: string, source: LiveFileSource) => Promise<void>
}

interface LiveFileSession {
  path: string
  fullPath: string
  ydoc: Y.Doc
  ytext: Y.Text
  clients: Map<string, LiveClient>
  baseDiskContent: string
  baseDiskHash: string
  lastFlushedHash: string
  lastFlushedMtimeMs: number
  lastFlushAt: number
  dirty: boolean
  saving: boolean
  conflict: boolean
  externalDiskContent?: string
  externalDiskHash?: string
  modified: string
  language: string
  contentRevision: number
  lastSavedRevision: number
  sessionEpoch: string
  saveTimer: ReturnType<typeof setTimeout> | null
  retireTimer: ReturnType<typeof setTimeout> | null
  lastSource: LiveFileSource
}

const hashText = (text: string) => createHash('sha256').update(text, 'utf-8').digest('hex')
const toBase64 = (update: Uint8Array) => Buffer.from(update).toString('base64')
const fromBase64 = (value: string) => new Uint8Array(Buffer.from(value, 'base64'))
const normalizeRelativePath = (filePath = '') => {
  const normalized = filePath.replace(/\\/g, '/').replace(/^\/+/, '')
  return normalized === '.' || normalized === './' ? '' : normalized
}
const extensionFor = (path: string) => path.toLowerCase().endsWith('.env.example') ? '.env.example' : extname(path.toLowerCase())
const languageFor = (path: string) => ({
  '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.vue': 'vue', '.json': 'json', '.jsonl': 'json', '.md': 'markdown', '.markdown': 'markdown', '.py': 'python', '.css': 'css',
  '.scss': 'scss', '.html': 'html', '.xml': 'xml', '.yaml': 'yaml', '.yml': 'yaml', '.sh': 'shell', '.sql': 'sql', '.bib': 'bibtex', '.tex': 'latex',
  '.sty': 'latex', '.cls': 'latex', '.bst': 'plaintext',
} as Record<string, string>)[extensionFor(path)] || 'plaintext'

const isSensitivePath = (filePath: string) => {
  const relPath = normalizeRelativePath(filePath)
  const segments = relPath.split('/').filter(Boolean)
  const name = segments[segments.length - 1] || ''
  if (!relPath) return false
  if (name !== '.env.example' && (name === '.env' || name.startsWith('.env.'))) return true
  return relPath === '.pi/agent/auth.json' || relPath.startsWith('.pi/agent/auth.json/')
    || relPath === '.pi/agent/models.json' || relPath.startsWith('.pi/agent/models.json/')
    || relPath.endsWith('.lock') || relPath.includes('.lock/')
}
const isHiddenPath = (filePath: string) => {
  const relPath = normalizeRelativePath(filePath)
  if (!relPath) return false
  if (isSensitivePath(relPath)) return true
  const segments = relPath.split('/').filter(Boolean)
  if (segments[0] === '.pi') return segments.slice(1).some(segment => segment.startsWith('.'))
  return segments.some(segment => segment.startsWith('.') && segment !== '.env.example')
}
const isProjectProtectedPath = (path: string) => normalizeRelativePath(path).split('/').filter(Boolean).some(segment => segment === '.git')
const isPapersPath = (path: string) => path === 'papers' || path.startsWith('papers/')
const isGlobalProtectedPath = (path: string) => !path || path === '.pi' || isPapersPath(path) || path === 'projects' || path.startsWith('projects/') || path === '.project-history' || path.startsWith('.project-history/')
const isEditable = (path: string, size?: number) => (TEXT_EXTENSIONS.has(extensionFor(path)) || TEXT_FILE_NAMES.has(basename(path))) && (size === undefined || size <= MAX_TEXT_FILE_SIZE)

const applyTextReplacement = (ytext: Y.Text, nextText: string, origin: unknown) => {
  const current = ytext.toString()
  if (current === nextText) return
  const diffs = dmp.diff_main(current, nextText)
  dmp.diff_cleanupSemantic(diffs)
  ytext.doc?.transact(() => {
    let index = 0
    for (const [op, text] of diffs) {
      if (op === DiffMatchPatch.DIFF_EQUAL) index += text.length
      else if (op === DiffMatchPatch.DIFF_DELETE) { if (text.length) ytext.delete(index, text.length) }
      else if (text) { ytext.insert(index, text); index += text.length }
    }
  }, origin)
}

type DmpPatch = { start1: number | null; length1: number; length2: number }
const getChangeRanges = (base: string, next: string): ChangeRange[] => {
  const patches = dmp.patch_make(base, next) as unknown as Array<DmpPatch & { diffs: Array<[number, string]> }>
  const ranges: ChangeRange[] = []
  for (const patch of patches) {
    let position = patch.start1 ?? 0
    let changeStart: number | null = null
    for (const [operation, text] of patch.diffs) {
      if (operation === DiffMatchPatch.DIFF_EQUAL) {
        if (changeStart !== null) { ranges.push({ start: changeStart, end: position }); changeStart = null }
        position += text.length
      } else if (operation === DiffMatchPatch.DIFF_DELETE) { changeStart ??= position; position += text.length }
      else changeStart ??= position
    }
    if (changeStart !== null) ranges.push({ start: changeStart, end: position })
  }
  return ranges
}
const rangesOverlap = (left: ChangeRange, right: ChangeRange) => {
  const li = left.start === left.end, ri = right.start === right.end
  if (li && ri) return left.start === right.start
  if (li) return left.start >= right.start && left.start <= right.end
  if (ri) return right.start >= left.start && right.start <= left.end
  return left.start < right.end && right.start < left.end
}
const hasOverlappingChanges = (base: string, live: string, disk: string) => {
  const a = getChangeRanges(base, live), b = getChangeRanges(base, disk)
  return a.some(left => b.some(right => rangesOverlap(left, right)))
}

export class LiveFileService {
  private rootDir: string
  private sessions = new Map<string, LiveFileSession>()
  private opening = new Map<string, Promise<LiveFileSession>>()
  private fileQueues = new Map<string, Promise<void>>()
  private workspaceQueue: Promise<void> = Promise.resolve()
  private watcher: ReturnType<typeof getDataChangeWatcher>

  constructor(private options: LiveFileServiceOptions = {}) {
    this.rootDir = resolve(options.rootDir || config.filesDir)
    this.watcher = getDataChangeWatcher(this.rootDir)
  }

  private normalizePath(path: string) { return normalizeRelativePath(path) }
  private assertProjectAgentPath(relPath: string | null) {
    if (this.options.workspaceKind !== 'project' || !relPath) return
    if (isSensitivePath(relPath)) throw new AppError('FORBIDDEN', 'Access denied', 403)
    if (isProjectProtectedPath(relPath)) throw new AppError('PROTECTED_PATH', '.git is managed only through Project Git', 403)
  }
  private resolvePath(filePath = '') {
    const relPath = this.normalizePath(filePath)
    if (isSensitivePath(relPath)) throw new AppError('FORBIDDEN', 'Access denied', 403)
    if (this.options.workspaceKind === 'project') {
      if (isProjectProtectedPath(relPath)) throw new AppError('PROTECTED_PATH', '.git is managed only through Project Git', 403)
    } else {
      if (isHiddenPath(relPath)) throw new AppError('FORBIDDEN', 'Access denied', 403)
      if (isGlobalProtectedPath(relPath)) throw new AppError('PROTECTED_PATH', 'This path is protected', 403)
    }
    const fullPath = resolve(this.rootDir, relPath)
    if (fullPath !== this.rootDir && !fullPath.startsWith(`${this.rootDir}${sep}`)) throw new AppError('FORBIDDEN', 'Access denied', 403)
    return fullPath
  }
  private toRelativePath(fullPath: string) { const rel = relative(this.rootDir, fullPath).replace(/\\/g, '/'); return rel === '.' ? '' : rel }
  private relativePathFromAbsolute(fullPath: string) {
    const resolvedPath = resolve(fullPath)
    if (resolvedPath !== this.rootDir && !resolvedPath.startsWith(`${this.rootDir}${sep}`)) return null
    return this.toRelativePath(resolvedPath)
  }
  private async withFileQueue<T>(filePath: string, operation: () => Promise<T>) {
    const key = this.normalizePath(filePath)
    const previous = this.fileQueues.get(key) || Promise.resolve()
    let release!: () => void
    const current = new Promise<void>(resolveCurrent => { release = resolveCurrent })
    const next = previous.catch(() => undefined).then(() => current)
    this.fileQueues.set(key, next)
    await previous.catch(() => undefined)
    try { return await operation() } finally { release(); if (this.fileQueues.get(key) === next) this.fileQueues.delete(key) }
  }
  async withWorkspaceMutationLock<T>(operation: () => Promise<T>) {
    const previous = this.workspaceQueue
    let release!: () => void
    const current = new Promise<void>(resolveCurrent => { release = resolveCurrent })
    this.workspaceQueue = previous.catch(() => undefined).then(() => current)
    await previous.catch(() => undefined)
    try { return await operation() } finally { release() }
  }
  private async readDiskText(filePath: string) {
    const relPath = this.normalizePath(filePath), fullPath = this.resolvePath(relPath)
    const entryStat = await stat(fullPath).catch(() => { throw new AppError('NOT_FOUND', 'File not found', 404) })
    if (!entryStat.isFile()) throw new AppError('NOT_FILE', 'Path is not a file', 400)
    if (!isEditable(relPath, entryStat.size)) throw new AppError('UNSUPPORTED_FILE', 'This file type or size cannot be edited as text', 400)
    return { relPath, fullPath, content: await readFile(fullPath, 'utf-8'), language: languageFor(relPath), modified: entryStat.mtime.toISOString(), mtimeMs: entryStat.mtimeMs }
  }
  private async writeDiskText(session: LiveFileSession, content: string, revision: number) {
    if (this.options.workspaceKind !== 'project' && isGlobalProtectedPath(session.path)) throw new AppError('PROTECTED_PATH', 'This path is protected', 403)
    const size = Buffer.byteLength(content, 'utf-8')
    if (!isEditable(session.path, size)) throw new AppError('UNSUPPORTED_FILE', 'Only supported text files up to 2MB can be written', 400)
    await this.options.beforeWrite?.(session.path, session.lastSource)
    await atomicWriteTextFile(session.fullPath, content)
    const entryStat = await stat(session.fullPath), hash = hashText(content)
    session.baseDiskContent = content; session.baseDiskHash = hash; session.lastFlushedHash = hash
    session.lastFlushedMtimeMs = entryStat.mtimeMs; session.lastFlushAt = Date.now(); session.lastSavedRevision = revision; session.modified = entryStat.mtime.toISOString()
    await this.options.afterWrite?.(session.path, session.lastSource)
  }
  private getStatus(session: LiveFileSession) {
    return { path: session.path, dirty: session.dirty, saving: session.saving, conflict: session.conflict, modified: session.modified,
      savedAt: session.lastFlushAt ? new Date(session.lastFlushAt).toISOString() : undefined, clients: session.clients.size,
      revision: session.contentRevision, savedRevision: session.lastSavedRevision, sessionEpoch: session.sessionEpoch,
      contentHash: hashText(session.ytext.toString()), diskHash: session.lastFlushedHash }
  }
  private send(client: LiveClient, message: unknown) { try { client.ws.send(JSON.stringify(message)) } catch {} }
  private broadcast(session: LiveFileSession, message: unknown, exceptClientId?: string) {
    const payload = JSON.stringify(message)
    for (const client of session.clients.values()) if (client.id !== exceptClientId) try { client.ws.send(payload) } catch {}
  }
  private broadcastStatus(session: LiveFileSession) { this.broadcast(session, { type: 'status', status: this.getStatus(session) }) }
  private emitChange(action: string, path: string) {
    if (this.options.workspaceKind === 'project' && this.options.projectId) sseHub.emit({ type: 'project-files-changed', projectId: this.options.projectId, action, path, live: true, at: new Date().toISOString() })
    else sseHub.emit({ type: 'files-changed', action, path, at: new Date().toISOString() })
  }
  private logPersistence(session: LiveFileSession, event: string, details: Record<string, unknown> = {}) {
    console.info('[LiveFile]', { event, workspaceKind: this.options.workspaceKind || 'global', projectId: this.options.projectId, path: session.path,
      revision: session.contentRevision, savedRevision: session.lastSavedRevision, sessionEpoch: session.sessionEpoch,
      contentHash: hashText(session.ytext.toString()), diskHash: session.lastFlushedHash, ...details })
  }
  private attachUpdateHandler(session: LiveFileSession) {
    session.ydoc.on('update', (update: Uint8Array, origin: LiveFileOrigin | string | null) => {
      const source: LiveFileSource = typeof origin === 'object' && origin?.source ? origin.source : 'client'
      const clientId = typeof origin === 'object' && typeof origin?.clientId === 'string' ? origin.clientId : undefined
      session.lastSource = source
      session.contentRevision++
      if (!session.conflict) { session.externalDiskContent = undefined; session.externalDiskHash = undefined }
      session.dirty = true
      this.broadcast(session, { type: 'update', path: session.path, update: toBase64(update), source, revision: session.contentRevision, sessionEpoch: session.sessionEpoch }, clientId)
      this.scheduleSave(session); this.broadcastStatus(session)
    })
  }
  private scheduleSave(session: LiveFileSession, delayMs = AUTOSAVE_DELAY_MS) {
    if (session.saveTimer) clearTimeout(session.saveTimer)
    session.saveTimer = setTimeout(() => { session.saveTimer = null; void this.flush(session.path).catch(err => {
      session.saving = false; this.broadcast(session, { type: 'error', code: 'SAVE_FAILED', message: (err as Error).message || '保存失败' }); this.broadcastStatus(session)
    }) }, delayMs)
  }
  private scheduleRetire(session: LiveFileSession) {
    if (session.clients.size > 0) return
    if (session.retireTimer) clearTimeout(session.retireTimer)
    session.retireTimer = setTimeout(() => {
      if (session.clients.size > 0) return
      if (session.dirty && !session.conflict) { void this.flush(session.path).catch(() => undefined).finally(() => this.scheduleRetire(session)); return }
      session.ydoc.destroy(); this.sessions.delete(session.path)
    }, session.conflict ? RETIRE_CONFLICT_DELAY_MS : RETIRE_CLEAN_DELAY_MS)
  }
  hasSession(path: string) { return this.sessions.has(this.normalizePath(path)) }
  getStateUpdate(path: string) { const s = this.sessions.get(this.normalizePath(path)); return s ? toBase64(Y.encodeStateAsUpdate(s.ydoc)) : null }
  getSnapshot(path: string) {
    const s = this.sessions.get(this.normalizePath(path)); if (!s) return null
    return { content: s.ytext.toString(), language: s.language, modified: s.modified, live: true, dirty: s.dirty, saving: s.saving, conflict: s.conflict,
      revision: s.contentRevision, savedRevision: s.lastSavedRevision, sessionEpoch: s.sessionEpoch, contentHash: hashText(s.ytext.toString()), diskHash: s.lastFlushedHash }
  }
  async open(filePath: string) {
    const requestedPath = this.normalizePath(filePath), existing = this.sessions.get(requestedPath)
    if (existing) { if (existing.retireTimer) { clearTimeout(existing.retireTimer); existing.retireTimer = null }; return existing }
    const pending = this.opening.get(requestedPath); if (pending) return pending
    const opening = (async () => {
      const disk = await this.readDiskText(requestedPath), alreadyOpened = this.sessions.get(disk.relPath); if (alreadyOpened) return alreadyOpened
      const ydoc = new Y.Doc(), ytext = ydoc.getText('content'); ytext.insert(0, disk.content); const hash = hashText(disk.content)
      const session: LiveFileSession = { path: disk.relPath, fullPath: disk.fullPath, ydoc, ytext, clients: new Map(), baseDiskContent: disk.content, baseDiskHash: hash,
        lastFlushedHash: hash, lastFlushedMtimeMs: disk.mtimeMs, lastFlushAt: 0, dirty: false, saving: false, conflict: false, modified: disk.modified,
        language: disk.language, contentRevision: 0, lastSavedRevision: 0, sessionEpoch: randomUUID(), saveTimer: null, retireTimer: null, lastSource: 'api' }
      this.attachUpdateHandler(session); this.sessions.set(session.path, session); return session
    })()
    this.opening.set(requestedPath, opening)
    try { return await opening } finally { if (this.opening.get(requestedPath) === opening) this.opening.delete(requestedPath) }
  }
  async attachClient(filePath: string, ws: LiveSocket) {
    const session = await this.open(filePath), client: LiveClient = { id: randomUUID(), ws }; session.clients.set(client.id, client)
    if (session.retireTimer) { clearTimeout(session.retireTimer); session.retireTimer = null }
    this.send(client, { type: 'init', path: session.path, update: toBase64(Y.encodeStateAsUpdate(session.ydoc)), language: session.language, modified: session.modified,
      sessionEpoch: session.sessionEpoch, revision: session.contentRevision, status: this.getStatus(session) })
    this.broadcastStatus(session); return { session, client }
  }
  detachClient(filePath: string, clientId: string) {
    const session = this.sessions.get(this.normalizePath(filePath)); if (!session || !session.clients.delete(clientId)) return
    this.broadcastStatus(session)
    if (session.clients.size === 0) {
      if (session.dirty && !session.conflict) void this.flush(session.path).catch(() => undefined).finally(() => this.scheduleRetire(session))
      else this.scheduleRetire(session)
    }
  }
  async applyClientUpdate(filePath: string, updateBase64: string, clientId: string) {
    return this.withFileQueue(filePath, async () => {
      const session = this.sessions.get(this.normalizePath(filePath)); if (!session) throw new AppError('LIVE_SESSION_NOT_FOUND', 'Live file session not found', 404)
      Y.applyUpdate(session.ydoc, fromBase64(updateBase64), { source: 'client', clientId })
    })
  }
  async replaceContent(filePath: string, content: string, source: LiveFileSource = 'api', clientId?: string) {
    return this.withFileQueue(filePath, async () => { const session = await this.open(filePath); applyTextReplacement(session.ytext, content, { source, clientId }); return session })
  }
  private async markMissingDiskConflict(session: LiveFileSession) {
    if (session.saveTimer) { clearTimeout(session.saveTimer); session.saveTimer = null }
    session.conflict = true; session.externalDiskContent = undefined; session.externalDiskHash = undefined
    this.logPersistence(session, 'disk-missing-conflict')
    this.broadcast(session, { type: 'conflict', path: session.path, message: '文件已从磁盘删除，未保存的编辑不会自动覆盖删除操作。' }); this.broadcastStatus(session)
  }
  private flushResult(session: LiveFileSession, conflict = session.conflict): LiveFlushResult {
    return { revision: session.contentRevision, hash: hashText(session.ytext.toString()), savedAt: session.lastFlushAt ? new Date(session.lastFlushAt).toISOString() : undefined, conflict }
  }
  private async flushUnsafe(session: LiveFileSession, allowExternalOverwrite = false): Promise<LiveFlushResult> {
    if (session.saveTimer) { clearTimeout(session.saveTimer); session.saveTimer = null }
    if (session.conflict && !allowExternalOverwrite) { this.broadcastStatus(session); return this.flushResult(session, true) }
    let content = session.ytext.toString(), hash = hashText(content)
    if (!allowExternalOverwrite) {
      let disk
      try { disk = await this.readDiskText(session.path) } catch (err) {
        if (err instanceof AppError && err.code === 'NOT_FOUND') { await this.markMissingDiskConflict(session); return this.flushResult(session, true) }
        throw err
      }
      const diskHash = hashText(disk.content)
      if (diskHash !== session.lastFlushedHash) {
        if (diskHash === hash) {
          session.baseDiskContent = disk.content; session.baseDiskHash = diskHash; session.lastFlushedHash = diskHash; session.lastFlushedMtimeMs = disk.mtimeMs
          session.modified = disk.modified; session.dirty = false; session.lastSavedRevision = session.contentRevision; this.broadcastStatus(session); return this.flushResult(session, false)
        }
        await this.handleDiskChangeUnsafe(session)
        if (session.conflict) { this.broadcastStatus(session); return this.flushResult(session, true) }
        content = session.ytext.toString(); hash = hashText(content)
      }
    }
    if (!session.dirty && hash === session.lastFlushedHash) { this.broadcastStatus(session); return this.flushResult(session, false) }
    const revision = session.contentRevision; session.saving = true; this.logPersistence(session, 'save-start', { targetRevision: revision }); this.broadcastStatus(session)
    try { await this.writeDiskText(session, content, revision) } catch (err) {
      session.saving = false; this.logPersistence(session, 'save-failed', { message: (err as Error).message || '保存失败' }); this.broadcastStatus(session); throw err
    }
    session.saving = false
    if (session.contentRevision === revision && session.ytext.toString() === content) { session.dirty = false; session.lastSavedRevision = revision }
    else { session.dirty = hashText(session.ytext.toString()) !== session.lastFlushedHash; if (session.dirty) this.scheduleSave(session) }
    this.logPersistence(session, 'save-complete', { targetRevision: revision }); this.broadcastStatus(session)
    await this.watcher.publish({ path: session.path, source: 'live-file' }).catch(error => console.warn('[LiveFile] failed to publish data change:', (error as Error).message))
    this.emitChange('live-save', session.path)
    return { revision, hash, savedAt: new Date(session.lastFlushAt).toISOString(), conflict: false }
  }
  async flush(filePath: string, options: { allowExternalOverwrite?: boolean } = {}) {
    return this.withFileQueue(filePath, async () => { const session = this.sessions.get(this.normalizePath(filePath)); if (!session) return null; return this.withWorkspaceMutationLock(() => this.flushUnsafe(session, !!options.allowExternalOverwrite)) })
  }
  async flushAll(prefix = '') {
    const normalized = this.normalizePath(prefix)
    const sessions = [...this.sessions.values()].filter(s => !normalized || s.path === normalized || s.path.startsWith(`${normalized}/`))
    const results: LiveFlushResult[] = []
    for (const session of sessions) {
      const result = await this.flush(session.path)
      if (result) { if (result.conflict) throw new AppError('PROJECT_FILE_CONFLICT', `Live file conflict: ${session.path}`, 409); results.push(result) }
    }
    return results
  }
  async resolveConflict(filePath: string, strategy: 'use-live' | 'use-disk', clientId?: string) {
    return this.withFileQueue(filePath, async () => {
      const session = this.sessions.get(this.normalizePath(filePath)); if (!session) throw new AppError('LIVE_SESSION_NOT_FOUND', 'Live file session not found', 404)
      return this.withWorkspaceMutationLock(async () => {
        if (!session.conflict) return this.flushResult(session, false)
        if (strategy === 'use-disk') applyTextReplacement(session.ytext, session.externalDiskContent ?? (await this.readDiskText(session.path)).content, { source: 'conflict', clientId })
        session.conflict = false; session.externalDiskContent = undefined; session.externalDiskHash = undefined; session.dirty = true
        return this.flushUnsafe(session, true)
      })
    })
  }
  private async handleDiskChangeUnsafe(session: LiveFileSession): Promise<'none' | 'self' | 'live'> {
    let disk
    try { disk = await this.readDiskText(session.path) } catch (err) {
      if (err instanceof AppError && err.code === 'NOT_FOUND') { await this.markMissingDiskConflict(session); return 'live' }
      return 'none'
    }
    const diskHash = hashText(disk.content); if (diskHash === session.lastFlushedHash) return 'self'
    const live = session.ytext.toString()
    if (live === disk.content) {
      session.baseDiskContent = disk.content; session.baseDiskHash = diskHash; session.lastFlushedHash = diskHash; session.lastFlushedMtimeMs = disk.mtimeMs
      session.modified = disk.modified; session.dirty = false; session.lastSavedRevision = session.contentRevision
      if (session.saveTimer) { clearTimeout(session.saveTimer); session.saveTimer = null }; this.broadcastStatus(session); return 'live'
    }
    if (hasOverlappingChanges(session.baseDiskContent, live, disk.content)) {
      session.conflict = true; session.externalDiskContent = disk.content; session.externalDiskHash = diskHash; session.modified = disk.modified
      this.logPersistence(session, 'external-conflict', { source: 'disk', externalHash: diskHash })
      this.broadcast(session, { type: 'conflict', path: session.path, message: '文件已在磁盘被外部程序修改，且与当前编辑存在重叠修改。' }); this.broadcastStatus(session); return 'live'
    }
    const patches = dmp.patch_make(session.baseDiskContent, disk.content), [merged, results] = dmp.patch_apply(patches, live)
    if (results.some(result => !result)) {
      session.conflict = true; session.externalDiskContent = disk.content; session.externalDiskHash = diskHash; session.modified = disk.modified
      this.broadcast(session, { type: 'conflict', path: session.path, message: '文件已在磁盘被外部程序修改，无法安全合并到当前编辑内容。' }); this.broadcastStatus(session); return 'live'
    }
    session.modified = disk.modified; if (merged !== live) applyTextReplacement(session.ytext, merged, { source: 'disk' })
    session.baseDiskContent = disk.content; session.baseDiskHash = diskHash; session.lastFlushedHash = diskHash; session.lastFlushedMtimeMs = disk.mtimeMs
    const current = session.ytext.toString(); session.dirty = hashText(current) !== diskHash
    if (!session.dirty) { session.lastSavedRevision = session.contentRevision; if (session.saveTimer) { clearTimeout(session.saveTimer); session.saveTimer = null } }
    this.broadcastStatus(session); return 'live'
  }
  async handleDiskChange(filePath: string) {
    return this.withFileQueue(filePath, async () => { const session = this.sessions.get(this.normalizePath(filePath)); if (!session) return 'none' as const; return this.withWorkspaceMutationLock(() => this.handleDiskChangeUnsafe(session)) })
  }
  async readAgentFile(absolutePath: string) {
    const relPath = this.relativePathFromAbsolute(absolutePath)
    this.assertProjectAgentPath(relPath)
    const session = relPath ? this.sessions.get(relPath) : undefined
    return session ? Buffer.from(session.ytext.toString(), 'utf-8') : readFile(absolutePath)
  }
  async accessAgentFile(absolutePath: string) {
    const relPath = this.relativePathFromAbsolute(absolutePath)
    this.assertProjectAgentPath(relPath)
    if (relPath && this.sessions.has(relPath)) return
    await access(absolutePath)
  }
  async writeAgentFile(absolutePath: string, content: string, baseContent?: string) {
    const relPath = this.relativePathFromAbsolute(absolutePath)
    this.assertProjectAgentPath(relPath)
    const session = relPath ? this.sessions.get(relPath) : undefined
    if (!relPath || !session) {
      await this.withWorkspaceMutationLock(async () => {
        if (relPath) await this.options.beforeWrite?.(relPath, 'agent')
        await atomicWriteTextFile(absolutePath, content)
        if (relPath) { await this.options.afterWrite?.(relPath, 'agent'); await this.watcher.publish({ path: relPath, source: 'live-file' }).catch(() => undefined); this.emitChange('write', relPath) }
      }); return
    }
    await this.withFileQueue(relPath, async () => this.withWorkspaceMutationLock(async () => {
      if (session.conflict) throw new AppError('CONFLICT', '文件存在外部修改冲突，请先处理冲突', 409)
      await this.handleDiskChangeUnsafe(session); if (session.conflict) throw new AppError('CONFLICT', '文件存在外部修改冲突，请先处理冲突', 409)
      const live = session.ytext.toString()
      if (baseContent !== undefined) {
        if (content === baseContent) return
        if (hasOverlappingChanges(baseContent, live, content)) { session.conflict = true; this.broadcast(session, { type: 'conflict', path: session.path, message: 'Agent 修改与当前编辑存在重叠，请先处理冲突。' }); this.broadcastStatus(session); throw new AppError('CONFLICT', 'Agent 修改与当前编辑存在重叠，请先处理冲突', 409) }
        const [merged, results] = dmp.patch_apply(dmp.patch_make(baseContent, content), live)
        if (results.some(result => !result)) { session.conflict = true; this.broadcastStatus(session); throw new AppError('CONFLICT', 'Agent 修改无法安全合并到当前编辑内容', 409) }
        applyTextReplacement(session.ytext, merged, { source: 'agent' })
      } else {
        if (session.dirty && content !== live) { session.conflict = true; this.broadcastStatus(session); throw new AppError('CONFLICT', 'Agent 尝试覆盖尚未保存的当前编辑，请先处理冲突', 409) }
        applyTextReplacement(session.ytext, content, { source: 'agent' })
      }
      const result = await this.flushUnsafe(session); if (result.conflict) throw new AppError('CONFLICT', '文件存在外部修改冲突，请先处理冲突', 409)
    }))
  }
  async disposeAll() {
    await this.flushAll().catch(() => undefined)
    for (const session of this.sessions.values()) { if (session.saveTimer) clearTimeout(session.saveTimer); if (session.retireTimer) clearTimeout(session.retireTimer); session.ydoc.destroy() }
    this.sessions.clear(); this.opening.clear(); this.fileQueues.clear()
  }
}

export const liveFileService = new LiveFileService({ rootDir: config.filesDir, workspaceKind: 'global' })
