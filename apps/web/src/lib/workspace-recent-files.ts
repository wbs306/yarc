import type { FileNode } from '@yarc/shared'

export type WorkspaceRecentFile = FileNode & {
  projectId: string | null
  projectName: string | null
}

// Legacy entries do not identify their workspace and cannot be safely migrated.
export const WORKSPACE_RECENT_FILES_KEY = 'yarc_recent_workspace_files_v2'
export const WORKSPACE_RECENT_FILES_LIMIT = 8

export const workspaceFileKey = (file: Pick<WorkspaceRecentFile, 'projectId' | 'path'>) =>
  JSON.stringify([file.projectId, file.path])

export const parseRecentWorkspaceFiles = (raw: string | null): WorkspaceRecentFile[] => {
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : []
    if (!Array.isArray(parsed)) return []
    const files = new Map<string, WorkspaceRecentFile>()
    for (const item of parsed) {
      if (!item || typeof item !== 'object' || item.type !== 'file'
        || typeof item.path !== 'string' || !item.path
        || typeof item.name !== 'string'
        || !(item.projectId === null || (typeof item.projectId === 'string' && item.projectId.length > 0))
        || !(item.projectName === null || typeof item.projectName === 'string')) continue
      const key = workspaceFileKey(item)
      if (!files.has(key)) files.set(key, item as WorkspaceRecentFile)
    }
    return [...files.values()].slice(0, WORKSPACE_RECENT_FILES_LIMIT)
  } catch {
    return []
  }
}

export const rememberWorkspaceFile = (files: WorkspaceRecentFile[], file: WorkspaceRecentFile) =>
  [{ ...file, children: undefined }, ...files.filter(item => workspaceFileKey(item) !== workspaceFileKey(file))]
    .slice(0, WORKSPACE_RECENT_FILES_LIMIT)

export const removeRecentWorkspaceFiles = (files: WorkspaceRecentFile[], projectId: string | null, path: string) =>
  files.filter(file => file.projectId !== projectId || (file.path !== path && !file.path.startsWith(`${path}/`)))
