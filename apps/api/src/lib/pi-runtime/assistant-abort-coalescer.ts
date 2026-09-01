export interface DeferredAssistantAbort {
  assistantMessageId?: string
  message: string
}

/**
 * An AgentSession can deliberately abort one assistant turn before starting a
 * continuation (for example, an extension may rebuild the Session tree after a
 * tool result). An `aborted` entry is durable history, but is not necessarily a
 * user-visible failure. Keep it pending until the Runtime settles: any later
 * assistant start in the same run supersedes the pending aborts; otherwise the
 * host reports a real stopped request.
 */
export class AssistantAbortCoalescer {
  private pending: DeferredAssistantAbort[] = []

  defer(abort: DeferredAssistantAbort): void {
    const existing = this.pending.find(item =>
      item.assistantMessageId === abort.assistantMessageId
      && item.message === abort.message
    )
    if (!existing) this.pending.push(abort)
  }

  supersedeWithContinuation(): void {
    this.pending = []
  }

  drain(): DeferredAssistantAbort[] {
    const pending = this.pending
    this.pending = []
    return pending
  }

  clear(): void {
    this.pending = []
  }
}
