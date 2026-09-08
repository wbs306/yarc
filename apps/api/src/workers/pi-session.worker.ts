import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { parentPort } from 'node:worker_threads'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Unsafe } from 'typebox'
import {
  SessionManager,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  defineTool,
} from '@earendil-works/pi-coding-agent'
import type { ChatEvent, PiComposerMirror, PiExtensionCommandInfo, PiRuntimeKey, PiTuiSurfaceKind } from '@yarc/shared'
import type {
  RuntimeHostMessage,
  RuntimeInitPayload,
  RuntimeMetadata,
  RuntimeToolManifest,
  RuntimeWorkerMessage,
} from '../lib/pi-runtime/protocol.js'
import { SessionDurabilityCoordinator } from '../lib/pi-runtime/session-durability.js'
import { AssistantAbortCoalescer } from '../lib/pi-runtime/assistant-abort-coalescer.js'
import { WebTuiSurface } from '../lib/pi-extension-ui/web-terminal.js'
import { DEFAULT_CHAT_SYSTEM_PROMPT } from '../lib/prompts.js'
import { persistFailedPromptIfMissing } from '../services/pi-failed-turn.js'

if (!parentPort) throw new Error('Pi Runtime Worker requires a parent MessagePort')
const port = parentPort

const post = (message: RuntimeWorkerMessage) => port.postMessage(message)

let loadedThemeModule: any = null
let TuiClass: any = null
const loadTuiClass = async () => {
  const codingAgentEntry = import.meta.resolve('@earendil-works/pi-coding-agent')
  const piTuiEntry = createRequire(codingAgentEntry).resolve('@earendil-works/pi-tui')
  const module = await import(pathToFileURL(piTuiEntry).href)
  if (typeof module.TUI !== 'function') throw new Error('Pi TUI constructor is unavailable')
  return module.TUI
}
const loadDefaultTheme = async () => {
  loadedThemeModule = await import(new URL('../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js', import.meta.url).href)
  loadedThemeModule.initTheme(undefined, false)
  return loadedThemeModule.theme
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  onUpdate?: (value: unknown) => void
}

interface SurfaceRecord {
  surface: WebTuiSurface
  kind: PiTuiSurfaceKind
  overlay: boolean
  key?: string
  close: (reason: 'done' | 'cancelled' | 'timeout' | 'reload' | 'disposed' | 'error') => void
}

let init: RuntimeInitPayload | null = null
let key: PiRuntimeKey | null = null
let generation = 0
let runtime: any = null
let session: any = null
let unsubscribe: (() => void) | null = null
let activeRunId: string | undefined
let activeRootAssistantId: string | undefined
let activeUserMessageId: string | undefined
let activeRunGroupId: string | undefined
let currentAssistantId: string | undefined
let assistantCount = 0
let autoExtensionRun = false
let autoExtensionCompletionScheduled = false
let runIdleBarrier: { runId: string; promise: Promise<void>; resolve: () => void; signalled: boolean } | null = null
let activeToolCount = 0
let pendingCommits = 0
let activityEpoch = 0
let composer: PiComposerMirror | undefined
let requestedModelId: string | undefined
let requestedThinkingLevel: string | undefined
let acmEnabled = false
let currentTheme: any = null
let currentEditorTheme: any = null
let toolsExpanded = false
let editorFactory: any = undefined
let autocompleteProvider: any = undefined
const pending = new Map<string, PendingRequest>()
const surfaces = new Map<string, SurfaceRecord>()
const terminalInputHandlers = new Set<(data: string) => { consume?: boolean; data?: string } | undefined>()
const extensionStatuses = new Map<string, string>()
const deferredAssistantAborts = new AssistantAbortCoalescer()
const durability = new SessionDurabilityCoordinator(
  process.env.PI_SESSION_DURABILITY === 'normal' ? 'normal' : 'strict'
)

const emit = (event: ChatEvent, runId = activeRunId) => {
  activityEpoch += 1
  post({ type: 'event', runId, event })
}

const resetWorkingUi = () => {
  if (!key) return
  emit({
    type: 'agent_ui_working',
    reset: true,
    conversationId: key.conversationId,
    branchId: key.branchId,
  })
}

const requestHost = <T>(
  message: any,
  onUpdate?: (value: unknown) => void,
  signal?: AbortSignal,
): Promise<T> => {
  const requestId = randomUUID()
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener('abort', abort)
    const abort = () => {
      const registered = pending.delete(requestId)
      cleanup()
      if (registered && message.type === 'ui_request') post({ type: 'ui_cancel', requestId, reason: 'signal_aborted' })
      resolve(undefined as T)
    }
    if (signal?.aborted) {
      abort()
      return
    }
    pending.set(requestId, {
      resolve: value => { cleanup(); resolve(value as T) },
      reject: error => { cleanup(); reject(error) },
      onUpdate,
    })
    signal?.addEventListener('abort', abort, { once: true })
    post({ ...message, requestId } as RuntimeWorkerMessage)
  })
}

const metadata = (): RuntimeMetadata => {
  const usage = session?.getContextUsage?.()
  const contextWindow = Number(usage?.contextWindow ?? session?.model?.contextWindow ?? 0)
  const contextUsage = session
    ? {
        tokens: usage?.tokens ?? 0,
        contextWindow,
        percent: usage?.percent ?? (contextWindow > 0 ? 0 : null),
        model: session?.model?.id,
      }
    : undefined
  return {
    conversationId: key?.conversationId || '',
    branchId: key?.branchId || '',
    sessionFile: session?.sessionFile,
    sessionId: session?.sessionId,
    leafEntryId: session?.sessionManager?.getLeafId?.() || null,
    model: session?.model?.id,
    thinkingLevel: session?.thinkingLevel,
    ...(contextUsage ? { contextUsage } : {}),
    updatedAt: new Date().toISOString(),
  }
}

const emitMetadata = () => post({ type: 'metadata', metadata: metadata() })

const thinkingLevel = (value?: string, enabled?: boolean): any => {
  if (enabled === false || value === 'off') return 'off'
  return value || 'medium'
}

const resolveModel = async (modelRuntime: any, modelId?: string) => {
  if (!modelId) return undefined
  const [provider, id] = modelId.split('/')
  let model = provider && id ? modelRuntime.getModel(provider, id) : undefined
  if (!model) {
    const available = await modelRuntime.getAvailable()
    model = available.find((candidate: any) => candidate.id === modelId)
  }
  return model
}

const cloneSchema = (schema: Record<string, unknown>) => Unsafe(schema as any)

const createProxyTools = (manifests: RuntimeToolManifest[]) => manifests.map(manifest => defineTool({
  name: manifest.name,
  label: manifest.label,
  description: manifest.description,
  ...(manifest.promptSnippet ? { promptSnippet: manifest.promptSnippet } : {}),
  ...(manifest.promptGuidelines ? { promptGuidelines: manifest.promptGuidelines } : {}),
  ...(manifest.executionMode ? { executionMode: manifest.executionMode } : {}),
  parameters: cloneSchema(manifest.parameters),
  async execute(toolCallId: string, params: unknown, signal: AbortSignal | undefined, onUpdate: any) {
    const requestId = randomUUID()
    const promise = new Promise<unknown>((resolve, reject) => {
      pending.set(requestId, { resolve, reject, onUpdate })
      post({
        type: 'tool_request',
        requestId,
        runId: activeRunId,
        toolCallId,
        toolName: manifest.name,
        params,
      })
    })
    const abort = () => post({ type: 'tool_abort', requestId })
    signal?.addEventListener('abort', abort, { once: true })
    try {
      return await promise as any
    } finally {
      signal?.removeEventListener('abort', abort)
    }
  },
}))

const findExtensionCommand = (name: string): any => {
  const loaded = session?.resourceLoader?.getExtensions?.()
  for (const extension of loaded?.extensions || []) {
    const command = extension.commands?.get?.(name)
    if (command) return command
  }
  return undefined
}

const applyDefaultCompletion = (
  lines: string[],
  cursorLine: number,
  cursorCol: number,
  item: { value: string },
  prefix: string,
) => {
  const nextLines = [...lines]
  const line = nextLines[cursorLine] || ''
  const start = Math.max(0, cursorCol - prefix.length)
  nextLines[cursorLine] = `${line.slice(0, start)}${item.value}${line.slice(cursorCol)}`
  return { lines: nextLines, cursorLine, cursorCol: start + item.value.length }
}

const defaultAutocompleteProvider = {
  getSuggestions: async (lines: string[], cursorLine: number, cursorCol: number) => {
    const line = lines[cursorLine] || ''
    const beforeCursor = line.slice(0, cursorCol)
    const match = beforeCursor.match(/^\/([^\s]+)\s+([\s\S]*)$/)
    const command = match ? findExtensionCommand(match[1]) : undefined
    const items = command?.getArgumentCompletions ? await command.getArgumentCompletions(match?.[2] || '') : null
    return items?.length ? { items, prefix: match?.[2] || '' } : null
  },
  applyCompletion: applyDefaultCompletion,
}

const collectCommands = (): PiExtensionCommandInfo[] => {
  if (!session?.resourceLoader) return []
  const commands = new Map<string, PiExtensionCommandInfo>()
  const loaded = session.resourceLoader.getExtensions?.()
  for (const extension of loaded?.extensions || []) {
    for (const command of extension.commands?.values?.() || []) {
      commands.set(command.name, {
        name: command.name,
        description: command.description,
        source: 'extension',
      })
    }
  }
  for (const skill of session.resourceLoader.getSkills?.().skills || []) {
    commands.set(`skill:${skill.name}`, {
      name: `skill:${skill.name}`,
      description: skill.description,
      source: 'skill',
    })
  }
  for (const prompt of session.promptTemplates || []) {
    commands.set(prompt.name, {
      name: prompt.name,
      description: prompt.description,
      source: 'prompt',
    })
  }
  return [...commands.values()].sort((a, b) => a.name.localeCompare(b.name))
}

let keybindings: any = {
  matches: () => false,
  getKeys: () => [],
  getDefinition: () => ({ defaultKeys: [] }),
  getConflicts: () => [],
  setUserBindings: () => {},
  getUserBindings: () => ({}),
  getResolvedBindings: () => ({}),
}

const closeSurface = (
  surfaceId: string,
  reason: 'done' | 'cancelled' | 'timeout' | 'reload' | 'disposed' | 'error',
) => {
  const record = surfaces.get(surfaceId)
  if (!record) return
  surfaces.delete(surfaceId)
  record.surface.dispose()
  if (key) {
    emit({
      type: 'agent_ui_tui_close',
      surfaceId,
      conversationId: key.conversationId,
      branchId: key.branchId,
      reason,
    })
  }
}

const closeAllSurfaces = (reason: 'reload' | 'disposed' | 'cancelled' | 'error') => {
  for (const record of [...surfaces.values()]) record.close(reason)
}

const createSurface = (
  kind: PiTuiSurfaceKind,
  overlay: boolean,
  factory: (tui: any, done: (value: unknown) => void) => Promise<any> | any,
  onDone?: (value: unknown) => void,
  surfaceKey?: string,
  placement?: 'aboveEditor' | 'belowEditor',
  overlayOptions?: Record<string, unknown>,
): Promise<{ surfaceId: string; result: unknown }> => new Promise(async (resolve, reject) => {
  if (!key) return reject(new Error('Runtime is not initialized'))
  let settled = false
  let component: any
  if (!TuiClass) return reject(new Error('Pi TUI is not initialized'))
  const surface = new WebTuiSurface(88, 28, TuiClass, snapshot => {
    const event: ChatEvent = snapshot.revision === 1
      ? {
          type: 'agent_ui_tui_open',
          surface: {
            surfaceId: snapshot.surfaceId,
            conversationId: key!.conversationId,
            branchId: key!.branchId,
            kind,
            overlay,
            cols: snapshot.cols,
            rows: snapshot.rows,
            revision: snapshot.revision,
            ansi: snapshot.ansi,
            plainText: snapshot.plainText,
            hidden: snapshot.hidden,
            ...(surfaceKey ? { hostKey: surfaceKey } : {}),
            ...(placement ? { placement } : {}),
            ...(overlayOptions ? { overlayOptions } : {}),
          },
        }
      : {
          type: 'agent_ui_tui_output',
          surfaceId: snapshot.surfaceId,
          conversationId: key!.conversationId,
          branchId: key!.branchId,
          revision: snapshot.revision,
          ansi: snapshot.ansi,
          plainText: snapshot.plainText,
          hidden: snapshot.hidden,
        }
    emit(event)
  }, title => emit({ type: 'agent_ui_title', title, conversationId: key!.conversationId, branchId: key!.branchId }), init?.agentDir)

  const done = (value: unknown) => {
    if (settled) return
    settled = true
    onDone?.(value)
    closeSurface(surface.surfaceId, 'done')
    resolve({ surfaceId: surface.surfaceId, result: value })
  }
  const close = (reason: 'done' | 'cancelled' | 'timeout' | 'reload' | 'disposed' | 'error') => {
    if (!settled) {
      settled = true
      resolve({ surfaceId: surface.surfaceId, result: undefined })
    }
    closeSurface(surface.surfaceId, reason)
  }
  surfaces.set(surface.surfaceId, { surface, kind, overlay, key: surfaceKey, close })

  try {
    component = await factory(surface.tui, done)
    if (!component || typeof component.render !== 'function') throw new Error('Extension TUI factory did not return a Component')
    if (!overlay) surface.mount(component)
    surface.start()
  } catch (err) {
    closeSurface(surface.surfaceId, 'error')
    reject(err)
  }
})

const createUiContext = (): any => {
  const requireKey = () => {
    if (!key) throw new Error('Runtime UI is not initialized')
    return key
  }
  const dialog = async (kind: 'select' | 'confirm' | 'input' | 'editor', payload: Record<string, unknown>, options?: any) => {
    const result = await requestHost<unknown>({
      type: 'ui_request',
      runId: activeRunId,
      kind,
      payload,
      timeoutMs: options?.timeout,
    }, undefined, options?.signal)
    return result
  }
  const replaceKeyedSurface = (kind: PiTuiSurfaceKind, surfaceKey: string) => {
    for (const record of surfaces.values()) {
      if (record.kind === kind && record.key === surfaceKey) record.close('disposed')
    }
  }

  return {
    select: async (title: string, options: string[], opts?: any) => {
      const result: any = await dialog('select', { title, options }, opts)
      return typeof result === 'string' ? result : result?.value
    },
    confirm: async (title: string, message: string, opts?: any) => {
      const result: any = await dialog('confirm', { title, message }, opts)
      return typeof result === 'boolean' ? result : !!result?.confirmed
    },
    input: async (title: string, placeholder?: string, opts?: any) => {
      const result: any = await dialog('input', { title, placeholder }, opts)
      return typeof result === 'string' ? result : result?.value
    },
    editor: async (title: string, prefill?: string) => {
      const result: any = await dialog('editor', { title, prefill, multiline: true })
      return typeof result === 'string' ? result : result?.value
    },
    notify: (message: string, notifyType: 'info' | 'warning' | 'error' = 'info') => {
      const runtimeKey = requireKey()
      emit({
        type: 'agent_interaction_request',
        requestId: randomUUID(),
        conversationId: runtimeKey.conversationId,
        branchId: runtimeKey.branchId,
        streamMessageId: activeRunId || '',
        kind: 'notification',
        title: notifyType === 'error' ? 'Agent 错误' : notifyType === 'warning' ? 'Agent 提醒' : 'Agent 通知',
        message,
        payload: { message, notifyType },
        createdAt: new Date().toISOString(),
      })
    },
    onTerminalInput: (handler: (data: string) => { consume?: boolean; data?: string } | undefined) => {
      terminalInputHandlers.add(handler)
      return () => terminalInputHandlers.delete(handler)
    },
    setStatus: (statusKey: string, text?: string) => {
      const runtimeKey = requireKey()
      if (text) extensionStatuses.set(statusKey, text)
      else extensionStatuses.delete(statusKey)
      for (const record of surfaces.values()) {
        if (record.kind === 'footer') record.surface.invalidate()
      }
      emit({ type: 'agent_ui_status', key: statusKey, text, conversationId: runtimeKey.conversationId, branchId: runtimeKey.branchId, streamMessageId: activeRunId })
    },
    setWorkingMessage: (message?: string) => {
      const runtimeKey = requireKey()
      emit({ type: 'agent_ui_working', message, conversationId: runtimeKey.conversationId, branchId: runtimeKey.branchId })
    },
    setWorkingVisible: (visible: boolean) => {
      const runtimeKey = requireKey()
      emit({ type: 'agent_ui_working', visible, conversationId: runtimeKey.conversationId, branchId: runtimeKey.branchId })
    },
    setWorkingIndicator: (indicator?: { frames?: string[]; intervalMs?: number }) => {
      const runtimeKey = requireKey()
      emit({ type: 'agent_ui_working', indicator, conversationId: runtimeKey.conversationId, branchId: runtimeKey.branchId })
    },
    setHiddenThinkingLabel: (hiddenThinkingLabel?: string) => {
      const runtimeKey = requireKey()
      emit({ type: 'agent_ui_working', hiddenThinkingLabel, conversationId: runtimeKey.conversationId, branchId: runtimeKey.branchId })
    },
    setWidget: (widgetKey: string, content?: string[] | ((tui: any, theme: any) => any), options?: { placement?: 'aboveEditor' | 'belowEditor' }) => {
      const runtimeKey = requireKey()
      replaceKeyedSurface('widget', widgetKey)
      const placement = options?.placement || 'aboveEditor'
      if (!content) {
        emit({ type: 'agent_ui_widget', key: widgetKey, placement, conversationId: runtimeKey.conversationId, branchId: runtimeKey.branchId })
      } else if (Array.isArray(content)) {
        emit({ type: 'agent_ui_widget', key: widgetKey, lines: content, placement, conversationId: runtimeKey.conversationId, branchId: runtimeKey.branchId })
      } else {
        void createSurface('widget', false, async surface => content(surface as any, currentTheme), undefined, widgetKey, placement)
          .catch(err => console.warn('[PiRuntimeWorker] widget failed:', (err as Error).message))
      }
    },
    setFooter: (factory?: (tui: any, theme: any, data: any) => any) => {
      const runtimeKey = requireKey()
      replaceKeyedSurface('footer', 'footer')
      if (!factory) {
        emit({ type: 'agent_ui_footer', conversationId: runtimeKey.conversationId, branchId: runtimeKey.branchId })
        return
      }
      const footerData = { getExtensionStatuses: () => new Map(extensionStatuses), getGitBranch: () => undefined }
      void createSurface('footer', false, async surface => factory(surface as any, currentTheme, footerData), undefined, 'footer')
        .catch(err => console.warn('[PiRuntimeWorker] footer failed:', (err as Error).message))
    },
    setHeader: (factory?: (tui: any, theme: any) => any) => {
      const runtimeKey = requireKey()
      replaceKeyedSurface('header', 'header')
      if (!factory) {
        emit({ type: 'agent_ui_header', conversationId: runtimeKey.conversationId, branchId: runtimeKey.branchId })
        return
      }
      void createSurface('header', false, async surface => factory(surface as any, currentTheme), undefined, 'header')
        .catch(err => console.warn('[PiRuntimeWorker] header failed:', (err as Error).message))
    },
    setTitle: (title: string) => {
      const runtimeKey = requireKey()
      emit({ type: 'agent_ui_title', title, conversationId: runtimeKey.conversationId, branchId: runtimeKey.branchId })
    },
    custom: async (factory: (tui: any, theme: any, kb: any, done: (value: unknown) => void) => any, options?: any) => {
      const resolvedOverlayOptions = typeof options?.overlayOptions === 'function' ? options.overlayOptions() : options?.overlayOptions
      const { result } = await createSurface('custom', !!options?.overlay, async (surface, done) => {
        const component = await factory(surface as any, currentTheme, keybindings, done)
        if (options?.overlay) {
          const handle = surface.showOverlay(component, resolvedOverlayOptions)
          options?.onHandle?.(handle)
        }
        return component
      }, undefined, undefined, undefined, resolvedOverlayOptions)
      return result
    },
    pasteToEditor: (text: string) => {
      const runtimeKey = requireKey()
      const revision = (composer?.revision || 0) + 1
      const selectionStart = composer?.selectionStart ?? composer?.text.length ?? 0
      const selectionEnd = composer?.selectionEnd ?? selectionStart
      const current = composer?.text || ''
      composer = {
        conversationId: runtimeKey.conversationId,
        branchId: runtimeKey.branchId,
        text: `${current.slice(0, selectionStart)}${text}${current.slice(selectionEnd)}`,
        selectionStart: selectionStart + text.length,
        selectionEnd: selectionStart + text.length,
        revision,
        clientId: composer?.clientId || 'extension',
      }
      for (const record of surfaces.values()) {
        if (record.kind === 'editor') record.surface.insertText(text)
      }
      emit({
        type: 'agent_ui_editor_paste',
        text: composer.text,
        revision,
        selectionStart: composer.selectionStart,
        selectionEnd: composer.selectionEnd,
        conversationId: runtimeKey.conversationId,
        branchId: runtimeKey.branchId,
      })
    },
    setEditorText: (text: string) => {
      const runtimeKey = requireKey()
      const revision = (composer?.revision || 0) + 1
      composer = {
        conversationId: runtimeKey.conversationId,
        branchId: runtimeKey.branchId,
        text,
        selectionStart: text.length,
        selectionEnd: text.length,
        revision,
        clientId: composer?.clientId || 'extension',
      }
      for (const record of surfaces.values()) {
        if (record.kind === 'editor') record.surface.setText(text)
      }
      emit({ type: 'agent_ui_editor_set_text', text, revision, selectionStart: text.length, selectionEnd: text.length, conversationId: runtimeKey.conversationId, branchId: runtimeKey.branchId })
    },
    getEditorText: () => composer?.text || '',
    addAutocompleteProvider: (factory: any) => {
      const provided = factory(autocompleteProvider || defaultAutocompleteProvider)
      autocompleteProvider = {
        getSuggestions: typeof provided?.getSuggestions === 'function'
          ? provided.getSuggestions.bind(provided)
          : defaultAutocompleteProvider.getSuggestions,
        applyCompletion: typeof provided?.applyCompletion === 'function'
          ? provided.applyCompletion.bind(provided)
          : defaultAutocompleteProvider.applyCompletion,
      }
    },
    setEditorComponent: (factory?: any) => {
      editorFactory = factory
      replaceKeyedSurface('editor', 'editor')
      if (factory) {
        void createSurface('editor', false, async surface => {
          const component = await factory(surface as any, currentEditorTheme, keybindings)
          component.setText?.(composer?.text || '')
          component.onChange = (text: string) => {
            const runtimeKey = requireKey()
            const revision = (composer?.revision || 0) + 1
            composer = {
              conversationId: runtimeKey.conversationId,
              branchId: runtimeKey.branchId,
              text,
              selectionStart: text.length,
              selectionEnd: text.length,
              revision,
              clientId: composer?.clientId || 'extension-editor',
            }
            emit({ type: 'agent_ui_editor_set_text', text, revision, conversationId: runtimeKey.conversationId, branchId: runtimeKey.branchId })
          }
          component.onSubmit = (text: string) => {
            const runtimeKey = requireKey()
            emit({ type: 'agent_ui_editor_submit', text, conversationId: runtimeKey.conversationId, branchId: runtimeKey.branchId })
          }
          component.setAutocompleteProvider?.(autocompleteProvider)
          return component
        }, undefined, 'editor')
          .catch(err => console.warn('[PiRuntimeWorker] editor component failed:', (err as Error).message))
      }
    },
    getEditorComponent: () => editorFactory,
    get theme() { return currentTheme },
    getAllThemes: () => {
      const themes = session?.resourceLoader?.getThemes?.().themes || []
      return themes.length
        ? themes.map((item: any) => ({ name: item.name, path: item.path }))
        : [{ name: currentTheme?.name || 'dark', path: undefined }]
    },
    getTheme: (name: string) => {
      const found = (session?.resourceLoader?.getThemes?.().themes || []).find((item: any) => item.name === name)
      if (found) return found
      return name === (currentTheme?.name || 'dark') || name === 'dark' ? currentTheme : undefined
    },
    setTheme: (value: string | any) => {
      if (typeof value === 'string') {
        const found = (session?.resourceLoader?.getThemes?.().themes || []).find((item: any) => item.name === value)
          || ((value === currentTheme?.name || value === 'dark') ? currentTheme : undefined)
        if (!found) return { success: false, error: `Theme not found: ${value}` }
        currentTheme = found
      } else {
        currentTheme = value
      }
      if (currentTheme !== loadedThemeModule?.theme) loadedThemeModule?.setThemeInstance?.(currentTheme)
      currentEditorTheme = loadedThemeModule?.getEditorTheme?.() || currentEditorTheme
      for (const record of surfaces.values()) record.surface.invalidate()
      return { success: true }
    },
    getToolsExpanded: () => toolsExpanded,
    setToolsExpanded: (expanded: boolean) => {
      toolsExpanded = expanded
      const runtimeKey = requireKey()
      emit({ type: 'agent_ui_tools_expanded', expanded, conversationId: runtimeKey.conversationId, branchId: runtimeKey.branchId })
    },
  }
}

const restoreAcmContext = async () => {
  const command = session?.extensionRunner?.getCommand?.('acm')
  if (!command?.handler) return

  const commandContext = session.extensionRunner.createCommandContext()
  const commandUi = commandContext.ui
  let suppressNotification = true
  const quietUi = new Proxy(commandUi, {
    get(target, property, receiver) {
      if (property === 'notify' && suppressNotification) return () => {}
      return Reflect.get(target, property, receiver)
    },
  })
  const context = new Proxy(commandContext, {
    get(target, property, receiver) {
      if (property === 'ui' && suppressNotification) return quietUi
      return Reflect.get(target, property, receiver)
    },
  })

  try {
    // Re-run only the idempotent ACM enable command after the host has rebuilt
    // the extension runner. The quiet UI avoids a duplicate notification while
    // keeping the newly-created CommandCtx bound to the current session.
    await command.handler('', context)
  } finally {
    suppressNotification = false
  }
}

const bindSession = async () => {
  session = runtime.session
  await session.bindExtensions({
    uiContext: createUiContext(),
    mode: 'rpc',
    commandContextActions: {
      waitForIdle: () => waitForCommandIdle(),
      newSession: async (options: any) => {
        const allocation = await requestHost<any>({ type: 'control_request', operation: 'allocate_new_conversation', payload: {} })
        const previousKey = key!
        const previousSessionFile = session.sessionFile
        const nextKey = { conversationId: allocation.conversationId, branchId: allocation.branchId || 'main' }
        // Runtime replacement binds extensions before newSession() resolves.
        // Set the destination key first so session_start/withSession handlers
        // receive a context attached to the new YARC Conversation.
        key = nextKey
        let result: { cancelled: boolean }
        try {
          result = await runtime.newSession(options)
        } catch (err) {
          key = previousKey
          await requestHost({ type: 'control_request', operation: 'discard_new_conversation', payload: { conversationId: nextKey.conversationId } }).catch(() => {})
          throw err
        }
        if (result.cancelled) {
          key = previousKey
          await requestHost({ type: 'control_request', operation: 'discard_new_conversation', payload: { conversationId: nextKey.conversationId } })
          return result
        }
        try {
          await requestHost({ type: 'control_request', operation: 'finalize_new_session', payload: { allocation, previousKey, key: nextKey, metadata: metadata() } })
        } catch (err) {
          key = previousKey
          if (previousSessionFile) await runtime.switchSession(previousSessionFile).catch(() => {})
          await requestHost({ type: 'control_request', operation: 'discard_new_conversation', payload: { conversationId: nextKey.conversationId } }).catch(() => {})
          throw err
        }
        emit({ type: 'runtime_branch_changed', conversationId: nextKey.conversationId, previousConversationId: previousKey.conversationId, previousBranchId: previousKey.branchId, branchId: nextKey.branchId, sessionFile: session.sessionFile, leafEntryId: session.sessionManager?.getLeafId?.() || null })
        emitMetadata()
        return result
      },
      fork: async (entryId: string, options: any) => {
        const allocation = await requestHost<any>({ type: 'control_request', operation: 'allocate_branch', payload: { entryId, position: options?.position || 'before' } })
        const previousKey = key!
        const previousSessionFile = session.sessionFile
        const nextKey = { conversationId: previousKey.conversationId, branchId: allocation.branchId }
        key = nextKey
        let result: { cancelled: boolean; selectedText?: string }
        try {
          result = await runtime.fork(entryId, options)
        } catch (err) {
          key = previousKey
          throw err
        }
        if (result.cancelled) {
          key = previousKey
          return { cancelled: true }
        }
        try {
          await requestHost({ type: 'control_request', operation: 'finalize_branch', payload: { allocation, previousKey, key: nextKey, metadata: metadata() } })
        } catch (err) {
          key = previousKey
          if (previousSessionFile) await runtime.switchSession(previousSessionFile).catch(() => {})
          throw err
        }
        emit({ type: 'runtime_branch_changed', conversationId: nextKey.conversationId, previousBranchId: previousKey.branchId, branchId: nextKey.branchId, sessionFile: session.sessionFile, leafEntryId: session.sessionManager?.getLeafId?.() || null })
        emitMetadata()
        return { cancelled: false }
      },
      navigateTree: async (targetId: string, options: any) => {
        const previousLeafId = session.sessionManager?.getLeafId?.() || null
        const result = await session.navigateTree(targetId, options)
        if (!result.cancelled) {
          try {
            await requestHost({ type: 'control_request', operation: 'navigate_tree', payload: { targetId, options, metadata: metadata(), summaryEntry: result.summaryEntry } })
          } catch (err) {
            if (previousLeafId) await session.navigateTree(previousLeafId, { summarize: false }).catch(() => {})
            throw err
          }
          emitMetadata()
        }
        return { cancelled: result.cancelled }
      },
      switchSession: async (sessionPath: string, options: any) => {
        const target = await requestHost<any>({ type: 'control_request', operation: 'validate_session', payload: { sessionPath } })
        if (!target?.conversationId || !target?.branchId) return { cancelled: true }
        const previousKey = key!
        const previousSessionFile = session.sessionFile
        const nextKey = { conversationId: target.conversationId, branchId: target.branchId }
        key = nextKey
        let result: { cancelled: boolean }
        try {
          result = await runtime.switchSession(sessionPath, options)
        } catch (err) {
          key = previousKey
          throw err
        }
        if (result.cancelled) {
          key = previousKey
          return result
        }
        try {
          await requestHost({ type: 'control_request', operation: 'session_switched', payload: { previousKey, key: nextKey, metadata: metadata() } })
        } catch (err) {
          key = previousKey
          if (previousSessionFile) await runtime.switchSession(previousSessionFile).catch(() => {})
          throw err
        }
        emit({ type: 'runtime_branch_changed', conversationId: nextKey.conversationId, previousConversationId: previousKey.conversationId, previousBranchId: previousKey.branchId, branchId: nextKey.branchId, sessionFile: session.sessionFile, leafEntryId: session.sessionManager?.getLeafId?.() || null })
        emitMetadata()
        return result
      },
      reload: async () => {
        resetWorkingUi()
        closeAllSurfaces('reload')
        await session.reload()
        if (acmEnabled) await restoreAcmContext()
      },
    },
    shutdownHandler: () => {},
    onError: (err: any) => emit({ type: 'error', message: `Extension error: ${err?.error || err?.message || 'unknown error'}`, conversationId: key?.conversationId, branchId: key?.branchId }),
  })

  unsubscribe?.()
  unsubscribe = session.subscribe(handleSessionEvent)
  if (acmEnabled) await restoreAcmContext()
}

const assistantFields = () => ({
  ...(key ? { conversationId: key.conversationId, branchId: key.branchId } : {}),
  ...(currentAssistantId ? { assistantMessageId: currentAssistantId } : {}),
  ...(activeRunGroupId ? { runGroupId: activeRunGroupId } : {}),
})

const isAbortRelatedError = (message: unknown) =>
  typeof message === 'string' && /\b(abort(?:ed)?|cancel(?:led)?|interrupted)\b/i.test(message)

const createRunIdleBarrier = (runId: string) => {
  let resolveBarrier!: () => void
  const promise = new Promise<void>(resolve => { resolveBarrier = resolve })
  runIdleBarrier = { runId, promise, resolve: resolveBarrier, signalled: false }
}

const signalRunIdleBoundary = (runId: string) => {
  if (!runIdleBarrier || runIdleBarrier.runId !== runId || runIdleBarrier.signalled) return
  runIdleBarrier.signalled = true
  runIdleBarrier.resolve()
}

const beginAutoExtensionRun = () => {
  if (activeRunId || !key) return
  const runId = `extension-run-${randomUUID()}`
  const assistantMessageId = `extension-assistant-${randomUUID()}`
  activeRunId = runId
  activeRootAssistantId = assistantMessageId
  activeRunGroupId = runId
  currentAssistantId = undefined
  assistantCount = 0
  activeToolCount = 0
  autoExtensionRun = true
  autoExtensionCompletionScheduled = false
  createRunIdleBarrier(runId)
  post({ type: 'extension_run_start', runId, key: { ...key }, assistantMessageId })
  post({ type: 'state', key, generation, state: 'running' })
}

const handleSessionEvent = (event: any) => {
  activityEpoch += 1
  if (event.type === 'message_start' && event.message?.role === 'user' && !activeRunId) {
    beginAutoExtensionRun()
  }
  if (event.type === 'message_start' && event.message?.role === 'assistant') {
    beginAutoExtensionRun()
    if (assistantCount > 0) deferredAssistantAborts.supersedeWithContinuation()
    assistantCount += 1
    currentAssistantId = assistantCount === 1 && activeRootAssistantId
      ? activeRootAssistantId
      : `extension-assistant-${randomUUID()}`
    if (key && currentAssistantId && activeRunGroupId) {
      emit({
        type: 'assistant_message_start',
        messageId: currentAssistantId,
        runGroupId: activeRunGroupId,
        source: assistantCount === 1 ? (autoExtensionRun ? 'extension' : 'user') : 'continuation',
        conversationId: key.conversationId,
        branchId: key.branchId,
      })
    }
    return
  }

  if (event.type === 'message_update') {
    const update = event.assistantMessageEvent
    if (update?.type === 'text_delta' && update.delta) emit({ type: 'text', content: String(update.delta), ...assistantFields() })
    else if (update?.type === 'thinking_delta' && update.delta) emit({ type: 'thinking', content: String(update.delta), ...assistantFields() })
    else if (update?.type === 'toolcall_delta' && update.delta) {
      const block = update.partial?.content?.[update.contentIndex]
      const toolCallId = String(block?.type === 'toolCall' ? block.id : '') || `${currentAssistantId || 'tool'}:${update.contentIndex}`
      emit({
        type: 'tool_call_delta',
        toolCallId,
        ...(block?.type === 'toolCall' && block.name ? { toolName: String(block.name) } : {}),
        inputDelta: String(update.delta),
        ...assistantFields(),
      })
    } else if (update?.type === 'error') {
      const message = update.error?.errorMessage || 'Pi error'
      if (isAbortRelatedError(message)) {
        deferredAssistantAborts.defer({ assistantMessageId: currentAssistantId, message })
      } else {
        emit({ type: 'error', message, ...assistantFields() })
      }
    }
    return
  }

  if (event.type === 'tool_execution_start') {
    activeToolCount += 1
    emit({ type: 'tool_call', toolCallId: String(event.toolCallId || ''), toolName: String(event.toolName || 'tool'), input: JSON.stringify(event.args || {}), ...assistantFields() })
    return
  }
  if (event.type === 'tool_execution_update') return
  if (event.type === 'tool_execution_end') {
    activeToolCount = Math.max(0, activeToolCount - 1)
    const result = event.result
    const text = Array.isArray(result?.content)
      ? result.content.map((item: any) => item?.type === 'text' ? item.text : '').filter(Boolean).join('\n')
      : typeof result === 'string' ? result : JSON.stringify(result ?? {})
    emit({ type: 'tool_result', toolCallId: String(event.toolCallId || ''), result: text.slice(0, 4000), ...assistantFields() })
    if (event.toolName === 'yarc_search_papers' && !event.isError && result?.details?.action === 'search') {
      const details = result.details
      emit({
        type: 'search_results',
        ...(key ? { conversationId: key.conversationId, branchId: key.branchId } : {}),
        toolCallId: event.toolCallId,
        query: String(details.query || ''),
        source: details.source || 'semantic_scholar',
        field: details.field || 'all',
        page: Number(details.page || 1),
        limit: Number(details.limit || details.papers?.length || 20),
        total: Number(details.total || details.papers?.length || 0),
        totalPages: Number(details.totalPages || 0),
        hasNextPage: Boolean(details.hasNextPage),
        nextPage: details.nextPage ?? null,
        papers: details.papers || [],
        earlyAccess: Boolean(details.earlyAccess),
        publication: details.publication,
      })
    }
    return
  }

  if (event.type === 'message_end') {
    const message = event.message
    const mappedAssistantId = currentAssistantId
    pendingCommits += 1
    queueMicrotask(() => {
      try {
        const entryId = session?.sessionManager?.getLeafId?.()
        const sessionFile = session?.sessionFile
        const verified = !entryId || !sessionFile || durability.verifyEntry(sessionFile, entryId)
        if (!verified) {
          console.warn(`[PiRuntimeWorker] Session entry ${entryId} was not visible in the JSONL tail at message commit`)
        }
        if (sessionFile) durability.commit(sessionFile)
        if (verified && entryId && sessionFile && key) {
          if (message?.role === 'user' && activeUserMessageId) {
            emit({ type: 'pi_user_entry', conversationId: key.conversationId, messageId: activeUserMessageId, entryId, sessionFile })
          }
          if (message?.role === 'assistant' && mappedAssistantId) {
            emit({ type: 'pi_assistant_entry', conversationId: key.conversationId, messageId: mappedAssistantId, entryId, sessionFile })
          }
        }
      } finally {
        pendingCommits = Math.max(0, pendingCommits - 1)
        emitMetadata()
      }
    })
    if (message?.role === 'assistant' && message.stopReason === 'aborted') {
      deferredAssistantAborts.defer({
        assistantMessageId: mappedAssistantId,
        message: message.errorMessage || 'Request aborted',
      })
    } else if (message?.role === 'assistant' && (message.stopReason === 'error' || message.errorMessage)) {
      emit({ type: 'error', message: message.errorMessage || 'Pi error', ...assistantFields() })
    }
    return
  }

  if (event.type === 'agent_end' && autoExtensionRun && activeRunId && !autoExtensionCompletionScheduled) {
    const runId = activeRunId
    autoExtensionCompletionScheduled = true
    const timer = setTimeout(() => {
      void (async () => {
        try {
          if (!autoExtensionRun || activeRunId !== runId) return
          await waitForQuiescence()
          signalRunIdleBoundary(runId)
          await new Promise<void>(resolve => setTimeout(resolve, 50))
          await waitForQuiescence()
          flushDeferredAssistantAborts()
          const state = metadata()
          durability.commit(state.sessionFile)
          resetWorkingUi()
          post({ type: 'run_complete', runId, metadata: state })
        } catch (err) {
          resetWorkingUi()
          post({ type: 'run_error', runId, error: (err as Error).message || 'Extension run failed', metadata: metadata() })
        } finally {
          if (activeRunId === runId) finishRun()
        }
      })()
    }, 0)
    if (typeof timer.unref === 'function') timer.unref()
    return
  }

  if (event.type === 'session_compact') {
    const entry = event.compactionEntry
    emit({ type: 'compaction_complete', summary: entry?.summary || '', tokensBefore: entry?.tokensBefore || 0, estimatedTokensAfter: entry?.estimatedTokensAfter, conversationId: key?.conversationId, branchId: key?.branchId })
    return
  }
  if (event.type === 'session_tree' && event.summaryEntry) {
    const summary = event.summaryEntry
    emit({ type: 'branch_summary', summary: summary.summary || '', entryId: summary.id, targetId: event.newLeafId, sourceLeafId: event.oldLeafId, label: summary.label, conversationId: key?.conversationId, branchId: key?.branchId })
  }
}

const waitForQuiescence = async () => {
  let stable = 0
  let previousEpoch = activityEpoch
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    const idle = !!session?.isIdle && !session?.isStreaming && !session?.isCompacting
      && (session?.pendingMessageCount || 0) === 0
      && activeToolCount === 0
      && pendingCommits === 0
      && pending.size === 0
    if (idle && previousEpoch === activityEpoch) stable += 1
    else stable = 0
    if (stable >= 2) return
    previousEpoch = activityEpoch
  }
  throw new Error('Runtime did not reach a stable idle state')
}

const waitForCommandIdle = async () => {
  const runId = activeRunId
  const barrier = runIdleBarrier
  await session?.waitForIdle?.()
  if (runId && barrier?.runId === runId) await barrier.promise
  else await waitForQuiescence()
}

const configureSession = async (payload: { model?: string; thinkingLevel?: string; thinkingEnabled?: boolean }) => {
  if (payload.model) requestedModelId = payload.model
  if (payload.thinkingLevel) requestedThinkingLevel = payload.thinkingLevel
  if (payload.model && session?.model?.id !== payload.model) {
    const model = await resolveModel(runtime.services.modelRuntime, payload.model)
    if (!model) throw new Error(`Model not found: ${payload.model}`)
    await session.setModel(model)
  }
  session.setThinkingLevel(thinkingLevel(payload.thinkingLevel || requestedThinkingLevel, payload.thinkingEnabled))
}

const beginRun = (runId: string, assistantMessageId: string, userMessageId?: string) => {
  if (activeRunId) throw new Error('Runtime already has an active run')
  deferredAssistantAborts.clear()
  activeRunId = runId
  activeRootAssistantId = assistantMessageId
  activeUserMessageId = userMessageId
  activeRunGroupId = runId
  currentAssistantId = undefined
  assistantCount = 0
  activeToolCount = 0
  createRunIdleBarrier(runId)
  post({ type: 'state', key: key!, generation, state: 'running' })
}

const finishRun = () => {
  if (activeRunId) signalRunIdleBoundary(activeRunId)
  runIdleBarrier = null
  activeRunId = undefined
  activeRootAssistantId = undefined
  activeUserMessageId = undefined
  activeRunGroupId = undefined
  currentAssistantId = undefined
  assistantCount = 0
  activeToolCount = 0
  autoExtensionRun = false
  autoExtensionCompletionScheduled = false
  deferredAssistantAborts.clear()
  post({ type: 'state', key: key!, generation, state: 'idle' })
}

const flushDeferredAssistantAborts = () => {
  for (const abort of deferredAssistantAborts.drain()) {
    emit({
      type: 'error',
      message: abort.message,
      ...(abort.assistantMessageId ? { assistantMessageId: abort.assistantMessageId } : {}),
      ...(activeRunGroupId ? { runGroupId: activeRunGroupId } : {}),
    })
  }
}

const runPrompt = async (payload: Extract<RuntimeHostMessage, { type: 'prompt' }>['payload']) => {
  beginRun(payload.runId, payload.assistantMessageId, payload.userMessageId)
  if (/^\/acm(?:\s|$)/.test(payload.prompt.trim())) acmEnabled = true
  const initialLeafId = session?.sessionManager?.getLeafId?.() || null
  try {
    await configureSession(payload)
    emit({
      type: 'session_state',
      model: session.model?.id || '',
      thinkingLevel: session.thinkingLevel || 'off',
      models: [],
      ...(key ? { conversationId: key.conversationId, branchId: key.branchId } : {}),
    })
    await session.prompt(payload.prompt)
    await waitForQuiescence()
    signalRunIdleBoundary(payload.runId)
    await new Promise<void>(resolve => setTimeout(resolve, 50))
    await waitForQuiescence()
    flushDeferredAssistantAborts()
    const usage = session.getContextUsage?.()
    if (usage) emit({ type: 'context_usage', tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.percent, model: session.model?.id, conversationId: key?.conversationId, branchId: key?.branchId })
    const state = metadata()
    durability.commit(state.sessionFile)
    resetWorkingUi()
    post({ type: 'run_complete', runId: payload.runId, metadata: state })
  } catch (err) {
    signalRunIdleBoundary(payload.runId)
    await new Promise<void>(resolve => setTimeout(resolve, 50))
    await waitForQuiescence().catch(() => {})
    flushDeferredAssistantAborts()
    const message = (err as Error).message || 'Pi runtime failed'
    try {
      persistFailedPromptIfMissing(session.sessionManager, initialLeafId, payload.prompt, message, session.model)
      durability.commit(session.sessionFile)
      emitMetadata()
    } catch (persistError) {
      console.warn('[PiRuntimeWorker] Failed to persist errored prompt:', (persistError as Error).message)
    }
    emit({ type: 'error', message, conversationId: key?.conversationId, branchId: key?.branchId })
    resetWorkingUi()
    post({ type: 'run_error', runId: payload.runId, error: message, metadata: metadata() })
  } finally {
    finishRun()
  }
}

const runCompact = async (payload: Extract<RuntimeHostMessage, { type: 'compact' }>['payload']) => {
  beginRun(payload.runId, payload.assistantMessageId)
  try {
    await configureSession(payload)
    emit({ type: 'compaction_start', conversationId: key?.conversationId, branchId: key?.branchId })
    const result = await session.compact(payload.customInstructions)
    await waitForQuiescence()
    signalRunIdleBoundary(payload.runId)
    await new Promise<void>(resolve => setTimeout(resolve, 50))
    await waitForQuiescence()
    emit({ type: 'compaction_complete', summary: result.summary, tokensBefore: result.tokensBefore, estimatedTokensAfter: result.estimatedTokensAfter, conversationId: key?.conversationId, branchId: key?.branchId })
    const usage = session.getContextUsage?.()
    if (usage) emit({ type: 'context_usage', tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.percent, model: session.model?.id, conversationId: key?.conversationId, branchId: key?.branchId })
    const state = metadata()
    durability.commit(state.sessionFile)
    resetWorkingUi()
    post({ type: 'run_complete', runId: payload.runId, metadata: state })
  } catch (err) {
    signalRunIdleBoundary(payload.runId)
    const message = (err as Error).message || 'Compaction failed'
    emit({ type: 'error', message, conversationId: key?.conversationId, branchId: key?.branchId })
    resetWorkingUi()
    post({ type: 'run_error', runId: payload.runId, error: message, metadata: metadata() })
  } finally {
    finishRun()
  }
}

const initialize = async (payload: RuntimeInitPayload) => {
  init = payload
  key = payload.key
  generation = payload.generation
  composer = payload.composer
  acmEnabled = payload.restoreAcm === true
  requestedModelId = payload.model
  requestedThinkingLevel = payload.thinkingLevel
  TuiClass = await loadTuiClass()
  currentTheme = await loadDefaultTheme()
  currentEditorTheme = loadedThemeModule?.getEditorTheme?.()
  const keybindingsModule = await import(new URL('../../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js', import.meta.url).href)
  keybindings = keybindingsModule.KeybindingsManager.create(payload.agentDir)
  const globalAgentsPath = payload.globalAgentsFile ? resolve(payload.globalAgentsFile) : null
  const globalAgentsContent = globalAgentsPath
    ? await readFile(globalAgentsPath, 'utf-8').catch(() => null)
    : null

  const createRuntime = async ({ cwd, agentDir, sessionManager, sessionStartEvent }: any) => {
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      resourceLoaderOptions: {
        agentsFilesOverride: (base: { agentsFiles: Array<{ path: string; content: string }> }) => {
          const legacyAgentsMd = resolve(dirname(agentDir), 'AGENTS.md')
          const seen = new Set<string>()
          const discovered = base.agentsFiles.filter(file => {
            const absolute = resolve(file.path)
            if (absolute === legacyAgentsMd || (globalAgentsPath && absolute === globalAgentsPath) || seen.has(absolute)) return false
            seen.add(absolute)
            return true
          })
          return {
            agentsFiles: [
              ...(globalAgentsPath && globalAgentsContent !== null
                ? [{ path: globalAgentsPath, content: globalAgentsContent }]
                : []),
              ...discovered,
            ],
          }
        },
        systemPromptOverride: (base: string | undefined) => payload.systemPrompt ?? base?.trim() ?? DEFAULT_CHAT_SYSTEM_PROMPT,
      },
    })

    services.settingsManager.setDefaultProvider = () => {}
    services.settingsManager.setDefaultModel = () => {}
    services.settingsManager.setDefaultModelAndProvider = () => {}
    services.settingsManager.setDefaultThinkingLevel = () => {}

    const model = await resolveModel(services.modelRuntime, requestedModelId)
    const created = await createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
      ...(model ? { model } : {}),
      thinkingLevel: thinkingLevel(requestedThinkingLevel),
      customTools: createProxyTools(payload.tools),
    })
    return { ...created, services, diagnostics: services.diagnostics }
  }

  const sessionManager = payload.sessionFile
    ? SessionManager.open(payload.sessionFile, payload.sessionDir, payload.cwd)
    : SessionManager.create(payload.cwd, payload.sessionDir)
  runtime = await createAgentSessionRuntime(createRuntime, {
    cwd: payload.cwd,
    agentDir: payload.agentDir,
    sessionManager,
  })
  currentTheme = runtime.services.resourceLoader.getThemes?.().themes?.[0] || currentTheme
  if (currentTheme !== loadedThemeModule?.theme) loadedThemeModule?.setThemeInstance?.(currentTheme)
  currentEditorTheme = loadedThemeModule?.getEditorTheme?.() || currentEditorTheme
  runtime.setBeforeSessionInvalidate(() => closeAllSurfaces('reload'))
  runtime.setRebindSession(bindSession)
  await bindSession()

  post({
    type: 'ready',
    key,
    generation,
    metadata: metadata(),
    commands: collectCommands(),
    diagnostics: runtime.diagnostics || [],
  })
}

parentPort.on('message', (message: RuntimeHostMessage) => {
  void (async () => {
    if (message.type === 'init') {
      try {
        await initialize(message.payload)
      } catch (err) {
        const error = (err as Error).message || 'Runtime initialization failed'
        post({ type: 'state', key: message.payload.key, generation: message.payload.generation, state: 'failed', error })
      }
      return
    }
    if (!runtime || !session || !key) return

    if (message.type === 'prompt') return runPrompt(message.payload)
    if (message.type === 'compact') return runCompact(message.payload)
    if (message.type === 'abort') {
      if (activeRunId === message.runId) {
        closeAllSurfaces('cancelled')
        await session.abort()
      }
      return
    }
    if (message.type === 'reload') {
      generation = message.generation
      post({ type: 'state', key, generation, state: 'reloading' })
      resetWorkingUi()
      closeAllSurfaces('reload')
      await session.reload()
      if (acmEnabled) await restoreAcmContext()
      post({ type: 'ready', key, generation, metadata: metadata(), commands: collectCommands(), diagnostics: [] })
      return
    }
    if (message.type === 'dispose') {
      resetWorkingUi()
      closeAllSurfaces('disposed')
      if (activeRunId && !session.isIdle) await session.abort().catch(() => {})
      await waitForQuiescence().catch(() => {})
      emitMetadata()
      durability.commit(session.sessionFile)
      unsubscribe?.()
      unsubscribe = null
      await runtime.dispose()
      post({ type: 'disposed', key, reason: message.reason })
      port.close()
      return
    }
    if (message.type === 'tool_result' || message.type === 'control_result' || message.type === 'ui_response') {
      const item = pending.get(message.requestId)
      if (!item) return
      pending.delete(message.requestId)
      if (message.ok) item.resolve(message.type === 'ui_response' ? message.value : message.result)
      else item.reject(new Error(message.error || 'Host request failed'))
      return
    }
    if (message.type === 'tool_update') {
      pending.get(message.requestId)?.onUpdate?.(message.update)
      return
    }
    if (message.type === 'composer_update') {
      if (!composer || message.mirror.revision >= composer.revision) {
        composer = message.mirror
        for (const record of surfaces.values()) {
          if (record.kind === 'editor') record.surface.setText(message.mirror.text)
        }
      }
      return
    }
    if (message.type === 'autocomplete_request') {
      try {
        const provider = autocompleteProvider || defaultAutocompleteProvider
        const result = await provider.getSuggestions(
          message.lines,
          message.cursorLine,
          message.cursorCol,
          { signal: new AbortController().signal, force: message.force },
        )
        post({ type: 'autocomplete_result', requestId: message.requestId, ok: true, result })
      } catch (err) {
        post({ type: 'autocomplete_result', requestId: message.requestId, ok: false, error: (err as Error).message })
      }
      return
    }
    if (message.type === 'autocomplete_apply') {
      try {
        const provider = autocompleteProvider || defaultAutocompleteProvider
        const result = await provider.applyCompletion(
          message.lines,
          message.cursorLine,
          message.cursorCol,
          message.item,
          message.prefix,
        )
        post({ type: 'autocomplete_result', requestId: message.requestId, ok: true, result })
      } catch (err) {
        post({ type: 'autocomplete_result', requestId: message.requestId, ok: false, error: (err as Error).message })
      }
      return
    }
    if (message.type === 'tui_input') {
      const record = surfaces.get(message.surfaceId)
      if (!record) return
      let data = message.data
      for (const handler of [...terminalInputHandlers]) {
        const result = handler(data)
        if (result?.data !== undefined) data = result.data
        if (result?.consume) return
      }
      record.surface.handleInput(data)
      return
    }
    if (message.type === 'tui_resize') {
      surfaces.get(message.surfaceId)?.surface.resize(message.cols, message.rows)
      return
    }
    if (message.type === 'tui_close') {
      const record = surfaces.get(message.surfaceId)
      record?.close('cancelled')
    }
  })().catch(err => {
    const error = (err as Error).message || 'Runtime worker command failed'
    if (activeRunId) post({ type: 'run_error', runId: activeRunId, error, metadata: metadata() })
    else post({ type: 'state', key: key!, generation, state: 'failed', error })
  })
})
