import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { persistFailedPromptIfMissing } from './pi-failed-turn.js'

const failureModel = {
  api: 'openai-responses',
  provider: 'openai',
  id: 'gpt-test',
}

describe('PiService failed-turn fallback', () => {
  it('writes a complete typed user/error turn without changing the session model identity', () => {
    const manager = SessionManager.inMemory(process.cwd())

    persistFailedPromptIfMissing(
      manager,
      null,
      'question',
      'missing credentials',
      failureModel
    )

    const branch = manager.getBranch() as any[]
    assert.equal(branch.length, 2)
    assert.equal(branch[0]?.message.role, 'user')
    assert.equal(branch[1]?.message.role, 'assistant')
    assert.equal(branch[1]?.message.stopReason, 'error')
    assert.equal(branch[1]?.message.errorMessage, 'missing credentials')
    assert.deepEqual(branch[1]?.message.content, [])
    assert.deepEqual(manager.buildSessionContext().model, { provider: 'openai', modelId: 'gpt-test' })

    persistFailedPromptIfMissing(
      manager,
      null,
      'question',
      'missing credentials',
      failureModel
    )
    assert.equal(manager.getBranch().length, 2)
  })

  it('only appends the missing assistant when prompt persistence already wrote the user', () => {
    const manager = SessionManager.inMemory(process.cwd())
    manager.appendMessage({ role: 'user', content: [{ type: 'text', text: 'previous' }], timestamp: 1 } as any)
    manager.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'previous reply' }],
      api: failureModel.api,
      provider: failureModel.provider,
      model: failureModel.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'stop',
      timestamp: 1,
    } as any)
    const initialLeafId = manager.getLeafId()
    manager.appendMessage({ role: 'user', content: [{ type: 'text', text: 'accepted prompt' }], timestamp: 2 } as any)

    persistFailedPromptIfMissing(
      manager,
      initialLeafId,
      'accepted prompt',
      'provider failed',
      failureModel
    )

    const newEntries = manager.getBranch().slice(2) as any[]
    assert.deepEqual(newEntries.map(entry => entry.message.role), ['user', 'assistant'])
    assert.equal(newEntries[1]?.message.errorMessage, 'provider failed')
  })
})
