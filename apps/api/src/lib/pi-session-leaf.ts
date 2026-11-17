import type { SessionManager, SessionEntry } from '@earendil-works/pi-coding-agent'

/**
 * SessionManager reconstructs a file's leaf from its last physical JSONL entry.
 * YARC also persists the active leaf because tree navigation can leave a valid
 * active branch behind later off-path entries in the same append-only file.
 */
export const restoreSessionLeaf = (
  sessionManager: SessionManager,
  leafEntryId: string | null | undefined,
): boolean => {
  // A null/missing leaf is common for legacy or not-yet-flushed sessions.
  // Keep SessionManager's physical-leaf fallback instead of hiding history.
  if (!leafEntryId || !sessionManager.getEntry(leafEntryId)) return false
  sessionManager.branch(leafEntryId)
  return true
}

/** Return the active branch using the persisted leaf, with legacy fallback. */
export const getSessionBranch = (
  sessionManager: SessionManager,
  leafEntryId: string | null | undefined,
): SessionEntry[] => {
  if (leafEntryId && sessionManager.getEntry(leafEntryId)) return sessionManager.getBranch(leafEntryId)
  return sessionManager.getBranch()
}
