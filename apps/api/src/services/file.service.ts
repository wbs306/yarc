import { readdir, stat, readFile, mkdir, rename, rm } from 'node:fs/promises'
import { dirname, extname, relative, resolve, sep, basename } from 'node:path'
import { atomicWriteFile, atomicWriteTextFile } from '../lib/atomic-file.js'
import { config } from '../lib/config.js'
import { isPiRuntimeResourcePath } from '../lib/data-sync-policy.js'
import { AppError } from '../lib/errors.js'
import { sseHub } from '../lib/sse.js'
import { ensureAgentWorkspace } from '../lib/agent-workspace.js'
import { liveFileService } from './live-file.service.js'
import { getDataChangeWatcher, type DataChangeWatcher } from './data-change-watcher.js'
import type { FileNode } from '@yarc/shared'

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonl', '.yaml', '.yml', '.toml', '.csv', '.tsv',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.css', '.scss', '.html', '.xml',
  '.py', '.sh', '.sql', '.log', '.bib', '.tex', '.ini', '.conf', '.env.example',
])

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg'])
const OFFICE_EXTENSIONS = new Set(['.docx', '.xlsx', '.pptx'])
const LEGACY_OFFICE_EXTENSIONS = new Set(['.doc', '.xls', '.ppt'])
const MAX_TEXT_FILE_SIZE = 2 * 1024 * 1024 // 2MB
const DEFAULT_TREE_DEPTH = 4
const PI_TREE_DEPTH = 6

// Items hidden from the file tree (internal app resources)
const EXCLUDED_NAMES = new Set(['backgrounds', 'model-catalog.json', 'temporary-pdfs'])

export class FileService {
  private rootDir: string
  private changeWatcher: DataChangeWatcher
  private unsubscribeDataChanges: (() => void) | null = null

  constructor() {
    this.rootDir = resolve(config.filesDir)
    this.changeWatcher = getDataChangeWatcher(this.rootDir)
  }

  private async ensureRootReady() {
    if (this.rootDir === resolve(config.dataDir)) {
      await ensureAgentWorkspace()
      return
    }
    await mkdir(this.rootDir, { recursive: true })
  }

  private normalizeRelativePath(filePath = ''): string {
    const normalized = filePath.replace(/\\/g, '/').replace(/^\/+/, '')
    if (normalized === '.' || normalized === './') return ''
    return normalized
  }

  private isSensitivePath(filePath: string): boolean {
    const relPath = this.normalizeRelativePath(filePath)
    const segments = relPath.split('/').filter(Boolean)
    const name = segments[segments.length - 1] || ''
    if (!relPath) return false
    if (name !== '.env.example' && (name === '.env' || name.startsWith('.env.'))) return true
    return relPath === '.pi/agent/auth.json'
      || relPath.startsWith('.pi/agent/auth.json/')
      || relPath === '.pi/agent/models.json'
      || relPath.startsWith('.pi/agent/models.json/')
      || relPath.endsWith('.lock')
      || relPath.includes('.lock/')
  }

  private isHiddenPath(filePath: string): boolean {
    const relPath = this.normalizeRelativePath(filePath)
    if (!relPath) return false
    if (this.isSensitivePath(relPath)) return true
    if (relPath === '.pi/agent/runtime-streams' || relPath.startsWith('.pi/agent/runtime-streams/')) return true

    const segments = relPath.split('/').filter(Boolean)
    if (segments[0] === '.pi') {
      return segments.slice(1).some((segment) => segment.startsWith('.'))
    }

    return segments.some((segment) => segment.startsWith('.') && segment !== '.env.example')
  }

  private isExcludedPath(filePath: string): boolean {
    const relPath = this.normalizeRelativePath(filePath)
    if (!relPath) return false
    if (relPath === 'generated/latex' || relPath.startsWith('generated/latex/')) return true
    const name = basename(relPath)
    return EXCLUDED_NAMES.has(name)
  }

  private resolvePath(filePath = ''): string {
    const relPath = this.normalizeRelativePath(filePath)
    if (this.isHiddenPath(relPath) || this.isSensitivePath(relPath)) {
      throw new AppError('FORBIDDEN', 'Access denied', 403)
    }
    const fullPath = resolve(this.rootDir, relPath)
    if (fullPath !== this.rootDir && !fullPath.startsWith(`${this.rootDir}${sep}`)) {
      throw new AppError('FORBIDDEN', 'Access denied', 403)
    }
    return fullPath
  }

  private toRelativePath(fullPath: string): string {
    const rel = relative(this.rootDir, fullPath).replace(/\\/g, '/')
    return rel === '.' ? '' : rel
  }

  private extensionFor(nameOrPath: string): string {
    const lower = nameOrPath.toLowerCase()
    if (lower.endsWith('.env.example')) return '.env.example'
    return extname(lower)
  }

  private mimeFor(filePath: string): string {
    const ext = this.extensionFor(filePath)
    const mimeTypes: Record<string, string> = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml',
      '.pdf': 'application/pdf',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      '.doc': 'application/msword',
      '.xls': 'application/vnd.ms-excel',
      '.ppt': 'application/vnd.ms-powerpoint',
      '.json': 'application/json',
      '.md': 'text/markdown; charset=utf-8',
      '.markdown': 'text/markdown; charset=utf-8',
      '.txt': 'text/plain; charset=utf-8',
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.mjs': 'application/javascript; charset=utf-8',
      '.ts': 'text/plain; charset=utf-8',
      '.vue': 'text/plain; charset=utf-8',
      '.py': 'text/x-python; charset=utf-8',
      '.sh': 'text/x-shellscript; charset=utf-8',
    }
    return mimeTypes[ext] || 'application/octet-stream'
  }

  private isEditable(filePath: string, size?: number): boolean {
    const ext = this.extensionFor(filePath)
    return TEXT_EXTENSIONS.has(ext) && (size === undefined || size <= MAX_TEXT_FILE_SIZE)
  }

  private isPapersPath(filePath: string): boolean {
    const relPath = this.normalizeRelativePath(filePath)
    return relPath === 'papers' || relPath.startsWith('papers/')
  }

  private isProtectedPath(filePath: string): boolean {
    const relPath = this.normalizeRelativePath(filePath)
    return !relPath || relPath === '.pi' || this.isPapersPath(relPath)
  }

  private isPiConfigPath(filePath: string): boolean {
    return isPiRuntimeResourcePath(this.normalizeRelativePath(filePath))
  }

  private treeDepthForPath(filePath: string): number {
    const relPath = this.normalizeRelativePath(filePath)
    return relPath === '.pi' || relPath.startsWith('.pi/')
      ? PI_TREE_DEPTH
      : DEFAULT_TREE_DEPTH
  }

  private async emitFilesChanged(action: string, path?: string) {
    if (action !== 'external-change' && path) {
      await this.changeWatcher.publish({
        path,
        kind: action === 'delete' ? 'delete' : 'change',
        source: 'file-service',
      }).catch((error) => {
        console.warn('[FileService] failed to publish data change:', (error as Error).message)
      })
    }

    if (action === 'external-change' && path) {
      try {
        const result = await liveFileService.handleDiskChange(path)
        if (result === 'self') return
        sseHub.emit({ type: 'files-changed', action, path, live: result === 'live', at: new Date().toISOString() })
        if (this.isPiConfigPath(path)) {
          void import('./pi.service.js')
            .then(({ piService }) => piService.reload(`files:${action}:${path}`))
            .catch((err) => console.warn('[FileService] Pi reload failed:', err))
        }
      } catch (err) {
        console.warn('[FileService] live disk-change bridge failed:', err)
      }
      return
    }

    sseHub.emit({ type: 'files-changed', action, path, at: new Date().toISOString() })
  }

  private async assertExists(fullPath: string) {
    try {
      return await stat(fullPath)
    } catch {
      throw new AppError('NOT_FOUND', 'File not found', 404)
    }
  }

  startWatcher(): void {
    if (this.unsubscribeDataChanges) return
    this.unsubscribeDataChanges = this.changeWatcher.subscribe(async (event) => {
      if (event.source !== 'filesystem') return
      const path = this.normalizeRelativePath(event.path)
      if (!path) return
      if (this.isHiddenPath(path) || this.isSensitivePath(path) || this.isExcludedPath(path)) return
      if (this.isPapersPath(path)) {
        sseHub.emit({ type: 'files-changed', action: 'external-change', path, live: false, at: new Date().toISOString() })
        return
      }
      if (event.signature === 'directory') {
        // fs.watch may report a parent directory with no filename when an
        // ignored generated subtree (sessions/runtime-streams) changes. Child
        // file events carry the actionable path, so a directory heartbeat must
        // not reload every Runtime Worker or erase extension module state.
        sseHub.emit({ type: 'files-changed', action: 'external-change', path, live: false, at: new Date().toISOString() })
        return
      }
      await this.emitFilesChanged('external-change', path)
    })
    void this.changeWatcher.start().catch((error) => {
      console.warn('[FileService] data watcher failed to start:', (error as Error).message)
    })
  }

  stopWatcher(): void {
    this.unsubscribeDataChanges?.()
    this.unsubscribeDataChanges = null
  }

  private async buildNode(fullPath: string, depth: number): Promise<FileNode | null> {
    const relPath = this.toRelativePath(fullPath)
    const name = basename(fullPath)
    if (this.isHiddenPath(relPath) || this.isSensitivePath(relPath) || this.isExcludedPath(relPath) || name === 'node_modules') return null
    const entryStat = await stat(fullPath)
    const common = {
      name,
      path: relPath,
      size: entryStat.isFile() ? entryStat.size : undefined,
      modified: entryStat.mtime.toISOString(),
      readonly: this.isProtectedPath(relPath),
    }

    if (entryStat.isDirectory()) {
      const node: FileNode = { ...common, type: 'directory', children: [] }
      if (depth < this.treeDepthForPath(relPath)) {
        const entries = await readdir(fullPath, { withFileTypes: true })
        const children: FileNode[] = []
        for (const entry of entries) {
          const child = await this.buildNode(resolve(fullPath, entry.name), depth + 1)
          if (child) children.push(child)
        }
        node.children = this.sortNodes(children)
      }
      return node
    }

    return {
      ...common,
      type: 'file',
      extension: this.extensionFor(name),
      mime: this.mimeFor(name),
      editable: this.isEditable(name, entryStat.size),
      office: OFFICE_EXTENSIONS.has(this.extensionFor(name)),
      legacyOffice: LEGACY_OFFICE_EXTENSIONS.has(this.extensionFor(name)),
    }
  }

  private sortNodes(nodes: FileNode[]): FileNode[] {
    return nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
  }

  async getFileTree(dirPath = ''): Promise<FileNode[]> {
    await this.ensureRootReady()
    const fullPath = this.resolvePath(dirPath)
    const rootStat = await this.assertExists(fullPath)
    if (!rootStat.isDirectory()) {
      throw new AppError('NOT_DIRECTORY', 'Path is not a directory', 400)
    }

    const entries = await readdir(fullPath, { withFileTypes: true })
    const nodes: FileNode[] = []
    for (const entry of entries) {
      const node = await this.buildNode(resolve(fullPath, entry.name), 1)
      if (node) nodes.push(node)
    }

    return this.sortNodes(nodes)
  }

  async getFileContent(filePath: string): Promise<{
    content: string
    language: string
    modified: string
    live?: boolean
    dirty?: boolean
    saving?: boolean
    conflict?: boolean
    revision?: number
    savedRevision?: number
    sessionEpoch?: string
    contentHash?: string
    diskHash?: string
  }> {
    const liveSnapshot = liveFileService.getSnapshot(filePath)
    if (liveSnapshot) return liveSnapshot

    const fullPath = this.resolvePath(filePath)
    const entryStat = await this.assertExists(fullPath)
    if (!entryStat.isFile()) throw new AppError('NOT_FILE', 'Path is not a file', 400)
    if (!this.isEditable(filePath, entryStat.size)) {
      throw new AppError('UNSUPPORTED_FILE', 'This file type or size cannot be edited as text', 400)
    }

    const content = await readFile(fullPath, 'utf-8')
    const ext = this.extensionFor(filePath)
    const languageMap: Record<string, string> = {
      '.ts': 'typescript',
      '.tsx': 'typescript',
      '.js': 'javascript',
      '.jsx': 'javascript',
      '.mjs': 'javascript',
      '.cjs': 'javascript',
      '.vue': 'vue',
      '.json': 'json',
      '.jsonl': 'json',
      '.md': 'markdown',
      '.markdown': 'markdown',
      '.py': 'python',
      '.css': 'css',
      '.scss': 'scss',
      '.html': 'html',
      '.xml': 'xml',
      '.yaml': 'yaml',
      '.yml': 'yaml',
      '.sh': 'shell',
      '.sql': 'sql',
      '.bib': 'bibtex',
      '.tex': 'latex',
    }

    return {
      content,
      language: languageMap[ext] || 'plaintext',
      modified: entryStat.mtime.toISOString(),
    }
  }

  async saveFileContent(filePath: string, content: string): Promise<void> {
    if (liveFileService.hasSession(filePath)) {
      await liveFileService.replaceContent(filePath, content, 'api')
      const result = await liveFileService.flush(filePath)
      if (result?.conflict) throw new AppError('CONFLICT', '文件存在外部修改冲突，请先处理冲突', 409)
      return
    }

    if (this.isProtectedPath(filePath)) throw new AppError('PROTECTED_PATH', 'This path is protected', 403)
    const fullPath = this.resolvePath(filePath)
    const entryStat = await this.assertExists(fullPath)
    if (!entryStat.isFile()) throw new AppError('NOT_FILE', 'Path is not a file', 400)
    if (!this.isEditable(filePath, Buffer.byteLength(content, 'utf-8'))) {
      throw new AppError('UNSUPPORTED_FILE', 'This file type or size cannot be edited as text', 400)
    }

    await liveFileService.withWorkspaceMutationLock(() => atomicWriteTextFile(fullPath, content))
    void this.emitFilesChanged('save', this.toRelativePath(fullPath))
  }

  async writeTextFile(filePath: string, content: string, create = false): Promise<FileNode> {
    if (this.isProtectedPath(filePath)) throw new AppError('PROTECTED_PATH', 'This path is protected', 403)
    const fullPath = this.resolvePath(filePath)
    const contentSize = Buffer.byteLength(content, 'utf-8')
    if (!this.isEditable(filePath, contentSize)) {
      throw new AppError('UNSUPPORTED_FILE', 'Only supported text files up to 2MB can be written', 400)
    }

    try {
      const entryStat = await stat(fullPath)
      if (!entryStat.isFile()) throw new AppError('NOT_FILE', 'Path is not a file', 400)
    } catch (err) {
      if (!create) throw new AppError('NOT_FOUND', 'File not found', 404)
      if (err instanceof AppError && err.code === 'NOT_FILE') throw err
      await mkdir(dirname(fullPath), { recursive: true })
    }

    if (liveFileService.hasSession(filePath)) {
      await liveFileService.replaceContent(filePath, content, 'api')
      const result = await liveFileService.flush(filePath)
      if (result?.conflict) throw new AppError('CONFLICT', '文件存在外部修改冲突，请先处理冲突', 409)
    } else {
      await liveFileService.withWorkspaceMutationLock(() => atomicWriteTextFile(fullPath, content))
    }
    const node = await this.buildNode(fullPath, DEFAULT_TREE_DEPTH)
    if (!node) throw new AppError('WRITE_FAILED', 'Failed to write file', 500)
    void this.emitFilesChanged('write', node.path)
    return node
  }

  async createFile(filePath: string, content = ''): Promise<FileNode> {
    if (!filePath) throw new AppError('MISSING_PATH', 'Path is required', 400)
    if (this.isProtectedPath(filePath)) throw new AppError('PROTECTED_PATH', 'This path is protected', 403)
    if (!this.isEditable(filePath, Buffer.byteLength(content, 'utf-8'))) {
      throw new AppError('UNSUPPORTED_FILE', 'Only editable text files can be created here', 400)
    }

    const fullPath = this.resolvePath(filePath)
    try {
      await stat(fullPath)
      throw new AppError('ALREADY_EXISTS', 'File already exists', 409)
    } catch (err) {
      if (err instanceof AppError) throw err
    }

    await liveFileService.withWorkspaceMutationLock(() => atomicWriteTextFile(fullPath, content))
    const node = await this.buildNode(fullPath, DEFAULT_TREE_DEPTH)
    if (!node) throw new AppError('CREATE_FAILED', 'Failed to create file', 500)
    void this.emitFilesChanged('create-file', node.path)
    return node
  }

  async createDirectory(dirPath: string): Promise<FileNode> {
    if (!dirPath) throw new AppError('MISSING_PATH', 'Path is required', 400)
    if (this.isProtectedPath(dirPath)) throw new AppError('PROTECTED_PATH', 'This path is protected', 403)
    const fullPath = this.resolvePath(dirPath)
    await mkdir(fullPath, { recursive: false })
    const node = await this.buildNode(fullPath, DEFAULT_TREE_DEPTH)
    if (!node) throw new AppError('CREATE_FAILED', 'Failed to create directory', 500)
    this.emitFilesChanged('create-directory', node.path)
    return node
  }

  async renamePath(fromPath: string, toPath: string): Promise<FileNode> {
    if (!fromPath || !toPath) throw new AppError('MISSING_PATH', 'Source and target paths are required', 400)
    if (this.isProtectedPath(fromPath) || this.isProtectedPath(toPath)) {
      throw new AppError('PROTECTED_PATH', 'This path is protected', 403)
    }
    const from = this.resolvePath(fromPath)
    const to = this.resolvePath(toPath)
    await this.assertExists(from)
    try {
      await stat(to)
      throw new AppError('ALREADY_EXISTS', 'Target already exists', 409)
    } catch (err) {
      if (err instanceof AppError) throw err
    }
    await liveFileService.withWorkspaceMutationLock(async () => {
      await mkdir(dirname(to), { recursive: true })
      await rename(from, to)
    })
    const node = await this.buildNode(to, DEFAULT_TREE_DEPTH)
    if (!node) throw new AppError('RENAME_FAILED', 'Failed to rename path', 500)
    this.emitFilesChanged('rename', node.path)
    return node
  }

  async deletePath(filePath: string): Promise<void> {
    if (!filePath) throw new AppError('MISSING_PATH', 'Path is required', 400)
    if (this.isProtectedPath(filePath)) throw new AppError('PROTECTED_PATH', 'This path is protected', 403)
    const fullPath = this.resolvePath(filePath)
    await this.assertExists(fullPath)
    await liveFileService.withWorkspaceMutationLock(() => rm(fullPath, { recursive: true, force: false }))
    void this.emitFilesChanged('delete', this.normalizeRelativePath(filePath))
  }

  async uploadFile(dirPath: string, file: File): Promise<FileNode> {
    if (!file) throw new AppError('MISSING_FILE', 'File is required', 400)
    const safeName = basename(file.name).replace(/[\\/]/g, '_')
    if (!safeName) throw new AppError('INVALID_NAME', 'Invalid file name', 400)
    const targetRelPath = this.normalizeRelativePath(`${dirPath || ''}/${safeName}`)
    if (this.isProtectedPath(targetRelPath)) throw new AppError('PROTECTED_PATH', 'This path is protected', 403)
    if (file.size > config.maxFileSize) throw new AppError('FILE_TOO_LARGE', 'File is too large', 400)
    const target = this.resolvePath(targetRelPath)
    try {
      await stat(target)
      throw new AppError('ALREADY_EXISTS', 'File already exists', 409)
    } catch (err) {
      if (err instanceof AppError) throw err
    }

    await mkdir(dirname(target), { recursive: true })
    const buffer = Buffer.from(await file.arrayBuffer())
    await liveFileService.withWorkspaceMutationLock(() => atomicWriteFile(target, buffer))
    const node = await this.buildNode(target, DEFAULT_TREE_DEPTH)
    if (!node) throw new AppError('UPLOAD_FAILED', 'Failed to upload file', 500)
    this.emitFilesChanged('upload', node.path)
    return node
  }

  async getLatexCompileContext(filePath: string): Promise<{
    fullPath: string
    sourceRoot: string
    entryName: string
    relativePath: string
  }> {
    const relativePath = this.normalizeRelativePath(filePath)
    if (this.extensionFor(relativePath) !== '.tex') {
      throw new AppError('UNSUPPORTED_FILE', 'Only .tex files can be compiled', 400)
    }
    if (this.isProtectedPath(relativePath)) {
      throw new AppError('PROTECTED_PATH', 'This path is protected', 403)
    }

    const fullPath = this.resolvePath(relativePath)
    const entryStat = await this.assertExists(fullPath)
    if (!entryStat.isFile()) throw new AppError('NOT_FILE', 'Path is not a file', 400)

    return {
      fullPath,
      sourceRoot: dirname(fullPath),
      entryName: basename(fullPath),
      relativePath,
    }
  }

  async getFileForDownload(filePath: string): Promise<{ fullPath: string; size: number; mime: string; name: string }> {
    const fullPath = this.resolvePath(filePath)
    const entryStat = await this.assertExists(fullPath)
    if (!entryStat.isFile()) throw new AppError('NOT_FILE', 'Path is not a file', 400)
    return { fullPath, size: entryStat.size, mime: this.mimeFor(filePath), name: basename(filePath) }
  }

  async getOfficeFile(filePath: string): Promise<{ fullPath: string; size: number; mime: string; name: string }> {
    const file = await this.getFileForDownload(filePath)
    const ext = this.extensionFor(filePath)
    if (!OFFICE_EXTENSIONS.has(ext)) throw new AppError('UNSUPPORTED_FILE', 'Not an Office file', 400)
    return file
  }

  async getFilePath(filePath: string): Promise<string> {
    const fullPath = this.resolvePath(filePath)
    const entryStat = await this.assertExists(fullPath)
    if (!entryStat.isFile()) throw new AppError('NOT_FILE', 'Path is not a file', 400)
    const ext = this.extensionFor(filePath)
    if (!IMAGE_EXTENSIONS.has(ext)) throw new AppError('UNSUPPORTED_FILE', 'Not an image file', 400)
    return fullPath
  }
}

export const fileService = new FileService()
