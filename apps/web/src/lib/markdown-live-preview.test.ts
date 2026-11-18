import assert from 'node:assert/strict'
import test from 'node:test'
import { Compartment, EditorSelection, EditorState } from '@codemirror/state'
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

test('read-only state can reveal source without mutating it; no Markdown tree means no replacements', () => {
  let state = EditorState.create({ doc: '# title\n\nparagraph', extensions: [EditorState.readOnly.of(true), markdownMathPreview, markdownLivePreview] })
  state = state.update({ selection: { anchor: 12 } }).state
  assert.equal(state.readOnly, true)
  assert.equal(state.doc.toString(), '# title\n\nparagraph')
  assert.deepEqual(widgets(state).map(widget => widget.source), ['# title'])
  state = EditorState.create({ doc: 'ordinary text', extensions: [markdownLivePreview] })
  assert.deepEqual(widgets(state), [])
})
