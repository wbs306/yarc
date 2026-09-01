import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { deriveRunJournalCommitState, RunJournalStore } from './run-journal.js'

test('run journal commit state distinguishes user and committed assistant entries', () => {
  assert.deepEqual(deriveRunJournalCommitState([
    { type: 'text', content: 'partial', eventSequence: 1 },
    { type: 'pi_user_entry', entryId: 'user-entry', eventSequence: 2 },
    { type: 'pi_assistant_entry', entryId: 'assistant-entry-1', eventSequence: 3 },
    { type: 'pi_assistant_entry', entryId: 'assistant-entry-2', eventSequence: 4 },
  ]), {
    userEntryId: 'user-entry',
    assistantEntryIds: ['assistant-entry-1', 'assistant-entry-2'],
    leafEntryId: 'assistant-entry-2',
  })
})

test('run journal cleanup removes only stale generated artifacts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yarc-run-journal-'))
  const store = new RunJournalStore(root)
  try {
    await store.write({
      conversationId: 'active',
      runId: 'run-active',
      branchId: 'main',
      source: 'user',
      status: 'streaming',
      events: [],
      commitState: { assistantEntryIds: [] },
      finalData: {},
      updatedAt: new Date().toISOString(),
    })

    const staleDir = join(root, 'stale')
    await mkdir(staleDir, { recursive: true })
    const staleJournal = join(staleDir, 'run-stale.jsonl')
    const staleTemp = join(staleDir, 'run-stale.jsonl.1.tmp')
    await writeFile(staleJournal, '{}\n', 'utf8')
    await writeFile(staleTemp, '{}\n', 'utf8')
    const old = new Date(Date.now() - 120_000)
    await utimes(staleJournal, old, old)
    await utimes(staleTemp, old, old)

    assert.equal(await store.cleanupStale(60_000), 2)
    assert.equal((await store.listPending()).length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
