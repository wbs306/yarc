import { spawn } from 'node:child_process'
import { AppError } from './errors.js'

export const OFFICE_VIEW_MODES = new Set(['html', 'text', 'outline', 'issues', 'stats'])
const OFFICE_VIEW_TIMEOUT_MS = 30_000
const OFFICE_VIEW_MAX_BYTES = 8 * 1024 * 1024

export const runOfficeView = (fullPath: string, mode: string): Promise<string> => new Promise((resolve, reject) => {
  const child = spawn('officecli', ['view', fullPath, mode], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, OFFICECLI_NO_AUTO_RESIDENT: '1' },
  })
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  let stdoutBytes = 0
  let stderrBytes = 0
  let settled = false
  const finish = (error?: Error, content?: string) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    if (error) reject(error)
    else resolve(content || '')
  }
  const timer = setTimeout(() => {
    child.kill('SIGTERM')
    finish(new AppError('OFFICECLI_TIMEOUT', 'officecli preview timed out', 504))
  }, OFFICE_VIEW_TIMEOUT_MS)

  child.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return finish(new AppError('OFFICECLI_NOT_AVAILABLE', 'officecli is not installed or not in PATH', 503))
    finish(error)
  })
  child.stdout.on('data', (chunk: Buffer) => {
    stdoutBytes += chunk.length
    if (stdoutBytes > OFFICE_VIEW_MAX_BYTES) {
      child.kill('SIGTERM')
      finish(new AppError('OFFICECLI_OUTPUT_TOO_LARGE', 'Office preview output is too large', 413))
      return
    }
    stdout.push(chunk)
  })
  child.stderr.on('data', (chunk: Buffer) => {
    stderrBytes += chunk.length
    if (stderrBytes <= 512 * 1024) stderr.push(chunk)
  })
  child.on('close', (code) => {
    if (settled) return
    const output = Buffer.concat(stdout).toString('utf-8')
    if (code === 0) return finish(undefined, output)
    const detail = Buffer.concat(stderr).toString('utf-8').trim()
    if (detail) console.warn('[office] officecli preview failed:', detail)
    finish(new AppError('OFFICECLI_FAILED', 'officecli failed to render preview', 500))
  })
})
