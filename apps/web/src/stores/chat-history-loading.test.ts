import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { createPinia } from 'pinia'
import { useChatStore } from './chat'

const json = (body: unknown) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
})
const deferredResponse = () => {
  let resolve!: (response: Response) => void
  const promise = new Promise<Response>(done => { resolve = done })
  return { promise, resolve }
}
const setupBrowser = (preferences: Record<string, string>, branches: Record<string, string> = {}) => {
  const storage = new Map([
    ['yarc-current-conversations', JSON.stringify(preferences)],
    ['yarc-conv-branches', JSON.stringify(branches)],
  ])
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
  })
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: Object.assign(new EventTarget(), { setTimeout, clearTimeout }),
  })
}
const conversation = (id: string, projectId: string | null = null) => ({
  id, projectId, paperId: null, title: id, model: null, createdAt: '', updatedAt: '',
})
const mainBranch = { id: 'main', branchName: 'main', parentBranchId: null, forkMessageId: null }
const history = (id: string) => ({ messages: [{ id, role: 'user', content: id }] })
const auxiliaryResponse = (url: string): Response => {
  if (url.endsWith('/model-settings')) return json({ model: null, modelSettings: null })
  if (url.includes('/context-usage?')) return json({ contextUsage: null })
  if (url.includes('/agent-interactions/runtime/')) return json({ runtime: { state: 'idle', commands: [], surfaces: [], uiEvents: [] } })
  if (url.endsWith('/streaming-message')) return json({ message: null })
  throw new Error(`Unexpected request: ${url}`)
}

test('refresh preloads saved history alongside the list but displays it only after scope validation', async t => {
  setupBrowser({ 'project-a': 'saved' }, { saved: 'edit-a' })
  const list = deferredResponse()
  const calls: string[] = []
  t.mock.method(globalThis, 'fetch', async input => {
    const url = String(input)
    calls.push(url)
    if (url === '/api/conversations?projectId=project-a') return list.promise
    if (url.endsWith('/saved/branches')) return json({ branches: [mainBranch, { ...mainBranch, id: 'edit-a', branchName: 'edit-a' }] })
    if (url.endsWith('/saved/switch-branch/edit-a')) return json(history('saved-history'))
    return auxiliaryResponse(url)
  })
  const store = useChatStore(createPinia())
  const loading = store.setConversationScope('project-a')
  try {
    await setImmediate()
    assert.ok(calls.some(url => url.endsWith('/saved/branches')))
    assert.ok(calls.some(url => url.endsWith('/saved/switch-branch/edit-a')))
    assert.deepEqual(store.messages, [])
    assert.equal(store.currentConvId, null)
  } finally {
    list.resolve(json({ conversations: [conversation('saved', 'project-a')] }))
    await loading
  }
  assert.equal(store.currentConvId, 'saved')
  assert.equal(store.currentBranchId, 'edit-a')
  assert.equal(store.messages[0]?.id, 'saved-history')
  assert.equal(calls.filter(url => url.endsWith('/saved/switch-branch/edit-a')).length, 1)
})

test('selecting a conversation fetches its expected history before the branch list returns', async t => {
  setupBrowser({})
  const branches = deferredResponse()
  const calls: string[] = []
  t.mock.method(globalThis, 'fetch', async input => {
    const url = String(input)
    calls.push(url)
    if (url.endsWith('/selected/branches')) return branches.promise
    if (url.endsWith('/selected/switch-branch/main')) return json(history('ready'))
    return auxiliaryResponse(url)
  })
  const store = useChatStore(createPinia())
  const loading = store.selectConversation('selected')
  try {
    await setImmediate()
    assert.ok(calls.some(url => url.endsWith('/selected/switch-branch/main')))
    assert.deepEqual(store.messages, [])
  } finally {
    branches.resolve(json({ branches: [mainBranch] }))
    await loading
  }
  assert.equal(store.messages[0]?.id, 'ready')
})

test('a deleted saved branch falls back to the server main branch without displaying speculative content', async t => {
  setupBrowser({ __global__: 'saved' }, { saved: 'deleted' })
  t.mock.method(globalThis, 'fetch', async input => {
    const url = String(input)
    if (url === '/api/conversations?projectId=') return json({ conversations: [conversation('saved')] })
    if (url.endsWith('/saved/branches')) return json({ branches: [mainBranch] })
    if (url.endsWith('/switch-branch/deleted')) return json(history('must-not-display'))
    if (url.endsWith('/switch-branch/main')) return json(history('main-history'))
    return auxiliaryResponse(url)
  })
  const store = useChatStore(createPinia())
  await store.setConversationScope(null)
  assert.equal(store.currentBranchId, 'main')
  assert.deepEqual(store.messages.map(message => message.id), ['main-history'])
})

test('late preloads for a removed preferred conversation never replace the selected conversation', async t => {
  setupBrowser({ __global__: 'removed' })
  const oldBranches = deferredResponse()
  const oldHistory = deferredResponse()
  t.mock.method(globalThis, 'fetch', async input => {
    const url = String(input)
    if (url === '/api/conversations?projectId=') return json({ conversations: [conversation('valid')] })
    if (url.endsWith('/removed/branches')) return oldBranches.promise
    if (url.endsWith('/removed/switch-branch/main')) return oldHistory.promise
    if (url.endsWith('/valid/branches')) return json({ branches: [mainBranch] })
    if (url.endsWith('/valid/switch-branch/main')) return json(history('valid-history'))
    return auxiliaryResponse(url)
  })
  const store = useChatStore(createPinia())
  try {
    await store.setConversationScope(null)
    assert.equal(store.currentConvId, 'valid')
  } finally {
    oldBranches.resolve(json({ branches: [mainBranch] }))
    oldHistory.resolve(json(history('removed-history')))
    await setImmediate()
  }
  assert.deepEqual(store.messages.map(message => message.id), ['valid-history'])
})

test('rapid workspace switching ignores late list and history preloads from the previous scope', async t => {
  setupBrowser({ 'project-a': 'a', 'project-b': 'b' })
  const oldList = deferredResponse()
  const oldHistory = deferredResponse()
  t.mock.method(globalThis, 'fetch', async input => {
    const url = String(input)
    if (url === '/api/conversations?projectId=project-a') return oldList.promise
    if (url === '/api/conversations?projectId=project-b') return json({ conversations: [conversation('b', 'project-b')] })
    if (url.endsWith('/branches')) return json({ branches: [mainBranch] })
    if (url.endsWith('/a/switch-branch/main')) return oldHistory.promise
    if (url.endsWith('/b/switch-branch/main')) return json(history('b-history'))
    return auxiliaryResponse(url)
  })
  const store = useChatStore(createPinia())
  const first = store.setConversationScope('project-a')
  try {
    await store.setConversationScope('project-b')
    assert.equal(store.currentConvId, 'b')
  } finally {
    oldList.resolve(json({ conversations: [conversation('a', 'project-a')] }))
    oldHistory.resolve(json(history('a-history')))
    await first
    await setImmediate()
  }
  assert.equal(store.conversationScope, 'project-b')
  assert.deepEqual(store.messages.map(message => message.id), ['b-history'])
})

test('reselecting the active conversation keeps its latest cached stream instead of replacing it with a preload', async t => {
  setupBrowser({})
  let historyRequests = 0
  t.mock.method(globalThis, 'fetch', async input => {
    const url = String(input)
    if (url.endsWith('/branches')) return json({ branches: [mainBranch] })
    if (url.endsWith('/switch-branch/main')) {
      historyRequests++
      return json(history('original'))
    }
    return auxiliaryResponse(url)
  })
  const store = useChatStore(createPinia())
  await store.selectConversation('active')
  const cached = store.branchCache.get('main')!
  cached[0].content = 'latest live content'
  await store.selectConversation('active')
  assert.equal(historyRequests, 1)
  assert.equal(store.messages[0]?.content, 'latest live content')
})

test('a failed speculative history request retries through the validated branch loader', async t => {
  setupBrowser({ __global__: 'saved' })
  let historyRequests = 0
  t.mock.method(globalThis, 'fetch', async input => {
    const url = String(input)
    if (url === '/api/conversations?projectId=') return json({ conversations: [conversation('saved')] })
    if (url.endsWith('/branches')) return json({ branches: [mainBranch] })
    if (url.endsWith('/switch-branch/main')) {
      if (++historyRequests === 1) throw new Error('temporary failure')
      return json(history('retried'))
    }
    return auxiliaryResponse(url)
  })
  const store = useChatStore(createPinia())
  await store.setConversationScope(null)
  assert.equal(historyRequests, 2)
  assert.equal(store.messages[0]?.id, 'retried')
})
