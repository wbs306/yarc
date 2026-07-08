interface CancelEntry {
  messageId: string
  expiresAt: number
}

const cancelledStreams = new Map<string, CancelEntry>()
const abortHandlers = new Map<string, Set<() => void>>()

// Auto-cleanup interval: remove expired entries every 5 minutes.
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000
const ENTRY_TTL_MS = 10 * 60 * 1000 // 10 minutes

let cleanupTimer: ReturnType<typeof setInterval> | null = null

function startCleanup() {
  if (cleanupTimer) return
  cleanupTimer = setInterval(() => {
    const now = Date.now()
    for (const [key, entry] of cancelledStreams) {
      if (now > entry.expiresAt) {
        cancelledStreams.delete(key)
      }
    }
  }, CLEANUP_INTERVAL_MS)
  // Make the timer non-blocking so it doesn't prevent process exit.
  if (cleanupTimer && typeof cleanupTimer.unref === 'function') {
    cleanupTimer.unref()
  }
}

startCleanup()

export const chatStreamControl = {
  cancel(messageId: string) {
    cancelledStreams.set(messageId, {
      messageId,
      expiresAt: Date.now() + ENTRY_TTL_MS,
    })
    for (const handler of abortHandlers.get(messageId) || []) {
      try { handler() } catch { /* ignore */ }
    }
  },

  isCancelled(messageId: string) {
    const entry = cancelledStreams.get(messageId)
    if (!entry) return false
    // Also clean up this entry if expired.
    if (Date.now() > entry.expiresAt) {
      cancelledStreams.delete(messageId)
      return false
    }
    return true
  },

  clear(messageId: string) {
    cancelledStreams.delete(messageId)
    abortHandlers.delete(messageId)
  },

  registerAbortHandler(messageId: string, handler: () => void) {
    const handlers = abortHandlers.get(messageId) || new Set<() => void>()
    handlers.add(handler)
    abortHandlers.set(messageId, handlers)
    return () => {
      handlers.delete(handler)
      if (!handlers.size) abortHandlers.delete(messageId)
    }
  },

  /** Manually trigger cleanup (useful for testing). */
  _cleanup() {
    const now = Date.now()
    for (const [key, entry] of cancelledStreams) {
      if (now > entry.expiresAt) {
        cancelledStreams.delete(key)
      }
    }
  },
}
