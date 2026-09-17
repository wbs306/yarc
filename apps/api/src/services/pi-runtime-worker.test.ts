import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import test from 'node:test'

const waitForMessage = <T = any>(worker: Worker, predicate: (message: any) => boolean, timeoutMs = 15_000) => new Promise<T>((resolvePromise, reject) => {
  const timeout = setTimeout(() => {
    cleanup()
    reject(new Error('Timed out waiting for Runtime Worker message'))
  }, timeoutMs)
  const onMessage = (message: any) => {
    if (!predicate(message)) return
    cleanup()
    resolvePromise(message as T)
  }
  const onError = (error: Error) => {
    cleanup()
    reject(error)
  }
  const cleanup = () => {
    clearTimeout(timeout)
    worker.off('message', onMessage)
    worker.off('error', onError)
  }
  worker.on('message', onMessage)
  worker.on('error', onError)
})

test('Runtime Worker keeps an extension command alive through a Web TUI interaction', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yarc-pi-runtime-'))
  const agentDir = join(root, 'agent')
  const sessionDir = join(agentDir, 'sessions')
  const extensionsDir = join(agentDir, 'extensions')
  await mkdir(sessionDir, { recursive: true })
  await mkdir(extensionsDir, { recursive: true })
  await writeFile(join(extensionsDir, 'surface.js'), `
export default function (pi) {
  pi.registerCommand('surface', {
    description: 'surface test',
    getArgumentCompletions: async (prefix) => [{ value: prefix + '-done', label: 'complete' }],
    handler: async (_args, ctx) => {
      await ctx.ui.custom((tui, theme, _kb, done) => ({
        render: () => [theme.fg('accent', 'Runtime surface ready'), 'Host: ' + tui.constructor.name, 'Press any key'],
        invalidate() {},
        handleInput() { done('ok') },
      }), { overlay: true })
    },
  })
  pi.registerCommand('deferred-surface', {
    description: 'wait for the host run boundary',
    handler: async (_args, ctx) => {
      setTimeout(async () => {
        await ctx.waitForIdle()
        await ctx.ui.custom((_tui, _theme, _kb, done) => ({
          render: () => ['Deferred after host idle'],
          invalidate() {},
          handleInput() { done() },
        }), { overlay: true })
      }, 0)
    },
  })
}
`, 'utf8')

  const worker = new Worker(new URL('../workers/pi-session.worker.ts', import.meta.url), {
    execArgv: ['--import', createRequire(import.meta.url).resolve('tsx')],
  })

  try {
    worker.postMessage({
      type: 'init',
      payload: {
        key: { conversationId: 'test-conversation', branchId: 'main' },
        generation: 1,
        cwd: root,
        agentDir,
        sessionDir,
        tools: [],
      },
    })
    const ready: any = await waitForMessage(worker, message => message.type === 'ready')
    assert.ok(ready.commands.some((command: any) => command.name === 'surface'))

    worker.postMessage({ type: 'autocomplete_request', requestId: 'completion-1', lines: ['/surface value'], cursorLine: 0, cursorCol: 14 })
    const completion: any = await waitForMessage(worker, message => message.type === 'autocomplete_result' && message.requestId === 'completion-1')
    assert.equal(completion.result.items[0].value, 'value-done')

    worker.postMessage({
      type: 'prompt',
      payload: {
        runId: 'run-1',
        prompt: '/surface',
        assistantMessageId: 'assistant-1',
      },
    })
    const opened: any = await waitForMessage(worker, message => message.type === 'event' && message.event?.type === 'agent_ui_tui_open')
    assert.match(opened.event.surface.plainText, /Runtime surface ready/)
    assert.match(opened.event.surface.plainText, /Host: TUI/)

    worker.postMessage({ type: 'tui_input', surfaceId: opened.event.surface.surfaceId, data: 'x' })
    const completed: any = await waitForMessage(worker, message => message.type === 'run_complete')
    assert.equal(completed.runId, 'run-1')

    const deferredOrder: string[] = []
    const deferredResult = new Promise<any>((resolvePromise, reject) => {
      const timeout = setTimeout(() => {
        cleanup()
        reject(new Error('Timed out waiting for deferred Runtime surface'))
      }, 15_000)
      let deferredSurface: any
      let runCompleted = false
      const onMessage = (message: any) => {
        if (message.type === 'run_complete' && message.runId === 'run-2') {
          runCompleted = true
          deferredOrder.push('run_complete')
        }
        if (message.type === 'event' && message.event?.type === 'agent_ui_tui_open' && /Deferred after host idle/.test(message.event.surface.plainText)) {
          deferredSurface = message.event.surface
          deferredOrder.push('tui_open')
        }
        if (runCompleted && deferredSurface) {
          cleanup()
          resolvePromise(deferredSurface)
        }
      }
      const cleanup = () => {
        clearTimeout(timeout)
        worker.off('message', onMessage)
      }
      worker.on('message', onMessage)
    })
    worker.postMessage({ type: 'prompt', payload: { runId: 'run-2', prompt: '/deferred-surface', assistantMessageId: 'assistant-2' } })
    const deferredSurface = await deferredResult
    assert.deepEqual(deferredOrder, ['tui_open', 'run_complete'])
    worker.postMessage({ type: 'tui_input', surfaceId: deferredSurface.surfaceId, data: 'x' })

    worker.postMessage({ type: 'dispose', reason: 'test' })
    await waitForMessage(worker, message => message.type === 'disposed')
  } finally {
    await worker.terminate()
    await rm(root, { recursive: true, force: true })
  }
})

test('Runtime Worker restores pi-context ACM state after a host reload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yarc-pi-runtime-acm-'))
  const agentDir = join(root, 'agent')
  const sessionDir = join(agentDir, 'sessions')
  const extensionsDir = join(agentDir, 'extensions')
  await mkdir(sessionDir, { recursive: true })
  await mkdir(extensionsDir, { recursive: true })
  await writeFile(join(extensionsDir, 'acm.js'), `
let enabled = false
export default function (pi) {
  pi.registerCommand('acm', {
    handler: async (_args, ctx) => {
      enabled = true
      ctx.ui.notify('restore-notification-should-be-suppressed', 'info')
    },
  })
  pi.registerCommand('check-acm', {
    handler: async (_args, ctx) => {
      ctx.ui.notify(enabled ? 'acm-ready' : 'acm-missing', 'info')
    },
  })
}
`, 'utf8')

  const worker = new Worker(new URL('../workers/pi-session.worker.ts', import.meta.url), {
    execArgv: ['--import', createRequire(import.meta.url).resolve('tsx')],
  })

  try {
    worker.postMessage({
      type: 'init',
      payload: {
        key: { conversationId: 'acm-conversation', branchId: 'main' },
        generation: 1,
        cwd: root,
        agentDir,
        sessionDir,
        tools: [],
        restoreAcm: true,
      },
    })
    await waitForMessage(worker, message => message.type === 'ready')
    worker.postMessage({ type: 'reload', generation: 2, reason: 'files:external-change:ordinary.md' })
    await waitForMessage(worker, message => message.type === 'ready' && message.generation === 2)
    worker.postMessage({ type: 'prompt', payload: { runId: 'acm-check-run', prompt: '/check-acm', assistantMessageId: 'assistant-acm' } })
    const checked: any = await waitForMessage(worker, message => message.type === 'event' && message.event?.type === 'agent_interaction_request' && message.event?.message === 'acm-ready')
    assert.equal(checked.event.message, 'acm-ready')
    await waitForMessage(worker, message => message.type === 'run_complete' && message.runId === 'acm-check-run')
  } finally {
    await worker.terminate()
    await rm(root, { recursive: true, force: true })
  }
})

test('Runtime Worker awaits /acm once before every context_compact call, including after reload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yarc-pi-runtime-auto-acm-'))
  const agentDir = join(root, 'agent')
  const sessionDir = join(agentDir, 'sessions')
  const extensionsDir = join(agentDir, 'extensions')
  await mkdir(sessionDir, { recursive: true })
  await mkdir(extensionsDir, { recursive: true })
  // In-memory provider: exercise the real tool hooks without a model API call.
  await writeFile(join(extensionsDir, 'auto-acm.js'), `
let enables = 0
let compacts = 0
let rejectEnable = false
export default function (pi) {
  pi.registerCommand('acm', {
    handler: async (_args, ctx) => {
      await new Promise(resolve => setTimeout(resolve, 10))
      if (rejectEnable) throw new Error('mock-acm-enable-failed')
      enables++
      ctx.ui.notify('automatic-enable-notice', 'info')
    },
  })
  pi.registerCommand('reject-acm', { handler: async () => { rejectEnable = true } })
  pi.registerCommand('acm-counts', {
    handler: async (_args, ctx) => ctx.ui.notify(JSON.stringify({ enables, compacts }), 'info'),
  })
  for (const name of ['context_checkpoint', 'context_compact']) {
    pi.registerTool({
      name, label: name, description: name,
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        if (name === 'context_compact') {
          compacts++
          if (enables !== compacts) throw new Error('ACM was not enabled exactly once before compaction')
        }
        return { content: [{ type: 'text', text: name + ':' + enables }], details: {} }
      },
    })
  }
  pi.registerProvider('acm-mock', {
    api: 'acm-mock-api', apiKey: 'test-only', baseUrl: 'http://127.0.0.1:1',
    models: [{ id: 'mock', name: 'Mock', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10000, maxTokens: 1000 }],
    streamSimple: (model, context) => {
      const start = context.messages.findLastIndex(message => message.role === 'user')
      const turn = context.messages.slice(start + 1).filter(message => message.role === 'toolResult').length
      const names = ['context_checkpoint', 'context_compact', 'context_compact']
      const message = {
        role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
        content: turn < names.length
          ? [{ type: 'toolCall', id: 'mock-' + start + '-' + turn, name: names[turn], arguments: {} }]
          : [{ type: 'text', text: 'done' }],
        stopReason: turn < names.length ? 'toolUse' : 'stop',
        usage: { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      }
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'start', partial: message }
          yield { type: 'done', reason: message.stopReason, message }
        },
        result: async () => message,
      }
    },
  })
}
`, 'utf8')

  const worker = new Worker(new URL('../workers/pi-session.worker.ts', import.meta.url), {
    execArgv: ['--import', createRequire(import.meta.url).resolve('tsx')],
  })
  const messages: any[] = []
  worker.on('message', message => messages.push(message))
  const prompt = async (runId: string, text: string) => {
    const completed = waitForMessage(worker, message =>
      (message.type === 'run_complete' || message.type === 'run_error') && message.runId === runId)
    worker.postMessage({ type: 'prompt', payload: { runId, prompt: text, assistantMessageId: 'assistant-' + runId } })
    assert.equal((await completed).type, 'run_complete')
    return messages.filter(message => message.runId === runId && message.type === 'event').map(message => message.event)
  }
  try {
    worker.postMessage({
      type: 'init',
      payload: { key: { conversationId: 'auto-acm', branchId: 'main' }, generation: 1,
        cwd: root, agentDir, sessionDir, tools: [], model: 'acm-mock/mock', thinkingLevel: 'off' },
    })
    await waitForMessage(worker, message => message.type === 'ready')
    for (const generation of [1, 2]) {
      if (generation === 2) {
        worker.postMessage({ type: 'reload', generation, reason: 'test' })
        await waitForMessage(worker, message => message.type === 'ready' && message.generation === generation)
      }
      const events = await prompt('compact-' + generation, 'Exercise the context tools')
      assert.deepEqual(events.filter(event => event.type === 'tool_result').map(event => event.result), [
        'context_checkpoint:0', 'context_compact:1', 'context_compact:2',
      ])
      assert.ok(!events.some(event => event.type === 'error'))
      assert.ok(!events.some(event => event.message === 'automatic-enable-notice'))
      const counts = await prompt('counts-' + generation, '/acm-counts')
      assert.ok(counts.some(event => event.message === JSON.stringify({ enables: 2, compacts: 2 })))
    }
    await prompt('reject-enable', '/reject-acm')
    const failed = await prompt('failed-compact', 'Exercise the context tools again')
    assert.deepEqual(failed.filter(event => event.type === 'tool_result').map(event => event.result), [
      'context_checkpoint:2', 'mock-acm-enable-failed', 'mock-acm-enable-failed',
    ])
    const counts = await prompt('failed-counts', '/acm-counts')
    assert.ok(counts.some(event => event.message === JSON.stringify({ enables: 2, compacts: 2 })))
  } finally {
    await worker.terminate()
    await rm(root, { recursive: true, force: true })
  }
})

test('Runtime Worker does not persist per-conversation model selection as a global default', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yarc-pi-runtime-settings-'))
  const agentDir = join(root, 'agent')
  const sessionDir = join(agentDir, 'sessions')
  const extensionsDir = join(agentDir, 'extensions')
  await mkdir(sessionDir, { recursive: true })
  await mkdir(extensionsDir, { recursive: true })
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({
    defaultProvider: 'test',
    defaultModel: 'one',
    defaultThinkingLevel: 'low',
  }) + '\n')
  await writeFile(join(agentDir, 'models.json'), JSON.stringify({
    providers: {
      test: {
        api: 'openai-completions',
        baseUrl: 'http://127.0.0.1:1/v1',
        models: [
          { id: 'one', name: 'One', reasoning: false, contextWindow: 1_000, maxTokens: 100 },
          { id: 'two', name: 'Two', reasoning: false, contextWindow: 1_000, maxTokens: 100 },
        ],
      },
    },
  }) + '\n')
  await writeFile(join(agentDir, 'auth.json'), JSON.stringify({ test: { type: 'api_key', key: 'test-only' } }) + '\n')
  await writeFile(join(extensionsDir, 'noop.js'), `
export default function (pi) {
  pi.registerCommand('noop', { handler: async () => {} })
}
`, 'utf8')

  const worker = new Worker(new URL('../workers/pi-session.worker.ts', import.meta.url), {
    execArgv: ['--import', createRequire(import.meta.url).resolve('tsx')],
  })

  try {
    worker.postMessage({
      type: 'init',
      payload: {
        key: { conversationId: 'settings-conversation', branchId: 'main' },
        generation: 1,
        cwd: root,
        agentDir,
        sessionDir,
        model: 'test/one',
        tools: [],
      },
    })
    await waitForMessage(worker, message => message.type === 'ready')
    worker.postMessage({
      type: 'prompt',
      payload: {
        runId: 'settings-run',
        prompt: '/noop',
        assistantMessageId: 'assistant-settings',
        model: 'test/two',
        thinkingEnabled: false,
      },
    })
    await waitForMessage(worker, message => message.type === 'run_complete' && message.runId === 'settings-run')

    const settings = JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8'))
    assert.equal(settings.defaultProvider, 'test')
    assert.equal(settings.defaultModel, 'one')
    assert.equal(settings.defaultThinkingLevel, 'low')
  } finally {
    await worker.terminate()
    await rm(root, { recursive: true, force: true })
  }
})

test('Runtime Worker retains its Runtime key when an extension fork fails before replacement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yarc-pi-runtime-fork-'))
  const agentDir = join(root, 'agent')
  const sessionDir = join(agentDir, 'sessions')
  const extensionsDir = join(agentDir, 'extensions')
  await mkdir(sessionDir, { recursive: true })
  await mkdir(extensionsDir, { recursive: true })
  await writeFile(join(extensionsDir, 'fork.js'), `
export default function (pi) {
  pi.registerCommand('fork-now', {
    handler: async (_args, ctx) => {
      const entryId = ctx.sessionManager.getLeafId()
      if (!entryId) throw new Error('missing leaf')
      await ctx.fork(entryId, { position: 'at' })
    },
  })
}
`, 'utf8')

  const worker = new Worker(new URL('../workers/pi-session.worker.ts', import.meta.url), {
    execArgv: ['--import', createRequire(import.meta.url).resolve('tsx')],
  })
  worker.on('message', (message: any) => {
    if (message.type === 'control_request' && message.operation === 'allocate_branch') {
      worker.postMessage({ type: 'control_result', requestId: message.requestId, ok: true, result: { branchId: 'extension-fork', parentBranchId: 'main' } })
    }
  })

  try {
    worker.postMessage({
      type: 'init',
      payload: {
        key: { conversationId: 'fork-conversation', branchId: 'main' },
        generation: 1,
        cwd: root,
        agentDir,
        sessionDir,
        tools: [],
      },
    })
    await waitForMessage(worker, message => message.type === 'ready')
    worker.postMessage({ type: 'prompt', payload: { runId: 'fork-run', prompt: '/fork-now', assistantMessageId: 'assistant-fork' } })
    const completed: any = await waitForMessage(worker, message => message.type === 'run_complete' && message.runId === 'fork-run')
    assert.equal(completed.metadata.branchId, 'main')
  } finally {
    await worker.terminate()
    await rm(root, { recursive: true, force: true })
  }
})

test('separate Runtime Workers isolate extension module globals', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yarc-pi-runtime-isolation-'))
  const agentDir = join(root, 'agent')
  const extensionsDir = join(agentDir, 'extensions')
  await mkdir(extensionsDir, { recursive: true })
  await writeFile(join(extensionsDir, 'counter.js'), `
let count = 0
export default function (pi) {
  pi.registerCommand('count', {
    handler: async (_args, ctx) => {
      count += 1
      await ctx.ui.custom((_tui, _theme, _kb, done) => ({
        render: () => [String(count)],
        invalidate() {},
        handleInput() { done() },
      }), { overlay: true })
    },
  })
}
`, 'utf8')

  const makeWorker = async (conversationId: string) => {
    const sessionDir = join(agentDir, `sessions-${conversationId}`)
    await mkdir(sessionDir, { recursive: true })
    const worker = new Worker(new URL('../workers/pi-session.worker.ts', import.meta.url), {
      execArgv: ['--import', createRequire(import.meta.url).resolve('tsx')],
    })
    worker.postMessage({
      type: 'init',
      payload: {
        key: { conversationId, branchId: 'main' },
        generation: 1,
        cwd: root,
        agentDir,
        sessionDir,
        tools: [],
      },
    })
    await waitForMessage(worker, message => message.type === 'ready')
    return worker
  }

  const runCount = async (worker: Worker, runId: string) => {
    worker.postMessage({ type: 'prompt', payload: { runId, prompt: '/count', assistantMessageId: `assistant-${runId}` } })
    const opened: any = await waitForMessage(worker, message => message.type === 'event' && message.event?.type === 'agent_ui_tui_open')
    const value = opened.event.surface.plainText.trim()
    worker.postMessage({ type: 'tui_input', surfaceId: opened.event.surface.surfaceId, data: 'x' })
    await waitForMessage(worker, message => message.type === 'run_complete' && message.runId === runId)
    return value
  }

  const workerA = await makeWorker('a')
  const workerB = await makeWorker('b')
  try {
    const [firstA, firstB] = await Promise.all([runCount(workerA, 'a-1'), runCount(workerB, 'b-1')])
    assert.equal(firstA, '1')
    assert.equal(firstB, '1')
    assert.equal(await runCount(workerA, 'a-2'), '2')
  } finally {
    await Promise.all([workerA.terminate(), workerB.terminate()])
    await rm(root, { recursive: true, force: true })
  }
})

test('Runtime Worker keeps multi-tool compact continuations in one run beyond 30 seconds', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yarc-pi-runtime-continuation-'))
  const agentDir = join(root, 'agent')
  const sessionDir = join(agentDir, 'sessions')
  const extensionsDir = join(agentDir, 'extensions')
  await mkdir(sessionDir, { recursive: true })
  await mkdir(extensionsDir, { recursive: true })
  // Reproduce pi-context's turn_end abort -> deferred waitForIdle -> tree
  // navigation -> triggerTurn flow, without a network call or user data.
  await writeFile(join(extensionsDir, 'continuation.js'), `
let commandCtx
let compactPending = false
let turn = 0
export default function (pi) {
  pi.registerCommand('acm', { handler: async (_args, ctx) => { commandCtx = ctx } })
  for (const name of ['before', 'context_compact', 'after']) {
    pi.registerTool({
      name, label: name, description: name, executionMode: 'parallel',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        await new Promise(resolve => setTimeout(resolve, name === 'context_compact' ? 5 : 30))
        if (name === 'context_compact') compactPending = true
        return { content: [{ type: 'text', text: name + '-done' }], details: {} }
      },
    })
  }
  pi.on('turn_end', (_event, ctx) => { if (compactPending) ctx.abort() })
  pi.on('agent_end', (_event, ctx) => {
    if (!compactPending) return
    compactPending = false
    setTimeout(async () => {
      try {
        await commandCtx.waitForIdle()
        const sm = ctx.sessionManager
        const target = sm.getBranch()[0].id
        const summary = sm.branchWithSummary(target, 'Continue the test')
        sm.branch(target)
        await commandCtx.navigateTree(summary, { summarize: false })
        pi.sendMessage({ customType: 'test-compact', content: 'Continue', display: false },
          { triggerTurn: true, deliverAs: 'followUp' })
      } catch (error) { ctx.ui.notify('continuation-failed: ' + error.message, 'error') }
    }, 0)
  })
  pi.registerProvider('continuation-mock', {
    api: 'continuation-mock-api', apiKey: 'test-only', baseUrl: 'http://127.0.0.1:1',
    models: [{ id: 'mock', name: 'Mock', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10000, maxTokens: 1000 }],
    streamSimple: (model, _context, options) => {
      const cancelled = options?.signal?.aborted
      const index = cancelled ? -1 : turn++
      const tools = !cancelled && index < 2
      const message = {
        role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
        content: tools
          ? ['before', 'context_compact', 'after'].map(name => ({ type: 'toolCall', id: name + index, name, arguments: {} }))
          : [{ type: 'text', text: cancelled ? '' : 'continuation-finished' }],
        stopReason: cancelled ? 'aborted' : tools ? 'toolUse' : 'stop',
        usage: { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      }
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'start', partial: message }
          if (index === 2) await new Promise(resolve => setTimeout(resolve, 31_000))
          yield { type: 'done', reason: message.stopReason, message }
        },
        result: async () => message,
      }
    },
  })
}
`, 'utf8')
  const worker = new Worker(new URL('../workers/pi-session.worker.ts', import.meta.url), {
    execArgv: ['--import', createRequire(import.meta.url).resolve('tsx')],
  })
  const messages: any[] = []
  worker.on('message', message => {
    messages.push(message)
    if (message.type === 'control_request' && message.operation === 'navigate_tree') {
      worker.postMessage({ type: 'control_result', requestId: message.requestId, ok: true, result: {} })
    }
  })
  try {
    worker.postMessage({ type: 'init', payload: {
      key: { conversationId: 'continuation-test', branchId: 'main' }, generation: 1,
      cwd: root, agentDir, sessionDir, tools: [], model: 'continuation-mock/mock', thinkingLevel: 'off',
    } })
    await waitForMessage(worker, message => message.type === 'ready')
    const completed = waitForMessage(worker, message =>
      ['run_complete', 'run_error'].includes(message.type) && message.runId === 'compact-run', 45_000)
    worker.postMessage({ type: 'prompt', payload: {
      runId: 'compact-run', assistantMessageId: 'compact-assistant', prompt: 'Run two compact continuations',
    } })
    assert.equal((await completed).type, 'run_complete')
    const events = messages.filter(message => message.type === 'event').map(message => message.event)
    assert.equal(events.filter(event => event.type === 'tool_result').length, 6,
      JSON.stringify(events.filter(event => ['tool_call', 'tool_result', 'error'].includes(event.type))))
    assert.equal(messages.filter(message => message.type === 'control_request' && message.operation === 'navigate_tree').length, 2)
    assert.ok(!events.some(event => event.type === 'error' || /continuation-failed/.test(event.message || '')))
    assert.ok(!messages.some(message => message.type === 'extension_run_start'))
    const next = waitForMessage(worker, message => ['run_complete', 'run_error'].includes(message.type) && message.runId === 'next')
    worker.postMessage({ type: 'prompt', payload: { runId: 'next', assistantMessageId: 'next-assistant', prompt: 'Next message' } })
    assert.equal((await next).type, 'run_complete')
  } finally {
    await worker.terminate()
    await rm(root, { recursive: true, force: true })
  }
})
