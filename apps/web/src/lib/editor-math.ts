import { markdownLanguage } from '@codemirror/lang-markdown'
import { scanLatexMath } from './latex-math'

export function scanEditorMath(text: string, language: string) {
  const code: { from: number; to: number; includeEnd: boolean }[] = []
  if (language === 'markdown') {
    // Parse beyond the viewport too. Mask code while preserving offsets and
    // blank lines; dollars in code must not affect surrounding prose math.
    markdownLanguage.parser.parse(text).iterate({
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
  const ranges = scanLatexMath(parts.join(''), language === 'markdown' ? 'markdown' : 'latex')
    // A formula cannot cross a code region. In particular, an unmatched
    // dollar before a fenced block must not enable previews inside that block.
    .filter(range => !code.some(excluded => range.from < excluded.to && range.to >= excluded.from))
  return { ranges, code }
}
