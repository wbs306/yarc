import { workspaceFileKey, type WorkspaceRecentFile } from './workspace-recent-files'

export type WorkbenchTabKind = 'library' | 'paper' | 'file'
export type WorkbenchTabStatus = 'dirty' | 'conflict'

export interface WorkbenchTab {
  key: string
  kind: WorkbenchTabKind
  title: string
  tooltip: string
  active: boolean
  /** One character shown instead of the file icon: the owning project. */
  badge?: string
  /** Directory of a file whose name is shared by another tab of its workspace. */
  hint?: string
  status?: WorkbenchTabStatus
  statusTitle?: string
}

type TabFile = Pick<WorkspaceRecentFile, 'projectId' | 'path' | 'name'>

export const LIBRARY_TAB_KEY = 'library'
export const paperTabKey = (paperId: string) => `paper:${paperId}`
// Same paths in different workspaces are different tabs.
export const fileTabKey = (file: Pick<WorkspaceRecentFile, 'projectId' | 'path'>) => `file:${workspaceFileKey(file)}`

export const parseTabOrder = (raw: string | null): string[] => {
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === 'string') : []
  } catch {
    return []
  }
}

/**
 * Keeps tabs where they are while the underlying list is reordered by recency:
 * surviving tabs keep their position and new ones are appended. Returns
 * `previous` itself when nothing changed.
 */
export const stableTabOrder = (previous: string[], current: string[]) => {
  const open = new Set(current)
  const kept = previous.filter(key => open.has(key))
  const known = new Set(kept)
  const next = [...kept, ...current.filter(key => !known.has(key))]
  return next.length === previous.length && next.every((key, index) => key === previous[index]) ? previous : next
}

export const rememberActiveTab = (history: string[], key: string, limit = 32) =>
  [...history.filter(item => item !== key), key].slice(-limit)

/**
 * The tab to show after closing the active one: the most recently used tab
 * that is still open, else a neighbour (right, then left) among
 * `fallbackKeys`. Both lists are in strip order and still contain
 * `closingKey`; `fallbackKeys` can leave out tabs that should only be reached
 * deliberately, such as files of another workspace.
 */
export const pickTabAfterClose = (
  history: string[],
  openKeys: string[],
  closingKey: string,
  fallbackKeys: string[] = openKeys,
) => {
  const open = new Set(openKeys)
  open.delete(closingKey)
  for (let index = history.length - 1; index >= 0; index--) {
    const key = history[index]
    if (key !== undefined && open.has(key)) return key
  }
  const position = fallbackKeys.indexOf(closingKey)
  if (position < 0) return null
  return fallbackKeys[position + 1] ?? fallbackKeys[position - 1] ?? null
}

const parentDirectory = (path: string) => path.split('/').slice(0, -1).join('/')

/** First character of a project name, shown as a fixed-width tab badge. */
export const projectBadge = (name: string) => (Array.from(name.trim())[0] || '?').toUpperCase()

/**
 * Directory hints for tabs that share a file name within one workspace. They
 * depend only on the open files, never on the workspace being viewed, so tab
 * widths do not change when switching between workspaces.
 */
export const fileTabHints = (files: TabFile[]) => {
  const hints = new Map<string, string>()
  for (const file of files) {
    const directory = parentDirectory(file.path)
    // A file in the workspace root needs no directory: its twin shows one.
    if (!directory) continue
    if (files.some(item => item !== file && item.name === file.name && item.projectId === file.projectId)) {
      hints.set(fileTabKey(file), directory)
    }
  }
  return hints
}
