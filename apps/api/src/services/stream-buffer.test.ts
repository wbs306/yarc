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
      flushFn: async () => {
        await persist.promise
        persisted = true
      },
      flushIntervalMs: 60_000,
    })
    const received: any[] = []

    buffer.start('message-1', 'conversation-1', 'main')
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
      flushFn: async () => { await persist.promise },
      flushIntervalMs: 60_000,
    })
    const received: any[] = []

    buffer.start('message-2', 'conversation-1', 'main')
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

    buffer.start('message-3', 'conversation-1', 'main')
    buffer.append('message-3', { type: 'thinking', content: 'reason-1' })
    buffer.append('message-3', { type: 'text', content: 'answer-1' })
    buffer.append('message-3', { type: 'tool_call', toolCallId: 'tool-1', toolName: 'read', input: '{}' })
    buffer.append('message-3', { type: 'thinking', content: 'reason-2' })
    buffer.append('message-3', { type: 'text', content: 'answer-2' })

    assert.deepEqual(
      buffer.getEvents('message-3').map((event: any) => event.type),
      ['thinking', 'text', 'tool_call', 'thinking', 'text']
    )
    assert.deepEqual(
      buffer.get('message-3')?.segments.map(segment => segment.type),
      ['thinking', 'text', 'tool', 'thinking', 'text']
    )

    await buffer.complete('message-3')
  })
})
