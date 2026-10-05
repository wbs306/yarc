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
