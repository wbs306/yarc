import assert from 'node:assert/strict'
import test from 'node:test'
import { buildModelLabels, formatModelLabel } from './model-label'

test('unique model names get no provider tag', () => {
  const labels = buildModelLabels([
    { id: 'alpha/one', name: 'One', provider: 'alpha', model: 'one' },
    { id: 'beta/two', name: 'Two', provider: 'beta', model: 'two' },
  ])
  assert.deepEqual(labels.get('alpha/one'), { name: 'One', tag: '' })
  assert.equal(formatModelLabel(labels.get('beta/two')!), 'Two')
})

test('same model name from different providers is tagged with the provider', () => {
  const labels = buildModelLabels([
    { id: 'alpha/gpt-4o', name: 'GPT-4o', provider: 'alpha', model: 'gpt-4o' },
    { id: 'beta/gpt-4o', name: 'gpt-4o', provider: 'beta', model: 'gpt-4o' },
  ])
  assert.deepEqual(labels.get('alpha/gpt-4o'), { name: 'GPT-4o', tag: 'alpha' })
  assert.equal(formatModelLabel(labels.get('beta/gpt-4o')!), 'gpt-4o (beta)')
})

test('same name within one provider falls back to the full model reference', () => {
  const labels = buildModelLabels([
    { id: 'alpha/a', name: 'Same', provider: 'alpha', model: 'a' },
    { id: 'alpha/b', name: 'Same', provider: 'alpha', model: 'b' },
    { id: 'beta/c', name: 'Same', provider: 'beta', model: 'c' },
  ])
  assert.equal(labels.get('alpha/a')?.tag, 'alpha/a')
  assert.equal(labels.get('alpha/b')?.tag, 'alpha/b')
  assert.equal(labels.get('beta/c')?.tag, 'beta/c')
})
