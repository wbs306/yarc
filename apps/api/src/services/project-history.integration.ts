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

const createTestProject = async (label: string) => {
  const directoryName = `${label}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
  const project = await projectService.create({ name: label, directoryName })
  const root = await projectFileService.getProjectRoot(project.id)
  return { project, root }
}

const cleanupTestProject = async (projectId: string, root: string) => {
  await projectLiveFileManager.disposeProject(projectId).catch(() => undefined)
  await prisma.project.delete({ where: { id: projectId } }).catch(() => undefined)
  await rm(root, { recursive: true, force: true })
}

describe('Project Writing History integration', () => {
  it('restores a complete writing checkpoint including creates and deletes, then undoes the restore', async () => {
    const { project, root } = await createTestProject('history-checkpoint')

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
      await cleanupTestProject(project.id, root)
    }
  })

  it('restores one file without changing Git HEAD, branch, or index and can undo via pre-restore', async () => {
    const { project, root } = await createTestProject('history-file')

    try {
      await projectFileService.createFile(project.id, 'a.tex', 'v1\n')
      await projectHistoryService.flushPending(project.id)
      const v1 = (await projectHistoryService.listFileHistory(project.id, 'a.tex')).find(item => !item.deleted)
      assert.ok(v1)

      await projectGitService.stage(project.id, ['.gitignore', 'a.tex'])
      await projectGitService.commit(project.id, 'Initial writing milestone')

      await projectFileService.saveFileContent(project.id, 'a.tex', 'v2\n')
      await projectHistoryService.flushPending(project.id)
      await projectFileService.saveFileContent(project.id, 'a.tex', 'v3\n')
      await projectHistoryService.flushPending(project.id)
      await projectGitService.stage(project.id, ['a.tex'])

      const before = await projectGitService.status(project.id)
      const stagedBefore = await projectGitService.diff(project.id, { staged: true, path: 'a.tex' })
      await projectHistoryService.restoreFileRevision(project.id, v1!.id)

      assert.equal(await readFile(`${root}/a.tex`, 'utf8'), 'v1\n')
      const after = await projectGitService.status(project.id)
      assert.equal(after.head, before.head)
      assert.equal(after.branch, before.branch)
      assert.equal(await projectGitService.diff(project.id, { staged: true, path: 'a.tex' }), stagedBefore)

      const checkpoints = await projectHistoryService.listCheckpoints(project.id, 100)
      const preRestore = checkpoints.find(item => item.kind === 'pre-restore' && (item.metadata as any)?.targetRevisionId === v1!.id)
      assert.ok(preRestore)
      await projectHistoryService.restoreWritingCheckpoint(project.id, preRestore!.id)
      assert.equal(await readFile(`${root}/a.tex`, 'utf8'), 'v3\n')
    } finally {
      await cleanupTestProject(project.id, root)
    }
  })

  it('keeps code Git-first while document Writing History remains independent', async () => {
    const { project, root } = await createTestProject('history-git')

    try {
      await projectFileService.createFile(project.id, 'paper/main.tex', 'paper v1\n')
      await projectFileService.createFile(project.id, 'src/model.py', 'print("v1")\n')
      await projectHistoryService.flushPending(project.id)

      assert.ok((await projectHistoryService.listFileHistory(project.id, 'paper/main.tex')).length > 0)
      assert.equal((await projectHistoryService.listFileHistory(project.id, 'src/model.py')).length, 0)

      await projectGitService.stage(project.id, ['.gitignore', 'paper/main.tex', 'src/model.py'])
      await projectGitService.commit(project.id, 'Initial project milestone')

      await projectFileService.saveFileContent(project.id, 'paper/main.tex', 'paper v2\n')
      await projectFileService.saveFileContent(project.id, 'src/model.py', 'print("v2")\n')
      await projectHistoryService.flushPending(project.id)

      const dirty = await projectGitService.status(project.id)
      assert.ok(dirty.files.some(item => item.path === 'paper/main.tex'))
      assert.ok(dirty.files.some(item => item.path === 'src/model.py'))
      assert.ok((await projectHistoryService.listFileHistory(project.id, 'paper/main.tex')).length > 1)
      assert.equal((await projectHistoryService.listFileHistory(project.id, 'src/model.py')).length, 0)

      await projectGitService.stage(project.id, ['src/model.py'])
      await projectGitService.commit(project.id, 'Update model code')

      const afterCommit = await projectGitService.status(project.id)
      const paper = afterCommit.files.find(item => item.path === 'paper/main.tex')
      assert.ok(paper, 'unfinished paper must remain in the working tree after a code-only commit')
      assert.equal(paper!.indexStatus, ' ')
      assert.equal(paper!.worktreeStatus, 'M')
      assert.equal(afterCommit.files.some(item => item.path === 'src/model.py'), false)
      assert.equal((await projectGitService.log(project.id, 10)).length, 2)
    } finally {
      await cleanupTestProject(project.id, root)
    }
  })
})
