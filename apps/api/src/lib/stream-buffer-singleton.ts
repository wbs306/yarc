/**
 * Singleton StreamBuffer instance shared between WebSocket handler and REST routes.
 * 
 * With Pi as single source, StreamBuffer only manages in-memory streaming state.
 * No longer flushes to PostgreSQL - Pi handles persistence in JSONL.
 */
import { StreamBuffer } from './stream-buffer.js'

export const streamBuffer = new StreamBuffer({
  // No-op flush function - Pi handles persistence
  flushFn: async (_conversationId, _messageId, _events, _finalData) => {
    // Stream persistence is handled by Pi SessionManager
  },
})

// Periodic cleanup of timed-out streams
setInterval(() => { streamBuffer.cleanup().catch(() => {}) }, 60_000)
