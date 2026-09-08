import type { ChatEvent, PiComposerMirror, PiExtensionCommandInfo, PiRuntimeKey } from '@yarc/shared'

export interface RuntimeToolManifest {
  name: string
  label: string
  description: string
  promptSnippet?: string
  promptGuidelines?: string[]
  parameters: Record<string, unknown>
  constrainedSampling?: unknown
  executionMode?: 'sequential' | 'parallel'
}

export interface RuntimeInitPayload {
  key: PiRuntimeKey
  generation: number
  cwd: string
  agentDir: string
  sessionDir: string
  sessionFile?: string | null
  model?: string
  thinkingLevel?: string
  systemPrompt?: string
  restoreAcm?: boolean
  tools: RuntimeToolManifest[]
  composer?: PiComposerMirror
}

export interface RuntimePromptPayload {
  runId: string
  prompt: string
  userMessageId?: string
  assistantMessageId: string
  model?: string
  thinkingLevel?: string
  thinkingEnabled?: boolean
}

export interface RuntimeCompactPayload {
  runId: string
  assistantMessageId: string
  customInstructions?: string
  model?: string
  thinkingLevel?: string
  thinkingEnabled?: boolean
}

export type RuntimeHostMessage =
  | { type: 'init'; payload: RuntimeInitPayload }
  | { type: 'prompt'; payload: RuntimePromptPayload }
  | { type: 'compact'; payload: RuntimeCompactPayload }
  | { type: 'abort'; runId: string }
  | { type: 'reload'; generation: number; reason: string }
  | { type: 'dispose'; reason: string }
  | { type: 'tool_result'; requestId: string; ok: boolean; result?: unknown; error?: string }
  | { type: 'tool_update'; requestId: string; update: unknown }
  | { type: 'control_result'; requestId: string; ok: boolean; result?: unknown; error?: string }
  | { type: 'ui_response'; requestId: string; ok: boolean; value?: unknown; error?: string }
  | { type: 'tui_input'; surfaceId: string; data: string; revision?: number; clientId?: string }
  | { type: 'tui_resize'; surfaceId: string; cols: number; rows: number; revision?: number; clientId?: string }
  | { type: 'tui_close'; surfaceId: string; reason?: string; clientId?: string }
  | { type: 'composer_update'; mirror: PiComposerMirror }
  | { type: 'autocomplete_request'; requestId: string; lines: string[]; cursorLine: number; cursorCol: number; force?: boolean }
  | { type: 'autocomplete_apply'; requestId: string; lines: string[]; cursorLine: number; cursorCol: number; item: { value: string; label: string; description?: string }; prefix: string }

export interface RuntimeMetadata {
  conversationId: string
  branchId: string
  sessionFile?: string
  sessionId?: string
  leafEntryId?: string | null
  model?: string
  thinkingLevel?: string
  contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null; model?: string }
  updatedAt: string
}

export type RuntimeWorkerMessage =
  | { type: 'ready'; key: PiRuntimeKey; generation: number; metadata: RuntimeMetadata; commands: PiExtensionCommandInfo[]; diagnostics: Array<{ type: string; message: string }> }
  | { type: 'state'; key: PiRuntimeKey; generation: number; state: 'idle' | 'running' | 'reloading' | 'failed'; error?: string }
  | { type: 'event'; runId?: string; event: ChatEvent }
  | { type: 'extension_run_start'; runId: string; key: PiRuntimeKey; assistantMessageId: string }
  | { type: 'run_complete'; runId: string; metadata: RuntimeMetadata }
  | { type: 'run_error'; runId: string; error: string; metadata?: RuntimeMetadata }
  | { type: 'metadata'; metadata: RuntimeMetadata }
  | { type: 'tool_request'; requestId: string; runId?: string; toolCallId: string; toolName: string; params: unknown }
  | { type: 'tool_abort'; requestId: string }
  | { type: 'control_request'; requestId: string; operation: string; payload?: unknown }
  | { type: 'ui_request'; requestId: string; runId?: string; kind: 'select' | 'confirm' | 'input' | 'editor'; payload: Record<string, unknown>; timeoutMs?: number }
  | { type: 'ui_cancel'; requestId: string; reason?: string }
  | { type: 'autocomplete_result'; requestId: string; ok: boolean; result?: unknown; error?: string }
  | { type: 'disposed'; key: PiRuntimeKey; reason: string }

export interface RuntimeToolExecutionContext {
  getKey: () => PiRuntimeKey
  getRunId: () => string | undefined
  emit: (event: ChatEvent) => void
  cwd?: string
  workspaceKind?: 'global' | 'project'
  projectId?: string
}

export interface RuntimeToolHost {
  manifests: RuntimeToolManifest[]
  execute: (
    toolName: string,
    toolCallId: string,
    params: unknown,
    signal: AbortSignal,
    onUpdate: (update: unknown) => void,
  ) => Promise<unknown>
}
