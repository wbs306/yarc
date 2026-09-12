import { extname } from 'node:path'
import type { ProjectLatexTarget } from '@yarc/shared'
import { AppError } from './errors.js'
import { normalizeProjectRelativePath } from './project-path.js'

const LATEX_ENGINES = new Set<ProjectLatexTarget['engine']>(['pdflatex', 'xelatex', 'lualatex'])
const TARGET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export function validateProjectLatexSettings(input: { defaultTarget?: unknown; targets?: unknown }) {
  if (!Array.isArray(input.targets)) throw new AppError('VALIDATION_ERROR', 'LaTeX targets must be an array', 400)
  if (input.targets.length > 50) throw new AppError('VALIDATION_ERROR', 'Too many LaTeX targets', 400)

  const ids = new Set<string>()
  const targets = input.targets.map((raw, index): ProjectLatexTarget => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AppError('VALIDATION_ERROR', `Invalid LaTeX target at index ${index}`, 400)
    const value = raw as Record<string, unknown>
    const id = typeof value.id === 'string' ? value.id.trim() : ''
    const name = typeof value.name === 'string' ? value.name.trim() : ''
    const engine = typeof value.engine === 'string' ? value.engine.trim() : ''
    const rawEntry = typeof value.entry === 'string' ? value.entry.trim() : ''
    const rawSourceRoot = typeof value.sourceRoot === 'string' ? value.sourceRoot.trim() : '.'

    if (!TARGET_ID_PATTERN.test(id)) throw new AppError('VALIDATION_ERROR', `Invalid LaTeX target id at index ${index}`, 400)
    if (ids.has(id)) throw new AppError('VALIDATION_ERROR', `Duplicate LaTeX target id: ${id}`, 400)
    ids.add(id)
    if (!name || name.length > 120) throw new AppError('VALIDATION_ERROR', `Invalid LaTeX target name: ${id}`, 400)
    if (!LATEX_ENGINES.has(engine as ProjectLatexTarget['engine'])) throw new AppError('VALIDATION_ERROR', `Unsupported LaTeX engine for target ${id}`, 400)

    const sourceRootNormalized = normalizeProjectRelativePath(rawSourceRoot || '.')
    const entry = normalizeProjectRelativePath(rawEntry)
    if (!entry || extname(entry).toLowerCase() !== '.tex') throw new AppError('INVALID_LATEX_ENTRY', `LaTeX entry for target ${id} must be a .tex file`, 400)
    if (sourceRootNormalized && !entry.startsWith(`${sourceRootNormalized}/`)) {
      throw new AppError('INVALID_LATEX_ENTRY', `LaTeX entry for target ${id} must be inside sourceRoot`, 400)
    }

    return {
      id,
      name,
      entry,
      sourceRoot: sourceRootNormalized || '.',
      engine: engine as ProjectLatexTarget['engine'],
    }
  })

  const requestedDefault = typeof input.defaultTarget === 'string' ? input.defaultTarget.trim() : ''
  if (requestedDefault && !ids.has(requestedDefault)) throw new AppError('VALIDATION_ERROR', 'defaultTarget must reference a configured LaTeX target', 400)
  return { defaultTarget: requestedDefault || targets[0]?.id || null, targets }
}

