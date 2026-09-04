import { Hono } from 'hono'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { latexService } from '../services/latex.service.js'
import { AppError } from '../lib/errors.js'
import type { LatexEngine } from '@yarc/shared'

const latex = new Hono()
const ENGINES = new Set<LatexEngine>(['pdflatex', 'xelatex', 'lualatex'])
const safeHeaderFileName = (name: string) => name.replace(/[\r\n\"]/g, '_')

const parseEngine = (value: unknown): LatexEngine => {
  const engine = typeof value === 'string' ? value : 'xelatex'
  if (!ENGINES.has(engine as LatexEngine)) throw new AppError('LATEX_INVALID_ENGINE', 'Unsupported LaTeX engine', 400)
  return engine as LatexEngine
}

// POST /api/latex/builds
latex.post('/builds', async (c) => {
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
  const path = typeof body.path === 'string' ? body.path : ''
  if (!path) throw new AppError('MISSING_PATH', 'Path is required', 400)

  const build = await latexService.startBuild({ path, engine: parseEngine(body.engine) })
  return c.json({ build }, 202)
})

// GET /api/latex/builds/:id
latex.get('/builds/:id', async (c) => {
  return c.json({ build: latexService.getBuild(c.req.param('id')) })
})

// GET /api/latex/builds/:id/log
latex.get('/builds/:id/log', async (c) => {
  return c.json(latexService.getBuildLog(c.req.param('id')))
})

// POST /api/latex/builds/:id/cancel
latex.post('/builds/:id/cancel', async (c) => {
  return c.json({ build: await latexService.cancelBuild(c.req.param('id')) })
})

// GET /api/latex/builds/:id/artifact/synctex
latex.get('/builds/:id/artifact/synctex', async (c) => {
  const artifact = await latexService.getArtifact(c.req.param('id'), 'synctex')
  const fileStat = await stat(artifact.path)
  c.header('Content-Type', 'application/gzip')
  c.header('Content-Length', String(fileStat.size))
  c.header('Content-Disposition', `attachment; filename="${safeHeaderFileName(artifact.name)}"`)
  c.header('Cache-Control', 'private, no-store')
  return c.body(Readable.toWeb(createReadStream(artifact.path)) as any)
})

// GET/HEAD /api/latex/builds/:id/pdf
// Keep the same range and HEAD semantics as the paper PDF endpoint so the
// existing PDF viewers can consume a compiled artifact without buffering it.
latex.on(['GET', 'HEAD'], '/builds/:id/pdf', async (c) => {
  const artifact = await latexService.getArtifact(c.req.param('id'), 'pdf')
  const fileStat = await stat(artifact.path)
  const fileSize = fileStat.size
  const range = c.req.header('Range')
  const etag = `"latex-${c.req.param('id')}-${fileSize}"`

  c.header('Content-Type', 'application/pdf')
  c.header('Content-Disposition', `inline; filename="${safeHeaderFileName(artifact.name)}"`)
  c.header('Cache-Control', 'private, no-store')
  c.header('Accept-Ranges', 'bytes')
  c.header('ETag', etag)

  if (c.req.header('If-None-Match') === etag) return c.body(null, 304)

  if (range) {
    const match = range.match(/^bytes=(\d*)-(\d*)$/)
    if (!match) {
      c.header('Content-Range', `bytes */${fileSize}`)
      return c.body(null, 416 as any)
    }

    let start = match[1] ? parseInt(match[1], 10) : 0
    let end = match[2] ? parseInt(match[2], 10) : fileSize - 1
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
    c.header('Content-Length', String(end - start + 1))
    c.header('Content-Range', `bytes ${start}-${end}/${fileSize}`)
    if (c.req.method === 'HEAD') return c.body(null, 206 as any)
    return c.body(Readable.toWeb(createReadStream(artifact.path, { start, end })) as any, 206 as any)
  }

  c.header('Content-Length', String(fileSize))
  if (c.req.method === 'HEAD') return c.body(null)
  return c.body(Readable.toWeb(createReadStream(artifact.path)) as any)
})

// GET /api/latex/builds/:id/synctex
// Forward: ?direction=forward&file=main.tex&line=12&column=1
// Backward: ?direction=backward&page=1&x=100&y=200
latex.get('/builds/:id/synctex', async (c) => {
  const requestedDirection = c.req.query('direction') || 'forward'
  if (requestedDirection !== 'forward' && requestedDirection !== 'backward') {
    throw new AppError('LATEX_INVALID_DIRECTION', 'SyncTeX direction must be forward or backward', 400)
  }
  const direction = requestedDirection
  const query = {
    direction,
    file: c.req.query('file'),
    line: Number(c.req.query('line') || 1),
    column: Number(c.req.query('column') || 1),
    page: Number(c.req.query('page') || 1),
    x: Number(c.req.query('x')),
    y: Number(c.req.query('y')),
  } as const
  return c.json(await latexService.querySyncTex(c.req.param('id'), query))
})

export default latex
