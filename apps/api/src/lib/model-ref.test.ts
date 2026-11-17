import assert from 'node:assert/strict'
import test from 'node:test'
import { findModelByRef, modelRefOf, resolveModelRef, sameModel, toModelRef } from './model-ref.js'

const models = [
  { provider: 'alpha', id: 'gpt-4o' },
  { provider: 'beta', id: 'gpt-4o' },
  { provider: 'openrouter', id: 'anthropic/claude-sonnet' },
]

const runtime = {
  getModel: (provider: string, id: string) => models.find(model => model.provider === provider && model.id === id),
  getAvailable: async () => models,
}

test('canonical refs distinguish same-id models of different providers', async () => {
  assert.equal(toModelRef(models[1]), 'beta/gpt-4o')
  assert.equal(findModelByRef(models, 'beta/gpt-4o'), models[1])
  assert.equal(await resolveModelRef(runtime, 'alpha/gpt-4o'), models[0])
  assert.equal(await resolveModelRef(runtime, 'beta/gpt-4o'), models[1])
  assert.equal(sameModel(models[0], models[1]), false)
  assert.equal(sameModel(models[1], { provider: 'beta', id: 'gpt-4o' }), true)
})

test('model ids containing a slash split on the first slash only', async () => {
  assert.equal(await resolveModelRef(runtime, 'openrouter/anthropic/claude-sonnet'), models[2])
})

test('legacy bare ids still resolve to the first matching model', async () => {
  assert.equal(await resolveModelRef(runtime, 'gpt-4o'), models[0])
  assert.equal(await resolveModelRef(runtime, 'missing/model'), undefined)
  assert.equal(await resolveModelRef(runtime, undefined), undefined)
})

test('modelRefOf falls back to the bare id when the provider is unknown', () => {
  assert.equal(modelRefOf({ provider: 'beta', id: 'gpt-4o' }), 'beta/gpt-4o')
  assert.equal(modelRefOf({ id: 'gpt-4o' }), 'gpt-4o')
  assert.equal(modelRefOf(undefined), undefined)
})
