import { Hono } from 'hono'
import { AppError } from '../lib/errors.js'
import { agentInteractionRegistry } from '../lib/agent-interaction-registry.js'
import { piService } from '../services/pi.service.js'
import type { AgentInteractionResponse, PiComposerMirror } from '@yarc/shared'

const agentInteractions = new Hono()

const isAction = (value: unknown): value is AgentInteractionResponse['action'] =>
  value === 'submit' || value === 'cancel' || value === 'chat'

const runtimeKeyFromRequest = (conversationId: string, branchId: unknown) => ({
  conversationId,
  branchId: typeof branchId === 'string' && branchId ? branchId : 'main',
})

agentInteractions.get('/runtime/:conversationId', async (c) => {
  const key = runtimeKeyFromRequest(c.req.param('conversationId'), c.req.query('branchId'))
  return c.json({ runtime: await piService.getRuntimeSnapshot(key) })
})

agentInteractions.post('/runtime/:conversationId/composer', async (c) => {
  const conversationId = c.req.param('conversationId')
  const body = await c.req.json().catch(() => null) as Partial<PiComposerMirror> | null
  if (!body || typeof body.text !== 'string' || typeof body.revision !== 'number') {
    throw new AppError('INVALID_REQUEST', 'text and revision are required', 400)
  }
  const branchId = typeof body.branchId === 'string' && body.branchId ? body.branchId : 'main'
  const mirror: PiComposerMirror = {
    conversationId,
    branchId,
    text: body.text,
    selectionStart: Number.isFinite(body.selectionStart) ? Number(body.selectionStart) : body.text.length,
    selectionEnd: Number.isFinite(body.selectionEnd) ? Number(body.selectionEnd) : body.text.length,
    revision: Math.max(0, Math.floor(body.revision)),
    clientId: typeof body.clientId === 'string' && body.clientId ? body.clientId : 'web',
  }
  piService.updateRuntimeComposer(mirror)
  return c.json({ ok: true, revision: mirror.revision })
})

agentInteractions.post('/runtime/:conversationId/autocomplete', async (c) => {
  const conversationId = c.req.param('conversationId')
  const body = await c.req.json().catch(() => null) as { branchId?: unknown; lines?: unknown; cursorLine?: unknown; cursorCol?: unknown; force?: unknown } | null
  if (!body || !Array.isArray(body.lines) || !body.lines.every(line => typeof line === 'string')) {
    throw new AppError('INVALID_REQUEST', 'lines are required', 400)
  }
  const key = runtimeKeyFromRequest(conversationId, body.branchId)
  const result = await piService.getRuntimeAutocomplete(key, body.lines, Number(body.cursorLine || 0), Number(body.cursorCol || 0), !!body.force)
  return c.json({ result })
})

agentInteractions.post('/runtime/:conversationId/autocomplete/apply', async (c) => {
  const conversationId = c.req.param('conversationId')
  const body = await c.req.json().catch(() => null) as any
  if (!body || !Array.isArray(body.lines) || typeof body.item?.value !== 'string' || typeof body.prefix !== 'string') {
    throw new AppError('INVALID_REQUEST', 'lines, item, and prefix are required', 400)
  }
  const key = runtimeKeyFromRequest(conversationId, body.branchId)
  const result = await piService.applyRuntimeAutocomplete(key, {
    lines: body.lines.map(String),
    cursorLine: Number(body.cursorLine || 0),
    cursorCol: Number(body.cursorCol || 0),
    item: { value: body.item.value, label: String(body.item.label || body.item.value), description: typeof body.item.description === 'string' ? body.item.description : undefined },
    prefix: body.prefix,
  })
  return c.json({ result })
})

agentInteractions.post('/runtime/:conversationId/tui/:surfaceId/input', async (c) => {
  const conversationId = c.req.param('conversationId')
  const surfaceId = c.req.param('surfaceId')
  const body = await c.req.json().catch(() => null) as { branchId?: unknown; data?: unknown; revision?: unknown; clientId?: unknown } | null
  if (!body || typeof body.data !== 'string') throw new AppError('INVALID_REQUEST', 'data is required', 400)
  const key = runtimeKeyFromRequest(conversationId, body.branchId)
  const result = piService.sendRuntimeTuiInput(key, surfaceId, body.data, Number.isFinite(body.revision) ? Number(body.revision) : undefined, typeof body.clientId === 'string' ? body.clientId : undefined)
  if (result === 'missing') throw new AppError('TUI_SURFACE_NOT_FOUND', 'TUI surface not found', 404)
  if (result === 'busy') throw new AppError('TUI_SURFACE_BUSY', 'TUI surface is controlled by another browser window', 409)
  return c.json({ ok: true })
})

agentInteractions.post('/runtime/:conversationId/tui/:surfaceId/resize', async (c) => {
  const conversationId = c.req.param('conversationId')
  const surfaceId = c.req.param('surfaceId')
  const body = await c.req.json().catch(() => null) as { branchId?: unknown; cols?: unknown; rows?: unknown; revision?: unknown; clientId?: unknown } | null
  const cols = Number(body?.cols)
  const rows = Number(body?.rows)
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) throw new AppError('INVALID_REQUEST', 'cols and rows are required', 400)
  const key = runtimeKeyFromRequest(conversationId, body?.branchId)
  const ok = piService.resizeRuntimeTui(key, surfaceId, cols, rows, Number.isFinite(body?.revision) ? Number(body?.revision) : undefined, typeof body?.clientId === 'string' ? body.clientId : undefined)
  if (!ok) throw new AppError('TUI_SURFACE_NOT_FOUND', 'TUI surface not found', 404)
  return c.json({ ok: true })
})

agentInteractions.post('/runtime/:conversationId/tui/:surfaceId/close', async (c) => {
  const conversationId = c.req.param('conversationId')
  const surfaceId = c.req.param('surfaceId')
  const body = await c.req.json().catch(() => ({})) as { branchId?: unknown; clientId?: unknown }
  const key = runtimeKeyFromRequest(conversationId, body.branchId)
  const ok = piService.closeRuntimeTui(key, surfaceId, typeof body.clientId === 'string' ? body.clientId : undefined)
  if (!ok) throw new AppError('TUI_SURFACE_NOT_FOUND', 'TUI surface not found', 404)
  return c.json({ ok: true })
})

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
  const bodyBranchId = (body as { branchId?: unknown }).branchId
  if (bodyBranchId && typeof bodyBranchId === 'string' && bodyBranchId !== pending.branchId) {
    throw new AppError('BRANCH_MISMATCH', 'branchId does not match this interaction', 403)
  }

  const response: AgentInteractionResponse = {
    requestId,
    action,
    value: (body as { value?: unknown }).value,
    conversationId: pending.conversationId,
    branchId: pending.branchId,
    clientId: typeof (body as { clientId?: unknown }).clientId === 'string'
      ? (body as { clientId: string }).clientId
      : undefined,
  }

  const ok = agentInteractionRegistry.respond(requestId, response)
  if (!ok) throw new AppError('INTERACTION_NOT_FOUND', 'Interaction request not found or already resolved', 404)

  return c.json({ ok: true })
})

export default agentInteractions
