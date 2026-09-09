import { Hono } from 'hono'
import { readFile, stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { spawn } from 'node:child_process'
import { Readable } from 'node:stream'
import { extname } from 'node:path'
import { fileService } from '../services/file.service.js'
import { liveFileService } from '../services/live-file.service.js'
import { piService } from '../services/pi.service.js'
import { isPiRuntimeResourcePath } from '../lib/data-sync-policy.js'
import { AppError } from '../lib/errors.js'

const files = new Hono()

const normalizePath = (path = '') => path.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')
const PROJECT_PRIVATE_ROOTS = new Set(['projects', '.project-history'])
const assertGlobalFilesPath = (path = '') => {
  const normalized = normalizePath(path)
  const root = normalized.split('/')[0]
  if (PROJECT_PRIVATE_ROOTS.has(root)) {
    throw new AppError('PROTECTED_PATH', 'Project workspaces are available only through /api/projects/:id/files', 403)
  }
  return normalized
}

const isPiConfigPath = (path = '') => isPiRuntimeResourcePath(normalizePath(path))

const reloadPiIfNeeded = async (reason: string, ...paths: Array<string | undefined | null>) => {
  if (paths.some((path) => path && isPiConfigPath(path))) await piService.reload(reason)
}

const officeViewModes = new Set(['html', 'text', 'outline', 'issues', 'stats'])
const OFFICE_VIEW_TIMEOUT_MS = 30_000
const OFFICE_VIEW_MAX_BYTES = 8 * 1024 * 1024

const systemOpenCommand = (fullPath: string): { command: string; args: string[] } => {
  if (process.platform === 'darwin') return { command: 'open', args: [fullPath] }
  if (process.platform === 'win32') return { command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process -LiteralPath $args[0]', fullPath] }
  return { command: 'xdg-open', args: [fullPath] }
}

const openWithSystemApp = (fullPath: string): Promise<void> => new Promise((resolve, reject) => {
  const { command, args } = systemOpenCommand(fullPath)
  const child = spawn(command, args, { detached: true, stdio: 'ignore' })
  let settled = false
  const finish = (err?: Error) => {
    if (settled) return
    settled = true
    if (err) reject(err)
    else resolve()
  }
  child.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return finish(new AppError('SYSTEM_OPEN_NOT_AVAILABLE', 'No system opener is available on this host', 503))
    finish(err)
  })
  child.on('spawn', () => { child.unref(); finish() })
})

const runOfficeView = (fullPath: string, mode: string): Promise<string> => new Promise((resolve, reject) => {
  const child = spawn('officecli', ['view', fullPath, mode], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, OFFICECLI_NO_AUTO_RESIDENT: '1' } })
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  let stdoutBytes = 0
  let stderrBytes = 0
  let settled = false
  const finish = (err?: Error, content?: string) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    if (err) reject(err)
    else resolve(content || '')
  }
  const timer = setTimeout(() => { child.kill('SIGTERM'); finish(new AppError('OFFICECLI_TIMEOUT', 'officecli preview timed out', 504)) }, OFFICE_VIEW_TIMEOUT_MS)
  child.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return finish(new AppError('OFFICECLI_NOT_AVAILABLE', 'officecli is not installed or not in PATH', 503))
    finish(err)
  })
  child.stdout.on('data', (chunk: Buffer) => {
    stdoutBytes += chunk.length
    if (stdoutBytes > OFFICE_VIEW_MAX_BYTES) { child.kill('SIGTERM'); finish(new AppError('OFFICECLI_OUTPUT_TOO_LARGE', 'Office preview output is too large', 413)); return }
    stdout.push(chunk)
  })
  child.stderr.on('data', (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes <= 512 * 1024) stderr.push(chunk) })
  child.on('close', (code) => {
    if (settled) return
    const output = Buffer.concat(stdout).toString('utf-8')
    if (code === 0) return finish(undefined, output)
    const detail = Buffer.concat(stderr).toString('utf-8').trim()
    if (detail) console.warn('[files] officecli preview failed:', detail)
    finish(new AppError('OFFICECLI_FAILED', 'officecli failed to render preview', 500))
  })
})

files.get('/', async (c) => {
  const path = assertGlobalFilesPath(c.req.query('path') || '')
  const tree = await fileService.getFileTree(path)
  const visible = path ? tree : tree.filter((node: any) => !PROJECT_PRIVATE_ROOTS.has(node.name) && !PROJECT_PRIVATE_ROOTS.has(node.path))
  return c.json({ files: visible })
})

files.get('/content', async (c) => {
  const raw = c.req.query('path')
  if (!raw) throw new AppError('MISSING_PATH', 'Path is required', 400)
  const path = assertGlobalFilesPath(raw)
  if (c.req.query('refreshLive') === '1') await liveFileService.handleDiskChange(path)
  return c.json(await fileService.getFileContent(path))
})

files.get('/office/view', async (c) => {
  const raw = c.req.query('path')
  const mode = c.req.query('mode') || 'html'
  if (!raw) throw new AppError('MISSING_PATH', 'Path is required', 400)
  const path = assertGlobalFilesPath(raw)
  if (!officeViewModes.has(mode)) throw new AppError('INVALID_MODE', 'Unsupported Office preview mode', 400)
  const file = await fileService.getOfficeFile(path)
  return c.json({ mode, content: await runOfficeView(file.fullPath, mode) })
})

files.put('/content', async (c) => {
  const { path: raw, content } = await c.req.json()
  if (!raw) throw new AppError('MISSING_PATH', 'Path is required', 400)
  const path = assertGlobalFilesPath(raw)
  await fileService.saveFileContent(path, String(content ?? ''))
  await reloadPiIfNeeded('files:save', path)
  return c.json({ message: 'Saved' })
})

files.post('/file', async (c) => {
  const { path: raw, content } = await c.req.json()
  if (!raw) throw new AppError('MISSING_PATH', 'Path is required', 400)
  const path = assertGlobalFilesPath(raw)
  const file = await fileService.createFile(path, String(content ?? ''))
  await reloadPiIfNeeded('files:create-file', path)
  return c.json({ file }, 201)
})

files.post('/open-system', async (c) => {
  const { path: raw } = await c.req.json()
  if (!raw) throw new AppError('MISSING_PATH', 'Path is required', 400)
  const path = assertGlobalFilesPath(raw)
  const file = await fileService.getFileForDownload(path)
  await openWithSystemApp(file.fullPath)
  return c.json({ message: 'Opened' })
})

files.post('/directory', async (c) => {
  const { path: raw } = await c.req.json()
  if (!raw) throw new AppError('MISSING_PATH', 'Path is required', 400)
  const path = assertGlobalFilesPath(raw)
  const directory = await fileService.createDirectory(path)
  await reloadPiIfNeeded('files:create-directory', path)
  return c.json({ file: directory }, 201)
})

files.patch('/path', async (c) => {
  const { from: rawFrom, to: rawTo } = await c.req.json()
  if (!rawFrom || !rawTo) throw new AppError('MISSING_PATH', 'Source and target paths are required', 400)
  const from = assertGlobalFilesPath(rawFrom)
  const to = assertGlobalFilesPath(rawTo)
  const file = await fileService.renamePath(from, to)
  await reloadPiIfNeeded('files:rename', from, to)
  return c.json({ file })
})

files.delete('/path', async (c) => {
  const raw = c.req.query('path')
  if (!raw) throw new AppError('MISSING_PATH', 'Path is required', 400)
  const path = assertGlobalFilesPath(raw)
  await fileService.deletePath(path)
  await reloadPiIfNeeded('files:delete', path)
  return c.json({ message: 'Deleted' })
})

files.post('/upload', async (c) => {
  const formData = await c.req.formData()
  const file = formData.get('file') as File | null
  const path = assertGlobalFilesPath(String(formData.get('path') || ''))
  if (!file) throw new AppError('MISSING_FILE', 'File is required', 400)
  const uploaded = await fileService.uploadFile(path, file)
  await reloadPiIfNeeded('files:upload', uploaded.path)
  return c.json({ file: uploaded }, 201)
})

files.get('/download', async (c) => {
  const raw = c.req.query('path')
  if (!raw) throw new AppError('MISSING_PATH', 'Path is required', 400)
  const file = await fileService.getFileForDownload(assertGlobalFilesPath(raw))
  c.header('Content-Type', file.mime)
  c.header('Content-Length', String(file.size))
  c.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`)
  return c.body(Readable.toWeb(createReadStream(file.fullPath)) as any)
})

files.get('/image', async (c) => {
  const raw = c.req.query('path')
  if (!raw) throw new AppError('MISSING_PATH', 'Path is required', 400)
  const path = assertGlobalFilesPath(raw)
  const fullPath = await fileService.getFilePath(path)
  const fileStat = await stat(fullPath)
  const buffer = await readFile(fullPath)
  const ext = extname(path).toLowerCase()
  const mimeTypes: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' }
  c.header('Content-Type', mimeTypes[ext] || 'application/octet-stream')
  c.header('Content-Length', fileStat.size.toString())
  c.header('Cache-Control', 'private, no-store')
  return c.body(buffer)
})

export default files
