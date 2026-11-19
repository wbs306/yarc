import { markdownLanguage } from '@codemirror/lang-markdown'
import type { ChangeDesc } from '@codemirror/state'
import { scanLatexMath } from './latex-math'

type MarkdownTree = ReturnType<typeof markdownLanguage.parser.parse>
type MarkdownFragments = NonNullable<Parameters<typeof markdownLanguage.parser.parse>[1]>

export function scanEditorMath(text: string, language: string, previousTree?: MarkdownTree | null, changes?: ChangeDesc) {
  const code: { from: number; to: number; includeEnd: boolean }[] = []
  let tree: MarkdownTree | null = null
  if (language === 'markdown') {
    // Reuse unchanged syntax through the parser's public TreeFragment shape.
    // CM's change description supplies both old/new offsets, including multi-edit
    // transactions. Open edges make the parser recheck changed block boundaries.
    const fragments: MarkdownFragments[number][] = []
    if (previousTree && changes) {
      changes.iterGaps((fromA, fromB, length) => {
        if (!length) return
        fragments.push({ from: fromB, to: fromB + length, tree: previousTree,
          offset: fromA - fromB, openStart: fromA > 0, openEnd: fromA + length < changes.length })
      })
    }
    tree = markdownLanguage.parser.parse(text, fragments)
    // Mask code while preserving offsets and blank lines. Dollars in code must
    // not affect surrounding prose math, including code outside the viewport.
    tree.iterate({
      enter(node) {
        if (!['InlineCode', 'FencedCode', 'CodeBlock'].includes(node.name)) return
        code.push({ from: node.from, to: node.to, includeEnd: node.name === 'CodeBlock'
          || (node.name === 'FencedCode' && node.node.lastChild?.name !== 'CodeMark') })
        return false
      },
    })
  }
  let from = 0
  const parts: string[] = []
  for (const range of code) {
    parts.push(text.slice(from, range.from), text.slice(range.from, range.to).replace(/[^\n]/g, ' '))
    from = range.to
  }
  parts.push(text.slice(from))
  let codeIndex = 0
  const ranges = scanLatexMath(parts.join(''), language === 'markdown' ? 'markdown' : 'latex')
    // Both lists are ordered: avoid comparing every formula with every code block.
    .filter(range => {
      while (codeIndex < code.length && code[codeIndex].to <= range.delimiterFrom) codeIndex++
      return codeIndex === code.length || range.delimiterTo <= code[codeIndex].from
    })
  return { ranges, code, tree }
}
