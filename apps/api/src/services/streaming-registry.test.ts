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

  it('transfers producer ownership across extension-driven session switches', () => {
    const registry = new StreamingRegistry()
    registry.register('conversation-1', 'message-1', 'main', 'session-1')

    assert.equal(registry.transfer('conversation-1', 'conversation-2', 'message-1', {
      branchId: 'main',
      sessionFile: 'session-2',
    }), true)
    assert.equal(registry.has('conversation-1'), false)
    assert.equal(registry.get('conversation-2')?.sessionFile, 'session-2')

    // The original producer closure still uses its starting conversation ID.
    // Heartbeat and cleanup must continue to find the transferred run by ID.
    registry.touch('conversation-1', 'message-1')
    registry.unregister('conversation-1', 'message-1')
    assert.equal(registry.has('conversation-2'), false)
  })

  it('hands producer ownership to a delayed extension continuation without a free gap', async () => {
    const registry = new StreamingRegistry()
    registry.register('conversation-1', 'message-1', 'main', 'session-1')
    const originalCompletion = registry.waitForMessage('message-1', 0)

    assert.equal(registry.handoff('conversation-1', 'message-1', 'extension-run-1', {
      branchId: 'main',
      sessionFile: 'session-1',
    }), true)
    await originalCompletion
    assert.equal(registry.get('conversation-1')?.messageId, 'extension-run-1')

    registry.unregister('conversation-1', 'message-1')
    assert.equal(registry.get('conversation-1')?.messageId, 'extension-run-1')
    registry.unregister('conversation-1', 'extension-run-1')
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
