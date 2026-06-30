import { Hono } from 'hono'
import { resolve } from 'node:path'
import { access } from 'node:fs/promises'
import { config } from '../lib/config.js'
import { sseHub } from '../lib/sse.js'
import { AppError } from '../lib/errors.js'
import { getWechatStorageDir } from '../lib/wechat-storage.js'

const wechat = new Hono()

type WeChatLoginState =
  | 'idle'
  | 'connecting'
  | 'qr_waiting'
  | 'scanned'
  | 'connected'
  | 'disconnected'
  | 'expired'
  | 'error'

type WeChatBridgeStatus = {
  loaded: true
  connected: boolean
  loginState: WeChatLoginState
  accountId: string | null
  userId: string | null
  activeUserId: string | null
  isStreaming: boolean
  lastQrUrl: string | null
  lastError: string | null
  updatedAt: string
}

type YarcWechatBridge = {
  getStatus(): WeChatBridgeStatus
  startLogin(options?: { force?: boolean }): Promise<WeChatBridgeStatus>
  disconnect(): Promise<WeChatBridgeStatus>
  reconnect(options?: { force?: boolean }): Promise<WeChatBridgeStatus>
  getQrUrl(): string | null
  onStatusChange(listener: (status: WeChatBridgeStatus) => void): () => void
}

const getBridge = (): YarcWechatBridge | null => (globalThis as any).__yarcWechatBridge || null

const fileExists = async (path: string) => {
  try { await access(path); return true } catch { return false }
}

const runtimePluginPath = () => resolve(config.dataDir, '.pi', 'agent', 'extensions', 'wechat')

// Track bridge listener for SSE forwarding
let bridgeListenerAttached = false

const attachBridgeListener = () => {
  const bridge = getBridge()
  if (!bridge || bridgeListenerAttached) return
  bridgeListenerAttached = true
  bridge.onStatusChange((status) => {
    sseHub.emit({ type: 'wechat-status', status, at: new Date().toISOString() })
  })
}

// GET /api/settings/wechat/status
wechat.get('/status', async (c) => {
  const runtimePath = runtimePluginPath()
  const runtimeExists = await fileExists(runtimePath)
  const bridge = getBridge()
  const storageDir = getWechatStorageDir()
  const storageExists = await fileExists(storageDir)

  if (bridge) attachBridgeListener()

  const diagnostics: string[] = []
  if (!runtimeExists) diagnostics.push('运行时插件未安装: data/.pi/agent/extensions/wechat')
  if (!bridge && runtimeExists) diagnostics.push('插件已安装但尚未加载，点击「初始化插件」')
  if (!bridge && !runtimeExists) diagnostics.push('请先安装 WeChat 插件')

  return c.json({
    runtimePluginExists: runtimeExists,
    runtimePluginPath: runtimePath,
    storageDir,
    storageExists,
    bridgeLoaded: !!bridge,
    diagnostics,
    status: bridge?.getStatus() || null,
  })
})

// POST /api/settings/wechat/login
wechat.post('/login', async (c) => {
  const bridge = getBridge()
  if (!bridge) throw new AppError('BRIDGE_NOT_LOADED', 'WeChat 插件尚未加载。请先初始化插件。', 400)

  const body = await c.req.json().catch(() => ({}))
  const force = !!(body as any)?.force

  try {
    attachBridgeListener()
    const status = await bridge.startLogin({ force })
    return c.json({ ok: true, status })
  } catch (err) {
    throw new AppError('LOGIN_FAILED', (err as Error).message || 'Login failed', 500)
  }
})

// POST /api/settings/wechat/init — force-load extensions by creating a Pi session
wechat.post('/init', async (c) => {
  const bridge = getBridge()
  if (bridge) return c.json({ ok: true, message: 'Bridge 已加载' })

  try {
    const { piService } = await import('../services/pi.service.js')
    await piService.initForExtensions()
    // Give the extension a moment to register
    await new Promise(r => setTimeout(r, 1000))
    const reloaded = getBridge()
    if (!reloaded) throw new Error('扩展加载完成但 Bridge 未注册，请检查扩展是否正确')
    attachBridgeListener()
    return c.json({ ok: true })
  } catch (err) {
    throw new AppError('INIT_FAILED', (err as Error).message || '初始化失败', 500)
  }
})

// POST /api/settings/wechat/logout
wechat.post('/logout', async (c) => {
  const bridge = getBridge()
  if (!bridge) throw new AppError('BRIDGE_NOT_LOADED', 'WeChat 插件尚未加载', 400)

  const status = await bridge.disconnect()
  return c.json({ ok: true, status })
})

// POST /api/settings/wechat/reconnect
wechat.post('/reconnect', async (c) => {
  const bridge = getBridge()
  if (!bridge) throw new AppError('BRIDGE_NOT_LOADED', 'WeChat 插件尚未加载', 400)

  const body = await c.req.json().catch(() => ({}))
  const force = !!(body as any)?.force

  try {
    attachBridgeListener()
    const status = await bridge.reconnect({ force })
    return c.json({ ok: true, status })
  } catch (err) {
    throw new AppError('RECONNECT_FAILED', (err as Error).message || 'Reconnect failed', 500)
  }
})

export default wechat
