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
