import { Hono } from 'hono'
import { rankingService } from '../services/ranking.service.js'
import { cache } from '../lib/cache.js'

const rankings = new Hono()

// GET /api/rankings/all — full mapping table (built-in + custom)
rankings.get('/all', async (c) => {
  try {
    const entries = await rankingService.getAllEntries()
    return c.json({ entries })
  } catch (err) {
    return c.json({ error: { code: 'RANKING_ERROR', message: (err as Error).message } }, 500)
  }
})

// GET /api/rankings/custom — user-defined mappings only
rankings.get('/custom', async (c) => {
  try {
    return c.json({ entries: await rankingService.getCustom() })
  } catch (err) {
    return c.json({ error: { code: 'RANKING_ERROR', message: (err as Error).message } }, 500)
  }
})

// PUT /api/rankings/custom — replace the user-defined mappings
rankings.put('/custom', async (c) => {
  try {
    const body = await c.req.json()
    const list = Array.isArray(body?.entries) ? body.entries : []
    const entries = await rankingService.setCustom(list)
    cache.invalidatePrefix('papers:list')
    return c.json({ entries })
  } catch (err) {
    return c.json({ error: { code: 'RANKING_ERROR', message: (err as Error).message } }, 500)
  }
})

// GET /api/rankings/search?q=xxx
rankings.get('/search', async (c) => {
  const query = c.req.query('q')
  if (!query) {
    return c.json({ error: { code: 'MISSING_QUERY', message: 'Query is required' } }, 400)
  }

  const limit = parseInt(c.req.query('limit') || '10')

  try {
    const results = rankingService.searchJournals(query, limit)
    return c.json({ results })
  } catch (err) {
    return c.json({ error: { code: 'SEARCH_ERROR', message: (err as Error).message } }, 500)
  }
})

// GET /api/rankings/:name
rankings.get('/:name', async (c) => {
  const name = c.req.param('name')
  if (!name) {
    return c.json({ error: { code: 'MISSING_NAME', message: 'Journal/conference name is required' } }, 400)
  }

  try {
    const result = await rankingService.getRankingsWithCustom(name)
    return c.json(result)
  } catch (err) {
    return c.json({ error: { code: 'RANKING_ERROR', message: (err as Error).message } }, 500)
  }
})

export default rankings
