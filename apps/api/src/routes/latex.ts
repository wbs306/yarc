import { Hono } from 'hono'
import { registerLatexBuildRoutes } from './latex-builds.js'
import { latexService } from '../services/latex.service.js'
import { AppError } from '../lib/errors.js'
import type { LatexEngine } from '@yarc/shared'

const latex = new Hono()
const ENGINES = new Set<LatexEngine>(['pdflatex', 'xelatex', 'lualatex'])

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

registerLatexBuildRoutes(latex, '/builds', () => latexService)

export default latex
