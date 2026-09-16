import { isAbsolute } from 'node:path'
import { AppError } from '../lib/errors.js'

const PROTECTED_ROOTS = new Set(['papers', 'projects', '.pi', '.project-history'])

const isCrossPlatformAbsolute = (value: string) => isAbsolute(value)
  || /^[A-Za-z]:[\\/]/.test(value)
  || value.startsWith('\\\\')
  || value.startsWith('//')

export const normalizePublicSharedFilePath = (value: string) => {
  const raw = value.trim()
  if (!raw || raw.includes('\0') || isCrossPlatformAbsolute(raw)) {
    throw new AppError('FORBIDDEN', 'Only relative public shared file paths are allowed', 403)
  }

  const normalized = raw.replace(/\\/g, '/')
  const segments = normalized.split('/')
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
    throw new AppError('FORBIDDEN', 'Path traversal is not allowed', 403)
  }

  const relativePath = segments.join('/')
  const root = segments[0]
  if (PROTECTED_ROOTS.has(root)) {
    throw new AppError('FORBIDDEN', 'This data area is not available through project @file references', 403)
  }

  if (segments.some(segment => segment.startsWith('.') && segment !== '.env.example')) {
    throw new AppError('FORBIDDEN', 'Hidden and sensitive files are not available through project @file references', 403)
  }

  return relativePath
}

export const resolvePublicSharedFileReference = (projectRelativePath: string) => {
  const normalized = projectRelativePath.trim().replace(/\\/g, '/')
  if (!normalized.startsWith('../../')) return null
  return normalizePublicSharedFilePath(normalized.slice('../../'.length))
}
