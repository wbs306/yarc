import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { getSessionBranch, restoreSessionLeaf } from '../lib/pi-session-leaf.js'
import { PiConversationService, type ConversationMessage } from './pi-conversation.service.js'

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

  it('preserves raw display history when Pi edits model context', () => {
    const manager = SessionManager.inMemory(process.cwd())
    const omitted = manager.appendMessage({ role: 'user', content: 'original first', timestamp: 1 })
    const replaced = manager.appendMessage({ role: 'user', content: 'original second', timestamp: 2 })
    manager.appendContextEdit(omitted, null)
    manager.appendContextEdit(replaced, { content: 'model-only replacement' })

    const service = new PiConversationService()
    const displayed = (service as any).entriesToMessages(manager.getBranch())
    assert.deepEqual(displayed.map((message: ConversationMessage) => message.content), ['original first', 'original second'])
    assert.deepEqual(manager.buildSessionContext().messages.map(message => message.role === 'user' ? message.content : undefined), ['model-only replacement'])
  })

  it('restores the persisted active leaf after a tree navigation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'yarc-session-leaf-'))
    try {
      const manager = SessionManager.create(directory, directory)
      const root = manager.appendMessage({ role: 'user', content: 'root', timestamp: 1 } as any)
      const active = manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'active' }], stopReason: 'stop', timestamp: 1 } as any)
      manager.branch(root)
      manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'off path' }], stopReason: 'stop', timestamp: 1 } as any)

      const reopened = SessionManager.open(manager.getSessionFile()!, directory, directory)
      assert.notEqual(reopened.getLeafId(), active)
      assert.equal(restoreSessionLeaf(reopened, active), true)
      assert.deepEqual(getSessionBranch(reopened, active).map(entry => entry.id), [root, active])
      assert.equal(getSessionBranch(reopened, undefined).at(-1)?.id, reopened.getLeafId())
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('excludes replay commits abandoned by context_compact but keeps newer descendants of the saved leaf', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'yarc-compact-replay-'))
    try {
      const manager = SessionManager.create(directory, directory)
      const root = manager.appendMessage({ role: 'user', content: 'prefix', timestamp: 1 })
      const oldUser = manager.appendMessage({ role: 'user', content: 'compact and continue', timestamp: 2 })
      const oldAssistant = manager.appendMessage(assistantEntry('unused', null, 'stop').message as any)
      const summary = manager.branchWithSummary(root, 'handoff summary')
      manager.branch(summary)
      const after = manager.appendMessage(assistantEntry('unused', null, 'stop').message as any)
      const newer = manager.appendMessage(assistantEntry('unused', null, 'stop').message as any)
      const sessionFile = manager.getSessionFile()!
      const service = new PiConversationService()
      ;(service as any).getBranchMeta = async () => ({ sessionFile, leafEntryId: after })
      const state = await service.getStreamReplayState('conversation-1', 'main', [
        { type: 'pi_user_entry', conversationId: 'conversation-1', messageId: 'old-user', entryId: oldUser, sessionFile },
        ...[
          ['old-assistant', oldAssistant], ['after', after], ['newer', newer], ['unknown', 'missing-entry'],
        ].map(([messageId, entryId]) => ({
          type: 'pi_assistant_entry' as const, conversationId: 'conversation-1', messageId, entryId, sessionFile,
        })),
        { type: 'pi_assistant_entry', conversationId: 'conversation-1', messageId: 'other-session', entryId: oldAssistant, sessionFile: '/other/session.jsonl' },
      ])
      assert.deepEqual(state.excludedMessageIds, ['old-user', 'old-assistant'])
      assert.deepEqual(getSessionBranch(SessionManager.open(sessionFile), after).map(entry => entry.id), [root, summary, after])
      ;(service as any).getBranchMeta = async () => ({ sessionFile, leafEntryId: 'legacy-missing-leaf' })
      const fallback = await service.getStreamReplayState('conversation-1', 'main', [
        { type: 'pi_assistant_entry', conversationId: 'conversation-1', messageId: 'newer', entryId: newer, sessionFile },
      ])
      assert.deepEqual(fallback.excludedMessageIds, [])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('keeps pre-compact messages in chronological branch order for ordinary Pi compaction', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'yarc-native-compact-'))
    try {
      const manager = SessionManager.create(directory, directory)
      const root = manager.appendMessage({ role: 'user', content: 'question', timestamp: 1 })
      const before = manager.appendMessage(assistantEntry('unused', null, 'stop').message as any)
      const compact = manager.appendCompaction('summary', before, 1000)
      const after = manager.appendMessage(assistantEntry('unused', null, 'stop').message as any)
      const sessionFile = manager.getSessionFile()!
      const service = new PiConversationService()
      ;(service as any).getSessionFile = async () => sessionFile
      ;(service as any).getBranchMeta = async () => ({ sessionFile, leafEntryId: after })
      const messages = await service.getBranchMessages('conversation-1', 'main')
      assert.deepEqual(messages.map(message => message.id), [root, before, compact, after])
      assert.equal(messages[2].isCompaction, true)
      const replay = await service.getStreamReplayState('conversation-1', 'main', [
        { type: 'pi_assistant_entry', conversationId: 'conversation-1', messageId: 'before', entryId: before, sessionFile },
      ])
      assert.deepEqual(replay.excludedMessageIds, [])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('loads history from one metadata snapshot and keeps the legacy session-file fallback', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'yarc-history-metadata-'))
    try {
      const manager = SessionManager.create(directory, directory)
      const root = manager.appendMessage({ role: 'user', content: 'root', timestamp: 1 })
      const reply = manager.appendMessage(assistantEntry('unused', null, 'stop').message as any)
      const sessionFile = manager.getSessionFile()!
      const service = new PiConversationService()
      let fileLookups = 0
      let metadataReads = 0
      ;(service as any).getSessionFile = async () => { fileLookups++; return sessionFile }
      ;(service as any).getBranchMeta = async () => { metadataReads++; return { sessionFile, leafEntryId: root } }
      assert.deepEqual((await service.getBranchMessages('conversation-1', 'main')).map(message => message.id), [root])
      assert.equal(metadataReads, 1)
      assert.equal(fileLookups, 0)

      ;(service as any).getBranchMeta = async () => null
      assert.deepEqual((await service.getBranchMessages('conversation-1', 'main')).map(message => message.id), [root, reply])
      assert.equal(fileLookups, 1)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('prepares an exact in-place retry for the latest failed user turn', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'yarc-failed-retry-'))
    try {
      const manager = SessionManager.create(directory, directory)
      const earlierUserId = manager.appendMessage({
        role: 'user',
        content: 'earlier',
        timestamp: 1,
      } as any)
      manager.appendMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        stopReason: 'stop',
        timestamp: 1,
      } as any)
      const prompt = '[context]\nfile: notes.md\n[/context]\n\nretry this request'
      const failedUserId = manager.appendMessage({
        role: 'user',
        content: [{ type: 'text', text: prompt }],
        timestamp: 1,
      } as any)
      manager.appendMessage({
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage: '500 Internal Server Error',
        timestamp: 1,
      } as any)

      const service = new PiConversationService()
      ;(service as any).getSessionFile = async () => manager.getSessionFile()

      const retry = await service.prepareFailedTurnRetry('conversation-1', 'main', failedUserId)
      assert.equal(retry.parentEntryId, manager.getEntry(failedUserId)?.parentId)
      assert.equal(retry.prompt, prompt)
      assert.equal(retry.content, 'retry this request')
      await assert.rejects(
        service.prepareFailedTurnRetry('conversation-1', 'main', earlierUserId),
        /latest user turn/
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects retrying a successful turn', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'yarc-success-retry-'))
    try {
      const manager = SessionManager.create(directory, directory)
      const userId = manager.appendMessage({ role: 'user', content: 'question', timestamp: 1 } as any)
      manager.appendMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'answer' }],
        stopReason: 'stop',
        timestamp: 1,
      } as any)

      const service = new PiConversationService()
      ;(service as any).getSessionFile = async () => manager.getSessionFile()
      await assert.rejects(
        service.prepareFailedTurnRetry('conversation-1', 'main', userId),
        /failed turn/
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
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
