import { Hono } from 'hono'
import { searchService } from '../services/search.service.js'
import type { PaperReferenceInput } from '@yarc/shared'

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

// POST /api/search/resolve — resolve Markdown paper references against local and external sources
search.post('/resolve', async (c) => {
  const body = await c.req.json().catch(() => null) as { references?: PaperReferenceInput[] } | null
  const references = body?.references
  if (!Array.isArray(references) || references.length === 0) {
    return c.json({ error: { code: 'INVALID_REFERENCES', message: 'references must be a non-empty array' } }, 400)
  }
  if (references.length > 20) {
    return c.json({ error: { code: 'TOO_MANY_REFERENCES', message: 'At most 20 references can be resolved at once' } }, 400)
  }

  const normalized = references.map(reference => ({
    key: typeof reference.key === 'string' ? reference.key.slice(0, 200) : undefined,
    title: typeof reference.title === 'string' ? reference.title.slice(0, 1000) : undefined,
    authors: Array.isArray(reference.authors) ? reference.authors.filter((author): author is string => typeof author === 'string').slice(0, 50) : undefined,
    year: typeof reference.year === 'number' && Number.isInteger(reference.year) ? reference.year : undefined,
    localPaperId: typeof reference.localPaperId === 'string' ? reference.localPaperId : undefined,
    doi: typeof reference.doi === 'string' ? reference.doi.slice(0, 500) : undefined,
    arxivId: typeof reference.arxivId === 'string' ? reference.arxivId.slice(0, 200) : undefined,
    semanticScholarId: typeof reference.semanticScholarId === 'string' ? reference.semanticScholarId.slice(0, 200) : undefined,
    ieeeArticleNumber: typeof reference.ieeeArticleNumber === 'string' ? reference.ieeeArticleNumber.slice(0, 100) : undefined,
    url: typeof reference.url === 'string' ? reference.url.slice(0, 2000) : undefined,
    rawText: typeof reference.rawText === 'string' ? reference.rawText.slice(0, 2000) : undefined,
  }))

  const results = await searchService.resolvePaperReferences(normalized)
  return c.json({ results })
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
