import type { LatexEngine } from '@yarc/shared'
import { fileTabKey } from './workbench-tabs'

export const LATEX_PREVIEW_STORAGE_KEY = 'yarc_latex_preview_sessions_v1'
export const LATEX_PREVIEW_SESSION_LIMIT = 32

export interface LatexPreviewSession {
  projectId: string | null
  path: string
  entryPath: string
  buildId: string
  visible: boolean
  engine: LatexEngine
}

const validPath = (value: unknown): value is string => typeof value === 'string'
  && !!value && !value.startsWith('/') && !/[\\:\u0000-\u001f]/.test(value)
  && value.split('/').every(part => !!part && part !== '.' && part !== '..' && part !== '.git')

export function parseLatexPreviewSessions(raw: string | null): Map<string, LatexPreviewSession> {
  const sessions = new Map<string, LatexPreviewSession>()
  try {
    const values: unknown = raw ? JSON.parse(raw) : []
    if (!Array.isArray(values)) return sessions
    for (const value of values) {
      if (!value || typeof value !== 'object') continue
      const item = value as Record<string, unknown>
      if (!(item.projectId === null || (typeof item.projectId === 'string' && !!item.projectId))
        || !validPath(item.path) || !validPath(item.entryPath)
        || typeof item.buildId !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(item.buildId)
        || typeof item.visible !== 'boolean'
        || !['xelatex', 'pdflatex', 'lualatex'].includes(String(item.engine))) continue
      const session = item as unknown as LatexPreviewSession
      sessions.set(fileTabKey(session), session)
    }
  } catch { /* Invalid browser state must not prevent opening a source file. */ }
  return new Map([...sessions].slice(-LATEX_PREVIEW_SESSION_LIMIT))
}

export function rememberLatexPreviewSession(sessions: Map<string, LatexPreviewSession>, session: LatexPreviewSession) {
  const key = fileTabKey(session)
  sessions.delete(key)
  sessions.set(key, session)
  while (sessions.size > LATEX_PREVIEW_SESSION_LIMIT) sessions.delete(sessions.keys().next().value!)
}

export function serializeLatexPreviewSessions(sessions: Map<string, LatexPreviewSession>): string {
  return JSON.stringify([...sessions.values()].filter(session => session.buildId).slice(-LATEX_PREVIEW_SESSION_LIMIT))
}
