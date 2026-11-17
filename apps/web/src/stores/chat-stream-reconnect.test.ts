import assert from 'node:assert/strict'
import test from 'node:test'
import { createPinia } from 'pinia'
import { useChatStore } from './chat'

class MockWebSocket {
  static instances: MockWebSocket[] = []

  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  sent: string[] = []

  constructor(readonly url: string) {
    MockWebSocket.instances.push(this)
  }

  send(data: string) {
    this.sent.push(data)
  }

  close() {}

  open() {
    this.onopen?.()
  }
}

const json = (body: unknown) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
})

const setupBrowser = () => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  })
  const events = new EventTarget() as EventTarget & {
    setTimeout: typeof setTimeout
    clearTimeout: typeof clearTimeout
    location: { pathname: string }
  }
  events.setTimeout = setTimeout
  events.clearTimeout = clearTimeout
  events.location = { pathname: '/' }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: events })
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { protocol: 'http:', host: 'localhost:3000' },
  })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } })
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: MockWebSocket })
}

test('reconnect hydrates buffered text immediately and subscribes after the replay cursor', async t => {
  setupBrowser()
  MockWebSocket.instances = []

  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = String(input)
    if (url === '/api/conversations/conversation-a/branches') {
      return json({ branches: [{ id: 'branch-a', branchName: 'main', parentBranchId: null, forkMessageId: null }] })
    }
    if (url === '/api/conversations/conversation-a/switch-branch/branch-a') return json({ messages: [] })
    if (url === '/api/conversations/conversation-a/context-usage?branchId=branch-a') return json({ contextUsage: null })
    if (url === '/api/agent-interactions/runtime/conversation-a?branchId=branch-a') {
      return json({ runtime: { commands: [], state: 'running', surfaces: [], uiEvents: [] } })
    }
    if (url === '/api/conversations/conversation-a/streaming-message') {
      return json({
        message: {
          id: 'stream-a',
          conversationId: 'conversation-a',
          branchId: 'branch-a',
          role: 'assistant',
          content: '',
          toolCalls: null,
          metadata: { pending: true },
          createdAt: '2026-01-01T00:00:00.000Z',
        },
        events: [
          { type: 'assistant_message_start', messageId: 'stream-a', runGroupId: 'run-a', eventSequence: 1 },
          { type: 'text', content: '12', assistantMessageId: 'stream-a', eventSequence: 2 },
          { type: 'text', content: '345', assistantMessageId: 'stream-a', eventSequence: 3 },
        ],
      })
    }
    throw new Error(`Unexpected API call: ${url}`)
  })

  const store = useChatStore(createPinia())
  await store.selectConversation('conversation-a')

  const assistant = store.messages.find(message => message.id === 'stream-a')
  assert.equal(assistant?.content, '12345')
  assert.equal(store.streamingContent, '12345')
  assert.equal(store.isStreaming, true)

  const socket = MockWebSocket.instances[0]
  assert.ok(socket)
  socket.open()
  assert.deepEqual(JSON.parse(socket.sent[0]), {
    type: 'attach',
    messageId: 'stream-a',
    afterSequence: 3,
  })
})

test('reconnect keeps tool execution on the assistant entry mapped before the tool ran', async t => {
  setupBrowser()
  MockWebSocket.instances = []

  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = String(input)
    if (url === '/api/conversations/conversation-a/branches') {
      return json({ branches: [{ id: 'branch-a', branchName: 'main', parentBranchId: null, forkMessageId: null }] })
    }
    if (url === '/api/conversations/conversation-a/switch-branch/branch-a') return json({ messages: [] })
    if (url === '/api/conversations/conversation-a/context-usage?branchId=branch-a') return json({ contextUsage: null })
    if (url === '/api/agent-interactions/runtime/conversation-a?branchId=branch-a') {
      return json({ runtime: { commands: [], state: 'running', surfaces: [], uiEvents: [] } })
    }
    if (url === '/api/conversations/conversation-a/streaming-message') {
      return json({
        message: {
          id: 'stream-a',
          conversationId: 'conversation-a',
          branchId: 'branch-a',
          role: 'assistant',
          content: '',
          toolCalls: null,
          metadata: { pending: true },
          createdAt: '2026-01-01T00:00:00.000Z',
        },
        events: [
          { type: 'assistant_message_start', messageId: 'stream-a', runGroupId: 'run-a', eventSequence: 1 },
          { type: 'tool_call_delta', toolCallId: 'call-1', toolName: 'bash', inputDelta: '{"command":"ls"}', assistantMessageId: 'stream-a', eventSequence: 2 },
          { type: 'pi_assistant_entry', conversationId: 'conversation-a', messageId: 'stream-a', entryId: 'entry-a', sessionFile: 'session.jsonl', eventSequence: 3 },
          { type: 'tool_call', toolCallId: 'call-1', toolName: 'bash', input: '{"command":"ls"}', assistantMessageId: 'stream-a', eventSequence: 4 },
        ],
      })
    }
    throw new Error(`Unexpected API call: ${url}`)
  })

  const store = useChatStore(createPinia())
  await store.selectConversation('conversation-a')

  const socket = MockWebSocket.instances[0]
  assert.ok(socket)
  socket.open()
  socket.onmessage?.({ data: JSON.stringify({ type: 'tool_result', toolCallId: 'call-1', result: 'ok', assistantMessageId: 'stream-a', eventSequence: 5 }) })

  const assistants = store.messages.filter(message => message.role === 'assistant')
  assert.deepEqual(assistants.map(message => message.id), ['entry-a'])
  const toolCalls = assistants[0]?.toolCalls || []
  assert.equal(toolCalls.length, 1)
  assert.equal(toolCalls[0].result, 'ok')
  assert.equal(toolCalls[0].inputText, undefined)
  assert.equal(assistants[0]?.metadata.segments?.filter(segment => segment.type === 'tool').length, 1)
})

test('reconnect replay skips old notifications but live notifications still show', async t => {
  setupBrowser()
  MockWebSocket.instances = []

  const notification = (requestId: string, sequence: number) => ({
    type: 'agent_interaction_request', requestId, kind: 'notification', title: 'Agent 通知', message: requestId,
    payload: { message: requestId, notifyType: 'info' }, conversationId: 'conversation-a', branchId: 'branch-a',
    streamMessageId: 'stream-a', createdAt: '2026-01-01T00:00:00.000Z', assistantMessageId: 'stream-a', eventSequence: sequence,
  })

  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = String(input)
    if (url === '/api/conversations/conversation-a/branches') {
      return json({ branches: [{ id: 'branch-a', branchName: 'main', parentBranchId: null, forkMessageId: null }] })
    }
    if (url === '/api/conversations/conversation-a/switch-branch/branch-a') return json({ messages: [] })
    if (url === '/api/conversations/conversation-a/context-usage?branchId=branch-a') return json({ contextUsage: null })
    if (url === '/api/agent-interactions/runtime/conversation-a?branchId=branch-a') {
      return json({ runtime: { commands: [], state: 'running', surfaces: [], uiEvents: [] } })
    }
    if (url === '/api/conversations/conversation-a/streaming-message') {
      return json({
        message: {
          id: 'stream-a', conversationId: 'conversation-a', branchId: 'branch-a', role: 'assistant',
          content: '', toolCalls: null, metadata: { pending: true }, createdAt: '2026-01-01T00:00:00.000Z',
        },
        events: [
          { type: 'assistant_message_start', messageId: 'stream-a', runGroupId: 'run-a', eventSequence: 1 },
          notification('old-compaction-1', 2),
          notification('old-compaction-2', 3),
        ],
      })
    }
    throw new Error(`Unexpected API call: ${url}`)
  })

  const store = useChatStore(createPinia())
  await store.selectConversation('conversation-a')
  assert.deepEqual(store.notificationInteractions.map(item => item.requestId), [])

  const socket = MockWebSocket.instances[0]
  assert.ok(socket)
  socket.open()
  socket.onmessage?.({ data: JSON.stringify(notification('live-notice', 4)) })
  assert.deepEqual(store.notificationInteractions.map(item => item.requestId), ['live-notice'])
  store.dismissInteraction('live-notice')
})

test('switching conversations restores their model and reasoning preferences across reloads', async t => {
  setupBrowser()
  const storage = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
  })
  const server = new Map<string, { model: string; reasoningEffort: string }>([
    ['a', { model: 'provider/a', reasoningEffort: 'medium' }],
    ['b', { model: 'provider/b', reasoningEffort: 'medium' }],
  ])
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const url = String(input)
    const settingsMatch = url.match(/\/conversations\/([^/]+)\/model-settings$/)
    if (settingsMatch) {
      const id = settingsMatch[1]
      if (init?.method === 'PUT') server.set(id, JSON.parse(String(init.body)))
      const settings = server.get(id)!
      return json({ model: settings.model, modelSettings: settings })
    }
    if (url.endsWith('/branches')) return json({ branches: [{ id: 'main', branchName: 'main', parentBranchId: null, forkMessageId: null, thinkingLevel: 'medium' }] })
    if (url.includes('/switch-branch/')) return json({ messages: [] })
    if (url.includes('/context-usage?')) return json({ contextUsage: null })
    if (url.includes('/agent-interactions/runtime/')) return json({ runtime: { commands: [], state: 'idle', surfaces: [], uiEvents: [] } })
    if (url.endsWith('/streaming-message')) return json({ message: null })
    throw new Error(`Unexpected API call: ${url}`)
  })
  const conversations = [
    { id: 'a', paperId: null, projectId: null, title: 'A', model: 'provider/a', createdAt: '', updatedAt: '' },
    { id: 'b', paperId: null, projectId: null, title: 'B', model: 'provider/b', createdAt: '', updatedAt: '' },
  ]
  const store = useChatStore(createPinia())
  store.conversations = conversations
  await store.selectConversation('a')
  assert.equal(store.currentModel, 'provider/a')
  assert.equal(store.reasoningEffort, 'medium')
  store.setReasoningEffort('high')
  await store.selectConversation('b')
  assert.equal(store.currentModel, 'provider/b')
  store.setReasoningEffort('off')
  await store.selectConversation('a')
  assert.equal(store.currentModel, 'provider/a')
  assert.equal(store.reasoningEffort, 'high')
  // A fresh browser has no local storage but reads the saved server settings.
  storage.clear()
  const reloaded = useChatStore(createPinia())
  reloaded.conversations = conversations.map(c => ({ ...c, modelSettings: null }))
  await reloaded.selectConversation('b')
  assert.equal(reloaded.currentModel, 'provider/b')
  assert.equal(reloaded.reasoningEffort, 'off')
  await reloaded.selectConversation('a')
  assert.equal(reloaded.reasoningEffort, 'high')
  assert.equal(storage.has('yarc-conversation-model-prefs'), false)
})

test('a model-settings load failure prevents sending with another conversation’s settings', async t => {
  setupBrowser()
  MockWebSocket.instances = []
  t.mock.method(globalThis, 'fetch', async input => {
    const url = String(input)
    if (url.endsWith('/model-settings')) return new Response(JSON.stringify({ error: { message: 'unavailable' } }), { status: 503 })
    if (url.endsWith('/branches')) return json({ branches: [{ id: 'main', branchName: 'main', parentBranchId: null, forkMessageId: null }] })
    if (url.includes('/switch-branch/')) return json({ messages: [] })
    if (url.includes('/context-usage?')) return json({ contextUsage: null })
    if (url.includes('/agent-interactions/runtime/')) return json({ runtime: { commands: [], state: 'idle', surfaces: [], uiEvents: [] } })
    if (url.endsWith('/streaming-message')) return json({ message: null })
    throw new Error(`Unexpected API call: ${url}`)
  })
  const store = useChatStore(createPinia())
  store.conversations = [{ id: 'a', paperId: null, projectId: null, title: 'A', model: 'provider/a', createdAt: '', updatedAt: '' }]
  await store.selectConversation('a')
  await store.sendMessage('hello')
  assert.match(store.chatError, /加载模型设置失败/)
  assert.equal(MockWebSocket.instances.length, 0)
})
