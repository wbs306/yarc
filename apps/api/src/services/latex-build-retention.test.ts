import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { cleanupLatexBuilds, isExpiredLatexBuild, markSettledLatexBuild, type SettledLatexBuild } from './latex-build-retention.js'

const now = Date.now()
const day = 24 * 60 * 60 * 1000
const build = (age: number, fields: Partial<SettledLatexBuild> = {}): SettledLatexBuild => ({
  id: randomUUID(), projectId: null, finishedAt: now - age, success: false, ...fields,
})

test('expires unsuccessful builds after 5 days and successful builds after 20 days in any workspace', () => {
  for (const projectId of [null, 'project-a', 'project-b']) {
    for (const [success, days] of [[false, 5], [true, 20]] as const) {
      assert.equal(isExpiredLatexBuild(build(days * day - 1, { projectId, success }), now), false)
      assert.equal(isExpiredLatexBuild(build(days * day, { projectId, success }), now), false)
      assert.equal(isExpiredLatexBuild(build(days * day + 1, { projectId, success }), now), true)
    }
  }
})

test('removes only marked settled directories whose deletion can be claimed', async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), 'yarc-latex-retention-'))
  t.after(() => rm(sandbox, { recursive: true, force: true }))
  const root = join(sandbox, 'output')
  const external = join(sandbox, 'outside')
  await mkdir(root)
  await mkdir(external)
  await writeFile(join(external, 'keep.txt'), 'untouched')

  const removable = build(6 * day, { projectId: 'project-a' })
  const oldSuccess = build(21 * day, { success: true })
  const busy = build(6 * day, { projectId: 'recently-accessed' })
  const retained = Array.from({ length: 45 }, (_, index) => build(19 * day, {
    projectId: index < 42 ? 'project-a' : 'project-b', success: true,
  }))
  const legacy = randomUUID()
  const invalid = randomUUID()
  const symlinkMarker = randomUUID()
  const linked = randomUUID()
  const settled = [removable, oldSuccess, busy, ...retained]
  for (const id of [legacy, invalid, symlinkMarker, ...settled.map(record => record.id)]) await mkdir(join(root, id))
  for (const record of settled) await markSettledLatexBuild(root, record)
  await writeFile(join(root, invalid, '.yarc-settled-build.json'), JSON.stringify(removable))
  await symlink(join(external, 'keep.txt'), join(root, symlinkMarker, '.yarc-settled-build.json'))
  await symlink(external, join(root, linked), 'dir')
  const removed: string[] = []
  const hooks = {
    claim: (id: string) => id !== busy.id,
    finish: (id: string, success: boolean) => { if (success) removed.push(id) },
    onError: (error: unknown) => { throw error },
  }
  await cleanupLatexBuilds(root, hooks, now)
  assert.deepEqual(new Set(removed), new Set([removable.id, oldSuccess.id]))
  assert.deepEqual(new Set(await readdir(root)), new Set([busy.id, legacy, invalid, linked, symlinkMarker, ...retained.map(record => record.id)]))
  assert.equal(await readFile(join(external, 'keep.txt'), 'utf8'), 'untouched')

  const linkedRoot = join(sandbox, 'linked-root')
  await symlink(root, linkedRoot, 'dir')
  await cleanupLatexBuilds(linkedRoot, { ...hooks, claim: () => true }, now)
  assert.equal(removed.length, 2)
})
