import { Hono } from 'hono'
import { createReadStream } from 'node:fs'
import { spawn } from 'node:child_process'
import { Readable } from 'node:stream'
import { projectService } from '../services/project.service.js'
import { projectFileService } from '../services/project-file.service.js'
import { projectGitService } from '../services/project-git.service.js'
import { projectHistoryService } from '../services/project-history.service.js'
import { projectLatexService } from '../services/project-latex.service.js'
import { AppError } from '../lib/errors.js'
import { normalizeProjectHistorySettings } from '../lib/project-history-settings.js'

const projects = new Hono()
const body = async (c: any) => await c.req.json().catch(() => ({})) as Record<string, any>
const id = (c: any) => c.req.param('id')

const systemOpenCommand = (fullPath: string): { command: string; args: string[] } => {
  if (process.platform === 'darwin') return { command: 'open', args: [fullPath] }
  if (process.platform === 'win32') return { command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process -LiteralPath $args[0]', fullPath] }
  return { command: 'xdg-open', args: [fullPath] }
}

const openWithSystemApp = (fullPath: string): Promise<void> => new Promise((resolve, reject) => {
  const { command, args } = systemOpenCommand(fullPath)
  const child = spawn(command, args, { detached: true, stdio: 'ignore' })
  let settled = false
  const finish = (error?: Error) => {
    if (settled) return
    settled = true
    if (error) reject(error)
    else resolve()
  }
  child.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return finish(new AppError('SYSTEM_OPEN_NOT_AVAILABLE', 'No system opener is available on this host', 503))
    finish(error)
  })
  child.on('spawn', () => {
    child.unref()
    finish()
  })
})

projects.get('/', async (c) => c.json({ projects: await projectService.list({ archived: c.req.query('archived') === 'true' }) }))
projects.post('/', async (c) => c.json({ project: await projectService.create(await body(c) as any) }, 201))
projects.get('/:id', async (c) => c.json({ project: await projectService.get(id(c)) }))
projects.patch('/:id', async (c) => {
  const input = await body(c)
  if ('directoryName' in input || 'absolutePath' in input || 'path' in input) throw new AppError('VALIDATION_ERROR', 'Project filesystem identity is immutable', 400)
  return c.json({ project: await projectService.update(id(c), input) })
})
projects.post('/:id/archive', async (c) => c.json({ project: await projectService.archive(id(c)) }))
projects.post('/:id/unarchive', async (c) => c.json({ project: await projectService.unarchive(id(c)) }))
projects.delete('/:id', async (c) => c.json(await projectService.delete(id(c))))

projects.get('/:id/files', async (c) => c.json({ files: await projectFileService.getFileTree(id(c), c.req.query('path') || '') }))
projects.get('/:id/files/content', async (c) => {
  const path = c.req.query('path') || ''
  if (!path) throw new AppError('MISSING_PATH', 'Path is required', 400)
  return c.json(await projectFileService.getFileContent(id(c), path))
})
projects.put('/:id/files/content', async (c) => {
  const input = await body(c)
  if (typeof input.path !== 'string' || typeof input.content !== 'string') throw new AppError('VALIDATION_ERROR', 'path and content are required', 400)
  return c.json(await projectFileService.saveFileContent(id(c), input.path, input.content))
})
projects.post('/:id/files/file', async (c) => {
  const input = await body(c)
  if (typeof input.path !== 'string') throw new AppError('MISSING_PATH', 'Path is required', 400)
  return c.json(await projectFileService.createFile(id(c), input.path, typeof input.content === 'string' ? input.content : ''), 201)
})
projects.post('/:id/files/directory', async (c) => {
  const input = await body(c)
  if (typeof input.path !== 'string') throw new AppError('MISSING_PATH', 'Path is required', 400)
  return c.json(await projectFileService.createDirectory(id(c), input.path), 201)
})
projects.post('/:id/files/open-system', async (c) => {
  const input = await body(c)
  if (typeof input.path !== 'string' || !input.path) throw new AppError('MISSING_PATH', 'Path is required', 400)
  const file = await projectFileService.getSystemOpenPath(id(c), input.path)
  await openWithSystemApp(file.path)
  return c.json({ message: 'Opened' })
})
projects.patch('/:id/files/path', async (c) => {
  const input = await body(c)
  if (typeof input.from !== 'string' || typeof input.to !== 'string') throw new AppError('VALIDATION_ERROR', 'from and to are required', 400)
  return c.json(await projectFileService.renamePath(id(c), input.from, input.to))
})
projects.delete('/:id/files/path', async (c) => {
  const path = c.req.query('path') || ''
  if (!path) throw new AppError('MISSING_PATH', 'Path is required', 400)
  return c.json(await projectFileService.deletePath(id(c), path))
})
projects.post('/:id/files/upload', async (c) => {
  const form = await c.req.formData()
  const file = form.get('file')
  if (!(file instanceof File)) throw new AppError('VALIDATION_ERROR', 'file is required', 400)
  return c.json(await projectFileService.upload(id(c), String(form.get('path') || ''), file), 201)
})
projects.get('/:id/files/download', async (c) => {
  const path = c.req.query('path') || ''
  if (!path) throw new AppError('MISSING_PATH', 'Path is required', 400)
  const file = await projectFileService.getDownload(id(c), path)
  c.header('Content-Type', file.mime)
  c.header('Content-Length', String(file.size))
  c.header('Content-Disposition', `attachment; filename="${file.name.replace(/[\r\n\"]/g, '_')}"`)
  return c.body(Readable.toWeb(createReadStream(file.path)) as any)
})
projects.get('/:id/files/image', async (c) => {
  const path = c.req.query('path') || ''
  if (!path) throw new AppError('MISSING_PATH', 'Path is required', 400)
  const file = await projectFileService.getDownload(id(c), path)
  if (!file.mime.startsWith('image/')) throw new AppError('UNSUPPORTED_FILE', 'Not an image', 400)
  c.header('Content-Type', file.mime)
  c.header('Content-Length', String(file.size))
  return c.body(Readable.toWeb(createReadStream(file.path)) as any)
})

projects.get('/:id/git/status', async (c) => c.json({ status: await projectGitService.status(id(c)) }))
projects.get('/:id/git/log', async (c) => c.json({ commits: await projectGitService.log(id(c), Number(c.req.query('limit') || 100)) }))
projects.get('/:id/git/diff', async (c) => c.json({ diff: await projectGitService.diff(id(c), { staged: c.req.query('staged') === 'true', path: c.req.query('path') }) }))
projects.get('/:id/git/remotes', async (c) => c.json({ remotes: await projectGitService.remotes(id(c)) }))
projects.post('/:id/git/stage', async (c) => c.json({ status: await projectGitService.stage(id(c), (await body(c)).paths || []) }))
projects.post('/:id/git/unstage', async (c) => c.json({ status: await projectGitService.unstage(id(c), (await body(c)).paths || []) }))
projects.post('/:id/git/commit', async (c) => c.json(await projectGitService.commit(id(c), String((await body(c)).message || ''))))
projects.get('/:id/git/branches', async (c) => c.json({ branches: await projectGitService.branches(id(c)) }))
projects.post('/:id/git/branches', async (c) => c.json({ branches: await projectGitService.createBranch(id(c), String((await body(c)).name || '')) }, 201))
projects.post('/:id/git/branches/switch', async (c) => c.json({ status: await projectGitService.switchBranch(id(c), String((await body(c)).name || '')) }))

projects.get('/:id/history/settings', async (c) => {
  const project = await projectService.get(id(c))
  return c.json({ settings: normalizeProjectHistorySettings(((project.settings || {}) as any).history) })
})
projects.put('/:id/history/settings', async (c) => {
  await projectHistoryService.flushPending(id(c))
  const input = await body(c)
  const history = normalizeProjectHistorySettings(input.settings ?? input)
  const project = await projectService.get(id(c))
  const settings = { ...((project.settings || {}) as any), history }
  await projectService.update(id(c), { settings })
  return c.json({ settings: history })
})
projects.get('/:id/history', async (c) => c.json({ checkpoints: await projectHistoryService.listCheckpoints(id(c), Number(c.req.query('limit') || 200)) }))
projects.get('/:id/history/files', async (c) => {
  const path = c.req.query('path') || ''
  if (!path) throw new AppError('MISSING_PATH', 'Path is required', 400)
  return c.json({ revisions: await projectHistoryService.listFileHistory(id(c), path) })
})
projects.get('/:id/history/checkpoints/:checkpointId', async (c) => c.json({ checkpoint: await projectHistoryService.getCheckpoint(id(c), c.req.param('checkpointId')) }))
projects.get('/:id/history/revisions/:revisionId', async (c) => c.json(await projectHistoryService.getRevisionContent(id(c), c.req.param('revisionId'))))
projects.post('/:id/history/checkpoints', async (c) => {
  const input = await body(c)
  return c.json({ checkpoint: await projectHistoryService.checkpoint(id(c), { kind: 'manual', paths: input.paths, label: input.label, metadata: input.metadata, forceBoundary: true }) }, 201)
})
projects.post('/:id/history/checkpoints/:checkpointId/pin', async (c) => {
  const input = await body(c)
  return c.json({ checkpoint: await projectHistoryService.pinCheckpoint(id(c), c.req.param('checkpointId'), input.pinned !== false) })
})
projects.post('/:id/history/revisions/:revisionId/restore', async (c) => c.json(await projectHistoryService.restoreFileRevision(id(c), c.req.param('revisionId'))))
projects.post('/:id/history/checkpoints/:checkpointId/restore', async (c) => c.json(await projectHistoryService.restoreWritingCheckpoint(id(c), c.req.param('checkpointId'))))

projects.get('/:id/latex/targets', async (c) => c.json(await projectLatexService.targets(id(c))))
projects.put('/:id/latex/targets', async (c) => {
  const input = await body(c)
  const latex = projectLatexService.validateTargetSettings({ defaultTarget: input.defaultTarget, targets: input.targets })
  const project = await projectService.get(id(c))
  const settings = { ...((project.settings || {}) as any), latex }
  return c.json({ project: await projectService.update(id(c), { settings }) })
})
projects.post('/:id/latex/builds', async (c) => {
  const input = await body(c)
  if (typeof input.targetId !== 'string' || !input.targetId) throw new AppError('PROJECT_LATEX_TARGET_NOT_FOUND', 'targetId is required', 400)
  return c.json({ build: await projectLatexService.startBuild(id(c), input.targetId) }, 202)
})
projects.get('/:id/latex/builds/:buildId', async (c) => c.json({ build: projectLatexService.getBuild(id(c), c.req.param('buildId')) }))
projects.get('/:id/latex/builds/:buildId/log', async (c) => c.json(projectLatexService.getLog(id(c), c.req.param('buildId'))))
projects.get('/:id/latex/builds/:buildId/pdf', async (c) => {
  const pdf = projectLatexService.getPdf(id(c), c.req.param('buildId'))
  c.header('Content-Type', 'application/pdf')
  c.header('Cache-Control', 'private, no-store')
  return c.body(Readable.toWeb(pdf.stream) as any)
})

export default projects
