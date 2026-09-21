import assert from 'node:assert/strict'
import test from 'node:test'
import { EditorSelection, EditorState, type StateCommand } from '@codemirror/state'
import { history, toggleLineComment, undo } from '@codemirror/commands'
import { wrapLatexCommand } from './latex-keymap'

function run(state: EditorState, command: StateCommand) {
  let next = state
  command({ state, dispatch: transaction => { next = transaction.state } })
  return next
}

for (const command of ['textbf', 'textit', 'underline']) {
  test(`${command}: wraps selection and supports undo`, () => {
    const state = EditorState.create({ doc: '你好 world', selection: { anchor: 2, head: 0 }, extensions: [history()] })
    const next = run(state, wrapLatexCommand(command))
    assert.equal(next.doc.toString(), `\\${command}{你好} world`)
    assert.equal(next.sliceDoc(next.selection.main.from, next.selection.main.to), '你好')
    assert.ok(next.selection.main.anchor > next.selection.main.head)
    assert.equal(run(next, undo).doc.toString(), state.doc.toString())
  })
}

test('empty selection puts the caret inside braces', () => {
  const next = run(EditorState.create(), wrapLatexCommand('textbf'))
  assert.equal(next.doc.toString(), '\\textbf{}')
  assert.equal(next.selection.main.head, 8)
  assert.ok(next.selection.main.empty)
})

test('multiple selections are mapped independently', () => {
  const state = EditorState.create({
    doc: 'a b',
    selection: EditorSelection.create([EditorSelection.range(0, 1), EditorSelection.cursor(3)]),
    extensions: [EditorState.allowMultipleSelections.of(true)],
  })
  const next = run(state, wrapLatexCommand('textit'))
  assert.equal(next.doc.toString(), '\\textit{a} b\\textit{}')
  assert.equal(next.selection.ranges.length, 2)
  assert.equal(next.selection.ranges[1].head, next.doc.length - 1)
})

test('line comments toggle across selected lines without touching the next line', () => {
  const state = EditorState.create({
    doc: '  first\n  second\nthird',
    selection: { anchor: 0, head: 17 },
    extensions: [EditorState.languageData.of(() => [{ commentTokens: { line: '%' } }])],
  })
  const commented = run(state, toggleLineComment)
  assert.equal(commented.doc.toString(), '  % first\n  % second\nthird')
  assert.equal(run(commented, toggleLineComment).doc.toString(), state.doc.toString())
})

test('line comments work at a cursor and preserve escaped percent signs', () => {
  const state = EditorState.create({
    doc: 'cost \\% value',
    extensions: [EditorState.languageData.of(() => [{ commentTokens: { line: '%' } }])],
  })
  const commented = run(state, toggleLineComment)
  assert.equal(commented.doc.toString(), '% ' + state.doc.toString())
  assert.equal(run(commented, toggleLineComment).doc.toString(), state.doc.toString())
})

test('readonly documents are not changed', () => {
  const state = EditorState.create({ doc: 'text', extensions: [EditorState.readOnly.of(true)] })
  assert.equal(run(state, wrapLatexCommand('textbf')), state)
})
