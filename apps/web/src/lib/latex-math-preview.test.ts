import assert from 'node:assert/strict'
import test from 'node:test'
import { Compartment, EditorState } from '@codemirror/state'
import { showTooltip } from '@codemirror/view'
import { blockLatexMathPreview, focusLatexMathPreview, hideLatexMathPreview, latexMathPreview, latexMathPreviewState, markdownMathPreview } from './latex-math-preview'
import type { EditorView } from '@codemirror/view'

function focusedState() {
  return EditorState.create({ doc: '$x^2$ text', selection: { anchor: 2 }, extensions: [latexMathPreview] })
    .update({ effects: focusLatexMathPreview.of(true) }).state
}

function tooltipCount(state: EditorState) {
  return state.facet(showTooltip).filter(Boolean).length
}

test('only shows previews while focused and inside math', () => {
  let state = focusedState()
  assert.equal(tooltipCount(state), 1)
  state = state.update({ selection: { anchor: 8 } }).state
  assert.equal(tooltipCount(state), 0)
  state = state.update({ selection: { anchor: 2 }, effects: focusLatexMathPreview.of(false) }).state
  assert.equal(tooltipCount(state), 0)
})

test('completion temporarily suppresses the preview without losing the formula', () => {
  let state = focusedState()
  state = state.update({ effects: blockLatexMathPreview.of(true) }).state
  assert.equal(tooltipCount(state), 0)
  state = state.update({ effects: blockLatexMathPreview.of(false) }).state
  assert.equal(tooltipCount(state), 1)
})

test('Escape dismisses until the next edit or cursor move', () => {
  let state = focusedState()
  const view = {
    get state() { return state },
    dispatch: (spec: Parameters<EditorState['update']>[0]) => { state = state.update(spec).state },
  } as unknown as EditorView
  assert.equal(hideLatexMathPreview(view), true)
  assert.equal(tooltipCount(state), 0)
  assert.equal(hideLatexMathPreview(view), false)
  state = state.update({ changes: { from: 2, insert: '+' } }).state
  assert.equal(tooltipCount(state), 1)
  assert.equal(state.field(latexMathPreviewState).ranges[0].source, 'x+^2')
})

test('cursor moves reuse scanned ranges and language switches remove the extension', () => {
  const compartment = new Compartment()
  let state = EditorState.create({ doc: '$x$', extensions: [compartment.of(latexMathPreview)] })
  const ranges = state.field(latexMathPreviewState).ranges
  state = state.update({ selection: { anchor: 2 }, effects: focusLatexMathPreview.of(true) }).state
  assert.equal(state.field(latexMathPreviewState).ranges, ranges)
  assert.equal(tooltipCount(state), 1)
  state = state.update({ effects: compartment.reconfigure([]) }).state
  assert.equal(tooltipCount(state), 0)
  assert.equal(state.field(latexMathPreviewState, false), undefined)
})

function markdownState(doc: string, anchor: number) {
  return EditorState.create({ doc, selection: { anchor }, extensions: [markdownMathPreview] })
    .update({ effects: focusLatexMathPreview.of(true) }).state
}

test('Markdown previews inline, display and unfinished dollar math, including percent signs', () => {
  for (const [doc, anchor, source, display, complete] of [
    ['$x^2$', 2, 'x^2', false, true],
    ['$$\nx+1\n$$', 5, '\nx+1\n', true, true],
    ['50% $x$', 6, 'x', false, true],
    ['$x', 2, 'x', false, false],
    ['$50\\% + x$', 6, '50\\% + x', false, true],
  ] as const) {
    const state = markdownState(doc, anchor)
    assert.equal(tooltipCount(state), 1, doc)
    const range = state.field(latexMathPreviewState).ranges[0]
    assert.deepEqual([range.source, range.display, range.complete], [source, display, complete])
  }
})

test('Markdown excludes code and escaped dollars, without treating TeX prose as math', () => {
  for (const [doc, anchor] of [
    ['`$x$`', 3],
    ['```tex\n$x$\n```', 9],
    ['~~~\n$$x$$\n~~~', 6],
    ['    $x$', 6],
    ['\\$x', 3],
    ['\\(x\\)', 3],
    ['$oops\n```\n$x$\n```', 11],
    ['$oops `$x$`', 9],
  ] as const) {
    assert.equal(tooltipCount(markdownState(doc, anchor)), 0, doc)
  }
  const doc = '`$hidden$` then $visible$'
  const state = markdownState(doc, doc.length - 2)
  assert.equal(tooltipCount(state), 1)
  assert.equal(state.field(latexMathPreviewState).ranges[0].source, 'visible')
})

test('Markdown edits rescan, cursor moves reuse ranges, Escape and blur hide previews', () => {
  let state = markdownState('$x$', 2)
  const ranges = state.field(latexMathPreviewState).ranges
  state = state.update({ selection: { anchor: 1 } }).state
  assert.equal(state.field(latexMathPreviewState).ranges, ranges)
  const view = {
    get state() { return state },
    dispatch: (spec: Parameters<EditorState['update']>[0]) => { state = state.update(spec).state },
  } as unknown as EditorView
  assert.equal(hideLatexMathPreview(view), true)
  assert.equal(tooltipCount(state), 0)
  state = state.update({ changes: { from: 2, insert: '+1' } }).state
  assert.equal(tooltipCount(state), 1)
  assert.equal(state.field(latexMathPreviewState).ranges[0].source, 'x+1')
  state = state.update({ effects: focusLatexMathPreview.of(false) }).state
  assert.equal(tooltipCount(state), 0)
})

test('switching LaTeX and Markdown rescans unchanged text and clears stale blocking', () => {
  const compartment = new Compartment()
  let state = EditorState.create({ doc: '50% $x$', selection: { anchor: 6 }, extensions: [compartment.of(latexMathPreview)] })
    .update({ effects: [focusLatexMathPreview.of(true), blockLatexMathPreview.of(true)] }).state
  assert.equal(tooltipCount(state), 0)
  state = state.update({ effects: compartment.reconfigure(markdownMathPreview) }).state
  assert.equal(tooltipCount(state), 1)
  state = state.update({ effects: compartment.reconfigure(latexMathPreview) }).state
  assert.equal(tooltipCount(state), 0)
  state = state.update({ effects: compartment.reconfigure(markdownMathPreview) }).state
  assert.equal(tooltipCount(state), 1)
  state = state.update({ effects: compartment.reconfigure([]) }).state
  assert.equal(tooltipCount(state), 0)
})
