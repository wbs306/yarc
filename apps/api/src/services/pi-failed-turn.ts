type FailureModel = {
  api?: string
  provider?: string
  id?: string
  model?: string
}

/**
 * Append a canonical failed turn only when AgentSession did not already
 * persist the corresponding user and/or assistant entries.
 */
export const persistFailedPromptIfMissing = (
  sessionManager: any,
  initialLeafId: string | null,
  prompt: string,
  errorMessage: string,
  assistantModel?: FailureModel
): void => {
  if (!errorMessage || typeof sessionManager?.appendMessage !== 'function') return

  const branch = typeof sessionManager.getBranch === 'function'
    ? sessionManager.getBranch()
    : []
  const initialIndex = initialLeafId
    ? branch.findIndex((entry: any) => entry?.id === initialLeafId)
    : -1
  const newEntries = initialIndex >= 0 ? branch.slice(initialIndex + 1) : branch
  const hasUserMessage = newEntries.some(
    (entry: any) => entry?.type === 'message' && entry.message?.role === 'user'
  )
  const hasAssistantMessage = newEntries.some(
    (entry: any) => entry?.type === 'message' && entry.message?.role === 'assistant'
  )
  const previousAssistant = [...branch].reverse().find(
    (entry: any) => entry?.type === 'message' && entry.message?.role === 'assistant'
  )?.message
  const model = assistantModel || previousAssistant || {}

  if (!hasUserMessage) {
    sessionManager.appendMessage({
      role: 'user',
      content: [{ type: 'text', text: prompt }],
      timestamp: Date.now(),
    })
  }

  if (!hasAssistantMessage) {
    sessionManager.appendMessage({
      role: 'assistant',
      content: [],
      api: model.api || 'pi-messages',
      provider: model.provider || 'yarc',
      model: model.id || model.model || 'error',
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'error',
      errorMessage,
      timestamp: Date.now(),
    })
  }
}
