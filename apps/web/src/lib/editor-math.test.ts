import assert from 'node:assert/strict'
import test from 'node:test'
import { EditorState } from '@codemirror/state'
import { scanEditorMath } from './editor-math'

test('incremental math/code scans agree with fresh scans across block-boundary and multi-edits', () => {
  let state = EditorState.create({ doc: '# Notes\n\n$x$ text `$code$`\n\n```js\n$hidden$\n```\n\n> $quote$\n\n    $indented$\n' })
  let scanned = scanEditorMath(state.doc.toString(), 'markdown')
  const edits = [
    [{ from: 12, insert: '+1' }],
    [{ from: 0, insert: 'intro\n\n' }, { from: state.doc.length, insert: '\n$tail$' }],
    [{ from: 0, insert: '```\n' }],
    [{ from: 0, to: 4, insert: '' }],
    [{ from: 20, insert: '`' }],
    [{ from: 20, to: 21, insert: '' }],
  ]
  for (const changes of edits) {
    const transaction = state.update({ changes })
    state = transaction.state
    scanned = scanEditorMath(state.doc.toString(), 'markdown', scanned.tree, transaction.changes)
    const fresh = scanEditorMath(state.doc.toString(), 'markdown')
    assert.deepEqual(scanned.ranges, fresh.ranges)
    assert.deepEqual(scanned.code, fresh.code)
  }
})

test('incremental scans preserve distant code exclusions through repeated local edits', () => {
  let state = EditorState.create({ doc: Array.from({ length: 150 }, (_, i) => `## ${i}\n\n$x_${i}$\n\n~~~\n$hidden$\n~~~\n\n`).join('') })
  let scanned = scanEditorMath(state.doc.toString(), 'markdown')
  const original = scanned.tree!
  for (let i = 0; i < 40; i++) {
    const from = 5 + (i * 139) % (state.doc.length - 10)
    const transaction = state.update({ changes: { from, insert: i % 3 === 0 ? '\n' : 'a' } })
    state = transaction.state
    scanned = scanEditorMath(state.doc.toString(), 'markdown', scanned.tree, transaction.changes)
    const fresh = scanEditorMath(state.doc.toString(), 'markdown')
    assert.deepEqual(scanned.ranges, fresh.ranges)
    assert.deepEqual(scanned.code, fresh.code)
  }
  assert.notEqual(scanned.tree, original)
})
