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
