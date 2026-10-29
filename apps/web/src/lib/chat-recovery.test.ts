import assert from 'node:assert/strict'
import test from 'node:test'
import { getChatRecovery } from './chat-recovery'

const user = { id: 'user-1', role: 'user' as const, content: 'original request', metadata: {} }

test('retries the latest failed turn when the assistant made no progress', () => {
  const recovery = getChatRecovery([
    user,
    {
      id: 'assistant-1',
      role: 'assistant',
      content: '',
      metadata: {
        isError: true,
        stopReason: 'error',
        errorMessage: '500 Internal Server Error',
        segments: [{ type: 'error', text: '500 Internal Server Error' }],
      },
    },
  ], false)

  assert.deepEqual(recovery, {
    action: 'retry',
    assistantMessageId: 'assistant-1',
    userMessageId: 'user-1',
    originalContent: 'original request',
  })
})

test('continues after a failed turn that already produced text, thinking, or tools', () => {
  for (const progress of [
    { segments: [{ type: 'text', text: 'partial answer' }] },
    { segments: [{ type: 'thinking', text: 'reasoning' }] },
    { segments: [{ type: 'tool', toolCallId: 'tool-1' }] },
  ]) {
    const recovery = getChatRecovery([
      user,
      {
        id: 'assistant-1',
        role: 'assistant',
        content: progress.segments[0].type === 'text' ? 'partial answer' : '',
        metadata: {
          isError: true,
          stopReason: 'error',
          errorMessage: 'network failed',
          segments: [...progress.segments, { type: 'error', text: 'network failed' }],
        },
      },
    ], false)
    assert.equal(recovery?.action, 'continue')
  }
})

test('offers no recovery while streaming or after a later user turn', () => {
  const failedAssistant = {
    id: 'assistant-1',
    role: 'assistant' as const,
    content: '',
    metadata: { isError: true, stopReason: 'error', errorMessage: 'failed' },
  }

  assert.equal(getChatRecovery([user, failedAssistant], true), null)
  assert.equal(getChatRecovery([user, failedAssistant, { ...user, id: 'user-2' }], false), null)
})
