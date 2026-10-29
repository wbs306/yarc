export type ChatRecoveryAction = 'retry' | 'continue'

export interface RecoverableChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content?: string
  toolCalls?: unknown[] | null
  metadata?: {
    isError?: boolean
    stopReason?: string
    errorMessage?: string
    segments?: Array<{ type?: string; text?: string }>
    pending?: boolean
  }
}

export interface ChatRecovery {
  action: ChatRecoveryAction
  assistantMessageId: string
  userMessageId: string
  originalContent: string
}

const isFailedAssistant = (message: RecoverableChatMessage) => {
  if (message.role !== 'assistant' || message.metadata?.pending) return false
  if (message.metadata?.isError || message.metadata?.errorMessage) return true
  if (message.metadata?.stopReason === 'error' || message.metadata?.stopReason === 'aborted') return true
  return message.metadata?.segments?.some(segment => segment.type === 'error') || false
}

const hasAssistantProgress = (message: RecoverableChatMessage) => {
  const segments = message.metadata?.segments || []
  if (segments.some(segment => segment.type === 'thinking' || segment.type === 'tool')) return true
  if (segments.some(segment => segment.type === 'text' && !!segment.text?.trim())) return true
  if (message.toolCalls?.length) return true

  // Live errors are appended to content for display. Do not count a standalone
  // error line as useful assistant progress when segments are unavailable.
  const content = message.content?.trim() || ''
  return !!content && !/^❌\s*/.test(content)
}

export const getChatRecovery = (
  messages: RecoverableChatMessage[],
  isStreaming: boolean,
): ChatRecovery | null => {
  if (isStreaming) return null

  let assistantIndex = -1
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === 'system') continue
    if (messages[index].role !== 'assistant') return null
    assistantIndex = index
    break
  }
  if (assistantIndex < 0) return null

  const assistant = messages[assistantIndex]
  if (!isFailedAssistant(assistant)) return null

  let userIndex = -1
  for (let index = assistantIndex - 1; index >= 0; index--) {
    if (messages[index].role === 'user') {
      userIndex = index
      break
    }
  }
  if (userIndex < 0) return null

  const user = messages[userIndex]
  if (user.metadata?.pending || !user.content?.trim()) return null

  const turnMessages = messages.slice(userIndex + 1, assistantIndex + 1)
  const madeProgress = turnMessages.some(message => message.role === 'assistant' && hasAssistantProgress(message))

  return {
    action: madeProgress ? 'continue' : 'retry',
    assistantMessageId: assistant.id,
    userMessageId: user.id,
    originalContent: user.content,
  }
}
