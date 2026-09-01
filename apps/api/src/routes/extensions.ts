import { Hono } from 'hono'
import { readdir, stat, readFile, writeFile, cp, rm, rename, mkdir, copyFile } from 'node:fs/promises'
import { existsSync, readdirSync } from 'node:fs'
import { join, basename, resolve, sep } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import { config } from '../lib/config.js'
import { AppError } from '../lib/errors.js'
import { piService } from '../services/pi.service.js'

const execFileAsync = promisify(execFile)
const extensions = new Hono()

// Paths match Pi's conventions
const agentDir = join(config.dataDir, '.pi', 'agent')
const extensionsDir = join(agentDir, 'extensions')
const npmDir = join(agentDir, 'npm')
const gitDir = join(agentDir, 'git')
const settingsPath = join(agentDir, 'settings.json')

function parseNpmSpec(spec: string): { name: string; version: string } {
  const clean = spec.replace(/^npm:/, '').trim()
  if (!clean) throw new AppError('INVALID_REQUEST', 'Invalid npm package spec', 400)

  if (clean.startsWith('@')) {
    const slash = clean.indexOf('/')
    if (slash === -1) throw new AppError('INVALID_REQUEST', 'Invalid scoped package', 400)
    const versionAt = clean.indexOf('@', slash + 1)
    if (versionAt === -1) return { name: clean, version: 'latest' }
    return {
      name: clean.slice(0, versionAt),
      version: clean.slice(versionAt + 1) || 'latest',
    }
  }

  const versionAt = clean.lastIndexOf('@')
  if (versionAt > 0) {
    return {
      name: clean.slice(0, versionAt),
      version: clean.slice(versionAt + 1) || 'latest',
    }
  }
  return { name: clean, version: 'latest' }
}

function safeExtensionName(raw: string): string {
  const name = raw.trim()
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
    throw new AppError('INVALID_REQUEST', 'Invalid extension name', 400)
  }
  return name
}

function resolveUnder(base: string, child: string): string {
  const resolvedBase = resolve(base)
  const target = resolve(resolvedBase, child)
  if (target !== resolvedBase && !target.startsWith(`${resolvedBase}${sep}`)) {
    throw new AppError('FORBIDDEN', 'Path escapes extension directory', 403)
  }
  return target
}

function assertSafeArchiveEntries(entries: string[]): void {
  for (const entry of entries) {
    const normalized = entry.replace(/\\/g, '/')
    if (
      !normalized ||
      normalized.startsWith('/') ||
      normalized.includes('\0') ||
      /^[a-zA-Z]:\//.test(normalized) ||
      normalized.split('/').some(part => part === '..')
    ) {
      throw new AppError('INVALID_REQUEST', 'Archive contains unsafe paths', 400)
    }
  }
}

function parseGitSpec(spec: string): { cloneUrl: string; ref?: string; host: string; repoPath: string; displayName: string } {
  const clean = spec.replace(/^git:/, '').trim()
  const hash = clean.indexOf('#')
  const cloneUrl = hash === -1 ? clean : clean.slice(0, hash)
  const ref = hash === -1 ? undefined : clean.slice(hash + 1) || undefined

  let host: string
  let repoPath: string
  if (cloneUrl.startsWith('git@')) {
    const match = cloneUrl.match(/^git@([^:]+):(.+)$/)
    if (!match) throw new AppError('INVALID_REQUEST', `无法解析 git URL: ${clean}`, 400)
    host = match[1]!
    repoPath = match[2]!
  } else {
    let parsed: URL
    try {
      parsed = new URL(cloneUrl)
    } catch {
      throw new AppError('INVALID_REQUEST', `无法解析 git URL: ${clean}`, 400)
    }
    if (!['https:', 'http:', 'ssh:'].includes(parsed.protocol)) {
      throw new AppError('INVALID_REQUEST', `不支持的 git URL 协议: ${parsed.protocol}`, 400)
    }
    host = parsed.host
    repoPath = parsed.pathname.replace(/^\/+/, '')
  }

  const normalizedRepoPath = repoPath.replace(/\.git$/, '')
  assertSafeArchiveEntries([normalizedRepoPath])
  const displayName = basename(normalizedRepoPath) || cloneUrl
  return { cloneUrl, ref, host, repoPath: normalizedRepoPath, displayName }
}

// ── Settings helpers ─────────────────────────────────────────────

interface PiSettings {
  packages?: string[]
  extensions?: string[]
  [key: string]: any
}

async function readSettings(): Promise<PiSettings> {
  try {
    return JSON.parse(await readFile(settingsPath, 'utf-8'))
  } catch {
    return {}
  }
}

async function writeSettings(settings: PiSettings): Promise<void> {
  await mkdir(agentDir, { recursive: true })
  await writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8')
}

let extensionUpdateInProgress = false

const assertExtensionsIdle = () => {
  if (extensionUpdateInProgress) {
    throw new AppError('CONFLICT', '已有插件更新任务正在执行', 409)
  }
}

const isPackageSource = (source: string) =>
  source.startsWith('npm:') ||
  source.startsWith('git:') ||
  source.startsWith('https://') ||
  source.startsWith('http://') ||
  source.startsWith('ssh://') ||
  source.startsWith('git@')

async function updatePackages(source?: string) {
  assertExtensionsIdle()
  if (source && !isPackageSource(source)) {
    throw new AppError('INVALID_REQUEST', '本地或上传插件不支持在线更新', 400)
  }

  extensionUpdateInProgress = true
  try {
    const settings = await readSettings()
    const packages = (settings.packages || [])
      .map(item => item.replace(/^-/, ''))
      .filter(isPackageSource)

    const { DefaultPackageManager, SettingsManager } = await import('@earendil-works/pi-coding-agent')
    const settingsManager = SettingsManager.inMemory({ ...settings, packages })
    const packageManager = new DefaultPackageManager({
      cwd: resolve(config.dataDir),
      agentDir,
      settingsManager,
    })
    const progress: Array<{ type: string; action: string; source: string; message?: string }> = []
    packageManager.setProgressCallback(event => {
      progress.push({
        type: event.type,
        action: event.action,
        source: event.source,
        ...(event.message ? { message: event.message } : {}),
      })
    })

    await packageManager.update(source)
    await piService.reloadExtensions(source || 'all')
    return { progress }
  } catch (err) {
    console.error('[Extensions] Update failed:', err)
    throw new AppError('UPDATE_FAILED', '插件更新失败，请检查插件来源或版本兼容性', 500)
  } finally {
    extensionUpdateInProgress = false
  }
}

// ── Types ────────────────────────────────────────────────────────

interface ExtensionEntry {
  id: string               // e.g. "npm:@foo/bar" or "local:my-ext"
  name: string             // display name
  source: string           // original source spec
  type: 'npm' | 'git' | 'local'
  enabled: boolean
  installed: boolean       // files exist on disk
  description: string | null
  version: string | null
  packageName: string | null
  entryFile: string | null
}

// ── Scan installed extensions (directory-based) ──────────────────

async function scanDirectoryExtensions(): Promise<ExtensionEntry[]> {
  const entries = await readdir(extensionsDir, { withFileTypes: true }).catch(() => [])
  const results: ExtensionEntry[] = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dirName = entry.name
    const disabled = dirName.endsWith('.disabled')
    const name = disabled ? dirName.replace(/\.disabled$/, '') : dirName
    const extDir = join(extensionsDir, dirName)

    let description: string | null = null
    let version: string | null = null
    let packageName: string | null = null
    let entryFile: string | null = null

    try {
      const pkgRaw = await readFile(join(extDir, 'package.json'), 'utf-8')
      const pkg = JSON.parse(pkgRaw)
      description = pkg.description || null
      version = pkg.version || null
      packageName = pkg.name || null
      if (pkg.pi?.extensions?.[0]) entryFile = pkg.pi.extensions[0]
    } catch {
      // No package.json or parse error
    }

    results.push({
      id: `local:${name}`,
      name,
      source: extDir,
      type: 'local',
      enabled: !disabled,
      installed: true,
      description,
      version,
      packageName,
      entryFile,
    })
  }

  return results
}

// ── Scan settings.json packages ──────────────────────────────────

async function scanSettingsPackages(): Promise<ExtensionEntry[]> {
  const settings = await readSettings()
  const pkgs = settings.packages || []
  const results: ExtensionEntry[] = []

  for (const spec of pkgs) {
    // Disabled entries prefixed with "-"
    const enabled = !spec.startsWith('-')
    const cleanSpec = spec.replace(/^-/, '')

    let type: 'npm' | 'git' = 'npm'
    let source = cleanSpec
    let id = cleanSpec
    let name = cleanSpec

    if (cleanSpec.startsWith('npm:')) {
      type = 'npm'
      source = cleanSpec.slice(4)
      id = cleanSpec
      name = parseNpmSpec(source).name
    } else if (cleanSpec.startsWith('git:') || cleanSpec.startsWith('https://') || cleanSpec.startsWith('ssh://') || cleanSpec.startsWith('git@')) {
      type = 'git'
      source = cleanSpec
      id = cleanSpec
      name = parseGitSpec(source).displayName
    } else {
      continue // Skip unknown formats
    }

    // Check if installed on disk
    let installed = false
    let description: string | null = null
    let version: string | null = null
    let packageName: string | null = null
    let entryFile: string | null = null

    if (type === 'npm') {
      // npm packages are in npmDir/node_modules/<name>
      const pkgName = parseNpmSpec(source).name
      const pkgDir = join(npmDir, 'node_modules', pkgName)
      if (existsSync(pkgDir)) {
        installed = true
        try {
          const pkgRaw = await readFile(join(pkgDir, 'package.json'), 'utf-8')
          const pkg = JSON.parse(pkgRaw)
          description = pkg.description || null
          version = pkg.version || null
          packageName = pkg.name || null
          if (pkg.pi?.extensions?.[0]) entryFile = pkg.pi.extensions[0]
        } catch {}
      }
    } else if (type === 'git') {
      // git packages are in gitDir/<host>/<path>
      try {
        const git = parseGitSpec(source)
        const gitPath = join(gitDir, git.host, git.repoPath)
        if (existsSync(gitPath)) {
          installed = true
          try {
            const pkgRaw = await readFile(join(gitPath, 'package.json'), 'utf-8')
            const pkg = JSON.parse(pkgRaw)
            description = pkg.description || null
            version = pkg.version || null
            packageName = pkg.name || null
            if (pkg.pi?.extensions?.[0]) entryFile = pkg.pi.extensions[0]
          } catch {}
        }
      } catch {}
    }

    results.push({
      id,
      name,
      source: cleanSpec,
      type,
      enabled,
      installed,
      description,
      version,
      packageName,
      entryFile,
    })
  }

  return results
}

// GET /api/extensions — list all extensions
extensions.get('/', async (c) => {
  const [dirExts, settingsPkgs] = await Promise.all([
    scanDirectoryExtensions(),
    scanSettingsPackages(),
  ])

  // Merge: settings packages first, then directory extensions (dedup by name)
  const seen = new Set<string>()
  const all: ExtensionEntry[] = []

  for (const pkg of settingsPkgs) {
    all.push(pkg)
    seen.add(pkg.name.toLowerCase())
  }
  for (const ext of dirExts) {
    if (!seen.has(ext.name.toLowerCase())) {
      all.push(ext)
    }
  }

  return c.json({ extensions: all, paths: { agentDir, extensionsDir, npmDir, gitDir } })
})

// POST /api/extensions/install — install a package
extensions.post('/install', async (c) => {
  assertExtensionsIdle()
  const body = await c.req.json().catch(() => ({}))
  const source = typeof body.source === 'string' ? body.source.trim() : ''
  if (!source) throw new AppError('INVALID_REQUEST', 'source is required', 400)

  await mkdir(extensionsDir, { recursive: true })

  // Detect source type
  let spec: string
  let type: 'npm' | 'git' | 'local'

  if (source.startsWith('npm:') || source.startsWith('npm@')) {
    spec = source.startsWith('npm@') ? `npm:${source.slice(4)}` : source
    type = 'npm'
  } else if (source.startsWith('git:') || source.startsWith('https://') || source.startsWith('ssh://') || source.startsWith('http://') || source.startsWith('git@')) {
    spec = source.startsWith('git:') ? source : `git:${source}`
    type = 'git'
  } else if (source.startsWith('/') || source.startsWith('./') || source.startsWith('../') || source.startsWith('~')) {
    type = 'local'
    spec = source
  } else {
    // Default: treat as npm package name
    spec = `npm:${source}`
    type = 'npm'
  }

  // Check if already installed
  const settings = await readSettings()
  const existingPkgs = settings.packages || []
  if (type !== 'local' && existingPkgs.some(p => p.replace(/^-/, '') === spec)) {
    throw new AppError('CONFLICT', `${spec} 已安装`, 409)
  }

  if (type === 'local') {
    // Local: copy to extensions directory
    const resolvedPath = spec.replace(/^~\//, `${homedir()}/`)
    if (!existsSync(resolvedPath)) {
      throw new AppError('NOT_FOUND', `路径不存在: ${resolvedPath}`, 400)
    }

    const srcStat = await stat(resolvedPath)
    if (!srcStat.isDirectory()) {
      // Single file extension
      const fileName = safeExtensionName(basename(resolvedPath))
      const dest = resolveUnder(extensionsDir, fileName)
      if (existsSync(dest)) throw new AppError('CONFLICT', `${fileName} 已存在`, 409)
      await copyFile(resolvedPath, dest)
      await piService.reloadExtensions(`install:local:${fileName}`)
      return c.json({ ok: true, id: `local:${fileName}`, type: 'local' })
    }

    // Directory
    const pkgPath = join(resolvedPath, 'package.json')
    let extName = safeExtensionName(basename(resolvedPath))
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(await readFile(pkgPath, 'utf-8'))
        if (pkg.name) extName = safeExtensionName(pkg.name.replace(/^@[^/]+\//, '').replace(/[^a-z0-9._-]/gi, '-'))
      } catch {}
    }

    const destDir = resolveUnder(extensionsDir, extName)
    if (existsSync(destDir)) throw new AppError('CONFLICT', `扩展 ${extName} 已存在`, 409)

    await cp(resolvedPath, destDir, {
      recursive: true,
      filter: (src) => !src.includes('/node_modules') && !src.includes('/.git'),
    })

    // Install deps if package.json exists
    if (existsSync(join(destDir, 'package.json'))) {
      try {
        await execFileAsync('npm', ['install', '--omit=dev'], { cwd: destDir, timeout: 60_000 })
      } catch (err) {
        console.warn(`[Extensions] npm install for ${extName}:`, (err as Error).message)
      }
    }

    await piService.reloadExtensions(`install:local:${extName}`)
    return c.json({ ok: true, id: `local:${extName}`, type: 'local' })

  } else if (type === 'npm') {
    // npm: install to npmDir
    await mkdir(npmDir, { recursive: true })

    const pkgSpec = spec.slice(4) // Remove "npm:" prefix

    // Create or update package.json in npmDir
    const npmPkgPath = join(npmDir, 'package.json')
    let npmPkg: any = { private: true }
    if (existsSync(npmPkgPath)) {
      try { npmPkg = JSON.parse(await readFile(npmPkgPath, 'utf-8')) } catch {}
    }
    if (!npmPkg.dependencies) npmPkg.dependencies = {}

    const { name: pkgName, version: pkgVersion } = parseNpmSpec(pkgSpec)
    npmPkg.dependencies[pkgName] = pkgVersion

    await writeFile(npmPkgPath, JSON.stringify(npmPkg, null, 2) + '\n', 'utf-8')

    // Run npm install
    try {
      await execFileAsync('npm', ['install', '--omit=dev'], { cwd: npmDir, timeout: 120_000 })
    } catch (err) {
      // Rollback
      delete npmPkg.dependencies[pkgName]
      await writeFile(npmPkgPath, JSON.stringify(npmPkg, null, 2) + '\n', 'utf-8')
      throw new AppError('INSTALL_FAILED', `npm install 失败: ${(err as Error).message}`, 500)
    }

    // Add to settings.json packages
    settings.packages = [...existingPkgs, spec]
    await writeSettings(settings)
    await piService.reloadExtensions(`install:${spec}`)

    return c.json({ ok: true, id: spec, type: 'npm' })

  } else {
    // git: clone to gitDir
    await mkdir(gitDir, { recursive: true })

    const git = parseGitSpec(spec)
    const clonePath = join(gitDir, git.host, git.repoPath)

    if (existsSync(clonePath)) {
      throw new AppError('CONFLICT', `git 仓库已存在: ${clonePath}`, 409)
    }

    try {
      const cloneArgs = ['clone']
      if (git.ref) cloneArgs.push('--branch', git.ref)
      cloneArgs.push(git.cloneUrl, clonePath)
      await execFileAsync('git', cloneArgs, { timeout: 60_000 })
    } catch (err) {
      throw new AppError('INSTALL_FAILED', `git clone 失败: ${(err as Error).message}`, 500)
    }

    // Install deps if package.json exists
    if (existsSync(join(clonePath, 'package.json'))) {
      try {
        await execFileAsync('npm', ['install', '--omit=dev'], { cwd: clonePath, timeout: 60_000 })
      } catch (err) {
        console.warn(`[Extensions] npm install for git package:`, (err as Error).message)
      }
    }

    // Add to settings.json packages
    settings.packages = [...existingPkgs, spec]
    await writeSettings(settings)
    await piService.reloadExtensions(`install:${spec}`)

    return c.json({ ok: true, id: spec, type: 'git' })
  }
})

// POST /api/extensions/update — update every configured npm/git package
extensions.post('/update', async (c) => {
  const result = await updatePackages()
  return c.json({ ok: true, ...result })
})

// POST /api/extensions/:id/update — update one configured npm/git package
extensions.post('/:id/update', async (c) => {
  const id = decodeURIComponent(c.req.param('id')).replace(/^-/, '')
  const result = await updatePackages(id)
  return c.json({ ok: true, id, ...result })
})

// POST /api/extensions/:id/enable — re-enable a disabled package
extensions.post('/:id/enable', async (c) => {
  assertExtensionsIdle()
  const id = decodeURIComponent(c.req.param('id'))

  if (id.startsWith('local:')) {
    // Local extension: rename .disabled → enabled
    const name = safeExtensionName(id.slice(6))
    const disabledPath = resolveUnder(extensionsDir, `${name}.disabled`)
    const enabledPath = resolveUnder(extensionsDir, name)
    if (!existsSync(disabledPath)) {
      if (existsSync(enabledPath)) return c.json({ ok: true })
      throw new AppError('NOT_FOUND', `扩展 ${name} 未找到`, 404)
    }
    await rename(disabledPath, enabledPath)
    await piService.reloadExtensions(`enable:${id}`)
    return c.json({ ok: true })
  }

  // Package: update settings.json
  const settings = await readSettings()
  const pkgs = settings.packages || []
  const idx = pkgs.findIndex(p => p.replace(/^-/, '') === id)
  if (idx === -1) throw new AppError('NOT_FOUND', `包 ${id} 未安装`, 404)
  pkgs[idx] = pkgs[idx].replace(/^-/, '')
  settings.packages = pkgs
  await writeSettings(settings)
  await piService.reloadExtensions(`enable:${id}`)
  return c.json({ ok: true })
})

// POST /api/extensions/:id/disable — disable a package
extensions.post('/:id/disable', async (c) => {
  assertExtensionsIdle()
  const id = decodeURIComponent(c.req.param('id'))

  if (id.startsWith('local:')) {
    // Local extension: rename to .disabled
    const name = safeExtensionName(id.slice(6))
    const enabledPath = resolveUnder(extensionsDir, name)
    const disabledPath = resolveUnder(extensionsDir, `${name}.disabled`)
    if (!existsSync(enabledPath)) {
      if (existsSync(disabledPath)) return c.json({ ok: true })
      throw new AppError('NOT_FOUND', `扩展 ${name} 未找到`, 404)
    }
    await rename(enabledPath, disabledPath)
    await piService.reloadExtensions(`disable:${id}`)
    return c.json({ ok: true })
  }

  // Package: prefix with "-" in settings.json
  const settings = await readSettings()
  const pkgs = settings.packages || []
  const idx = pkgs.findIndex(p => p.replace(/^-/, '') === id)
  if (idx === -1) throw new AppError('NOT_FOUND', `包 ${id} 未安装`, 404)
  if (!pkgs[idx]!.startsWith('-')) pkgs[idx] = `-${pkgs[idx]}`
  settings.packages = pkgs
  await writeSettings(settings)
  await piService.reloadExtensions(`disable:${id}`)
  return c.json({ ok: true })
})

// POST /api/extensions/upload — upload a .ts/.js file or .zip/.tar.gz archive
extensions.post('/upload', async (c) => {
  assertExtensionsIdle()
  const formData = await c.req.formData()
  const file = formData.get('file') as File | null
  if (!file || !(file instanceof File) || !file.name) {
    throw new AppError('INVALID_REQUEST', '请上传文件', 400)
  }

  await mkdir(extensionsDir, { recursive: true })
  const tmpDir = join(config.dataDir, '.tmp', 'ext-upload', Date.now().toString())
  await mkdir(tmpDir, { recursive: true })

  try {
    const fileName = file.name.toLowerCase()
    const buffer = Buffer.from(await file.arrayBuffer())

    if (fileName.endsWith('.ts') || fileName.endsWith('.js')) {
      // Single file extension
      const originalName = safeExtensionName(basename(file.name))
      const dest = resolveUnder(extensionsDir, originalName)
      if (existsSync(dest)) throw new AppError('CONFLICT', `${originalName} 已存在`, 409)
      // writeFile already imported
      await writeFile(dest, buffer)
      await piService.reloadExtensions(`upload:local:${originalName}`)
      return c.json({ ok: true, id: `local:${originalName.replace(/\.[^.]+$/, '')}`, type: 'local' })
    }

    if (fileName.endsWith('.zip')) {
      // Zip archive
      const zipPath = join(tmpDir, 'upload.zip')
      // writeFile already imported
      await writeFile(zipPath, buffer)

      const zipList = await execFileAsync('unzip', ['-Z1', zipPath], { timeout: 30_000 }).catch(() => {
        throw new AppError('INSTALL_FAILED', '无法读取 zip 文件目录', 400)
      })
      assertSafeArchiveEntries(zipList.stdout.split('\n').filter(Boolean))

      // Extract to temp dir first to inspect structure
      await execFileAsync('unzip', ['-q', zipPath, '-d', tmpDir + '/extract'], { timeout: 30_000 }).catch(() => {
        throw new AppError('INSTALL_FAILED', '无法解压 zip 文件', 400)
      })

      const extractDir = join(tmpDir, 'extract')
      const extName = await resolveExtensionDirName(extractDir)
      const destDir = resolveUnder(extensionsDir, extName)
      if (existsSync(destDir)) throw new AppError('CONFLICT', `扩展 ${extName} 已存在`, 409)

      await cp(findExtensionRoot(extractDir), destDir, { recursive: true })
      await installDeps(destDir)
      await piService.reloadExtensions(`upload:local:${extName}`)
      return c.json({ ok: true, id: `local:${extName}`, type: 'local' })
    }

    if (fileName.endsWith('.tar.gz') || fileName.endsWith('.tgz')) {
      // Tar archive
      const tarPath = join(tmpDir, 'upload.tar.gz')
      // writeFile already imported
      await writeFile(tarPath, buffer)

      const tarList = await execFileAsync('tar', ['tzf', tarPath], { timeout: 30_000 }).catch(() => {
        throw new AppError('INSTALL_FAILED', '无法读取 tar.gz 文件目录', 400)
      })
      assertSafeArchiveEntries(tarList.stdout.split('\n').filter(Boolean))

      const extractDir = join(tmpDir, 'extract')
      await mkdir(extractDir, { recursive: true })
      await execFileAsync('tar', ['xzf', tarPath, '-C', extractDir], { timeout: 30_000 }).catch(() => {
        throw new AppError('INSTALL_FAILED', '无法解压 tar.gz 文件', 400)
      })

      const extName = await resolveExtensionDirName(extractDir)
      const destDir = resolveUnder(extensionsDir, extName)
      if (existsSync(destDir)) throw new AppError('CONFLICT', `扩展 ${extName} 已存在`, 409)

      await cp(findExtensionRoot(extractDir), destDir, { recursive: true })
      await installDeps(destDir)
      await piService.reloadExtensions(`upload:local:${extName}`)
      return c.json({ ok: true, id: `local:${extName}`, type: 'local' })
    }

    throw new AppError('INVALID_REQUEST', '支持的格式: .ts, .js, .zip, .tar.gz, .tgz', 400)

  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
})

// Helper: find the actual extension root inside an extracted archive
function findExtensionRoot(dir: string): string {
  // If the archive contains a single top-level directory, use that
  // (common pattern: archive.zip → my-extension/package.json)
  try {
    const entries = readdirSync(dir, { withFileTypes: true })
    const dirs = entries.filter(e => e.isDirectory())
    if (dirs.length === 1) {
      const sub = join(dir, dirs[0].name)
      if (existsSync(join(sub, 'package.json')) || existsSync(join(sub, 'index.ts'))) return sub
    }
  } catch {}
  return dir
}

// Helper: resolve extension name from extracted directory
async function resolveExtensionDirName(dir: string): Promise<string> {
  const root = findExtensionRoot(dir)
  try {
    const pkgRaw = await readFile(join(root, 'package.json'), 'utf-8')
    const pkg = JSON.parse(pkgRaw)
    if (pkg.name) return safeExtensionName(pkg.name.replace(/^@[^/]+\//, '').replace(/[^a-z0-9._-]/gi, '-'))
  } catch {}
  return safeExtensionName(basename(root) || 'uploaded-extension')
}

// Helper: install npm dependencies if package.json exists
async function installDeps(dir: string): Promise<void> {
  if (!existsSync(join(dir, 'package.json'))) return
  try {
    await execFileAsync('npm', ['install', '--omit=dev'], { cwd: dir, timeout: 60_000 })
  } catch (err) {
    console.warn(`[Extensions] npm install for uploaded ext:`, (err as Error).message)
  }
}

// DELETE /api/extensions/:id — uninstall
extensions.delete('/:id', async (c) => {
  assertExtensionsIdle()
  const id = decodeURIComponent(c.req.param('id'))

  if (id.startsWith('local:')) {
    // Local: delete directory
    const name = safeExtensionName(id.slice(6))
    const enabledPath = resolveUnder(extensionsDir, name)
    const disabledPath = resolveUnder(extensionsDir, `${name}.disabled`)
    let target: string | null = null
    if (existsSync(enabledPath)) target = enabledPath
    else if (existsSync(disabledPath)) target = disabledPath
    else throw new AppError('NOT_FOUND', `扩展 ${name} 未找到`, 404)
    await rm(target, { recursive: true, force: true })
    await piService.reloadExtensions(`uninstall:${id}`)
    return c.json({ ok: true })
  }

  // Package: remove from settings.json and delete files
  const settings = await readSettings()
  const pkgs = settings.packages || []
  const idx = pkgs.findIndex(p => p.replace(/^-/, '') === id)
  if (idx !== -1) {
    pkgs.splice(idx, 1)
    settings.packages = pkgs
    await writeSettings(settings)
  }

  // Delete installed files
  if (id.startsWith('npm:')) {
    const pkgName = parseNpmSpec(id).name
    const pkgDir = join(npmDir, 'node_modules', pkgName)
    if (existsSync(pkgDir)) await rm(pkgDir, { recursive: true, force: true })
  } else if (id.startsWith('git:') || id.startsWith('https://') || id.startsWith('ssh://') || id.startsWith('git@')) {
    try {
      const git = parseGitSpec(id)
      const gitPath = join(gitDir, git.host, git.repoPath)
      if (existsSync(gitPath)) await rm(gitPath, { recursive: true, force: true })
    } catch {}
  }

  await piService.reloadExtensions(`uninstall:${id}`)
  return c.json({ ok: true })
})

export default extensions
