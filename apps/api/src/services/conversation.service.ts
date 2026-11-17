import { prisma } from '@yarc/db'
import { AppError } from '../lib/errors.js'
import type { ConversationModelSettings, ChatThinkingLevel } from '@yarc/shared'

const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

export function parseConversationModelSettings(value: unknown): ConversationModelSettings | null {
  if (!value || typeof value !== 'object') return null
  const settings = value as Record<string, unknown>
  if (typeof settings.model !== 'string' || !settings.model.trim() || settings.model.length > 512) return null
  if (typeof settings.reasoningEffort !== 'string' || !THINKING_LEVELS.has(settings.reasoningEffort)) return null
  return { model: settings.model, reasoningEffort: settings.reasoningEffort as ChatThinkingLevel }
}

export function getConversationModelSettings(metadata: unknown): ConversationModelSettings | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null
  return parseConversationModelSettings((metadata as Record<string, unknown>).modelSettings)
}

const DEFAULT_CONVERSATION_TITLE = '新对话'

export const conversationTitleFromMessage = (content: string) =>
  content.slice(0, 30).replace(/\n/g, ' ').trim()

export class ConversationService {
  async list(options: { projectId?: string | null } = {}) {
    const conversations = await prisma.conversation.findMany({
      where: options.projectId !== undefined ? { projectId: options.projectId } : undefined,
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        paperId: true,
        projectId: true,
        title: true,
        model: true,
        metadata: true,
        createdAt: true,
        updatedAt: true,
      },
    })
    return conversations.map(({ metadata, ...conversation }) => ({
      ...conversation,
      modelSettings: getConversationModelSettings(metadata),
    }))
  }

  async getById(id: string) {
    const conv = await prisma.conversation.findUnique({ where: { id } })
    if (!conv) throw new AppError('NOT_FOUND', 'Conversation not found', 404)
    return conv
  }

  async create(data: { id?: string; paperId?: string; projectId?: string; title?: string; model?: string; systemPrompt?: string; modelSettings?: ConversationModelSettings }) {
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
        model: data.modelSettings?.model || data.model,
        ...(data.modelSettings ? { metadata: { modelSettings: { model: data.modelSettings.model, reasoningEffort: data.modelSettings.reasoningEffort } } } : {}),
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

  async updateModelSettings(id: string, settings: ConversationModelSettings) {
    const json = JSON.stringify(settings)
    const updated = await prisma.$executeRaw`
      UPDATE conversations
      SET model = ${settings.model},
          metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{modelSettings}', ${json}::jsonb, true)
      WHERE id = ${id}::uuid
    `
    if (!updated) throw new AppError('NOT_FOUND', 'Conversation not found', 404)
  }

  async updateMetadata(id: string, metadata: Record<string, unknown>) {
    const conv = await prisma.conversation.findUnique({ where: { id }, select: { metadata: true } })
    if (!conv) throw new AppError('NOT_FOUND', 'Conversation not found', 404)
    const merged = { ...((conv.metadata || {}) as Record<string, unknown>), ...metadata }
    return prisma.conversation.update({ where: { id }, data: { metadata: merged as any, updatedAt: new Date() } })
  }
}

export const conversationService = new ConversationService()
