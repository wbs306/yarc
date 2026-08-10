import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { isDefaultIgnoredDataPath } from '../lib/data-sync-policy.js'
import { DataChangeWatcher, type DataChangeEvent } from './data-change-watcher.js'

const waitFor = async (predicate: () => boolean, timeoutMs = 7_000) => {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started >= timeoutMs) throw new Error('Timed out waiting for data change event')
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

describe('data sync path policy', () => {
  it('watches useful .pi configuration while excluding generated and sensitive paths', () => {
    assert.equal(isDefaultIgnoredDataPath('.pi/agent/settings.json'), false)
    assert.equal(isDefaultIgnoredDataPath('.pi/agent/agents/reviewer.md'), false)
    assert.equal(isDefaultIgnoredDataPath('.pi/agent/sessions/run.jsonl'), true)
    assert.equal(isDefaultIgnoredDataPath('.pi/agent/subagent-results/result.json'), true)
    assert.equal(isDefaultIgnoredDataPath('.pi/agent/auth.json'), true)
    assert.equal(isDefaultIgnoredDataPath('.pi/agent/models.json'), true)
    assert.equal(isDefaultIgnoredDataPath('.pi/agent/npm/node_modules/pkg/index.js'), true)
    assert.equal(isDefaultIgnoredDataPath('works/demo/.venv/bin/python'), true)
    assert.equal(isDefaultIgnoredDataPath('works/demo/.cache/index.json'), true)
    assert.equal(isDefaultIgnoredDataPath('works/demo/src/index.ts'), false)
  })
})

describe('DataChangeWatcher', () => {
  it('publishes explicit changes but ignores protected paths', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'yarc-data-watcher-'))
    const watcher = new DataChangeWatcher(directory)
    const events: DataChangeEvent[] = []
    watcher.subscribe(event => { events.push(event) })

    try {
      await mkdir(join(directory, 'works'), { recursive: true })
      await writeFile(join(directory, 'works', 'note.md'), 'hello')
      await watcher.publish({ path: 'works/note.md', source: 'file-service' })
      await watcher.publish({ path: '.pi/agent/sessions/run.jsonl', source: 'file-service' })
      await waitFor(() => events.length === 1)

      assert.equal(events.length, 1)
      assert.equal(events[0]?.path, 'works/note.md')
      assert.equal(events[0]?.source, 'file-service')
      assert.match(events[0]?.signature || '', /^file:/)
    } finally {
      watcher.stop()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('detects external filesystem changes through the shared watcher', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'yarc-data-watcher-'))
    const watcher = new DataChangeWatcher(directory)
    const events: DataChangeEvent[] = []
    watcher.subscribe(event => { events.push(event) })

    try {
      await watcher.start()
      await mkdir(join(directory, 'works'), { recursive: true })
      await writeFile(join(directory, 'works', 'external.md'), 'changed')
      await waitFor(() => events.some(event => event.source === 'filesystem' && event.path === 'works/external.md'))
    } finally {
      watcher.stop()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('suppresses the filesystem echo of a WebDAV write but observes a later user edit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'yarc-data-watcher-'))
    const watcher = new DataChangeWatcher(directory)
    const events: DataChangeEvent[] = []
    watcher.subscribe(event => { events.push(event) })

    try {
      await mkdir(join(directory, 'works'), { recursive: true })
      await watcher.start()
      await writeFile(join(directory, 'works', 'synced.md'), 'remote version')
      await watcher.publish({ path: 'works/synced.md', source: 'webdav' })
      await waitFor(() => events.some(event => event.source === 'webdav'))
      await new Promise(resolve => setTimeout(resolve, 250))
      assert.equal(events.some(event => event.source === 'filesystem' && event.path === 'works/synced.md'), false)

      await writeFile(join(directory, 'works', 'synced.md'), 'user edit after download')
      await waitFor(() => events.some(event => event.source === 'filesystem' && event.path === 'works/synced.md'))
    } finally {
      watcher.stop()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
