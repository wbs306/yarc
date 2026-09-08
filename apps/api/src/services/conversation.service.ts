import { prisma } from '@yarc/db'
import { AppError } from '../lib/errors.js'

const DEFAULT_CONVERSATION_TITLE = '新对话'

export const conversationTitleFromMessage = (content: string) =>
  content.slice(0, 30).replace(/\n/g, ' ').trim()

export class ConversationService {
  async list(options: { projectId?: string | null } = {}) {
    return prisma.conversation.findMany({
      where: options.projectId !== undefined ? { projectId: options.projectId } : undefined,
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        paperId: true,
        projectId: true,
        title: true,
        model: true,
        createdAt: true,
        updatedAt: true,
      },
    })
  }

  async getById(id: string) {
    const conv = await prisma.conversation.findUnique({ where: { id } })
    if (!conv) throw new AppError('NOT_FOUND', 'Conversation not found', 404)
    return conv
  }

  async create(data: { id?: string; paperId?: string; projectId?: string; title?: string; model?: string; systemPrompt?: string }) {
    if (data.projectId) {
      const project = await prisma.project.findUnique({ where: { id: data.projectId }, select: { id: true, archivedAt: true } })
      if (!project) throw new AppError('PROJECT_NOT_FOUND', 'Project not found', 404)
      if (project.archivedAt) throw new AppError('PROJECT_ARCHIVED', 'Archived projects cannot create new conversations', 409)
    }
    return prisma.conversation.create({
      data: {
        ...(data.id ? { id: data.id } : {}),
        paperId: data.paperId,
        projectId: data.projectId,
        title: data.title || DEFAULT_CONVERSATION_TITLE,
        model: data.model,
        systemPrompt: data.systemPrompt,
      },
    })
  }

  async delete(id: string) {
    const conv = await prisma.conversation.findUnique({ where: { id } })
    if (!conv) throw new AppError('NOT_FOUND', 'Conversation not found', 404)
    await prisma.conversation.delete({ where: { id } })
  }

  async updateTitle(id: string, title: string) {
    return prisma.conversation.update({ where: { id }, data: { title, updatedAt: new Date() } })
  }

  async updateDefaultTitleFromMessage(id: string, content: string) {
    const title = conversationTitleFromMessage(content)
    if (!title) return null
    const result = await prisma.conversation.updateMany({
      where: { id, title: DEFAULT_CONVERSATION_TITLE },
      data: { title, updatedAt: new Date() },
    })
    return result.count > 0 ? title : null
  }

  async updateModel(id: string, model: string) {
    return prisma.conversation.update({ where: { id }, data: { model, updatedAt: new Date() } })
  }

  async updateMetadata(id: string, metadata: Record<string, unknown>) {
    const conv = await prisma.conversation.findUnique({ where: { id }, select: { metadata: true } })
    if (!conv) throw new AppError('NOT_FOUND', 'Conversation not found', 404)
    const merged = { ...((conv.metadata || {}) as Record<string, unknown>), ...metadata }
    return prisma.conversation.update({ where: { id }, data: { metadata: merged as any, updatedAt: new Date() } })
  }
}

export const conversationService = new ConversationService()
