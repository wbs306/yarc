/**
 * Singleton StreamBuffer instance shared between WebSocket handler and REST routes.
 * 
 * With Pi as single source, StreamBuffer only manages in-memory streaming state.
 * No longer flushes to PostgreSQL - Pi handles persistence in JSONL.
 */
import { config } from './config.js'
import { StreamBuffer } from './stream-buffer.js'
import { deriveRunJournalCommitState, runJournalStore } from './pi-runtime/run-journal.js'

export const streamBuffer = new StreamBuffer({
  // Pi JSONL remains authoritative for finalized messages. This journal only
  // preserves in-flight prompts/deltas across an API or Runtime Worker crash.
  flushFn: async (conversationId, messageId, events, finalData) => {
    if (finalData.status === 'streaming') {
      const entry = streamBuffer.get(messageId)
      await runJournalStore.write({
        conversationId,
        runId: messageId,
        branchId: entry?.branchId,
        source: entry?.source,
        initialLeafId: entry?.initialLeafId,
        sessionFile: entry?.sessionFile,
        status: 'streaming',
        events,
        commitState: deriveRunJournalCommitState(events),
        finalData: {
          ...finalData,
          userMessage: entry?.userMessage,
        },
        updatedAt: new Date().toISOString(),
      })
      return
    }

    // complete()/fail() are called only after the Pi producer has drained its
    // persistence cleanup, so the temporary journal is no longer authoritative.
    const originalConversationId = streamBuffer.get(messageId)?.originalConversationId
    await runJournalStore.remove(conversationId, messageId)
    if (originalConversationId && originalConversationId !== conversationId) {
      await runJournalStore.remove(originalConversationId, messageId)
    }
  },
})

// Periodic cleanup must not keep short-lived test/CLI processes alive.
const cleanupTimer = setInterval(() => { streamBuffer.cleanup().catch(() => {}) }, 60_000)
if (typeof cleanupTimer.unref === 'function') cleanupTimer.unref()

// Runtime journals are crash-recovery artifacts, not permanent conversation
// data. Active runs refresh their file continuously; abandoned/corrupt/temp
// files age out without entering WebDAV synchronization.
const journalCleanupTimer = setInterval(() => {
  runJournalStore.cleanupStale(config.piRuntimeJournalRetentionMs).catch(() => {})
}, 60 * 60 * 1000)
if (typeof journalCleanupTimer.unref === 'function') journalCleanupTimer.unref()
