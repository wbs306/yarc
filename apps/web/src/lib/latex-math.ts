export interface LatexMathRange {
  from: number
  to: number
  source: string
  display: boolean
  complete: boolean
}

const mathEnvironments = new Set(['equation', 'equation*', 'align', 'align*', 'gather', 'gather*', 'multline', 'multline*', 'displaymath', 'math'])
const verbatimEnvironments = new Set(['verbatim', 'verbatim*', 'Verbatim', 'lstlisting', 'minted', 'comment'])
const maxFormulaLength = 8000

function environmentSource(source: string, environment?: string) {
  // Numbering belongs to the full document, not this local preview.
  const name = environment?.replace(/\*$/, '')
  if (name === 'align') return `\\begin{aligned}\n${source}\n\\end{aligned}`
  if (name === 'gather' || name === 'multline') return `\\begin{gathered}\n${source}\n\\end{gathered}`
  return source
}

// Lightweight lexical scan, not a full TeX parser. Keep ranges cached between
// cursor moves, skip comments/verbatim, and bound unfinished math so a missing
// delimiter cannot turn the rest of a document into a preview.
export function scanLatexMath(text: string): LatexMathRange[] {
  const ranges: LatexMathRange[] = []
  const tokens = /%[^\n]*|\\(?:begin|end)\{([A-Za-z*]+)\}|\\verb\*?(?![A-Za-z])|\\[()[\]]|\\.|\${1,2}/g
  let active: { from: number; close: string; display: boolean; environment?: string; limit: number } | undefined
  let match: RegExpExecArray | null

  const finish = (to: number, complete: boolean) => {
    if (!active) return
    ranges.push({
      from: active.from,
      to,
      source: environmentSource(text.slice(active.from, to), active.environment),
      display: active.display,
      complete,
    })
    active = undefined
  }

  while ((match = tokens.exec(text))) {
    const token = match[0]
    const start = match.index
    if (active && start >= active.limit) finish(active.limit, false)
    if (token.startsWith('%')) continue
    if (token === '\\verb' || token === '\\verb*') {
      const delimiter = text[tokens.lastIndex]
      if (delimiter && !/\s/.test(delimiter)) {
        const end = text.indexOf(delimiter, tokens.lastIndex + 1)
        const lineEnd = text.indexOf('\n', tokens.lastIndex)
        tokens.lastIndex = end >= 0 && (lineEnd < 0 || end < lineEnd) ? end + 1 : lineEnd < 0 ? text.length : lineEnd
      }
      continue
    }
    const environment = match[1]
    if (environment && token.startsWith('\\begin') && verbatimEnvironments.has(environment)) {
      const closing = `\\end{${environment}}`
      const end = text.indexOf(closing, tokens.lastIndex)
      tokens.lastIndex = end < 0 ? text.length : end + closing.length
      continue
    }
    if (active) {
      // Adjacent inline formulas ($x$$y$) share two consecutive dollars,
      // but those dollars do not open a display-math block.
      if (active.close === '$' && token === '$$') {
        tokens.lastIndex = start + 1
        finish(start, true)
      } else if (token === active.close) {
        finish(start, true)
      }
      continue
    }

    let close: string | undefined
    let display = true
    if (token === '$' || token === '$$') {
      close = token
      display = token === '$$'
    } else if (token === '\\(') {
      close = '\\)'
      display = false
    } else if (token === '\\[') {
      close = '\\]'
    } else if (environment && token.startsWith('\\begin') && mathEnvironments.has(environment)) {
      close = `\\end{${environment}}`
      display = environment !== 'math'
    }
    if (!close) continue
    const from = tokens.lastIndex
    let limit = Math.min(text.length, from + maxFormulaLength)
    // Blank lines are not valid inside standard math environments.
    const blank = /\n[\t \r]*\n/.exec(text.slice(from, limit))
    if (blank) limit = from + blank.index
    active = { from, close, display, environment, limit }
  }
  if (active) finish(active.limit, false)
  return ranges
}

export function mathAtPosition(ranges: readonly LatexMathRange[], position: number) {
  return ranges.find(range => position >= range.from && position <= range.to)
}
