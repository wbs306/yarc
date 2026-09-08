import { lstat, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, resolve, sep } from 'node:path'
import { prisma } from '@yarc/db'
import { config } from './config.js'
import { AppError } from './errors.js'

const normalize = (value = '') => value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
const isInside = (root: string, target: string) => target === root || target.startsWith(`${root}${sep}`)

export const validateProjectDirectoryName = (value: string) => {
  const name = value.trim()
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(name)) {
    throw new AppError('PROJECT_INVALID_DIRECTORY', 'Project directoryName must contain lowercase letters, digits, and hyphens only', 400)
  }
  return name
}

export const normalizeProjectRelativePath = (value = '') => {
  if (value.includes('\0') || isAbsolute(value)) throw new AppError('PROJECT_INVALID_DIRECTORY', 'Invalid project path', 400)
  const normalized = normalize(value)
  if (!normalized || normalized === '.') return ''
  const segments = normalized.split('/')
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
    throw new AppError('PROJECT_INVALID_DIRECTORY', 'Project path traversal is not allowed', 400)
  }
  if (segments[0] === '.git') throw new AppError('PROTECTED_PATH', '.git is managed only through Project Git', 403)
  return normalized
}

export const resolveProjectRootByDirectoryName = (directoryName: string) => {
  const projectsDir = resolve(config.projectsDir)
  const root = resolve(projectsDir, validateProjectDirectoryName(directoryName))
  if (dirname(root) !== projectsDir) throw new AppError('PROJECT_INVALID_DIRECTORY', 'Invalid project directory', 400)
  return root
}

export const resolveProjectRoot = async (projectId: string, requireExists = true) => {
  const project = await prisma.project.findUnique({ where: { id: projectId } })
  if (!project) throw new AppError('PROJECT_NOT_FOUND', 'Project not found', 404)
  const root = resolveProjectRootByDirectoryName(project.directoryName)
  if (!requireExists) return { project, root }
  try {
    const info = await lstat(root)
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('unsafe')
    const actual = await realpath(root)
    if (actual !== root) throw new Error('unsafe')
  } catch {
    throw new AppError('PROJECT_WORKSPACE_MISSING', 'Project workspace is missing or unsafe', 409)
  }
  return { project, root }
}

export const resolveProjectPath = async (projectId: string, relativePath = '', options: { allowMissing?: boolean } = {}) => {
  const { project, root } = await resolveProjectRoot(projectId)
  const relative = normalizeProjectRelativePath(relativePath)
  const target = relative ? resolve(root, ...relative.split('/')) : root
  if (!isInside(root, target)) throw new AppError('PROJECT_INVALID_DIRECTORY', 'Path escapes project root', 400)

  let current = root
  for (const segment of relative ? relative.split('/') : []) {
    current = resolve(current, segment)
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink()) throw new AppError('PROJECT_INVALID_DIRECTORY', 'Project File API does not follow symlinks', 400)
      const actual = await realpath(current)
      if (!isInside(root, actual)) throw new AppError('PROJECT_INVALID_DIRECTORY', 'Path escapes project root', 400)
    } catch (error: any) {
      if (error instanceof AppError) throw error
      if (error?.code === 'ENOENT' && options.allowMissing) break
      if (error?.code === 'ENOENT') throw new AppError('NOT_FOUND', 'Project path not found', 404)
      throw error
    }
  }
  return { project, root, relativePath: relative, fullPath: target }
}
