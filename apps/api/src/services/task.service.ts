import { prisma } from '@yarc/db'
import { AppError } from '../lib/errors.js'

export class TaskService {
  async list(status?: string, limit = 50) {
    const where: any = {}
    if (status) where.status = status

    return prisma.task.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
    })
  }

  async getById(id: string) {
    const task = await prisma.task.findUnique({ where: { id } })
    if (!task) throw new AppError('NOT_FOUND', 'Task not found', 404)
    return task
  }

  async cancel(id: string) {
    const task = await prisma.task.findUnique({ where: { id } })
    if (!task) throw new AppError('NOT_FOUND', 'Task not found', 404)
    if (task.status !== 'pending') {
      throw new AppError('INVALID_STATUS', 'Can only cancel pending tasks', 400)
    }
    return prisma.task.update({
      where: { id },
      data: { status: 'failed', error: 'Cancelled by user', completedAt: new Date() },
    })
  }

  async retry(id: string) {
    const task = await prisma.task.findUnique({ where: { id } })
    if (!task) throw new AppError('NOT_FOUND', 'Task not found', 404)
    if (task.status !== 'failed') {
      throw new AppError('INVALID_STATUS', 'Can only retry failed tasks', 400)
    }

    return prisma.task.update({
      where: { id },
      data: { status: 'pending', error: null, progress: 0, result: null as any, completedAt: null },
    })
  }

  async getStats() {
    const [pending, active, completed, failed] = await Promise.all([
      prisma.task.count({ where: { status: 'pending' } }),
      prisma.task.count({ where: { status: 'active' } }),
      prisma.task.count({ where: { status: 'completed' } }),
      prisma.task.count({ where: { status: 'failed' } }),
    ])
    return { pending, active, completed, failed }
  }
}

export const taskService = new TaskService()
