import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentInteractionRequest, AgentInteractionResolved } from '@yarc/shared'
import { agentInteractionRegistry } from '../agent-interaction-registry.js'

const input = (streamMessageId: string) => ({
  conversationId: 'test-conversation',
  branchId: 'main',
  streamMessageId,
  kind: 'questionnaire' as const,
  payload: { questions: [] },
})

test('questionnaires remain pending beyond five minutes and accept an answer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let request!: AgentInteractionRequest
  const promise = agentInteractionRegistry.create({
    ...input('questionnaire-no-timeout'),
    emitRequest: event => { request = event },
  })
  try {
    assert.equal(request.timeoutMs, 0)
    assert.equal(agentInteractionRegistry.get(request.requestId)?.timeout, undefined)
    t.mock.timers.tick(30 * 60 * 1000)
    assert.ok(agentInteractionRegistry.get(request.requestId))
    agentInteractionRegistry.respond(request.requestId, { requestId: request.requestId, action: 'submit', value: 'answer' })
    assert.equal((await promise).action, 'submit')
    assert.equal(agentInteractionRegistry.get(request.requestId), undefined)
  } finally {
    agentInteractionRegistry.cancelByStream('questionnaire-no-timeout')
  }
})

test('other interactions retain their default five-minute timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let request!: AgentInteractionRequest
  const promise = agentInteractionRegistry.create({
    ...input('confirm-default-timeout'),
    kind: 'confirm',
    emitRequest: event => { request = event },
  })
  try {
    assert.equal(request.timeoutMs, 5 * 60 * 1000)
    t.mock.timers.tick(5 * 60 * 1000)
    assert.deepEqual(await promise, { requestId: request.requestId, action: 'cancel', value: { reason: 'timeout' } })
    assert.equal(agentInteractionRegistry.get(request.requestId), undefined)
  } finally {
    agentInteractionRegistry.cancelByStream('confirm-default-timeout')
  }
})

test('explicit questionnaire timeouts are still respected', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let request!: AgentInteractionRequest
  const promise = agentInteractionRegistry.create({
    ...input('questionnaire-explicit-timeout'),
    timeoutMs: 1000,
    emitRequest: event => { request = event },
  })
  try {
    t.mock.timers.tick(1000)
    assert.deepEqual(await promise, { requestId: request.requestId, action: 'cancel', value: { reason: 'timeout' } })
  } finally {
    agentInteractionRegistry.cancelByStream('questionnaire-explicit-timeout')
  }
})

test('stopping a stream still cancels a questionnaire without a timeout', async () => {
  let request!: AgentInteractionRequest
  let resolved: AgentInteractionResolved | undefined
  const promise = agentInteractionRegistry.create({
    ...input('questionnaire-stopped-stream'),
    emitRequest: event => { request = event },
    emitResolved: event => { resolved = event },
  })
  try {
    agentInteractionRegistry.cancelByStream('questionnaire-stopped-stream', 'tool_aborted')
    assert.deepEqual(await promise, { requestId: request.requestId, action: 'cancel', value: { reason: 'tool_aborted' } })
    assert.equal(resolved?.reason, 'tool_aborted')
    assert.equal(agentInteractionRegistry.get(request.requestId), undefined)
  } finally {
    agentInteractionRegistry.cancelByStream('questionnaire-stopped-stream')
  }
})
