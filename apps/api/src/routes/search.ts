import { Hono } from 'hono'
import { searchService } from '../services/search.service.js'
import {
  IeeeXploreError,
  ieeeXploreService,
  readIeeeJournalBrowserPreferences,
} from '../services/ieee-xplore.service.js'
import { temporaryPdfService } from '../services/temporary-pdf.service.js'
import type { IeeeSearchMode, IeeeSearchSort, PaperReferenceInput } from '@yarc/shared'

const search = new Hono()

// GET /api/search
search.get('/', async (c) => {
  const source = c.req.query('source') || 'semantic_scholar'
  const legacyPublication = c.req.query('publication')?.trim().toLowerCase()
  const query = c.req.query('q') || ''
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

    if (source === 'ieee') {
      const rawMode = c.req.query('ieee_mode') || 'search'
      if (!['search', 'current_issue', 'early_access', 'article_abstract'].includes(rawMode)) {
        return c.json({ error: { code: 'INVALID_IEEE_MODE', message: 'ieee_mode must be search, current_issue, early_access, or article_abstract' } }, 400)
      }
      const mode = rawMode as IeeeSearchMode
      const journalId = c.req.query('journal_id')?.trim()
      const preferences = await readIeeeJournalBrowserPreferences()
      const journal = journalId
        ? preferences.journals.find(item => item.id === journalId)
        : legacyPublication
          ? preferences.journals.find(item =>
            item.id.toLowerCase() === legacyPublication ||
            item.publicationNumber === legacyPublication ||
            item.displayName.toLowerCase() === legacyPublication ||
            item.publicationTitle.toLowerCase() === legacyPublication
          )
          : undefined
      if (journalId && !journal) {
        return c.json({ error: { code: 'IEEE_JOURNAL_NOT_FOUND', message: 'Configured IEEE journal was not found' } }, 404)
      }
      if ((mode === 'current_issue' || mode === 'early_access') && !journalId) {
        return c.json({ error: { code: 'MISSING_JOURNAL_ID', message: 'journal_id is required for IEEE journal browsing' } }, 400)
      }
      const articleNumber = c.req.query('article_number')?.trim()
      if (mode === 'article_abstract' && !/^\d{4,20}$/.test(articleNumber || '')) {
        return c.json({ error: { code: 'INVALID_IEEE_ARTICLE_NUMBER', message: 'article_number must contain only digits' } }, 400)
      }
      if (mode === 'search' && !query.trim()) {
        return c.json({ error: { code: 'MISSING_QUERY', message: 'q is required for IEEE article search' } }, 400)
      }
      const rawSort = c.req.query('sort') || 'relevance'
      if (!['relevance', 'newest'].includes(rawSort)) {
        return c.json({ error: { code: 'INVALID_IEEE_SORT', message: 'sort must be relevance or newest' } }, 400)
      }
      if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 25) {
        return c.json({ error: { code: 'INVALID_PAGINATION', message: 'page must be positive and limit must be between 1 and 25' } }, 400)
      }
      // `q` is intentionally ignored in directory modes; the browser filters
      // the returned in-memory list without repeatedly querying IEEE.
      results = await ieeeXploreService.execute({
        mode,
        q: mode === 'search' ? query : undefined,
        journal,
        sort: rawSort as IeeeSearchSort,
        page,
        limit,
        refresh: c.req.query('refresh') === '1',
        articleNumber,
      })
      return c.json(results)
    }

    if (!query) {
      return c.json(
        { error: { code: 'MISSING_QUERY', message: 'Query is required' } },
        400
      )
    }

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
    if (err instanceof IeeeXploreError) {
      return c.json({ error: { code: err.code, message: err.message } }, err.status as any)
    }
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

// Temporary PDF parsing lifecycle. Parsing starts when the reader opens and
// produces a Markdown file inside the agent data workspace for @current.
search.post('/temporary-pdfs', async (c) => {
  const body = await c.req.json().catch(() => null) as { url?: string; title?: string } | null
  const url = body?.url?.trim()
  if (!url) {
    return c.json({ error: { code: 'MISSING_URL', message: 'URL is required' } }, 400)
  }

  const document = await temporaryPdfService.create(url, body?.title, { retryFailed: true })
  return c.json({ document }, 202)
})

search.get('/temporary-pdfs/:id', (c) => {
  const id = c.req.param('id')
  if (!/^[a-f0-9]{24}$/.test(id)) {
    return c.json({ error: { code: 'INVALID_TEMPORARY_PDF_ID', message: 'Invalid temporary PDF id' } }, 400)
  }
  const document = temporaryPdfService.get(id)
  if (!document) {
    return c.json({ error: { code: 'TEMPORARY_PDF_NOT_FOUND', message: 'Temporary PDF not found or expired' } }, 404)
  }
  return c.json({ document })
})

search.delete('/temporary-pdfs/:id', (c) => {
  const id = c.req.param('id')
  if (!/^[a-f0-9]{24}$/.test(id)) {
    return c.json({ error: { code: 'INVALID_TEMPORARY_PDF_ID', message: 'Invalid temporary PDF id' } }, 400)
  }
  const scheduled = temporaryPdfService.scheduleCleanup(id)
  if (!scheduled) {
    return c.json({ error: { code: 'TEMPORARY_PDF_NOT_FOUND', message: 'Temporary PDF not found or expired' } }, 404)
  }
  return c.json({ ok: true })
})

// GET/HEAD /api/search/pdf — stream a remote PDF for the temporary reader.
// The URL is validated by SearchService before every upstream request, and the
// response is deliberately not buffered or persisted in the library.
search.on(['GET', 'HEAD'], '/pdf', async (c) => {
  const url = c.req.query('url')
  if (!url) {
    return c.json({ error: { code: 'MISSING_URL', message: 'URL is required' } }, 400)
  }

  const range = c.req.header('Range')
  if (range && !/^bytes=\d*-\d*$/.test(range)) {
    return c.json({ error: { code: 'INVALID_RANGE', message: 'Range must use the bytes unit' } }, 416)
  }

  try {
    const method = c.req.method === 'HEAD' ? 'HEAD' : 'GET'
    const upstream = await searchService.fetchPdfStream(url, range, method)
    const headers = new Headers({
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'inline; filename="paper.pdf"',
      // A temporary reader must not turn a preview into a durable HTTP cache.
      'Cache-Control': 'private, no-store',
    })
    for (const name of ['accept-ranges', 'content-length', 'content-range', 'etag', 'last-modified']) {
      const value = upstream.headers.get(name)
      if (value) headers.set(name, value)
    }

    if (c.req.method === 'HEAD') {
      try { await upstream.body?.cancel() } catch {}
      return new Response(null, { status: upstream.status, headers })
    }
    return new Response(upstream.body, { status: upstream.status, headers })
  } catch (err) {
    return c.json(
      { error: { code: 'PDF_STREAM_FAILED', message: (err as Error).message || 'Failed to stream PDF' } },
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
