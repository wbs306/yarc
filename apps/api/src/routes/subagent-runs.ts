import { Hono } from 'hono'
import { subagentWatcher } from '../lib/subagent-watcher.js'
import { AppError } from '../lib/errors.js'

const subagentRuns = new Hono()

// POST /api/subagent-runs/:runId/track — register a run for tracking
subagentRuns.post('/:runId/track', async (c) => {
  const runId = c.req.param('runId')
  const body = await c.req.json().catch(() => ({}))
  const conversationId = typeof body.conversationId === 'string' ? body.conversationId : ''
  const messageId = typeof body.messageId === 'string' ? body.messageId : ''
  const branchId = typeof body.branchId === 'string' ? body.branchId : undefined

  if (!runId) throw new AppError('INVALID_REQUEST', 'runId is required', 400)

  const run = subagentWatcher.trackRun(runId, conversationId, messageId, branchId)
  return c.json({ run })
})

// GET /api/subagent-runs?conversationId=xxx — get tracked runs for a conversation
subagentRuns.get('/', async (c) => {
  const conversationId = c.req.query('conversationId')
  const runs = conversationId
    ? subagentWatcher.getTrackedRunsByConversation(conversationId)
    : subagentWatcher.getTrackedRuns()
  return c.json({ runs })
})

// DELETE /api/subagent-runs/:runId — stop tracking a run
subagentRuns.delete('/:runId', async (c) => {
  const runId = c.req.param('runId')
  subagentWatcher.untrackRun(runId)
  return c.json({ ok: true })
})

export default subagentRuns
