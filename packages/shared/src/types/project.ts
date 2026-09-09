export type ProjectWorkspaceKind = 'global' | 'project'

export interface ProjectLatexTarget {
  id: string
  name: string
  entry: string
  sourceRoot: string
  engine: 'pdflatex' | 'xelatex' | 'lualatex'
}

export interface ProjectHistorySettings {
  enabled: boolean
  include: string[]
  exclude: string[]
  idleDebounceSeconds: number
  maxIntervalSeconds: number
  retentionDays: number
  maxStorageMb: number
}

export interface ProjectSettings {
  latex?: {
    defaultTarget?: string
    targets?: ProjectLatexTarget[]
  }
  history?: Partial<ProjectHistorySettings>
  [key: string]: unknown
}

export interface Project {
  id: string
  name: string
  directoryName: string
  description: string | null
  settings: ProjectSettings
  archivedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface ProjectSummary extends Project {
  git?: Pick<ProjectGitStatus, 'branch' | 'detached' | 'head' | 'dirty'>
}

export interface ProjectGitFileStatus {
  path: string
  originalPath?: string
  indexStatus: string
  worktreeStatus: string
}

export interface ProjectGitStatus {
  branch: string | null
  detached: boolean
  head: string | null
  dirty: boolean
  files: ProjectGitFileStatus[]
}

export interface ProjectGitCommit {
  hash: string
  shortHash: string
  author: string
  authorEmail?: string
  authoredAt: string
  subject: string
}

export interface ProjectGitBranch {
  name: string
  current: boolean
  head: string | null
}

export type ProjectHistoryKind =
  | 'baseline'
  | 'autosave'
  | 'external'
  | 'build'
  | 'manual'
  | 'pre-restore'
  | 'restore'

export interface ProjectHistoryRevision {
  id: string
  checkpointId: string
  projectId: string
  path: string
  contentHash: string
  blobHash: string | null
  size: number
  deleted: boolean
  createdAt: string
}

export interface ProjectHistoryCheckpoint {
  id: string
  sequence: number
  projectId: string
  kind: ProjectHistoryKind | string
  label: string | null
  pinned: boolean
  metadata: Record<string, unknown>
  createdAt: string
  revisions?: ProjectHistoryRevision[]
}

export interface ProjectFilesChangedEvent {
  type: 'project-files-changed'
  projectId: string
  action: string
  path?: string
  live?: boolean
  at: string
}

export type FileWorkspaceRef =
  | { kind: 'files' }
  | { kind: 'project'; projectId: string }

export type FileScope =
  | { kind: 'global' }
  | { kind: 'project'; projectId: string }

// Keep Conversation defined in the shared base types while extending it from
// the Project domain so existing imports continue to use one canonical type.
declare module './index.js' {
  interface Conversation {
    projectId: string | null
  }
}
