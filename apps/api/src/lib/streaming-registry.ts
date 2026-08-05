/**
 * In-memory registry for active streaming messages.
 * Replaces PostgreSQL query for stream resumption.
 */

interface ActiveStream {
  messageId: string
  branchId: string
  sessionFile: string
  startedAt: number
  completion: Promise<void>
  resolveCompletion: () => void
}

class StreamingRegistry {
  private activeStreams = new Map<string, ActiveStream>()

  /** Register a new active stream */
  register(conversationId: string, messageId: string, branchId: string, sessionFile: string): void {
    // A stale producer must not be able to resolve/remove a newer stream for
    // the same conversation. Its message ID is checked in unregister().
    this.activeStreams.get(conversationId)?.resolveCompletion()

    let resolveCompletion!: () => void
    const completion = new Promise<void>((resolve) => { resolveCompletion = resolve })
    this.activeStreams.set(conversationId, {
      messageId,
      branchId,
      sessionFile,
      startedAt: Date.now(),
      completion,
      resolveCompletion,
    })
  }

  /** Unregister a completed/failed stream */
  unregister(conversationId: string, messageId?: string): void {
    const active = this.activeStreams.get(conversationId)
    if (!active || (messageId && active.messageId !== messageId)) return
    this.activeStreams.delete(conversationId)
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

  /** Get active stream for a conversation */
  get(conversationId: string): ActiveStream | undefined {
    return this.activeStreams.get(conversationId)
  }

  /** Check if a conversation has an active stream */
  has(conversationId: string): boolean {
    return this.activeStreams.has(conversationId)
  }

  /** Clean up timed-out streams (5 minutes) */
  cleanup(): void {
    const now = Date.now()
    const timeoutMs = 5 * 60 * 1000
    for (const [convId, stream] of this.activeStreams) {
      if (now - stream.startedAt > timeoutMs) {
        this.unregister(convId, stream.messageId)
      }
    }
  }
}

export const streamingRegistry = new StreamingRegistry()

// Periodic cleanup
setInterval(() => streamingRegistry.cleanup(), 60_000)
