import katex from 'katex'
import { Facet, StateEffect, StateField, type Extension } from '@codemirror/state'
import { EditorView, showTooltip, type Tooltip } from '@codemirror/view'
import { mathAtPosition, type LatexMathRange } from './latex-math'
import { scanEditorMath } from './editor-math'

export const blockLatexMathPreview = StateEffect.define<boolean>()
export const focusLatexMathPreview = StateEffect.define<boolean>()
const dismissPreview = StateEffect.define<null>()
const previewDialect = Facet.define<'latex' | 'markdown', 'latex' | 'markdown'>({
  combine: values => values[0] ?? 'latex',
})

interface PreviewState {
  ranges: LatexMathRange[]
  focused: boolean
  blocked: boolean
  dismissed: boolean
}

export const latexMathPreviewState = StateField.define<PreviewState>({
  create: state => ({ ranges: scanEditorMath(state.doc.toString(), state.facet(previewDialect)).ranges, focused: false, blocked: false, dismissed: false }),
  update(value, transaction) {
    let next = value
    const dialect = transaction.state.facet(previewDialect)
    const dialectChanged = dialect !== transaction.startState.facet(previewDialect)
    if (transaction.docChanged || transaction.selection || dialectChanged) {
      next = {
        ...value,
        ranges: transaction.docChanged || dialectChanged
          ? scanEditorMath(transaction.newDoc.toString(), dialect).ranges : value.ranges,
        blocked: dialectChanged ? false : value.blocked,
        dismissed: false,
      }
    }
    for (const effect of transaction.effects) {
      if (effect.is(blockLatexMathPreview)) next = { ...next, blocked: effect.value }
      if (effect.is(focusLatexMathPreview)) next = { ...next, focused: effect.value }
      if (effect.is(dismissPreview)) next = { ...next, dismissed: true }
    }
    return next
  },
})

// CodeMirror reuses a tooltip view by its `create` function identity. Keep
// that identity for a scanned formula while allowing the anchor to follow
// the caret. Weak keys release old entries after edits or editor disposal.
const formulaTooltips = new WeakMap<LatexMathRange, Tooltip>()

function previewTooltip(range: LatexMathRange, position: number): Tooltip {
  const cached = formulaTooltips.get(range)
  if (cached) return { ...cached, pos: position }
  const tooltip: Tooltip = {
    pos: position,
    above: true,
    arrow: true,
    create(view) {
      const dom = document.createElement('div')
      dom.className = 'latex-math-preview'
      dom.setAttribute('role', 'status')
      dom.setAttribute('aria-label', 'LaTeX 公式预览')
      // Allow scrolling long formulas without moving focus out of the editor.
      dom.addEventListener('mousedown', event => event.preventDefault())
      const heading = document.createElement('div')
      heading.className = 'latex-math-preview-heading'
      heading.textContent = '公式预览 · Esc 关闭'
      const body = document.createElement('div')
      body.className = 'latex-math-preview-body'
      body.textContent = '正在预览…'
      const note = document.createElement('div')
      note.className = 'latex-math-preview-note'
      note.textContent = view.state.facet(previewDialect) === 'markdown'
        ? 'KaTeX 公式预览' : 'KaTeX 预览，最终效果以编译结果为准'
      dom.append(heading, body, note)
      // No document compilation, network requests, or persisted macro state.
      const timer = window.setTimeout(() => {
        if (!range.source.trim()) {
          body.textContent = '输入公式后将在此预览'
        } else {
          try {
            katex.render(range.source, body, {
              displayMode: range.display,
              throwOnError: true,
              trust: false,
              strict: 'ignore',
              maxExpand: 200,
              maxSize: 20,
            })
            if (!range.complete) note.textContent = '公式分隔符尚未闭合 · 临时预览'
          } catch {
            body.textContent = '公式尚未完整，或含有预览不支持的命令'
          }
        }
        view.requestMeasure()
      }, 150)
      return { dom, destroy: () => window.clearTimeout(timer) }
    },
  }
  formulaTooltips.set(range, tooltip)
  return tooltip
}

export function hideLatexMathPreview(view: EditorView) {
  const value = view.state.field(latexMathPreviewState, false)
  if (!value || !value.focused || value.blocked || value.dismissed) return false
  if (!mathAtPosition(value.ranges, view.state.selection.main.head)) return false
  view.dispatch({ effects: dismissPreview.of(null) })
  return true
}

export const latexMathPreview: Extension = [
  latexMathPreviewState,
  showTooltip.compute([latexMathPreviewState, 'selection'], state => {
    const value = state.field(latexMathPreviewState)
    if (!value.focused || value.blocked || value.dismissed) return null
    const position = state.selection.main.head
    const range = mathAtPosition(value.ranges, position)
    return range ? previewTooltip(range, position) : null
  }),
  EditorView.domEventHandlers({
    focus(_event, view) {
      view.dispatch({ effects: focusLatexMathPreview.of(true) })
    },
    blur(_event, view) {
      view.dispatch({ effects: focusLatexMathPreview.of(false) })
    },
  }),
  EditorView.baseTheme({
    '.cm-tooltip.latex-math-preview': {
      maxWidth: 'min(480px, calc(100vw - 32px))',
      backgroundColor: 'var(--color-bg-card, #fff)',
      color: 'var(--color-text, #222)',
      border: '1px solid var(--color-border, #ddd)',
      borderRadius: '8px',
      boxShadow: '0 4px 18px rgba(0, 0, 0, .15)',
      padding: '10px 12px',
    },
    '.latex-math-preview-heading, .latex-math-preview-note': {
      fontFamily: 'system-ui, sans-serif',
      fontSize: '11px',
      lineHeight: '1.5',
      color: 'var(--color-text-muted, #666)',
    },
    '.latex-math-preview-body': {
      maxHeight: '200px',
      overflow: 'auto',
      padding: '8px 0',
      fontSize: '14px',
    },
    '.latex-math-preview-body .katex-display': { margin: '0' },
  }),
]

export const markdownMathPreview: Extension = [previewDialect.of('markdown'), latexMathPreview]
