import { Hono } from 'hono'
import { prisma } from '@yarc/db'
import type { ReparseAction } from '@yarc/shared'
import { config } from '../lib/config.js'
import { paperService } from '../services/paper.service.js'
import { importJobService } from '../services/import-job.service.js'

const papers = new Hono()

// GET /api/papers
papers.get('/', async (c) => {
  const categoryId = c.req.query('category')
  const query = c.req.query('q')
  const field = c.req.query('field')
  const page = parseInt(c.req.query('page') || '1')
  const limit = parseInt(c.req.query('limit') || '50')

  const result = await paperService.list({ categoryId, query, field, page, limit })
  return c.json(result)
})

// GET /api/papers/search
papers.get('/search', async (c) => {
  const query = c.req.query('q')
  if (!query) return c.json({ error: { code: 'MISSING_QUERY', message: 'Query is required' } }, 400)

  const limit = parseInt(c.req.query('limit') || '20')
  const threshold = parseFloat(c.req.query('threshold') || '0.5')
  const paperId = c.req.query('paperId') || undefined

  try {
    // Generate embedding for query
    const { embeddingService } = await import('../services/embedding.service.js')
    const embedding = await embeddingService.generate(query)
    const { searchService } = await import('../services/search.service.js')
    const results = await searchService.searchLocal(query, embedding, limit, threshold, paperId)
    return c.json({ results })
  } catch (err) {
    return c.json({ results: [], error: (err as Error).message })
  }
})

// POST /api/papers
papers.post('/', async (c) => {
  const body = await c.req.json()
  const paper = await paperService.create(body)
  return c.json({ paper }, 201)
})

// POST /api/papers/upload — single or batch
papers.post('/upload', async (c) => {
  const formData = await c.req.formData()

  // Accept 'files' (batch) or 'file' (single)
  const batchFiles = formData
    .getAll('files')
    .filter((f): f is File => f instanceof File && f.size > 0)
  const singleFile = formData.get('file')
  const files = batchFiles.length
    ? batchFiles
    : singleFile instanceof File && singleFile.size > 0
      ? [singleFile]
      : []

  if (!files.length) {
    return c.json({ error: { code: 'MISSING_FILE', message: 'No file provided' } }, 400)
  }

  const titleValue = formData.get('title')
  const title = typeof titleValue === 'string' ? titleValue.trim() : undefined
  const categoryIdValue = formData.get('categoryId')
  const categoryId = typeof categoryIdValue === 'string' && categoryIdValue.trim()
    ? categoryIdValue.trim()
    : undefined

  const results: any[] = []
  const errors: { fileName: string; message: string }[] = []
  const singleUploadTitle = files.length === 1 ? title || undefined : undefined

  for (const file of files) {
    if (file.size > 50 * 1024 * 1024) {
      errors.push({ fileName: file.name, message: 'File exceeds 50MB limit' })
      continue
    }
    try {
      const paper = await paperService.upload(file, singleUploadTitle, categoryId)
      results.push(paper)
    } catch (err) {
      errors.push({ fileName: file.name, message: (err as Error).message })
    }
  }

  // Single file → backward-compatible shape
  if (files.length === 1 && !errors.length) {
    return c.json({ paper: results[0] }, 201)
  }

  return c.json({ papers: results, errors }, errors.length ? 207 : 201)
})

// POST /api/papers/import-from-search — enqueue server-side PDF import from external search results
papers.post('/import-from-search', async (c) => {
  const body = await c.req.json()
  const papersToImport = Array.isArray(body.papers) ? body.papers : []
  if (!papersToImport.length) {
    return c.json({ error: { code: 'INVALID_INPUT', message: 'papers array is required' } }, 400)
  }

  const job = importJobService.create({
    papers: papersToImport,
    categoryId: body.categoryId || undefined,
    requirePdf: body.requirePdf !== false,
    extractMetadata: body.extractMetadata === true,
  })

  return c.json({ job }, 202)
})

// GET /api/papers/import-jobs/:id — inspect an import job
papers.get('/import-jobs/:id', async (c) => {
  const job = importJobService.get(c.req.param('id'))
  if (!job) return c.json({ error: { code: 'NOT_FOUND', message: 'Import job not found' } }, 404)
  return c.json({ job })
})

// GET /api/papers/:id
papers.get('/:id', async (c) => {
  const id = c.req.param('id')
  const paper = await paperService.getById(id)
  return c.json({ paper })
})

// PUT /api/papers/:id
papers.put('/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json()
  const paper = await paperService.update(id, body)
  return c.json({ paper })
})

// DELETE /api/papers/:id
papers.delete('/:id', async (c) => {
  const id = c.req.param('id')
  await paperService.delete(id)
  return c.json({ message: 'Deleted' })
})

// POST /api/papers/batch/delete
papers.post('/batch/delete', async (c) => {
  const body = await c.req.json()
  const { ids } = body
  if (!Array.isArray(ids) || ids.length === 0) {
    return c.json({ error: { code: 'INVALID_INPUT', message: 'ids array is required' } }, 400)
  }
  const result = await paperService.deleteMany(ids)
  return c.json(result)
})

// POST /api/papers/batch/move
papers.post('/batch/move', async (c) => {
  const body = await c.req.json()
  const { ids, categoryId } = body
  if (!Array.isArray(ids) || ids.length === 0) {
    return c.json({ error: { code: 'INVALID_INPUT', message: 'ids array is required' } }, 400)
  }
  const result = await paperService.updateCategory(ids, categoryId || null)
  return c.json(result)
})

// POST /api/papers/batch/summarize
papers.post('/batch/summarize', async (c) => {
  const body = await c.req.json()
  const { ids } = body
  if (!Array.isArray(ids) || ids.length === 0) {
    return c.json({ error: { code: 'INVALID_INPUT', message: 'ids array is required' } }, 400)
  }

  const uniqueIds = Array.from(new Set(ids.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)))
  const errors: Array<{ id: string; message: string }> = []
  let enqueued = 0
  for (const id of uniqueIds) {
    try {
      await paperService.summarize(id)
      enqueued++
    } catch (err) {
      errors.push({ id, message: (err as Error).message })
    }
  }

  return c.json({ enqueued, errors }, errors.length ? 207 : 202)
})

// GET/HEAD /api/papers/:id/pdf
// EmbedPDF/PDFium may use HEAD and byte-range requests. Serve both full and partial
// responses so PDF loading works through Vite proxy and non-localhost hosts.
papers.on(['GET', 'HEAD'], '/:id/pdf', async (c) => {
  const id = c.req.param('id')
  const filePath = await paperService.getPdfPath(id)

  const { stat } = await import('node:fs/promises')
  const { createReadStream } = await import('node:fs')
  const { Readable } = await import('node:stream')
  const fileStat = await stat(filePath)
  const fileSize = fileStat.size
  const range = c.req.header('Range')

  c.header('Content-Type', 'application/pdf')
  c.header('Content-Disposition', `inline; filename="${id}.pdf"`)

  let cacheDays = config.pdfCacheDays
  try {
    const setting = await prisma.setting.findUnique({ where: { key: 'pdf_cache_days' } })
    if (setting) cacheDays = parseInt(setting.value as string) || cacheDays
  } catch {}
  c.header('Cache-Control', `public, max-age=${cacheDays * 86400}, immutable`)
  c.header('Accept-Ranges', 'bytes')
  c.header('ETag', `"${fileSize}-${id}"`)

  const ifNoneMatch = c.req.header('If-None-Match')
  if (ifNoneMatch === `"${fileSize}-${id}"`) {
    return c.body(null, 304)
  }

  if (range) {
    const match = range.match(/^bytes=(\d*)-(\d*)$/)
    if (!match) {
      c.header('Content-Range', `bytes */${fileSize}`)
      return c.body(null, 416 as any)
    }

    let start = match[1] ? parseInt(match[1], 10) : 0
    let end = match[2] ? parseInt(match[2], 10) : fileSize - 1

    // Suffix range: bytes=-500 means the last 500 bytes.
    if (!match[1] && match[2]) {
      const suffixLength = parseInt(match[2], 10)
      start = Math.max(fileSize - suffixLength, 0)
      end = fileSize - 1
    }

    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= fileSize) {
      c.header('Content-Range', `bytes */${fileSize}`)
      return c.body(null, 416 as any)
    }

    end = Math.min(end, fileSize - 1)
    const chunkSize = end - start + 1
    c.header('Content-Length', chunkSize.toString())
    c.header('Content-Range', `bytes ${start}-${end}/${fileSize}`)

    if (c.req.method === 'HEAD') return c.body(null, 206 as any)
    const stream = Readable.toWeb(createReadStream(filePath, { start, end })) as any
    return c.body(stream, 206 as any)
  }

  c.header('Content-Length', fileSize.toString())
  if (c.req.method === 'HEAD') return c.body(null)
  const stream = Readable.toWeb(createReadStream(filePath)) as any
  return c.body(stream)
})

// POST /api/papers/:id/summarize
papers.post('/:id/summarize', async (c) => {
  const id = c.req.param('id')
  await paperService.summarize(id)
  return c.json({ message: 'Summarize task enqueued' })
})

// POST /api/papers/:id/enrich
papers.post('/:id/enrich', async (c) => {
  const id = c.req.param('id')
  await paperService.enrich(id)
  return c.json({ message: 'Enrich task enqueued' })
})

// GET /api/papers/:id/reparse-info — lightweight status and metadata for the reparse action dialog
papers.get('/:id/reparse-info', async (c) => {
  const info = await paperService.getReparseInfo(c.req.param('id'))
  return c.json({ info })
})

// POST /api/papers/:id/reparse — enqueue selected independent reparse actions
papers.post('/:id/reparse', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => ({})) as { actions?: unknown }
  if (body.actions !== undefined && !Array.isArray(body.actions)) {
    return c.json({ error: { code: 'INVALID_REPARSE_ACTIONS', message: 'actions must be an array' } }, 400)
  }
  const actions = Array.isArray(body.actions)
    ? body.actions.filter((action): action is ReparseAction => action === 'mineru' || action === 'embedding' || action === 'metadata' || action === 'abstract')
    : undefined
  if (actions && actions.length !== body.actions!.length) {
    return c.json({ error: { code: 'INVALID_REPARSE_ACTIONS', message: 'actions may only contain mineru, embedding, metadata, or abstract' } }, 400)
  }
  await paperService.reparse(id, actions)
  return c.json({ message: 'Selected reparse actions enqueued', actions: actions || ['mineru', 'embedding', 'metadata', 'abstract'] })
})

export default papers
