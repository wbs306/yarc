import { randomUUID } from 'node:crypto'

export type BtwRunStatus = 'running' | 'completed' | 'failed' | 'cancelled'

export interface BtwRun {
  id: string
  conversationId: string
  branchId: string | null
  question: string
  answer: string
  thinking: string
  status: BtwRunStatus
  error?: string
  createdAt: string
  updatedAt: string
  abortController: AbortController
}

/**
 * In-memory registry for /btw side question runs.
 * Short-lived; server restart marks all running as failed.
 */
class BtwRunRegistry {
  private runs = new Map<string, BtwRun>()

  create(conversationId: string, branchId: string | null, question: string): BtwRun {
    const run: BtwRun = {
      id: randomUUID(),
      conversationId,
      branchId,
      question,
      answer: '',
      thinking: '',
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      abortController: new AbortController(),
    }
    this.runs.set(run.id, run)
    return run
  }

  get(runId: string): BtwRun | undefined {
    return this.runs.get(runId)
  }

  getByConversation(conversationId: string): BtwRun[] {
    return [...this.runs.values()]
      .filter(r => r.conversationId === conversationId)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
  }

  cancel(runId: string): boolean {
    const run = this.runs.get(runId)
    if (!run || run.status !== 'running') return false
    run.abortController.abort()
    run.status = 'cancelled'
    run.updatedAt = new Date().toISOString()
    return true
  }

  complete(runId: string, answer: string, thinking?: string): void {
    const run = this.runs.get(runId)
    if (!run) return
    run.answer = answer
    if (thinking) run.thinking = thinking
    run.status = 'completed'
    run.updatedAt = new Date().toISOString()
  }

  fail(runId: string, error: string): void {
    const run = this.runs.get(runId)
    if (!run) return
    run.error = error
    run.status = 'failed'
    run.updatedAt = new Date().toISOString()
  }

  delete(runId: string): boolean {
    return this.runs.delete(runId)
  }

}

export const btwRunRegistry = new BtwRunRegistry()
