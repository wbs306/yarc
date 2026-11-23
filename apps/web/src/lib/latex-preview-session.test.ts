import assert from 'node:assert/strict'
import test from 'node:test'
import { fileTabKey } from './workbench-tabs'
import { parseLatexPreviewSessions, rememberLatexPreviewSession, serializeLatexPreviewSessions, type LatexPreviewSession } from './latex-preview-session'

const session = (projectId: string | null, path = 'main.tex'): LatexPreviewSession => ({
  projectId, path, entryPath: 'main.tex', buildId: '12345678-1234-1234-1234-123456789abc',
  visible: true, engine: 'xelatex',
})

test('refresh restores the build ID, engine, visibility and included-source association', () => {
  const saved = session('project-a', 'chapters/intro.tex')
  saved.engine = 'lualatex'
  saved.visible = false
  const restored = parseLatexPreviewSessions(serializeLatexPreviewSessions(new Map([[fileTabKey(saved), saved]])))
  assert.deepEqual(restored.get(fileTabKey(saved)), saved)
})

test('same file paths in global files and two projects retain separate builds', () => {
  const sessions = [session(null), session('project-a'), session('project-b')]
  const restored = parseLatexPreviewSessions(JSON.stringify(sessions))
  assert.equal(restored.size, 3)
  for (const saved of sessions) assert.deepEqual(restored.get(fileTabKey(saved)), saved)
})

test('ignores malformed, unscoped and unsafe browser records', () => {
  assert.equal(parseLatexPreviewSessions('invalid JSON').size, 0)
  assert.equal(parseLatexPreviewSessions('{}').size, 0)
  const valid = session(null)
  const invalid = [
    { ...valid, projectId: undefined }, { ...valid, projectId: '' },
    { ...valid, entryPath: '../main.tex' }, { ...valid, path: '/main.tex' },
    { ...valid, entryPath: '.git/main.tex' }, { ...valid, engine: 'shell' },
    { ...valid, buildId: '../../outside' }, { ...valid, visible: 'true' },
  ]
  assert.equal(parseLatexPreviewSessions(JSON.stringify(invalid)).size, 0)
})

test('recently used sources stay restorable when older associations are evicted', () => {
  const sessions = new Map<string, LatexPreviewSession>()
  const first = session(null, 'first.tex')
  rememberLatexPreviewSession(sessions, first)
  for (let index = 0; index < 31; index++) rememberLatexPreviewSession(sessions, session(null, `file-${index}.tex`))
  rememberLatexPreviewSession(sessions, first)
  rememberLatexPreviewSession(sessions, session(null, 'new.tex'))
  assert.equal(sessions.size, 32)
  assert.equal(sessions.has(fileTabKey(first)), true)
  assert.equal(sessions.has(fileTabKey(session(null, 'file-0.tex'))), false)
})

test('bounds persisted history and excludes builds that have not started', () => {
  const entries = Array.from({ length: 40 }, (_, index) => session(null, `file-${index}.tex`))
  const empty = { ...session(null, 'empty.tex'), buildId: '' }
  const raw = serializeLatexPreviewSessions(new Map([...entries, empty].map(item => [fileTabKey(item), item])))
  const restored = parseLatexPreviewSessions(raw)
  assert.equal(restored.size, 32)
  assert.equal(restored.has(fileTabKey(entries[0])), false)
  assert.equal(restored.has(fileTabKey(entries[39])), true)
  assert.equal(restored.has(fileTabKey(empty)), false)
})
