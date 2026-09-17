import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { PiRuntimeRegistry } from './pi-runtime-registry.js'

const afterTimers = () => new Promise(resolve => setTimeout(resolve, 5))

describe('PiRuntimeRegistry startup reload handling', () => {
  it('does not reject a command waiting for a Runtime Worker that is about to reload', async () => {
    const registry = new PiRuntimeRegistry({
      createToolHost: async () => ({
        manifests: [],
        execute: async () => ({ content: [] }),
      }),
    })

    let resolveReady!: () => void
    let rejectReady!: (error: Error) => void
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })
    let disposeReason = ''
    const record: any = {
      key: { conversationId: 'conversation', branchId: 'main' },
      generation: 1,
      state: 'starting',
      commands: [],
      diagnostics: [],
      ready,
      resolveReady,
      rejectReady,
      pendingReload: { generation: 2, reason: 'files:external-change' },
      surfaces: new Map(),
      surfaceOwners: new Map(),
      uiState: new Map(),
      requests: new Map(),
      uiRequestIds: new Map(),
    }

    ;(registry as any).disposeRecord = async (target: any, reason: string) => {
      disposeReason = reason
      target.state = 'disposing'
    }

    await (registry as any).handleWorkerMessage(record, {
      type: 'ready',
      key: record.key,
      generation: 1,
      metadata: { conversationId: 'conversation', branchId: 'main', updatedAt: new Date().toISOString() },
      commands: [],
      diagnostics: [],
    })

    await ready
    assert.equal(record.state, 'idle')
    await afterTimers()
    assert.equal(disposeReason, 'reload:files:external-change')

    await registry.disposeAll('test')
  })

  it('defers the reload until an immediately-resumed command settles', async () => {
    const registry = new PiRuntimeRegistry({
      createToolHost: async () => ({
        manifests: [],
        execute: async () => ({ content: [] }),
      }),
    })

    let resolveReady!: () => void
    const ready = new Promise<void>(resolve => { resolveReady = resolve })
    let disposeReason = ''
    const record: any = {
      key: { conversationId: 'conversation', branchId: 'main' },
      generation: 1,
      state: 'starting',
      commands: [],
      diagnostics: [],
      ready,
      resolveReady,
      rejectReady: () => {},
      pendingReload: { generation: 2, reason: 'files:external-change' },
      surfaces: new Map(),
      surfaceOwners: new Map(),
      uiState: new Map(),
      requests: new Map(),
      uiRequestIds: new Map(),
    }
    ;(registry as any).disposeRecord = async (target: any, reason: string) => {
      disposeReason = reason
      target.state = 'disposing'
    }

    await (registry as any).handleWorkerMessage(record, {
      type: 'ready',
      key: record.key,
      generation: 1,
      metadata: { conversationId: 'conversation', branchId: 'main', updatedAt: new Date().toISOString() },
      commands: [],
      diagnostics: [],
    })

    await ready
    record.state = 'running'
    record.activeRun = { runId: 'command-run' }
    await afterTimers()

    assert.equal(disposeReason, '')
    assert.deepEqual(record.pendingReload, { generation: 2, reason: 'files:external-change' })
    await registry.disposeAll('test')
  })
})

describe('PiRuntimeRegistry failed-run recovery', () => {
  it('does not turn an unhealthy run_error back into idle', async () => {
    const registry = new PiRuntimeRegistry({ createToolHost: async () => ({ manifests: [], execute: async () => ({}) }) })
    const record: any = {
      state: 'running', extensionRuns: new Map(),
      activeRun: { runId: 'failed-run', completed: false, queue: { push() {}, end() {} } },
    }
    ;(registry as any).saveMetadata = async () => {}
    try {
      await (registry as any).handleWorkerMessage(record, {
        type: 'run_error', runId: 'failed-run', error: 'idle timeout', runtimeFailed: true,
      })
      assert.equal(record.state, 'failed')
      assert.equal(record.activeRun, undefined)
    } finally { await registry.disposeAll('test') }
  })

  it('serializes replacement and waits for disposal before reusing the session', async () => {
    const registry = new PiRuntimeRegistry({ createToolHost: async () => ({ manifests: [], execute: async () => ({}) }) })
    const internals = registry as any
    const key = { conversationId: 'failed-conversation', branchId: 'main' }
    const record = { key, state: 'failed', ready: Promise.resolve(), lastUsedAt: 0 }
    const replacement = { key, state: 'idle' }
    internals.records.set('failed-conversation:main', record)
    let release!: () => void
    const disposed = new Promise<void>(resolve => { release = resolve })
    let creations = 0
    let disposals = 0
    internals.disposeRecord = async () => {
      disposals++
      record.state = 'disposing'
      internals.records.delete('failed-conversation:main')
      await disposed
    }
    internals.createRuntime = async () => { creations++; return replacement }
    try {
      const first = internals.ensure(key)
      const second = internals.ensure(key)
      await afterTimers()
      const third = internals.ensure(key)
      assert.equal(disposals, 1)
      assert.equal(creations, 0)
      release()
      assert.deepEqual(await Promise.all([first, second, third]), [replacement, replacement, replacement])
      assert.equal(creations, 1)
    } finally {
      release()
      await registry.disposeAll('test')
    }
  })
})
