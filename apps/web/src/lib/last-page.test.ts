import assert from 'node:assert/strict'
import test from 'node:test'
import { createMemoryHistory, createRouter } from 'vue-router'
import { installLastPageRestoration, LAST_PAGE_STORAGE_KEY } from './last-page'

function setup(saved?: string) {
  const records = new Map<string, string>(saved ? [[LAST_PAGE_STORAGE_KEY, saved]] : [])
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'home', component: {} },
      { path: '/files', name: 'files', component: {} },
      { path: '/projects', name: 'projects', component: {} },
      { path: '/projects/:id', name: 'project-workspace', component: {} },
      { path: '/projects/:id/settings', name: 'project-settings', component: {} },
      { path: '/settings', name: 'settings', component: {} },
      { path: '/login', name: 'login', component: {} },
      { path: '/papers', redirect: '/' },
    ],
  })
  installLastPageRestoration(router, {
    getItem: key => records.get(key) ?? null,
    setItem: (key, value) => { records.set(key, value) },
  })
  return { router, records }
}

test('fresh root visits restore the last project without requiring an open file', async () => {
  for (const path of ['/projects/A', '/projects/B', '/files', '/projects', '/projects/A/settings', '/settings?section=appearance']) {
    const { router, records } = setup()
    await router.push(path)
    assert.equal(records.get(LAST_PAGE_STORAGE_KEY), path)
    const nextVisit = setup(records.get(LAST_PAGE_STORAGE_KEY))
    await nextVisit.router.push('/')
    assert.equal(nextVisit.router.currentRoute.value.fullPath, path)
  }
})

test('explicit URLs and in-app home navigation take precedence', async () => {
  for (const path of ['/projects/B', '/files', '/?search=test', '/#section', '/papers']) {
    const { router } = setup('/projects/A')
    await router.push(path)
    assert.equal(router.currentRoute.value.fullPath, path === '/papers' ? '/' : path)
  }
  const { router, records } = setup('/projects/A')
  await router.push('/')
  await router.push('/')
  assert.equal(router.currentRoute.value.name, 'home')
  assert.equal(records.get(LAST_PAGE_STORAGE_KEY), '/')
})

test('login keeps the restored destination and does not overwrite it', async () => {
  const { router, records } = setup('/projects/A')
  let loggedIn = false
  router.beforeEach(to => {
    if (!loggedIn && to.name !== 'login') return { name: 'login', query: { next: to.fullPath } }
  })
  await router.push('/')
  assert.equal(router.currentRoute.value.name, 'login')
  assert.equal(router.currentRoute.value.query.next, '/projects/A')
  assert.equal(records.get(LAST_PAGE_STORAGE_KEY), '/projects/A')
  loggedIn = true
  await router.push(String(router.currentRoute.value.query.next))
  assert.equal(router.currentRoute.value.fullPath, '/projects/A')
})

test('missing, external and non-restorable records fall back to home', async () => {
  for (const saved of [undefined, '/', 'broken', 'https://example.com', '//example.com', '/login']) {
    const { router } = setup(saved)
    await router.push('/')
    assert.equal(router.currentRoute.value.name, 'home')
  }
})

test('failed navigation does not overwrite the last successful page', async () => {
  const { router, records } = setup('/projects/A')
  await router.push('/')
  router.beforeEach(to => to.name === 'files' ? false : undefined)
  await router.push('/files')
  assert.equal(records.get(LAST_PAGE_STORAGE_KEY), '/projects/A')
})

test('storage errors do not prevent navigation', async () => {
  const { router } = setup()
  installLastPageRestoration(router, {
    getItem: () => { throw new Error('storage unavailable') },
    setItem: () => { throw new Error('storage unavailable') },
  })
  await router.push('/')
  await router.push('/projects/A')
  assert.equal(router.currentRoute.value.fullPath, '/projects/A')
})
