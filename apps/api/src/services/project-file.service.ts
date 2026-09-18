import { createReadStream } from 'node:fs'
import { lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { config } from '../lib/config.js'
import { assertGlobalFilesPathSafe } from '../lib/global-files-path.js'
import { projectChangePath } from '../lib/project-change-path.js'
import { sseHub } from '../lib/sse.js'
import { AppError } from '../lib/errors.js'
import { normalizeProjectRelativePath, resolveProjectPath, resolveProjectRoot } from '../lib/project-path.js'
import { normalizePublicSharedFilePath, resolvePublicSharedFileReference } from './global-shared-file.service.js'
import { getDataChangeWatcher, type DataChangeKind } from './data-change-watcher.js'
import { projectHistoryService } from './project-history.service.js'
import { projectLiveFileManager } from './project-live-file.service.js'
import type { FileNode, ResolvedWorkspaceFileReference } from '@yarc/shared'

export type ProjectFileNode = FileNode & {
  modifiedAt?: string
}

const HIDDEN_NAMES = new Set(['.git'])
const TEXT_EXTENSIONS = new Set([
  '.tex', '.bib', '.sty', '.cls', '.bst', '.txt', '.md', '.markdown', '.json', '.jsonl', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.csv', '.tsv', '.log',
  '.py', '.r', '.jl', '.m', '.c', '.h', '.cc', '.cpp', '.hpp', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.css', '.scss', '.html', '.xml', '.sh', '.zsh', '.fish', '.sql',
])
const TEXT_FILE_NAMES = new Set(['.gitignore', '.gitattributes', 'Dockerfile', 'Makefile'])
const OFFICE_EXTENSIONS = new Set(['.docx', '.xlsx', '.pptx'])
const LEGACY_OFFICE_EXTENSIONS = new Set(['.doc', '.xls', '.ppt'])
const MIME: Record<string, string> = {
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.doc': 'application/msword', '.xls': 'application/vnd.ms-excel', '.ppt': 'application/vnd.ms-powerpoint',
  '.tex': 'text/x-tex; charset=utf-8', '.bib': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.markdown': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
}

const extensionFor = (path: string) => path.toLowerCase().endsWith('.env.example') ? '.env.example' : extname(path).toLowerCase()
const mimeFor = (path: string) => MIME[extensionFor(path)] || 'application/octet-stream'

const isSensitiveProjectPath = (path: string) => {
  const relative = normalizeProjectRelativePath(path)
  if (!relative) return false
  const segments = relative.split('/')
  const name = segments[segments.length - 1] || ''
  if (name !== '.env.example' && (name === '.env' || name.startsWith('.env.'))) return true
  if (relative === '.pi/auth.json' || relative.startsWith('.pi/auth.json/')) return true
  if (relative === '.pi/models.json' || relative.startsWith('.pi/models.json/')) return true
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

const isInside = (root: string, target: string) => target === root || target.startsWith(`${root}${sep}`)
const isAbsoluteReference = (value: string) => isAbsolute(value)
  || /^[A-Za-z]:[\\/]/.test(value)
  || value.startsWith('\\\\')
  || value.startsWith('//')

export class ProjectFileService {
  private emit(projectId: string, action: string, path?: string, live = false) {
    sseHub.emit({ type: 'project-files-changed', projectId, action, path, live, at: new Date().toISOString() })
  }

  private async publishFileServiceChange(directoryName: string, path: string, kind?: DataChangeKind) {
    const change = projectChangePath(directoryName, path)
    await getDataChangeWatcher(change.root).publish({ path: change.path, kind, source: 'file-service' }).catch(error => {
      console.warn('[ProjectFile] failed to publish data change:', (error as Error).message)
    })
  }

  async resolveFileReference(projectId: string, filePath: string): Promise<ResolvedWorkspaceFileReference | null> {
    const rawPath = filePath.trim()
    if (!rawPath) return null

    const { root } = await resolveProjectRoot(projectId)
    const globalRoot = resolve(config.filesDir)
    const normalizedPath = rawPath.replace(/\\/g, '/')

    if (isAbsoluteReference(rawPath)) {
      const target = resolve(rawPath)
      if (isInside(root, target)) {
        try {
          const resolved = await resolveProjectPath(projectId, relative(root, target).replace(/\\/g, '/'))
          const info = await lstat(resolved.fullPath)
          return info.isFile() ? { scope: 'project', path: resolved.relativePath } : null
        } catch {
          return null
        }
      }
      if (isInside(globalRoot, target)) {
        try {
          await assertGlobalFilesPathSafe(globalRoot, target)
          const sharedPath = normalizePublicSharedFilePath(relative(globalRoot, target).replace(/\\/g, '/'))
          if (!sharedPath) return null
          const info = await lstat(target)
          return info.isFile() ? { scope: 'global', path: sharedPath } : null
        } catch {
          return null
        }
      }
      return null
    }

    if (normalizedPath.startsWith('../../')) {
      try {
        const sharedPath = resolvePublicSharedFileReference(normalizedPath)
        if (!sharedPath) return null
        const target = resolve(globalRoot, ...sharedPath.split('/'))
        await assertGlobalFilesPathSafe(globalRoot, target)
        const info = await lstat(target)
        return info.isFile() ? { scope: 'global', path: sharedPath } : null
      } catch {
        return null
      }
    }

    try {
      const resolved = await resolveProjectPath(projectId, rawPath)
      const info = await lstat(resolved.fullPath)
      return info.isFile() ? { scope: 'project', path: resolved.relativePath } : null
    } catch {
      return null
    }
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
    const name = basename(relativePath || fullPath)
    const extension = extensionFor(name)
    const base: ProjectFileNode = {
      name,
      path: relativePath,
      type: info.isDirectory() ? 'directory' : 'file',
      modified: info.mtime.toISOString(),
      modifiedAt: info.mtime.toISOString(),
      ...(info.isFile() ? {
        size: Number(info.size),
        extension,
        mime: mimeFor(name),
        editable: isEditableText(relativePath || name, Number(info.size)),
        office: OFFICE_EXTENSIONS.has(extension),
        legacyOffice: LEGACY_OFFICE_EXTENSIONS.has(extension),
      } : {}),
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
    const language = ({
      '.tex': 'latex', '.sty': 'latex', '.cls': 'latex', '.bib': 'bibtex',
      '.md': 'markdown', '.markdown': 'markdown', '.json': 'json', '.jsonl': 'json',
      '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
      '.vue': 'vue', '.py': 'python', '.r': 'r', '.jl': 'julia', '.css': 'css', '.scss': 'scss', '.html': 'html', '.xml': 'xml',
      '.yaml': 'yaml', '.yml': 'yaml', '.sql': 'sql', '.sh': 'shell',
    } as Record<string, string>)[extensionFor(resolved.relativePath)] || 'plaintext'
    return {
      path: resolved.relativePath,
      content,
      language,
      size: Buffer.byteLength(content, 'utf-8'),
      modified: info.mtime.toISOString(),
      modifiedAt: info.mtime.toISOString(),
    }
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
    await this.publishFileServiceChange(resolved.project.directoryName, resolved.relativePath)
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
    await this.publishFileServiceChange(resolved.project.directoryName, resolved.relativePath)
    this.emit(projectId, 'create', resolved.relativePath)
    return this.getFileContent(projectId, resolved.relativePath)
  }

  async createDirectory(projectId: string, path: string) {
    const relativePath = assertProjectExposedPath(path)
    if (!relativePath) throw new AppError('MISSING_PATH', 'Path is required', 400)
    const resolved = await resolveProjectPath(projectId, relativePath, { allowMissing: true })
    await mkdir(resolved.fullPath, { recursive: false })
    await this.publishFileServiceChange(resolved.project.directoryName, resolved.relativePath)
    this.emit(projectId, 'mkdir', resolved.relativePath)
    return { path: resolved.relativePath }
  }

  async renamePath(projectId: string, from: string, to: string) {
    const sourcePath = assertProjectExposedPath(from)
    const targetPath = assertProjectExposedPath(to)
    if (!sourcePath || !targetPath) throw new AppError('VALIDATION_ERROR', 'Source and target paths are required', 400)
    if (sourcePath === targetPath) throw new AppError('VALIDATION_ERROR', 'Source and target paths must differ', 400)
    const source = await resolveProjectPath(projectId, sourcePath)
    const target = await resolveProjectPath(projectId, targetPath, { allowMissing: true })
    try {
      await lstat(target.fullPath)
      throw new AppError('ALREADY_EXISTS', 'Target path already exists', 409)
    } catch (error: any) {
      if (error instanceof AppError) throw error
      if (error?.code !== 'ENOENT') throw error
    }
    const info = await lstat(source.fullPath)
    if (info.isDirectory() && target.fullPath.startsWith(`${source.fullPath}${sep}`)) {
      throw new AppError('VALIDATION_ERROR', 'A directory cannot be moved into its own subtree', 400)
    }
    await projectLiveFileManager.flushProject(projectId, source.relativePath)

    let sourcePaths: string[] = []
    let targetPaths: string[] = []
    if (info.isDirectory()) {
      sourcePaths = (await projectHistoryService.listTrackedPaths(projectId)).filter(path => path.startsWith(`${source.relativePath}/`))
      targetPaths = sourcePaths.map(path => `${target.relativePath}${path.slice(source.relativePath.length)}`)
      for (const trackedPath of sourcePaths) await projectHistoryService.ensureBaseline(projectId, trackedPath)
      for (const trackedPath of targetPaths) await projectHistoryService.ensureBaseline(projectId, trackedPath, { missing: true })
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
    await this.publishFileServiceChange(source.project.directoryName, source.relativePath, 'delete')
    await this.publishFileServiceChange(source.project.directoryName, target.relativePath)
    for (const trackedPath of sourcePaths) await this.publishFileServiceChange(source.project.directoryName, trackedPath, 'delete')
    for (const trackedPath of targetPaths) await this.publishFileServiceChange(source.project.directoryName, trackedPath)
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
    await this.publishFileServiceChange(resolved.project.directoryName, resolved.relativePath, 'delete')
    for (const trackedPath of trackedPaths) await this.publishFileServiceChange(resolved.project.directoryName, trackedPath, 'delete')
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
    await this.publishFileServiceChange(resolved.project.directoryName, relative)
    this.emit(projectId, 'upload', relative)
    return { path: relative, size: file.size }
  }

  async getOfficeFile(projectId: string, path: string) {
    const file = await this.getDownload(projectId, path)
    if (!OFFICE_EXTENSIONS.has(extensionFor(path))) throw new AppError('UNSUPPORTED_FILE', 'Not an Office file', 400)
    return file
  }

  async getSystemOpenPath(projectId: string, path: string) {
    const relativePath = assertProjectExposedPath(path)
    const resolved = await resolveProjectPath(projectId, relativePath)
    const info = await stat(resolved.fullPath)
    if (!info.isFile()) throw new AppError('NOT_FILE', 'Path is not a file', 400)
    return { path: resolved.fullPath, name: basename(relativePath) }
  }

  async getDownload(projectId: string, path: string) {
    const relativePath = assertProjectExposedPath(path)
    const resolved = await resolveProjectPath(projectId, relativePath)
    const info = await stat(resolved.fullPath)
    if (!info.isFile()) throw new AppError('NOT_FILE', 'Path is not a file', 400)
    return { path: resolved.fullPath, name: basename(relativePath), size: info.size, mime: MIME[extname(relativePath).toLowerCase()] || 'application/octet-stream', stream: createReadStream(resolved.fullPath) }
  }

  notifyExternalChange(projectId: string, path: string, action = 'external') {
    this.emit(projectId, action, path)
  }
}

export const projectFileService = new ProjectFileService()
