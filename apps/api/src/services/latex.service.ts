import { access, copyFile, lstat, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { spawn, type ChildProcess } from 'node:child_process'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { config } from '../lib/config.js'
import { AppError } from '../lib/errors.js'
import { fileService } from './file.service.js'
import { liveFileService } from './live-file.service.js'
import type {
  LatexBuild,
  LatexBuildLog,
  LatexDiagnostic,
  LatexEngine,
  LatexSyncTexBackwardResult,
  LatexSyncTexForwardResult,
  LatexSyncTexRect,
} from '@yarc/shared'

const ENGINES: LatexEngine[] = ['pdflatex', 'xelatex', 'lualatex']
const ENGINE_FLAGS: Record<LatexEngine, string> = {
  pdflatex: '-pdf',
  xelatex: '-xelatex',
  lualatex: '-lualatex',
}
const MAX_SYNC_TEX_OUTPUT_BYTES = 512 * 1024
const EXCLUDED_SOURCE_NAMES = new Set([
  '.git',
  '.pi',
  'papers',
  'backgrounds',
  'temporary-pdfs',
  'node_modules',
])

export interface LatexCompileOptions {
  path: string
  engine?: LatexEngine
}

interface LatexBuildJob extends LatexBuild {
  jobDir: string
  sourceDir: string
  outputDir: string
  entryName: string
  pdfPath: string
  synctexPath: string
  logPath: string
  containerName: string
  sourceFiles: number
  sourceBytes: number
  logText: string
  child?: ChildProcess
  cancelReason?: 'user' | 'timeout'
}

interface SourceSnapshot {
  files: number
  bytes: number
}

const positiveInt = (value: number, fallback: number, minimum: number) => {
  return Number.isFinite(value) && value >= minimum ? Math.floor(value) : fallback
}

const normalizedPath = (value: string) => value.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')

const isSafeRelativePath = (value: string) => {
  const normalized = normalizedPath(value)
  return !!normalized && !normalized.split('/').some((segment) => segment === '..' || segment === '.')
}

const fileExists = async (path: string) => {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

const parseNumber = (value: string | undefined) => {
  if (!value) return undefined
  const parsed = Number(value.trim())
  return Number.isFinite(parsed) ? parsed : undefined
}

const parseDiagnostics = (log: string): LatexDiagnostic[] => {
  const diagnostics: LatexDiagnostic[] = []
  const seen = new Set<string>()
  let pendingError = ''

  const add = (diagnostic: LatexDiagnostic) => {
    const key = `${diagnostic.severity}:${diagnostic.file || ''}:${diagnostic.line || ''}:${diagnostic.message}`
    if (seen.has(key)) return
    seen.add(key)
    diagnostics.push(diagnostic)
  }

  for (const rawLine of log.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue

    if (line.startsWith('!')) {
      pendingError = line.slice(1).trim()
      continue
    }

    const location = rawLine.match(/^(?:\s*)([^:\n]+):(\d+):\s*(.*)$/)
    if (location) {
      const [, file, lineNumber, message] = location
      const cleanMessage = message.trim() || pendingError || 'LaTeX error'
      const severity: LatexDiagnostic['severity'] = /warning/i.test(cleanMessage) ? 'warning' : 'error'
      add({ severity, file: normalizedPath(file), line: Number(lineNumber), message: cleanMessage })
      pendingError = ''
      continue
    }

    const sourceLine = rawLine.match(/^\s*l\.(\d+)\s*(.*)$/)
    if (sourceLine && pendingError) {
      add({ severity: 'error', line: Number(sourceLine[1]), message: pendingError })
      pendingError = ''
      continue
    }

    const warning = rawLine.match(/^\s*(?:LaTeX|Package|Class)\s+[^:]*Warning:\s*(.*)$/i)
    if (warning) add({ severity: 'warning', message: warning[1].trim() })
  }

  if (pendingError) add({ severity: 'error', message: pendingError })
  return diagnostics.slice(0, 200)
}

const parseSyncTexFields = (raw: string) => {
  const fields = new Map<string, string[]>()
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z]+):\s*(.*)$/)
    if (!match) continue
    const values = fields.get(match[1]) || []
    values.push(match[2])
    fields.set(match[1], values)
  }
  return fields
}

const firstNumber = (fields: Map<string, string[]>, ...keys: string[]) => {
  for (const key of keys) {
    const value = parseNumber(fields.get(key)?.[0])
    if (value !== undefined) return value
  }
  return undefined
}

export const parseSyncTexForwardOutput = (
  raw: string,
  file: string,
  line: number,
  column: number,
): LatexSyncTexForwardResult => {
  // Each Page starts a result record. Keep fields within that record so a
  // missing value cannot accidentally be borrowed from the next match.
  const records = raw.split(/(?=^Page:)/m)
    .filter((record) => record.startsWith('Page:'))
    .map(parseSyncTexFields)
  const rectangles: LatexSyncTexRect[] = []
  let firstRect: LatexSyncTexRect | undefined
  const seen = new Set<string>()
  for (const [index, fields] of records.entries()) {
    const page = firstNumber(fields, 'Page')
    const h = firstNumber(fields, 'h')
    const v = firstNumber(fields, 'v')
    const w = firstNumber(fields, 'W')
    const height = firstNumber(fields, 'H')
    if (page === undefined || !Number.isInteger(page) || page < 1
      || h === undefined || v === undefined || w === undefined
      || height === undefined || height <= 0 || w === 0) continue
    // SyncTeX CLI emits v = baseline + depth and H = height + depth:
    // its box grows upwards, whereas CSS rectangles grow downwards.
    // https://github.com/TeX-Live/texlive-source/blob/trunk/texk/web2c/synctexdir/synctex_main.c
    const rect = { page, x: h, y: v - height, width: Math.abs(w), height }
    if (index === 0) firstRect = rect
    const key = JSON.stringify(rect)
    if (!seen.has(key)) {
      seen.add(key)
      rectangles.push(rect)
    }
  }
  const fields = records[0] || new Map<string, string[]>()
  const page = firstNumber(fields, 'Page')
  const x = firstNumber(fields, 'x', 'h')
  const y = firstNumber(fields, 'y', 'v')
  const boxX = firstRect?.x
  const boxY = firstRect?.y
  const width = firstRect?.width
  const height = firstRect?.height
  return {
    direction: 'forward',
    file,
    line,
    column,
    ...(page !== undefined ? { page } : {}),
    ...(x !== undefined ? { x } : {}),
    ...(y !== undefined ? { y } : {}),
    ...(boxX !== undefined ? { boxX } : {}),
    ...(boxY !== undefined ? { boxY } : {}),
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    rectangles,
    raw,
  }
}

const mapWorkerInputPath = (value: string, sourceDir: string) => {
  const normalized = value.trim().replace(/\\/g, '/')
  const sourcePrefix = `${sourceDir.replace(/\\/g, '/')}/`
  const relativePath = normalized.startsWith('/workspace/')
    ? normalized.slice('/workspace/'.length)
    : normalized.startsWith(sourcePrefix)
      ? normalized.slice(sourcePrefix.length)
      : normalized
  return relativePath.replace(/^\.\//, '')
}

export const parseSyncTexBackwardOutput = (
  raw: string,
  page: number,
  x: number,
  y: number,
  sourceDir: string,
): LatexSyncTexBackwardResult => {
  const fields = parseSyncTexFields(raw)
  const input = fields.get('Input')?.[0]
  const line = firstNumber(fields, 'Line')
  const column = firstNumber(fields, 'Column')
  return {
    direction: 'backward',
    page,
    x,
    y,
    ...(input ? { file: mapWorkerInputPath(input.replace(/^\d+:/, ''), sourceDir) } : {}),
    ...(line !== undefined ? { line } : {}),
    ...(column !== undefined ? { column } : {}),
    raw,
  }
}

export class LatexService {
  private readonly jobs = new Map<string, LatexBuildJob>()
  private readonly pendingJobIds: string[] = []
  private runningJobs = 0

  private maxConcurrent() {
    return positiveInt(config.latexMaxConcurrent, 2, 1)
  }

  private maxSourceBytes() {
    return positiveInt(config.latexMaxSourceBytes, 100 * 1024 * 1024, 1)
  }

  private maxSourceFiles() {
    return positiveInt(config.latexMaxSourceFiles, 2000, 1)
  }

  private maxLogBytes() {
    return positiveInt(config.latexMaxLogBytes, 4 * 1024 * 1024, 1024)
  }

  private buildView(job: LatexBuildJob): LatexBuild {
    return {
      id: job.id,
      path: job.path,
      entry: job.entry,
      engine: job.engine,
      status: job.status,
      createdAt: job.createdAt,
      ...(job.startedAt ? { startedAt: job.startedAt } : {}),
      ...(job.completedAt ? { completedAt: job.completedAt } : {}),
      ...(job.durationMs !== undefined ? { durationMs: job.durationMs } : {}),
      ...(job.exitCode !== undefined ? { exitCode: job.exitCode } : {}),
      ...(job.error ? { error: job.error } : {}),
      pdfAvailable: job.pdfAvailable,
      synctexAvailable: job.synctexAvailable,
      diagnostics: job.diagnostics.map((diagnostic) => ({ ...diagnostic })),
    }
  }

  private async copySourceDirectory(sourceDir: string, targetDir: string, excludedPaths: string[] = []): Promise<SourceSnapshot> {
    const maxBytes = this.maxSourceBytes()
    const maxFiles = this.maxSourceFiles()
    let files = 0
    let bytes = 0

    const visit = async (from: string, to: string): Promise<void> => {
      await mkdir(to, { recursive: true })
      const entries = await readdir(from, { withFileTypes: true })
      for (const entry of entries) {
        if (EXCLUDED_SOURCE_NAMES.has(entry.name) || entry.name.startsWith('.')) continue
        const sourcePath = join(from, entry.name)
        const targetPath = join(to, entry.name)
        if (excludedPaths.some((excludedPath) => sourcePath === excludedPath || sourcePath.startsWith(`${excludedPath}${sep}`))) continue
        if (entry.isSymbolicLink()) {
          throw new AppError('LATEX_UNSAFE_SOURCE', `Symbolic links are not allowed in LaTeX sources: ${entry.name}`, 400)
        }
        if (entry.isDirectory()) {
          await visit(sourcePath, targetPath)
          continue
        }
        if (!entry.isFile()) continue

        const info = await lstat(sourcePath)
        if (info.nlink > 1) {
          throw new AppError('LATEX_UNSAFE_SOURCE', `Hard links are not allowed in LaTeX sources: ${entry.name}`, 400)
        }
        files += 1
        bytes += info.size
        if (files > maxFiles) throw new AppError('LATEX_SOURCE_TOO_LARGE', `LaTeX source contains more than ${maxFiles} files`, 413)
        if (bytes > maxBytes) throw new AppError('LATEX_SOURCE_TOO_LARGE', `LaTeX source exceeds ${maxBytes} bytes`, 413)
        await copyFile(sourcePath, targetPath)
      }
    }

    await visit(sourceDir, targetDir)
    return { files, bytes }
  }

  private dockerArgs(
    job: LatexBuildJob,
    command: string,
    commandArgs: string[],
    outputMode: 'ro' | 'rw',
    name = job.containerName,
  ) {
    const hostUser = typeof process.getuid === 'function' && typeof process.getgid === 'function'
      ? ['--user', `${process.getuid()}:${process.getgid()}`]
      : []

    return [
      'run',
      '--rm',
      '--pull',
      'never',
      '--name',
      name,
      '--network',
      'none',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--pids-limit',
      String(positiveInt(config.latexPidsLimit, 128, 1)),
      '--memory',
      `${positiveInt(config.latexMemoryMb, 1024, 128)}m`,
      '--cpus',
      String(config.latexCpus || '2'),
      '--tmpfs',
      `/tmp:rw,noexec,nosuid,size=${positiveInt(config.latexTmpfsMb, 256, 32)}m`,
      ...hostUser,
      '--env',
      'HOME=/tmp',
      '--volume',
      `${job.sourceDir}:/workspace:ro`,
      '--volume',
      `${job.outputDir}:/output:${outputMode}`,
      '--workdir',
      '/workspace',
      config.latexDockerImage,
      command,
      ...commandArgs,
    ]
  }

  private appendLog(job: LatexBuildJob, chunk: Buffer | string) {
    const value = typeof chunk === 'string' ? chunk : chunk.toString('utf-8')
    const maxBytes = this.maxLogBytes()
    const currentBytes = Buffer.byteLength(job.logText, 'utf-8')
    if (currentBytes >= maxBytes) return
    const remaining = maxBytes - currentBytes
    job.logText += Buffer.from(value, 'utf-8').subarray(0, remaining).toString('utf-8')
  }

  private async forceRemoveContainer(name: string) {
    await new Promise<void>((resolvePromise) => {
      const child = spawn(config.latexDockerCommand, ['rm', '-f', name], {
        stdio: 'ignore',
      })
      child.once('error', () => resolvePromise())
      child.once('close', () => resolvePromise())
    })
  }

  private async stopJob(job: LatexBuildJob) {
    try {
      job.child?.kill('SIGTERM')
    } catch {
      // The process may already have exited between the timeout and cleanup.
    }
    await this.forceRemoveContainer(job.containerName)
  }

  async startBuild(options: LatexCompileOptions): Promise<LatexBuild> {
    if (!config.latexEnabled) throw new AppError('LATEX_DISABLED', 'LaTeX compilation is disabled', 503)
    if (!ENGINES.includes(options.engine || 'xelatex')) {
      throw new AppError('LATEX_INVALID_ENGINE', 'Unsupported LaTeX engine', 400)
    }

    const engine = options.engine || 'xelatex'
    const flushed = await liveFileService.flush(options.path)
    if (flushed?.conflict) throw new AppError('CONFLICT', '文件存在外部修改冲突，请先处理冲突', 409)

    const context = await fileService.getLatexCompileContext(options.path)
    const sourceRootStat = await lstat(context.sourceRoot)
    if (!sourceRootStat.isDirectory()) throw new AppError('NOT_DIRECTORY', 'LaTeX source root is not a directory', 400)

    const id = randomUUID()
    const jobDir = resolve(config.latexOutputDir, id)
    const sourceDir = join(jobDir, 'source')
    const outputDir = join(jobDir, 'out')
    const stem = context.entryName.replace(/\.tex$/i, '')
    const job: LatexBuildJob = {
      id,
      path: context.relativePath,
      entry: context.entryName,
      engine,
      status: 'queued',
      createdAt: new Date().toISOString(),
      pdfAvailable: false,
      synctexAvailable: false,
      diagnostics: [],
      jobDir,
      sourceDir,
      outputDir,
      entryName: context.entryName,
      pdfPath: join(outputDir, `${stem}.pdf`),
      synctexPath: join(outputDir, `${stem}.synctex.gz`),
      logPath: join(outputDir, 'build.log'),
      containerName: `yarc-latex-${id}`,
      sourceFiles: 0,
      sourceBytes: 0,
      logText: '',
    }

    try {
      await mkdir(outputDir, { recursive: true })
      // The default artifact directory lives under DATA_DIR. If the selected
      // entry is directly under DATA_DIR, exclude the newly-created job from
      // its own recursive source snapshot.
      const snapshot = await this.copySourceDirectory(context.sourceRoot, sourceDir, [jobDir])
      job.sourceFiles = snapshot.files
      job.sourceBytes = snapshot.bytes
      if (!(await fileExists(join(sourceDir, context.entryName)))) {
        throw new AppError('LATEX_ENTRY_MISSING', 'LaTeX entry file is missing from the source snapshot', 500)
      }
    } catch (error) {
      await rm(jobDir, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }

    this.jobs.set(job.id, job)
    this.pendingJobIds.push(job.id)
    void this.processQueue()
    return this.buildView(job)
  }

  private async processQueue() {
    while (this.runningJobs < this.maxConcurrent() && this.pendingJobIds.length) {
      const id = this.pendingJobIds.shift()
      if (!id) continue
      const job = this.jobs.get(id)
      if (!job || job.status !== 'queued') continue

      this.runningJobs += 1
      void this.runBuild(job)
        .catch((error) => {
          job.status = 'failed'
          job.error = (error as Error).message || 'LaTeX 编译失败'
          job.completedAt = new Date().toISOString()
          job.diagnostics = parseDiagnostics(job.logText)
        })
        .finally(() => {
          this.runningJobs -= 1
          void this.processQueue()
        })
    }
  }

  private async runBuild(job: LatexBuildJob) {
    job.status = 'running'
    job.startedAt = new Date().toISOString()
    const args = this.dockerArgs(job, 'latexmk', [
      '-norc',
      ENGINE_FLAGS[job.engine],
      '-synctex=1',
      '-interaction=nonstopmode',
      '-halt-on-error',
      '-file-line-error',
      '-outdir=/output',
      `/workspace/${job.entryName}`,
    ], 'rw')

    let timedOut = false
    const child = spawn(config.latexDockerCommand, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    job.child = child

    const timeout = setTimeout(() => {
      timedOut = true
      job.cancelReason = 'timeout'
      void this.stopJob(job)
    }, positiveInt(config.latexBuildTimeoutMs, 120000, 1000))

    const exitCode = await new Promise<number>((resolvePromise) => {
      child.stdout.on('data', (chunk: Buffer) => this.appendLog(job, chunk))
      child.stderr.on('data', (chunk: Buffer) => this.appendLog(job, chunk))
      child.once('error', (error: NodeJS.ErrnoException) => {
        this.appendLog(job, `${error.message}\n`)
        resolvePromise(-1)
      })
      child.once('close', (code) => resolvePromise(code ?? -1))
    })
    clearTimeout(timeout)
    job.child = undefined
    job.exitCode = exitCode
    job.completedAt = new Date().toISOString()
    job.durationMs = job.startedAt ? Math.max(0, Date.parse(job.completedAt) - Date.parse(job.startedAt)) : undefined
    job.pdfAvailable = await fileExists(job.pdfPath)
    job.synctexAvailable = await fileExists(job.synctexPath)
    job.diagnostics = parseDiagnostics(job.logText)
    await writeFile(job.logPath, job.logText, 'utf-8').catch(() => undefined)

    if (job.cancelReason === 'user') {
      job.status = 'cancelled'
      job.error = '编译已取消'
    } else if (timedOut || job.cancelReason === 'timeout') {
      job.status = 'failed'
      job.error = 'LaTeX 编译超时'
    } else if (exitCode === 0 && job.pdfAvailable) {
      job.status = 'completed'
    } else {
      job.status = 'failed'
      job.error = job.logText.trim().split(/\r?\n/).filter(Boolean).slice(-1)[0] || 'LaTeX 编译失败'
    }
  }

  getBuild(id: string): LatexBuild {
    const job = this.jobs.get(id)
    if (!job) throw new AppError('NOT_FOUND', 'LaTeX build not found', 404)
    return this.buildView(job)
  }

  getBuildLog(id: string): LatexBuildLog {
    const job = this.jobs.get(id)
    if (!job) throw new AppError('NOT_FOUND', 'LaTeX build not found', 404)
    return {
      id,
      log: job.logText,
      diagnostics: job.diagnostics.map((diagnostic) => ({ ...diagnostic })),
    }
  }

  async cancelBuild(id: string): Promise<LatexBuild> {
    const job = this.jobs.get(id)
    if (!job) throw new AppError('NOT_FOUND', 'LaTeX build not found', 404)
    if (job.status === 'queued') {
      job.cancelReason = 'user'
      job.status = 'cancelled'
      job.completedAt = new Date().toISOString()
      const pendingIndex = this.pendingJobIds.indexOf(id)
      if (pendingIndex >= 0) this.pendingJobIds.splice(pendingIndex, 1)
      return this.buildView(job)
    }
    if (job.status === 'running') {
      job.cancelReason = 'user'
      await this.stopJob(job)
    }
    return this.buildView(job)
  }

  async getArtifact(id: string, kind: 'pdf' | 'synctex') {
    const job = this.jobs.get(id)
    if (!job) throw new AppError('NOT_FOUND', 'LaTeX build not found', 404)
    if (job.status !== 'completed' && kind === 'pdf') {
      throw new AppError('LATEX_BUILD_NOT_READY', 'LaTeX PDF is not ready', 409)
    }
    const path = kind === 'pdf' ? job.pdfPath : job.synctexPath
    if (!(await fileExists(path))) {
      throw new AppError('NOT_FOUND', `LaTeX ${kind} artifact not found`, 404)
    }
    const info = await stat(path)
    return {
      path,
      size: info.size,
      name: basename(path),
      job,
    }
  }

  private async runSyncTexCommand(job: LatexBuildJob, commandArgs: string[]) {
    const utilityName = `${job.containerName}-synctex`
    const args = this.dockerArgs(job, 'synctex', commandArgs, 'ro', utilityName)
    return new Promise<string>((resolvePromise, rejectPromise) => {
      const child = spawn(config.latexDockerCommand, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const chunks: Buffer[] = []
      let total = 0
      let stderr = ''
      const timer = setTimeout(() => {
        child.kill('SIGTERM')
        void this.forceRemoveContainer(utilityName)
        rejectPromise(new AppError('LATEX_SYNCTEX_TIMEOUT', 'SyncTeX query timed out', 504))
      }, positiveInt(config.latexBuildTimeoutMs, 120000, 1000))
      const append = (chunk: Buffer) => {
        total += chunk.length
        if (total <= MAX_SYNC_TEX_OUTPUT_BYTES) chunks.push(chunk)
      }
      child.stdout.on('data', append)
      child.stderr.on('data', (chunk: Buffer) => {
        if (Buffer.byteLength(stderr, 'utf-8') < 32 * 1024) stderr += chunk.toString('utf-8')
      })
      child.once('error', (error) => {
        clearTimeout(timer)
        rejectPromise(error)
      })
      child.once('close', (code) => {
        clearTimeout(timer)
        const raw = Buffer.concat(chunks).toString('utf-8')
        if (code !== 0) {
          rejectPromise(new AppError('LATEX_SYNCTEX_FAILED', stderr.trim() || raw.trim() || 'SyncTeX query failed', 500))
          return
        }
        resolvePromise(raw)
      })
    })
  }

  async querySyncTex(id: string, query: {
    direction: 'forward' | 'backward'
    file?: string
    line?: number
    column?: number
    page?: number
    x?: number
    y?: number
  }): Promise<LatexSyncTexForwardResult | LatexSyncTexBackwardResult> {
    const job = this.jobs.get(id)
    if (!job) throw new AppError('NOT_FOUND', 'LaTeX build not found', 404)
    if (!job.synctexAvailable) throw new AppError('LATEX_SYNCTEX_NOT_READY', 'SyncTeX artifact is not ready', 409)

    const pdfName = basename(job.pdfPath)
    if (query.direction === 'forward') {
      const file = normalizedPath(query.file || job.entryName)
      const lineValue = Number(query.line || 1)
      const columnValue = Number(query.column || 1)
      if (!Number.isFinite(lineValue) || !Number.isFinite(columnValue) || lineValue < 1 || columnValue < 1) {
        throw new AppError('LATEX_INVALID_SOURCE_POSITION', 'SyncTeX source line and column must be positive numbers', 400)
      }
      const line = Math.floor(lineValue)
      const column = Math.floor(columnValue)
      if (!isSafeRelativePath(file)) throw new AppError('LATEX_INVALID_SOURCE', 'Invalid SyncTeX source path', 400)
      if (!(await fileExists(join(job.sourceDir, file)))) throw new AppError('NOT_FOUND', 'SyncTeX source file not found', 404)
      const raw = await this.runSyncTexCommand(job, [
        'view',
        '-i',
        `${line}:${column}:/workspace/${file}`,
        '-o',
        `/output/${pdfName}`,
      ])
      return parseSyncTexForwardOutput(raw, file, line, column)
    }

    const pageValue = Number(query.page || 1)
    const page = Math.floor(pageValue)
    const x = Number(query.x)
    const y = Number(query.y)
    if (!Number.isFinite(pageValue) || page < 1 || !Number.isFinite(x) || !Number.isFinite(y)) {
      throw new AppError('LATEX_INVALID_COORDINATES', 'SyncTeX page coordinates are required', 400)
    }
    const raw = await this.runSyncTexCommand(job, [
      'edit',
      '-o',
      `${page}:${x}:${y}:/output/${pdfName}`,
    ])
    return parseSyncTexBackwardOutput(raw, page, x, y, job.sourceDir)
  }
}

export const latexService = new LatexService()
