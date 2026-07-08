import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, relative, resolve, sep } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import * as Y from 'yjs'
import DiffMatchPatch from 'diff-match-patch'
import { config } from '../lib/config.js'
import { AppError } from '../lib/errors.js'
import { sseHub } from '../lib/sse.js'

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonl', '.yaml', '.yml', '.toml', '.csv', '.tsv',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.css', '.scss', '.html', '.xml',
  '.py', '.sh', '.sql', '.log', '.bib', '.tex', '.ini', '.conf', '.env.example',
])

const MAX_TEXT_FILE_SIZE = 2 * 1024 * 1024
const AUTOSAVE_DELAY_MS = 800
const RETIRE_CLEAN_DELAY_MS = 30_000
const RETIRE_CONFLICT_DELAY_MS = 10 * 60_000

const dmp = new DiffMatchPatch()
dmp.Diff_Timeout = 1

type LiveFileSource = 'client' | 'api' | 'disk' | 'conflict'

type LiveSocket = {
  send(data: string): void
  close?: () => void
}

interface LiveClient {
  id: string
  ws: LiveSocket
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
  saveTimer: ReturnType<typeof setTimeout> | null
  retireTimer: ReturnType<typeof setTimeout> | null
}

const hashText = (text: string) => createHash('sha256').update(text, 'utf-8').digest('hex')
const toBase64 = (update: Uint8Array) => Buffer.from(update).toString('base64')
const fromBase64 = (value: string) => new Uint8Array(Buffer.from(value, 'base64'))

const normalizeRelativePath = (filePath = ''): string => {
  const normalized = filePath.replace(/\\/g, '/').replace(/^\/+/, '')
  if (normalized === '.' || normalized === './') return ''
  return normalized
}

const extensionFor = (nameOrPath: string): string => {
  const lower = nameOrPath.toLowerCase()
  if (lower.endsWith('.env.example')) return '.env.example'
  return extname(lower)
}

const languageFor = (filePath: string): string => {
  const languageMap: Record<string, string> = {
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.mjs': 'javascript',
    '.cjs': 'javascript',
    '.vue': 'vue',
    '.json': 'json',
    '.jsonl': 'json',
    '.md': 'markdown',
    '.markdown': 'markdown',
    '.py': 'python',
    '.css': 'css',
    '.scss': 'scss',
    '.html': 'html',
    '.xml': 'xml',
    '.yaml': 'yaml',
    '.yml': 'yaml',
    '.sh': 'shell',
    '.sql': 'sql',
    '.bib': 'bibtex',
    '.tex': 'latex',
  }
  return languageMap[extensionFor(filePath)] || 'plaintext'
}

const isSensitivePath = (filePath: string): boolean => {
  const relPath = normalizeRelativePath(filePath)
  const segments = relPath.split('/').filter(Boolean)
  const name = segments[segments.length - 1] || ''
  if (!relPath) return false
  if (name !== '.env.example' && (name === '.env' || name.startsWith('.env.'))) return true
  return relPath === '.pi/agent/auth.json'
    || relPath.startsWith('.pi/agent/auth.json/')
    || relPath === '.pi/agent/models.json'
    || relPath.startsWith('.pi/agent/models.json/')
    || relPath.endsWith('.lock')
    || relPath.includes('.lock/')
}

const isHiddenPath = (filePath: string): boolean => {
  const relPath = normalizeRelativePath(filePath)
  if (!relPath) return false
  if (isSensitivePath(relPath)) return true

  const segments = relPath.split('/').filter(Boolean)
  if (segments[0] === '.pi') {
    return segments.slice(1).some((segment) => segment.startsWith('.'))
  }

  return segments.some((segment) => segment.startsWith('.') && segment !== '.env.example')
}

const isPapersPath = (filePath: string): boolean => {
  const relPath = normalizeRelativePath(filePath)
  return relPath === 'papers' || relPath.startsWith('papers/')
}

const isProtectedPath = (filePath: string): boolean => {
  const relPath = normalizeRelativePath(filePath)
  return !relPath || relPath === '.pi' || isPapersPath(relPath)
}

const isEditable = (filePath: string, size?: number): boolean => {
  const ext = extensionFor(filePath)
  return TEXT_EXTENSIONS.has(ext) && (size === undefined || size <= MAX_TEXT_FILE_SIZE)
}

const applyTextReplacement = (ytext: Y.Text, nextText: string, origin: unknown) => {
  const current = ytext.toString()
  if (current === nextText) return
  const diffs = dmp.diff_main(current, nextText)
  dmp.diff_cleanupSemantic(diffs)
  ytext.doc?.transact(() => {
    let index = 0
    for (const [op, text] of diffs) {
      if (op === DiffMatchPatch.DIFF_EQUAL) {
        index += text.length
      } else if (op === DiffMatchPatch.DIFF_DELETE) {
        if (text.length) ytext.delete(index, text.length)
      } else if (op === DiffMatchPatch.DIFF_INSERT) {
        if (text) {
          ytext.insert(index, text)
          index += text.length
        }
      }
    }
  }, origin)
}

export class LiveFileService {
  private rootDir = resolve(config.filesDir)
  private sessions = new Map<string, LiveFileSession>()

  private normalizePath(filePath: string) {
    return normalizeRelativePath(filePath)
  }

  private resolvePath(filePath = ''): string {
    const relPath = this.normalizePath(filePath)
    if (isHiddenPath(relPath) || isSensitivePath(relPath)) {
      throw new AppError('FORBIDDEN', 'Access denied', 403)
    }
    const fullPath = resolve(this.rootDir, relPath)
    if (fullPath !== this.rootDir && !fullPath.startsWith(`${this.rootDir}${sep}`)) {
      throw new AppError('FORBIDDEN', 'Access denied', 403)
    }
    return fullPath
  }

  private toRelativePath(fullPath: string): string {
    const rel = relative(this.rootDir, fullPath).replace(/\\/g, '/')
    return rel === '.' ? '' : rel
  }

  private async readDiskText(filePath: string) {
    const relPath = this.normalizePath(filePath)
    const fullPath = this.resolvePath(relPath)
    const entryStat = await stat(fullPath).catch(() => { throw new AppError('NOT_FOUND', 'File not found', 404) })
    if (!entryStat.isFile()) throw new AppError('NOT_FILE', 'Path is not a file', 400)
    if (!isEditable(relPath, entryStat.size)) {
      throw new AppError('UNSUPPORTED_FILE', 'This file type or size cannot be edited as text', 400)
    }
    const content = await readFile(fullPath, 'utf-8')
    return {
      relPath,
      fullPath,
      content,
      language: languageFor(relPath),
      modified: entryStat.mtime.toISOString(),
      mtimeMs: entryStat.mtimeMs,
    }
  }

  private async writeDiskText(session: LiveFileSession, content: string) {
    if (isProtectedPath(session.path)) throw new AppError('PROTECTED_PATH', 'This path is protected', 403)
    const size = Buffer.byteLength(content, 'utf-8')
    if (!isEditable(session.path, size)) {
      throw new AppError('UNSUPPORTED_FILE', 'Only supported text files up to 2MB can be written', 400)
    }
    await mkdir(dirname(session.fullPath), { recursive: true })
    await writeFile(session.fullPath, content, 'utf-8')
    const entryStat = await stat(session.fullPath)
    const hash = hashText(content)
    session.baseDiskContent = content
    session.baseDiskHash = hash
    session.lastFlushedHash = hash
    session.lastFlushedMtimeMs = entryStat.mtimeMs
    session.lastFlushAt = Date.now()
    session.modified = entryStat.mtime.toISOString()
  }

  private getStatus(session: LiveFileSession) {
    return {
      path: session.path,
      dirty: session.dirty,
      saving: session.saving,
      conflict: session.conflict,
      modified: session.modified,
      savedAt: session.lastFlushAt ? new Date(session.lastFlushAt).toISOString() : undefined,
      clients: session.clients.size,
    }
  }

  private send(client: LiveClient, message: unknown) {
    try { client.ws.send(JSON.stringify(message)) } catch { /* closed */ }
  }

  private broadcast(session: LiveFileSession, message: unknown, exceptClientId?: string) {
    const payload = JSON.stringify(message)
    for (const client of session.clients.values()) {
      if (client.id === exceptClientId) continue
      try { client.ws.send(payload) } catch { /* closed */ }
    }
  }

  private broadcastStatus(session: LiveFileSession) {
    this.broadcast(session, { type: 'status', status: this.getStatus(session) })
  }

  private attachUpdateHandler(session: LiveFileSession) {
    session.ydoc.on('update', (update: Uint8Array, origin: any) => {
      const source: LiveFileSource = origin?.source || 'client'
      const clientId = typeof origin?.clientId === 'string' ? origin.clientId : undefined
      session.conflict = false
      session.externalDiskContent = undefined
      session.externalDiskHash = undefined
      session.dirty = true
      this.broadcast(session, {
        type: 'update',
        path: session.path,
        update: toBase64(update),
        source,
      }, clientId)
      this.scheduleSave(session)
      this.broadcastStatus(session)
    })
  }

  private scheduleSave(session: LiveFileSession, delayMs = AUTOSAVE_DELAY_MS) {
    if (session.saveTimer) clearTimeout(session.saveTimer)
    session.saveTimer = setTimeout(() => {
      session.saveTimer = null
      void this.flush(session.path).catch((err) => {
        session.saving = false
        this.broadcast(session, { type: 'error', code: 'SAVE_FAILED', message: (err as Error).message || '保存失败' })
        this.broadcastStatus(session)
      })
    }, delayMs)
  }

  private scheduleRetire(session: LiveFileSession) {
    if (session.clients.size > 0) return
    if (session.retireTimer) clearTimeout(session.retireTimer)
    const delay = session.conflict ? RETIRE_CONFLICT_DELAY_MS : RETIRE_CLEAN_DELAY_MS
    session.retireTimer = setTimeout(() => {
      if (session.clients.size > 0) return
      if (session.dirty && !session.conflict) {
        void this.flush(session.path).finally(() => this.scheduleRetire(session))
        return
      }
      session.ydoc.destroy()
      this.sessions.delete(session.path)
    }, delay)
  }

  hasSession(filePath: string) {
    return this.sessions.has(this.normalizePath(filePath))
  }

  getSnapshot(filePath: string) {
    const session = this.sessions.get(this.normalizePath(filePath))
    if (!session) return null
    return {
      content: session.ytext.toString(),
      language: session.language,
      modified: session.modified,
      live: true,
      dirty: session.dirty,
      saving: session.saving,
      conflict: session.conflict,
    }
  }

  async open(filePath: string) {
    const disk = await this.readDiskText(filePath)
    const existing = this.sessions.get(disk.relPath)
    if (existing) {
      if (existing.retireTimer) {
        clearTimeout(existing.retireTimer)
        existing.retireTimer = null
      }
      return existing
    }

    const ydoc = new Y.Doc()
    const ytext = ydoc.getText('content')
    ytext.insert(0, disk.content)
    const hash = hashText(disk.content)
    const session: LiveFileSession = {
      path: disk.relPath,
      fullPath: disk.fullPath,
      ydoc,
      ytext,
      clients: new Map(),
      baseDiskContent: disk.content,
      baseDiskHash: hash,
      lastFlushedHash: hash,
      lastFlushedMtimeMs: disk.mtimeMs,
      lastFlushAt: 0,
      dirty: false,
      saving: false,
      conflict: false,
      modified: disk.modified,
      language: disk.language,
      saveTimer: null,
      retireTimer: null,
    }
    this.attachUpdateHandler(session)
    this.sessions.set(session.path, session)
    return session
  }

  async attachClient(filePath: string, ws: LiveSocket) {
    const session = await this.open(filePath)
    const client: LiveClient = { id: randomUUID(), ws }
    session.clients.set(client.id, client)
    if (session.retireTimer) {
      clearTimeout(session.retireTimer)
      session.retireTimer = null
    }

    this.send(client, {
      type: 'init',
      path: session.path,
      update: toBase64(Y.encodeStateAsUpdate(session.ydoc)),
      language: session.language,
      modified: session.modified,
      status: this.getStatus(session),
    })
    this.broadcastStatus(session)
    return { session, client }
  }

  detachClient(filePath: string, clientId: string) {
    const session = this.sessions.get(this.normalizePath(filePath))
    if (!session) return
    session.clients.delete(clientId)
    this.broadcastStatus(session)
    if (session.clients.size === 0) {
      if (session.dirty && !session.conflict) {
        void this.flush(session.path).finally(() => this.scheduleRetire(session))
      } else {
        this.scheduleRetire(session)
      }
    }
  }

  applyClientUpdate(filePath: string, updateBase64: string, clientId: string) {
    const session = this.sessions.get(this.normalizePath(filePath))
    if (!session) throw new AppError('LIVE_SESSION_NOT_FOUND', 'Live file session not found', 404)
    Y.applyUpdate(session.ydoc, fromBase64(updateBase64), { source: 'client', clientId })
  }

  async replaceContent(filePath: string, content: string, source: LiveFileSource = 'api') {
    const session = await this.open(filePath)
    applyTextReplacement(session.ytext, content, { source })
    return session
  }

  async flush(filePath: string) {
    const session = this.sessions.get(this.normalizePath(filePath))
    if (!session) return
    if (session.conflict) {
      this.broadcastStatus(session)
      return
    }
    if (session.saveTimer) {
      clearTimeout(session.saveTimer)
      session.saveTimer = null
    }

    let content = session.ytext.toString()
    let hash = hashText(content)

    // Do not blindly write the live buffer over a file that changed on disk
    // since the last baseline. This is the path used by Pi's built-in edit/write
    // tools, so merge it first instead of losing the agent's write.
    try {
      const disk = await this.readDiskText(session.path)
      const diskHash = hashText(disk.content)
      if (diskHash !== session.lastFlushedHash) {
        if (diskHash === hash) {
          session.baseDiskContent = disk.content
          session.baseDiskHash = diskHash
          session.lastFlushedHash = diskHash
          session.lastFlushedMtimeMs = disk.mtimeMs
          session.modified = disk.modified
          session.dirty = false
          this.broadcastStatus(session)
          return
        }

        await this.handleDiskChange(session.path)
        if (session.conflict) {
          this.broadcastStatus(session)
          return
        }
        content = session.ytext.toString()
        hash = hashText(content)
      }
    } catch {
      // Existing validation/write errors are handled by writeDiskText below.
    }

    if (!session.dirty && hash === session.lastFlushedHash) {
      this.broadcastStatus(session)
      return
    }
    session.saving = true
    this.broadcastStatus(session)
    await this.writeDiskText(session, content)
    session.dirty = false
    session.saving = false
    this.broadcastStatus(session)
    sseHub.emit({ type: 'files-changed', action: 'live-save', path: session.path, at: new Date().toISOString() })
  }

  async resolveConflict(filePath: string, strategy: 'use-live' | 'use-disk') {
    const session = this.sessions.get(this.normalizePath(filePath))
    if (!session) throw new AppError('LIVE_SESSION_NOT_FOUND', 'Live file session not found', 404)
    if (!session.conflict) return
    if (strategy === 'use-disk') {
      const diskContent = session.externalDiskContent ?? (await this.readDiskText(session.path)).content
      applyTextReplacement(session.ytext, diskContent, { source: 'conflict' })
    }
    session.conflict = false
    session.externalDiskContent = undefined
    session.externalDiskHash = undefined
    session.dirty = true
    await this.flush(session.path)
  }

  async handleDiskChange(filePath: string): Promise<'none' | 'self' | 'live'> {
    const relPath = this.normalizePath(filePath)
    const session = this.sessions.get(relPath)
    if (!session) return 'none'

    let disk
    try {
      disk = await this.readDiskText(relPath)
    } catch {
      return 'none'
    }
    const diskHash = hashText(disk.content)
    if (diskHash === session.lastFlushedHash) return 'self'

    const live = session.ytext.toString()
    const patches = dmp.patch_make(session.baseDiskContent, disk.content)
    const [merged, results] = dmp.patch_apply(patches, live)
    const safe = results.length === 0 || results.every(Boolean)

    if (!safe) {
      session.conflict = true
      session.externalDiskContent = disk.content
      session.externalDiskHash = diskHash
      session.modified = disk.modified
      this.broadcast(session, {
        type: 'conflict',
        path: session.path,
        message: '文件已在磁盘被外部程序修改，且无法安全合并到当前编辑内容。',
      })
      this.broadcastStatus(session)
      return 'live'
    }

    session.modified = disk.modified
    if (merged !== live) {
      applyTextReplacement(session.ytext, merged, { source: 'disk' })
    }

    // Mark this disk version as the new baseline even when the merge changed
    // the live document. Otherwise the same external write is re-applied by the
    // next watcher/poll pass, which duplicates inserted lines.
    session.baseDiskContent = disk.content
    session.baseDiskHash = diskHash
    session.lastFlushedHash = diskHash
    session.lastFlushedMtimeMs = disk.mtimeMs

    const current = session.ytext.toString()
    session.dirty = hashText(current) !== diskHash
    if (!session.dirty && session.saveTimer) {
      clearTimeout(session.saveTimer)
      session.saveTimer = null
    }
    this.broadcastStatus(session)
    return 'live'
  }

}

export const liveFileService = new LiveFileService()
