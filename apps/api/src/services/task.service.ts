import { prisma } from '@yarc/db'
import { AppError } from '../lib/errors.js'
import { JOB_QUEUE_CONCURRENCY_SETTING_KEY, jobQueue } from './job-queue.service.js'
import type { JobQueueConcurrency, JobType } from './job-queue.service.js'

export class TaskService {
  async list(status?: string, limit = 50, order: 'asc' | 'desc' = 'desc') {
    const where: any = {}
    if (status) where.status = status

    const numericLimit = Number(limit)
    const take = Number.isFinite(numericLimit) && numericLimit > 0
      ? Math.min(Math.floor(numericLimit), 5000)
      : undefined

    return prisma.task.findMany({
      where,
      orderBy: { createdAt: order },
      ...(take ? { take } : {}),
      include: {
        paper: { select: { id: true, title: true } },
      },
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

    const reason = 'Cancelled by user'
    await jobQueue.cancelPendingTask(id, reason)
    const updated = await prisma.task.updateMany({
      where: { id, status: 'pending' },
      data: { status: 'failed', error: reason, completedAt: new Date() },
    })
    if (updated.count === 0) {
      throw new AppError('INVALID_STATUS', 'Can only cancel pending tasks', 400)
    }
    return this.getById(id)
  }

  async retry(id: string) {
    const task = await prisma.task.findUnique({ where: { id } })
    if (!task) throw new AppError('NOT_FOUND', 'Task not found', 404)
    if (task.status !== 'failed') {
      throw new AppError('INVALID_STATUS', 'Can only retry failed tasks', 400)
    }

    const updated = await prisma.task.update({
      where: { id },
      data: { status: 'pending', error: null, progress: 0, result: null as any, completedAt: null },
    })
    jobQueue.add(updated.type as JobType, updated.paperId, { persistTask: false, taskId: updated.id })
    return updated
  }

  getConcurrency() {
    return jobQueue.getConcurrency()
  }

  async updateConcurrency(input: Partial<JobQueueConcurrency>) {
    const concurrency = jobQueue.setConcurrency(input)
    const value: Record<string, number> = { ...concurrency }
    await prisma.setting.upsert({
      where: { key: JOB_QUEUE_CONCURRENCY_SETTING_KEY },
      create: { key: JOB_QUEUE_CONCURRENCY_SETTING_KEY, value },
      update: { value, updatedAt: new Date() },
    })
    return concurrency
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
