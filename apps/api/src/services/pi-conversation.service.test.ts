import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { PiConversationService } from './pi-conversation.service.js'

const timestamp = '2026-01-01T00:00:00.000Z'
const userEntry = (id: string, parentId: string | null, text: string) => ({
  type: 'message',
  id,
  parentId,
  timestamp,
  message: { role: 'user', content: [{ type: 'text', text }], timestamp: 1 },
})
const assistantEntry = (
  id: string,
  parentId: string | null,
  stopReason: 'stop' | 'error',
  errorMessage?: string
) => ({
  type: 'message',
  id,
  parentId,
  timestamp,
  message: {
    role: 'assistant',
    content: stopReason === 'stop' ? [{ type: 'text', text: 'ok' }] : [],
    stopReason,
    errorMessage,
    timestamp: 1,
  },
})

describe('PiConversationService branch projection', () => {
  it('maps an edited user after intervening custom entries and handles root forks', () => {
    const service = new PiConversationService()
    const entriesToMessages = (service as any).entriesToMessages.bind(service)
    const entries = [
      userEntry('user-1', null, 'first'),
      assistantEntry('assistant-1', 'user-1', 'stop'),
      { type: 'custom', id: 'context-1', parentId: 'assistant-1', timestamp, customType: 'yarc-context', data: {} },
      userEntry('user-2', 'context-1', 'edited'),
    ]

    const nested = entriesToMessages(entries, {
      forkMessageId: 'display-anchor',
      forkParentEntryId: 'assistant-1',
    })
    assert.equal(nested.find((message: any) => message.id === 'user-2')?.forkFromMessageId, 'display-anchor')

    const root = entriesToMessages([userEntry('root-edit', null, 'edited root')], {
      forkMessageId: 'original-root',
      forkParentEntryId: null,
    })
    assert.equal(root[0]?.forkFromMessageId, 'original-root')
  })

  it('hides retry errors superseded in the same user turn', () => {
    const service = new PiConversationService()
    const entriesToMessages = (service as any).entriesToMessages.bind(service)

    const successfulRetry = entriesToMessages([
      userEntry('user-1', null, 'question'),
      assistantEntry('error-1', 'user-1', 'error', 'temporary failure'),
      assistantEntry('error-2', 'error-1', 'error', 'temporary failure 2'),
      assistantEntry('success-1', 'error-2', 'stop'),
    ])
    assert.deepEqual(successfulRetry.map((message: any) => message.id), ['user-1', 'success-1'])

    const exhaustedRetry = entriesToMessages([
      userEntry('user-2', null, 'question'),
      assistantEntry('error-3', 'user-2', 'error', 'first failure'),
      assistantEntry('error-4', 'error-3', 'error', 'final failure'),
    ])
    assert.deepEqual(exhaustedRetry.map((message: any) => message.id), ['user-2', 'error-4'])
  })

  it('creates an empty child session when editing the root user', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'yarc-root-edit-'))
    try {
      const source = SessionManager.create(directory, directory)
      const rootUserId = source.appendMessage({
        role: 'user',
        content: [{ type: 'text', text: 'original' }],
        timestamp: 1,
      } as any)
      const assistantId = source.appendMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'reply' }],
        stopReason: 'stop',
        timestamp: 1,
      } as any)
      const sourceFile = source.getSessionFile()
      assert.ok(sourceFile)

      const service = new PiConversationService()
      let savedLeaf: string | null | undefined
      ;(service as any).getSessionFile = async () => sourceFile
      ;(service as any).saveSessionInfo = async (
        _conversationId: string,
        _branchId: string,
        _sessionFile: string,
        leafEntryId: string | null | undefined
      ) => { savedLeaf = leafEntryId }

      const branch = await service.createBranchFromEdit('conversation-1', 'main', rootUserId, 'edited')
      const opened = SessionManager.open(branch.sessionFile)

      assert.equal(branch.forkEntryId, null)
      assert.equal(savedLeaf, null)
      assert.deepEqual(opened.getBranch(), [])
      assert.equal(opened.getHeader()?.parentSession, sourceFile)
      await assert.rejects(
        service.createBranchFromEdit('conversation-1', 'main', assistantId, 'not allowed'),
        /Only user messages can be edited/
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
