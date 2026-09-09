import assert from 'node:assert/strict'
import { access, readFile, rm } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { prisma } from '@yarc/db'
import { projectService } from './project.service.js'
import { projectFileService } from './project-file.service.js'
import { projectGitService } from './project-git.service.js'
import { projectHistoryService } from './project-history.service.js'
import { projectLiveFileManager } from './project-live-file.service.js'

const isMissing = async (path: string) => {
  try {
    await access(path)
    return false
  } catch {
    return true
  }
}

describe('Project Writing History integration', () => {
  it('restores a complete writing checkpoint including creates and deletes, then undoes the restore', async () => {
    const directoryName = `history-integration-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
    const project = await projectService.create({ name: 'History integration', directoryName })
    const root = await projectFileService.getProjectRoot(project.id)

    try {
      const initialGit = await projectGitService.status(project.id)
      assert.equal(initialGit.head, null)

      await projectFileService.createFile(project.id, 'a.tex', 'A1\n')
      await projectFileService.createFile(project.id, 'b.tex', 'B1\n')
      await projectHistoryService.flushPending(project.id)
      const t1 = await projectHistoryService.checkpoint(project.id, {
        kind: 'manual',
        label: 'T1',
        forceBoundary: true,
      })
      assert.ok(t1)

      await projectFileService.saveFileContent(project.id, 'a.tex', 'A2\n')
      await projectFileService.deletePath(project.id, 'b.tex')
      await projectFileService.createFile(project.id, 'c.tex', 'C2\n')
      await projectHistoryService.flushPending(project.id)

      const beforeRestoreGit = await projectGitService.status(project.id)
      await projectHistoryService.restoreWritingCheckpoint(project.id, t1!.id)

      assert.equal(await readFile(`${root}/a.tex`, 'utf8'), 'A1\n')
      assert.equal(await readFile(`${root}/b.tex`, 'utf8'), 'B1\n')
      assert.equal(await isMissing(`${root}/c.tex`), true)

      const checkpoints = await projectHistoryService.listCheckpoints(project.id, 100)
      const preRestore = checkpoints.find(item => item.kind === 'pre-restore' && (item.metadata as any)?.targetCheckpointId === t1!.id)
      assert.ok(preRestore, 'restore must create an undoable pre-restore checkpoint')

      await projectHistoryService.restoreWritingCheckpoint(project.id, preRestore!.id)
      assert.equal(await readFile(`${root}/a.tex`, 'utf8'), 'A2\n')
      assert.equal(await isMissing(`${root}/b.tex`), true)
      assert.equal(await readFile(`${root}/c.tex`, 'utf8'), 'C2\n')

      const afterRestoreGit = await projectGitService.status(project.id)
      assert.equal(afterRestoreGit.head, beforeRestoreGit.head)
      assert.equal(afterRestoreGit.branch, beforeRestoreGit.branch)
      assert.equal(afterRestoreGit.head, initialGit.head)
    } finally {
      await projectLiveFileManager.disposeProject(project.id).catch(() => undefined)
      await prisma.project.delete({ where: { id: project.id } }).catch(() => undefined)
      await rm(root, { recursive: true, force: true })
    }
  })
})
