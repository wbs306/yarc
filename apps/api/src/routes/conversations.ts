import { Hono } from 'hono'
import { prisma } from '@yarc/db'
import { conversationService } from '../services/conversation.service.js'
import { piConversationService } from '../services/pi-conversation.service.js'
import { piService } from '../services/pi.service.js'
import { streamBuffer } from '../lib/stream-buffer-singleton.js'
import { streamingRegistry } from '../lib/streaming-registry.js'
import { chatStreamControl } from '../lib/chat-stream-control.js'
import { agentInteractionRegistry } from '../lib/agent-interaction-registry.js'
import { btwRunRegistry } from '../lib/btw-run-registry.js'
import { sseHub } from '../lib/sse.js'
import { AppError } from '../lib/errors.js'
import type { ChatEvent } from '@yarc/shared'

const conversations = new Hono()

// GET /api/conversations
conversations.get('/', async (c) => {
  const list = await conversationService.list()
  return c.json({ conversations: list })
})

// POST /api/conversations
conversations.post('/', async (c) => {
  const body = await c.req.json()
  const conv = await conversationService.create(body)
  return c.json({ conversation: conv }, 201)
})

// GET /api/conversations/:id
conversations.get('/:id', async (c) => {
  const id = c.req.param('id')
  const conv = await conversationService.getById(id)
  return c.json({ conversation: conv })
})

// DELETE /api/conversations/:id
conversations.delete('/:id', async (c) => {
  const id = c.req.param('id')
  // Read metadata before deleting so we can clean up Pi session files.
  const conv = await prisma.conversation.findUnique({ where: { id }, select: { metadata: true } })
  agentInteractionRegistry.cancelByConversation(id, 'conversation_deleted')
  await conversationService.delete(id)
  // Best-effort cleanup of Pi session files on disk.
  await piService.deleteSessionFiles(conv?.metadata as Record<string, unknown>).catch(() => {})
  return c.json({ message: 'Deleted' })
})

// GET /api/conversations/:id/branches
conversations.get('/:id/branches', async (c) => {
  const id = c.req.param('id')
  const branches = await piConversationService.listBranches(id)
  return c.json({ branches })
})

// GET /api/conversations/:id/context-usage
conversations.get('/:id/context-usage', async (c) => {
  const id = c.req.param('id')
  const branchId = c.req.query('branchId') || 'main'
  const contextUsage = await piService.getConversationContextUsage(id, branchId)
  return c.json({ contextUsage })
})

// POST /api/conversations/:id/switch-branch/:branchId
conversations.post('/:id/switch-branch/:branchId', async (c) => {
  const convId = c.req.param('id')
  const branchId = c.req.param('branchId')
  const messages = await piConversationService.switchBranch(convId, branchId)
  return c.json({ messages })
})

// PUT /api/conversations/:id/title
conversations.put('/:id/title', async (c) => {
  const id = c.req.param('id')
  const { title } = await c.req.json()
  const conv = await conversationService.updateTitle(id, title)
  return c.json({ conversation: conv })
})

// POST /api/conversations/:id/btw
// Start a streaming /btw side question. Returns runId for SSE tracking.
conversations.post('/:id/btw', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => ({}))
  const question = typeof body.question === 'string' ? body.question.trim() : ''
  if (!question) throw new AppError('INVALID_REQUEST', 'question is required', 400)

  const conv = await prisma.conversation.findUnique({ where: { id }, select: { model: true } })
  if (!conv) throw new AppError('NOT_FOUND', 'Conversation not found', 404)

  const branchId = typeof body.branchId === 'string' ? body.branchId : null
  const run = btwRunRegistry.create(id, branchId, question)

  // Emit start event via SSE
  sseHub.emit({ type: 'btw_start', runId: run.id, conversationId: id, question, at: run.createdAt })

  // Run async (fire-and-forget from the request handler)
  ;(async () => {
    try {
      const result = await piService.answerSideQuestion({
        conversationId: id,
        branchId: branchId || undefined,
        model: typeof body.model === 'string' ? body.model : conv.model || undefined,
        reasoningEffort: typeof body.reasoningEffort === 'string' ? body.reasoningEffort : undefined,
        thinkingEnabled: typeof body.thinkingEnabled === 'boolean'
          ? body.thinkingEnabled
          : (body.reasoningEffort === 'off' ? false : undefined),
        question,
        abortSignal: run.abortController.signal,
        onEvent: (event: ChatEvent) => {
          if (event.type === 'text') {
            run.answer += event.content || ''
            sseHub.emit({ type: 'btw_delta', runId: run.id, content: event.content || '' })
          } else if (event.type === 'thinking') {
            run.thinking += event.content || ''
            sseHub.emit({ type: 'btw_thinking', runId: run.id, content: event.content || '' })
          }
        },
      })

      if (run.status === 'cancelled') {
        sseHub.emit({ type: 'btw_cancelled', runId: run.id })
        return
      }

      btwRunRegistry.complete(run.id, result.answer, result.thinking)
      sseHub.emit({ type: 'btw_done', runId: run.id, answer: result.answer })
    } catch (err) {
      const errorMessage = (err as Error).message || '侧问失败'
      btwRunRegistry.fail(run.id, errorMessage)
      sseHub.emit({ type: 'btw_error', runId: run.id, error: errorMessage })
    }
  })()

  return c.json({ runId: run.id, status: run.status })
})

// GET /api/conversations/:id/btw/runs — list btw runs for a conversation
conversations.get('/:id/btw/runs', async (c) => {
  const id = c.req.param('id')
  const runs = btwRunRegistry.getByConversation(id)
  return c.json({ runs: runs.map(r => ({
    id: r.id,
    question: r.question,
    answer: r.answer,
    thinking: r.thinking || undefined,
    status: r.status,
    error: r.error || undefined,
    createdAt: r.createdAt,
  })) })
})

// POST /api/conversations/:id/btw/:runId/cancel — cancel a running btw
conversations.post('/:id/btw/:runId/cancel', async (c) => {
  const runId = c.req.param('runId')
  const ok = btwRunRegistry.cancel(runId)
  if (!ok) throw new AppError('NOT_FOUND', 'Run not found or not running', 404)
  sseHub.emit({ type: 'btw_cancelled', runId })
  return c.json({ ok: true })
})

// DELETE /api/conversations/:id/btw/:runId — delete a btw run (in-memory only, ephemeral)
conversations.delete('/:id/btw/:runId', async (c) => {
  const runId = c.req.param('runId')
  btwRunRegistry.delete(runId)
  return c.json({ ok: true })
})

// ── Streaming reconnection ───────────────────────────────────────────────────

// GET /api/conversations/:id/streaming-message
conversations.get('/:id/streaming-message', async (c) => {
  const id = c.req.param('id')

  // Check in-memory streaming registry first
  const activeStream = streamingRegistry.get(id)
  if (activeStream) {
    const bufferedStream = streamBuffer.get(activeStream.messageId)
    const message = {
      id: activeStream.messageId,
      conversationId: id,
      branchId: activeStream.branchId,
      role: 'assistant' as const,
      content: '',
      toolCalls: null,
      metadata: { pending: true, segments: [], streamStatus: 'streaming' },
      createdAt: new Date(bufferedStream?.createdAt || activeStream.startedAt).toISOString(),
    }

    // If we have buffered events, return the complete in-flight turn metadata.
    if (bufferedStream) {
      return c.json({
        message,
        userMessage: bufferedStream.userMessage || null,
        events: streamBuffer.getEvents(activeStream.messageId),
        fromBuffer: true,
      })
    }
    // Stream is still active but no buffer yet (shouldn't happen normally).
    return c.json({ message, userMessage: null })
  }

  return c.json({ message: null })
})

// POST /api/conversations/:id/streaming-message/:messageId/stop
conversations.post('/:id/streaming-message/:messageId/stop', async (c) => {
  const convId = c.req.param('id')
  const messageId = c.req.param('messageId')

  // Cancel the stream and any pending web interaction owned by it. The
  // producer owns final stream persistence and registry cleanup; wait for it
  // before returning so the next prompt cannot race the aborted Pi session.
  chatStreamControl.cancel(messageId)
  agentInteractionRegistry.cancelByStream(messageId, 'stream_stopped')

  const activeStream = streamingRegistry.get(convId)
  if (activeStream?.messageId === messageId) {
    await streamingRegistry.waitForMessage(messageId)
  } else if (streamBuffer.has(messageId)) {
    // Fallback for a stream whose producer has already disappeared. There is
    // no active session left to drain, so close the buffer locally.
    await streamBuffer.fail(messageId, '已停止生成')
  }

  return c.json({ ok: true })
})

export default conversations
