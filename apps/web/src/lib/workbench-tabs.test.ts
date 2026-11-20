import assert from 'node:assert/strict'
import test from 'node:test'
import {
  LIBRARY_TAB_KEY,
  fileTabHints,
  fileTabKey,
  paperTabKey,
  parseTabOrder,
  pickTabAfterClose,
  projectBadge,
  rememberActiveTab,
  stableTabOrder,
} from './workbench-tabs'

const file = (projectId: string | null, path: string) => ({ projectId, path, name: path.split('/').at(-1)! })

test('tab keys keep papers, files and workspaces apart', () => {
  const keys = [LIBRARY_TAB_KEY, paperTabKey('main.tex'), fileTabKey(file(null, 'main.tex')), fileTabKey(file('A', 'main.tex')), fileTabKey(file('B', 'main.tex'))]
  assert.equal(new Set(keys).size, keys.length)
})

test('recency reordering does not move open tabs; new tabs are appended', () => {
  const order = stableTabOrder([], ['b', 'a'])
  assert.deepEqual(order, ['b', 'a'])
  // Selecting "a" moves it to the front of the recent list only.
  assert.equal(stableTabOrder(order, ['a', 'b']), order)
  assert.deepEqual(stableTabOrder(order, ['c', 'a', 'b']), ['b', 'a', 'c'])
  assert.deepEqual(stableTabOrder(['b', 'a', 'c'], ['c', 'b']), ['b', 'c'])
})

test('closing the active tab returns to the most recently used open tab', () => {
  let history: string[] = []
  for (const key of ['library', 'paper:1', 'file:x', 'paper:1', 'paper:2']) history = rememberActiveTab(history, key)
  assert.deepEqual(history, ['library', 'file:x', 'paper:1', 'paper:2'])
  const open = ['library', 'paper:1', 'paper:2', 'file:x']
  assert.equal(pickTabAfterClose(history, open, 'paper:2'), 'paper:1')
  // Tabs closed in the meantime are skipped.
  assert.equal(pickTabAfterClose(history, ['library', 'paper:2', 'file:x'], 'paper:2'), 'file:x')
})

test('without usable history closing falls back to a neighbour, or nothing', () => {
  const open = ['library', 'paper:1', 'file:x', 'file:y']
  assert.equal(pickTabAfterClose([], open, 'paper:1'), 'file:x')
  assert.equal(pickTabAfterClose(['file:y'], open, 'file:y'), 'file:x')
  assert.equal(pickTabAfterClose([], open, 'library'), 'paper:1')
  assert.equal(pickTabAfterClose(['paper:1'], ['paper:1'], 'paper:1'), null)
  assert.equal(rememberActiveTab(['a', 'b', 'c'], 'd', 3).join(), 'b,c,d')
})

test('tabs left out of the fallback are reached through history only', () => {
  const open = ['library', 'file:x', 'file:other-project']
  const fallback = ['library', 'file:x']
  assert.equal(pickTabAfterClose([], open, 'file:x', fallback), 'library')
  assert.equal(pickTabAfterClose([], ['file:x', 'file:other-project'], 'file:x', ['file:x']), null)
  assert.equal(pickTabAfterClose(['file:other-project', 'file:x'], open, 'file:x', fallback), 'file:other-project')
})

test('directory hints tell apart same-named files of one workspace only', () => {
  const files = [file('A', 'main.tex'), file('B', 'main.tex'), file('A', 'chapters/main.tex'), file('A', 'refs.bib'), file(null, 'main.tex')]
  const hints = fileTabHints(files)
  assert.deepEqual([...hints], [[fileTabKey(files[2]!), 'chapters']])
})

test('project badges are a single upper-case character', () => {
  assert.equal(projectBadge('  survey '), 'S')
  assert.equal(projectBadge('论文写作'), '论')
  assert.equal(projectBadge('😀 notes'), '😀')
  assert.equal(projectBadge(''), '?')
})

test('a malformed persisted tab order is ignored', () => {
  assert.deepEqual(parseTabOrder(null), [])
  assert.deepEqual(parseTabOrder('not json'), [])
  assert.deepEqual(parseTabOrder('{"a":1}'), [])
  assert.deepEqual(parseTabOrder('["a",1,null,"b"]'), ['a', 'b'])
})
