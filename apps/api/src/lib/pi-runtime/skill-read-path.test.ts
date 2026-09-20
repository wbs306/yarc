import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import test, { type TestContext } from 'node:test'
import { createReadToolDefinition, type ExtensionContext } from '@earendil-works/pi-coding-agent'
import { resolveLoadedSkillReadPath } from './skill-read-path.js'
import { resolvePublicSharedFileReference } from '../../services/global-shared-file.service.js'

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'yarc-skill-read-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const cwd = join(root, 'data/projects/A')
  const skillDir = join(root, 'data/.pi/agent/skills/demo')
  await mkdir(cwd, { recursive: true })
  await mkdir(join(skillDir, 'references'), { recursive: true })
  await mkdir(join(skillDir, 'scripts'), { recursive: true })
  const skillFile = join(skillDir, 'SKILL.md')
  await writeFile(skillFile, '# Demo skill\n')
  await writeFile(join(skillDir, 'references/guide.md'), 'Reference contents\n')
  await writeFile(join(skillDir, 'scripts/example.sh'), 'echo demo\n')
  return { root, cwd, skillDir, skillFile }
}

test('loaded shared skill and its references/scripts receive a read-only path exception', async t => {
  const { skillDir, skillFile } = await fixture(t)
  for (const path of [skillFile, join(skillDir, 'references/guide.md'), join(skillDir, 'scripts/example.sh')]) {
    assert.equal(await resolveLoadedSkillReadPath(path, [skillFile]), await realpath(path))
  }
})

test('Pi read can open absolute and project-relative skill paths rejected by public @file rules', async t => {
  const { cwd, skillFile } = await fixture(t)
  const relativePath = relative(cwd, skillFile)
  assert.throws(() => resolvePublicSharedFileReference(relativePath), /not available through project @file/)
  const resolveRead = async (path: string) => {
    const allowed = await resolveLoadedSkillReadPath(path, [skillFile])
    if (!allowed) throw new Error('Not a loaded resource')
    return allowed
  }
  const tool = createReadToolDefinition(cwd, { operations: {
    access: async path => access(await resolveRead(path)),
    readFile: async path => readFile(await resolveRead(path)),
    detectImageMimeType: async () => null,
  } })
  for (const path of [skillFile, relativePath]) {
    const result = await tool.execute('read-skill', { path }, undefined, undefined, undefined as unknown as ExtensionContext)
    assert.ok(result.content.some(item => item.type === 'text' && item.text.includes('# Demo skill')))
  }
})

test('unloaded resources, sibling skills, credentials and other workspaces gain no exception', async t => {
  const { root, skillDir, skillFile } = await fixture(t)
  assert.equal(await resolveLoadedSkillReadPath(skillFile, []), null)
  for (const path of [
    join(dirname(skillDir), 'other/SKILL.md'),
    join(dirname(skillDir), 'demo-copy/SKILL.md'),
    join(root, 'data/.pi/agent/auth.json'),
    join(root, 'data/.pi/agent/sessions/session.jsonl'),
    join(root, 'data/projects/B/notes.md'),
    join(root, 'data/papers/paper/parsed.md'),
    resolve(skillDir, '../other/SKILL.md'),
    join(root, 'data/shared/guide.md'),
  ]) assert.equal(await resolveLoadedSkillReadPath(path, [skillFile]), null)
})

test('sensitive filenames inside a loaded skill are rejected before filesystem access', async t => {
  const { skillDir, skillFile } = await fixture(t)
  for (const name of ['.env', '.env.local', 'auth.json', 'models.json', 'credentials.json', 'id_rsa', 'id_ed25519', 'private.key', 'cert.pem', '.git/config']) {
    await assert.rejects(resolveLoadedSkillReadPath(join(skillDir, name), [skillFile]), /Sensitive files/)
  }
})

test('symlinks cannot escape a loaded skill or conceal sensitive names', async t => {
  const { root, skillDir, skillFile } = await fixture(t)
  const outside = join(root, 'outside.txt')
  await writeFile(outside, 'synthetic fixture')
  await symlink(outside, join(skillDir, 'references/escape.md'))
  await assert.rejects(resolveLoadedSkillReadPath(join(skillDir, 'references/escape.md'), [skillFile]), /stay inside/)
  // Synthetic fixture only; no real credentials are accessed.
  await writeFile(join(skillDir, '.hidden'), 'synthetic fixture')
  await symlink(join(skillDir, '.hidden'), join(skillDir, 'references/disguised.md'))
  await assert.rejects(resolveLoadedSkillReadPath(join(skillDir, 'references/disguised.md'), [skillFile]), /stay inside/)
})

test('installed directory symlinks and package skills outside data remain readable', async t => {
  const { root, skillDir } = await fixture(t)
  const linkedDir = join(root, 'linked-skill')
  await symlink(skillDir, linkedDir, 'dir')
  const linkedSkill = join(linkedDir, 'SKILL.md')
  assert.equal(await resolveLoadedSkillReadPath(join(linkedDir, 'references/guide.md'), [linkedSkill]), await realpath(join(skillDir, 'references/guide.md')))
  const packageSkill = join(root, 'packages/example/skills/demo/SKILL.md')
  await mkdir(dirname(packageSkill), { recursive: true })
  await writeFile(packageSkill, '# Package skill')
  assert.equal(await resolveLoadedSkillReadPath(packageSkill, [packageSkill]), await realpath(packageSkill))
})

test('standalone markdown skills do not authorize their whole parent directory', async t => {
  const { root } = await fixture(t)
  const file = join(root, 'standalone.md')
  await writeFile(file, '# Standalone')
  assert.equal(await resolveLoadedSkillReadPath(file, [file]), await realpath(file))
  assert.equal(await resolveLoadedSkillReadPath(join(root, 'sibling.md'), [file]), null)
})

test('a skill entry symlink cannot grant access to an unrelated parent directory', async t => {
  const { root, skillFile } = await fixture(t)
  const directory = join(root, 'unrelated')
  await mkdir(directory)
  await symlink(skillFile, join(directory, 'SKILL.md'))
  await writeFile(join(directory, 'notes.md'), 'not a skill resource')
  await assert.rejects(resolveLoadedSkillReadPath(join(directory, 'notes.md'), [join(directory, 'SKILL.md')]), /stay inside/)
})
