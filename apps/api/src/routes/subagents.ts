import { Hono } from 'hono'
import { piService } from '../services/pi.service.js'
import { AppError } from '../lib/errors.js'
import type { ChatEvent } from '@yarc/shared'

const subagents = new Hono()

/**
 * Execute a subagent control action (status, interrupt, resume, append-step).
 *
 * This works by sending the control action through the Pi session that owns
 * the subagent run. The agent processes the action and returns the result.
 */
subagents.post('/:runId/:action', async (c) => {
  const runId = c.req.param('runId')
  const action = c.req.param('action')

  if (!['status', 'interrupt', 'resume', 'append-step'].includes(action)) {
    throw new AppError('INVALID_ACTION', 'action must be status, interrupt, resume, or append-step', 400)
  }

  const body = await c.req.json().catch(() => ({}))
  const conversationId = typeof body.conversationId === 'string' ? body.conversationId : undefined
  const branchId = typeof body.branchId === 'string' ? body.branchId : undefined
  const message = typeof body.message === 'string' ? body.message : undefined
  const index = typeof body.index === 'number' ? body.index : undefined
  const agent = typeof body.agent === 'string' ? body.agent : undefined
  const task = typeof body.task === 'string' ? body.task : undefined

  // Build the subagent tool control action prompt
  let prompt = `subagent({ action: "${action}", id: "${runId}" }`
  if (message) prompt += `, message: "${message.replace(/"/g, '\\"')}"`
  if (index !== undefined) prompt += `, index: ${index}`
  if (agent) prompt += `, agent: "${agent}"`
  if (task) prompt += `, task: "${task.replace(/"/g, '\\"')}"`
  prompt += ')'

  // Execute through Pi (in-memory, no persistence)
  const events: ChatEvent[] = []
  let result = ''
  for await (const event of piService.completeEvents({
    conversationId,
    branchId,
    prompt: `Execute this subagent control action and return the result:\n${prompt}`,
  })) {
    events.push(event)
    if (event.type === 'text') result += event.content
  }

  return c.json({ result: result.trim() || 'No result', events })
})

export default subagents
