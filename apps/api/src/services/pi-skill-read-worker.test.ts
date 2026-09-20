import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import test from 'node:test'
import type { RuntimeWorkerMessage } from '../lib/pi-runtime/protocol.js'

function waitFor(worker: Worker, predicate: (message: RuntimeWorkerMessage) => boolean) {
  return new Promise<RuntimeWorkerMessage>((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); worker.off('message', onMessage); worker.off('error', onError) }
    const onMessage = (message: RuntimeWorkerMessage) => { if (predicate(message)) { cleanup(); resolve(message) } }
    const onError = (error: Error) => { cleanup(); reject(error) }
    const timer = setTimeout(() => { cleanup(); reject(new Error('Worker timed out')) }, 15_000)
    worker.on('message', onMessage)
    worker.on('error', onError)
  })
}

test('Worker sends loader-owned skill paths only for read, refreshed after reload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yarc-skill-worker-'))
  const cwd = join(root, 'projects/A')
  const agentDir = join(root, '.pi/agent')
  const sessionDir = join(agentDir, 'sessions')
  const extensionsDir = join(agentDir, 'extensions')
  await mkdir(cwd, { recursive: true })
  await mkdir(sessionDir, { recursive: true })
  await mkdir(extensionsDir)
  const createSkill = async (name: string) => {
    const dir = join(agentDir, 'skills', name)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: Test resource\n---\nTest skill\n`)
    return join(dir, 'SKILL.md')
  }
  const skill = await createSkill('demo')
  // In-memory provider: no model API, real user data or credentials required.
  await writeFile(join(extensionsDir, 'mock.js'), `
export default function (pi) {
  pi.registerProvider('skill-mock', {
    api: 'skill-mock-api', apiKey: 'test-only', baseUrl: 'http://127.0.0.1:1',
    models: [{ id: 'mock', name: 'Mock', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10000, maxTokens: 1000 }],
    streamSimple: (model, context) => {
      const start = context.messages.findLastIndex(message => message.role === 'user')
      const turn = context.messages.slice(start + 1).filter(message => message.role === 'toolResult').length
      const message = {
        role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
        content: turn < 2 ? [{ type: 'toolCall', id: 'mock-' + start + '-' + turn,
          name: turn === 0 ? 'read' : 'write', arguments: { path: 'fixture.md', skillFiles: ['/untrusted/SKILL.md'] } }]
          : [{ type: 'text', text: 'done' }],
        stopReason: turn < 2 ? 'toolUse' : 'stop',
        usage: { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      }
      return {
        async *[Symbol.asyncIterator]() { yield { type: 'start', partial: message }; yield { type: 'done', reason: message.stopReason, message } },
        result: async () => message,
      }
    },
  })
}
`)
  const worker = new Worker(new URL('../workers/pi-session.worker.ts', import.meta.url), {
    execArgv: ['--import', createRequire(import.meta.url).resolve('tsx')],
  })
  const requests: Extract<RuntimeWorkerMessage, { type: 'tool_request' }>[] = []
  worker.on('message', (message: RuntimeWorkerMessage) => {
    if (message.type !== 'tool_request') return
    requests.push(message)
    worker.postMessage({ type: 'tool_result', requestId: message.requestId, ok: true,
      result: { content: [{ type: 'text', text: 'fixture result' }], details: {} } })
  })
  try {
    const ready = waitFor(worker, message => message.type === 'ready')
    worker.postMessage({ type: 'init', payload: {
      key: { conversationId: 'skill-test', branchId: 'main' }, generation: 1,
      cwd, agentDir, sessionDir, model: 'skill-mock/mock', thinkingLevel: 'off',
      tools: ['read', 'write'].map(name => ({ name, label: name, description: name,
        parameters: { type: 'object', properties: { path: { type: 'string' }, skillFiles: { type: 'array', items: { type: 'string' } } }, required: ['path'] } })),
    } })
    await ready
    const expected = [skill]
    for (const generation of [1, 2]) {
      if (generation === 2) {
        expected.push(await createSkill('added'))
        const reloaded = waitFor(worker, message => message.type === 'ready' && message.generation === generation)
        worker.postMessage({ type: 'reload', generation, reason: 'test' })
        await reloaded
      }
      const done = waitFor(worker, message => message.type === 'run_complete' || message.type === 'run_error')
      worker.postMessage({ type: 'prompt', payload: { runId: `run-${generation}`, prompt: 'Exercise tools', assistantMessageId: `assistant-${generation}` } })
      assert.equal((await done).type, 'run_complete')
      const current = requests.filter(request => request.runId === `run-${generation}`)
      assert.equal(current.length, 2)
      assert.deepEqual(current[0].skillFiles?.slice().sort(), expected.slice().sort())
      assert.equal(current[1].skillFiles, undefined)
      assert.ok(!current[0].skillFiles?.includes('/untrusted/SKILL.md'))
    }
  } finally {
    await worker.terminate()
    await rm(root, { recursive: true, force: true })
  }
})
