import { prisma } from '@yarc/db'
import { AppError } from '../lib/errors.js'

// ── Service ──────────────────────────────────────────────────────────────────

/**
 * ConversationService - Handles conversation metadata CRUD operations.
 * Message and branch operations are now handled by PiConversationService.
 */
export class ConversationService {
  async list() {
    return prisma.conversation.findMany({
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        paperId: true,
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

  async create(data: { paperId?: string; title?: string; model?: string; systemPrompt?: string }) {
    const conv = await prisma.conversation.create({
      data: {
        paperId: data.paperId,
        title: data.title || '新对话',
        model: data.model,
        systemPrompt: data.systemPrompt,
      },
    })
    return conv
  }

  async delete(id: string) {
    const conv = await prisma.conversation.findUnique({ where: { id } })
    if (!conv) throw new AppError('NOT_FOUND', 'Conversation not found', 404)
    await prisma.conversation.delete({ where: { id } })
  }

  async updateTitle(id: string, title: string) {
    return prisma.conversation.update({
      where: { id },
      data: { title, updatedAt: new Date() },
    })
  }

  async updateModel(id: string, model: string) {
    return prisma.conversation.update({
      where: { id },
      data: { model, updatedAt: new Date() },
    })
  }

  async updateMetadata(id: string, metadata: Record<string, unknown>) {
    const conv = await prisma.conversation.findUnique({
      where: { id },
      select: { metadata: true },
    })
    if (!conv) throw new AppError('NOT_FOUND', 'Conversation not found', 404)

    const merged = { ...((conv.metadata || {}) as Record<string, unknown>), ...metadata }
    return prisma.conversation.update({
      where: { id },
      data: { metadata: merged as any, updatedAt: new Date() },
    })
  }
}

export const conversationService = new ConversationService()
