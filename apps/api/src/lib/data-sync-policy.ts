import { basename } from 'node:path'

const IGNORED_SEGMENT_NAMES = new Set([
  'node_modules',
  '.git',
  '.venv',
  'venv',
  '__pycache__',
  '.cache',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
])

const IGNORED_GENERATED_PREFIXES = [
  '.latex-builds',
  '.project-history',
  '.yarc/latex-builds',
  'generated/latex',
] as const
const IGNORED_PI_PREFIXES = [
  '.pi/agent/sessions',
  '.pi/agent/subagent-results',
  '.pi/agent/runtime-streams',
]

const IGNORED_EXACT_PATHS = new Set([
  '.pi/agent/auth.json',
  '.pi/agent/models.json',
  '.pi/agent/run-history.jsonl',
  '.pi/agent/web-search.json',
])

const PI_RUNTIME_EXACT_PATHS = new Set([
  'AGENTS.md',
  '.pi/AGENTS.md',
  '.pi/CLAUDE.md',
  '.pi/SYSTEM.md',
  '.pi/APPEND_SYSTEM.md',
  '.pi/agent/AGENTS.md',
  '.pi/agent/CLAUDE.md',
  '.pi/agent/SYSTEM.md',
  '.pi/agent/APPEND_SYSTEM.md',
  '.pi/agent/settings.json',
  '.pi/agent/keybindings.json',
  '.pi/agent/npm/package.json',
])

const PI_RUNTIME_PATH_PREFIXES = [
  '.pi/skills/',
  '.pi/prompts/',
  '.pi/themes/',
  '.pi/extensions/',
  '.pi/agent/skills/',
  '.pi/agent/prompts/',
  '.pi/agent/themes/',
  '.pi/agent/extensions/',
  '.pi/agent/git/',
] as const

export const PROJECT_PI_RUNTIME_EXACT_PATHS = new Set([
  'AGENTS.md',
  '.pi/AGENTS.md',
  '.pi/CLAUDE.md',
  '.pi/SYSTEM.md',
  '.pi/APPEND_SYSTEM.md',
  '.pi/settings.json',
])

export const PROJECT_PI_RUNTIME_PATH_PREFIXES = [
  '.pi/prompts/',
  '.pi/themes/',
  '.pi/extensions/',
  '.agents/skills/',
] as const

export const DEFAULT_DATA_SYNC_EXCLUDE_PATTERNS = [
  'node_modules',
  '.git',
  '.venv',
  'venv',
  '__pycache__',
  '.cache',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.pi/agent/sessions',
  '.pi/agent/subagent-results',
  '.pi/agent/runtime-streams',
  '.project-history',
  '.latex-builds',
  '.yarc/latex-builds',
  'generated/latex',
  '.pi/agent/auth.json',
  '.pi/agent/models.json',
  '.pi/agent/run-history.jsonl',
  '.pi/agent/web-search.json',
  '*.lock',
  '.env / .env.*',
] as const

export const normalizeDataRelativePath = (value = '') => value
  .replace(/\\/g, '/')
  .replace(/^\/+|\/+$/g, '')
  .split('/')
  .filter(part => part && part !== '.')
  .join('/')

export const isDefaultIgnoredDataPath = (value: string) => {
  const path = normalizeDataRelativePath(value)
  if (!path) return false
  const segments = path.split('/')
  if (segments.some(segment => IGNORED_SEGMENT_NAMES.has(segment))) return true
  if (IGNORED_EXACT_PATHS.has(path)) return true
  if (IGNORED_GENERATED_PREFIXES.some(prefix => path === prefix || path.startsWith(`${prefix}/`))) return true
  if (IGNORED_PI_PREFIXES.some(prefix => path === prefix || path.startsWith(`${prefix}/`))) return true

  const name = basename(path)
  if (name.endsWith('.lock')) return true
  if (name === '.env' || (name.startsWith('.env.') && name !== '.env.example')) return true
  if (name.startsWith('.yarc-webdav-') && name.endsWith('.tmp')) return true
  return false
}

export const isPiRuntimeResourcePath = (value: string) => {
  const path = normalizeDataRelativePath(value)
  if (!path) return false
  if (PI_RUNTIME_EXACT_PATHS.has(path)) return true
  return PI_RUNTIME_PATH_PREFIXES.some(prefix => path.startsWith(prefix))
}

export const isProjectPiRuntimeResourcePath = (value: string) => {
  const path = normalizeDataRelativePath(value)
  if (!path) return false
  if (PROJECT_PI_RUNTIME_EXACT_PATHS.has(path)) return true
  return PROJECT_PI_RUNTIME_PATH_PREFIXES.some(prefix => path.startsWith(prefix))
}
