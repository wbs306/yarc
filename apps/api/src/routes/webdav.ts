import { Hono, type Context } from 'hono'
import type { WebDavSyncConfig } from '@yarc/shared'
import {
  WebDavRequestError,
  WebDavSyncBusyError,
  webDavSyncService,
} from '../services/webdav-sync.service.js'

const webdav = new Hono()

const errorResponse = (c: Context, error: unknown, fallbackCode: string, fallbackStatus: 400 | 500 = 400) => {
  const message = (error as Error)?.message || 'WebDAV 操作失败'
  if (error instanceof WebDavSyncBusyError) {
    return c.json({ error: { code: 'WEBDAV_SYNC_BUSY', message } }, 409)
  }
  if (error instanceof WebDavRequestError) {
    const status = error.status === 401 || error.status === 403 ? 401 : 502
    return c.json({ error: { code: 'WEBDAV_REQUEST_FAILED', message } }, status)
  }
  return c.json({ error: { code: fallbackCode, message } }, fallbackStatus)
}

// GET /api/webdav/config
webdav.get('/config', async (c) => {
  try {
    return c.json(await webDavSyncService.getConfig())
  } catch (error) {
    return errorResponse(c, error, 'WEBDAV_CONFIG_READ_FAILED', 500)
  }
})

// PUT /api/webdav/config
webdav.put('/config', async (c) => {
  try {
    const body = await c.req.json().catch(() => null) as {
      config?: Partial<WebDavSyncConfig>
      password?: string
      clearPassword?: boolean
    } | null
    if (!body || !body.config || typeof body.config !== 'object') {
      return c.json({ error: { code: 'INVALID_BODY', message: 'config must be an object' } }, 400)
    }
    const result = await webDavSyncService.saveConfig(
      body.config,
      typeof body.password === 'string' ? body.password : undefined,
      body.clearPassword === true,
    )
    return c.json(result)
  } catch (error) {
    return errorResponse(c, error, 'WEBDAV_CONFIG_SAVE_FAILED')
  }
})

// GET /api/webdav/status
webdav.get('/status', async (c) => {
  try {
    return c.json({ status: await webDavSyncService.getStatus() })
  } catch (error) {
    return errorResponse(c, error, 'WEBDAV_STATUS_READ_FAILED', 500)
  }
})

// GET /api/webdav/files — data/ tree used by the selection UI.
webdav.get('/files', async (c) => {
  try {
    return c.json({ files: await webDavSyncService.getLocalTree() })
  } catch (error) {
    return errorResponse(c, error, 'WEBDAV_FILE_TREE_FAILED', 500)
  }
})

// POST /api/webdav/test — accepts unsaved form values; a blank password reuses the saved secret.
webdav.post('/test', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({})) as {
      config?: Partial<WebDavSyncConfig>
      password?: string
    }
    const result = await webDavSyncService.testConnection(
      body.config && typeof body.config === 'object' ? body.config : undefined,
      typeof body.password === 'string' ? body.password : undefined,
    )
    return c.json(result)
  } catch (error) {
    return errorResponse(c, error, 'WEBDAV_TEST_FAILED')
  }
})

// POST /api/webdav/sync
webdav.post('/sync', async (c) => {
  try {
    return c.json({ result: await webDavSyncService.sync('manual') })
  } catch (error) {
    return errorResponse(c, error, 'WEBDAV_SYNC_FAILED')
  }
})

export default webdav
