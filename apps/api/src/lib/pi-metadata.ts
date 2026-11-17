import { prisma } from '@yarc/db'

/**
 * Pi session metadata stored in Conversation.metadata.pi.sessions[branchId]
 */
export interface PiSessionMetadata {
  sessionFile?: string
  sessionId?: string
  leafEntryId?: string | null
  model?: string | null
  thinkingLevel?: string | null
  updatedAt?: string
}

/**
 * Get Pi session metadata for a specific branch.
 * Returns null if conversation or session not found.
 */
export async function getPiSessionMetadata(
  conversationId: string,
  branchId: string
): Promise<PiSessionMetadata | null> {
  try {
    const conv = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { metadata: true },
    })
    const meta = (conv?.metadata || {}) as any
    return meta?.pi?.sessions?.[branchId] || null
  } catch {
    return null
  }
}

/**
 * Save Pi session metadata for a specific branch.
 */
export async function savePiSessionMetadata(
  conversationId: string,
  branchId: string,
  metadata: PiSessionMetadata
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ metadata: unknown }>>`
      SELECT metadata FROM conversations WHERE id = ${conversationId}::uuid FOR UPDATE
    `
    if (!rows[0]) return
    const existingMeta = (rows[0].metadata || {}) as any
    const sessions = existingMeta?.pi?.sessions || {}
    sessions[branchId] = { ...sessions[branchId], ...metadata }

    await tx.conversation.update({
      where: { id: conversationId },
      data: {
        metadata: {
          ...existingMeta,
          pi: {
            ...(existingMeta?.pi || {}),
            sessions,
          },
        },
      },
    })
  })
}

/**
 * Get all Pi session metadata for a conversation.
 * Returns a map of branchId -> session metadata.
 */
export async function getAllPiSessionMetadata(
  conversationId: string
): Promise<Record<string, PiSessionMetadata>> {
  try {
    const conv = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { metadata: true },
    })
    const meta = (conv?.metadata || {}) as any
    return meta?.pi?.sessions || {}
  } catch {
    return {}
  }
}
