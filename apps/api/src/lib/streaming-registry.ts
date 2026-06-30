/**
 * In-memory registry for active streaming messages.
 * Replaces PostgreSQL query for stream resumption.
 */

interface ActiveStream {
  messageId: string
  branchId: string
  sessionFile: string
  startedAt: number
}

class StreamingRegistry {
  private activeStreams = new Map<string, ActiveStream>()

  /** Register a new active stream */
  register(conversationId: string, messageId: string, branchId: string, sessionFile: string): void {
    this.activeStreams.set(conversationId, {
      messageId,
      branchId,
      sessionFile,
      startedAt: Date.now(),
    })
  }

  /** Unregister a completed/failed stream */
  unregister(conversationId: string): void {
    this.activeStreams.delete(conversationId)
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
        this.activeStreams.delete(convId)
      }
    }
  }
}

export const streamingRegistry = new StreamingRegistry()

// Periodic cleanup
setInterval(() => streamingRegistry.cleanup(), 60_000)
