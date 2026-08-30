import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { conversationTitleFromMessage } from './conversation.service.js'

describe('conversationTitleFromMessage', () => {
  it('uses the first 30 characters and flattens line breaks', () => {
    assert.equal(conversationTitleFromMessage('第一行\n第二行'), '第一行 第二行')
    assert.equal(conversationTitleFromMessage('123456789012345678901234567890extra'), '123456789012345678901234567890')
  })

  it('returns an empty title for whitespace-only content', () => {
    assert.equal(conversationTitleFromMessage('  \n  '), '')
  })
})
