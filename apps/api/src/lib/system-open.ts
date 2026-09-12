import { spawn } from 'node:child_process'
import { AppError } from './errors.js'

const systemOpenCommand = (fullPath: string): { command: string; args: string[] } => {
  if (process.platform === 'darwin') return { command: 'open', args: [fullPath] }
  if (process.platform === 'win32') return { command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process -LiteralPath $args[0]', fullPath] }
  return { command: 'xdg-open', args: [fullPath] }
}

export const openWithSystemApp = (fullPath: string): Promise<void> => new Promise((resolve, reject) => {
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
