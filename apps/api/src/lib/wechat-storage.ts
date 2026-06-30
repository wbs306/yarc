import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { config } from './config.js'

/**
 * Resolve the WeChat credential storage directory.
 * Mirrors the extension's own lookup logic:
 *   1. WECHATBOT_STORAGE_DIR env var
 *   2. <dataDir>/.pi/wechatbot  (if .pi dir exists)
 *   3. ~/.wechatbot
 */
export function getWechatStorageDir(): string {
  if (process.env.WECHATBOT_STORAGE_DIR) return process.env.WECHATBOT_STORAGE_DIR
  const cwd = config.dataDir
  if (existsSync(join(cwd, '.pi'))) return join(cwd, '.pi', 'wechatbot')
  return join(homedir(), '.wechatbot')
}
