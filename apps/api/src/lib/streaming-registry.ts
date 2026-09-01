/**
 * In-memory registry for active streaming messages.
 * Replaces PostgreSQL query for stream resumption.
 */

interface ActiveStream {
  messageId: string
  branchId: string
  sessionFile: string
  startedAt: number
  updatedAt: number
  completion: Promise<void>
  resolveCompletion: () => void
}

export class StreamingRegistry {
  private activeStreams = new Map<string, ActiveStream>()
  private timeoutMs: number

  constructor(options: { timeoutMs?: number } = {}) {
    this.timeoutMs = options.timeoutMs ?? 5 * 60 * 1000
  }

  /** Register a new active stream. A conversation has at most one producer. */
  register(conversationId: string, messageId: string, branchId: string, sessionFile: string): void {
    if (this.activeStreams.has(conversationId)) {
      throw new Error('Conversation already has an active stream')
    }

    let resolveCompletion!: () => void
    const completion = new Promise<void>((resolve) => { resolveCompletion = resolve })
    const now = Date.now()
    this.activeStreams.set(conversationId, {
      messageId,
      branchId,
      sessionFile,
      startedAt: now,
      updatedAt: now,
      completion,
      resolveCompletion,
    })
  }

  /** Update branch/session metadata after an edit branch has been prepared. */
  update(
    conversationId: string,
    messageId: string,
    values: { branchId?: string; sessionFile?: string }
  ): void {
    const active = this.activeStreams.get(conversationId)
    if (!active || active.messageId !== messageId) return
    if (values.branchId !== undefined) active.branchId = values.branchId
    if (values.sessionFile !== undefined) active.sessionFile = values.sessionFile
    active.updatedAt = Date.now()
  }

  /** Atomically hand producer ownership to a continuation run in the same conversation. */
  handoff(
    conversationId: string,
    fromMessageId: string,
    toMessageId: string,
    values: { branchId: string; sessionFile: string },
  ): boolean {
    const active = this.activeStreams.get(conversationId)
    if (!active || active.messageId !== fromMessageId) return false
    active.resolveCompletion()

    let resolveCompletion!: () => void
    const completion = new Promise<void>((resolve) => { resolveCompletion = resolve })
    const now = Date.now()
    this.activeStreams.set(conversationId, {
      messageId: toMessageId,
      branchId: values.branchId,
      sessionFile: values.sessionFile,
      startedAt: now,
      updatedAt: now,
      completion,
      resolveCompletion,
    })
    return true
  }

  /** Move an active producer when an extension switches to another YARC conversation. */
  transfer(
    fromConversationId: string,
    toConversationId: string,
    messageId: string,
    values: { branchId: string; sessionFile: string },
  ): boolean {
    const active = this.activeStreams.get(fromConversationId)
    if (!active || active.messageId !== messageId) return false
    const target = this.activeStreams.get(toConversationId)
    if (target && target.messageId !== messageId) return false
    this.activeStreams.delete(fromConversationId)
    active.branchId = values.branchId
    active.sessionFile = values.sessionFile
    active.updatedAt = Date.now()
    this.activeStreams.set(toConversationId, active)
    return true
  }

  /** Refresh producer liveness without changing user-visible state. */
  touch(conversationId: string, messageId: string): void {
    const active = this.activeStreams.get(conversationId)
      || [...this.activeStreams.values()].find(stream => stream.messageId === messageId)
    if (active?.messageId === messageId) active.updatedAt = Date.now()
  }

  /** Unregister a completed/failed stream. */
  unregister(conversationId: string, messageId?: string): void {
    let ownerConversationId = conversationId
    let active = this.activeStreams.get(conversationId)
    if ((!active || (messageId && active.messageId !== messageId)) && messageId) {
      const transferred = [...this.activeStreams.entries()].find(([, stream]) => stream.messageId === messageId)
      if (transferred) [ownerConversationId, active] = transferred
    }
    if (!active || (messageId && active.messageId !== messageId)) return
    this.activeStreams.delete(ownerConversationId)
    active.resolveCompletion()
  }

  /** Wait until a producer has completed its session and stream cleanup. */
  async waitForMessage(messageId: string, timeoutMs = 30_000): Promise<void> {
    const active = [...this.activeStreams.values()].find((stream) => stream.messageId === messageId)
    if (!active) return
    if (timeoutMs <= 0) {
      await active.completion
      return
    }
    await Promise.race([
      active.completion,
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ])
  }

  /** Get active stream for a conversation. */
  get(conversationId: string): ActiveStream | undefined {
    return this.activeStreams.get(conversationId)
  }

  /** Check if a conversation has an active stream. */
  has(conversationId: string): boolean {
    return this.activeStreams.has(conversationId)
  }

  /** Clean up producers that have stopped updating their heartbeat. */
  cleanup(): void {
    const now = Date.now()
    for (const [convId, stream] of this.activeStreams) {
      if (now - stream.updatedAt > this.timeoutMs) {
        this.unregister(convId, stream.messageId)
      }
    }
  }
}

export const streamingRegistry = new StreamingRegistry()

// Periodic cleanup. Do not keep isolated test/CLI processes alive.
const cleanupTimer = setInterval(() => streamingRegistry.cleanup(), 60_000)
if (typeof cleanupTimer.unref === 'function') cleanupTimer.unref()
