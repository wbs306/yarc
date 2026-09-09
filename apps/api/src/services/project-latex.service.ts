import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { cp, lstat, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { basename, extname, join, relative, resolve, sep } from 'node:path'
import { spawn } from 'node:child_process'
import type { LatexDiagnostic, ProjectLatexTarget } from '@yarc/shared'
import { config } from '../lib/config.js'
import { AppError } from '../lib/errors.js'
import { normalizeProjectRelativePath, resolveProjectPath, resolveProjectRoot } from '../lib/project-path.js'
import { projectHistoryService } from './project-history.service.js'
import { projectGitService } from './project-git.service.js'
import { projectLiveFileManager } from './project-live-file.service.js'

export type ProjectLatexBuildStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
export interface ProjectLatexBuild {
  id: string
  projectId: string
  targetId: string
  targetName: string
  entry: string
  sourceRoot: string
  engine: ProjectLatexTarget['engine']
  status: ProjectLatexBuildStatus
  createdAt: string
  startedAt?: string
  completedAt?: string
  durationMs?: number
  exitCode?: number | null
  error?: string
  log: string
  pdfPath?: string
  synctexPath?: string
  diagnostics: LatexDiagnostic[]
  checkpointId?: string
}

const LATEX_ENGINES = new Set<ProjectLatexTarget['engine']>(['pdflatex', 'xelatex', 'lualatex'])
const TARGET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

const runDocker = (args: string[], timeoutMs: number) => new Promise<{ code: number; stdout: string; stderr: string }>((resolveRun, reject) => {
  const child = spawn(config.latexDockerCommand, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  const cap = Math.max(1024, config.latexMaxLogBytes)
  const timer = setTimeout(() => {
    child.kill('SIGTERM')
    setTimeout(() => child.kill('SIGKILL'), 2_000).unref?.()
    reject(new AppError('LATEX_BUILD_TIMEOUT', 'LaTeX build timed out', 504))
  }, timeoutMs)
  timer.unref?.()
  child.stdout.on('data', chunk => { if (stdout.length < cap) stdout += chunk.toString().slice(0, cap - stdout.length) })
  child.stderr.on('data', chunk => { if (stderr.length < cap) stderr += chunk.toString().slice(0, cap - stderr.length) })
  child.once('error', error => { clearTimeout(timer); reject(error) })
  child.once('close', code => { clearTimeout(timer); resolveRun({ code: code ?? -1, stdout, stderr }) })
})

const diagnosticLines = (log: string): LatexDiagnostic[] => {
  const out: LatexDiagnostic[] = []
  const seen = new Set<string>()
  for (const line of log.split(/\r?\n/)) {
    const fileLine = line.match(/^(.+?\.tex):(\d+):\s*(.+)$/)
    const bang = line.match(/^!\s+(.+)$/)
    if (!fileLine && !bang) continue
    const item: LatexDiagnostic = fileLine
      ? { severity: /warning/i.test(fileLine[3]) ? 'warning' : 'error', file: fileLine[1], line: Number(fileLine[2]), message: fileLine[3] }
      : { severity: 'error', message: bang![1] }
    const key = JSON.stringify(item)
    if (!seen.has(key)) { seen.add(key); out.push(item) }
    if (out.length >= 200) break
  }
  return out
}

export class ProjectLatexService {
  private builds = new Map<string, ProjectLatexBuild>()
  private active = 0
  private queue: string[] = []

  validateTargetSettings(input: { defaultTarget?: unknown; targets?: unknown }) {
    if (!Array.isArray(input.targets)) throw new AppError('VALIDATION_ERROR', 'LaTeX targets must be an array', 400)
    if (input.targets.length > 50) throw new AppError('VALIDATION_ERROR', 'Too many LaTeX targets', 400)

    const ids = new Set<string>()
    const targets = input.targets.map((raw, index): ProjectLatexTarget => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AppError('VALIDATION_ERROR', `Invalid LaTeX target at index ${index}`, 400)
      const value = raw as Record<string, unknown>
      const id = typeof value.id === 'string' ? value.id.trim() : ''
      const name = typeof value.name === 'string' ? value.name.trim() : ''
      const engine = typeof value.engine === 'string' ? value.engine.trim() : ''
      const rawEntry = typeof value.entry === 'string' ? value.entry.trim() : ''
      const rawSourceRoot = typeof value.sourceRoot === 'string' ? value.sourceRoot.trim() : '.'

      if (!TARGET_ID_PATTERN.test(id)) throw new AppError('VALIDATION_ERROR', `Invalid LaTeX target id at index ${index}`, 400)
      if (ids.has(id)) throw new AppError('VALIDATION_ERROR', `Duplicate LaTeX target id: ${id}`, 400)
      ids.add(id)
      if (!name || name.length > 120) throw new AppError('VALIDATION_ERROR', `Invalid LaTeX target name: ${id}`, 400)
      if (!LATEX_ENGINES.has(engine as ProjectLatexTarget['engine'])) throw new AppError('VALIDATION_ERROR', `Unsupported LaTeX engine for target ${id}`, 400)

      const sourceRootNormalized = normalizeProjectRelativePath(rawSourceRoot || '.')
      const entry = normalizeProjectRelativePath(rawEntry)
      if (!entry || extname(entry).toLowerCase() !== '.tex') throw new AppError('INVALID_LATEX_ENTRY', `LaTeX entry for target ${id} must be a .tex file`, 400)
      if (sourceRootNormalized && !entry.startsWith(`${sourceRootNormalized}/`)) {
        throw new AppError('INVALID_LATEX_ENTRY', `LaTeX entry for target ${id} must be inside sourceRoot`, 400)
      }

      return {
        id,
        name,
        entry,
        sourceRoot: sourceRootNormalized || '.',
        engine: engine as ProjectLatexTarget['engine'],
      }
    })

    const requestedDefault = typeof input.defaultTarget === 'string' ? input.defaultTarget.trim() : ''
    if (requestedDefault && !ids.has(requestedDefault)) throw new AppError('VALIDATION_ERROR', 'defaultTarget must reference a configured LaTeX target', 400)
    return { defaultTarget: requestedDefault || targets[0]?.id || null, targets }
  }

  async targets(projectId: string) {
    const { project } = await resolveProjectRoot(projectId)
    const latex = ((project.settings || {}) as any).latex || {}
    if (!Array.isArray(latex.targets)) return { defaultTarget: null, targets: [] as ProjectLatexTarget[] }
    return this.validateTargetSettings({ defaultTarget: latex.defaultTarget, targets: latex.targets })
  }

  private async target(projectId: string, targetId: string) {
    const { targets } = await this.targets(projectId)
    const target = targets.find(item => item.id === targetId)
    if (!target) throw new AppError('PROJECT_LATEX_TARGET_NOT_FOUND', 'LaTeX target not found', 404)
    return target
  }

  async startBuild(projectId: string, targetId: string) {
    if (!config.latexEnabled) throw new AppError('LATEX_DISABLED', 'LaTeX builds are disabled', 503)
    const target = await this.target(projectId, targetId)
    const sourceRoot = normalizeProjectRelativePath(target.sourceRoot || '.')
    const entry = normalizeProjectRelativePath(target.entry)
    const source = await resolveProjectPath(projectId, sourceRoot)
    const entryResolved = await resolveProjectPath(projectId, entry)
    const relEntry = relative(source.fullPath, entryResolved.fullPath)
    if (!relEntry || relEntry.startsWith(`..${sep}`) || relEntry === '..' || resolve(source.fullPath, relEntry) !== entryResolved.fullPath) {
      throw new AppError('INVALID_LATEX_ENTRY', 'LaTeX entry must be inside sourceRoot', 400)
    }
    const entryInfo = await lstat(entryResolved.fullPath)
    if (!entryInfo.isFile() || entryInfo.isSymbolicLink()) throw new AppError('INVALID_LATEX_ENTRY', 'LaTeX entry must be a regular file', 400)

    const build: ProjectLatexBuild = {
      id: randomUUID(), projectId, targetId, targetName: target.name || target.id,
      entry, sourceRoot: sourceRoot || '.', engine: target.engine,
      status: 'queued', createdAt: new Date().toISOString(), log: '', diagnostics: [],
    }
    this.builds.set(build.id, build)
    this.queue.push(build.id)
    void this.drain()
    return this.publicBuild(build)
  }

  private async drain() {
    while (this.active < Math.max(1, config.latexMaxConcurrent) && this.queue.length) {
      const id = this.queue.shift()!
      const build = this.builds.get(id)
      if (!build || build.status !== 'queued') continue
      this.active++
      void this.runBuild(build).finally(() => { this.active--; void this.drain() })
    }
  }

  private async snapshot(sourceRoot: string, targetDir: string) {
    let totalBytes = 0
    let totalFiles = 0
    const excluded = new Set(['.git', '.pi', 'node_modules'])
    const walk = async (source: string, dest: string) => {
      await mkdir(dest, { recursive: true })
      for (const item of await readdir(source, { withFileTypes: true })) {
        if (excluded.has(item.name)) continue
        const from = join(source, item.name)
        const to = join(dest, item.name)
        const info = await lstat(from)
        if (info.isSymbolicLink()) throw new AppError('LATEX_UNSAFE_SOURCE', `LaTeX source contains symlink: ${relative(sourceRoot, from)}`, 400)
        if (info.isDirectory()) { await walk(from, to); continue }
        if (!info.isFile()) continue
        if (info.nlink > 1) throw new AppError('LATEX_UNSAFE_SOURCE', `LaTeX source contains hardlink: ${relative(sourceRoot, from)}`, 400)
        totalFiles++
        totalBytes += info.size
        if (totalFiles > config.latexMaxSourceFiles || totalBytes > config.latexMaxSourceBytes) throw new AppError('LATEX_SOURCE_TOO_LARGE', 'LaTeX source exceeds configured limits', 413)
        await cp(from, to, { dereference: false, force: false })
      }
    }
    await walk(sourceRoot, targetDir)
  }

  private async runBuild(build: ProjectLatexBuild) {
    const started = Date.now()
    build.status = 'running'
    build.startedAt = new Date().toISOString()
    const outputRoot = join(config.latexOutputDir, 'projects', build.projectId, build.id)
    const snapshotDir = join(outputRoot, 'src')
    const artifactDir = join(outputRoot, 'out')
    try {
      const target = await this.target(build.projectId, build.targetId)
      const source = await resolveProjectPath(build.projectId, target.sourceRoot || '.')
      const entry = await resolveProjectPath(build.projectId, target.entry)
      const relEntry = relative(source.fullPath, entry.fullPath).replace(/\\/g, '/')

      await projectLiveFileManager.flushProject(build.projectId, normalizeProjectRelativePath(target.sourceRoot || '.'))
      await projectHistoryService.flushPending(build.projectId)
      const git = await projectGitService.status(build.projectId).catch(() => null)
      const checkpoint = await projectHistoryService.checkpoint(build.projectId, {
        kind: 'build',
        metadata: { target: build.targetId, engine: build.engine, git: git ? { branch: git.branch, head: git.head } : null },
        forceBoundary: true,
      })
      if (checkpoint) build.checkpointId = checkpoint.id

      await rm(outputRoot, { recursive: true, force: true })
      await mkdir(snapshotDir, { recursive: true })
      await mkdir(artifactDir, { recursive: true })
      await this.snapshot(source.fullPath, snapshotDir)

      const engineFlag = build.engine === 'xelatex' ? '-xelatex' : build.engine === 'lualatex' ? '-lualatex' : '-pdf'
      const args = [
        'run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
        '--memory', `${config.latexMemoryMb}m`, '--cpus', String(config.latexCpus), '--pids-limit', String(config.latexPidsLimit),
        '--tmpfs', `/tmp:rw,noexec,nosuid,size=${config.latexTmpfsMb}m`,
        '-v', `${snapshotDir}:/src:ro`, '-v', `${artifactDir}:/out:rw`, '-w', '/src',
        config.latexDockerImage, 'latexmk', engineFlag, '-interaction=nonstopmode', '-file-line-error', '-synctex=1', '-halt-on-error', '-outdir=/out', relEntry,
      ]
      const result = await runDocker(args, config.latexBuildTimeoutMs)
      build.exitCode = result.code
      build.log = `${result.stdout}${result.stderr ? `\n${result.stderr}` : ''}`.slice(0, config.latexMaxLogBytes)
      build.diagnostics = diagnosticLines(build.log)
      const stem = basename(relEntry, extname(relEntry))
      const pdfPath = join(artifactDir, `${stem}.pdf`)
      const synctexPath = join(artifactDir, `${stem}.synctex.gz`)
      if (result.code !== 0) throw new AppError('LATEX_BUILD_FAILED', 'LaTeX build failed', 422)
      const pdfInfo = await stat(pdfPath).catch(() => null)
      if (!pdfInfo?.isFile()) throw new AppError('LATEX_BUILD_FAILED', 'LaTeX build completed without a PDF', 422)
      build.pdfPath = pdfPath
      if ((await stat(synctexPath).catch(() => null))?.isFile()) build.synctexPath = synctexPath
      build.status = 'completed'
      if (build.checkpointId) await projectHistoryService.updateCheckpointMetadata(build.projectId, build.checkpointId, { buildId: build.id, success: true })
    } catch (error: any) {
      build.status = build.status === 'cancelled' ? 'cancelled' : 'failed'
      build.error = error?.message || 'LaTeX build failed'
      if (build.checkpointId) await projectHistoryService.updateCheckpointMetadata(build.projectId, build.checkpointId, { buildId: build.id, success: false, error: build.error }).catch(() => undefined)
    } finally {
      build.completedAt = new Date().toISOString()
      build.durationMs = Date.now() - started
      await rm(join(outputRoot, 'src'), { recursive: true, force: true }).catch(() => undefined)
    }
  }

  private publicBuild(build: ProjectLatexBuild) {
    const { log, pdfPath, synctexPath, ...result } = build
    return { ...result, pdfAvailable: !!pdfPath, synctexAvailable: !!synctexPath }
  }

  getBuild(projectId: string, buildId: string) {
    const build = this.builds.get(buildId)
    if (!build || build.projectId !== projectId) throw new AppError('NOT_FOUND', 'LaTeX build not found', 404)
    return this.publicBuild(build)
  }

  getLog(projectId: string, buildId: string) {
    const build = this.builds.get(buildId)
    if (!build || build.projectId !== projectId) throw new AppError('NOT_FOUND', 'LaTeX build not found', 404)
    return { id: build.id, log: build.log, diagnostics: build.diagnostics }
  }

  getPdf(projectId: string, buildId: string) {
    const build = this.builds.get(buildId)
    if (!build || build.projectId !== projectId || !build.pdfPath) throw new AppError('NOT_FOUND', 'Build PDF not found', 404)
    return { path: build.pdfPath, stream: createReadStream(build.pdfPath) }
  }
}

export const projectLatexService = new ProjectLatexService()
