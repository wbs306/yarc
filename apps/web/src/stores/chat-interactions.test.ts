import assert from 'node:assert/strict'
import test from 'node:test'
import { createPinia } from 'pinia'
import { useChatStore, type AgentInteractionRequest } from './chat'

const setup = () => {
  // Isolated browser state; never load real storage or contact the API.
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  })
  const events = new EventTarget()
  Object.defineProperty(globalThis, 'window', { configurable: true, value: events })
  const store = useChatStore(createPinia())
  store.currentConvId = 'conversation-a'
  store.currentBranchId = 'branch-a'
  const emit = (event: Record<string, unknown>) => events.dispatchEvent(new CustomEvent('yarc-pi-runtime-event', {
    detail: { conversationId: store.currentConvId, branchId: store.currentBranchId, event },
  }))
  return { store, emit }
}

const question = (requestId = 'question-a', toolCallId = 'tool-a'): AgentInteractionRequest => ({
  type: 'agent_interaction_request', requestId,
  conversationId: 'conversation-a', branchId: 'branch-a', streamMessageId: 'message-a',
  kind: 'questionnaire', payload: { toolCallId, questions: [] }, createdAt: '2026-01-01T00:00:00Z',
})

test('hiding preserves a pending request without submitting or cancelling it', t => {
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected API call') })
  const { store, emit } = setup()
  emit(question())
  assert.equal(store.activeInteraction?.requestId, 'question-a')
  store.hideInteraction('question-a')
  assert.equal(store.activeInteraction, null)
  assert.equal(store.activeInteractionId, null)
  assert.equal(store.questionnaireForTool('tool-a')?.requestId, 'question-a')
  store.openInteraction('question-a')
  assert.equal(store.activeInteraction?.requestId, 'question-a')
  assert.equal(fetch.mock.callCount(), 0)
})

test('hidden requests stay hidden through replay, refresh and workspace switches', () => {
  const { store, emit } = setup()
  emit(question())
  store.hideInteraction('question-a')
  emit(question())
  assert.equal(store.activeInteraction, null)
  store.dismissInteraction('unrelated-notification')
  assert.equal(store.activeInteraction, null)
  store.currentConvId = 'conversation-b'
  store.openInteraction('question-a')
  assert.equal(store.activeInteraction, null)
  assert.equal(store.questionnaireForTool('tool-a'), undefined)
  store.currentConvId = 'conversation-a'
  store.currentBranchId = 'branch-b'
  store.openInteraction('question-a')
  assert.equal(store.activeInteraction, null)
  assert.equal(store.questionnaireForTool('tool-a'), undefined)
  store.currentBranchId = 'branch-a'
  assert.equal(store.activeInteraction, null)
  store.openInteraction('question-a')
  assert.equal(store.activeInteraction?.requestId, 'question-a')
})

test('parallel questionnaires map to their exact tool calls and keep independent visibility', () => {
  const { store, emit } = setup()
  emit(question('question-a', 'tool-a'))
  emit(question('question-b', 'tool-b'))
  store.interactions.foreign = { ...question('foreign', 'tool-a'), conversationId: 'conversation-b' }
  store.interactions.otherBranch = { ...question('otherBranch', 'tool-a'), branchId: 'branch-b' }
  assert.equal(store.questionnaireForTool('tool-a')?.requestId, 'question-a')
  assert.equal(store.questionnaireForTool('tool-b')?.requestId, 'question-b')
  store.hideInteraction('question-b')
  assert.equal(store.activeInteraction?.requestId, 'question-a')
  store.hideInteraction('question-a')
  assert.equal(store.activeInteraction, null)
  store.openInteraction('question-b')
  assert.equal(store.activeInteraction?.requestId, 'question-b')
  store.dismissInteraction('question-b')
  assert.equal(store.activeInteraction, null)
})

test('resolved and timed-out requests no longer offer a reopening action', () => {
  const { store, emit } = setup()
  emit(question())
  store.hideInteraction('question-a')
  emit({ type: 'agent_interaction_resolved', requestId: 'question-a', action: 'cancel', reason: 'timeout' })
  assert.equal(store.questionnaireForTool('tool-a'), undefined)
  store.openInteraction('question-a')
  assert.equal(store.activeInteraction, null)
  assert.match(store.chatError, /超时/)
})

test('generic interactions cannot be hidden by the questionnaire action', () => {
  const { store } = setup()
  store.interactions.confirm = { ...question('confirm'), kind: 'confirm' }
  store.hideInteraction('confirm')
  assert.equal(store.activeInteraction?.requestId, 'confirm')
  assert.equal(store.questionnaireForTool('tool-a'), undefined)
})

for (const action of ['submit', 'cancel'] as const) {
  test(`explicit ${action} still responds to the API and removes the reopening action`, async t => {
    const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ ok: true })))
    const { store, emit } = setup()
    emit(question())
    store.hideInteraction('question-a')
    store.openInteraction('question-a')
    await store.respondInteraction('question-a', { requestId: 'question-a', action, value: { answers: [] } })
    assert.equal(fetch.mock.callCount(), 1)
    const options = fetch.mock.calls[0].arguments[1] as RequestInit
    const body = JSON.parse(String(options.body))
    assert.equal(body.action, action)
    assert.equal(body.conversationId, 'conversation-a')
    assert.equal(body.branchId, 'branch-a')
    assert.equal(store.questionnaireForTool('tool-a'), undefined)
    assert.equal(store.activeInteraction, null)
  })
}
