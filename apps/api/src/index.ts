// Ensure Pi SDK packages installed in the agent npm directory are resolvable
// by child processes spawned by extensions (e.g., pi-subagents async runner).
import { createRequire } from 'node:module'
const _require = createRequire(import.meta.url)
const _agentNpmModules = _require('node:path').join(process.cwd(), '.pi', 'agent', 'npm', 'node_modules')
if (_require('node:fs').existsSync(_agentNpmModules)) {
  const _delim = _require('node:path').delimiter
  process.env.NODE_PATH = process.env.NODE_PATH
    ? `${process.env.NODE_PATH}${_delim}${_agentNpmModules}`
    : _agentNpmModules
}

import 'dotenv/config'

// Set --conditions=import AFTER dotenv so the server's own require() is unaffected.
// This is inherited by child processes (pi-subagents async runner) where jiti needs
// it to resolve ESM-only Pi SDK packages.
if (_require('node:fs').existsSync(_agentNpmModules)) {
  if (!process.env.NODE_OPTIONS?.includes('--conditions=import')) {
    process.env.NODE_OPTIONS = (process.env.NODE_OPTIONS ? process.env.NODE_OPTIONS + ' ' : '') + '--conditions=import'
  }
}

// Prevent unhandled errors from crashing the server
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
import { sseHub } from './lib/sse.js'
import { streamBuffer } from './lib/stream-buffer-singleton.js'
import { chatStreamControl } from './lib/chat-stream-control.js'
import { agentInteractionRegistry } from './lib/agent-interaction-registry.js'
import { subagentWatcher } from './lib/subagent-watcher.js'
import { webDavSyncService } from './services/webdav-sync.service.js'
import type { ChatRequest } from '@yarc/shared'

const app = new Hono()
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app })

// ── Global Middleware ────────────────────────────────────────────────────────

app.use('*', corsMiddleware(config.cors.origin))
app.onError(errorHandler)

// ── Public Routes ────────────────────────────────────────────────────────────

app.route('/api/auth', authRoutes)

// ── Health check ─────────────────────────────────────────────────────────────

app.get('/api/health', (c) => c.json({ status: 'ok', version: '2.0.0' }))

// ── Auth-protected API Routes ────────────────────────────────────────────────

// Apply auth middleware to all /api/* routes except auth
app.use('/api/*', async (c, next) => {
  // Skip auth for login/logout and health
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
// ── WebSocket live workspace files ──────────────────────────────────────────

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
            if (msg.requestId && result) {
              ws.send(JSON.stringify({ type: 'flush-ack', requestId: msg.requestId, ...result }))
            }
          } else if (msg.type === 'resolve-conflict' && (msg.strategy === 'use-live' || msg.strategy === 'use-disk')) {
            const result = await liveFileService.resolveConflict(path, msg.strategy, clientId)
            if (msg.requestId && result) {
              ws.send(JSON.stringify({
                type: 'flush-ack',
                requestId: msg.requestId,
                ...result,
                update: liveFileService.getStateUpdate(path),
              }))
            }
          } else if (msg.type === 'replace-content' && typeof msg.content === 'string') {
            await liveFileService.replaceContent(path, msg.content, 'client', clientId)
            const result = await liveFileService.flush(path)
            if (msg.requestId && result) {
              ws.send(JSON.stringify({
                type: 'flush-ack',
                requestId: msg.requestId,
                ...result,
                update: liveFileService.getStateUpdate(path),
              }))
            }
          } else {
            ws.send(JSON.stringify({ type: 'error', code: 'INVALID_MESSAGE', message: 'Unsupported live file message' }))
          }
        } catch (err) {
          ws.send(JSON.stringify({ type: 'error', code: 'MESSAGE_FAILED', message: (err as Error).message || 'Live file message failed' }))
        }
      },
      onClose() {
        if (clientId) liveFileService.detachClient(path, clientId)
      },
      onError() {
        if (clientId) liveFileService.detachClient(path, clientId)
      },
    }
  }),
)

app.route('/api/files', filesRoutes)
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

// ── SSE: real-time paper/task status ─────────────────────────────────────────

app.get('/api/events', () => {
  let clientId = crypto.randomUUID()
  const stream = new ReadableStream({
    start(controller) {
      const remove = sseHub.add(clientId, controller)
      // Keepalive ping every 30s
      const timer = setInterval(() => {
        try { controller.enqueue(': keepalive\n\n') } catch { clearInterval(timer) }
      }, 30_000)
      // Cleanup on close
      const origRemove = remove
      const cleanup = () => { clearInterval(timer); origRemove() }
      // Hono doesn't expose close event directly, so we rely on write errors
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

// ── WebSocket Chat ───────────────────────────────────────────────────────────

app.get(
  '/api/chat',
  upgradeWebSocket((c) => {
    let conversationId: string | null = null
    let streamMsgId: string | null = null
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
            safeSend({
              type: 'stream_start',
              messageId,
              branchId: bufferedStream?.branchId,
              userMessage: bufferedStream?.userMessage,
            })
            for (const evt of streamBuffer.getEvents(messageId)) safeSend(evt)

            if (!streamBuffer.has(messageId)) {
              safeSend({ type: 'done' })
              return
            }

            unsubscribeAttachedStream?.()
            unsubscribeAttachedStream = streamBuffer.subscribe(messageId, (evt) => {
              safeSend(evt)
              if ((evt as any)?.type === 'done') {
                unsubscribeAttachedStream?.()
                unsubscribeAttachedStream = null
              }
            })
            return
          }

          if (data.type === 'chat' && conversationId) {
            // Prepare message (may create branch for edits)
            const originalBranchId = data.branchId
            const prepared = await chatService.handleEditBranch(conversationId, data) as any
            const branchId = prepared?.branchId || data.branchId || 'main'
            data.branchId = branchId

            // Generate stable in-flight user/assistant IDs. The pending user
            // message is retained with the stream so an immediate refresh can
            // restore the complete turn before Pi JSONL has persisted it.
            const { randomUUID } = await import('node:crypto')
            streamMsgId = randomUUID()
            const isEditBranch = !!(prepared?.branchId && prepared.branchId !== originalBranchId)
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
                ...(isEditBranch ? { forkFromMessageId: data.editMessageId || null } : {}),
              },
              createdAt: new Date().toISOString(),
            }
            streamBuffer.start(streamMsgId, conversationId, branchId, pendingUserMessage)

            // Register in streaming registry for resumption
            const sessionFile = await piConversationService.getSessionFile(conversationId, branchId) || ''
            streamingRegistry.register(conversationId, streamMsgId, branchId, sessionFile)

            // In-flight IDs let replay metadata map pending messages to their
            // canonical Pi JSONL entries after persistence.
            data.userMessageId = pendingUserMessage.id
            data.assistantMessageId = streamMsgId

            // For edits with new branch, send full message list
            if (isEditBranch) {
              let branchInfo: unknown = undefined
              try {
                const fullMessages = await piConversationService.getBranchMessages(conversationId, branchId)
                branchInfo = (await piConversationService.listBranches(conversationId)).find(b => b.id === branchId)
                safeSend({ type: 'branch_messages', branchId, messages: fullMessages })
              } catch { /* non-fatal */ }
              // For edits, the new session is forked before the edited turn.
              // Show the edited user message optimistically; Pi will persist it
              // when prompt() starts, and refresh will load the Pi entry ID.
              safeSend({
                type: 'stream_start',
                messageId: streamMsgId,
                branchId,
                branch: branchInfo,
                userMessage: pendingUserMessage,
              })
            } else {
              // For new messages, send userMessage in stream_start
              safeSend({
                type: 'stream_start',
                messageId: streamMsgId,
                branchId,
                userMessage: pendingUserMessage,
              })
            }

            // Detach the producer from this WebSocket handler. If the browser
            // refreshes, the socket closes but this background task keeps writing
            // to streamBuffer; the refreshed page can attach to the same message.
            const runConversationId = conversationId
            const runMessageId = streamMsgId
            const heartbeat = setInterval(() => {
              streamBuffer.touch(runMessageId)
            }, 30_000)
            if (typeof heartbeat.unref === 'function') heartbeat.unref()
            void (async () => {
              let completedNormally = false
              let failed = false
              let cancellationObserved = false
              let terminalRecorded = false
              try {
                // Always drain the generator. In particular, do not break on
                // the first `done`: Pi's generator uses the next() after that
                // yield to await prompt settlement and persist the session.
                for await (const evt of chatService.processMessage(runConversationId, data, { persistUserMessage: false, cancelledMessageId: runMessageId })) {
                  if (chatStreamControl.isCancelled(runMessageId)) {
                    cancellationObserved = true
                    agentInteractionRegistry.cancelByStream(runMessageId, 'stream_cancelled')
                  }

                  if (evt.type === 'done') {
                    completedNormally = true
                    // ChatService may add a final done after Pi already did.
                    // Persist and send only one terminal event.
                    if (!terminalRecorded) {
                      streamBuffer.append(runMessageId, evt)
                      terminalRecorded = true
                    }
                    continue
                  }

                  streamBuffer.append(runMessageId, evt)

                  // Pi entry IDs are applied by reloading the branch from
                  // Pi JSONL when the stream completes, not by mutating
                  // temporary in-flight IDs.
                  // User entry mappings are needed by the live editor: the
                  // pending user ID must be replaced before the user can edit
                  // immediately after stopping a turn. Assistant mappings stay
                  // internal because the stream ID is still needed by stop.
                  if (evt.type === 'pi_assistant_entry') continue

                  safeSend(evt)
                }
              } catch (err) {
                failed = true
                const message = (err as Error).message || 'Chat failed'
                safeSend({ type: 'error', message })
                await streamBuffer.fail(runMessageId, message).catch(() => {})
                safeSend({ type: 'done' })
              } finally {
                clearInterval(heartbeat)

                // A generator that exits without a terminal event is a
                // failure, including a cancelled /compact operation that
                // returns early. Make it visible and unblock the client.
                if (!completedNormally && !failed) {
                  failed = true
                  const wasCancelled = cancellationObserved || chatStreamControl.isCancelled(runMessageId)
                  const message = wasCancelled ? 'Request aborted' : 'Chat stream ended unexpectedly'
                  safeSend({ type: 'error', message })
                  await streamBuffer.fail(runMessageId, message).catch(() => {})
                  safeSend({ type: 'done' })
                } else if (completedNormally) {
                  await streamBuffer.complete(runMessageId).catch(() => {})
                  safeSend({ type: 'done' })
                }

                agentInteractionRegistry.cancelByStream(runMessageId, completedNormally ? 'stream_completed' : 'stream_ended')
                chatStreamControl.clear(runMessageId)
                // Resolve stop requests only after stream persistence and Pi
                // generator cleanup have completed.
                streamingRegistry.unregister(runConversationId, runMessageId)
              }
            })()
          }
        } catch (err) {
          const message = (err as Error).message || 'Chat failed'
          safeSend({ type: 'error', message })
          if (streamMsgId) {
            await streamBuffer.fail(streamMsgId, message).catch(() => {})
            streamMsgId = null
          }
          // Even failures before stream_start (notably stale edit entry IDs)
          // must terminate the client-side stream state.
          safeSend({ type: 'done' })
        }
      },

      onClose() {
        // Do not fail the stream on client disconnect. A page refresh or route
        // switch should only detach the client; the backend stream continues and
        // can be replayed from /streaming-message while it is still active.
        clientClosed = true
        unsubscribeAttachedStream?.()
        unsubscribeAttachedStream = null
      },
    }
  })
)

// ── Serve Vue static files ───────────────────────────────────────────────────

const runtimeDir =
  typeof import.meta.dirname === 'string'
    ? import.meta.dirname
    : typeof __dirname !== 'undefined'
      ? __dirname
      : dirname(fileURLToPath(import.meta.url))
const webDistDir = join(runtimeDir, '../../web/dist')

// Hashed Vite assets are immutable. Missing assets must stay 404 instead of
// falling through to index.html, so stale lazy imports can be detected reliably.
app.use('/assets/*', serveStatic({
  root: webDistDir,
  onFound: (_path, c) => c.header('Cache-Control', 'public, max-age=31536000, immutable'),
}))
app.get('/assets/*', (c) => c.notFound())

// Backgrounds are runtime user data, served outside the frontend build output.
app.get('/bg/*', async (c) => {
  const bgDir = resolve(config.dataDir, 'backgrounds')
  const relativePath = c.req.path.slice('/bg/'.length)
  const filePath = resolve(bgDir, relativePath)
  if (!filePath.startsWith(`${bgDir}/`)) return c.notFound()

  try {
    const content = await readFile(filePath)
    const ext = extname(filePath).toLowerCase()
    const mimeTypes: Record<string, string> = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.webp': 'image/webp',
      '.gif': 'image/gif',
    }
    c.header('Content-Type', mimeTypes[ext] || 'application/octet-stream')
    c.header('Cache-Control', 'public, max-age=86400')
    return c.body(content)
  } catch {
    return c.notFound()
  }
})

// SPA fallback: all non-API routes serve index.html
app.get('*', async (c) => {
  const path = c.req.path

  // Skip API routes
  if (path.startsWith('/api/')) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404)
  }

  // Try to serve the exact file first
  const filePath = join(webDistDir, path)
  try {
    await access(filePath)
    const ext = extname(filePath).toLowerCase()
    const mimeTypes: Record<string, string> = {
      '.html': 'text/html',
      '.js': 'application/javascript',
      '.css': 'text/css',
      '.json': 'application/json',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.gif': 'image/gif',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
      '.woff': 'font/woff',
      '.woff2': 'font/woff2',
    }
    const content = await readFile(filePath)
    c.header('Content-Type', mimeTypes[ext] || 'application/octet-stream')
    if (ext === '.html' || path === '/sw.js') c.header('Cache-Control', 'no-cache')
    return c.body(content)
  } catch {
    // File not found, serve index.html (SPA fallback)
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

// ── Start Server ─────────────────────────────────────────────────────────────

// Seed agent workspace filesystem from DB once at startup.
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

// ── Expose chat bridge for WeChat extension ─────────────────────────────

const setupChatBridge = () => {
  ;(globalThis as any).__yarcChatBridge = {
    /**
     * Get the current active conversation ID (from the most recent conversation).
     */
    getCurrentConversationId: async () => {
      const convs = await conversationService.list()
      return convs[0]?.id || null
    },

    /**
     * Create a new conversation.
     */
    createConversation: async (paperId?: string) => {
      return conversationService.create({ paperId, title: '新对话' })
    },

    /**
     * List all conversations.
     */
    listConversations: async () => {
      return conversationService.list()
    },

    /**
     * Get messages for a conversation branch.
     */
    getMessages: async (conversationId: string, branchId?: string) => {
      return piConversationService.getMessagesForContext(conversationId, branchId)
    },

    /**
     * Send a chat message and yield events.
     * This is an async generator that yields ChatEvent objects.
     */
    sendMessage: async function* (content: string, conversationId: string, options?: { model?: string; reasoningEffort?: string }) {
      const request: ChatRequest = { type: 'chat', content } as ChatRequest
      if (options?.model) (request as any).model = options.model
      if (options?.reasoningEffort) (request as any).reasoning_effort = options.reasoningEffort

      for await (const event of chatService.processMessage(conversationId, request)) {
        yield event
      }
    },

    /**
     * List branches for a conversation.
     */
    listBranches: async (conversationId: string) => {
      return piConversationService.listBranches(conversationId)
    },

    /**
     * Get the Pi session file for a conversation branch.
     */
    getSessionFile: async (conversationId: string, branchId: string) => {
      return piConversationService.getSessionFile(conversationId, branchId)
    },

    /**
     * Update conversation title.
     */
    updateTitle: async (conversationId: string, title: string) => {
      return conversationService.updateTitle(conversationId, title)
    },

    /**
     * Get conversation details.
     */
    getConversation: async (conversationId: string) => {
      return conversationService.getById(conversationId)
    },
  }
  console.log('[Startup] YARC chat bridge exposed on globalThis.__yarcChatBridge')
}

// ── Auto-start WeChat if credentials exist ──────────────────────────────────

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
    // Initialize Pi SDK and create a session to trigger extension loading
    // The extension's session_start handler will detect credentials and auto-connect
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

    // Recover pending jobs and watch editable workspace files for external changes.
    recoverJobs()
    fileService.startWatcher()
    webDavSyncService.start().catch((err) => {
      console.warn('[Startup] WebDAV sync scheduler failed to start:', err)
    })

    // Seed the agent workspace filesystem from DB once at startup.
    // This replaces the per-request ensureAgentWorkspace() in GET /api/settings
    // that caused repeated file writes and SSE pi-config-changed events.
    ensureAgentWorkspaceFromDb().catch((err) => {
      console.warn('[Startup] Agent workspace seed failed:', err)
    })

    // Expose chat bridge for WeChat extension
    setupChatBridge()

    // Start subagent filesystem watcher for real-time status updates
    subagentWatcher.start()    // Auto-start WeChat if credentials exist
    autoStartWechat().catch((err) => {
      console.warn('[Startup] WeChat auto-start failed:', err)
    })
  }
)

injectWebSocket(server)
