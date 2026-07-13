import { readFile, realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { prisma } from '@yarc/db'
import type { NoteFileSyncItem, NoteFileSyncResult } from '@yarc/shared'
import { config } from '../lib/config.js'
import { AppError } from '../lib/errors.js'

const PAPER_ID_RE = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i

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

  async syncFromFiles(paperIds?: string[]): Promise<NoteFileSyncResult> {
    const requestedPaperIds = paperIds ? [...new Set(paperIds)] : null
    if (requestedPaperIds?.some(id => !PAPER_ID_RE.test(id))) {
      throw new AppError('INVALID_PAPER_ID', 'Invalid paper ID', 400)
    }

    const notes = await prisma.note.findMany({
      where: {
        filePath: { not: null },
        ...(requestedPaperIds ? { paperId: { in: requestedPaperIds } } : {}),
      },
      orderBy: { createdAt: 'asc' },
    })

    const items: NoteFileSyncItem[] = []
    const updatedNoteIds: string[] = []
    const changedPaperIds = new Set<string>()

    for (const note of notes) {
      const item: NoteFileSyncItem = { noteId: note.id, paperId: note.paperId, status: 'failed' }
      try {
        const paperNotesDir = resolve(config.papersDir, note.paperId, 'notes')
        const storedPath = note.filePath || ''
        const fullPath = isAbsolute(storedPath)
          ? resolve(storedPath)
          : storedPath.replace(/\\/g, '/').startsWith('papers/')
            ? resolve(config.dataDir, storedPath)
            : resolve(paperNotesDir, storedPath)
        const relativePath = relative(paperNotesDir, fullPath)
        if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
          item.error = '笔记文件路径不在对应论文的 notes 目录中'
          items.push(item)
          continue
        }
        if (!['.md', '.markdown'].includes(extname(fullPath).toLowerCase())) {
          item.error = '笔记文件不是 Markdown 格式'
          items.push(item)
          continue
        }

        let fileStat
        try {
          fileStat = await stat(fullPath)
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            item.status = 'missing'
            items.push(item)
            continue
          }
          item.error = '读取笔记文件状态失败'
          items.push(item)
          continue
        }
        if (!fileStat.isFile()) {
          item.error = '笔记路径不是文件'
          items.push(item)
          continue
        }
        if (fileStat.size > config.maxFileSize) {
          item.error = '笔记文件超过大小限制'
          items.push(item)
          continue
        }

        const realNotesDir = await realpath(paperNotesDir)
        const realFilePath = await realpath(fullPath)
        const realRelativePath = relative(realNotesDir, realFilePath)
        if (!realRelativePath || realRelativePath === '..' || realRelativePath.startsWith(`..${sep}`) || isAbsolute(realRelativePath)) {
          item.error = '笔记文件指向了论文 notes 目录之外'
          items.push(item)
          continue
        }

        const content = await readFile(realFilePath, 'utf-8')
        if (content === note.content) {
          item.status = 'unchanged'
          items.push(item)
          continue
        }

        await prisma.note.update({
          where: { id: note.id },
          data: { content, updatedAt: new Date() },
        })
        item.status = 'synced'
        updatedNoteIds.push(note.id)
        changedPaperIds.add(note.paperId)
        items.push(item)
      } catch {
        item.error = '同步笔记文件失败'
        items.push(item)
      }
    }

    return {
      requestedPaperIds,
      matched: items.length,
      synced: items.filter(item => item.status === 'synced').length,
      unchanged: items.filter(item => item.status === 'unchanged').length,
      missing: items.filter(item => item.status === 'missing').length,
      failed: items.filter(item => item.status === 'failed').length,
      updatedNoteIds,
      changedPaperIds: [...changedPaperIds],
      items,
    }
  }
}

export const noteService = new NoteService()
