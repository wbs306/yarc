import { access } from 'node:fs/promises'
import { prisma } from '@yarc/db'
import { config } from './config.js'
import { AppError } from './errors.js'
import { resolveProjectRoot } from './project-path.js'

export type ConversationWorkspace = {
  kind: 'global' | 'project'
  cwd: string
  projectId?: string
}

export const resolveConversationWorkspace = async (conversationId?: string | null): Promise<ConversationWorkspace> => {
  if (!conversationId) return { kind: 'global', cwd: config.dataDir }
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { projectId: true },
  })
  if (!conversation) throw new AppError('CONVERSATION_NOT_FOUND', 'Conversation not found', 404)
  if (!conversation.projectId) {
    await access(config.dataDir).catch(() => { throw new AppError('WORKSPACE_MISSING', 'Data workspace is missing', 409) })
    return { kind: 'global', cwd: config.dataDir }
  }
  const { root } = await resolveProjectRoot(conversation.projectId)
  return { kind: 'project', cwd: root, projectId: conversation.projectId }
}
