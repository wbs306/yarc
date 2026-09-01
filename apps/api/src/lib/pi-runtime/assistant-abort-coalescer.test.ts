import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { AssistantAbortCoalescer } from './assistant-abort-coalescer.js'

describe('AssistantAbortCoalescer', () => {
  it('suppresses internal aborts when a continuation assistant starts', () => {
    const coalescer = new AssistantAbortCoalescer()
    coalescer.defer({ assistantMessageId: 'assistant-1', message: 'Request aborted' })
    coalescer.supersedeWithContinuation()
    assert.deepEqual(coalescer.drain(), [])
  })

  it('keeps a user-visible abort when no continuation follows', () => {
    const coalescer = new AssistantAbortCoalescer()
    coalescer.defer({ assistantMessageId: 'assistant-1', message: 'Request aborted' })
    assert.deepEqual(coalescer.drain(), [{ assistantMessageId: 'assistant-1', message: 'Request aborted' }])
  })

  it('deduplicates matching update and message-end abort reports', () => {
    const coalescer = new AssistantAbortCoalescer()
    coalescer.defer({ assistantMessageId: 'assistant-1', message: 'Request aborted' })
    coalescer.defer({ assistantMessageId: 'assistant-1', message: 'Request aborted' })
    assert.equal(coalescer.drain().length, 1)
  })
})
