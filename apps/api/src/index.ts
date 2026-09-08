// Ensure Pi SDK packages installed in the agent npm directory are resolvable
// by child processes spawned by extensions (e.g., pi-subagents async runner).
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
const _require = createRequire(import.meta.url)
const _agentNpmModules = _require('node:path').join(process.cwd(), '.pi', 'agent', 'npm', 'node_modules')
if (_require('node:fs').existsSync(_agentNpmModules)) {
  const _delim = _require('node:path').delimiter
  process.env.NODE_PATH = process.env.NODE_PATH
    ? `${process.env.NODE_PATH}${_delim}${_agentNpmModules}`
    : _agentNpmModules
}

import 'dotenv/config'

if (_require('node:fs').existsSync(_agentNpmModules)) {
  if (!process.env.NODE_OPTIONS?.includes('--conditions=import')) {
    process.env.NODE_OPTIONS = (process.env.NODE_OPTIONS ? process.env.NODE_OPTIONS + ' ' : '') + '--conditions=import'
  }
}

process.on('uncaughtException', (err) => {
  console.error('[UncaughtException]', err.message)
})
process.on('unhandledRejection', (err) => {
  console.error('[UnhandledRejection]', err)
})
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { createNodeWebSocket } from '@hono/node-ws'
import { serveStatic } from '@hono/node-server/serve-static'
import { readFile, access } from 'node:fs/promises'
import { dirname, join, extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { config } from './lib/config.js'
import { corsMiddleware } from './lib/cors.js'
import { authMiddleware } from './lib/auth.js'
import { errorHandler } from './lib/errors.js'

import authRoutes from './routes/auth.js'
import papersRoutes from './routes/papers.js'
import categoriesRoutes from './routes/categories.js'
import notesRoutes from './routes/notes.js'
import conversationsRoutes from './routes/conversations.js'
import searchRoutes from './routes/search.js'
import tasksRoutes from './routes/tasks.js'
import filesRoutes from './routes/files.js'
import projectsRoutes from './routes/projects.js'
import latexRoutes from './routes/latex.js'
import settingsRoutes from './routes/settings.js'
import rankingsRoutes from './routes/rankings.js'
import searchCategoriesRoutes from './routes/search-categories.js'
import agentRoutes from './routes/agent.js'
import agentInteractionsRoutes from './routes/agent-interactions.js'
import subagentRoutes from './routes/subagents.js'
import subagentRunsRoutes from './routes/subagent-runs.js'
import extensionsRoutes from './routes/extensions.js'
import wechatRoutes from './routes/wechat.js'
import webdavRoutes from './routes/webdav.js'
import { getWechatStorageDir } from './lib/wechat-storage.js'
import { chatService } from './services/chat.service.js'
import { piService } from './services/pi.service.js'
import { conversationService } from './services/conversation.service.js'
import { piConversationService } from './services/pi-conversation.service.js'
import { recoverJobs } from './services/job-queue.service.js'
import { streamingRegistry } from './lib/streaming-registry.js'
import { ensureAgentWorkspace } from './lib/agent-workspace.js'
import { prisma } from '@yarc/db'
import { DEFAULT_CHAT_SYSTEM_PROMPT, DEFAULT_SUMMARY_PROMPT } from './lib/prompts.js'
import { fileService } from './services/file.service.js'
import { liveFileService } from './services/live-file.service.js'
import { projectLiveFileManager } from './services/project-live-file.service.js'
import { projectWorkspaceWatcherService } from './services/project-workspace-watcher.service.js'
import { sseHub } from './lib/sse.js'
import { streamBuffer } from './lib/stream-buffer-singleton.js'
import { chatStreamControl } from './lib/chat-stream-control.js'
import { agentInteractionRegistry } from './lib/agent-interaction-registry.js'
import { subagentWatcher } from './lib/subagent-watcher.js'
import { webDavSyncService } from './services/webdav-sync.service.js'
import type { ChatRequest } from '@yarc/shared'

const app = new Hono()
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app })

app.use('*', corsMiddleware(config.cors.origin))
app.onError(errorHandler)

app.route('/api/auth', authRoutes)
app.get('/api/health', (c) => c.json({ status: 'ok', version: '2.0.0' }))

app.use('/api/*', async (c, next) => {
  const path = c.req.path
  if (
    path === '/api/auth/login' ||
    path === '/api/auth/logout' ||
    path === '/api/auth/me' ||
    path === '/api/health' ||
    path === '/api/settings/models' ||
    path === '/api/settings/pi-models/catalog' ||
    path === '/api/pi/models'
  ) {
    return next()
  }
  return authMiddleware()(c, next)
})

app.route('/api/papers', papersRoutes)
app.route('/api/categories', categoriesRoutes)
app.route('/api/notes', notesRoutes)
app.route('/api/conversations', conversationsRoutes)
app.route('/api/search', searchRoutes)
app.route('/api/tasks', tasksRoutes)

app.get(
  '/api/files/live',
  upgradeWebSocket((c) => {
    const path = c.req.query('path') || ''
    let clientId: string | null = null

    return {
      async onOpen(_event, ws) {
        try {
          if (!path) {
            ws.send(JSON.stringify({ type: 'error', code: 'MISSING_PATH', message: 'Path is required' }))
            ws.close()
            return
          }
          const attached = await liveFileService.attachClient(path, ws)
          clientId = attached.client.id
        } catch (err) {
          ws.send(JSON.stringify({ type: 'error', code: 'OPEN_FAILED', message: (err as Error).message || 'Failed to open live file' }))
          ws.close()
        }
      },
      async onMessage(event, ws) {
        try {
          const raw = typeof event.data === 'string' ? event.data : Buffer.from(event.data as any).toString('utf-8')
          const msg = JSON.parse(raw)
          if (!clientId) return
          if (msg.type === 'update' && typeof msg.update === 'string') {
            await liveFileService.applyClientUpdate(path, msg.update, clientId)
          } else if (msg.type === 'flush') {
            const result = await liveFileService.flush(path)
            if (msg.requestId && result) ws.send(JSON.stringify({ type: 'flush-ack', requestId: msg.requestId, ...result }))
          } else if (msg.type === 'resolve-conflict' && (msg.strategy === 'use-live' || msg.strategy === 'use-disk')) {
            const result = await liveFileService.resolveConflict(path, msg.strategy, clientId)
            if (msg.requestId && result) ws.send(JSON.stringify({ type: 'flush-ack', requestId: msg.requestId, ...result, update: liveFileService.getStateUpdate(path) }))
          } else if (msg.type === 'replace-content' && typeof msg.content === 'string') {
            await liveFileService.replaceContent(path, msg.content, 'client', clientId)
            const result = await liveFileService.flush(path)
            if (msg.requestId && result) ws.send(JSON.stringify({ type: 'flush-ack', requestId: msg.requestId, ...result, update: liveFileService.getStateUpdate(path) }))
          } else {
            ws.send(JSON.stringify({ type: 'error', code: 'INVALID_MESSAGE', message: 'Unsupported live file message' }))
          }
        } catch (err) {
          ws.send(JSON.stringify({ type: 'error', code: 'MESSAGE_FAILED', message: (err as Error).message || 'Live file message failed' }))
        }
      },
      onClose() { if (clientId) liveFileService.detachClient(path, clientId) },
      onError() { if (clientId) liveFileService.detachClient(path, clientId) },
    }
  }),
)

app.get(
  '/api/projects/:id/files/live',
  upgradeWebSocket((c) => {
    const projectId = c.req.param('id')
    const path = c.req.query('path') || ''
    let clientId: string | null = null
    let service: Awaited<ReturnType<typeof projectLiveFileManager.get>> | null = null
    return {
      async onOpen(_event, ws) {
        try {
          if (!path) {
            ws.send(JSON.stringify({ type: 'error', code: 'MISSING_PATH', message: 'Path is required' }))
            ws.close()
            return
          }
          service = await projectLiveFileManager.get(projectId)
          const attached = await service.attachClient(path, ws)
          clientId = attached.client.id
        } catch (err) {
          ws.send(JSON.stringify({ type: 'error', code: 'OPEN_FAILED', message: (err as Error).message || 'Failed to open project live file' }))
          ws.close()
        }
      },
      async onMessage(event, ws) {
        try {
          if (!service || !clientId) return
          const raw = typeof event.data === 'string' ? event.data : Buffer.from(event.data as any).toString('utf-8')
          const msg = JSON.parse(raw)
          if (msg.type === 'update' && typeof msg.update === 'string') {
            await service.applyClientUpdate(path, msg.update, clientId)
          } else if (msg.type === 'flush') {
            const result = await service.flush(path)
            if (msg.requestId && result) ws.send(JSON.stringify({ type: 'flush-ack', requestId: msg.requestId, ...result }))
          } else if (msg.type === 'resolve-conflict' && (msg.strategy === 'use-live' || msg.strategy === 'use-disk')) {
            const result = await service.resolveConflict(path, msg.strategy, clientId)
            if (msg.requestId && result) ws.send(JSON.stringify({ type: 'flush-ack', requestId: msg.requestId, ...result, update: service.getStateUpdate(path) }))
          } else if (msg.type === 'replace-content' && typeof msg.content === 'string') {
            await service.replaceContent(path, msg.content, 'client', clientId)
            const result = await service.flush(path)
            if (msg.requestId && result) ws.send(JSON.stringify({ type: 'flush-ack', requestId: msg.requestId, ...result, update: service.getStateUpdate(path) }))
          } else {
            ws.send(JSON.stringify({ type: 'error', code: 'INVALID_MESSAGE', message: 'Unsupported live file message' }))
          }
        } catch (err) {
          ws.send(JSON.stringify({ type: 'error', code: 'MESSAGE_FAILED', message: (err as Error).message || 'Project live file message failed' }))
        }
      },
      onClose() { if (service && clientId) service.detachClient(path, clientId) },
      onError() { if (service && clientId) service.detachClient(path, clientId) },
    }
  }),
)

app.route('/api/files', filesRoutes)
app.route('/api/projects', projectsRoutes)
app.route('/api/latex', latexRoutes)
app.route('/api/settings', settingsRoutes)
app.route('/api/rankings', rankingsRoutes)
app.route('/api/search-categories', searchCategoriesRoutes)
app.route('/api/agent', agentRoutes)
app.route('/api/agent-interactions', agentInteractionsRoutes)
app.route('/api/subagents', subagentRoutes)
app.route('/api/subagent-runs', subagentRunsRoutes)
app.route('/api/extensions', extensionsRoutes)
app.route('/api/settings/wechat', wechatRoutes)
app.route('/api/webdav', webdavRoutes)
app.get('/api/pi/models', async (c) => c.json(await piService.listModels(c.req.query('refresh') === '1')))

app.get('/api/events', () => {
  let clientId = crypto.randomUUID()
  const stream = new ReadableStream({
    start(controller) {
      const remove = sseHub.add(clientId, controller)
      const timer = setInterval(() => {
        try { controller.enqueue(': keepalive\n\n') } catch { clearInterval(timer) }
      }, 30_000)
      const origRemove = remove
      const cleanup = () => { clearInterval(timer); origRemove() }
      ;(controller as any)._cleanup = cleanup
    },
  })
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  })
})

app.get(
  '/api/chat',
  upgradeWebSocket((c) => {
    let conversationId: string | null = null
    let streamMsgId: string | null = null
    let streamStarted = false
    let clientClosed = false
    let unsubscribeAttachedStream: (() => void) | null = null

    return {
      onOpen(_event, ws) {
        const url = new URL(c.req.url)
        conversationId = url.searchParams.get('conversation_id')
        if (!conversationId) {
          ws.send(JSON.stringify({ type: 'error', message: 'conversation_id is required' }))
          ws.close()
        }
      },

      async onMessage(event, ws) {
        const safeSend = (payload: unknown) => {
          if (clientClosed) return
          try { ws.send(JSON.stringify(payload)) } catch { clientClosed = true }
        }

        try {
          const data = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString())

          if (data.type === 'attach' && conversationId) {
            const messageId = String(data.messageId || '')
            if (!messageId) {
              safeSend({ type: 'error', message: 'messageId is required' })
              safeSend({ type: 'done' })
              return
            }

            const bufferedStream = streamBuffer.get(messageId)
            const afterSequence = Math.max(0, Math.floor(Number(data.afterSequence || 0)))
            let lastSequence = afterSequence
            let replaying = true
            let terminalSent = false
            const pendingLive: unknown[] = []

            unsubscribeAttachedStream?.()
            unsubscribeAttachedStream = streamBuffer.subscribe(messageId, (event) => {
              if (replaying) {
                pendingLive.push(event)
                return
              }
              const sequence = Number((event as any)?.eventSequence || 0)
              if (sequence && sequence <= lastSequence) return
              if (sequence) lastSequence = sequence
              safeSend(event)
              if ((event as any)?.type === 'done') {
                terminalSent = true
                unsubscribeAttachedStream?.()
                unsubscribeAttachedStream = null
              }
            })

            safeSend({ type: 'stream_start', messageId, branchId: bufferedStream?.branchId, userMessage: bufferedStream?.userMessage, eventSequence: afterSequence })
            for (const replayed of streamBuffer.getEvents(messageId, afterSequence)) {
              const sequence = Number((replayed as any)?.eventSequence || 0)
              if (sequence) lastSequence = Math.max(lastSequence, sequence)
              safeSend(replayed)
              if ((replayed as any)?.type === 'done') terminalSent = true
            }
            replaying = false
            for (const live of pendingLive) {
              const sequence = Number((live as any)?.eventSequence || 0)
              if (sequence && sequence <= lastSequence) continue
              if (sequence) lastSequence = sequence
              safeSend(live)
              if ((live as any)?.type === 'done') terminalSent = true
            }

            if (!streamBuffer.has(messageId)) {
              unsubscribeAttachedStream?.()
              unsubscribeAttachedStream = null
              if (!terminalSent) safeSend({ type: 'done', eventSequence: lastSequence + 1 })
            }
            return
          }

          if (data.type === 'chat' && conversationId) {
            if (streamingRegistry.has(conversationId)) {
              safeSend({ type: 'error', code: 'STREAM_ACTIVE', message: 'Conversation already has an active stream' })
              safeSend({ type: 'done' })
              return
            }

            streamMsgId = randomUUID()
            streamingRegistry.register(conversationId, streamMsgId, data.branchId || 'main', '')

            const prepared = await chatService.handleEditBranch(conversationId, data) as any
            const branchId = prepared?.branchId || data.branchId || 'main'
            data.branchId = branchId

            const isEditBranch = Boolean(data.editMessageId)
            const conversationTitle = !isEditBranch && typeof data.content === 'string'
              ? await conversationService.updateDefaultTitleFromMessage(conversationId, data.content).catch(() => null)
              : null
            const pendingUserMessage = {
              id: `pending-user-${streamMsgId}`,
              conversationId,
              branchId,
              role: 'user' as const,
              content: data.content,
              toolCalls: null,
              metadata: {
                pending: true,
                context: data.context || null,
                ...(isEditBranch ? { forkFromMessageId: data.editForkMessageId || data.editMessageId || null } : {}),
              },
              createdAt: new Date().toISOString(),
            }
            const [sessionFile, initialLeafId] = await Promise.all([
              piConversationService.getSessionFile(conversationId, branchId),
              piConversationService.getLeafEntryId(conversationId, branchId),
            ])
            await streamBuffer.start(streamMsgId, conversationId, branchId, pendingUserMessage, {
              source: 'user', initialLeafId, sessionFile: sessionFile || undefined,
            })
            streamStarted = true
            streamingRegistry.update(conversationId, streamMsgId, { branchId, sessionFile: sessionFile || '' })
            data.userMessageId = pendingUserMessage.id
            data.assistantMessageId = streamMsgId

            if (isEditBranch) {
              let branchInfo: unknown = undefined
              try {
                const fullMessages = await piConversationService.getBranchMessages(conversationId, branchId)
                branchInfo = (await piConversationService.listBranches(conversationId)).find(b => b.id === branchId)
                safeSend({ type: 'branch_messages', branchId, messages: fullMessages })
              } catch {}
              safeSend({ type: 'stream_start', messageId: streamMsgId, branchId, branch: branchInfo, userMessage: pendingUserMessage })
            } else {
              safeSend({ type: 'stream_start', messageId: streamMsgId, branchId, userMessage: pendingUserMessage, conversationTitle })
            }

            unsubscribeAttachedStream?.()
            unsubscribeAttachedStream = streamBuffer.subscribe(streamMsgId, event => {
              safeSend(event)
              if ((event as any)?.type === 'done') {
                unsubscribeAttachedStream?.()
                unsubscribeAttachedStream = null
              }
            })

            const runConversationId = conversationId
            const runMessageId = streamMsgId
            const heartbeat = setInterval(() => {
              streamBuffer.touch(runMessageId)
              streamingRegistry.touch(runConversationId, runMessageId)
            }, 30_000)
            if (typeof heartbeat.unref === 'function') heartbeat.unref()
            void (async () => {
              let completedNormally = false
              let failed = false
              let cancellationObserved = false
              let terminalRecorded = false
              try {
                for await (const evt of chatService.processMessage(runConversationId, data, { persistUserMessage: false, cancelledMessageId: runMessageId })) {
                  if (chatStreamControl.isCancelled(runMessageId)) {
                    cancellationObserved = true
                    agentInteractionRegistry.cancelByStream(runMessageId, 'stream_cancelled')
                  }
                  if (evt.type === 'done') {
                    completedNormally = true
                    if (!terminalRecorded) {
                      streamBuffer.append(runMessageId, evt)
                      terminalRecorded = true
                    }
                    continue
                  }
                  streamBuffer.append(runMessageId, evt)
                  if (evt.type === 'pi_assistant_entry') continue
                }
              } catch (err) {
                failed = true
                const message = (err as Error).message || 'Chat failed'
                await streamBuffer.fail(runMessageId, message).catch(() => {})
              } finally {
                clearInterval(heartbeat)
                if (!completedNormally && !failed) {
                  failed = true
                  const wasCancelled = cancellationObserved || chatStreamControl.isCancelled(runMessageId)
                  const message = wasCancelled ? 'Request aborted' : 'Chat stream ended unexpectedly'
                  await streamBuffer.fail(runMessageId, message).catch(() => {})
                } else if (completedNormally) {
                  await streamBuffer.complete(runMessageId).catch(() => {})
                }
                agentInteractionRegistry.cancelByStream(runMessageId, completedNormally ? 'stream_completed' : 'stream_ended')
                chatStreamControl.clear(runMessageId)
                streamingRegistry.unregister(runConversationId, runMessageId)
              }
            })()
          }
        } catch (err) {
          const message = (err as Error).message || 'Chat failed'
          if (streamMsgId) {
            if (streamStarted) await streamBuffer.fail(streamMsgId, message).catch(() => {})
            else {
              safeSend({ type: 'error', message })
              safeSend({ type: 'done' })
            }
            if (conversationId) streamingRegistry.unregister(conversationId, streamMsgId)
            chatStreamControl.clear(streamMsgId)
            streamMsgId = null
            streamStarted = false
          } else {
            safeSend({ type: 'error', message })
            safeSend({ type: 'done' })
          }
        }
      },

      onClose() {
        clientClosed = true
        unsubscribeAttachedStream?.()
        unsubscribeAttachedStream = null
      },
    }
  })
)

const runtimeDir =
  typeof import.meta.dirname === 'string'
    ? import.meta.dirname
    : typeof __dirname !== 'undefined'
      ? __dirname
      : dirname(fileURLToPath(import.meta.url))
const webDistDir = join(runtimeDir, '../../web/dist')

app.use('/assets/*', serveStatic({
  root: webDistDir,
  onFound: (_path, c) => c.header('Cache-Control', 'public, max-age=31536000, immutable'),
}))
app.get('/assets/*', (c) => c.notFound())

app.get('/bg/*', async (c) => {
  const bgDir = resolve(config.dataDir, 'backgrounds')
  const relativePath = c.req.path.slice('/bg/'.length)
  const filePath = resolve(bgDir, relativePath)
  if (!filePath.startsWith(`${bgDir}/`)) return c.notFound()

  try {
    const content = await readFile(filePath)
    const ext = extname(filePath).toLowerCase()
    const mimeTypes: Record<string, string> = {
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
    }
    c.header('Content-Type', mimeTypes[ext] || 'application/octet-stream')
    c.header('Cache-Control', 'public, max-age=86400')
    return c.body(content)
  } catch {
    return c.notFound()
  }
})

app.get('*', async (c) => {
  const path = c.req.path
  if (path.startsWith('/api/')) return c.json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404)
  const filePath = join(webDistDir, path)
  try {
    await access(filePath)
    const ext = extname(filePath).toLowerCase()
    const mimeTypes: Record<string, string> = {
      '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json',
      '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
      '.woff': 'font/woff', '.woff2': 'font/woff2',
    }
    const content = await readFile(filePath)
    c.header('Content-Type', mimeTypes[ext] || 'application/octet-stream')
    if (ext === '.html' || path === '/sw.js') c.header('Cache-Control', 'no-cache')
    return c.body(content)
  } catch {
    try {
      const indexHtml = await readFile(join(webDistDir, 'index.html'), 'utf-8')
      c.header('Content-Type', 'text/html')
      c.header('Cache-Control', 'no-cache')
      return c.body(indexHtml)
    } catch {
      return c.text('Frontend not built. Run: pnpm --filter @yarc/web build', 500)
    }
  }
})

async function ensureAgentWorkspaceFromDb() {
  const all = await prisma.setting.findMany()
  const settings: Record<string, unknown> = {}
  for (const s of all) settings[s.key] = s.value
  await ensureAgentWorkspace({
    summaryPrompt: typeof settings.summary_prompt === 'string' ? settings.summary_prompt as string : DEFAULT_SUMMARY_PROMPT,
    systemPrompt: typeof settings.system_prompt === 'string' ? settings.system_prompt as string : DEFAULT_CHAT_SYSTEM_PROMPT,
    agentMd: typeof settings.agent_md === 'string' ? settings.agent_md as string : null,
    skills: settings.skills,
  })
}

const setupChatBridge = () => {
  ;(globalThis as any).__yarcChatBridge = {
    getCurrentConversationId: async () => {
      const convs = await conversationService.list()
      return convs[0]?.id || null
    },
    createConversation: async (paperId?: string) => conversationService.create({ paperId, title: '新对话' }),
    listConversations: async () => conversationService.list(),
    getMessages: async (conversationId: string, branchId?: string) => piConversationService.getMessagesForContext(conversationId, branchId),
    sendMessage: async function* (content: string, conversationId: string, options?: { model?: string; reasoningEffort?: string; thinkingEnabled?: boolean }) {
      const request: ChatRequest = { type: 'chat', content } as ChatRequest
      if (options?.model) (request as any).model = options.model
      if (options?.thinkingEnabled !== undefined) (request as any).thinking_enabled = options.thinkingEnabled
      if (options?.reasoningEffort && options.reasoningEffort !== 'off') (request as any).reasoning_effort = options.reasoningEffort
      else if (options?.reasoningEffort === 'off') (request as any).thinking_enabled = false
      for await (const event of chatService.processMessage(conversationId, request)) yield event
    },
    listBranches: async (conversationId: string) => piConversationService.listBranches(conversationId),
    getSessionFile: async (conversationId: string, branchId: string) => piConversationService.getSessionFile(conversationId, branchId),
    updateTitle: async (conversationId: string, title: string) => conversationService.updateTitle(conversationId, title),
    getConversation: async (conversationId: string) => conversationService.getById(conversationId),
  }
  console.log('[Startup] YARC chat bridge exposed on globalThis.__yarcChatBridge')
}

async function autoStartWechat() {
  const { existsSync } = await import('node:fs')
  const { join } = await import('node:path')
  const storageDir = getWechatStorageDir()
  const credentialFile = join(storageDir, 'credentials.json')

  if (!existsSync(credentialFile)) {
    console.log('[Startup] No WeChat credentials found, skipping auto-start')
    return
  }

  console.log('[Startup] WeChat credentials found, initializing Pi session for auto-reconnect…')
  try {
    await piService.initForExtensions()
    console.log('[Startup] WeChat auto-start initiated')
  } catch (err) {
    console.warn('[Startup] WeChat auto-start failed:', err)
  }
}

const server = serve(
  { fetch: app.fetch, port: config.port },
  (info) => {
    console.log(`🚀 YARC server running at http://localhost:${info.port}`)
    console.log(`   Environment: ${config.nodeEnv}`)
    console.log(`   Database: ${config.databaseUrl.replace(/\/\/.*@/, '//***@')}`)

    recoverJobs()
    fileService.startWatcher()
    projectWorkspaceWatcherService.start().catch((err) => {
      console.warn('[Startup] Project workspace watcher failed to start:', err)
    })
    webDavSyncService.start().catch((err) => {
      console.warn('[Startup] WebDAV sync scheduler failed to start:', err)
    })

    ensureAgentWorkspaceFromDb()
      .then(() => piService.recoverRuntimeJournals())
      .then(({ recovered }) => {
        if (recovered > 0) console.log(`[Startup] Recovered ${recovered} interrupted Pi Runtime run(s)`)
      })
      .catch((err) => {
        console.warn('[Startup] Agent workspace seed or Runtime recovery failed:', err)
      })

    setupChatBridge()
    subagentWatcher.start()
    autoStartWechat().catch((err) => {
      console.warn('[Startup] WeChat auto-start failed:', err)
    })
  }
)

injectWebSocket(server)

let shuttingDown = false
const shutdown = async (signal: string) => {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[Shutdown] ${signal}: disposing Pi Runtime Workers`)
  projectWorkspaceWatcherService.stop()
  await projectLiveFileManager.disposeAll().catch((err) => console.warn('[Shutdown] Project live file disposal failed:', err))
  await piService.disposeRuntimes(signal).catch((err) => {
    console.warn('[Shutdown] Pi Runtime disposal failed:', err)
  })
  server.close((err) => {
    if (err && (err as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') {
      console.error('[Shutdown] HTTP server close failed:', err)
      process.exit(1)
    }
    process.exit(0)
  })
}

process.once('SIGTERM', () => { void shutdown('SIGTERM') })
process.once('SIGINT', () => { void shutdown('SIGINT') })
