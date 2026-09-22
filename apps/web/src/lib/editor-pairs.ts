import { EditorSelection, type EditorState, type StateCommand } from '@codemirror/state'
import { mathAtPosition } from './latex-math'
import { scanEditorMath } from './editor-math'

const openingPairs: Record<string, string> = { '(': ')', '[': ']', '{': '}', '$': '$' }
const closingPairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' }
// Quotes and angle brackets keep their existing selection-only behavior.
const selectionPairs: Record<string, readonly [string, string]> = {
  "'": ["'", "'"], '"': ['"', '"'], '`': ['`', '`'], '<': ['<', '>'], '>': ['<', '>'],
}

function isEscaped(state: EditorState, position: number) {
  let backslashes = 0
  while (position > 0 && state.sliceDoc(position - 1, position) === '\\') {
    backslashes++
    position--
  }
  return backslashes % 2 === 1
}

export function insertEditorPair(key: string, language: string): StateCommand {
  return ({ state, dispatch }) => {
    const dollars = language === 'latex' || language === 'markdown'
    const selectionOnly = Object.hasOwn(selectionPairs, key)
    if (state.readOnly || (key === '$' && !dollars)
      || !(Object.hasOwn(openingPairs, key) || Object.hasOwn(closingPairs, key) || selectionOnly)) return false
    const math = key === '$' ? scanEditorMath(state.doc.toString(), language) : undefined
    let handled = false
    const transaction = state.changeByRange(range => {
      const { from, to } = range
      const next = state.sliceDoc(to, to + 1)
      const normalInput = () => ({ changes: { from, to, insert: key }, range: EditorSelection.cursor(from + 1) })
      if (selectionOnly && range.empty) return { range }
      if (key === '$' && math?.code.some(code => from >= code.from && (from < code.to || (code.includeEnd && from === code.to)))) return normalInput()
      // In TeX, \( must not become \(). Markdown only escapes dollar math.
      if ((language === 'latex' || (language === 'markdown' && key === '$')) && isEscaped(state, from)) return normalInput()

      if (!range.empty) {
        const [open, close] = selectionPairs[key] ?? [closingPairs[key] ?? key, openingPairs[closingPairs[key] ?? key]]
        handled = true
        return {
          changes: [{ from, insert: open }, { from: to, insert: close }],
          range: EditorSelection.range(range.anchor + 1, range.head + 1),
        }
      }

      if (key === '$') {
        // Upgrade a fresh $|$ to $$|$$, but not the $x$|$y$ boundary.
        if (state.sliceDoc(Math.max(0, from - 1), from) === '$' && next === '$'
          && state.sliceDoc(Math.max(0, from - 2), from - 1) !== '$'
          && state.sliceDoc(from + 1, from + 2) !== '$'
          && !isEscaped(state, from - 1)
          && !math!.ranges.some(item => item.complete && item.to === from - 1)) {
          handled = true
          return { changes: { from, insert: '$$' }, range: EditorSelection.cursor(from + 1) }
        }
      }
      if ((Object.hasOwn(closingPairs, key) || key === '$') && next === key) {
        handled = true
        return { range: EditorSelection.cursor(from + 1) }
      }
      if (Object.hasOwn(closingPairs, key)) return normalInput()
      // Unfinished math needs one closing dollar, not another pair.
      const context = math ? mathAtPosition(math.ranges, from) : undefined
      if (context && state.sliceDoc(context.from - 1, context.from) === '$') return normalInput()
      handled = true
      return { changes: { from, insert: key + openingPairs[key] }, range: EditorSelection.cursor(from + 1) }
    })
    if (!handled) return false
    dispatch(state.update({ ...transaction, scrollIntoView: true, userEvent: transaction.changes.empty ? 'select' : 'input.type' }))
    return true
  }
}

export function deleteEditorPair(language: string): StateCommand {
  return ({ state, dispatch }) => {
    if (state.readOnly) return false
    const dollars = language === 'latex' || language === 'markdown'
    const code = language === 'markdown' && state.selection.ranges.some(range => range.from > 0 && state.sliceDoc(range.from - 1, range.from) === '$')
      ? scanEditorMath(state.doc.toString(), language).code : []
    const pairs = state.selection.ranges.map(range => {
      if (!range.empty || range.from === 0 || (language === 'latex' && isEscaped(state, range.from - 1))) return null
      const { from } = range
      const open = state.sliceDoc(from - 1, from)
      if (open === '$' && (!dollars || isEscaped(state, from - 1) || code.some(range => from >= range.from && (from < range.to || (range.includeEnd && from === range.to))))) return null
      if (dollars && from >= 2 && state.sliceDoc(from - 2, from + 2) === '$$$$' && !isEscaped(state, from - 2)) {
        return { from: from - 2, to: from + 2 }
      }
      return openingPairs[open] === state.sliceDoc(from, from + 1) ? { from: from - 1, to: from + 1 } : null
    })
    // Delegate mixed selections and ordinary deletion to native CM behavior.
    if (pairs.some((pair, index) => pair === null || (index > 0 && pairs[index - 1]!.to > pair.from))) return false
    let index = 0
    dispatch(state.update({
      ...state.changeByRange(() => {
        const pair = pairs[index++]!
        return { changes: pair, range: EditorSelection.cursor(pair.from) }
      }),
      scrollIntoView: true,
      userEvent: 'delete.backward',
    }))
    return true
  }
}
