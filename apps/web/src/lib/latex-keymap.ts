import { EditorSelection, Prec, type StateCommand } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import { toggleLineComment } from '@codemirror/commands'

// Keep the contents selected so typing replaces them; empty selections leave
// the caret inside the braces. changeByRange also handles multiple cursors.
export function wrapLatexCommand(command: string): StateCommand {
  return ({ state, dispatch }) => {
    if (state.readOnly) return false
    const open = `\\${command}{`
    dispatch(state.update({
      ...state.changeByRange(range => ({
        changes: [
          { from: range.from, insert: open },
          { from: range.to, insert: '}' },
        ],
        range: EditorSelection.range(range.anchor + open.length, range.head + open.length),
      })),
      scrollIntoView: true,
      userEvent: 'input.format',
    }))
    return true
  }
}

export const latexKeymap = Prec.high(keymap.of([
  { key: 'Mod-b', run: wrapLatexCommand('textbf'), preventDefault: true },
  { key: 'Mod-i', run: wrapLatexCommand('textit'), preventDefault: true },
  { key: 'Mod-u', run: wrapLatexCommand('underline'), preventDefault: true },
  { key: 'Mod-/', run: toggleLineComment, preventDefault: true },
]))
