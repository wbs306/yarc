import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { agentWorkspacePaths, withAgentWorkspaceCwd } from '../lib/agent-workspace.js'
import { isDefaultIgnoredDataPath, isProjectPiRuntimeResourcePath } from '../lib/data-sync-policy.js'
import { normalizeProjectRelativePath, validateProjectDirectoryName } from '../lib/project-path.js'
import { parseProjectGitPorcelainStatus } from './project-git.service.js'
import { LiveFileService } from './live-file.service.js'

describe('Project path policy', () => {
  it('accepts normalized relative paths and the workspace root', () => {
    assert.equal(normalizeProjectRelativePath('.'), '')
    assert.equal(normalizeProjectRelativePath('sections/main.tex'), 'sections/main.tex')
    assert.equal(normalizeProjectRelativePath('sections\\main.tex'), 'sections/main.tex')
    assert.equal(validateProjectDirectoryName('paper-2026'), 'paper-2026')
  })

  it('rejects traversal, protected git paths, and cross-platform absolute paths', () => {
    assert.throws(() => normalizeProjectRelativePath('../outside.tex'), /traversal/i)
    assert.throws(() => normalizeProjectRelativePath('src/../outside.tex'), /traversal/i)
    assert.throws(() => normalizeProjectRelativePath('.git/config'), /managed only through Project Git/i)
    assert.throws(() => normalizeProjectRelativePath('nested/.git/config'), /managed only through Project Git/i)
    assert.throws(() => normalizeProjectRelativePath('/tmp/outside.tex'), /Invalid project path/i)
    assert.throws(() => normalizeProjectRelativePath('C:\\Users\\user\\outside.tex'), /Invalid project path/i)
    assert.throws(() => normalizeProjectRelativePath('\\\\server\\share\\outside.tex'), /Invalid project path/i)
    assert.throws(() => normalizeProjectRelativePath('bad\0path.tex'), /Invalid project path/i)
  })

  it('keeps immutable directory identities deliberately narrow', () => {
    for (const invalid of ['Project', 'two words', '../escape', 'under_score', '-leading', 'trailing-']) {
      assert.throws(() => validateProjectDirectoryName(invalid), /directoryName/i)
    }
  })
})

describe('Project Git status parsing', () => {
  it('consumes the second NUL pathname for rename/copy records', () => {
    const files = parseProjectGitPorcelainStatus(
      'R  chapters/new.tex\0chapters/old.tex\0 M main.tex\0C  figures/new.svg\0figures/old.svg\0',
    )
    assert.deepEqual(files, [
      { indexStatus: 'R', worktreeStatus: ' ', path: 'chapters/new.tex', originalPath: 'chapters/old.tex' },
      { indexStatus: ' ', worktreeStatus: 'M', path: 'main.tex' },
      { indexStatus: 'C', worktreeStatus: ' ', path: 'figures/new.svg', originalPath: 'figures/old.svg' },
    ])
  })
})

describe('Project sync and Pi resource policy', () => {
  it('ignores nested git metadata and global writing-history objects without hiding project Pi resources', () => {
    assert.equal(isDefaultIgnoredDataPath('projects/demo/.git/HEAD'), true)
    assert.equal(isDefaultIgnoredDataPath('projects/demo/src/.git/config'), true)
    assert.equal(isDefaultIgnoredDataPath('.project-history/objects/aa/hash.br'), true)
    assert.equal(isDefaultIgnoredDataPath('projects/demo/.pi/settings.json'), false)
    assert.equal(isDefaultIgnoredDataPath('projects/demo/.agents/skills/reviewer/SKILL.md'), false)

    assert.equal(isProjectPiRuntimeResourcePath('AGENTS.md'), true)
    assert.equal(isProjectPiRuntimeResourcePath('.pi/SYSTEM.md'), true)
    assert.equal(isProjectPiRuntimeResourcePath('.pi/settings.json'), true)
    assert.equal(isProjectPiRuntimeResourcePath('.agents/skills/reviewer/SKILL.md'), true)
    assert.equal(isProjectPiRuntimeResourcePath('src/main.ts'), false)
  })

  it('scopes conversation cwd without moving global Pi configuration paths', () => {
    const global = agentWorkspacePaths()
    const projectRoot = resolve(tmpdir(), 'yarc-project-cwd-test')
    const scoped = withAgentWorkspaceCwd(projectRoot, () => agentWorkspacePaths())

    assert.equal(scoped.cwd, projectRoot)
    assert.equal(scoped.agentDir, global.agentDir)
    assert.equal(scoped.sessionsDir, global.sessionsDir)
    assert.equal(scoped.auth, global.auth)
    assert.equal(scoped.models, global.models)
  })
})

describe('Project LiveFile isolation', () => {
  it('does not collide when two projects edit the same relative path', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'yarc-project-live-'))
    const rootA = join(directory, 'project-a')
    const rootB = join(directory, 'project-b')
    await mkdir(rootA)
    await mkdir(rootB)
    await writeFile(join(rootA, 'main.tex'), 'project A\n')
    await writeFile(join(rootB, 'main.tex'), 'project B\n')

    const a = new LiveFileService({ rootDir: rootA, workspaceKind: 'project', projectId: 'project-a' })
    const b = new LiveFileService({ rootDir: rootB, workspaceKind: 'project', projectId: 'project-b' })

    try {
      await a.replaceContent('main.tex', 'project A edited\n', 'api')
      const resultA = await a.flush('main.tex')
      assert.equal(resultA?.conflict, false)
      assert.equal(await readFile(join(rootA, 'main.tex'), 'utf-8'), 'project A edited\n')
      assert.equal(await readFile(join(rootB, 'main.tex'), 'utf-8'), 'project B\n')

      await b.replaceContent('main.tex', 'project B edited\n', 'api')
      const resultB = await b.flush('main.tex')
      assert.equal(resultB?.conflict, false)
      assert.equal(await readFile(join(rootA, 'main.tex'), 'utf-8'), 'project A edited\n')
      assert.equal(await readFile(join(rootB, 'main.tex'), 'utf-8'), 'project B edited\n')

      await assert.rejects(() => a.open('.git/config'), /managed only through Project Git|protected/i)
    } finally {
      await Promise.allSettled([a.disposeAll(), b.disposeAll()])
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('allows project-local Pi and skill resources while blocking sensitive files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yarc-project-live-resources-'))
    const skill = join(root, '.agents', 'skills', 'reviewer', 'SKILL.md')
    const systemPrompt = join(root, '.pi', 'SYSTEM.md')
    await mkdir(join(root, '.agents', 'skills', 'reviewer'), { recursive: true })
    await mkdir(join(root, '.pi'), { recursive: true })
    await writeFile(skill, '# Reviewer\n')
    await writeFile(systemPrompt, 'Project system\n')
    await writeFile(join(root, '.gitignore'), '*.aux\n')
    await writeFile(join(root, '.env'), 'SECRET=do-not-read\n')

    const live = new LiveFileService({ rootDir: root, workspaceKind: 'project', projectId: 'resources' })
    try {
      await live.replaceContent('.agents/skills/reviewer/SKILL.md', '# Reviewer\nUpdated\n', 'api')
      await live.flush('.agents/skills/reviewer/SKILL.md')
      assert.equal(await readFile(skill, 'utf-8'), '# Reviewer\nUpdated\n')

      await live.replaceContent('.pi/SYSTEM.md', 'Project system updated\n', 'api')
      await live.flush('.pi/SYSTEM.md')
      assert.equal(await readFile(systemPrompt, 'utf-8'), 'Project system updated\n')

      await live.replaceContent('.gitignore', '*.aux\n*.log\n', 'api')
      await live.flush('.gitignore')
      assert.equal(await readFile(join(root, '.gitignore'), 'utf-8'), '*.aux\n*.log\n')

      await assert.rejects(() => live.open('.env'), /Access denied/i)
      await assert.rejects(() => live.open('.git/config'), /managed only through Project Git|protected/i)
    } finally {
      await live.disposeAll()
      await rm(root, { recursive: true, force: true })
    }
  })
})
