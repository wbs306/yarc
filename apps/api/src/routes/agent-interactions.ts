import { Hono } from 'hono'
import { AppError } from '../lib/errors.js'
import { agentInteractionRegistry } from '../lib/agent-interaction-registry.js'
import type { AgentInteractionResponse } from '@yarc/shared'

const agentInteractions = new Hono()

const isAction = (value: unknown): value is AgentInteractionResponse['action'] =>
  value === 'submit' || value === 'cancel' || value === 'chat'

agentInteractions.post('/:requestId/respond', async (c) => {
  const requestId = c.req.param('requestId')

  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    throw new AppError('INVALID_REQUEST', 'Invalid JSON body', 400)
  }

  const action = (body as { action?: unknown }).action
  if (!isAction(action)) throw new AppError('INVALID_ACTION', 'action must be submit, cancel, or chat', 400)

  // E5: Check if already resolved (multi-window friendly)
  const alreadyResolved = agentInteractionRegistry.getResolvedAction(requestId)
  if (alreadyResolved) {
    return c.json({ ok: false, resolved: true, action: alreadyResolved, message: '该请求已在其他窗口处理' })
  }

  const pending = agentInteractionRegistry.get(requestId)
  if (!pending) throw new AppError('INTERACTION_NOT_FOUND', 'Interaction request not found or already resolved', 404)

  // E6: conversationId validation
  const bodyConversationId = (body as { conversationId?: unknown }).conversationId
  if (bodyConversationId && typeof bodyConversationId === 'string' && bodyConversationId !== pending.conversationId) {
    throw new AppError('CONVERSATION_MISMATCH', 'conversationId does not match this interaction', 403)
  }

  const response: AgentInteractionResponse = {
    requestId,
    action,
    value: (body as { value?: unknown }).value,
  }

  const ok = agentInteractionRegistry.respond(requestId, response)
  if (!ok) throw new AppError('INTERACTION_NOT_FOUND', 'Interaction request not found or already resolved', 404)

  return c.json({ ok: true })
})

export default agentInteractions
