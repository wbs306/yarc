import katex, { type KatexOptions } from 'katex'
import { marked, Renderer, type MarkedExtension, type Token, type Tokens } from 'marked'
import { linkifyImplicitPaperReferences } from './paper-reference'
import { relaxedStrongRule } from './markdown-strong'

interface KatexToken extends Tokens.Generic {
  type: 'inlineKatex' | 'blockKatex'
  raw: string
  text: string
  displayMode: boolean
  prefix?: string
  sourceRange?: MarkdownSourceRange
}

interface RelaxedStrongToken extends Tokens.Generic {
  type: 'relaxedStrong'
  raw: string
  text: string
  tokens: Token[]
}

const inlineRule = /^([\s\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{P}]?)(\${1,2})(?!\$)((?:\\.|[^\\\n\$])*?(?:\\.|[^\\\n\$]))\2(?=[\s\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{P}]|$)/u
const cjkStrongStartRule = /\*\*(?=\S)/u
// Allow trailing spaces on $$ lines — common with Markdown hard breaks (two trailing spaces).
const blockRule = /^(\${1,2})[ \t]*\n((?:\\[^]|[^\\])+?)\n\1[ \t]*(?:\n|$)/
const displayMathLineRule = /^[ \t]*\$\$[ \t]*$/
const inlineBoundaryChar = /^[\s\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{P}]$/u
const blockquoteLineRule = /^((?:[ \t]*>[ \t]?)+)(.*)$/
const listItemRule = /^([ \t]*)(?:[-+*]|\d+[.)])[ \t]+/
const codeFenceRule = /^(`{3,}|~{3,})/

let configured = false

function createKatexRenderer(options: KatexOptions, newlineAfter: boolean) {
  return (token: Tokens.Generic): string => {
    const katexToken = token as KatexToken
    const rendered = katex.renderToString(katexToken.text, {
      ...options,
      displayMode: katexToken.displayMode,
    })
    const sourceRange = katexToken.displayMode ? katexToken.sourceRange : undefined
    const sourceAttributes = sourceRange
      ? ` data-md-source-line="${sourceRange.startLine}" data-md-source-line-end="${sourceRange.endLine}"`
      : ''
    const mappedRendered = sourceAttributes
      ? rendered.replace(/^<([a-z][\w-]*)/, `<$1${sourceAttributes}`)
      : rendered
    return `${katexToken.prefix ?? ''}${mappedRendered}${newlineAfter ? '\n' : ''}`
  }
}

function findInlineKatexStart(src: string): number | undefined {
  let index = src.indexOf('$')

  while (index !== -1) {
    const start = index === 0 ? 0 : index - 1
    const previousChar = index === 0 ? '' : src.charAt(index - 1)

    if ((index === 0 || inlineBoundaryChar.test(previousChar)) && inlineRule.test(src.substring(start))) {
      return start
    }

    index = src.indexOf('$', index + 1)
  }
}

// Marked only truncates paragraphs for custom block extensions that provide start().
// Without this, a $$ block right after a paragraph line is swallowed into the paragraph.
function findBlockKatexStart(src: string): number | undefined {
  let searchFrom = 0

  while (searchFrom < src.length) {
    const dollar = src.indexOf('$$', searchFrom)
    if (dollar === -1) return undefined

    const lineStart = src.lastIndexOf('\n', dollar - 1) + 1
    const lineEnd = src.indexOf('\n', dollar)
    const line = src.slice(lineStart, lineEnd === -1 ? src.length : lineEnd)

    if (!displayMathLineRule.test(line) || lineEnd === -1) {
      searchFrom = dollar + 2
      continue
    }

    // Require a matching closing $$ line so we don't cut paragraphs on stray delimiters.
    const indent = line.match(/^[ \t]*/)?.[0] ?? ''
    const restLines = src.slice(lineEnd + 1).split('\n')
    const hasClose = restLines.some(candidate =>
      displayMathLineRule.test(candidate)
      && candidate.startsWith(indent)
      && candidate.trim() === '$$')
    if (!hasClose) {
      searchFrom = dollar + 2
      continue
    }

    return dollar
  }
}

function normalizeBlockquoteMathBlocks(markdown: string): string {
  const lines = markdown.split('\n')
  const normalized: string[] = []
  let inCodeFence = false
  let codeFenceChar = ''
  let codeFenceLength = 0
  let inBlockquoteMath = false

  for (const line of lines) {
    const quoteMatch = line.match(blockquoteLineRule)
    const content = quoteMatch?.[2] ?? line
    const trimmedContent = content.trim()
    const fenceMatch = trimmedContent.match(codeFenceRule)

    if (fenceMatch) {
      const fence = fenceMatch[1]
      if (!inCodeFence) {
        inCodeFence = true
        codeFenceChar = fence.charAt(0)
        codeFenceLength = fence.length
      } else if (fence.charAt(0) === codeFenceChar && fence.length >= codeFenceLength) {
        inCodeFence = false
        codeFenceChar = ''
        codeFenceLength = 0
      }
    }

    if (!inCodeFence && quoteMatch && trimmedContent === '$$') {
      if (!inBlockquoteMath) {
        const previousLine = normalized[normalized.length - 1]
        const previousQuoteMatch = previousLine?.match(blockquoteLineRule)
        const previousContent = previousQuoteMatch?.[2].trim()

        if (previousQuoteMatch && previousContent && previousContent !== '$$') {
          normalized.push(quoteMatch[1].trimEnd())
        }
        inBlockquoteMath = true
      } else {
        inBlockquoteMath = false
      }
    } else if (!quoteMatch || trimmedContent === '') {
      inBlockquoteMath = false
    }

    normalized.push(line)
  }

  return normalized.join('\n')
}

function leadingWhitespace(line: string): string {
  return line.match(/^[ \t]*/)?.[0] ?? ''
}

function isDisplayMathDelimiter(line: string | undefined, minIndent = ''): boolean {
  return !!line
    && displayMathLineRule.test(line)
    && line.startsWith(minIndent)
    && line.trim() === '$$'
}

function normalizeListMathBlocks(markdown: string): string {
  const lines = markdown.split('\n')
  const normalized: string[] = []
  let inCodeFence = false
  let codeFenceChar = ''
  let codeFenceLength = 0

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const fenceMatch = line.trimStart().match(codeFenceRule)
    if (fenceMatch) {
      const fence = fenceMatch[1]
      if (!inCodeFence) {
        inCodeFence = true
        codeFenceChar = fence.charAt(0)
        codeFenceLength = fence.length
      } else if (fence.charAt(0) === codeFenceChar && fence.length >= codeFenceLength) {
        inCodeFence = false
        codeFenceChar = ''
        codeFenceLength = 0
      }
      normalized.push(line)
      continue
    }

    if (inCodeFence) {
      normalized.push(line)
      continue
    }

    const listItemMatch = line.match(listItemRule)
    if (!listItemMatch) {
      normalized.push(line)
      continue
    }

    normalized.push(line)

    // Find a display-math block that belongs to this list item before the next
    // sibling/outer list item. Authors often indent $$ under "1. " / "- ".
    const listIndent = listItemMatch[1]
    let mathStartIndex = -1
    for (let cursor = index + 1; cursor < lines.length; cursor++) {
      const candidate = lines[cursor]
      const nextList = candidate.match(listItemRule)
      if (nextList && nextList[1].length <= listIndent.length) break
      if (isDisplayMathDelimiter(candidate, listIndent)) {
        mathStartIndex = cursor
        break
      }
      // Only skip blank lines between the list marker line and $$; other text
      // stays on the normal path and can be revisited as its own list item.
      if (candidate.trim() !== '') break
    }
    if (mathStartIndex === -1) continue

    let mathEndIndex = -1
    for (let cursor = mathStartIndex + 1; cursor < lines.length; cursor++) {
      if (isDisplayMathDelimiter(lines[cursor], listIndent)) {
        mathEndIndex = cursor
        break
      }
      const nextList = lines[cursor].match(listItemRule)
      if (nextList && nextList[1].length <= listIndent.length) break
    }
    if (mathEndIndex === -1) continue

    const mathLines = lines.slice(mathStartIndex, mathEndIndex + 1)
    const commonIndentLen = mathLines.reduce((min, mathLine) => {
      if (mathLine.trim() === '') return min
      return Math.min(min, leadingWhitespace(mathLine).length)
    }, Number.POSITIVE_INFINITY)
    const stripLen = Number.isFinite(commonIndentLen) ? commonIndentLen : 0

    // Keep the formula inside the list item, and insert blank lines so Marked
    // treats $$ as a nested block instead of paragraph text.
    const contentIndent = listItemMatch[0].replace(/[^\t]/g, ' ')
    if (normalized[normalized.length - 1]?.trim()) normalized.push('')

    for (const mathLine of mathLines) {
      const stripped = mathLine.slice(Math.min(stripLen, leadingWhitespace(mathLine).length))
      // Otherwise Marked recognizes a standalone minus inside the formula as
      // a nested list marker before the math extension sees the block.
      const body = stripped.trim() === '-' ? stripped.replace('-', '\\mathbin{-}') : stripped
      normalized.push(`${contentIndent}${body}`)
    }

    const nextLine = lines[mathEndIndex + 1]
    if (nextLine !== undefined && nextLine.trim() !== '') normalized.push('')

    index = mathEndIndex
  }

  return normalized.join('\n')
}

function createCjkAwareMarkdownExtension(options: KatexOptions): MarkedExtension {
  return {
    extensions: [
      {
        name: 'relaxedStrong',
        level: 'inline',
        start(src) {
          return src.match(cjkStrongStartRule)?.index
        },
        tokenizer(src) {
          const match = src.match(relaxedStrongRule)
          if (!match) return undefined

          return {
            type: 'relaxedStrong',
            raw: match[0],
            text: match[1],
            tokens: this.lexer.inlineTokens(match[1]),
          }
        },
        renderer(token) {
          const strongToken = token as RelaxedStrongToken
          return `<strong>${this.parser.parseInline(strongToken.tokens)}</strong>`
        },
      },
      {
        name: 'inlineKatex',
        level: 'inline',
        start: findInlineKatexStart,
        tokenizer(src) {
          const match = src.match(inlineRule)
          if (!match) return undefined

          return {
            type: 'inlineKatex',
            raw: match[0],
            prefix: match[1],
            text: match[3].trim(),
            displayMode: match[2].length === 2,
          }
        },
        renderer: createKatexRenderer(options, false),
      },
      {
        name: 'blockKatex',
        level: 'block',
        start: findBlockKatexStart,
        tokenizer(src) {
          const match = src.match(blockRule)
          if (!match) return undefined

          return {
            type: 'blockKatex',
            raw: match[0],
            text: match[2].trim(),
            displayMode: match[1].length === 2,
          }
        },
        renderer: createKatexRenderer(options, true),
      },
    ],
  }
}

export function configureMarked() {
  if (configured) return
  configured = true

  marked.use(createCjkAwareMarkdownExtension({ throwOnError: false }))
  marked.use({ breaks: true })
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function isEscaped(text: string, index: number): boolean {
  let backslashes = 0
  for (let cursor = index - 1; cursor >= 0 && text.charAt(cursor) === '\\'; cursor--) backslashes++
  return backslashes % 2 === 1
}

/**
 * Renders only inline LaTeX delimiters and escapes all remaining title text.
 * Unlike renderMarkdown(), this is safe to place inside headings and other
 * inline-only containers whose content is supplied by external metadata.
 */
export function renderInlineLatex(text: string): string {
  if (!text) return ''

  let html = ''
  let cursor = 0
  let plainStart = 0

  const appendPlain = (end: number) => {
    html += escapeHtml(text.slice(plainStart, end))
  }

  while (cursor < text.length) {
    const isDollar = text.charAt(cursor) === '$'
      && !isEscaped(text, cursor)
      && text.charAt(cursor - 1) !== '$'
      && text.charAt(cursor + 1) !== '$'
    const isParenStart = text.slice(cursor, cursor + 2) === '\\('
    if (!isDollar && !isParenStart) {
      cursor++
      continue
    }

    const delimiter = isDollar ? '$' : '\\('
    const closingDelimiter = isDollar ? '$' : '\\)'
    const formulaStart = cursor + delimiter.length
    let end = formulaStart
    while (end < text.length) {
      if (text.startsWith(closingDelimiter, end) && !isEscaped(text, end)) break
      end++
    }

    const formula = text.slice(formulaStart, end).trim()
    if (end === text.length || !formula || (isDollar && text.charAt(formulaStart) === '$')) {
      cursor = formulaStart
      continue
    }

    appendPlain(cursor)
    try {
      html += katex.renderToString(formula, { throwOnError: false, displayMode: false })
    } catch {
      html += escapeHtml(text.slice(cursor, end + closingDelimiter.length))
    }
    cursor = end + closingDelimiter.length
    plainStart = cursor
  }

  appendPlain(text.length)
  return html
}

/**
 * CommonMark rejects forms such as `**文字，**继续` and `**第 2 项；**3）...`
 * because the closing delimiter is between punctuation and a non-punctuation
 * character. Chinese prose normally has no space there, so handle this common
 * form as a dedicated inline token.
 */
const prepareMarkdownSource = (text: string) =>
  linkifyImplicitPaperReferences(normalizeListMathBlocks(normalizeBlockquoteMathBlocks(text)))

type TokenWithChildren = Token & {
  tokens?: Token[]
  items?: Token[]
}

interface MarkdownSourceRange {
  startLine: number
  endLine: number
}

const buildMarkdownSourceRanges = (tokens: Token[], source: string) => {
  const ranges = new WeakMap<object, MarkdownSourceRange>()
  const lineStarts = [0]
  for (let index = 0; index < source.length; index++) {
    if (source.charAt(index) === '\n') lineStarts.push(index + 1)
  }

  const lineAt = (offset: number) => {
    let low = 0
    let high = lineStarts.length - 1
    while (low <= high) {
      const middle = Math.floor((low + high) / 2)
      if (lineStarts[middle] <= offset) low = middle + 1
      else high = middle - 1
    }
    return high + 1
  }

  const mappedBlockTypes = new Set([
    'heading',
    'paragraph',
    'code',
    'blockquote',
    'list',
    'list_item',
    'hr',
    'table',
    'blockKatex',
  ])

  const visit = (items: Token[], from: number, limit: number) => {
    let cursor = from
    for (const token of items) {
      const raw = typeof token.raw === 'string' ? token.raw : ''
      let start = raw ? source.indexOf(raw, cursor) : cursor
      if (start < cursor || start >= limit) start = cursor
      const end = raw ? Math.min(limit, start + raw.length) : start

      if (raw && mappedBlockTypes.has(token.type)) {
        const range = {
          startLine: lineAt(start),
          endLine: lineAt(Math.max(start, end - 1)),
        }
        ranges.set(token, range)
        if (token.type === 'blockKatex') (token as KatexToken).sourceRange = range
      }

      const nested = token as TokenWithChildren
      if (token.type === 'list' && nested.items?.length) {
        visit(nested.items, start, Math.max(start, end))
      } else if ((token.type === 'blockquote' || token.type === 'list_item') && nested.tokens?.length) {
        visit(nested.tokens, start, Math.max(start, end))
      }
      cursor = Math.max(cursor, end)
    }
  }

  visit(tokens, 0, source.length)
  return ranges
}

class MarkdownSourceMapRenderer extends Renderer {
  constructor(private readonly ranges: WeakMap<object, MarkdownSourceRange>) {
    super()
  }

  private addSourceRange(html: string, token: object, tagName: string) {
    const range = this.ranges.get(token)
    if (!range) return html
    const attributes = ` data-md-source-line="${range.startLine}" data-md-source-line-end="${range.endLine}"`
    return html.replace(new RegExp(`^<${tagName}(?=[ >])`), `<${tagName}${attributes}`)
  }

  heading(token: Tokens.Heading) {
    return this.addSourceRange(super.heading(token), token, `h${token.depth}`)
  }

  paragraph(token: Tokens.Paragraph) {
    return this.addSourceRange(super.paragraph(token), token, 'p')
  }

  code(token: Tokens.Code) {
    return this.addSourceRange(super.code(token), token, 'pre')
  }

  blockquote(token: Tokens.Blockquote) {
    return this.addSourceRange(super.blockquote(token), token, 'blockquote')
  }

  list(token: Tokens.List) {
    return this.addSourceRange(super.list(token), token, token.ordered ? 'ol' : 'ul')
  }

  listitem(token: Tokens.ListItem) {
    return this.addSourceRange(super.listitem(token), token, 'li')
  }

  hr(token: Tokens.Hr) {
    return this.addSourceRange(super.hr(token), token, 'hr')
  }

  table(token: Tokens.Table) {
    return this.addSourceRange(super.table(token), token, 'table')
  }
}

export function renderMarkdown(text: string): string {
  if (!text) return ''
  configureMarked()
  try {
    return marked.parse(prepareMarkdownSource(text)) as string
  } catch {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')
  }
}

export function renderMarkdownWithSourceMap(text: string): string {
  if (!text) return ''
  configureMarked()
  try {
    const source = prepareMarkdownSource(text)
    const tokens = marked.lexer(source)
    const renderer = new MarkdownSourceMapRenderer(buildMarkdownSourceRanges(tokens, source))
    return marked.parser(tokens, { ...marked.defaults, renderer }) as string
  } catch {
    return renderMarkdown(text)
  }
}
