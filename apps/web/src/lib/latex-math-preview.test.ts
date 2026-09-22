import assert from 'node:assert/strict'
import test from 'node:test'
import { Compartment, EditorState } from '@codemirror/state'
import { showTooltip } from '@codemirror/view'
import { blockLatexMathPreview, focusLatexMathPreview, hideLatexMathPreview, latexMathPreview, latexMathPreviewState } from './latex-math-preview'
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
