import assert from 'node:assert/strict'
import test from 'node:test'
import { Compartment, EditorSelection, EditorState, type StateEffect, type TransactionSpec } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { markdownMathPreview } from './latex-math-preview'
import { markdownLivePreview, markdownLivePreviewState } from './markdown-live-preview'

function create(doc: string, anchor = 0) {
  return EditorState.create({ doc, selection: { anchor }, extensions: [markdownMathPreview, markdownLivePreview] })
}

function widgets(state: EditorState) {
  const result: { from: number; to: number; source: string; references: string }[] = []
  for (let cursor = state.field(markdownLivePreviewState).decorations.iter(); cursor.value; cursor.next()) {
    result.push({ from: cursor.from, to: cursor.to, source: cursor.value.spec.widget.source, references: cursor.value.spec.widget.references })
  }
  return result
}

test('keeps the active block as source and renders inactive headings, paragraphs, code and math', () => {
  const doc = '# Title\n\nparagraph **bold**\n\n```js\n$x$\n```\n\n$$\nx+1\n$$\n'
  let state = create(doc)
  assert.deepEqual(widgets(state).map(widget => widget.source), ['paragraph **bold**', '```js\n$x$\n```', '$$\nx+1\n$$'])
  state = state.update({ selection: { anchor: doc.indexOf('bold') } }).state
  assert.equal(widgets(state)[0].source, '# Title')
  assert.ok(widgets(state).every(widget => !widget.source.includes('bold')))
  assert.equal(state.doc.toString(), doc)
})

test('lists and GFM tables render as whole blocks; formulas spanning CommonMark blocks fall back to source', () => {
  const state = create('# Title\n\n- first\n- second\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n$$\nx+1\n---\ny-1\n$$\n\ntail\n')
  const sources = widgets(state).map(widget => widget.source)
  assert.ok(sources.some(source => source.startsWith('- first')))
  assert.ok(sources.some(source => source.startsWith('| a | b |')))
  assert.ok(sources.includes('tail'))
  assert.ok(sources.every(source => !source.includes('$$')))
})

test('multi-selection reveals every intersecting block; selecting all reveals all source', () => {
  const doc = '# Title\n\nfirst paragraph\n\nsecond paragraph\n'
  let state = EditorState.create({ doc, extensions: [EditorState.allowMultipleSelections.of(true), markdownMathPreview, markdownLivePreview],
    selection: EditorSelection.create([EditorSelection.cursor(2), EditorSelection.cursor(doc.indexOf('second') + 2)]) })
  assert.deepEqual(widgets(state).map(widget => widget.source), ['first paragraph'])
  state = state.update({ selection: { anchor: 0, head: state.doc.length } }).state
  assert.deepEqual(widgets(state), [])
})

test('newline edits update offsets and re-evaluate block boundaries without changing untouched widgets', () => {
  let state = create('# Title\n\nparagraph\n\n$x$\n')
  const before = state.field(markdownLivePreviewState).decorations.iter().value.spec.widget
  state = state.update({ changes: { from: 0, insert: '\n' }, selection: { anchor: 2 } }).state
  const after = state.field(markdownLivePreviewState).decorations.iter().value.spec.widget
  assert.ok(after.eq(before))
  assert.equal(widgets(state)[0].from, 10)
  state = state.update({ changes: { from: 10, insert: '```\n' } }).state
  assert.ok(widgets(state).some(widget => widget.source.startsWith('```\nparagraph')))
})

test('link definitions stay editable source and are supplied to each rendered block', () => {
  const doc = '# Title\n\n[link][ref]\n\n[ref]: https://example.com/old\n'
  let state = create(doc)
  assert.equal(widgets(state).length, 1)
  assert.match(widgets(state)[0].references, /example.com\/old/)
  const before = state.field(markdownLivePreviewState).decorations.iter().value.spec.widget
  const from = doc.indexOf('/old')
  state = state.update({ changes: { from, to: from + 4, insert: '/new' } }).state
  assert.match(widgets(state)[0].references, /example.com\/new/)
  assert.equal(state.field(markdownLivePreviewState).decorations.iter().value.spec.widget.eq(before), false)
})

test('raw HTML and its contents stay source; mode changes preserve the exact document and selection', () => {
  const doc = '# Title\n\n<div>\nhtml\n</div>\n\nparagraph\n'
  const compartment = new Compartment()
  let state = EditorState.create({ doc, selection: { anchor: 2 }, extensions: [markdownMathPreview, compartment.of(markdownLivePreview)] })
  assert.deepEqual(widgets(state).map(widget => widget.source), ['paragraph'])
  state = state.update({ effects: compartment.reconfigure([]) }).state
  assert.equal(state.field(markdownLivePreviewState, false), undefined)
  assert.equal(state.doc.toString(), doc)
  assert.equal(state.selection.main.head, 2)
  state = state.update({ effects: compartment.reconfigure(markdownLivePreview) }).state
  assert.deepEqual(widgets(state).map(widget => widget.source), ['paragraph'])
  assert.equal(state.doc.toString(), doc)
})

test('block replacements include their boundaries without consuming real blank source lines', () => {
  const doc = '\n\n# Title\n\n\nparagraph\n\n\n\n```js\n\ncode\n\n```\n\n'
  let state = create(doc)
  const blocks = widgets(state)
  for (let number = 1; number <= state.doc.lines; number++) {
    const line = state.doc.line(number)
    if (line.text || blocks.some(block => line.from >= block.from && line.from <= block.to)) continue
    state = state.update({ selection: { anchor: line.from } }).state
    assert.equal(widgets(state).length, 3)
    for (let cursor = state.field(markdownLivePreviewState).decorations.iter(); cursor.value; cursor.next()) {
      assert.equal(cursor.value.spec.block, true)
      assert.equal(cursor.value.spec.inclusive, true, 'exclusive block edges insert phantom text lines')
      assert.equal(state.doc.lineAt(cursor.from).from, cursor.from)
      assert.equal(state.doc.lineAt(cursor.to).to, cursor.to)
    }
    assert.equal(state.doc.toString(), doc)
  }
})

test('widget activation anchors to its screen position instead of a generic scroll-to-caret request', () => {
  const state = create('# Title\n\nparagraph')
  const widget = state.field(markdownLivePreviewState).decorations.iter().value.spec.widget
  const handlers = new Map<string, (event: MouseEvent) => void>()
  const ownerDocument = { caretPositionFromPoint: () => null, caretRangeFromPoint: () => null }
  const dom = {
    ownerDocument, isConnected: true,
    setAttribute: () => {},
    addEventListener: (name: string, handler: (event: MouseEvent) => void) => { handlers.set(name, handler) },
    getBoundingClientRect: () => ({ top: 240, height: 24 }),
  }
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const dispatched: TransactionSpec[] = []
  let focused = false
  try {
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => dom } })
    widget.toDOM({ state, composing: false, posAtDOM: () => 9,
      scrollDOM: { clientHeight: 400, getBoundingClientRect: () => ({ top: 100 }) },
      dispatch: (spec: TransactionSpec) => { dispatched.push(spec) },
      focus: () => { focused = true },
    } as unknown as EditorView)
    handlers.get('mousedown')!({ button: 0, clientX: 20, clientY: 245, preventDefault: () => {} } as MouseEvent)
    assert.equal(focused, true)
    assert.equal(dispatched.length, 1)
    assert.equal(dispatched[0].changes, undefined)
    assert.notEqual(dispatched[0].scrollIntoView, true)
    const target = (dispatched[0].effects as StateEffect<unknown>).value as { y: string; yMargin: number }
    assert.equal(target.y, 'start')
    assert.equal(target.yMargin, 140)
    assert.equal(state.doc.toString(), '# Title\n\nparagraph')
  } finally {
    if (previous) Object.defineProperty(globalThis, 'document', previous)
    else Reflect.deleteProperty(globalThis, 'document')
  }
})

test('read-only state can reveal source without mutating it; no Markdown tree means no replacements', () => {
  let state = EditorState.create({ doc: '# title\n\nparagraph', extensions: [EditorState.readOnly.of(true), markdownMathPreview, markdownLivePreview] })
  state = state.update({ selection: { anchor: 12 } }).state
  assert.equal(state.readOnly, true)
  assert.equal(state.doc.toString(), '# title\n\nparagraph')
  assert.deepEqual(widgets(state).map(widget => widget.source), ['# title'])
  state = EditorState.create({ doc: 'ordinary text', extensions: [markdownLivePreview] })
  assert.deepEqual(widgets(state), [])
})
