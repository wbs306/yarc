import { AppError } from './errors.js'
import { normalizeProjectHistorySettings } from './project-history-settings.js'
import { validateProjectLatexSettings } from './project-latex-settings.js'

// Validate at the persistence boundary, regardless of which HTTP endpoint was
// used. This is configuration only: no file writes, History or Git operations.
export const normalizeProjectSettings = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError('VALIDATION_ERROR', 'Project settings must be an object', 400)
  }
  const input = value as Record<string, unknown>
  const settings = { ...input }
  if (Object.hasOwn(input, 'history')) {
    settings.history = normalizeProjectHistorySettings(input.history)
  }
  if (Object.hasOwn(input, 'latex')) {
    if (!input.latex || typeof input.latex !== 'object' || Array.isArray(input.latex)) {
      throw new AppError('VALIDATION_ERROR', 'LaTeX settings must be an object', 400)
    }
    settings.latex = validateProjectLatexSettings(input.latex as Record<string, unknown>)
  }
  return settings
}
