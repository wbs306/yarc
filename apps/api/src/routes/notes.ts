import { Hono } from 'hono'
import { AppError } from '../lib/errors.js'
import { sseHub } from '../lib/sse.js'
import { noteService } from '../services/note.service.js'

const notes = new Hono()

// POST /api/notes/sync — import linked Markdown files into database notes.
notes.post('/sync', async (c) => {
  const body = await c.req.json().catch(() => ({})) as { paperId?: unknown; paperIds?: unknown }
  const hasPaperIds = Object.prototype.hasOwnProperty.call(body, 'paperIds')
  if (hasPaperIds && (!Array.isArray(body.paperIds) || body.paperIds.length === 0 || body.paperIds.some(id => typeof id !== 'string'))) {
    throw new AppError('INVALID_PAPER_IDS', 'paperIds must be a non-empty string array', 400)
  }
  if (body.paperId !== undefined && typeof body.paperId !== 'string') {
    throw new AppError('INVALID_PAPER_ID', 'paperId must be a string', 400)
  }

  const paperIds = [...new Set([
    ...(typeof body.paperId === 'string' ? [body.paperId] : []),
    ...(Array.isArray(body.paperIds) ? body.paperIds as string[] : []),
  ])]
  if (paperIds.length > 100) throw new AppError('TOO_MANY_PAPERS', 'At most 100 paper IDs can be synced at once', 400)

  const result = await noteService.syncFromFiles(paperIds.length ? paperIds : undefined)
  for (const paperId of result.changedPaperIds) {
    sseHub.emit({
      type: 'notes-changed',
      source: 'file-sync',
      action: 'sync',
      paperId,
      noteIds: result.items.filter(item => item.paperId === paperId && item.status === 'synced').map(item => item.noteId),
      at: new Date().toISOString(),
    })
  }
  return c.json({ result })
})

// GET /api/notes/:paperId
notes.get('/:paperId', async (c) => {
  const paperId = c.req.param('paperId')
  const list = await noteService.listByPaper(paperId)
  return c.json({ notes: list })
})

// POST /api/notes/:paperId
notes.post('/:paperId', async (c) => {
  const paperId = c.req.param('paperId')
  const body = await c.req.json()
  const note = await noteService.create({ ...body, paperId })
  return c.json({ note }, 201)
})

// GET /api/notes/detail/:id
notes.get('/detail/:id', async (c) => {
  const id = c.req.param('id')
  const note = await noteService.getById(id)
  return c.json({ note })
})

// PUT /api/notes/:id
notes.put('/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json()
  const note = await noteService.update(id, body)
  return c.json({ note })
})

// DELETE /api/notes/:id
notes.delete('/:id', async (c) => {
  const id = c.req.param('id')
  await noteService.delete(id)
  return c.json({ message: 'Deleted' })
})

export default notes
