import { randomUUID } from 'node:crypto'
import type {
  AgentInteractionKind,
  AgentInteractionRequest,
  AgentInteractionResolved,
  AgentInteractionResponse,
} from '@yarc/shared'

export interface PendingInteraction {
  requestId: string
  conversationId: string
  branchId: string
  streamMessageId: string
  kind: AgentInteractionKind
  resolve: (value: AgentInteractionResponse) => void
  reject: (err: Error) => void
  createdAt: number
  timeout?: ReturnType<typeof setTimeout>
  emitResolved?: (event: AgentInteractionResolved) => void
}

export interface CreateInteractionInput {
  conversationId: string
  branchId: string
  streamMessageId: string
  kind: AgentInteractionKind
  title?: string
  message?: string
  payload: unknown
  timeoutMs?: number
  emitRequest: (event: AgentInteractionRequest) => void
  emitResolved?: (event: AgentInteractionResolved) => void
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000

class AgentInteractionRegistry {
  private pending = new Map<string, PendingInteraction>()
  // E5: Short-lived cache of recently resolved interactions for multi-window friendly messages
  private resolvedCache = new Map<string, { action: string; resolvedAt: number }>()
  private readonly RESOLVED_TTL_MS = 60_000

  create(input: CreateInteractionInput): Promise<AgentInteractionResponse> {
    const requestId = randomUUID()
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const request: AgentInteractionRequest = {
      type: 'agent_interaction_request',
      requestId,
      conversationId: input.conversationId,
      branchId: input.branchId,
      streamMessageId: input.streamMessageId,
      kind: input.kind,
      title: input.title,
      message: input.message,
      payload: input.payload,
      createdAt: new Date().toISOString(),
      timeoutMs,
    }

    return new Promise<AgentInteractionResponse>((resolve, reject) => {
      const pending: PendingInteraction = {
        requestId,
        conversationId: input.conversationId,
        branchId: input.branchId,
        streamMessageId: input.streamMessageId,
        kind: input.kind,
        resolve,
        reject,
        createdAt: Date.now(),
        emitResolved: input.emitResolved,
      }

      if (timeoutMs > 0) {
        pending.timeout = setTimeout(() => {
          this.resolvePending(requestId, {
            requestId,
            action: 'cancel',
            value: { reason: 'timeout' },
          })
        }, timeoutMs)
        if (typeof pending.timeout.unref === 'function') pending.timeout.unref()
      }

      this.pending.set(requestId, pending)

      try {
        input.emitRequest(request)
      } catch (err) {
        this.pending.delete(requestId)
        if (pending.timeout) clearTimeout(pending.timeout)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  respond(requestId: string, response: AgentInteractionResponse): boolean | { resolved: true; action: string } {
    // E5: Check if already resolved
    const cached = this.resolvedCache.get(requestId)
    if (cached) return { resolved: true, action: cached.action }

    const pending = this.pending.get(requestId)
    if (!pending) return false
    if (response.requestId && response.requestId !== requestId) return false
    return this.resolvePending(requestId, { ...response, requestId })
  }

  cancelByStream(streamMessageId: string, reason = 'stream_cancelled'): void {
    const targets = [...this.pending.values()].filter((item) => item.streamMessageId === streamMessageId)
    for (const item of targets) {
      this.resolvePending(item.requestId, {
        requestId: item.requestId,
        action: 'cancel',
        value: { reason },
      })
    }
  }

  cancelByConversation(conversationId: string, reason = 'conversation_cancelled'): void {
    const targets = [...this.pending.values()].filter((item) => item.conversationId === conversationId)
    for (const item of targets) {
      this.resolvePending(item.requestId, {
        requestId: item.requestId,
        action: 'cancel',
        value: { reason },
      })
    }
  }

  get(requestId: string): PendingInteraction | undefined {
    return this.pending.get(requestId)
  }

  private resolvePending(requestId: string, response: AgentInteractionResponse): boolean {
    const pending = this.pending.get(requestId)
    if (!pending) return false

    this.pending.delete(requestId)
    if (pending.timeout) clearTimeout(pending.timeout)

    // E5: Store in resolved cache for multi-window friendly messages
    this.resolvedCache.set(requestId, { action: response.action, resolvedAt: Date.now() })
    // Prune old entries
    if (this.resolvedCache.size > 200) {
      const now = Date.now()
      for (const [key, val] of this.resolvedCache) {
        if (now - val.resolvedAt > this.RESOLVED_TTL_MS) this.resolvedCache.delete(key)
      }
    }

    pending.emitResolved?.({
      type: 'agent_interaction_resolved',
      requestId,
      action: response.action,
      reason: (response.value as any)?.reason,
    })
    pending.resolve(response)
    return true
  }

  /** E5: Check if an interaction was recently resolved (for multi-window friendly message). */
  getResolvedAction(requestId: string): string | null {
    const cached = this.resolvedCache.get(requestId)
    if (!cached) return null
    if (Date.now() - cached.resolvedAt > this.RESOLVED_TTL_MS) {
      this.resolvedCache.delete(requestId)
      return null
    }
    return cached.action
  }
}

export const agentInteractionRegistry = new AgentInteractionRegistry()
