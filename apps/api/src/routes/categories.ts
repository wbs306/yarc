import { Hono } from 'hono'
import { categoryService } from '../services/category.service.js'

const categories = new Hono()

// GET /api/categories
categories.get('/', async (c) => {
  const list = await categoryService.list()
  return c.json({ categories: list })
})

// POST /api/categories
categories.post('/', async (c) => {
  const body = await c.req.json()
  const cat = await categoryService.create(body)
  return c.json({ category: cat }, 201)
})

// PUT /api/categories/:id
categories.put('/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json()
  const cat = await categoryService.update(id, body)
  return c.json({ category: cat })
})

// DELETE /api/categories/:id
categories.delete('/:id', async (c) => {
  const id = c.req.param('id')
  await categoryService.delete(id)
  return c.json({ message: 'Deleted' })
})

// POST /api/categories/batch/delete
categories.post('/batch/delete', async (c) => {
  const body = await c.req.json()
  const { ids } = body
  if (!Array.isArray(ids) || ids.length === 0) {
    return c.json({ error: { code: 'INVALID_INPUT', message: 'ids array is required' } }, 400)
  }
  const result = await categoryService.deleteMany(ids)
  return c.json(result)
})

export default categories
