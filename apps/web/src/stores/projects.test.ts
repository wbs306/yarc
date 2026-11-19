import assert from 'node:assert/strict'
import test from 'node:test'
import { createPinia } from 'pinia'
import { fetchActiveProjects, useProjectsStore } from './projects'

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })

test('concurrent active-project reads share a request without reusing stale results', async t => {
  let complete!: (response: Response) => void
  const response = new Promise<Response>(resolve => { complete = resolve })
  let refreshed = false
  const fetch = t.mock.method(globalThis, 'fetch', async () => refreshed
    ? json({ projects: [{ id: 'new-project', archivedAt: null }] })
    : response)
  const store = useProjectsStore(createPinia())
  const list = store.fetchProjects()
  const picker = fetchActiveProjects()
  assert.equal(fetch.mock.callCount(), 1)
  complete(json({ projects: [{ id: 'active', archivedAt: null }] }))
  const [listed, picked] = await Promise.all([list, picker])
  assert.deepEqual(listed, picked.projects)
  refreshed = true
  assert.equal((await fetchActiveProjects()).projects[0]?.id, 'new-project')
  assert.equal(fetch.mock.callCount(), 2)
})

test('an active scope-picker read never replaces the archived projects view', async t => {
  t.mock.method(globalThis, 'fetch', async input => json({ projects: String(input).includes('archived=true')
    ? [{ id: 'archived', archivedAt: '2026-01-01' }]
    : [{ id: 'active', archivedAt: null }] }))
  const store = useProjectsStore(createPinia())
  await store.fetchProjects(true)
  const picker = await fetchActiveProjects()
  assert.equal(picker.projects[0]?.id, 'active')
  assert.equal(store.projects[0]?.id, 'archived')
})

test('failed active-project requests can be retried', async t => {
  let fail = true
  const fetch = t.mock.method(globalThis, 'fetch', async () => {
    if (fail) throw new Error('offline')
    return json({ projects: [] })
  })
  await assert.rejects(fetchActiveProjects(), /offline/)
  fail = false
  assert.deepEqual(await fetchActiveProjects(), { projects: [] })
  assert.equal(fetch.mock.callCount(), 2)
})
