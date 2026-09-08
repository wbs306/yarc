import { createReadStream } from 'node:fs'
import { lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname } from 'node:path'
import { sseHub } from '../lib/sse.js'
import { AppError } from '../lib/errors.js'
import { normalizeProjectRelativePath, resolveProjectPath, resolveProjectRoot } from '../lib/project-path.js'
import { projectHistoryService } from './project-history.service.js'

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
const MIME: Record<string, string> = {
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.tex': 'text/x-tex; charset=utf-8', '.bib': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
}

export class ProjectFileService {
  private emit(projectId: string, action: string, path?: string, live = false) {
    sseHub.emit({ type: 'project-files-changed', projectId, action, path, live, at: new Date().toISOString() })
  }

  async getFileTree(projectId: string, path = ''): Promise<ProjectFileNode[]> {
    const resolved = await resolveProjectPath(projectId, path)
    const info = await lstat(resolved.fullPath)
    if (info.isSymbolicLink()) throw new AppError('PROJECT_INVALID_DIRECTORY', 'Symlinks are not exposed by Project File API', 400)
    if (info.isFile()) return [await this.node(projectId, resolved.relativePath, resolved.fullPath, info)]
    if (!info.isDirectory()) return []
    const entries = await readdir(resolved.fullPath, { withFileTypes: true })
    const nodes: ProjectFileNode[] = []
    for (const entry of entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))) {
      if (HIDDEN_NAMES.has(entry.name)) continue
      const relative = normalizeProjectRelativePath([resolved.relativePath, entry.name].filter(Boolean).join('/'))
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
    const resolved = await resolveProjectPath(projectId, path)
    const info = await lstat(resolved.fullPath)
    if (!info.isFile()) throw new AppError('NOT_FILE', 'Path is not a file', 400)
    if (!TEXT_EXTENSIONS.has(extname(path).toLowerCase()) && info.size > 2 * 1024 * 1024) {
      throw new AppError('UNSUPPORTED_FILE', 'Binary/large files are not editable as text', 400)
    }
    return { path: resolved.relativePath, content: await readFile(resolved.fullPath, 'utf-8'), size: info.size, modifiedAt: info.mtime.toISOString() }
  }

  async saveFileContent(projectId: string, path: string, content: string) {
    await projectHistoryService.ensureBaseline(projectId, path)
    const resolved = await resolveProjectPath(projectId, path)
    const info = await lstat(resolved.fullPath)
    if (!info.isFile()) throw new AppError('NOT_FILE', 'Path is not a file', 400)
    const tmp = `${resolved.fullPath}.yarc-${process.pid}-${Date.now()}.tmp`
    await writeFile(tmp, content, 'utf-8')
    await rename(tmp, resolved.fullPath)
    await projectHistoryService.trackChange(projectId, resolved.relativePath, 'autosave')
    this.emit(projectId, 'save', resolved.relativePath)
    return this.getFileContent(projectId, resolved.relativePath)
  }

  async createFile(projectId: string, path: string, content = '') {
    const resolved = await resolveProjectPath(projectId, path, { allowMissing: true })
    try { await lstat(resolved.fullPath); throw new AppError('ALREADY_EXISTS', 'Path already exists', 409) } catch (error: any) {
      if (error instanceof AppError) throw error
      if (error?.code !== 'ENOENT') throw error
    }
    await mkdir(dirname(resolved.fullPath), { recursive: true })
    await projectHistoryService.ensureBaseline(projectId, path, { missing: true })
    await writeFile(resolved.fullPath, content, { flag: 'wx' })
    await projectHistoryService.trackChange(projectId, resolved.relativePath, 'autosave')
    this.emit(projectId, 'create', resolved.relativePath)
    return this.getFileContent(projectId, resolved.relativePath)
  }

  async createDirectory(projectId: string, path: string) {
    const resolved = await resolveProjectPath(projectId, path, { allowMissing: true })
    await mkdir(resolved.fullPath, { recursive: false })
    this.emit(projectId, 'mkdir', resolved.relativePath)
    return { path: resolved.relativePath }
  }

  async renamePath(projectId: string, from: string, to: string) {
    const source = await resolveProjectPath(projectId, from)
    const target = await resolveProjectPath(projectId, to, { allowMissing: true })
    await projectHistoryService.ensureBaseline(projectId, source.relativePath)
    await projectHistoryService.ensureBaseline(projectId, target.relativePath, { missing: true })
    await mkdir(dirname(target.fullPath), { recursive: true })
    await rename(source.fullPath, target.fullPath)
    await projectHistoryService.checkpoint(projectId, {
      kind: 'manual', paths: [source.relativePath, target.relativePath],
      metadata: { operation: 'rename', from: source.relativePath, to: target.relativePath },
    })
    this.emit(projectId, 'rename', target.relativePath)
    return { from: source.relativePath, to: target.relativePath }
  }

  async deletePath(projectId: string, path: string) {
    const resolved = await resolveProjectPath(projectId, path)
    if (!resolved.relativePath) throw new AppError('PROTECTED_PATH', 'Project root cannot be deleted through File API', 403)
    const info = await lstat(resolved.fullPath)
    if (info.isFile()) await projectHistoryService.ensureBaseline(projectId, resolved.relativePath)
    await rm(resolved.fullPath, { recursive: info.isDirectory(), force: false })
    if (info.isFile()) await projectHistoryService.checkpoint(projectId, { kind: 'manual', paths: [resolved.relativePath], metadata: { operation: 'delete' } })
    this.emit(projectId, 'delete', resolved.relativePath)
    return { deleted: true }
  }

  async upload(projectId: string, directory: string, file: File) {
    const name = basename(file.name).replace(/[\\/]/g, '_')
    const relative = normalizeProjectRelativePath([directory, name].filter(Boolean).join('/'))
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
    const resolved = await resolveProjectPath(projectId, path)
    const info = await stat(resolved.fullPath)
    if (!info.isFile()) throw new AppError('NOT_FILE', 'Path is not a file', 400)
    return { path: resolved.fullPath, name: basename(path), size: info.size, mime: MIME[extname(path).toLowerCase()] || 'application/octet-stream', stream: createReadStream(resolved.fullPath) }
  }

  async getAbsolutePath(projectId: string, path: string, allowMissing = false) {
    return (await resolveProjectPath(projectId, path, { allowMissing })).fullPath
  }

  async getProjectRoot(projectId: string) {
    return (await resolveProjectRoot(projectId)).root
  }

  notifyExternalChange(projectId: string, path: string, action = 'external') {
    this.emit(projectId, action, path)
  }
}

export const projectFileService = new ProjectFileService()
