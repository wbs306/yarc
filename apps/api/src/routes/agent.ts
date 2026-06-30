import { Hono } from 'hono'
import { agentService } from '../services/agent.service.js'

const agent = new Hono()

// POST /api/agent/auto-classify - 自动分类论文
agent.post('/auto-classify', async (c) => {
  try {
    const body = await c.req.json()
    const { paperId } = body

    if (!paperId) {
      return c.json({ error: { code: 'MISSING_PAPER_ID', message: '论文ID不能为空' } }, 400)
    }

    const result = await agentService.autoClassifyPaper(paperId)
    return c.json(result)
  } catch (err) {
    return c.json({ error: { code: 'CLASSIFY_ERROR', message: (err as Error).message } }, 500)
  }
})

export default agent
