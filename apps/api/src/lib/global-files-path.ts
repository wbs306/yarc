import { lstat } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import { AppError } from './errors.js'
import { config } from './config.js'

export const isProjectStoragePath = (path: string) => {
  const first = path.replace(/\\/g, '/').replace(/^\/+/, '').split('/')[0]
  return first === 'projects' || first === '.project-history'
}

// Global Files never follows links, including links on an existing ancestor of
// a new file. This keeps REST and global LiveFile out of Project storage.
// Like the Project resolver, this is not a sandbox against concurrent OS writes.
export async function assertGlobalFilesPathSafe(rootDir: string, fullPath: string) {
  const root = resolve(rootDir)
  const target = resolve(fullPath)
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new AppError('FORBIDDEN', 'Access denied', 403)
  }
  const rel = relative(root, target)
  const protectedRoots = [config.projectsDir, config.projectHistoryDir].map(path => resolve(path))
  if (isProjectStoragePath(rel) || protectedRoots.some(path => target === path || target.startsWith(`${path}${sep}`))) {
    throw new AppError('PROTECTED_PATH', 'This path is protected', 403)
  }
  let current = root
  for (const segment of rel ? ['', ...rel.split(sep)] : ['']) {
    current = resolve(current, segment)
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink()) throw new AppError('FORBIDDEN', 'Global Files does not follow symlinks', 403)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
  }
}
