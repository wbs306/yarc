import { mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { config } from '../config.js'

export interface RunJournalCommitState {
  userEntryId?: string
  assistantEntryIds: string[]
  leafEntryId?: string | null
}

export interface RunJournalSnapshot {
  conversationId: string
  runId: string
  branchId?: string
  source?: 'user' | 'extension' | 'command' | 'continuation'
  initialLeafId?: string | null
  sessionFile?: string
  status: 'streaming' | 'completed' | 'failed'
  events: unknown[]
  commitState: RunJournalCommitState
  finalData: Record<string, unknown>
  updatedAt: string
}

export const deriveRunJournalCommitState = (events: unknown[]): RunJournalCommitState => {
  let userEntryId: string | undefined
  const assistantEntryIds: string[] = []
  let leafEntryId: string | null | undefined
  for (const event of events) {
    const value = event as any
    if (value?.type === 'pi_user_entry' && typeof value.entryId === 'string') {
      userEntryId = value.entryId
      leafEntryId = value.entryId
    } else if (value?.type === 'pi_assistant_entry' && typeof value.entryId === 'string') {
      assistantEntryIds.push(value.entryId)
      leafEntryId = value.entryId
    }
  }
  return { userEntryId, assistantEntryIds, leafEntryId }
}

const safeSegment = (value: string) => value.replace(/[^a-zA-Z0-9._-]/g, '_')

export class RunJournalStore {
  private readonly root: string

  constructor(root = join(config.dataDir, '.pi', 'agent', 'runtime-streams')) {
    this.root = root
  }

  private pathFor(conversationId: string, runId: string): string {
    return join(this.root, safeSegment(conversationId), `${safeSegment(runId)}.jsonl`)
  }

  async write(snapshot: RunJournalSnapshot): Promise<void> {
    const path = this.pathFor(snapshot.conversationId, snapshot.runId)
    await mkdir(join(this.root, safeSegment(snapshot.conversationId)), { recursive: true })
    const temp = `${path}.${process.pid}.tmp`
    await writeFile(temp, `${JSON.stringify(snapshot)}\n`, 'utf8')
    await rename(temp, path)
  }

  async remove(conversationId: string, runId: string): Promise<void> {
    await rm(this.pathFor(conversationId, runId), { force: true })
  }

  async move(fromConversationId: string, toConversationId: string, runId: string): Promise<void> {
    if (fromConversationId === toConversationId) return
    const from = this.pathFor(fromConversationId, runId)
    const to = this.pathFor(toConversationId, runId)
    await mkdir(join(this.root, safeSegment(toConversationId)), { recursive: true })
    await rename(from, to).catch(() => {})
  }

  async cleanupStale(retentionMs: number, now = Date.now()): Promise<number> {
    const normalizedRetention = Number.isFinite(retentionMs) ? retentionMs : 24 * 60 * 60 * 1000
    const cutoff = now - Math.max(60_000, normalizedRetention)
    let removed = 0
    const conversations = await readdir(this.root, { withFileTypes: true }).catch(() => [])
    for (const conversation of conversations) {
      if (!conversation.isDirectory()) continue
      const dir = join(this.root, conversation.name)
      const files = await readdir(dir, { withFileTypes: true }).catch(() => [])
      for (const file of files) {
        if (!file.isFile() || (!file.name.endsWith('.jsonl') && !file.name.endsWith('.tmp'))) continue
        const path = join(dir, file.name)
        const info = await stat(path).catch(() => null)
        if (!info || info.mtimeMs >= cutoff) continue
        await rm(path, { force: true })
        removed += 1
      }
      await rmdir(dir).catch(() => {})
    }
    return removed
  }

  async listPending(): Promise<RunJournalSnapshot[]> {
    const snapshots: RunJournalSnapshot[] = []
    const conversations = await readdir(this.root, { withFileTypes: true }).catch(() => [])
    for (const conversation of conversations) {
      if (!conversation.isDirectory()) continue
      const dir = join(this.root, conversation.name)
      const files = await readdir(dir, { withFileTypes: true }).catch(() => [])
      for (const file of files) {
        if (!file.isFile() || !file.name.endsWith('.jsonl')) continue
        try {
          const line = (await readFile(join(dir, file.name), 'utf8')).trim()
          const parsed = JSON.parse(line) as Partial<RunJournalSnapshot>
          const events = Array.isArray(parsed.events) ? parsed.events : []
          const snapshot: RunJournalSnapshot = {
            conversationId: String(parsed.conversationId || conversation.name),
            runId: String(parsed.runId || file.name.replace(/\.jsonl$/, '')),
            branchId: typeof parsed.branchId === 'string' ? parsed.branchId : undefined,
            source: parsed.source,
            initialLeafId: parsed.initialLeafId,
            sessionFile: typeof parsed.sessionFile === 'string' ? parsed.sessionFile : undefined,
            status: parsed.status || 'streaming',
            events,
            commitState: parsed.commitState || deriveRunJournalCommitState(events),
            finalData: parsed.finalData && typeof parsed.finalData === 'object' ? parsed.finalData : {},
            updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date(0).toISOString(),
          }
          if (snapshot.status === 'streaming') snapshots.push(snapshot)
        } catch {
          // A corrupt journal is ignored; canonical Pi JSONL remains authoritative.
        }
      }
    }
    return snapshots
  }
}

export const runJournalStore = new RunJournalStore()
