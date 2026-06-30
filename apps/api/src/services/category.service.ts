import { prisma } from '@yarc/db'
import { AppError } from '../lib/errors.js'

export class CategoryService {
  private async assertValidParent(id: string | null, parentId: string | null | undefined) {
    if (!parentId) return
    if (id && parentId === id) {
      throw new AppError('INVALID_PARENT', 'Category cannot be parent of itself', 400)
    }

    const parent = await prisma.category.findUnique({
      where: { id: parentId },
      select: { id: true, parentId: true },
    })
    if (!parent) throw new AppError('NOT_FOUND', 'Parent category not found', 404)

    let cursor = parent.parentId
    while (cursor) {
      if (id && cursor === id) {
        throw new AppError('INVALID_PARENT', 'Category cycle is not allowed', 400)
      }
      const next = await prisma.category.findUnique({
        where: { id: cursor },
        select: { parentId: true },
      })
      cursor = next?.parentId || null
    }
  }

  async list() {
    return prisma.category.findMany({
      include: { _count: { select: { papers: true } } },
      orderBy: { name: 'asc' },
    })
  }

  async create(data: { name: string; parentId?: string | null; color?: string }) {
    await this.assertValidParent(null, data.parentId)
    return prisma.category.create({ data })
  }

  async update(id: string, data: { name?: string; color?: string; parentId?: string | null }) {
    const cat = await prisma.category.findUnique({ where: { id } })
    if (!cat) throw new AppError('NOT_FOUND', 'Category not found', 404)
    if (data.parentId !== undefined) await this.assertValidParent(id, data.parentId)
    return prisma.category.update({ where: { id }, data })
  }

  async delete(id: string) {
    const cat = await prisma.category.findUnique({
      where: { id },
      include: { papers: { select: { id: true } }, children: { select: { id: true } } },
    })
    if (!cat) throw new AppError('NOT_FOUND', 'Category not found', 404)

    // Move papers to uncategorized
    if (cat.papers.length > 0) {
      await prisma.paper.updateMany({
        where: { categoryId: id },
        data: { categoryId: null },
      })
    }

    // Move children to parent
    if (cat.children.length > 0) {
      await prisma.category.updateMany({
        where: { parentId: id },
        data: { parentId: cat.parentId },
      })
    }

    await prisma.category.delete({ where: { id } })
  }

  async deleteMany(ids: string[]) {
    let totalPapers = 0
    let deleted = 0
    for (const id of ids) {
      const cat = await prisma.category.findUnique({
        where: { id },
        include: { papers: { select: { id: true } }, children: { select: { id: true } } },
      })
      if (cat) {
        totalPapers += cat.papers.length
        if (cat.papers.length > 0) {
          await prisma.paper.updateMany({
            where: { categoryId: id },
            data: { categoryId: null },
          })
        }
        if (cat.children.length > 0) {
          await prisma.category.updateMany({
            where: { parentId: id },
            data: { parentId: cat.parentId },
          })
        }
        await prisma.category.delete({ where: { id } })
        deleted += 1
      }
    }
    return { requested: ids.length, deleted, missing: ids.length - deleted, papersUncategorized: totalPapers }
  }
}

export const categoryService = new CategoryService()
