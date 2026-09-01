import { randomUUID } from 'node:crypto'
import { access } from 'node:fs/promises'
import { Worker } from 'node:worker_threads'
import { createRequire } from 'node:module'
import { prisma } from '@yarc/db'
import type { ChatEvent, PiComposerMirror, PiExtensionCommandInfo, PiRuntimeKey, PiTuiSurfaceState } from '@yarc/shared'
import { config } from '../lib/config.js'
import { sseHub } from '../lib/sse.js'
import { agentInteractionRegistry } from '../lib/agent-interaction-registry.js'
import { chatStreamControl } from '../lib/chat-stream-control.js'
import { streamBuffer } from '../lib/stream-buffer-singleton.js'
import { streamingRegistry } from '../lib/streaming-registry.js'
import { runJournalStore } from '../lib/pi-runtime/run-journal.js'
import { ensureAgentWorkspace } from '../lib/agent-workspace.js'
import { AsyncEventQueue } from '../lib/pi-runtime/runtime-events.js'
import type {
  RuntimeHostMessage,
  RuntimeMetadata,
  RuntimeToolExecutionContext,
  RuntimeToolHost,
  RuntimeWorkerMessage,
} from '../lib/pi-runtime/protocol.js'
import { piConversationService } from './pi-conversation.service.js'
import { conversationService } from './conversation.service.js'

interface RuntimeRunRecord {
  runId: string
  queue: AsyncEventQueue<ChatEvent>
  completed: boolean
}

interface ExtensionRunRecord {
  runId: string
  key: PiRuntimeKey
  assistantMessageId: string
  events: ChatEvent[]
  started: boolean
  completed: boolean
  error?: string
  unregisterAbort?: () => void
}

interface RuntimeRecord {
  key: PiRuntimeKey
  worker: Worker
  generation: number
  state: 'starting' | 'idle' | 'running' | 'reloading' | 'disposing' | 'failed'
  sessionFile?: string
  leafEntryId?: string | null
  commands: PiExtensionCommandInfo[]
  diagnostics: Array<{ type: string; message: string }>
  contextUsage?: RuntimeMetadata['contextUsage']
  lastUsedAt: number
  ready: Promise<void>
  resolveReady: () => void
  rejectReady: (error: Error) => void
  activeRun?: RuntimeRunRecord
  extensionRuns: Map<string, ExtensionRunRecord>
  pendingReload?: { generation: number; reason: string }
  toolHost: RuntimeToolHost
  toolAbortControllers: Map<string, AbortController>
  surfaces: Map<string, PiTuiSurfaceState>
  surfaceOwners: Map<string, { clientId: string; updatedAt: number }>
  uiState: Map<string, ChatEvent>
  requests: Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>
  uiRequestIds: Map<string, string>
}

export interface RuntimeSnapshot {
  key: PiRuntimeKey
  state: RuntimeRecord['state']
  generation: number
  sessionFile?: string
  leafEntryId?: string | null
  commands: PiExtensionCommandInfo[]
  diagnostics: Array<{ type: string; message: string }>
  contextUsage?: RuntimeMetadata['contextUsage']
  surfaces: PiTuiSurfaceState[]
  uiEvents: ChatEvent[]
}

export interface PiRuntimeRegistryOptions {
  createToolHost: (context: RuntimeToolExecutionContext) => Promise<RuntimeToolHost>
  systemPrompt?: string
}

const runtimeKey = (key: PiRuntimeKey) => `${key.conversationId}:${key.branchId}`
const tsxLoader = createRequire(import.meta.url).resolve('tsx')

export class PiRuntimeRegistry {
  private records = new Map<string, RuntimeRecord>()
  private starting = new Map<string, Promise<RuntimeRecord>>()
  private disposingConversations = new Set<string>()
  // pi-context keeps ACM enabled state in its extension module. Preserve only
  // this small session-level flag across host Worker replacement; the plugin
  // itself is still responsible for the actual CommandCtx implementation.
  private acmEnabled = new Set<string>()
  private mirrors = new Map<string, PiComposerMirror>()
  private metadataChains = new Map<string, Promise<void>>()
  private generation = 1
  private cleanupTimer: ReturnType<typeof setInterval>

  constructor(private readonly options: PiRuntimeRegistryOptions) {
    this.cleanupTimer = setInterval(() => { void this.cleanupIdle() }, 60_000)
    if (typeof this.cleanupTimer.unref === 'function') this.cleanupTimer.unref()
  }

  async *prompt(input: {
    key: PiRuntimeKey
    runId: string
    prompt: string
    userMessageId?: string
    assistantMessageId: string
    model?: string
    thinkingLevel?: string
    thinkingEnabled?: boolean
  }): AsyncGenerator<ChatEvent> {
    const record = await this.ensure(input.key, input.model, input.thinkingLevel)
    if (record.activeRun || record.extensionRuns.size > 0) throw new Error('Runtime already has an active run')
    if (/^\/acm(?:\s|$)/.test(input.prompt.trim()) && record.commands.some(command => command.name === 'acm')) {
      this.acmEnabled.add(runtimeKey(input.key))
    }
    const run: RuntimeRunRecord = {
      runId: input.runId,
      queue: new AsyncEventQueue<ChatEvent>(),
      completed: false,
    }
    record.activeRun = run
    record.state = 'running'
    record.lastUsedAt = Date.now()
    this.post(record, {
      type: 'prompt',
      payload: {
        runId: input.runId,
        prompt: input.prompt,
        userMessageId: input.userMessageId,
        assistantMessageId: input.assistantMessageId,
        model: input.model,
        thinkingLevel: input.thinkingLevel,
        thinkingEnabled: input.thinkingEnabled,
      },
    })

    try {
      for await (const event of run.queue) yield event
    } finally {
      if (record.activeRun === run && run.completed) record.activeRun = undefined
    }
  }

  async *compact(input: {
    key: PiRuntimeKey
    runId: string
    assistantMessageId: string
    customInstructions?: string
    model?: string
    thinkingLevel?: string
    thinkingEnabled?: boolean
  }): AsyncGenerator<ChatEvent> {
    const record = await this.ensure(input.key, input.model, input.thinkingLevel)
    if (record.activeRun || record.extensionRuns.size > 0) throw new Error('Runtime already has an active run')

    const run: RuntimeRunRecord = {
      runId: input.runId,
      queue: new AsyncEventQueue<ChatEvent>(),
      completed: false,
    }
    record.activeRun = run
    record.state = 'running'
    record.lastUsedAt = Date.now()
    this.post(record, { type: 'compact', payload: input })

    try {
      for await (const event of run.queue) yield event
    } finally {
      if (record.activeRun === run && run.completed) record.activeRun = undefined
    }
  }

  async abort(key: PiRuntimeKey, runId: string): Promise<void> {
    const record = this.records.get(runtimeKey(key))
    if (!record || record.activeRun?.runId !== runId) return
    this.post(record, { type: 'abort', runId })
  }

  async getAutocomplete(key: PiRuntimeKey, lines: string[], cursorLine: number, cursorCol: number, force = false): Promise<unknown> {
    const record = await this.ensure(key)
    return this.requestWorker(record, requestId => ({ type: 'autocomplete_request', requestId, lines, cursorLine, cursorCol, force }))
  }

  async applyAutocomplete(key: PiRuntimeKey, input: { lines: string[]; cursorLine: number; cursorCol: number; item: { value: string; label: string; description?: string }; prefix: string }): Promise<unknown> {
    const record = await this.ensure(key)
    return this.requestWorker(record, requestId => ({ type: 'autocomplete_apply', requestId, ...input }))
  }

  async reloadAll(reason = 'manual'): Promise<void> {
    this.generation += 1
    const generation = this.generation
    const disposals: Promise<void>[] = []
    for (const record of [...this.records.values()]) {
      if (record.state === 'running' || record.state === 'starting') {
        record.pendingReload = { generation, reason }
      } else {
        // A new Worker is required to clear Node's extension module cache.
        // session.reload() alone can reuse a cached package factory and miss an
        // installed/updated package version.
        disposals.push(this.disposeRecord(record, `reload:${reason}`))
      }
    }
    await Promise.all(disposals)
  }

  updateComposer(mirror: PiComposerMirror): void {
    const key = runtimeKey(mirror)
    const previous = this.mirrors.get(key)
    if (previous && previous.revision > mirror.revision) return
    this.mirrors.set(key, mirror)
    const record = this.records.get(key)
    if (record) this.post(record, { type: 'composer_update', mirror })
  }

  sendTuiInput(key: PiRuntimeKey, surfaceId: string, data: string, revision?: number, clientId?: string): 'ok' | 'missing' | 'busy' {
    const record = this.records.get(runtimeKey(key))
    if (!record?.surfaces.has(surfaceId)) return 'missing'
    const ownerId = clientId || 'anonymous'
    const owner = record.surfaceOwners.get(surfaceId)
    if (owner && owner.clientId !== ownerId && Date.now() - owner.updatedAt < 15_000) return 'busy'
    record.surfaceOwners.set(surfaceId, { clientId: ownerId, updatedAt: Date.now() })
    this.post(record, { type: 'tui_input', surfaceId, data, revision, clientId })
    return 'ok'
  }

  resizeTui(key: PiRuntimeKey, surfaceId: string, cols: number, rows: number, revision?: number, clientId?: string): boolean {
    const record = this.records.get(runtimeKey(key))
    if (!record?.surfaces.has(surfaceId)) return false
    this.post(record, { type: 'tui_resize', surfaceId, cols, rows, revision, clientId })
    return true
  }

  closeTui(key: PiRuntimeKey, surfaceId: string, clientId?: string): boolean {
    const record = this.records.get(runtimeKey(key))
    if (!record?.surfaces.has(surfaceId)) return false
    this.post(record, { type: 'tui_close', surfaceId, reason: 'browser_close', clientId })
    return true
  }

  getSnapshot(key: PiRuntimeKey): RuntimeSnapshot | null {
    const record = this.records.get(runtimeKey(key))
    if (!record) return null
    return {
      key: record.key,
      state: record.state,
      generation: record.generation,
      sessionFile: record.sessionFile,
      leafEntryId: record.leafEntryId,
      commands: record.commands,
      diagnostics: record.diagnostics,
      contextUsage: record.contextUsage,
      surfaces: [...record.surfaces.values()],
      uiEvents: [...record.uiState.values()],
    }
  }

  async ensureSnapshot(key: PiRuntimeKey): Promise<RuntimeSnapshot> {
    await this.ensure(key)
    return this.getSnapshot(key)!
  }

  async disposeConversation(conversationId: string, reason = 'conversation_deleted'): Promise<void> {
    if (this.disposingConversations.has(conversationId)) return
    this.disposingConversations.add(conversationId)
    try {
      const starting = [...this.starting.entries()]
        .filter(([id]) => id.startsWith(`${conversationId}:`))
        .map(([, promise]) => promise)
      await Promise.allSettled(starting)

      const records = [...this.records.values()].filter(record => record.key.conversationId === conversationId)
      if (!records.length) return

      agentInteractionRegistry.cancelByConversation(conversationId, reason)
      for (const record of records) {
        if (record.activeRun) {
          chatStreamControl.cancel(record.activeRun.runId)
          try { this.post(record, { type: 'abort', runId: record.activeRun.runId }) } catch {}
        }
        for (const run of record.extensionRuns.values()) {
          chatStreamControl.cancel(run.runId)
          try { this.post(record, { type: 'abort', runId: run.runId }) } catch {}
        }
      }

      // Let normal abort handling persist the aborted assistant before the
      // caller removes the conversation and its Session files.
      await Promise.all(records.map(record => this.waitForRecordRuns(record)))
      await Promise.all(records.map(record => this.disposeRecord(record, reason)))
    } finally {
      for (const id of this.acmEnabled) {
        if (id.startsWith(`${conversationId}:`)) this.acmEnabled.delete(id)
      }
      this.disposingConversations.delete(conversationId)
    }
  }

  async disposeAll(reason = 'api_shutdown'): Promise<void> {
    clearInterval(this.cleanupTimer)
    await Promise.allSettled([...this.starting.values()])
    await Promise.all([...this.records.values()].map(record => this.disposeRecord(record, reason)))
    this.acmEnabled.clear()
  }

  private async ensure(key: PiRuntimeKey, model?: string, thinkingLevel?: string): Promise<RuntimeRecord> {
    if (this.disposingConversations.has(key.conversationId)) {
      throw new Error('Conversation is being disposed')
    }
    const id = runtimeKey(key)
    const existing = this.records.get(id)
    if (existing) {
      existing.lastUsedAt = Date.now()
      await existing.ready
      if (existing.state === 'failed') throw new Error('Pi Runtime is unavailable')
      return existing
    }
    const inFlight = this.starting.get(id)
    if (inFlight) return inFlight

    const creation = this.createRuntime(key, model, thinkingLevel)
    this.starting.set(id, creation)
    try {
      return await creation
    } finally {
      if (this.starting.get(id) === creation) this.starting.delete(id)
    }
  }

  private async createRuntime(key: PiRuntimeKey, model?: string, thinkingLevel?: string): Promise<RuntimeRecord> {
    const id = runtimeKey(key)
    const existing = this.records.get(id)
    if (existing) {
      existing.lastUsedAt = Date.now()
      await existing.ready
      if (existing.state === 'failed') throw new Error('Pi Runtime is unavailable')
      return existing
    }

    await this.ensureCapacity()
    const agentWorkspace = await ensureAgentWorkspace()
    let sessionFile = await piConversationService.getSessionFile(key.conversationId, key.branchId)
    if (sessionFile) {
      try { await access(sessionFile) } catch { sessionFile = null }
    }
    let emitFromTool = (_event: ChatEvent) => {}
    let recordRef: RuntimeRecord | undefined
    const toolHost = await this.options.createToolHost({
      getKey: () => recordRef?.key || key,
      getRunId: () => recordRef?.activeRun?.runId,
      emit: event => emitFromTool(event),
    })

    let resolveReady!: () => void
    let rejectReady!: (error: Error) => void
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })

    if (this.disposingConversations.has(key.conversationId)) {
      throw new Error('Conversation is being disposed')
    }

    const workerUrl = new URL('../workers/pi-session.worker.ts', import.meta.url)
    const worker = new Worker(workerUrl, {
      execArgv: ['--import', tsxLoader],
    })
    const record: RuntimeRecord = {
      key: { ...key },
      worker,
      generation: this.generation,
      state: 'starting',
      sessionFile: sessionFile || undefined,
      commands: [],
      diagnostics: [],
      lastUsedAt: Date.now(),
      ready,
      resolveReady,
      rejectReady,
      toolHost,
      toolAbortControllers: new Map(),
      extensionRuns: new Map(),
      surfaces: new Map(),
      surfaceOwners: new Map(),
      uiState: new Map(),
      requests: new Map(),
      uiRequestIds: new Map(),
    }
    recordRef = record
    emitFromTool = event => this.emitToActiveRun(record, event)
    this.records.set(id, record)

    worker.on('message', (message: RuntimeWorkerMessage) => {
      void this.handleWorkerMessage(record, message).catch(error => this.handleWorkerMessageError(record, error))
    })
    worker.on('error', error => this.failRecord(record, error instanceof Error ? error : new Error(String(error))))
    worker.on('exit', code => {
      if (record.state !== 'disposing' && code !== 0) this.failRecord(record, new Error(`Pi Runtime Worker exited with code ${code}`))
      if (this.records.get(runtimeKey(record.key)) === record) this.records.delete(runtimeKey(record.key))
    })

    const conversation = await prisma.conversation.findUnique({
      where: { id: key.conversationId },
      select: { model: true, systemPrompt: true },
    })
    const sessionDir = `${agentWorkspace.agentDir}/sessions`
    this.post(record, {
      type: 'init',
      payload: {
        key,
        generation: record.generation,
        restoreAcm: this.acmEnabled.has(id),
        cwd: agentWorkspace.cwd,
        agentDir: agentWorkspace.agentDir,
        sessionDir,
        sessionFile,
        model: model || conversation?.model || undefined,
        thinkingLevel,
        systemPrompt: conversation?.systemPrompt || this.options.systemPrompt,
        tools: toolHost.manifests,
        composer: this.mirrors.get(id),
      },
    })

    const timeout = setTimeout(() => rejectReady(new Error('Pi Runtime startup timed out')), config.piRuntimeStartTimeoutMs)
    if (typeof timeout.unref === 'function') timeout.unref()
    try {
      await ready
    } catch (err) {
      await this.disposeRecord(record, 'startup_failed')
      throw err
    } finally {
      clearTimeout(timeout)
    }
    return record
  }

  private async handleWorkerMessage(record: RuntimeRecord, message: RuntimeWorkerMessage): Promise<void> {
    record.lastUsedAt = Date.now()
    if (message.type === 'ready') {
      record.key = message.key
      record.generation = message.generation
      record.state = 'idle'
      record.commands = message.commands
      record.diagnostics = message.diagnostics
      await this.saveMetadata(record, message.metadata)
      // A filesystem/config event may arrive while the first request is still
      // creating its Runtime Worker. Resolving the initial waiter is critical:
      // rejecting it here turns the triggering command (for example
      // `/context`) into a failed chat turn. Defer the requested reload one
      // event-loop turn so prompt() can reserve its active run; once reserved,
      // the normal settled-path below disposes the Worker safely.
      const pendingReload = record.pendingReload
      record.pendingReload = undefined
      record.resolveReady()
      this.emitToActiveRun(record, {
        type: 'runtime_state',
        conversationId: record.key.conversationId,
        branchId: record.key.branchId,
        state: 'idle',
        commands: record.commands,
        generation: record.generation,
      })
      if (pendingReload) {
        const deferReload = setTimeout(() => {
          if (record.state === 'disposing' || record.state === 'failed') return
          if (record.activeRun || record.state === 'running') {
            record.pendingReload = pendingReload
            return
          }
          void this.disposeRecord(record, `reload:${pendingReload.reason}`)
        }, 0)
        if (typeof deferReload.unref === 'function') deferReload.unref()
      }
      return
    }

    if (message.type === 'state') {
      if (record.state === 'disposing') return
      record.state = message.state
      if (message.state === 'failed') {
        const error = new Error(message.error || 'Pi Runtime failed')
        record.rejectReady(error)
        this.emitToActiveRun(record, { type: 'error', message: error.message })
      }
      return
    }

    if (message.type === 'extension_run_start') {
      const extensionRun: ExtensionRunRecord = {
        runId: message.runId,
        key: { ...message.key },
        assistantMessageId: message.assistantMessageId,
        events: [],
        started: false,
        completed: false,
      }
      record.extensionRuns.set(message.runId, extensionRun)
      void this.startExtensionRun(record, extensionRun)
      return
    }

    if (message.type === 'event') {
      this.trackUiEvent(record, message.event)
      const extensionRun = message.runId ? record.extensionRuns.get(message.runId) : undefined
      if (extensionRun) {
        if (extensionRun.started) streamBuffer.append(extensionRun.runId, message.event)
        else extensionRun.events.push(message.event)
        return
      }

      const hasMatchingRun = !!record.activeRun && (!message.runId || record.activeRun.runId === message.runId)
      this.emitToActiveRun(record, message.event, message.runId)
      if (!hasMatchingRun) {
        sseHub.emit({
          type: 'pi-runtime-event',
          conversationId: record.key.conversationId,
          branchId: record.key.branchId,
          event: message.event,
          at: new Date().toISOString(),
        })
      }
      return
    }

    if (message.type === 'metadata') {
      await this.saveMetadata(record, message.metadata)
      return
    }

    if (message.type === 'run_complete' || message.type === 'run_error') {
      await this.saveMetadata(record, message.metadata)
      const extensionRun = record.extensionRuns.get(message.runId)
      if (extensionRun) {
        extensionRun.completed = true
        if (message.type === 'run_error') extensionRun.error = message.error
        if (extensionRun.started) await this.finishExtensionRun(record, extensionRun)
      } else {
        const run = record.activeRun
        if (run?.runId === message.runId) {
          run.completed = true
          run.queue.push({ type: 'done' })
          run.queue.end()
          record.activeRun = undefined
        }
      }
      if (record.state !== 'disposing') record.state = 'idle'
      if (record.state !== 'disposing' && record.pendingReload && record.extensionRuns.size === 0) {
        const pendingReload = record.pendingReload
        record.pendingReload = undefined
        await this.disposeRecord(record, `reload:${pendingReload.reason}`)
      }
      return
    }

    if (message.type === 'tool_request') {
      const controller = new AbortController()
      record.toolAbortControllers.set(message.requestId, controller)
      try {
        const result = await record.toolHost.execute(
          message.toolName,
          message.toolCallId,
          message.params,
          controller.signal,
          update => this.post(record, { type: 'tool_update', requestId: message.requestId, update }),
        )
        this.post(record, { type: 'tool_result', requestId: message.requestId, ok: true, result })
      } catch (err) {
        this.post(record, { type: 'tool_result', requestId: message.requestId, ok: false, error: (err as Error).message })
      } finally {
        record.toolAbortControllers.delete(message.requestId)
      }
      return
    }

    if (message.type === 'tool_abort') {
      record.toolAbortControllers.get(message.requestId)?.abort()
      return
    }

    if (message.type === 'ui_request') {
      const streamMessageId = message.runId || record.activeRun?.runId || ''
      try {
        const response = await agentInteractionRegistry.create({
          conversationId: record.key.conversationId,
          branchId: record.key.branchId,
          streamMessageId,
          kind: message.kind,
          title: typeof message.payload.title === 'string' ? message.payload.title : undefined,
          message: typeof message.payload.message === 'string' ? message.payload.message : undefined,
          payload: message.payload,
          timeoutMs: message.timeoutMs ?? config.piExtensionUiTimeoutMs,
          emitRequest: event => {
            record.uiRequestIds.set(message.requestId, event.requestId)
            this.emitToActiveRun(record, event, message.runId)
          },
          emitResolved: event => this.emitToActiveRun(record, event, message.runId),
        })
        record.uiRequestIds.delete(message.requestId)
        this.post(record, {
          type: 'ui_response',
          requestId: message.requestId,
          ok: true,
          value: response.action === 'submit' ? response.value : undefined,
        })
      } catch (err) {
        record.uiRequestIds.delete(message.requestId)
        this.post(record, { type: 'ui_response', requestId: message.requestId, ok: false, error: (err as Error).message })
      }
      return
    }

    if (message.type === 'ui_cancel') {
      const interactionId = record.uiRequestIds.get(message.requestId)
      if (interactionId) {
        agentInteractionRegistry.respond(interactionId, {
          requestId: interactionId,
          action: 'cancel',
          value: { reason: message.reason || 'signal_aborted' },
        })
        record.uiRequestIds.delete(message.requestId)
      }
      return
    }

    if (message.type === 'control_request') {
      try {
        const result = await this.handleControl(record, message.operation, message.payload)
        this.post(record, { type: 'control_result', requestId: message.requestId, ok: true, result })
      } catch (err) {
        this.post(record, { type: 'control_result', requestId: message.requestId, ok: false, error: (err as Error).message })
      }
      return
    }

    if (message.type === 'autocomplete_result') {
      const request = record.requests.get(message.requestId)
      if (!request) return
      record.requests.delete(message.requestId)
      if (message.ok) request.resolve(message.result)
      else request.reject(new Error(message.error || 'Autocomplete failed'))
      return
    }

    if (message.type === 'disposed') {
      if (this.records.get(runtimeKey(record.key)) === record) this.records.delete(runtimeKey(record.key))
    }
  }

  private async startExtensionRun(record: RuntimeRecord, run: ExtensionRunRecord): Promise<void> {
    try {
      const active = streamingRegistry.get(run.key.conversationId)
      if (active && active.messageId !== run.runId) {
        const handedOff = streamingRegistry.handoff(
          run.key.conversationId,
          active.messageId,
          run.runId,
          { branchId: run.key.branchId, sessionFile: record.sessionFile || '' },
        )
        if (!handedOff) throw new Error('Conversation producer handoff failed')
      } else if (!active) {
        streamingRegistry.register(
          run.key.conversationId,
          run.runId,
          run.key.branchId,
          record.sessionFile || '',
        )
      }

      await streamBuffer.start(run.runId, run.key.conversationId, run.key.branchId, undefined, {
        source: 'extension',
        initialLeafId: record.leafEntryId,
        sessionFile: record.sessionFile,
      })
      run.unregisterAbort = chatStreamControl.registerAbortHandler(run.runId, () => {
        this.post(record, { type: 'abort', runId: run.runId })
      })
      run.started = true
      for (const event of run.events.splice(0)) streamBuffer.append(run.runId, event)

      sseHub.emit({
        type: 'pi-extension-run-start',
        conversationId: run.key.conversationId,
        branchId: run.key.branchId,
        messageId: run.runId,
        at: new Date().toISOString(),
      })

      if (run.completed) await this.finishExtensionRun(record, run)
    } catch (err) {
      run.unregisterAbort?.()
      this.post(record, { type: 'abort', runId: run.runId })
      record.extensionRuns.delete(run.runId)
      streamingRegistry.unregister(run.key.conversationId, run.runId)
      sseHub.emit({
        type: 'pi-runtime-event',
        conversationId: run.key.conversationId,
        branchId: run.key.branchId,
        event: { type: 'error', message: (err as Error).message || 'Extension run failed to start' },
        at: new Date().toISOString(),
      })
    }
  }

  private async finishExtensionRun(record: RuntimeRecord, run: ExtensionRunRecord): Promise<void> {
    if (!record.extensionRuns.has(run.runId)) return
    try {
      if (run.error) await streamBuffer.fail(run.runId, run.error)
      else await streamBuffer.complete(run.runId)
    } finally {
      run.unregisterAbort?.()
      chatStreamControl.clear(run.runId)
      streamingRegistry.unregister(run.key.conversationId, run.runId)
      record.extensionRuns.delete(run.runId)
      sseHub.emit({
        type: 'pi-extension-run-complete',
        conversationId: run.key.conversationId,
        branchId: run.key.branchId,
        messageId: run.runId,
        status: run.error ? 'failed' : 'completed',
        at: new Date().toISOString(),
      })
    }
  }

  private emitToActiveRun(record: RuntimeRecord, event: ChatEvent, runId?: string): void {
    const run = record.activeRun
    if (!run || (runId && run.runId !== runId)) return
    run.queue.push(event)
  }

  private trackUiEvent(record: RuntimeRecord, event: ChatEvent): void {
    if (event.type === 'agent_ui_tui_open') {
      record.surfaces.set(event.surface.surfaceId, event.surface)
      return
    }
    if (event.type === 'agent_ui_tui_output') {
      const surface = record.surfaces.get(event.surfaceId)
      if (surface && event.revision >= surface.revision) {
        surface.revision = event.revision
        surface.ansi = event.ansi
        surface.plainText = event.plainText
        surface.hidden = event.hidden
      }
      return
    }
    if (event.type === 'agent_ui_tui_close') {
      record.surfaces.delete(event.surfaceId)
      record.surfaceOwners.delete(event.surfaceId)
      return
    }
    if (event.type === 'agent_ui_status') {
      const id = `status:${event.key}`
      if (event.text) record.uiState.set(id, event)
      else record.uiState.delete(id)
      return
    }
    if (event.type === 'agent_ui_widget') {
      const id = `widget:${event.key}`
      if (event.lines?.length || event.surfaceId) record.uiState.set(id, event)
      else record.uiState.delete(id)
      return
    }
    if (event.type === 'agent_ui_header' || event.type === 'agent_ui_footer' || event.type === 'agent_ui_title' || event.type === 'agent_ui_working') {
      record.uiState.set(event.type, event)
    }
  }

  private async saveMetadata(record: RuntimeRecord, meta?: RuntimeMetadata): Promise<void> {
    if (!meta?.sessionFile) return
    record.sessionFile = meta.sessionFile
    record.leafEntryId = meta.leafEntryId
    record.contextUsage = meta.contextUsage
    const conversationId = meta.conversationId || record.key.conversationId
    const branchId = meta.branchId || record.key.branchId
    await this.withMetadataMutation(conversationId, () => piConversationService.saveSessionInfo(
      conversationId,
      branchId,
      meta.sessionFile!,
      meta.leafEntryId,
      {},
      {
        sessionId: meta.sessionId,
        model: meta.model,
        thinkingLevel: meta.thinkingLevel,
      },
    ))
  }

  private async withMetadataMutation<T>(conversationId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.metadataChains.get(conversationId) || Promise.resolve()
    let result!: T
    const current = previous.catch(() => {}).then(async () => { result = await operation() })
    this.metadataChains.set(conversationId, current)
    try {
      await current
      return result
    } finally {
      if (this.metadataChains.get(conversationId) === current) this.metadataChains.delete(conversationId)
    }
  }

  private async handleControl(record: RuntimeRecord, operation: string, payload: any): Promise<unknown> {
    if (operation === 'allocate_branch') {
      return {
        branchId: `extension-${Date.now()}-${randomUUID().slice(0, 8)}`,
        parentBranchId: record.key.branchId,
        forkEntryId: payload?.entryId || null,
      }
    }
    if (operation === 'finalize_branch') {
      const meta = payload?.metadata as RuntimeMetadata
      if (!meta?.sessionFile) throw new Error('Fork did not create a Session file')
      const oldKey = { ...record.key }
      const nextKey = payload.key as PiRuntimeKey
      await this.withMetadataMutation(nextKey.conversationId, () => piConversationService.saveSessionInfo(nextKey.conversationId, nextKey.branchId, meta.sessionFile!, meta.leafEntryId, {
        parentBranchId: payload.allocation?.parentBranchId || oldKey.branchId,
        forkMessageId: payload.allocation?.forkEntryId || null,
        forkParentEntryId: payload.allocation?.forkEntryId || null,
      }))
      this.rekey(record, nextKey)
      const activeStream = streamingRegistry.get(nextKey.conversationId)
      if (activeStream && record.activeRun?.runId === activeStream.messageId) {
        streamingRegistry.update(nextKey.conversationId, activeStream.messageId, { branchId: nextKey.branchId, sessionFile: meta.sessionFile })
        streamBuffer.updateContext(activeStream.messageId, nextKey.conversationId, nextKey.branchId)
      }
      return { ok: true }
    }
    if (operation === 'allocate_new_conversation') {
      const conversation = await conversationService.create({ id: randomUUID(), title: '新对话' })
      return { conversationId: conversation.id, branchId: 'main' }
    }
    if (operation === 'discard_new_conversation') {
      const conversationId = String(payload?.conversationId || '')
      if (conversationId) await prisma.conversation.delete({ where: { id: conversationId } }).catch(() => {})
      return { ok: true }
    }
    if (operation === 'finalize_new_session') {
      const meta = payload?.metadata as RuntimeMetadata
      const nextKey = payload.key as PiRuntimeKey
      if (!meta?.sessionFile) throw new Error('New Session did not create a Session file')
      await prisma.conversation.update({
        where: { id: nextKey.conversationId },
        data: { model: meta.model || undefined, updatedAt: new Date() },
      })
      try {
        await this.withMetadataMutation(nextKey.conversationId, () => piConversationService.saveSessionInfo(nextKey.conversationId, nextKey.branchId, meta.sessionFile!, meta.leafEntryId))
      } catch (err) {
        await prisma.conversation.delete({ where: { id: nextKey.conversationId } }).catch(() => {})
        throw err
      }
      const previousKey = payload.previousKey as PiRuntimeKey
      const runId = record.activeRun?.runId
      this.rekey(record, nextKey)
      if (runId && streamingRegistry.transfer(previousKey.conversationId, nextKey.conversationId, runId, { branchId: nextKey.branchId, sessionFile: meta.sessionFile })) {
        streamBuffer.updateContext(runId, nextKey.conversationId, nextKey.branchId)
        await runJournalStore.move(previousKey.conversationId, nextKey.conversationId, runId)
      }
      return { ok: true }
    }
    if (operation === 'navigate_tree') {
      const meta = payload?.metadata as RuntimeMetadata
      if (meta?.sessionFile) await this.saveMetadata(record, meta)
      return { ok: true }
    }
    if (operation === 'validate_session') {
      const sessionPath = String(payload?.sessionPath || '')
      const conversations = await prisma.conversation.findMany({ select: { id: true, metadata: true } })
      for (const conversation of conversations) {
        const sessions = (conversation.metadata as any)?.pi?.sessions || {}
        for (const [branchId, info] of Object.entries(sessions) as Array<[string, any]>) {
          if (info?.sessionFile === sessionPath) {
            const targetKey = { conversationId: conversation.id, branchId }
            const targetRuntime = this.records.get(runtimeKey(targetKey))
            if (targetRuntime && targetRuntime !== record) {
              if (targetRuntime.state !== 'idle' || targetRuntime.activeRun) return null
              await this.disposeRecord(targetRuntime, 'session_switch_target')
            }
            return targetKey
          }
        }
      }
      return null
    }
    if (operation === 'session_switched') {
      const meta = payload?.metadata as RuntimeMetadata
      const nextKey = payload.key as PiRuntimeKey
      if (!meta?.sessionFile) throw new Error('Switched Session has no file')
      await this.withMetadataMutation(nextKey.conversationId, () => piConversationService.saveSessionInfo(nextKey.conversationId, nextKey.branchId, meta.sessionFile!, meta.leafEntryId))
      const previousKey = payload.previousKey as PiRuntimeKey
      const runId = record.activeRun?.runId
      this.rekey(record, nextKey)
      if (runId && previousKey.conversationId !== nextKey.conversationId && streamingRegistry.transfer(previousKey.conversationId, nextKey.conversationId, runId, { branchId: nextKey.branchId, sessionFile: meta.sessionFile })) {
        streamBuffer.updateContext(runId, nextKey.conversationId, nextKey.branchId)
        await runJournalStore.move(previousKey.conversationId, nextKey.conversationId, runId)
      } else if (runId && previousKey.conversationId === nextKey.conversationId) {
        streamingRegistry.update(nextKey.conversationId, runId, { branchId: nextKey.branchId, sessionFile: meta.sessionFile })
        streamBuffer.updateContext(runId, nextKey.conversationId, nextKey.branchId)
      }
      return { ok: true }
    }
    throw new Error(`Unsupported Runtime control operation: ${operation}`)
  }

  private rekey(record: RuntimeRecord, nextKey: PiRuntimeKey): void {
    const oldId = runtimeKey(record.key)
    const newId = runtimeKey(nextKey)
    if (oldId !== newId) {
      if (this.records.get(oldId) === record) this.records.delete(oldId)
      const collision = this.records.get(newId)
      if (collision && collision !== record) throw new Error(`Runtime already exists for ${newId}`)
      if (this.acmEnabled.delete(oldId)) this.acmEnabled.add(newId)
      record.key = { ...nextKey }
      this.records.set(newId, record)
    }
  }

  private requestWorker(record: RuntimeRecord, createMessage: (requestId: string) => RuntimeHostMessage): Promise<unknown> {
    const requestId = randomUUID()
    return new Promise((resolve, reject) => {
      record.requests.set(requestId, { resolve, reject })
      this.post(record, createMessage(requestId))
    })
  }

  private post(record: RuntimeRecord, message: RuntimeHostMessage): void {
    record.worker.postMessage(message)
  }

  private handleWorkerMessageError(record: RuntimeRecord, error: unknown): void {
    const normalized = error instanceof Error ? error : new Error(String(error))
    if (record.state === 'disposing') return
    console.warn('[PiRuntimeRegistry] Worker message handling failed:', normalized.message)
    this.failRecord(record, normalized)
  }

  private failRecord(record: RuntimeRecord, error: Error): void {
    if (record.state === 'failed' || record.state === 'disposing') return
    record.state = 'failed'
    for (const controller of record.toolAbortControllers.values()) controller.abort()
    record.toolAbortControllers.clear()
    record.rejectReady(error)
    for (const request of record.requests.values()) request.reject(error)
    record.requests.clear()
    for (const interactionId of record.uiRequestIds.values()) {
      agentInteractionRegistry.respond(interactionId, { requestId: interactionId, action: 'cancel', value: { reason: 'runtime_failed' } })
    }
    record.uiRequestIds.clear()
    if (record.activeRun) {
      record.activeRun.queue.push({ type: 'error', message: error.message })
      record.activeRun.queue.push({ type: 'done' })
      record.activeRun.completed = true
      record.activeRun.queue.end()
      record.activeRun = undefined
    }
    for (const run of record.extensionRuns.values()) {
      run.unregisterAbort?.()
      if (run.started) void streamBuffer.fail(run.runId, error.message)
      streamingRegistry.unregister(run.key.conversationId, run.runId)
    }
    record.extensionRuns.clear()
  }

  private async waitForRecordRuns(record: RuntimeRecord, timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while ((record.activeRun || record.extensionRuns.size > 0) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }

  private async ensureCapacity(): Promise<void> {
    // Count in-flight starts as capacity too. Otherwise concurrent requests for
    // different conversations can all pass the check before their records are
    // inserted and exceed PI_RUNTIME_MAX_ACTIVE.
    if (this.records.size + this.starting.size < config.piRuntimeMaxActive) return
    const candidates = [...this.records.values()]
      .filter(record => record.state === 'idle'
        && record.surfaces.size === 0
        && !record.activeRun
        && record.extensionRuns.size === 0
        && record.requests.size === 0
        && record.toolAbortControllers.size === 0
        && record.uiRequestIds.size === 0)
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt)
    const candidate = candidates[0]
    if (!candidate) throw new Error('Pi Runtime capacity reached; all Runtime Workers are busy')
    await this.disposeRecord(candidate, 'capacity')
  }

  private async cleanupIdle(): Promise<void> {
    const cutoff = Date.now() - config.piRuntimeIdleTtlMs
    const candidates = [...this.records.values()].filter(record =>
      record.lastUsedAt < cutoff
      && record.state === 'idle'
      && !record.activeRun
      && record.extensionRuns.size === 0
      && record.surfaces.size === 0
      && record.requests.size === 0
      && record.toolAbortControllers.size === 0
      && record.uiRequestIds.size === 0
    )
    await Promise.all(candidates.map(record => this.disposeRecord(record, 'idle_ttl')))
  }

  private async disposeRecord(record: RuntimeRecord, reason: string): Promise<void> {
    if (record.state === 'disposing') return
    record.state = 'disposing'
    if (this.records.get(runtimeKey(record.key)) === record) this.records.delete(runtimeKey(record.key))

    // A failed Worker message or a forced conversation deletion can leave the
    // host-side queue open. Close it before terminating the Worker so callers
    // waiting on the Runtime prompt are not left hanging forever.
    if (record.activeRun) {
      record.activeRun.queue.push({ type: 'error', message: `Runtime disposed: ${reason}` })
      record.activeRun.queue.push({ type: 'done' })
      record.activeRun.completed = true
      record.activeRun.queue.end()
      record.activeRun = undefined
    }
    for (const controller of record.toolAbortControllers.values()) controller.abort()
    record.toolAbortControllers.clear()
    for (const request of record.requests.values()) request.reject(new Error(`Runtime disposed: ${reason}`))
    record.requests.clear()
    for (const interactionId of record.uiRequestIds.values()) {
      agentInteractionRegistry.respond(interactionId, { requestId: interactionId, action: 'cancel', value: { reason: `runtime_disposed:${reason}` } })
    }
    record.uiRequestIds.clear()
    for (const run of [...record.extensionRuns.values()]) {
      run.unregisterAbort?.()
      if (run.started) await streamBuffer.fail(run.runId, `Runtime disposed: ${reason}`).catch(() => {})
      streamingRegistry.unregister(run.key.conversationId, run.runId)
      chatStreamControl.clear(run.runId)
      record.extensionRuns.delete(run.runId)
    }
    try {
      this.post(record, { type: 'dispose', reason })
      await Promise.race([
        new Promise<void>(resolve => record.worker.once('exit', () => resolve())),
        new Promise<void>(resolve => setTimeout(resolve, Math.max(35_000, config.piRuntimeStartTimeoutMs))),
      ])
    } finally {
      await record.worker.terminate().catch(() => {})
    }
  }
}
