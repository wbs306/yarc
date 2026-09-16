import assert from 'node:assert/strict'
import test from 'node:test'
import {
  parseRecentWorkspaceFiles,
  rememberWorkspaceFile,
  removeRecentWorkspaceFiles,
  workspaceFileKey,
  type WorkspaceRecentFile,
} from './workspace-recent-files'

const file = (projectId: string | null, path = 'main.tex'): WorkspaceRecentFile => ({
  type: 'file', name: path.split('/').at(-1)!, path,
  projectId, projectName: projectId ? `项目 ${projectId}` : null,
})

test('same paths in global files and different projects remain distinct', () => {
  let files: WorkspaceRecentFile[] = []
  for (const id of [null, 'A', 'B']) files = rememberWorkspaceFile(files, file(id))
  assert.equal(files.length, 3)
  assert.equal(new Set(files.map(workspaceFileKey)).size, 3)
  files = rememberWorkspaceFile(files, file('A'))
  assert.deepEqual(files.map(item => item.projectId), ['A', 'B', null])
})

test('removal is limited to a path and descendants in the specified workspace', () => {
  const files = [file(null, 'src/main.tex'), file('A', 'src/main.tex'), file('B', 'src/main.tex'), file('A', 'src2/main.tex')]
  assert.deepEqual(removeRecentWorkspaceFiles(files, 'A', 'src'), [files[0], files[2], files[3]])
})

test('round-trip persistence retains project names and scopes', () => {
  const files = [file(null), file('A'), file('B')]
  assert.deepEqual(parseRecentWorkspaceFiles(JSON.stringify(files)), files)
})

test('invalid, legacy and duplicate records do not become ambiguous entries', () => {
  assert.deepEqual(parseRecentWorkspaceFiles('not json'), [])
  assert.deepEqual(parseRecentWorkspaceFiles('{}'), [])
  const valid = file('A')
  assert.deepEqual(parseRecentWorkspaceFiles(JSON.stringify([
    null, {}, { type: 'file', path: 'main.tex', name: 'main.tex' },
    { ...valid, projectId: '' }, { ...valid, type: 'directory' }, valid, valid,
  ])), [valid])
})

test('keeps the eight most recent files across workspace scopes', () => {
  let files: WorkspaceRecentFile[] = []
  for (let i = 0; i < 10; i++) files = rememberWorkspaceFile(files, file(`project-${i}`))
  assert.equal(files.length, 8)
  assert.equal(files[0]?.projectId, 'project-9')
  assert.equal(files.at(-1)?.projectId, 'project-2')
  assert.equal(parseRecentWorkspaceFiles(JSON.stringify(Array.from({ length: 12 }, (_, i) => file(String(i))))).length, 8)
})
