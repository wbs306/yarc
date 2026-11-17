import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { conversationTitleFromMessage, getConversationModelSettings, parseConversationModelSettings } from './conversation.service.js'

describe('conversation model settings', () => {
  it('validates model and reasoning effort and reads only the settings field', () => {
    const settings = { model: 'provider/model', reasoningEffort: 'high' }
    assert.deepEqual(parseConversationModelSettings(settings), settings)
    assert.deepEqual(getConversationModelSettings({ modelSettings: settings, pi: { sessions: {} } }), settings)
    assert.equal(parseConversationModelSettings({ model: '', reasoningEffort: 'high' }), null)
    assert.equal(parseConversationModelSettings({ model: 'provider/model', reasoningEffort: 'unknown' }), null)
    assert.equal(getConversationModelSettings({ pi: {} }), null)
  })
})

describe('conversationTitleFromMessage', () => {
  it('uses the first 30 characters and flattens line breaks', () => {
    assert.equal(conversationTitleFromMessage('第一行\n第二行'), '第一行 第二行')
    assert.equal(conversationTitleFromMessage('123456789012345678901234567890extra'), '123456789012345678901234567890')
  })

  it('returns an empty title for whitespace-only content', () => {
    assert.equal(conversationTitleFromMessage('  \n  '), '')
  })
})
