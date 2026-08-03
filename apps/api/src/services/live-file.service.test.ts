import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'

const testRoot = await mkdtemp(join(tmpdir(), 'yarc-live-file-test-'))
process.env.FILES_DIR = testRoot

const { LiveFileService } = await import('./live-file.service.js')

let service: InstanceType<typeof LiveFileService>

const createFile = async (name: string, content: string) => {
  const path = `${name}.md`
  await writeFile(join(testRoot, path), content, 'utf8')
  return path
}

before(() => {
  service = new LiveFileService()
})

after(async () => {
  await rm(testRoot, { recursive: true, force: true })
})

describe('LiveFileService persistence', () => {
  it('serializes an older flush before a newer edit and leaves the newest content on disk', async () => {
    const path = await createFile('flush-order', 'BASE\n')
    await service.open(path)
    await service.replaceContent(path, 'OLD\n', 'client')

    await Promise.all([
      service.flush(path),
      service.replaceContent(path, 'NEW\n', 'client'),
    ])
    await service.flush(path)

    assert.equal(await readFile(join(testRoot, path), 'utf8'), 'NEW\n')
    assert.equal(service.getSnapshot(path)?.dirty, false)
  })

  it('turns overlapping external edits into an explicit conflict', async () => {
    const path = await createFile('overlap', 'A\nB\n')
    await service.open(path)
    await service.replaceContent(path, 'A\nUSER\n', 'client')
    await writeFile(join(testRoot, path), 'A\nAGENT\n', 'utf8')

    await service.handleDiskChange(path)

    await service.replaceContent(path, 'A\nUSER\nMORE\n', 'client')
    const snapshot = service.getSnapshot(path)
    assert.equal(snapshot?.content, 'A\nUSER\nMORE\n')
    assert.equal(snapshot?.conflict, true)
    await service.resolveConflict(path, 'use-live')
    assert.equal(await readFile(join(testRoot, path), 'utf8'), 'A\nUSER\nMORE\n')
  })

  it('merges non-overlapping external edits without duplicating them', async () => {
    const path = await createFile('merge', 'A\nB\nC\n')
    await service.open(path)
    await service.replaceContent(path, 'A\nUSER\nB\nC\n', 'client')
    await writeFile(join(testRoot, path), 'A\nB\nAGENT\n', 'utf8')

    await service.handleDiskChange(path)
    const secondResult = await service.handleDiskChange(path)
    const snapshot = service.getSnapshot(path)
    assert.equal(secondResult, 'self')
    assert.equal(snapshot?.content, 'A\nUSER\nB\nAGENT\n')
    assert.equal(snapshot?.conflict, false)
  })

  it('rejects an Agent edit whose read base overlaps a later user edit', async () => {
    const path = await createFile('agent-conflict', 'A\nB\n')
    await service.open(path)
    await service.replaceContent(path, 'A\nUSER\n', 'client')

    await assert.rejects(
      service.writeAgentFile(join(testRoot, path), 'A\nAGENT\n', 'A\nB\n'),
      (error: unknown) => (error as { code?: string }).code === 'CONFLICT',
    )
    assert.equal(await readFile(join(testRoot, path), 'utf8'), 'A\nB\n')
  })

  it('applies an Agent edit against its read base and preserves later user edits', async () => {
    const path = await createFile('agent-merge', 'A\nUSER\nB\nC\n')
    await service.open(path)
    await service.replaceContent(path, 'AA\nUSER\nB\nC\n', 'client')

    await service.writeAgentFile(
      join(testRoot, path),
      'A\nUSER\nB\nC\nAGENT\n',
      'A\nUSER\nB\nC\n',
    )

    assert.equal(await readFile(join(testRoot, path), 'utf8'), 'AA\nUSER\nB\nC\nAGENT\n')
    assert.equal(service.getSnapshot(path)?.dirty, false)
  })
})
