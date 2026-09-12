import type { Context, Hono } from 'hono'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import type { LatexService } from '../services/latex.service.js'
import { AppError } from '../lib/errors.js'

type BuildAccess = Pick<LatexService, 'getBuild' | 'getBuildLog' | 'cancelBuild' | 'getArtifact' | 'querySyncTex'>
const safeHeaderFileName = (name: string) => name.replace(/[\r\n\"]/g, '_')

// Share HTTP contracts (including Range/HEAD) across Global Files and Projects.
export const registerLatexBuildRoutes = (app: Hono, base: string, service: (c: Context) => BuildAccess) => {
  // GET /api/latex/builds/:id
  app.get(`${base}/:buildId`, async (c) => {
    return c.json({ build: service(c).getBuild(c.req.param('buildId')) })
  })

  // GET /api/latex/builds/:id/log
  app.get(`${base}/:buildId/log`, async (c) => {
    return c.json(service(c).getBuildLog(c.req.param('buildId')))
  })

  // POST /api/latex/builds/:id/cancel
  app.post(`${base}/:buildId/cancel`, async (c) => {
    return c.json({ build: await service(c).cancelBuild(c.req.param('buildId')) })
  })

  // GET /api/latex/builds/:id/artifact/synctex
  app.get(`${base}/:buildId/artifact/synctex`, async (c) => {
    const artifact = await service(c).getArtifact(c.req.param('buildId'), 'synctex')
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
  app.on(['GET', 'HEAD'], `${base}/:buildId/pdf`, async (c) => {
    const artifact = await service(c).getArtifact(c.req.param('buildId'), 'pdf')
    const fileStat = await stat(artifact.path)
    const fileSize = fileStat.size
    const range = c.req.header('Range')
    const etag = `"latex-${c.req.param('buildId')}-${fileSize}"`

    c.header('Content-Type', 'application/pdf')
    c.header('Content-Disposition', `inline; filename="${safeHeaderFileName(artifact.name)}"`)
    c.header('Cache-Control', 'private, no-store')
    c.header('Accept-Ranges', 'bytes')
    c.header('ETag', etag)

    if (c.req.header('If-None-Match') === etag) return c.body(null, 304)

    if (range) {
      const match = range.match(/^bytes=(\d*)-(\d*)$/)
      if (!match || (!match[1] && !match[2])) {
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
  app.get(`${base}/:buildId/synctex`, async (c) => {
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
    return c.json(await service(c).querySyncTex(c.req.param('buildId'), query))
  })

}
