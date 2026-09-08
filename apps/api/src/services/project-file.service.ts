import { createReadStream } from 'node:fs'
import { lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname } from 'node:path'
import { sseHub } from '../lib/sse.js'
import { AppError } from '../lib/errors.js'
import { normalizeProjectRelativePath, resolveProjectPath, resolveProjectRoot } from '../lib/project-path.js'
import { projectHistoryService } from './project-history.service.js'
import { projectLiveFileManager } from './project-live-file.service.js'

export interface ProjectFileNode {
  name: string
  path: string
  type: 'file' | 'directory'
  size?: number
  modifiedAt?: string
  children?: ProjectFileNode[]
}

const HIDDEN_NAMES = new Set(['.git'])
const TEXT_EXTENSIONS = new Set([
  '.tex', '.bib', '.sty', '.cls', '.bst', '.txt', '.md', '.json', '.jsonl', '.yaml', '.yml', '.toml', '.ini', '.cfg',
  '.py', '.r', '.jl', '.m', '.c', '.h', '.cc', '.cpp', '.hpp', '.ts', '.tsx', '.js', '.jsx', '.vue', '.css', '.scss', '.html', '.sh', '.zsh', '.fish', '.sql', '.csv', '.tsv',
])
const TEXT_FILE_NAMES = new Set(['.gitignore', '.gitattributes', 'Dockerfile', 'Makefile'])
const MIME: Record<string, string> = {
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.tex': 'text/x-tex; charset=utf-8', '.bib': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
}

const isSensitiveProjectPath = (path: string) => {
  const relative = normalizeProjectRelativePath(path)
  if (!relative) return false
  const segments = relative.split('/')
  const name = segments[segments.length - 1] || ''
  if (name !== '.env.example' && (name === '.env' || name.startsWith('.env.'))) return true
  if (relative === '.pi/agent/auth.json' || relative.startsWith('.pi/agent/auth.json/')) return true
  if (relative === '.pi/agent/models.json' || relative.startsWith('.pi/agent/models.json/')) return true
  return relative.endsWith('.lock') || relative.includes('.lock/')
}

const assertProjectExposedPath = (path = '') => {
  const relative = normalizeProjectRelativePath(path)
  if (isSensitiveProjectPath(relative)) throw new AppError('FORBIDDEN', 'Access denied', 403)
  return relative
}

const isEditableText = (path: string, size: number) =>
  (TEXT_EXTENSIONS.has(extname(path).toLowerCase()) || TEXT_FILE_NAMES.has(basename(path))) && size <= 2 * 1024 * 1024

export class ProjectFileService {
  private emit(projectId: string, action: string, path?: string, live = false) {
    sseHub.emit({ type: 'project-files-changed', projectId, action, path, live, at: new Date().toISOString() })
  }

  async getFileTree(projectId: string, path = ''): Promise<ProjectFileNode[]> {
    const relativePath = assertProjectExposedPath(path)
    const resolved = await resolveProjectPath(projectId, relativePath)
    const info = await lstat(resolved.fullPath)
    if (info.isSymbolicLink()) throw new AppError('PROJECT_INVALID_DIRECTORY', 'Symlinks are not exposed by Project File API', 400)
    if (info.isFile()) return [await this.node(projectId, resolved.relativePath, resolved.fullPath, info)]
    if (!info.isDirectory()) return []
    const entries = await readdir(resolved.fullPath, { withFileTypes: true })
    const nodes: ProjectFileNode[] = []
    for (const entry of entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))) {
      if (HIDDEN_NAMES.has(entry.name)) continue
      const relative = normalizeProjectRelativePath([resolved.relativePath, entry.name].filter(Boolean).join('/'))
      if (isSensitiveProjectPath(relative)) continue
      try {
        const child = await resolveProjectPath(projectId, relative)
        const childInfo = await lstat(child.fullPath)
        if (childInfo.isSymbolicLink()) continue
        nodes.push(await this.node(projectId, relative, child.fullPath, childInfo))
      } catch {
        // A broken/unsafe symlink must not break the whole tree.
      }
    }
    return nodes
  }

  private async node(projectId: string, relativePath: string, fullPath: string, info: Awaited<ReturnType<typeof lstat>>): Promise<ProjectFileNode> {
    const base: ProjectFileNode = {
      name: basename(relativePath || fullPath),
      path: relativePath,
      type: info.isDirectory() ? 'directory' : 'file',
      modifiedAt: info.mtime.toISOString(),
      ...(info.isFile() ? { size: info.size } : {}),
    }
    if (info.isDirectory()) base.children = await this.getFileTree(projectId, relativePath)
    return base
  }

  async getFileContent(projectId: string, path: string) {
    const relativePath = assertProjectExposedPath(path)
    const resolved = await resolveProjectPath(projectId, relativePath)
    const info = await lstat(resolved.fullPath)
    if (!info.isFile()) throw new AppError('NOT_FILE', 'Path is not a file', 400)
    if (!isEditableText(resolved.relativePath, info.size)) {
      throw new AppError('UNSUPPORTED_FILE', 'Only supported text files up to 2MB are editable', 400)
    }
    const live = await projectLiveFileManager.get(projectId)
    const content = live.hasSession(resolved.relativePath)
      ? (await live.readAgentFile(resolved.fullPath)).toString('utf-8')
      : await readFile(resolved.fullPath, 'utf-8')
    return { path: resolved.relativePath, content, size: Buffer.byteLength(content, 'utf-8'), modifiedAt: info.mtime.toISOString() }
  }

  async saveFileContent(projectId: string, path: string, content: string) {
    const relativePath = assertProjectExposedPath(path)
    const resolved = await resolveProjectPath(projectId, relativePath)
    const info = await lstat(resolved.fullPath)
    if (!info.isFile()) throw new AppError('NOT_FILE', 'Path is not a file', 400)
    if (!isEditableText(resolved.relativePath, Buffer.byteLength(content, 'utf-8'))) {
      throw new AppError('UNSUPPORTED_FILE', 'Only supported text files up to 2MB are editable', 400)
    }
    await projectHistoryService.ensureBaseline(projectId, resolved.relativePath)

    const live = await projectLiveFileManager.get(projectId)
    if (live.hasSession(resolved.relativePath)) {
      await live.replaceContent(resolved.relativePath, content, 'api')
      const result = await live.flush(resolved.relativePath)
      if (result?.conflict) throw new AppError('PROJECT_FILE_CONFLICT', `Live file conflict: ${resolved.relativePath}`, 409)
    } else {
      const tmp = `${resolved.fullPath}.yarc-${process.pid}-${Date.now()}.tmp`
      await writeFile(tmp, content, 'utf-8')
      await rename(tmp, resolved.fullPath)
      await projectHistoryService.trackChange(projectId, resolved.relativePath, 'autosave')
    }
    this.emit(projectId, 'save', resolved.relativePath, live.hasSession(resolved.relativePath))
    return this.getFileContent(projectId, resolved.relativePath)
  }

  async createFile(projectId: string, path: string, content = '') {
    const relativePath = assertProjectExposedPath(path)
    if (!relativePath) throw new AppError('MISSING_PATH', 'Path is required', 400)
    if (!isEditableText(relativePath, Buffer.byteLength(content, 'utf-8'))) {
      throw new AppError('UNSUPPORTED_FILE', 'Only supported text files up to 2MB can be created through the text File API', 400)
    }
    const resolved = await resolveProjectPath(projectId, relativePath, { allowMissing: true })
    try { await lstat(resolved.fullPath); throw new AppError('ALREADY_EXISTS', 'Path already exists', 409) } catch (error: any) {
      if (error instanceof AppError) throw error
      if (error?.code !== 'ENOENT') throw error
    }
    await mkdir(dirname(resolved.fullPath), { recursive: true })
    await projectHistoryService.ensureBaseline(projectId, relativePath, { missing: true })
    await writeFile(resolved.fullPath, content, { flag: 'wx' })
    await projectHistoryService.trackChange(projectId, resolved.relativePath, 'autosave')
    this.emit(projectId, 'create', resolved.relativePath)
    return this.getFileContent(projectId, resolved.relativePath)
  }

  async createDirectory(projectId: string, path: string) {
    const relativePath = assertProjectExposedPath(path)
    if (!relativePath) throw new AppError('MISSING_PATH', 'Path is required', 400)
    const resolved = await resolveProjectPath(projectId, relativePath, { allowMissing: true })
    await mkdir(resolved.fullPath, { recursive: false })
    this.emit(projectId, 'mkdir', resolved.relativePath)
    return { path: resolved.relativePath }
  }

  async renamePath(projectId: string, from: string, to: string) {
    const sourcePath = assertProjectExposedPath(from)
    const targetPath = assertProjectExposedPath(to)
    if (!sourcePath || !targetPath) throw new AppError('VALIDATION_ERROR', 'Source and target paths are required', 400)
    const source = await resolveProjectPath(projectId, sourcePath)
    const target = await resolveProjectPath(projectId, targetPath, { allowMissing: true })
    const info = await lstat(source.fullPath)
    await projectLiveFileManager.flushProject(projectId, source.relativePath)

    let sourcePaths: string[] = []
    let targetPaths: string[] = []
    if (info.isDirectory()) {
      sourcePaths = (await projectHistoryService.listTrackedPaths(projectId)).filter(path => path.startsWith(`${source.relativePath}/`))
      targetPaths = sourcePaths.map(path => `${target.relativePath}${path.slice(source.relativePath.length)}`)
      for (const path of sourcePaths) await projectHistoryService.ensureBaseline(projectId, path)
      for (const path of targetPaths) await projectHistoryService.ensureBaseline(projectId, path, { missing: true })
    } else {
      sourcePaths = [source.relativePath]
      targetPaths = [target.relativePath]
      await projectHistoryService.ensureBaseline(projectId, source.relativePath)
      await projectHistoryService.ensureBaseline(projectId, target.relativePath, { missing: true })
    }

    await mkdir(dirname(target.fullPath), { recursive: true })
    await rename(source.fullPath, target.fullPath)
    await projectLiveFileManager.resetPaths(projectId, [source.relativePath], 'project-file-rename')
    await projectHistoryService.checkpoint(projectId, {
      kind: 'manual', paths: [...sourcePaths, ...targetPaths],
      metadata: { operation: 'rename', from: source.relativePath, to: target.relativePath },
      forceBoundary: true,
    })
    this.emit(projectId, 'rename', target.relativePath)
    return { from: source.relativePath, to: target.relativePath }
  }

  async deletePath(projectId: string, path: string) {
    const relativePath = assertProjectExposedPath(path)
    const resolved = await resolveProjectPath(projectId, relativePath)
    if (!resolved.relativePath) throw new AppError('PROTECTED_PATH', 'Project root cannot be deleted through File API', 403)
    const info = await lstat(resolved.fullPath)
    await projectLiveFileManager.flushProject(projectId, resolved.relativePath)

    const trackedPaths = info.isDirectory()
      ? (await projectHistoryService.listTrackedPaths(projectId)).filter(item => item.startsWith(`${resolved.relativePath}/`))
      : [resolved.relativePath]
    for (const trackedPath of trackedPaths) await projectHistoryService.ensureBaseline(projectId, trackedPath)

    await rm(resolved.fullPath, { recursive: info.isDirectory(), force: false })
    await projectLiveFileManager.resetPaths(projectId, [resolved.relativePath], 'project-file-delete')
    if (trackedPaths.length) {
      await projectHistoryService.checkpoint(projectId, {
        kind: 'manual',
        paths: trackedPaths,
        metadata: { operation: 'delete', path: resolved.relativePath },
        forceBoundary: true,
      })
    }
    this.emit(projectId, 'delete', resolved.relativePath)
    return { deleted: true }
  }

  async upload(projectId: string, directory: string, file: File) {
    const safeDirectory = assertProjectExposedPath(directory)
    const name = basename(file.name).replace(/[\\/]/g, '_')
    const relative = assertProjectExposedPath([safeDirectory, name].filter(Boolean).join('/'))
    const resolved = await resolveProjectPath(projectId, relative, { allowMissing: true })
    try { await lstat(resolved.fullPath); throw new AppError('ALREADY_EXISTS', 'File already exists', 409) } catch (error: any) {
      if (error instanceof AppError) throw error
      if (error?.code !== 'ENOENT') throw error
    }
    await mkdir(dirname(resolved.fullPath), { recursive: true })
    await projectHistoryService.ensureBaseline(projectId, relative, { missing: true })
    await writeFile(resolved.fullPath, Buffer.from(await file.arrayBuffer()), { flag: 'wx' })
    await projectHistoryService.trackChange(projectId, relative, 'autosave')
    this.emit(projectId, 'upload', relative)
    return { path: relative, size: file.size }
  }

  async getDownload(projectId: string, path: string) {
    const relativePath = assertProjectExposedPath(path)
    const resolved = await resolveProjectPath(projectId, relativePath)
    const info = await stat(resolved.fullPath)
    if (!info.isFile()) throw new AppError('NOT_FILE', 'Path is not a file', 400)
    return { path: resolved.fullPath, name: basename(relativePath), size: info.size, mime: MIME[extname(relativePath).toLowerCase()] || 'application/octet-stream', stream: createReadStream(resolved.fullPath) }
  }

  async getAbsolutePath(projectId: string, path: string, allowMissing = false) {
    const relativePath = assertProjectExposedPath(path)
    return (await resolveProjectPath(projectId, relativePath, { allowMissing })).fullPath
  }

  async getProjectRoot(projectId: string) {
    return (await resolveProjectRoot(projectId)).root
  }

  notifyExternalChange(projectId: string, path: string, action = 'external') {
    this.emit(projectId, action, path)
  }
}

export const projectFileService = new ProjectFileService()
