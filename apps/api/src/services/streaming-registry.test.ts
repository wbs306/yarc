import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { StreamingRegistry } from '../lib/streaming-registry.js'

describe('StreamingRegistry producer ownership', () => {
  it('rejects a second producer and ignores stale unregister calls', () => {
    const registry = new StreamingRegistry()
    registry.register('conversation-1', 'message-1', 'main', 'session-1')

    assert.throws(
      () => registry.register('conversation-1', 'message-2', 'main', 'session-2'),
      /already has an active stream/
    )

    registry.unregister('conversation-1', 'message-2')
    assert.equal(registry.get('conversation-1')?.messageId, 'message-1')

    registry.unregister('conversation-1', 'message-1')
    assert.equal(registry.has('conversation-1'), false)
  })

  it('uses heartbeat activity rather than start time for cleanup', () => {
    const registry = new StreamingRegistry({ timeoutMs: 100 })
    const originalNow = Date.now
    let now = 100
    Date.now = () => now

    try {
      registry.register('conversation-1', 'message-1', 'main', 'session-1')
      now = 150
      registry.touch('conversation-1', 'message-1')
      now = 220
      registry.cleanup()
      assert.equal(registry.has('conversation-1'), true)

      registry.update('conversation-1', 'message-1', { branchId: 'edit-1', sessionFile: 'session-2' })
      assert.equal(registry.get('conversation-1')?.branchId, 'edit-1')
      assert.equal(registry.get('conversation-1')?.sessionFile, 'session-2')

      now = 321
      registry.cleanup()
      assert.equal(registry.has('conversation-1'), false)
    } finally {
      Date.now = originalNow
    }
  })
})
