import { EditorSelection, StateField, type EditorState } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'
import { latexMathPreviewState } from './latex-math-preview'
import { renderMarkdown } from './markdown'

interface PreviewBlock {
  from: number
  to: number
  source: string
}

interface LivePreviewState {
  blocks: PreviewBlock[]
  references: string
  decorations: DecorationSet
}

class MarkdownBlockWidget extends WidgetType {
  constructor(readonly source: string, readonly references: string) {
    super()
  }

  eq(other: MarkdownBlockWidget) {
    return this.source === other.source && this.references === other.references
  }

  toDOM(view: EditorView) {
    const dom = document.createElement('div')
    dom.className = 'md cm-live-preview-block'
    dom.tabIndex = 0
    dom.setAttribute('role', 'button')
    dom.setAttribute('aria-label', '编辑此 Markdown 内容块')
    dom.title = '点击或按 Enter 编辑此内容块'
    // Widgets are rendered only when CM draws them, not once per document edit.
    dom.innerHTML = renderMarkdown(`${this.source}\n\n${this.references}`)
    const activate = (point?: { x: number; y: number }) => {
      if (!dom.isConnected || view.composing) return
      // Resolve the current range from CM, not a closed-over document offset:
      // an equal widget may have moved after edits in a preceding block.
      const from = view.posAtDOM(dom)
      const lines = this.source.split('\n')
      const rect = dom.getBoundingClientRect()
      const index = point === undefined ? 0 : Math.min(lines.length - 1,
        Math.floor(Math.max(0, point.y - rect.top) / Math.max(1, rect.height) * lines.length))
      let offset = lines.slice(0, index).reduce((length, line) => length + line.length + 1, 0)
      let anchorTop = rect.top + index / lines.length * rect.height
      if (point) {
        const document = dom.ownerDocument
        const caret = document.caretPositionFromPoint?.(point.x, point.y)
        const range = caret ? null : document.caretRangeFromPoint?.(point.x, point.y)
        const node = caret?.offsetNode ?? range?.startContainer
        const at = caret?.offset ?? range?.startOffset ?? 0
        const text = node?.nodeType === 3 ? node.textContent : null
        if (node && text && dom.contains(node)) {
          const sourceOffset = this.source.indexOf(text)
          // Direct text matches preserve click positions in wrapped prose and
          // inline markup. Ambiguous/generated formula text uses the line fallback.
          if (sourceOffset >= 0 && sourceOffset === this.source.lastIndexOf(text)) {
            offset = sourceOffset + at
            const character = document.createRange()
            character.setStart(node, Math.min(at, text.length - 1))
            character.setEnd(node, Math.min(at + 1, text.length))
            const bounds = character.getBoundingClientRect()
            if (bounds.height) anchorTop = bounds.top
          }
        }
      }
      const position = Math.min(view.state.doc.length, from + offset)
      const scroller = view.scrollDOM
      const margin = Math.max(0, Math.min(scroller.clientHeight - 1, anchorTop - scroller.getBoundingClientRect().top))
      // Anchor the clicked text at its existing screen position. A generic
      // scrollIntoView would jump to the start of a long, partly visible block.
      view.dispatch({ selection: EditorSelection.cursor(position),
        effects: EditorView.scrollIntoView(position, { y: 'start', yMargin: margin }) })
      view.focus()
    }
    dom.addEventListener('mousedown', event => {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return
      event.preventDefault()
      activate({ x: event.clientX, y: event.clientY })
    })
    dom.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      activate()
    })
    dom.addEventListener('load', () => { if (dom.isConnected) view.requestMeasure() }, true)
    return dom
  }
}

function collectBlocks(state: EditorState) {
  // The math extension already maintains a full incremental Markdown tree.
  // Sharing it avoids a second synchronous parse just for Live Preview.
  const math = state.field(latexMathPreviewState, false)
  const displayMath = math?.ranges.filter(range => range.display) ?? []
  let mathIndex = 0
  const blocks: PreviewBlock[] = []
  const references: string[] = []
  for (let node = math?.tree?.topNode.firstChild; node; node = node.nextSibling) {
    const source = state.sliceDoc(node.from, node.to)
    while (mathIndex < displayMath.length && displayMath[mathIndex].delimiterTo <= node.from) mathIndex++
    let needsSource = false
    for (let index = mathIndex; index < displayMath.length && displayMath[index].delimiterFrom < node.to; index++) {
      const range = displayMath[index]
      // The Markdown renderer handles dollar blocks, not raw TeX environments.
      if (range.environment || range.delimiterFrom < node.from || range.delimiterTo > node.to) needsSource = true
    }
    // Keep raw HTML and math fragments that cannot be rendered independently as source.
    if (needsSource || node.name === 'HTMLBlock') continue
    if (node.name === 'LinkReference') references.push(source)
    else blocks.push({ from: node.from, to: node.to, source })
  }
  return { blocks, references: references.join('\n') }
}

function decorate(state: EditorState, blocks: PreviewBlock[], references: string) {
  return Decoration.set(blocks.filter(block => !state.selection.ranges.some(range =>
    range.from <= block.to && range.to >= block.from)).map(block =>
    // Inclusive block boundaries avoid phantom text lines on both sides of
    // each widget. Real blank source lines remain untouched and editable.
    Decoration.replace({ widget: new MarkdownBlockWidget(block.source, references), block: true, inclusive: true })
      .range(block.from, block.to)))
}

export const markdownLivePreviewState = StateField.define<LivePreviewState>({
  create(state) {
    const { blocks, references } = collectBlocks(state)
    return { blocks, references, decorations: decorate(state, blocks, references) }
  },
  update(value, transaction) {
    if (!transaction.docChanged && !transaction.selection && !transaction.reconfigured) return value
    const { blocks, references } = transaction.docChanged || transaction.reconfigured
      ? collectBlocks(transaction.state) : value
    return { blocks, references, decorations: decorate(transaction.state, blocks, references) }
  },
  provide: field => EditorView.decorations.from(field, value => value.decorations),
})

export const markdownLivePreview = [
  markdownLivePreviewState,
  EditorView.baseTheme({
    '.cm-live-preview-block': {
      fontFamily: 'system-ui, -apple-system, sans-serif',
      fontSize: 'var(--editor-markdown-font-size, 14px)',
      lineHeight: '1.7',
      whiteSpace: 'normal',
      overflowWrap: 'anywhere',
      padding: '0 4px',
      margin: '0',
      cursor: 'text',
    },
    '.cm-live-preview-block:focus-visible': { outline: '1px solid var(--color-primary)' },
    '.cm-live-preview-block > :first-child': { marginTop: '0' },
    '.cm-live-preview-block > :last-child': { marginBottom: '0' },
    '.cm-live-preview-block pre': { whiteSpace: 'pre-wrap' },
    '.cm-live-preview-block img': { maxWidth: '100%' },
    '.cm-live-preview-block table': { borderCollapse: 'collapse' },
    '.cm-live-preview-block th, .cm-live-preview-block td': { border: '1px solid var(--color-border)', padding: '6px 10px' },
  }),
]
