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

const IGNORED_PI_PREFIXES = [
  '.pi/agent/sessions',
  '.pi/agent/subagent-results',
]

const IGNORED_EXACT_PATHS = new Set([
  '.pi/agent/auth.json',
  '.pi/agent/models.json',
  '.pi/agent/run-history.jsonl',
  '.pi/agent/web-search.json',
])

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
  if (IGNORED_PI_PREFIXES.some(prefix => path === prefix || path.startsWith(`${prefix}/`))) return true

  const name = basename(path)
  if (name.endsWith('.lock')) return true
  if (name === '.env' || (name.startsWith('.env.') && name !== '.env.example')) return true
  if (name.startsWith('.yarc-webdav-') && name.endsWith('.tmp')) return true
  return false
}
