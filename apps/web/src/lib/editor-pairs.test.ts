import assert from 'node:assert/strict'
import test from 'node:test'
import { EditorSelection, EditorState, type StateCommand } from '@codemirror/state'
import { history, undo } from '@codemirror/commands'
import { deleteEditorPair, insertEditorPair } from './editor-pairs'

const deleteLatexPair = deleteEditorPair('latex')
const insertLatexPair = (key: string) => insertEditorPair(key, 'latex')

function run(state: EditorState, command: StateCommand) {
  let next = state
  const handled = command({ state, dispatch: transaction => { next = transaction.state } })
  return { state: next, handled }
}

function input(state: EditorState, key: string) {
  const result = run(state, insertLatexPair(key))
  return result.handled ? result.state : state.update(state.replaceSelection(key)).state
}

for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}'], ['$', '$']]) {
  test(`${open}${close}: inserts both sides, places the caret inside, and undoes together`, () => {
    const initial = EditorState.create({ extensions: [history()] })
    const state = input(initial, open)
    assert.equal(state.doc.toString(), open + close)
    assert.equal(state.selection.main.head, 1)
    assert.equal(run(state, undo).state.doc.toString(), '')
    assert.equal(run(state, deleteLatexPair).state.doc.toString(), '')
  })

  test(`${open}${close}: wraps selected text and keeps reverse selection`, () => {
    const initial = EditorState.create({ doc: 'text', selection: { anchor: 4, head: 0 } })
    const state = input(initial, open)
    assert.equal(state.doc.toString(), open + 'text' + close)
    assert.equal(state.selection.main.anchor, 5)
    assert.equal(state.selection.main.head, 1)
  })

  test(`${open}${close}: skips the existing closing delimiter`, () => {
    const initial = EditorState.create({ doc: open + 'x' + close, selection: { anchor: 2 } })
    const state = input(initial, close)
    assert.equal(state.doc.toString(), initial.doc.toString())
    assert.equal(state.selection.main.head, 3)
  })
}

test('two opening dollars produce display math, and two closing dollars skip both sides', () => {
  let state = input(input(EditorState.create(), '$'), '$')
  assert.equal(state.doc.toString(), '$$$$')
  assert.equal(state.selection.main.head, 2)
  assert.equal(run(state, deleteLatexPair).state.doc.toString(), '')
  state = state.update(state.replaceSelection('x')).state
  state = input(input(state, '$'), '$')
  assert.equal(state.doc.toString(), '$$x$$')
  assert.equal(state.selection.main.head, 5)
})

test('closes unfinished inline and display math without inserting an extra pair', () => {
  for (const [doc, expected, keys] of [['$x', '$x$', '$'], ['$$x', '$$x$$', '$$']]) {
    let state = EditorState.create({ doc, selection: { anchor: doc.length } })
    for (const key of keys) state = input(state, key)
    assert.equal(state.doc.toString(), expected)
  }
})

test('does not upgrade the boundary between two adjacent formulas', () => {
  const state = input(EditorState.create({ doc: '$x$$y$', selection: { anchor: 3 } }), '$')
  assert.equal(state.doc.toString(), '$x$$y$')
})

test('escaped dollar and delimiters remain literal input, even/odd backslashes are distinguished', () => {
  for (const key of ['$', '(', '[', '{']) {
    const state = input(EditorState.create({ doc: '\\', selection: { anchor: 1 } }), key)
    assert.equal(state.doc.toString(), '\\' + key)
  }
  const state = input(EditorState.create({ doc: '\\\\', selection: { anchor: 2 } }), '$')
  assert.equal(state.doc.toString(), '\\\\$$')
})

test('nested brackets are inserted inside the existing pair', () => {
  const state = input(input(EditorState.create(), '{'), '(')
  assert.equal(state.doc.toString(), '{()}')
  assert.equal(state.selection.main.head, 2)
})

test('multiple cursors insert and delete independent pairs', () => {
  const initial = EditorState.create({
    doc: 'a b',
    selection: EditorSelection.create([EditorSelection.cursor(1), EditorSelection.cursor(3)]),
    extensions: [EditorState.allowMultipleSelections.of(true)],
  })
  const state = input(initial, '(')
  assert.equal(state.doc.toString(), 'a() b()')
  assert.deepEqual(state.selection.ranges.map(range => range.head), [2, 6])
  assert.equal(run(state, deleteLatexPair).state.doc.toString(), initial.doc.toString())
})

test('mixed multi-cursor contexts retain normal input for escaped characters', () => {
  const initial = EditorState.create({
    doc: '\\ a',
    selection: EditorSelection.create([EditorSelection.cursor(1), EditorSelection.cursor(3)]),
    extensions: [EditorState.allowMultipleSelections.of(true)],
  })
  assert.equal(input(initial, '$').doc.toString(), '\\$ a$$')
})

test('Backspace leaves escaped pairs, nonempty selections and ordinary text to CodeMirror', () => {
  for (const [doc, position] of [['\\{}', 2], ['abc', 2], ['', 0]] as const) {
    const state = EditorState.create({ doc, selection: { anchor: position } })
    assert.equal(run(state, deleteLatexPair).handled, false)
  }
  const selected = EditorState.create({ doc: '{}', selection: { anchor: 0, head: 2 } })
  assert.equal(run(selected, deleteLatexPair).handled, false)
})

test('readonly and unrelated keys are not handled', () => {
  const state = EditorState.create({ doc: '()', selection: { anchor: 1 }, extensions: [EditorState.readOnly.of(true)] })
  assert.equal(run(state, insertLatexPair('(')).handled, false)
  assert.equal(run(state, deleteLatexPair).handled, false)
  assert.equal(run(EditorState.create(), insertLatexPair('a')).handled, false)
})

for (const language of ['markdown', 'python', 'javascript', 'typescript', 'json', 'html', 'css', 'plaintext']) {
  test(`${language}: shared brackets insert, wrap, skip and delete`, () => {
    for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}']]) {
      const paired = run(EditorState.create(), insertEditorPair(open, language)).state
      assert.equal(paired.doc.toString(), open + close)
      assert.equal(run(paired, deleteEditorPair(language)).state.doc.toString(), '')
      assert.equal(run(paired, insertEditorPair(close, language)).state.selection.main.head, 2)
      const selected = EditorState.create({ doc: 'x', selection: { anchor: 1, head: 0 } })
      assert.equal(run(selected, insertEditorPair(close, language)).state.doc.toString(), open + 'x' + close)
    }
    if (language !== 'markdown') {
      assert.equal(run(EditorState.create(), insertEditorPair('$', language)).handled, false)
      assert.equal(run(EditorState.create({ doc: '$$', selection: { anchor: 1 } }), deleteEditorPair(language)).handled, false)
    }
  })
}

test('Markdown dollars support display upgrade, deletion, wrapping and unfinished math', () => {
  const insert = (state: EditorState) => {
    const result = run(state, insertEditorPair('$', 'markdown'))
    return result.handled ? result.state : state.update(state.replaceSelection('$')).state
  }
  const display = insert(insert(EditorState.create()))
  assert.equal(display.doc.toString(), '$$$$')
  assert.equal(run(display, deleteEditorPair('markdown')).state.doc.toString(), '')
  const selection = EditorState.create({ doc: 'x', selection: { anchor: 0, head: 1 } })
  assert.equal(insert(selection).doc.toString(), '$x$')
  for (const doc of ['50% $x', '`$` $x', '```js\n$\n```\n$x', '\\( prose $x']) {
    assert.equal(insert(EditorState.create({ doc, selection: { anchor: doc.length } })).doc.toString(), doc + '$')
  }
  const adjacent = EditorState.create({ doc: '$x$$y$', selection: { anchor: 3 } })
  assert.equal(insert(adjacent).doc.toString(), '$x$$y$')
})

test('Markdown code regions and escaped dollars remain literal, prose after code is enabled', () => {
  for (const [doc, anchor] of [['`x`', 2], ['```python\nx\n```', 11], ['```\nx', 5], ['    x', 5], ['\\', 1]] as const) {
    const state = EditorState.create({ doc, selection: { anchor } })
    assert.equal(run(state, insertEditorPair('$', 'markdown')).handled, false, doc)
  }
  for (const doc of ['`x`', '```\nx\n```', '`$` ']) {
    const state = EditorState.create({ doc, selection: { anchor: doc.length } })
    assert.equal(run(state, insertEditorPair('$', 'markdown')).state.doc.toString(), doc + '$$')
  }
  const codePair = EditorState.create({ doc: '`$$`', selection: { anchor: 2 } })
  assert.equal(run(codePair, deleteEditorPair('markdown')).handled, false)
})

test('selection-only quotes and angles preserve reverse selections without auto-insertion', () => {
  for (const [key, expected] of [["'", "'text'"], ['"', '"text"'], ['`', '`text`'], ['<', '<text>'], ['>', '<text>']]) {
    assert.equal(run(EditorState.create(), insertEditorPair(key, 'python')).handled, false)
    const initial = EditorState.create({ doc: 'text', selection: { anchor: 4, head: 0 } })
    const state = run(initial, insertEditorPair(key, 'python')).state
    assert.equal(state.doc.toString(), expected)
    assert.equal(state.selection.main.anchor, 5)
    assert.equal(state.selection.main.head, 1)
  }
})

test('mixed selection-only ranges keep empty cursors unchanged', () => {
  const initial = EditorState.create({
    doc: 'x y', selection: EditorSelection.create([EditorSelection.range(0, 1), EditorSelection.cursor(3)]),
    extensions: [EditorState.allowMultipleSelections.of(true)],
  })
  assert.equal(run(initial, insertEditorPair('"', 'python')).state.doc.toString(), '"x" y')
})
