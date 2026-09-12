import { createHash } from 'node:crypto'
import { brotliCompress, brotliDecompress } from 'node:zlib'
import { promisify } from 'node:util'
import { lstat, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import { prisma } from '@yarc/db'
import { config } from '../lib/config.js'
import { AppError } from '../lib/errors.js'
import { sseHub } from '../lib/sse.js'
import { atomicWriteFile } from '../lib/atomic-file.js'
import { normalizeProjectRelativePath, resolveProjectPath, resolveProjectRoot } from '../lib/project-path.js'
import { DEFAULT_PROJECT_HISTORY_SETTINGS } from '../lib/project-history-settings.js'

const compress = promisify(brotliCompress)
const decompress = promisify(brotliDecompress)
const DEFAULT_EXTENSIONS = new Set(['.tex', '.bib', '.sty', '.cls', '.bst'])
const DELETED_HASH = createHash('sha256').update('').digest('hex')
const GC_OBJECT_GRACE_MS = 5 * 60_000

interface PendingProject {
  paths: Set<string>
  source: 'autosave' | 'external'
  firstAt: number
  idleTimer?: ReturnType<typeof setTimeout>
  maxTimer?: ReturnType<typeof setTimeout>
}

interface CheckpointInput {
  kind: string
  paths?: string[]
  label?: string
  metadata?: any
  forceBoundary?: boolean
  // Internal restore safety snapshots must not depend on current tracking settings.
  includeUntracked?: boolean
}

const globRegex = (pattern: string) => {
  let source = '^'
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        i++
        if (pattern[i + 1] === '/') { i++; source += '(?:.*/)?' } else source += '.*'
      } else source += '[^/]*'
    } else if (ch === '?') source += '[^/]'
    else source += ch.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
  }
  return new RegExp(`${source}$`)
}

const matchesAny = (path: string, patterns: string[]) => patterns.some(pattern => {
  try { return globRegex(pattern).test(path) } catch { return false }
})

export class ProjectHistoryService {
  private pending = new Map<string, PendingProject>()
  private pendingFlushes = new Map<string, ReturnType<ProjectHistoryService['checkpoint']>>()
  private retentionTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private retentionRuns = new Map<string, Promise<void>>()

  private objectPath(hash: string) {
    return join(config.projectHistoryDir, 'objects', hash.slice(0, 2), `${hash}.br`)
  }

  private async settings(projectId: string) {
    const { project } = await resolveProjectRoot(projectId)
    const custom = ((project.settings || {}) as any).history || {}
    return { ...DEFAULT_PROJECT_HISTORY_SETTINGS, ...custom }
  }

  async isTracked(projectId: string, path: string) {
    const relative = normalizeProjectRelativePath(path)
    if (!relative || relative.startsWith('.git/')) return false
    const settings = await this.settings(projectId)
    if (!settings.enabled) return false
    const included = settings.include?.length ? matchesAny(relative, settings.include) : DEFAULT_EXTENSIONS.has(extname(relative).toLowerCase())
    return included && !matchesAny(relative, settings.exclude || [])
  }

  private scheduleRetention(projectId: string, delayMs = 5_000) {
    const previous = this.retentionTimers.get(projectId)
    if (previous) clearTimeout(previous)
    const timer = setTimeout(() => {
      if (this.retentionTimers.get(projectId) === timer) this.retentionTimers.delete(projectId)
      void this.runRetentionGc(projectId).catch(error => console.warn('[ProjectHistory] retention failed:', (error as Error).message))
    }, delayMs)
    timer.unref?.()
    this.retentionTimers.set(projectId, timer)
  }

  private cancelScheduledRetention(projectId: string) {
    const timer = this.retentionTimers.get(projectId)
    if (timer) clearTimeout(timer)
    this.retentionTimers.delete(projectId)
  }

  private async waitForRetentionIdle(projectId: string) {
    const running = this.retentionRuns.get(projectId)
    if (running) await running.catch(() => undefined)
  }

  private async storeBlob(content: Buffer) {
    const hash = createHash('sha256').update(content).digest('hex')
    const target = this.objectPath(hash)
    try { await stat(target); return hash } catch {}
    await mkdir(dirname(target), { recursive: true })
    await atomicWriteFile(target, await compress(content))
    // Persist the directory entry before publishing a database reference.
    const directory = await open(dirname(target), 'r')
    try { await directory.sync() } finally { await directory.close() }
    return hash
  }

  private async readBlob(hash: string) {
    try { return await decompress(await readFile(this.objectPath(hash))) }
    catch { throw new AppError('PROJECT_HISTORY_BLOB_MISSING', `History object ${hash} is missing`, 500) }
  }

  async ensureBaseline(projectId: string, path: string, options: { missing?: boolean } = {}) {
    const relative = normalizeProjectRelativePath(path)
    if (!(await this.isTracked(projectId, relative))) return null
    const prior = await prisma.projectHistoryRevision.findFirst({
      where: { projectId, path: relative },
      orderBy: { checkpoint: { sequence: 'desc' } },
    })
    if (prior) return prior

    if (options.missing) {
      return this.createSingleRevision(projectId, 'baseline', relative, null, true, { baseline: true })
    }
    const resolved = await resolveProjectPath(projectId, relative)
    const info = await lstat(resolved.fullPath)
    if (!info.isFile()) return null
    const content = await readFile(resolved.fullPath)
    return this.createSingleRevision(projectId, 'baseline', relative, content, false, { baseline: true })
  }

  private async createSingleRevision(projectId: string, kind: string, path: string, content: Buffer | null, deleted: boolean, metadata: any = {}) {
    const blobHash = deleted || !content ? null : await this.storeBlob(content)
    const contentHash = deleted || !content ? DELETED_HASH : createHash('sha256').update(content).digest('hex')
    const checkpoint = await prisma.projectHistoryCheckpoint.create({
      data: {
        projectId, kind, metadata,
        revisions: { create: [{ projectId, path, contentHash, blobHash, size: content?.length || 0, deleted }] },
      },
      include: { revisions: true },
    })
    return checkpoint.revisions[0]
  }

  async trackChange(projectId: string, path: string, source: 'autosave' | 'external' = 'autosave') {
    const relative = normalizeProjectRelativePath(path)
    if (!(await this.isTracked(projectId, relative))) return
    let pending = this.pending.get(projectId)
    if (!pending) {
      pending = { paths: new Set(), source, firstAt: Date.now() }
      this.pending.set(projectId, pending)
    }
    pending.paths.add(relative)
    // External changes take precedence so a batch containing both editor and
    // external writes is not mislabeled as a normal autosave checkpoint.
    if (source === 'external') pending.source = 'external'
    if (pending.idleTimer) clearTimeout(pending.idleTimer)
    pending.idleTimer = undefined

    // Autosave and external changes use the same project-level debounce. This
    // lets saves to several files become one Writing History checkpoint rather
    // than producing a sequence of one-file checkpoints. The idle timer moves
    // with each edit, while the max timer stays anchored to the first edit.
    const settings = await this.settings(projectId)
    const idleDelayMs = Math.max(1, Number(settings.idleDebounceSeconds || 30)) * 1000
    const maxDelayMs = Math.max(1, Number(settings.maxIntervalSeconds || 120)) * 1000
    pending.idleTimer = setTimeout(() => this.flushInBackground(projectId), idleDelayMs)
    if (!pending.maxTimer) {
      pending.maxTimer = setTimeout(() => this.flushInBackground(projectId), Math.max(1, maxDelayMs - (Date.now() - pending!.firstAt)))
    }
    pending.idleTimer.unref?.()
    pending.maxTimer.unref?.()
  }

  private flushInBackground(projectId: string) {
    void this.flushPending(projectId).catch(() => console.warn('[ProjectHistory] checkpoint failed; pending paths retained for retry'))
  }

  /** Flush all queued project history before an API shutdown or other boundary. */
  async flushAllPending() {
    while (this.pending.size) {
      const projectIds = [...this.pending.keys()]
      for (const projectId of projectIds) await this.flushPending(projectId)
    }
  }

  async flushPending(projectId: string): ReturnType<ProjectHistoryService['checkpoint']> {
    // A caller requiring a flush boundary must also wait for an in-flight batch.
    while (this.pendingFlushes.has(projectId)) await this.pendingFlushes.get(projectId)
    const pending = this.pending.get(projectId)
    if (!pending) return null
    this.pending.delete(projectId)
    if (pending.idleTimer) clearTimeout(pending.idleTimer)
    if (pending.maxTimer) clearTimeout(pending.maxTimer)
    const running = this.checkpoint(projectId, { kind: pending.source, paths: [...pending.paths] })
    this.pendingFlushes.set(projectId, running)
    try {
      return await running
    } catch (error) {
      // Changes arriving during the failed write belong to the retry as well.
      const retry: PendingProject = this.pending.get(projectId) || { paths: new Set<string>(), source: pending.source, firstAt: pending.firstAt }
      for (const path of pending.paths) retry.paths.add(path)
      if (pending.source === 'external') retry.source = 'external'
      retry.firstAt = Math.min(retry.firstAt, pending.firstAt)
      if (retry.idleTimer) clearTimeout(retry.idleTimer)
      if (retry.maxTimer) clearTimeout(retry.maxTimer)
      retry.maxTimer = undefined
      retry.idleTimer = setTimeout(() => this.flushInBackground(projectId), 5_000)
      retry.idleTimer.unref?.()
      this.pending.set(projectId, retry)
      throw error
    } finally {
      this.pendingFlushes.delete(projectId)
    }
  }

  private async snapshotPath(projectId: string, path: string) {
    const relative = normalizeProjectRelativePath(path)
    try {
      const resolved = await resolveProjectPath(projectId, relative)
      const info = await lstat(resolved.fullPath)
      if (!info.isFile() || info.isSymbolicLink()) return { path: relative, deleted: true, contentHash: DELETED_HASH, blobHash: null as string | null, size: 0 }
      const content = await readFile(resolved.fullPath)
      const contentHash = createHash('sha256').update(content).digest('hex')
      return { path: relative, deleted: false, contentHash, blobHash: await this.storeBlob(content), size: content.length }
    } catch (error: any) {
      if (error instanceof AppError && ['NOT_FOUND', 'PROJECT_WORKSPACE_MISSING'].includes(error.code)) {
        return { path: relative, deleted: true, contentHash: DELETED_HASH, blobHash: null as string | null, size: 0 }
      }
      throw error
    }
  }

  async checkpoint(projectId: string, input: CheckpointInput) {
    await resolveProjectRoot(projectId)
    let paths = [...new Set((input.paths || []).map(normalizeProjectRelativePath).filter(Boolean))]
    if (!paths.length) paths = await this.listTrackedPaths(projectId)
    if (!input.includeUntracked) {
      paths = (await Promise.all(paths.map(async path => (await this.isTracked(projectId, path)) ? path : null))).filter(Boolean) as string[]
    }

    const revisions: Array<{ projectId: string; path: string; contentHash: string; blobHash: string | null; size: number; deleted: boolean }> = []
    for (const path of paths) {
      const snapshot = await this.snapshotPath(projectId, path)
      const previous = await prisma.projectHistoryRevision.findFirst({
        where: { projectId, path },
        orderBy: { checkpoint: { sequence: 'desc' } },
      })
      if (previous && previous.contentHash === snapshot.contentHash && previous.deleted === snapshot.deleted) continue
      revisions.push({ projectId, ...snapshot })
    }
    if (!revisions.length && !input.forceBoundary) return null
    const checkpoint = await prisma.projectHistoryCheckpoint.create({
      data: {
        projectId,
        kind: input.kind,
        label: input.label || null,
        metadata: input.metadata || {},
        revisions: { create: revisions },
      },
      include: { revisions: true },
    })
    if (input.kind !== 'pre-restore' && input.kind !== 'restore') this.scheduleRetention(projectId)
    sseHub.emit({
      type: 'project-files-changed',
      projectId,
      action: 'history-checkpoint',
      path: checkpoint.revisions[0]?.path,
      at: new Date().toISOString(),
    })
    return checkpoint
  }

  private async walkTracked(projectId: string, relative = ''): Promise<string[]> {
    const resolved = await resolveProjectPath(projectId, relative)
    const entries = await readdir(resolved.fullPath, { withFileTypes: true })
    const result: string[] = []
    for (const entry of entries) {
      if (entry.name === '.git') continue
      const path = normalizeProjectRelativePath([relative, entry.name].filter(Boolean).join('/'))
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) result.push(...await this.walkTracked(projectId, path))
      else if (entry.isFile() && await this.isTracked(projectId, path)) result.push(path)
    }
    return result
  }

  async listTrackedPaths(projectId: string) {
    const current = await this.walkTracked(projectId)
    const historical = await prisma.projectHistoryRevision.findMany({ where: { projectId }, distinct: ['path'], select: { path: true } })
    return [...new Set([...current, ...historical.map(item => item.path)])].sort()
  }

  /** Resolve the sparse revision journal into the full project state at each sequence. */
  private async effectiveRevisionsAt(projectId: string, sequences: number[]) {
    const targets = [...new Set(sequences)].sort((a, b) => a - b)
    const snapshots = new Map<number, Array<{
      id: string
      checkpointId: string
      projectId: string
      path: string
      contentHash: string
      blobHash: string | null
      size: number
      deleted: boolean
      createdAt: Date
    }>>()
    if (!targets.length) return snapshots

    const rows = await prisma.projectHistoryRevision.findMany({
      where: { projectId, checkpoint: { sequence: { lte: targets[targets.length - 1] } } },
      select: {
        id: true,
        checkpointId: true,
        projectId: true,
        path: true,
        contentHash: true,
        blobHash: true,
        size: true,
        deleted: true,
        createdAt: true,
        checkpoint: { select: { sequence: true } },
      },
      orderBy: [{ checkpoint: { sequence: 'asc' } }, { id: 'asc' }],
    })
    const state = new Map<string, (typeof rows)[number]>()
    let rowIndex = 0
    for (const sequence of targets) {
      while (rowIndex < rows.length && rows[rowIndex].checkpoint.sequence <= sequence) {
        const row = rows[rowIndex++]
        state.set(row.path, row)
      }
      snapshots.set(sequence, [...state.values()].map(({ checkpoint: _checkpoint, ...revision }) => revision))
    }
    return snapshots
  }

  async listCheckpoints(projectId: string, take = 200) {
    const checkpoints = await prisma.projectHistoryCheckpoint.findMany({
      where: { projectId },
      orderBy: { sequence: 'desc' },
      take,
      include: { revisions: true },
    })
    const snapshots = await this.effectiveRevisionsAt(projectId, checkpoints.map(checkpoint => checkpoint.sequence))
    return checkpoints.map(checkpoint => ({
      ...checkpoint,
      // `revisions` remains the sparse journal for compatibility. The count
      // reflects the full state represented by this writing checkpoint.
      snapshotFileCount: snapshots.get(checkpoint.sequence)?.length ?? checkpoint.revisions.length,
    }))
  }

  async getCheckpointSnapshot(projectId: string, checkpointId: string) {
    const checkpoint = await this.getCheckpoint(projectId, checkpointId)
    const snapshots = await this.effectiveRevisionsAt(projectId, [checkpoint.sequence])
    return {
      ...checkpoint,
      snapshotFileCount: snapshots.get(checkpoint.sequence)?.length ?? checkpoint.revisions.length,
      snapshotRevisions: snapshots.get(checkpoint.sequence) || [],
    }
  }

  listFileHistory(projectId: string, path: string, take = 200) {
    return prisma.projectHistoryRevision.findMany({
      where: { projectId, path: normalizeProjectRelativePath(path) },
      orderBy: { checkpoint: { sequence: 'desc' } },
      take,
      include: { checkpoint: true },
    })
  }

  async getCheckpoint(projectId: string, checkpointId: string) {
    const checkpoint = await prisma.projectHistoryCheckpoint.findUnique({ where: { id: checkpointId }, include: { revisions: true } })
    if (!checkpoint || checkpoint.projectId !== projectId) throw new AppError('PROJECT_HISTORY_NOT_FOUND', 'History checkpoint not found', 404)
    return checkpoint
  }

  async getRevision(projectId: string, revisionId: string) {
    const revision = await prisma.projectHistoryRevision.findUnique({ where: { id: revisionId }, include: { checkpoint: true } })
    if (!revision || revision.projectId !== projectId) throw new AppError('PROJECT_HISTORY_NOT_FOUND', 'History revision not found', 404)
    return revision
  }

  async getRevisionContent(projectId: string, revisionId: string) {
    const revision = await this.getRevision(projectId, revisionId)
    if (revision.deleted || !revision.blobHash) return { revision, content: null }
    return { revision, content: (await this.readBlob(revision.blobHash)).toString('utf-8') }
  }

  private async writeState(projectId: string, path: string, revision: { deleted: boolean; blobHash: string | null }) {
    const resolved = await resolveProjectPath(projectId, path, { allowMissing: true })
    if (revision.deleted) {
      await rm(resolved.fullPath, { force: true })
      return
    }
    if (!revision.blobHash) throw new AppError('PROJECT_HISTORY_BLOB_MISSING', 'History revision has no content object', 500)
    await mkdir(dirname(resolved.fullPath), { recursive: true })
    const content = await this.readBlob(revision.blobHash)
    const temp = `${resolved.fullPath}.restore-${process.pid}-${Date.now()}.tmp`
    await writeFile(temp, content)
    await rename(temp, resolved.fullPath)
  }

  async restoreFileRevision(projectId: string, revisionId: string) {
    this.cancelScheduledRetention(projectId)
    await this.waitForRetentionIdle(projectId)
    const revision = await this.getRevision(projectId, revisionId)
    const { projectLiveFileManager } = await import('./project-live-file.service.js')
    await projectLiveFileManager.flushProject(projectId, revision.path)
    await this.flushPending(projectId)
    this.cancelScheduledRetention(projectId)
    await this.checkpoint(projectId, {
      kind: 'pre-restore',
      paths: [revision.path],
      metadata: { targetRevisionId: revisionId },
      forceBoundary: true,
      includeUntracked: true,
    })
    await this.writeState(projectId, revision.path, revision)
    await projectLiveFileManager.resetPaths(projectId, [revision.path], 'history-file-restore')
    const restored = await this.checkpoint(projectId, { kind: 'restore', paths: [revision.path], metadata: { targetRevisionId: revisionId }, forceBoundary: true, includeUntracked: true })
    this.scheduleRetention(projectId)
    return { path: revision.path, checkpoint: restored }
  }

  async restoreWritingCheckpoint(projectId: string, checkpointId: string) {
    this.cancelScheduledRetention(projectId)
    await this.waitForRetentionIdle(projectId)
    const target = await this.getCheckpoint(projectId, checkpointId)
    const { projectLiveFileManager } = await import('./project-live-file.service.js')
    await projectLiveFileManager.flushProject(projectId)
    await this.flushPending(projectId)
    this.cancelScheduledRetention(projectId)
    const paths = await this.listTrackedPaths(projectId)
    await this.checkpoint(projectId, { kind: 'pre-restore', paths, metadata: { targetCheckpointId: checkpointId }, forceBoundary: true, includeUntracked: true })

    const revisionsThroughTarget = await prisma.projectHistoryRevision.findMany({
      where: { projectId, checkpoint: { sequence: { lte: target.sequence } } },
      include: { checkpoint: true },
      orderBy: [{ checkpoint: { sequence: 'asc' } }, { id: 'asc' }],
    })
    const state = new Map<string, (typeof revisionsThroughTarget)[number]>()
    for (const revision of revisionsThroughTarget) state.set(revision.path, revision)
    for (const path of paths) {
      const revision = state.get(path)
      if (revision) await this.writeState(projectId, path, revision)
      else await this.writeState(projectId, path, { deleted: true, blobHash: null })
    }
    await projectLiveFileManager.resetPaths(projectId, paths, 'history-checkpoint-restore')
    const restored = await this.checkpoint(projectId, { kind: 'restore', paths, metadata: { targetCheckpointId: checkpointId }, forceBoundary: true, includeUntracked: true })
    this.scheduleRetention(projectId)
    return { checkpoint: restored, restoredPaths: paths }
  }

  async pinCheckpoint(projectId: string, checkpointId: string, pinned = true) {
    this.cancelScheduledRetention(projectId)
    await this.waitForRetentionIdle(projectId)
    await this.getCheckpoint(projectId, checkpointId)
    const checkpoint = await prisma.projectHistoryCheckpoint.update({ where: { id: checkpointId }, data: { pinned } })
    if (!pinned) this.scheduleRetention(projectId)
    return checkpoint
  }

  async updateCheckpointMetadata(projectId: string, checkpointId: string, metadata: Record<string, unknown>) {
    const checkpoint = await this.getCheckpoint(projectId, checkpointId)
    return prisma.projectHistoryCheckpoint.update({
      where: { id: checkpoint.id }, data: { metadata: { ...((checkpoint.metadata || {}) as any), ...metadata } },
    })
  }

  private async projectStorageBytes(projectId: string) {
    const revisions = await prisma.projectHistoryRevision.findMany({
      where: { projectId, blobHash: { not: null } },
      select: { blobHash: true },
    })
    const hashes = [...new Set(revisions.map(item => item.blobHash).filter((value): value is string => !!value))]
    let total = 0
    for (const hash of hashes) {
      try { total += (await stat(this.objectPath(hash))).size } catch {}
    }
    return total
  }

  private async removeCheckpointPreservingState(projectId: string, checkpointId: string) {
    // Revisions are sparse: deleting a row also cascades its revisions. Carry
    // any state still needed by later checkpoints into the immediate successor
    // before deleting it. Do both atomically, including tombstones. The latest
    // checkpoint is retained because it defines the current historical state.
    await prisma.$transaction(async tx => {
      const checkpoint = await tx.projectHistoryCheckpoint.findUnique({
        where: { id: checkpointId }, include: { revisions: true },
      })
      if (!checkpoint || checkpoint.projectId !== projectId || checkpoint.pinned) return
      const successor = await tx.projectHistoryCheckpoint.findFirst({
        where: { projectId, sequence: { gt: checkpoint.sequence } },
        orderBy: { sequence: 'asc' }, include: { revisions: true },
      })
      if (!successor) return
      const replacedPaths = new Set(successor.revisions.map(revision => revision.path))
      const inherited = checkpoint.revisions.filter(revision => !replacedPaths.has(revision.path))
      if (inherited.length) {
        await tx.projectHistoryRevision.createMany({
          data: inherited.map(({ path, contentHash, blobHash, size, deleted }) => ({
            checkpointId: successor.id, projectId, path, contentHash, blobHash, size, deleted,
          })),
        })
      }
      await tx.projectHistoryCheckpoint.delete({ where: { id: checkpointId } })
    }, { isolationLevel: 'Serializable' })
  }

  private async trimProjectStorage(projectId: string, maxStorageMb: number) {
    const limit = Math.max(1, Number(maxStorageMb || 512)) * 1024 * 1024
    if (await this.projectStorageBytes(projectId) <= limit) return

    const checkpoints = await prisma.projectHistoryCheckpoint.findMany({
      where: { projectId, pinned: false },
      select: { id: true, kind: true, sequence: true },
      orderBy: { sequence: 'asc' },
    })
    const tiers = [
      checkpoints.filter(item => item.kind === 'autosave' || item.kind === 'external'),
      checkpoints.filter(item => item.kind === 'build'),
      checkpoints.filter(item => !['baseline', 'autosave', 'external', 'build'].includes(item.kind)),
    ]

    for (const tier of tiers) {
      for (const checkpoint of tier) {
        if (await this.projectStorageBytes(projectId) <= limit) return
        await this.removeCheckpointPreservingState(projectId, checkpoint.id)
      }
    }
  }

  private async runRetentionGcUnsafe(projectId: string, options: { projectDeleted?: boolean } = {}) {
    if (!options.projectDeleted) {
      const settings = await this.settings(projectId)
      const cutoff = new Date(Date.now() - Math.max(1, Number(settings.retentionDays || 180)) * 86_400_000)
      const expired = await prisma.projectHistoryCheckpoint.findMany({
        where: { projectId, pinned: false, kind: { in: ['autosave', 'external'] }, createdAt: { lt: cutoff } },
        orderBy: { sequence: 'asc' }, select: { id: true },
      })
      for (const checkpoint of expired) await this.removeCheckpointPreservingState(projectId, checkpoint.id)
      await this.trimProjectStorage(projectId, Number(settings.maxStorageMb || 512))
    }
    await this.gcObjects()
  }

  async runRetentionGc(projectId: string, options: { projectDeleted?: boolean } = {}) {
    this.cancelScheduledRetention(projectId)
    const previous = this.retentionRuns.get(projectId) || Promise.resolve()
    const current = previous.catch(() => undefined).then(() => this.runRetentionGcUnsafe(projectId, options))
    this.retentionRuns.set(projectId, current)
    try {
      await current
    } finally {
      if (this.retentionRuns.get(projectId) === current) this.retentionRuns.delete(projectId)
    }
  }

  private async gcObjects() {
    const referenced = new Set((await prisma.projectHistoryRevision.findMany({ where: { blobHash: { not: null } }, select: { blobHash: true } })).map(item => item.blobHash!).filter(Boolean))
    const objects = join(config.projectHistoryDir, 'objects')
    let prefixes: string[] = []
    try { prefixes = await readdir(objects) } catch { return }
    for (const prefix of prefixes) {
      const dir = join(objects, prefix)
      let names: string[] = []
      try { names = await readdir(dir) } catch { continue }
      for (const name of names) {
        if (!name.endsWith('.br')) continue
        const hash = name.slice(0, -3)
        if (!referenced.has(hash)) {
          const objectFile = join(dir, name)
          try {
            const info = await stat(objectFile)
            if (Date.now() - info.mtimeMs < GC_OBJECT_GRACE_MS) continue
          } catch { continue }
          await rm(objectFile, { force: true })
        }
      }
    }
  }
}

export const projectHistoryService = new ProjectHistoryService()
