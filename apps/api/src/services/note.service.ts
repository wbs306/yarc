import { prisma } from '@yarc/db'
import { AppError } from '../lib/errors.js'

export class NoteService {
  async listByPaper(paperId: string, options?: { kind?: string }) {
    return prisma.note.findMany({
      where: {
        paperId,
        ...(options?.kind ? { kind: options.kind } : {}),
      },
      orderBy: { createdAt: 'desc' },
    })
  }

  async getById(id: string) {
    const note = await prisma.note.findUnique({ where: { id } })
    if (!note) throw new AppError('NOT_FOUND', 'Note not found', 404)
    return note
  }

  async create(data: {
    paperId: string
    title?: string
    content?: string
    pageNumber?: number
    highlightText?: string
    highlightRect?: Record<string, number>
    kind?: string
    filePath?: string
  }) {
    return prisma.note.create({
      data: {
        paperId: data.paperId,
        title: data.title || '',
        content: data.content || '',
        pageNumber: data.pageNumber,
        highlightText: data.highlightText,
        highlightRect: data.highlightRect as any,
        kind: data.kind || 'note',
        filePath: data.filePath,
      },
    })
  }

  async update(id: string, data: {
    title?: string
    content?: string
    pageNumber?: number
    highlightText?: string
    highlightRect?: Record<string, number>
    kind?: string
    filePath?: string
  }) {
    const note = await prisma.note.findUnique({ where: { id } })
    if (!note) throw new AppError('NOT_FOUND', 'Note not found', 404)

    return prisma.note.update({ where: { id }, data: data as any })
  }

  async delete(id: string) {
    const note = await prisma.note.findUnique({ where: { id } })
    if (!note) throw new AppError('NOT_FOUND', 'Note not found', 404)
    await prisma.note.delete({ where: { id } })
  }
}

export const noteService = new NoteService()
