import { Hono } from 'hono'
import { searchService } from '../services/search.service.js'

const search = new Hono()

// GET /api/search
search.get('/', async (c) => {
  const source = c.req.query('source') || 'semantic_scholar'
  const publication = c.req.query('publication')
  const earlyAccess = c.req.query('early_access') === 'true'
  const query = c.req.query('q') || (source === 'ieee' && earlyAccess && publication ? publication : '')
  if (!query) {
    return c.json(
      { error: { code: 'MISSING_QUERY', message: 'Query is required' } },
      400
    )
  }

  const field = c.req.query('field') || 'all'
  const page = parseInt(c.req.query('page') || '1')
  const limit = parseInt(c.req.query('limit') || '20')
  const yearFrom = c.req.query('year_from')
    ? parseInt(c.req.query('year_from')!)
    : undefined
  const yearTo = c.req.query('year_to')
    ? parseInt(c.req.query('year_to')!)
    : undefined

  try {
    let results

    switch (source) {
      case 'local':
        // Hybrid local search combines metadata/keyword matching (title,
        // authors, abstract, full-text chunks) with pgvector semantic chunks.
        // This lets exact paper-title queries find the paper while still
        // returning a useful PDF snippet instead of an empty abstract.
        results = await searchService.searchLocalHybrid(
          query,
          field,
          limit,
          (page - 1) * limit
        )
        break

      case 'vector':
        // Explicit local semantic vector search alias.
        results = await searchService.searchLocalVector(query, limit)
        break

      case 'ieee':
        // IEEE Xplore official API when configured; otherwise bounded campus-IP crawler fallback.
        results = await searchService.searchIEEE(
          query,
          field,
          page,
          limit,
          yearFrom,
          yearTo,
          { earlyAccess, publication }
        )
        break

      case 'semantic_scholar':
      default:
        results = await searchService.searchSemanticScholar(
          query,
          field,
          page,
          limit,
          yearFrom,
          yearTo
        )
        break
    }

    return c.json(results)
  } catch (err) {
    return c.json(
      { error: { code: 'SEARCH_ERROR', message: (err as Error).message } },
      502
    )
  }
})

// GET /api/search/download-pdf
search.get('/download-pdf', async (c) => {
  const url = c.req.query('url')
  if (!url) {
    return c.json(
      { error: { code: 'MISSING_URL', message: 'URL is required' } },
      400
    )
  }

  try {
    const pdfBuffer = await searchService.downloadPdf(url)
    if (!pdfBuffer) {
      return c.json(
        {
          error: {
            code: 'DOWNLOAD_FAILED',
            message: 'Failed to download PDF',
          },
        },
        502
      )
    }

    return new Response(pdfBuffer, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'attachment; filename="paper.pdf"',
      },
    })
  } catch (err) {
    return c.json(
      { error: { code: 'DOWNLOAD_ERROR', message: (err as Error).message } },
      502
    )
  }
})

export default search
