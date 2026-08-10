import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { lstat, mkdir, readdir, rename, rm, stat, utimes } from 'node:fs/promises'
import { dirname, join, posix, relative, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { prisma, type Prisma } from '@yarc/db'
import type {
  WebDavSyncConfig,
  WebDavSyncDirection,
  WebDavSyncErrorItem,
  WebDavSyncResult,
  WebDavSyncStatus,
  WebDavSyncTreeNode,
} from '@yarc/shared'
import { config as appConfig } from '../lib/config.js'
import { sseHub } from '../lib/sse.js'

const CONFIG_KEY = 'webdav_sync_config'
const SECRET_KEY = 'webdav_sync_secret'
const MANIFEST_KEY = 'webdav_sync_manifest'
const RUNTIME_KEY = 'webdav_sync_runtime'
const CLOCK_TOLERANCE_MS = 2_000
const MAX_RECORDED_ERRORS = 100
const SYNC_TEMP_PREFIX = '.yarc-webdav-'
const PROTECTED_EXCLUDE_PATTERNS = [
  '.pi',
  'node_modules',
  '.git',
  '.venv',
  'venv',
  '__pycache__',
] as const

export const WEB_DAV_PRIVATE_SETTING_KEYS = new Set([
  CONFIG_KEY,
  SECRET_KEY,
  MANIFEST_KEY,
  RUNTIME_KEY,
])

export const DEFAULT_WEB_DAV_SYNC_CONFIG: WebDavSyncConfig = {
  enabled: false,
  url: '',
  username: '',
  remotePath: 'yarc-data',
  direction: 'bidirectional',
  syncAll: true,
  selectedPaths: [],
  excludePatterns: [],
  scheduleEnabled: false,
  intervalMinutes: 60,
  timeoutSeconds: 30,
}

type LocalFile = {
  path: string
  absolutePath: string
  size: number
  modified: number
}

export type RemoteFile = {
  path: string
  size: number
  modified: number | null
  etag: string
}

type ManifestEntry = {
  local?: string
  remote?: string
  syncedAt: string
}

type SyncManifest = Record<string, ManifestEntry>

type SecretEnvelope = {
  version: 1
  iv: string
  tag: string
  ciphertext: string
}

const initialStatus = (): WebDavSyncStatus => ({
  enabled: false,
  scheduled: false,
  phase: 'disabled',
  running: false,
  message: 'WebDAV 同步未启用',
  currentPath: null,
  processed: 0,
  total: 0,
  lastSyncAt: null,
  lastSuccessAt: null,
  nextSyncAt: null,
  lastError: null,
  lastResult: null,
})

const clampInteger = (value: unknown, fallback: number, min: number, max: number) => {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.round(parsed)))
}

export const normalizeRelativePath = (value: string) => {
  const normalized = value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (!normalized) return ''
  const parts = normalized.split('/').filter(part => part && part !== '.')
  if (parts.some(part => part === '..' || part.includes('\0'))) {
    throw new Error(`不安全的相对路径：${value}`)
  }
  return parts.join('/')
}

const normalizePattern = (value: string) => {
  let pattern = value.trim().replace(/\\/g, '/').replace(/^\/+/, '')
  if (pattern.endsWith('/')) pattern += '**'
  return pattern
}

export const normalizeWebDavConfig = (
  input: Partial<WebDavSyncConfig> | null | undefined,
  base: WebDavSyncConfig = DEFAULT_WEB_DAV_SYNC_CONFIG,
): WebDavSyncConfig => {
  const source = input || {}
  const direction: WebDavSyncDirection = ['upload', 'download', 'bidirectional'].includes(String(source.direction))
    ? source.direction as WebDavSyncDirection
    : base.direction
  const url = typeof source.url === 'string' ? source.url.trim().replace(/\/+$/, '') : base.url
  if (url) {
    const parsed = new URL(url)
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('WebDAV 地址必须使用 http:// 或 https://')
    if (parsed.username || parsed.password) throw new Error('请使用单独的用户名和密码字段，不要把凭据写在 WebDAV 地址中')
  }

  const selectedCandidates = Array.isArray(source.selectedPaths)
    ? [...new Set(source.selectedPaths.filter((item): item is string => typeof item === 'string').map(normalizeRelativePath).filter(Boolean))]
    : [...base.selectedPaths]
  const selectedPaths = selectedCandidates
    .filter(path => !selectedCandidates.some(other => other !== path && path.startsWith(`${other}/`)))
    .sort((a, b) => a.localeCompare(b))
  const excludePatterns = Array.isArray(source.excludePatterns)
    ? [...new Set(source.excludePatterns
      .filter((item): item is string => typeof item === 'string')
      .map(normalizePattern)
      .filter(item => item && !item.startsWith('#')))]
    : [...base.excludePatterns]

  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : base.enabled,
    url,
    username: typeof source.username === 'string' ? source.username.trim() : base.username,
    remotePath: typeof source.remotePath === 'string' ? normalizeRelativePath(source.remotePath.trim()) : base.remotePath,
    direction,
    syncAll: typeof source.syncAll === 'boolean' ? source.syncAll : base.syncAll,
    selectedPaths,
    excludePatterns,
    scheduleEnabled: typeof source.scheduleEnabled === 'boolean' ? source.scheduleEnabled : base.scheduleEnabled,
    intervalMinutes: clampInteger(source.intervalMinutes, base.intervalMinutes, 5, 7 * 24 * 60),
    timeoutSeconds: clampInteger(source.timeoutSeconds, base.timeoutSeconds, 5, 300),
  }
}

const escapeRegExp = (value: string) => value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')

export const globToRegExp = (rawPattern: string) => {
  const pattern = normalizePattern(rawPattern)
  let expression = '^'
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        index++
        if (pattern[index + 1] === '/') {
          index++
          expression += '(?:.*/)?'
        } else {
          expression += '.*'
        }
      } else {
        expression += '[^/]*'
      }
    } else if (char === '?') {
      expression += '[^/]'
    } else {
      expression += escapeRegExp(char)
    }
  }
  return new RegExp(`${expression}$`)
}

export const isExcludedPath = (rawPath: string, patterns: readonly string[]) => {
  const path = normalizeRelativePath(rawPath)
  if (!path) return false
  const segments = path.split('/')
  const prefixes = segments.map((_, index) => segments.slice(0, index + 1).join('/'))

  return patterns.some(rawPattern => {
    const pattern = normalizePattern(rawPattern)
    if (!pattern || pattern.startsWith('#')) return false
    const matcher = globToRegExp(pattern)
    if (!pattern.includes('/')) return segments.some(segment => matcher.test(segment))
    return prefixes.some(prefix => matcher.test(prefix))
  })
}

export const isSelectedPath = (rawPath: string, syncAll: boolean, selectedPaths: string[]) => {
  if (syncAll) return true
  const path = normalizeRelativePath(rawPath)
  return selectedPaths.some(rawSelected => {
    const selected = normalizeRelativePath(rawSelected)
    return selected === path || path.startsWith(`${selected}/`)
  })
}

const isProtectedSyncPath = (path: string) => isExcludedPath(path, PROTECTED_EXCLUDE_PATTERNS)

const isWebDavExcludedPath = (path: string, patterns: string[]) => (
  isProtectedSyncPath(path) || isExcludedPath(path, patterns)
)

export const shouldSyncPath = (path: string, config: Pick<WebDavSyncConfig, 'syncAll' | 'selectedPaths' | 'excludePatterns'>) => (
  isSelectedPath(path, config.syncAll, config.selectedPaths) && !isWebDavExcludedPath(path, config.excludePatterns)
)

const decodeXml = (value: string) => value
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'")
  .replace(/&amp;/g, '&')

const decodePathname = (pathname: string) => {
  try {
    return decodeURIComponent(pathname)
  } catch {
    return pathname
  }
}

const extractTag = (block: string, tag: string) => {
  const match = block.match(new RegExp(`<(?:[\\w.-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${tag}>`, 'i'))
  return match?.[1]?.trim() || ''
}

const appendUrlPath = (base: URL, relativePath: string, directory = false) => {
  const url = new URL(base.toString())
  const baseParts = decodePathname(url.pathname).split('/').filter(Boolean)
  const relativeParts = normalizeRelativePath(relativePath).split('/').filter(Boolean)
  url.pathname = `/${[...baseParts, ...relativeParts].map(part => encodeURIComponent(part)).join('/')}${directory ? '/' : ''}`
  return url
}

export class WebDavRequestError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message)
    this.name = 'WebDavRequestError'
  }
}

export class WebDavSyncBusyError extends Error {
  constructor() {
    super('已有 WebDAV 操作正在进行')
    this.name = 'WebDavSyncBusyError'
  }
}

type NodeRequestInit = RequestInit & { duplex?: 'half' }

export class WebDavClient {
  private serverUrl: URL
  private rootUrl: URL
  private timeoutMs: number
  private authorization: string | null
  private rootEnsured = false
  private ensuredDirectories = new Set<string>()

  constructor(config: Pick<WebDavSyncConfig, 'url' | 'username' | 'remotePath' | 'timeoutSeconds'>, password: string) {
    if (!config.url) throw new Error('请填写 WebDAV 地址')
    this.serverUrl = new URL(config.url)
    this.serverUrl.pathname = `${this.serverUrl.pathname.replace(/\/+$/, '')}/`
    this.serverUrl.hash = ''
    this.rootUrl = appendUrlPath(this.serverUrl, config.remotePath, true)
    this.timeoutMs = config.timeoutSeconds * 1000
    this.authorization = config.username || password
      ? `Basic ${Buffer.from(`${config.username}:${password}`).toString('base64')}`
      : null
  }

  private async request(url: URL, options: NodeRequestInit, acceptedStatuses: number[]) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    const headers = new Headers(options.headers)
    if (this.authorization) headers.set('Authorization', this.authorization)

    try {
      const response = await fetch(url, { ...options, headers, signal: controller.signal })
      if (!acceptedStatuses.includes(response.status)) {
        const detail = (await response.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 240)
        throw new WebDavRequestError(
          `WebDAV ${options.method || 'GET'} ${decodePathname(url.pathname)} 失败：HTTP ${response.status}${detail ? ` - ${detail}` : ''}`,
          response.status,
        )
      }
      return response
    } catch (error) {
      if (error instanceof WebDavRequestError) throw error
      if ((error as Error).name === 'AbortError') throw new WebDavRequestError(`WebDAV 请求超时（${this.timeoutMs / 1000} 秒）`, 0)
      throw new WebDavRequestError(`WebDAV ${options.method || 'GET'} ${decodePathname(url.pathname)} 请求失败：${(error as Error).message || '网络错误'}`, 0)
    } finally {
      clearTimeout(timer)
    }
  }

  private async propfind(url: URL, depth: '0' | '1') {
    return this.request(url, {
      method: 'PROPFIND',
      headers: {
        Depth: depth,
        'Content-Type': 'application/xml; charset=utf-8',
      },
      body: '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/><d:getetag/></d:prop></d:propfind>',
    }, [200, 207])
  }

  async test() {
    await this.propfind(this.serverUrl, '0')
    await this.ensureRoot()
    await this.propfind(this.rootUrl, '0')
  }

  async ensureRoot() {
    if (this.rootEnsured) return
    try {
      await this.propfind(this.rootUrl, '0')
      this.rootEnsured = true
      return
    } catch (error) {
      if (!(error instanceof WebDavRequestError) || error.status !== 404) throw error
    }

    const segments = decodePathname(this.rootUrl.pathname).split('/').filter(Boolean)
    const serverSegments = decodePathname(this.serverUrl.pathname).split('/').filter(Boolean)
    const remoteSegments = segments.slice(serverSegments.length)
    let accumulated = ''
    for (const segment of remoteSegments) {
      accumulated = accumulated ? `${accumulated}/${segment}` : segment
      await this.request(appendUrlPath(this.serverUrl, accumulated, true), { method: 'MKCOL' }, [200, 201, 204, 405])
    }
    this.rootEnsured = true
  }

  async ensureDirectory(relativeDirectory: string) {
    await this.ensureRoot()
    const normalizedDirectory = normalizeRelativePath(relativeDirectory)
    if (this.ensuredDirectories.has(normalizedDirectory)) return
    const segments = normalizedDirectory.split('/').filter(Boolean)
    let accumulated = ''
    for (const segment of segments) {
      accumulated = accumulated ? `${accumulated}/${segment}` : segment
      if (this.ensuredDirectories.has(accumulated)) continue
      await this.request(appendUrlPath(this.rootUrl, accumulated, true), { method: 'MKCOL' }, [200, 201, 204, 405])
      this.ensuredDirectories.add(accumulated)
    }
  }

  private parseDirectory(xml: string) {
    const entries: Array<{ href: string; directory: boolean; size: number; modified: number | null; etag: string }> = []
    const responsePattern = /<(?:[\w.-]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?response>/gi
    let match: RegExpExecArray | null
    while ((match = responsePattern.exec(xml))) {
      const block = match[1]
      const href = decodeXml(extractTag(block, 'href'))
      if (!href) continue
      const resourceType = extractTag(block, 'resourcetype')
      const directory = /<(?:[\w.-]+:)?collection\b/i.test(resourceType)
      const sizeValue = Number.parseInt(extractTag(block, 'getcontentlength'), 10)
      const modifiedValue = Date.parse(extractTag(block, 'getlastmodified'))
      entries.push({
        href,
        directory,
        size: Number.isFinite(sizeValue) ? sizeValue : 0,
        modified: Number.isFinite(modifiedValue) ? modifiedValue : null,
        etag: decodeXml(extractTag(block, 'getetag')).replace(/^"|"$/g, ''),
      })
    }
    return entries
  }

  async list() {
    await this.ensureRoot()
    const files = new Map<string, RemoteFile>()
    const pending: Array<{ path: string; url: URL }> = [{ path: '', url: this.rootUrl }]
    const visited = new Set<string>()
    const rootPath = decodePathname(this.rootUrl.pathname).replace(/\/+$/, '')

    while (pending.length) {
      const current = pending.shift()!
      if (visited.has(current.path)) continue
      visited.add(current.path)
      const response = await this.propfind(current.url, '1')
      const entries = this.parseDirectory(await response.text())

      for (const entry of entries) {
        const entryUrl = new URL(entry.href, current.url)
        const entryPathname = decodePathname(entryUrl.pathname).replace(/\/+$/, '')
        if (entryPathname === rootPath || !entryPathname.startsWith(`${rootPath}/`)) continue
        const relativePath = normalizeRelativePath(entryPathname.slice(rootPath.length + 1))
        if (!relativePath) continue
        if (entry.directory) {
          if (!visited.has(relativePath)) pending.push({ path: relativePath, url: appendUrlPath(this.rootUrl, relativePath, true) })
        } else {
          files.set(relativePath, {
            path: relativePath,
            size: entry.size,
            modified: entry.modified,
            etag: entry.etag,
          })
        }
      }
    }

    return files
  }

  async stat(path: string) {
    const normalizedPath = normalizeRelativePath(path)
    const response = await this.propfind(appendUrlPath(this.rootUrl, normalizedPath), '0')
    const entry = this.parseDirectory(await response.text()).find(item => !item.directory)
    if (!entry) throw new Error(`WebDAV 未返回文件属性：${normalizedPath}`)
    return {
      path: normalizedPath,
      size: entry.size,
      modified: entry.modified,
      etag: entry.etag,
    } satisfies RemoteFile
  }

  private async prepareUpload(path: string) {
    const normalizedPath = normalizeRelativePath(path)
    const parent = posix.dirname(normalizedPath)
    if (parent !== '.') await this.ensureDirectory(parent)
    else await this.ensureRoot()
    return normalizedPath
  }

  private async finishUpload(normalizedPath: string) {
    // Persist exactly the metadata a later PROPFIND will return. Using PUT
    // response timestamps here can otherwise make an unchanged upload look
    // remotely modified on the next synchronization.
    return this.stat(normalizedPath)
  }

  async upload(path: string, data: Uint8Array, modified: number) {
    const normalizedPath = await this.prepareUpload(path)
    await this.request(appendUrlPath(this.rootUrl, normalizedPath), {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(data.byteLength),
        'X-OC-Mtime': String(Math.floor(modified / 1000)),
      },
      body: data as BodyInit,
    }, [200, 201, 204])
    return this.finishUpload(normalizedPath)
  }

  async uploadFile(path: string, absolutePath: string, size: number, modified: number) {
    const normalizedPath = await this.prepareUpload(path)
    await this.request(appendUrlPath(this.rootUrl, normalizedPath), {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(size),
        'X-OC-Mtime': String(Math.floor(modified / 1000)),
      },
      body: createReadStream(absolutePath) as unknown as BodyInit,
      duplex: 'half',
    }, [200, 201, 204])
    return this.finishUpload(normalizedPath)
  }

  private downloadResponse(path: string) {
    return this.request(appendUrlPath(this.rootUrl, normalizeRelativePath(path)), { method: 'GET' }, [200])
  }

  async download(path: string) {
    const response = await this.downloadResponse(path)
    return new Uint8Array(await response.arrayBuffer())
  }

  async downloadTo(path: string, absolutePath: string) {
    const response = await this.downloadResponse(path)
    if (!response.body) throw new Error(`WebDAV 下载没有响应内容：${normalizeRelativePath(path)}`)
    const body = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
    await pipeline(body, createWriteStream(absolutePath, { flags: 'wx' }))
  }

  async hash(path: string) {
    const response = await this.downloadResponse(path)
    if (!response.body) throw new Error(`WebDAV 下载没有响应内容：${normalizeRelativePath(path)}`)
    const digest = createHash('sha256')
    for await (const chunk of Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])) {
      digest.update(chunk as Uint8Array)
    }
    return digest.digest('hex')
  }
}

const localSignature = (file: LocalFile) => `${file.size}:${Math.round(file.modified)}`
const remoteSignature = (file: RemoteFile) => `${file.size}:${file.modified ?? ''}:${file.etag}`

const hashFile = async (absolutePath: string) => {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(absolutePath)) digest.update(chunk)
  return digest.digest('hex')
}

const readSetting = async <T>(key: string): Promise<T | null> => {
  const row = await prisma.setting.findUnique({ where: { key } })
  return row?.value as T | null
}

const writeSetting = async (key: string, value: unknown) => {
  await prisma.setting.upsert({
    where: { key },
    create: { key, value: value as Prisma.InputJsonValue },
    update: { value: value as Prisma.InputJsonValue, updatedAt: new Date() },
  })
}

const deriveSecretKey = () => createHash('sha256')
  .update(`yarc:webdav-sync:${appConfig.jwtSecret}`)
  .digest()

const encryptPassword = (password: string): SecretEnvelope => {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', deriveSecretKey(), iv)
  const ciphertext = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()])
  return {
    version: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  }
}

const decryptPassword = (envelope: SecretEnvelope) => {
  if (envelope.version !== 1) throw new Error('不支持的 WebDAV 密码存储版本')
  const decipher = createDecipheriv('aes-256-gcm', deriveSecretKey(), Buffer.from(envelope.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'))
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8')
}

const makeLocalFile = async (root: string, absolutePath: string): Promise<LocalFile> => {
  const info = await stat(absolutePath)
  return {
    path: relative(root, absolutePath).split(sep).join('/'),
    absolutePath,
    size: info.size,
    modified: info.mtimeMs,
  }
}

const localPathSignature = async (absolutePath: string) => {
  try {
    const info = await stat(absolutePath)
    return `${info.size}:${Math.round(info.mtimeMs)}`
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

const assertLocalUnchanged = async (absolutePath: string, expected: LocalFile | undefined) => {
  const current = await localPathSignature(absolutePath)
  const expectedSignature = expected ? localSignature(expected) : null
  if (current !== expectedSignature) {
    throw new Error('本地文件在同步过程中发生变化，已跳过下载以避免覆盖')
  }
}

const atomicDownload = async (
  absolutePath: string,
  modified: number | null,
  download: (temporaryPath: string) => Promise<void>,
  beforeCommit: () => Promise<void>,
) => {
  await mkdir(dirname(absolutePath), { recursive: true })
  const temporaryPath = join(dirname(absolutePath), `${SYNC_TEMP_PREFIX}${randomUUID()}.tmp`)
  try {
    await download(temporaryPath)
    await beforeCommit()
    await rename(temporaryPath, absolutePath)
    if (modified != null && Number.isFinite(modified)) {
      const date = new Date(modified)
      await utimes(absolutePath, date, date).catch(() => {})
    }
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {})
    throw error
  }
}

const safeLocalDestination = (root: string, relativePath: string) => {
  const destination = resolve(root, normalizeRelativePath(relativePath))
  const normalizedRoot = resolve(root)
  if (destination !== normalizedRoot && !destination.startsWith(`${normalizedRoot}${sep}`)) {
    throw new Error(`同步路径超出 data 目录：${relativePath}`)
  }
  return destination
}

const assertNoSymlinkParents = async (root: string, relativePath: string) => {
  const segments = normalizeRelativePath(relativePath).split('/').filter(Boolean).slice(0, -1)
  let current = resolve(root)
  for (const segment of segments) {
    current = join(current, segment)
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink()) throw new Error(`下载路径包含符号链接目录：${relativePath}`)
      if (!info.isDirectory()) throw new Error(`下载路径的上级不是目录：${relativePath}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
  }
}

export class WebDavSyncService {
  private initialized = false
  private config = { ...DEFAULT_WEB_DAV_SYNC_CONFIG }
  private status: WebDavSyncStatus = initialStatus()
  private hasPassword = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private runPromise: Promise<WebDavSyncResult> | null = null
  private testing = false

  async start() {
    await this.ensureInitialized()
  }

  private async ensureInitialized() {
    if (this.initialized) return
    const [savedConfig, savedSecret, savedRuntime] = await Promise.all([
      readSetting<Partial<WebDavSyncConfig>>(CONFIG_KEY),
      readSetting<SecretEnvelope>(SECRET_KEY),
      readSetting<Partial<WebDavSyncStatus>>(RUNTIME_KEY),
    ])
    this.config = normalizeWebDavConfig(savedConfig)
    this.hasPassword = !!savedSecret
    const restoredPhase = savedRuntime?.phase === 'error' || savedRuntime?.phase === 'success'
      ? savedRuntime.phase
      : 'idle'
    this.status = {
      ...initialStatus(),
      ...(savedRuntime || {}),
      enabled: this.config.enabled,
      scheduled: this.config.enabled && this.config.scheduleEnabled,
      running: false,
      currentPath: null,
      phase: this.config.enabled ? restoredPhase : 'disabled',
      message: this.config.enabled ? (savedRuntime?.message || '等待同步') : 'WebDAV 同步未启用',
      nextSyncAt: null,
    }
    if (savedRuntime?.running || savedRuntime?.phase === 'syncing') {
      this.status.lastError = '上次同步未正常完成'
      this.status.message = this.status.lastError
      this.status.phase = 'error'
    }
    this.initialized = true
    this.reschedule()
    this.emitStatus()
  }

  private emitStatus() {
    sseHub.emit({ type: 'webdav-sync-status', status: this.status })
  }

  private setStatus(patch: Partial<WebDavSyncStatus>) {
    this.status = { ...this.status, ...patch }
    this.emitStatus()
  }

  private async persistStatus() {
    await writeSetting(RUNTIME_KEY, this.status)
  }

  private reschedule() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const scheduled = this.config.enabled && this.config.scheduleEnabled
    if (!scheduled) {
      this.setStatus({ scheduled: false, nextSyncAt: null })
      return
    }

    const intervalMs = this.config.intervalMinutes * 60_000
    this.setStatus({ scheduled: true, nextSyncAt: new Date(Date.now() + intervalMs).toISOString() })
    this.timer = setTimeout(() => {
      this.timer = null
      this.setStatus({ nextSyncAt: null })
      void this.sync('schedule')
        .catch(error => {
          console.warn('[WebDAV] Scheduled sync failed:', (error as Error).message)
        })
        .finally(() => {
          if (!this.timer && this.config.enabled && this.config.scheduleEnabled) this.reschedule()
        })
    }, intervalMs)
    this.timer.unref?.()
  }

  async getConfig() {
    await this.ensureInitialized()
    return {
      config: {
        ...this.config,
        selectedPaths: [...this.config.selectedPaths],
        excludePatterns: [...this.config.excludePatterns],
      },
      hasPassword: this.hasPassword,
      protectedPatterns: [...PROTECTED_EXCLUDE_PATTERNS],
    }
  }

  async getStatus() {
    await this.ensureInitialized()
    return { ...this.status }
  }

  async saveConfig(input: Partial<WebDavSyncConfig>, password?: string, clearPassword = false) {
    await this.ensureInitialized()
    if (this.runPromise || this.testing) throw new WebDavSyncBusyError()
    const nextConfig = normalizeWebDavConfig(input, this.config)
    if (nextConfig.enabled && !nextConfig.url) throw new Error('启用 WebDAV 同步前必须填写 WebDAV 地址')
    const remoteTargetChanged = nextConfig.url !== this.config.url
      || nextConfig.username !== this.config.username
      || nextConfig.remotePath !== this.config.remotePath

    const encryptedPassword = typeof password === 'string' && password.length > 0
      ? encryptPassword(password)
      : null
    const configJson = nextConfig as unknown as Prisma.InputJsonValue
    await prisma.$transaction(async (transaction) => {
      await transaction.setting.upsert({
        where: { key: CONFIG_KEY },
        create: { key: CONFIG_KEY, value: configJson },
        update: { value: configJson, updatedAt: new Date() },
      })
      if (clearPassword) {
        await transaction.setting.deleteMany({ where: { key: SECRET_KEY } })
      } else if (encryptedPassword) {
        await transaction.setting.upsert({
          where: { key: SECRET_KEY },
          create: { key: SECRET_KEY, value: encryptedPassword as Prisma.InputJsonValue },
          update: { value: encryptedPassword as Prisma.InputJsonValue, updatedAt: new Date() },
        })
      }
      if (remoteTargetChanged) {
        await transaction.setting.deleteMany({ where: { key: MANIFEST_KEY } })
      }
    })

    if (clearPassword) this.hasPassword = false
    else if (encryptedPassword) this.hasPassword = true
    this.config = nextConfig
    this.setStatus({
      enabled: nextConfig.enabled,
      phase: nextConfig.enabled ? 'idle' : 'disabled',
      message: nextConfig.enabled ? '设置已保存，等待同步' : 'WebDAV 同步未启用',
      lastError: null,
      ...(remoteTargetChanged ? {
        lastSyncAt: null,
        lastSuccessAt: null,
        lastResult: null,
        processed: 0,
        total: 0,
      } : {}),
    })
    this.reschedule()
    await this.persistStatus()
    return this.getConfig()
  }

  private async readPassword(explicitPassword?: string) {
    if (typeof explicitPassword === 'string') return explicitPassword
    const envelope = await readSetting<SecretEnvelope>(SECRET_KEY)
    if (!envelope) return ''
    return decryptPassword(envelope)
  }

  async testConnection(input?: Partial<WebDavSyncConfig>, explicitPassword?: string) {
    await this.ensureInitialized()
    if (this.runPromise || this.testing) throw new WebDavSyncBusyError()
    const testConfig = normalizeWebDavConfig(input, this.config)
    if (!testConfig.url) throw new Error('请填写 WebDAV 地址')
    const previousPhase = this.status.phase
    this.testing = true
    this.setStatus({ phase: 'testing', running: true, message: '正在测试 WebDAV 连接…', lastError: null })
    try {
      const client = new WebDavClient(testConfig, await this.readPassword(explicitPassword))
      const started = Date.now()
      await client.test()
      const latencyMs = Date.now() - started
      this.setStatus({
        phase: this.config.enabled ? 'idle' : 'disabled',
        running: false,
        message: `WebDAV 连接成功（${latencyMs} ms）`,
        lastError: null,
      })
      await this.persistStatus()
      return { ok: true, latencyMs, message: 'WebDAV 连接成功' }
    } catch (error) {
      const message = (error as Error).message || 'WebDAV 连接失败'
      this.setStatus({ phase: 'error', running: false, message, lastError: message })
      await this.persistStatus().catch(() => {})
      throw error
    } finally {
      this.testing = false
      if (this.status.phase === 'testing') this.setStatus({ phase: previousPhase, running: false })
    }
  }

  async getLocalTree() {
    await this.ensureInitialized()
    const walk = async (directory: string): Promise<WebDavSyncTreeNode[]> => {
      let entries
      try {
        entries = await readdir(directory, { withFileTypes: true })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw error
      }

      const nodes: WebDavSyncTreeNode[] = []
      for (const entry of entries.sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
        return a.name.localeCompare(b.name)
      })) {
        if (entry.isSymbolicLink() || (entry.isFile() && entry.name.startsWith(SYNC_TEMP_PREFIX) && entry.name.endsWith('.tmp'))) continue
        const absolutePath = join(directory, entry.name)
        const path = relative(appConfig.dataDir, absolutePath).split(sep).join('/')
        if (isProtectedSyncPath(path)) continue
        if (entry.isDirectory()) {
          nodes.push({ name: entry.name, path, type: 'directory', children: await walk(absolutePath) })
        } else if (entry.isFile()) {
          try {
            const info = await stat(absolutePath)
            nodes.push({ name: entry.name, path, type: 'file', size: info.size, modified: info.mtime.toISOString() })
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
        }
      }
      return nodes
    }

    return walk(appConfig.dataDir)
  }

  private async scanLocalFiles(syncConfig: WebDavSyncConfig) {
    const files = new Map<string, LocalFile>()
    const walk = async (directory: string) => {
      let entries
      try {
        entries = await readdir(directory, { withFileTypes: true })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink() || (entry.isFile() && entry.name.startsWith(SYNC_TEMP_PREFIX) && entry.name.endsWith('.tmp'))) continue
        const absolutePath = join(directory, entry.name)
        const path = relative(appConfig.dataDir, absolutePath).split(sep).join('/')
        if (isWebDavExcludedPath(path, syncConfig.excludePatterns)) continue
        if (entry.isDirectory()) await walk(absolutePath)
        else if (entry.isFile() && isSelectedPath(path, syncConfig.syncAll, syncConfig.selectedPaths)) {
          try {
            files.set(path, await makeLocalFile(appConfig.dataDir, absolutePath))
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
        }
      }
    }
    await walk(appConfig.dataDir)
    return files
  }

  async sync(trigger: 'manual' | 'schedule' = 'manual') {
    await this.ensureInitialized()
    if (this.runPromise || this.testing) throw new WebDavSyncBusyError()
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
      this.setStatus({ nextSyncAt: null })
    }
    this.runPromise = this.performSync(trigger)
    try {
      return await this.runPromise
    } finally {
      this.runPromise = null
      if (this.config.enabled && this.config.scheduleEnabled) this.reschedule()
    }
  }

  private async performSync(trigger: 'manual' | 'schedule'): Promise<WebDavSyncResult> {
    const syncConfig = { ...this.config, selectedPaths: [...this.config.selectedPaths], excludePatterns: [...this.config.excludePatterns] }
    if (!syncConfig.enabled) throw new Error('WebDAV 同步未启用')
    if (!syncConfig.url) throw new Error('请填写 WebDAV 地址')

    const startedAt = new Date().toISOString()
    this.setStatus({
      enabled: true,
      phase: 'syncing',
      running: true,
      message: trigger === 'schedule' ? '定时同步进行中…' : '正在同步…',
      currentPath: null,
      processed: 0,
      total: 0,
      lastError: null,
    })

    try {
      await this.persistStatus()
      const client = new WebDavClient(syncConfig, await this.readPassword())
      const [localFiles, remoteFiles, savedManifest] = await Promise.all([
        this.scanLocalFiles(syncConfig),
        client.list(),
        readSetting<SyncManifest>(MANIFEST_KEY),
      ])
      const manifest: SyncManifest = savedManifest && typeof savedManifest === 'object' ? { ...savedManifest } : {}
      const remoteCandidates = new Map([...remoteFiles].filter(([path]) => shouldSyncPath(path, syncConfig)))
      const paths = new Set<string>()
      if (syncConfig.direction !== 'download') for (const path of localFiles.keys()) paths.add(path)
      if (syncConfig.direction !== 'upload') for (const path of remoteCandidates.keys()) paths.add(path)
      const sortedPaths = [...paths].sort((a, b) => a.localeCompare(b))

      const result: WebDavSyncResult = {
        trigger,
        startedAt,
        finishedAt: startedAt,
        uploaded: 0,
        downloaded: 0,
        skipped: 0,
        conflicts: 0,
        failed: 0,
        errors: [],
      }
      let downloadedAny = false
      let currentAction: WebDavSyncErrorItem['action'] = 'scan'
      this.setStatus({ total: sortedPaths.length })

      const recordError = (item: WebDavSyncErrorItem) => {
        if (result.errors.length < MAX_RECORDED_ERRORS) result.errors.push(item)
      }

      const recordManifest = (path: string, local: LocalFile, remote: RemoteFile) => {
        manifest[path] = {
          local: localSignature(local),
          remote: remoteSignature(remote),
          syncedAt: new Date().toISOString(),
        }
      }

      const upload = async (path: string, local: LocalFile) => {
        currentAction = 'upload'
        const remote = await client.uploadFile(path, local.absolutePath, local.size, local.modified)
        remoteCandidates.set(path, remote)
        recordManifest(path, local, remote)
        result.uploaded++
      }

      const download = async (path: string, remote: RemoteFile) => {
        currentAction = 'download'
        const destination = safeLocalDestination(appConfig.dataDir, path)
        const expectedLocal = localFiles.get(path)
        await assertNoSymlinkParents(appConfig.dataDir, path)
        await assertLocalUnchanged(destination, expectedLocal)
        await atomicDownload(
          destination,
          remote.modified,
          temporaryPath => client.downloadTo(path, temporaryPath),
          async () => {
            await assertNoSymlinkParents(appConfig.dataDir, path)
            await assertLocalUnchanged(destination, expectedLocal)
          },
        )
        const local = await makeLocalFile(appConfig.dataDir, destination)
        localFiles.set(path, local)
        recordManifest(path, local, remote)
        result.downloaded++
        downloadedAny = true
      }

      const conflict = (path: string, message: string) => {
        result.conflicts++
        recordError({ path, action: 'conflict', message })
      }

      for (let index = 0; index < sortedPaths.length; index++) {
        const path = sortedPaths[index]
        currentAction = 'scan'
        this.setStatus({ currentPath: path, processed: index, message: `正在同步 ${path}` })
        try {
          const local = localFiles.get(path)
          const remote = remoteCandidates.get(path)
          const previous = manifest[path]

          if (syncConfig.direction === 'upload') {
            if (!local) {
              result.skipped++
            } else if (previous?.local === localSignature(local) && remote && previous.remote === remoteSignature(remote)) {
              result.skipped++
            } else {
              await upload(path, local)
            }
          } else if (syncConfig.direction === 'download') {
            if (!remote) {
              result.skipped++
            } else if (local && previous?.local === localSignature(local) && previous.remote === remoteSignature(remote)) {
              result.skipped++
            } else {
              await download(path, remote)
            }
          } else if (local && remote) {
            if (!previous) {
              let sameContent = false
              if (local.size === remote.size) {
                const [localHash, remoteHash] = await Promise.all([
                  hashFile(local.absolutePath),
                  client.hash(path),
                ])
                sameContent = localHash === remoteHash
              }
              if (sameContent) {
                recordManifest(path, local, remote)
                result.skipped++
              } else if (remote.modified != null && Math.abs(local.modified - remote.modified) > CLOCK_TOLERANCE_MS) {
                if (local.modified > remote.modified) await upload(path, local)
                else await download(path, remote)
              } else {
                conflict(path, '本地与远端同名文件都存在且内容不同，修改时间不足以安全判断新旧，已跳过')
              }
            } else {
              const localChanged = previous.local !== localSignature(local)
              const remoteChanged = previous.remote !== remoteSignature(remote)
              if (localChanged && remoteChanged) conflict(path, '本地与远端在上次同步后都发生了修改，已跳过以避免覆盖')
              else if (localChanged) await upload(path, local)
              else if (remoteChanged) await download(path, remote)
              else result.skipped++
            }
          } else if (local) {
            await upload(path, local)
          } else if (remote) {
            await download(path, remote)
          } else {
            result.skipped++
          }
        } catch (error) {
          result.failed++
          recordError({
            path,
            action: currentAction,
            message: (error as Error).message || '同步失败',
          })
        }
        this.setStatus({ processed: index + 1 })
      }

      result.finishedAt = new Date().toISOString()
      await writeSetting(MANIFEST_KEY, manifest)
      if (downloadedAny) sseHub.emit({ type: 'files-changed', action: 'webdav-sync' })

      const problemCount = result.failed + result.conflicts
      const message = problemCount
        ? `同步完成：上传 ${result.uploaded}，下载 ${result.downloaded}，冲突 ${result.conflicts}，失败 ${result.failed}`
        : `同步完成：上传 ${result.uploaded}，下载 ${result.downloaded}，跳过 ${result.skipped}`
      const nextSyncAt = this.config.enabled && this.config.scheduleEnabled
        ? new Date(Date.now() + this.config.intervalMinutes * 60_000).toISOString()
        : null
      const lastError = result.failed
        ? result.errors.find(item => item.action !== 'conflict')?.message || '部分文件同步失败'
        : result.conflicts
          ? '存在未解决的同步冲突'
          : null
      this.setStatus({
        phase: problemCount ? 'error' : 'success',
        running: false,
        message,
        currentPath: null,
        processed: sortedPaths.length,
        total: sortedPaths.length,
        lastSyncAt: result.finishedAt,
        lastSuccessAt: problemCount ? this.status.lastSuccessAt : result.finishedAt,
        nextSyncAt,
        lastError,
        lastResult: result,
      })
      await this.persistStatus()
      return result
    } catch (error) {
      const message = (error as Error).message || 'WebDAV 同步失败'
      this.setStatus({
        phase: 'error',
        running: false,
        message,
        currentPath: null,
        lastSyncAt: new Date().toISOString(),
        lastError: message,
      })
      await this.persistStatus().catch(() => {})
      throw error
    }
  }
}

export const webDavSyncService = new WebDavSyncService()
