import { Hono } from 'hono'
import { taskService } from '../services/task.service.js'

const tasks = new Hono()

// GET /api/tasks
tasks.get('/', async (c) => {
  const status = c.req.query('status')
  const limit = parseInt(c.req.query('limit') || '50')
  const list = await taskService.list(status, limit)
  return c.json({ tasks: list })
})

// GET /api/tasks/stats
tasks.get('/stats', async (c) => {
  const stats = await taskService.getStats()
  return c.json(stats)
})

// GET /api/tasks/:id
tasks.get('/:id', async (c) => {
  const id = c.req.param('id')
  const task = await taskService.getById(id)
  return c.json({ task })
})

// POST /api/tasks/:id/cancel
tasks.post('/:id/cancel', async (c) => {
  const id = c.req.param('id')
  const task = await taskService.cancel(id)
  return c.json({ task })
})

// POST /api/tasks/:id/retry
tasks.post('/:id/retry', async (c) => {
  const id = c.req.param('id')
  const task = await taskService.retry(id)
  return c.json({ task })
})

export default tasks
