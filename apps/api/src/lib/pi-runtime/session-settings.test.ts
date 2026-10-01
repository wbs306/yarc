import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createSessionSettings } from './session-settings.js'

test('YARC disables cache warming in memory without changing shared settings', async t => {
  const root = await mkdtemp(join(tmpdir(), 'yarc-pi-settings-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const agentDir = join(root, 'agent')
  await mkdir(agentDir)
  const path = join(agentDir, 'settings.json')
  const content = JSON.stringify({ cacheWarming: 'idle', defaultModel: 'mock-model' }) + '\n'
  await writeFile(path, content)

  const settings = createSessionSettings(root, agentDir)
  assert.equal(settings.getCacheWarmingMode(), 'off')
  assert.equal(settings.getDefaultModel(), 'mock-model')
  await settings.reload()
  assert.equal(settings.getCacheWarmingMode(), 'off')
  assert.equal(await readFile(path, 'utf8'), content)
})
