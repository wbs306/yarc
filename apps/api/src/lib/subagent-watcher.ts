import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { sseHub } from './sse.js'

export interface TrackedRun {
  runId: string
  conversationId: string
  branchId?: string
  messageId: string
  status: 'running' | 'completed' | 'failed'
  startedAt: string
  completedAt?: string
  result?: any
  currentState?: string
  currentTool?: string
}

export type SubagentCompleteCallback = (data: {
  runId: string
  conversationId: string
  branchId?: string
  agentName: string
  success: boolean
  resultFile: string
  summary?: string
}) => void | Promise<void>

class SubagentWatcher {
  private tracked = new Map<string, TrackedRun>()
  private uid: number
  private baseDir: string
  private resultsDir: string
  private asyncDir: string
  private watcher: fs.FSWatcher | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private started = false
  private onComplete: SubagentCompleteCallback | null = null

  constructor() {
    this.uid = typeof process.getuid === 'function' ? process.getuid() : 0
    this.baseDir = path.join(os.tmpdir(), `pi-subagents-uid-${this.uid}`)
    this.resultsDir = path.join(this.baseDir, 'async-subagent-results')
    this.asyncDir = path.join(this.baseDir, 'async-subagent-runs')
  }

  start(): void {
    if (this.started) return
    this.started = true
    try {
      fs.mkdirSync(this.resultsDir, { recursive: true })
      this.watcher = fs.watch(this.resultsDir, { persistent: false }, (_et, fn) => {
        if (fn) this.handleResultFile(fn)
      })
      this.watcher.on('error', (err) => console.warn('[SubagentWatcher] fs.watch error:', err.message))
    } catch (err) {
      console.warn('[SubagentWatcher] Failed to watch results dir:', (err as Error).message)
    }
    this.pollTimer = setInterval(() => this.pollActiveRuns(), 3000)
    if (this.pollTimer && typeof this.pollTimer.unref === 'function') this.pollTimer.unref()
    console.log(`[SubagentWatcher] Watching ${this.resultsDir}`)
  }

  stop(): void {
    if (this.watcher) { this.watcher.close(); this.watcher = null }
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null }
    this.started = false
  }

  setOnComplete(cb: SubagentCompleteCallback): void { this.onComplete = cb }

  trackRun(runId: string, conversationId: string, messageId: string, branchId?: string): TrackedRun {
    const existing = this.tracked.get(runId)
    if (existing) {
      existing.conversationId = conversationId
      existing.messageId = messageId
      if (branchId) existing.branchId = branchId
      return existing
    }

    const run: TrackedRun = { runId, conversationId, branchId, messageId, status: 'running', startedAt: new Date().toISOString() }
    const resultPath = path.join(this.resultsDir, `${runId}.json`)
    const statusPath = path.join(this.asyncDir, runId, 'status.json')

    try {
      if (fs.existsSync(resultPath)) {
        const data = JSON.parse(fs.readFileSync(resultPath, 'utf-8'))
        run.status = data.success === false ? 'failed' : 'completed'
        run.result = data
        run.completedAt = new Date().toISOString()
        if (this.onComplete && run.status === 'completed' && conversationId) {
          const agentName = data.agent || data.results?.[0]?.agent || 'subagent'
          void this.onComplete({ runId, conversationId, branchId, agentName, success: true, resultFile: resultPath, summary: data.summary })
        }
      } else if (fs.existsSync(statusPath)) {
        const data = JSON.parse(fs.readFileSync(statusPath, 'utf-8'))
        run.currentState = data.state
        run.currentTool = data.currentTool
      } else {
        run.status = 'completed'
        run.completedAt = new Date().toISOString()
      }
    } catch {
      run.status = 'completed'
      run.completedAt = new Date().toISOString()
    }

    this.tracked.set(runId, run)
    if (run.status === 'running') {
      sseHub.emit({ type: 'subagent_started', runId, conversationId, messageId, at: run.startedAt })
    }
    return run
  }

  untrackRun(runId: string): void { this.tracked.delete(runId) }
  getTrackedRuns(): TrackedRun[] { return [...this.tracked.values()] }
  getTrackedRunsByConversation(cid: string): TrackedRun[] { return [...this.tracked.values()].filter(r => r.conversationId === cid) }

  private emitComplete(tracked: TrackedRun, data: any, success: boolean, filePath: string): void {
    tracked.status = success ? 'completed' : 'failed'
    tracked.result = data
    tracked.completedAt = new Date().toISOString()

    // Persist result to data directory so it survives tmp cleanup
    const persistedPath = success ? this.persistResult(tracked.runId, data) : null

    sseHub.emit({
      type: success ? 'subagent_complete' : 'subagent_failed',
      runId: tracked.runId, conversationId: tracked.conversationId, messageId: tracked.messageId,
      success,
      agent: data?.agent || data?.results?.[0]?.agent || data?.steps?.[0]?.agent || 'subagent',
      resultFile: persistedPath || filePath,
      summary: data?.summary || (success ? '完成' : data?.error || '失败'),
      error: success ? undefined : (data?.error || '子任务执行失败'),
      durationMs: data?.durationMs, at: tracked.completedAt,
    })

    if (this.onComplete && tracked.conversationId && success) {
      const agentName = data?.agent || data?.results?.[0]?.agent || data?.steps?.[0]?.agent || 'subagent'
      console.log(`[SubagentWatcher] Calling onComplete for ${tracked.runId} (success=${success})`)
      void this.onComplete({
        runId: tracked.runId, conversationId: tracked.conversationId, branchId: tracked.branchId,
        agentName, success, resultFile: persistedPath || filePath, summary: data?.summary,
      })
    }
    if (this.onComplete && tracked.conversationId && !success) {
      const agentName = data?.agent || data?.steps?.[0]?.agent || 'subagent'
      void this.onComplete({
        runId: tracked.runId, conversationId: tracked.conversationId, branchId: tracked.branchId,
        agentName, success: false, resultFile: '',
      })
    }
  }

  /** Copy result to persistent data directory so it survives tmp cleanup. */
  private persistResult(runId: string, data: any): string | null {
    try {
      const destDir = path.join(process.cwd(), '.pi', 'agent', 'subagent-results')
      fs.mkdirSync(destDir, { recursive: true })
      const destPath = path.join(destDir, `${runId}.json`)
      fs.writeFileSync(destPath, JSON.stringify(data, null, 2))
      return destPath
    } catch (err) {
      console.warn('[SubagentWatcher] Failed to persist result:', (err as Error).message)
      return null
    }
  }

  private handleResultFile(filename: string): void {
    if (!filename.endsWith('.json')) return
    const runId = filename.replace(/\.json$/, '')
    const tracked = this.tracked.get(runId)
    if (!tracked) return
    const filePath = path.join(this.resultsDir, filename)
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
      this.emitComplete(tracked, data, data.success !== false, filePath)
    } catch (err) {
      console.warn(`[SubagentWatcher] Failed to read result for ${runId}:`, (err as Error).message)
    }
  }

  private pollActiveRuns(): void {
    // 1. Scan for ANY new result files (not just tracked runs)
    try {
      const files = fs.readdirSync(this.resultsDir)
      for (const file of files) {
        if (!file.endsWith('.json')) continue
        const runId = file.replace(/\.json$/, '')
        const tracked = this.tracked.get(runId)
        // Skip if already processed
        if (tracked && tracked.status !== 'running') continue
        // Process new result files
        this.handleResultFile(file)
      }
    } catch { /* dir might not exist yet */ }

    // 2. Poll tracked runs for intermediate status
    for (const run of this.tracked.values()) {
      if (run.status !== 'running') continue
      const asyncRunDir = path.join(this.asyncDir, run.runId)
      const statusPath = path.join(asyncRunDir, 'status.json')
      const resultPath = path.join(this.resultsDir, `${run.runId}.json`)

      try {
        if (fs.existsSync(resultPath)) {
          this.handleResultFile(`${run.runId}.json`)
          continue
        }
        if (!fs.existsSync(asyncRunDir)) {
          if (Date.now() - new Date(run.startedAt).getTime() > 15_000) {
            this.emitComplete(run, null, false, '')
          }
          continue
        }
        if (!fs.existsSync(statusPath)) continue
        const data = JSON.parse(fs.readFileSync(statusPath, 'utf-8'))

        if (data.state === 'failed') {
          this.emitComplete(run, data, false, '')
          continue
        }
        if (data.state === 'complete') {
          if (fs.existsSync(resultPath)) {
            this.handleResultFile(`${run.runId}.json`)
          } else {
            run.currentState = 'complete'
          }
          continue
        }

        const changed = data.state !== run.currentState || data.currentTool !== run.currentTool
        run.currentState = data.state
        run.currentTool = data.currentTool
        if (changed) {
          sseHub.emit({
            type: 'subagent_status', runId: run.runId, conversationId: run.conversationId, messageId: run.messageId,
            state: data.state, currentTool: data.currentTool, turnCount: data.turnCount, toolCount: data.toolCount,
            at: new Date().toISOString(),
          })
        }
      } catch { /* ignore transient read errors */ }
    }
  }
}

export const subagentWatcher = new SubagentWatcher()
