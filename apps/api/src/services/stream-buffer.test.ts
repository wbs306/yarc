import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { StreamBuffer } from '../lib/stream-buffer.js'

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

describe('StreamBuffer terminal ordering', () => {
  it('does not replay or publish done until complete persistence finishes', async () => {
    const persist = deferred()
    let persisted = false
    const buffer = new StreamBuffer({
      flushFn: async (_conversationId, _messageId, _events, finalData) => {
        if (finalData.status === 'streaming') return
        await persist.promise
        persisted = true
      },
      flushIntervalMs: 60_000,
    })
    const received: any[] = []

    await buffer.start('message-1', 'conversation-1', 'main')
    buffer.subscribe('message-1', event => { received.push(event) })
    buffer.append('message-1', { type: 'text', content: 'hello' })
    buffer.append('message-1', { type: 'done' })

    assert.equal(buffer.getEvents('message-1').some((event: any) => event.type === 'done'), false)
    const completing = buffer.complete('message-1')
    await new Promise(resolve => setImmediate(resolve))

    assert.equal(persisted, false)
    assert.equal(received.some(event => event.type === 'done'), false)
    assert.equal(buffer.has('message-1'), true)

    persist.resolve()
    await completing

    assert.equal(persisted, true)
    assert.equal(received.filter(event => event.type === 'done').length, 1)
    assert.equal(buffer.has('message-1'), false)
  })

  it('publishes failed done only after the failed snapshot is persisted', async () => {
    const persist = deferred()
    const buffer = new StreamBuffer({
      flushFn: async (_conversationId, _messageId, _events, finalData) => {
        if (finalData.status !== 'streaming') await persist.promise
      },
      flushIntervalMs: 60_000,
    })
    const received: any[] = []

    await buffer.start('message-2', 'conversation-1', 'main')
    buffer.subscribe('message-2', event => { received.push(event) })
    const failing = buffer.fail('message-2', 'provider failed')
    await new Promise(resolve => setImmediate(resolve))

    assert.equal(received.some(event => event.type === 'error'), true)
    assert.equal(received.some(event => event.type === 'done'), false)

    persist.resolve()
    await failing

    assert.equal(received.filter(event => event.type === 'done').length, 1)
    assert.equal(buffer.has('message-2'), false)
  })

  it('preserves thinking, text, and tool boundaries for replay', async () => {
    const buffer = new StreamBuffer({
      flushFn: async () => {},
      flushIntervalMs: 60_000,
    })

    await buffer.start('message-3', 'conversation-1', 'main')
    buffer.append('message-3', { type: 'thinking', content: 'reason-1' })
    buffer.append('message-3', { type: 'text', content: 'answer-1' })
    buffer.append('message-3', { type: 'tool_call', toolCallId: 'tool-1', toolName: 'read', input: '{}' })
    buffer.append('message-3', { type: 'thinking', content: 'reason-2' })
    buffer.append('message-3', { type: 'text', content: 'answer-2' })

    const replay = buffer.getEvents('message-3')
    assert.deepEqual(
      replay.map((event: any) => event.type),
      ['thinking', 'text', 'tool_call', 'thinking', 'text']
    )
    assert.deepEqual(replay.map((event: any) => event.eventSequence), [1, 2, 3, 4, 5])
    assert.deepEqual(buffer.getEvents('message-3', 3).map((event: any) => event.eventSequence), [4, 5])
    assert.deepEqual(
      buffer.get('message-3')?.segments.map(segment => segment.type),
      ['thinking', 'text', 'tool', 'thinking', 'text']
    )

    await buffer.complete('message-3')
  })

  it('coalesces adjacent deltas for replay while live subscribers get every delta', async () => {
    const buffer = new StreamBuffer({
      flushFn: async () => {},
      flushIntervalMs: 60_000,
    })
    const live: any[] = []

    await buffer.start('message-6', 'conversation-1', 'main')
    buffer.subscribe('message-6', event => { live.push(event) })
    buffer.append('message-6', { type: 'thinking', content: 'ab', assistantMessageId: 'a-1' })
    buffer.append('message-6', { type: 'thinking', content: 'cd', assistantMessageId: 'a-1' })
    buffer.append('message-6', { type: 'thinking', content: 'ef', assistantMessageId: 'a-1' })
    buffer.append('message-6', { type: 'tool_call', toolCallId: 'tool-1', toolName: 'read', input: '{}', assistantMessageId: 'a-1' })
    buffer.append('message-6', { type: 'text', content: 'x', assistantMessageId: 'a-1' })
    buffer.append('message-6', { type: 'text', content: 'y', assistantMessageId: 'a-2' })
    buffer.append('message-6', { type: 'text', content: 'z', assistantMessageId: 'a-2' })

    // Live delivery is unchanged: one event per delta with its own sequence.
    assert.deepEqual(live.map(event => event.eventSequence), [1, 2, 3, 4, 5, 6, 7])
    assert.deepEqual(live.slice(0, 3).map(event => event.content), ['ab', 'cd', 'ef'])

    const replay = buffer.getEvents('message-6') as any[]
    assert.deepEqual(replay.map(event => [event.type, event.content, event.eventSequence]), [
      ['thinking', 'abcdef', 3],
      ['tool_call', undefined, 4],
      ['text', 'x', 5],
      ['text', 'yz', 7],
    ])

    // A cursor inside a merged range replays only the unseen suffix.
    const resumed = buffer.getEvents('message-6', 1) as any[]
    assert.deepEqual(resumed.map(event => [event.type, event.content, event.eventSequence]), [
      ['thinking', 'cdef', 3],
      ['tool_call', undefined, 4],
      ['text', 'x', 5],
      ['text', 'yz', 7],
    ])
    assert.deepEqual((buffer.getEvents('message-6', 6) as any[]).map(event => [event.content, event.eventSequence]), [['z', 7]])
    assert.deepEqual(buffer.getEvents('message-6', 7), [])

    // Merging must not mutate events already handed to live subscribers.
    assert.equal(live[0].content, 'ab')
    await buffer.complete('message-6')
  })

  it('persists the streaming journal only when recovery state changes', async () => {
    const writes: Array<{ events: unknown[] }> = []
    const buffer = new StreamBuffer({
      flushFn: async (_conversationId, _messageId, events, finalData) => {
        if (finalData.status === 'streaming') writes.push({ events: [...events] })
      },
      flushIntervalMs: 5,
    })

    await buffer.start('message-6', 'conversation-1', 'main')
    assert.equal(writes.length, 1)

    for (let i = 0; i < 50; i++) buffer.append('message-6', { type: 'thinking', content: `t${i}` })
    buffer.append('message-6', { type: 'tool_call', toolCallId: 'tool-1', toolName: 'read', input: '{}' })
    buffer.append('message-6', { type: 'tool_result', toolCallId: 'tool-1', result: 'ok' })
    await new Promise(resolve => setTimeout(resolve, 40))
    assert.equal(writes.length, 1, 'deltas and tool events must not rewrite the journal')

    buffer.append('message-6', {
      type: 'pi_assistant_entry', conversationId: 'conversation-1', messageId: 'message-6',
      entryId: 'entry-6', sessionFile: '/tmp/session-6.jsonl',
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(writes.length, 2, 'a commit mapping must be persisted immediately')

    await new Promise(resolve => setTimeout(resolve, 40))
    assert.equal(writes.length, 2)
    await buffer.complete('message-6')
  })

  it('records the canonical Session file when a commit mapping arrives', async () => {
    const buffer = new StreamBuffer({
      flushFn: async () => {},
      flushIntervalMs: 60_000,
    })

    await buffer.start('message-5', 'conversation-1', 'main')
    buffer.append('message-5', {
      type: 'pi_assistant_entry',
      conversationId: 'conversation-1',
      messageId: 'message-5',
      entryId: 'assistant-entry-5',
      sessionFile: '/tmp/session-5.jsonl',
    })

    assert.equal(buffer.get('message-5')?.sessionFile, '/tmp/session-5.jsonl')
    await buffer.complete('message-5')
  })

  it('merges reasoning blocks within the same tool phase', async () => {
    const buffer = new StreamBuffer({
      flushFn: async () => {},
      flushIntervalMs: 60_000,
    })

    await buffer.start('message-4', 'conversation-1', 'main')
    buffer.append('message-4', { type: 'tool_call', toolCallId: 'tool-1', toolName: 'read', input: '{}' })
    buffer.append('message-4', { type: 'thinking', content: 'reason-1' })
    buffer.append('message-4', { type: 'text', content: 'intermediate text' })
    buffer.append('message-4', { type: 'thinking', content: 'reason-2' })
    buffer.append('message-4', { type: 'tool_call', toolCallId: 'tool-2', toolName: 'write', input: '{}' })

    buffer.getEvents('message-4')
    assert.deepEqual(
      buffer.get('message-4')?.segments.map(segment => segment.type),
      ['tool', 'thinking', 'text', 'tool']
    )
    const thinkingSegment = buffer.get('message-4')?.segments[1]
    assert.equal(thinkingSegment?.type, 'thinking')
    assert.equal(thinkingSegment && 'text' in thinkingSegment ? thinkingSegment.text : undefined, 'reason-1\n\nreason-2')

    await buffer.complete('message-4')
  })
})
