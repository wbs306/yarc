import { Hono } from 'hono'
import { noteService } from '../services/note.service.js'

const notes = new Hono()

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
