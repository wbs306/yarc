import katex, { type KatexOptions } from 'katex'
import { marked, type MarkedExtension, type Tokens } from 'marked'
import { linkifyImplicitPaperReferences } from './paper-reference'

interface KatexToken extends Tokens.Generic {
  type: 'inlineKatex' | 'blockKatex'
  raw: string
  text: string
  displayMode: boolean
  prefix?: string
}

const inlineRule = /^([\s\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{P}]?)(\${1,2})(?!\$)((?:\\.|[^\\\n\$])*?(?:\\.|[^\\\n\$]))\2(?=[\s\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{P}]|$)/u
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
    return `${katexToken.prefix ?? ''}${rendered}${newlineAfter ? '\n' : ''}`
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

function createCjkAwareKatexExtension(options: KatexOptions): MarkedExtension {
  return {
    extensions: [
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

  marked.use(createCjkAwareKatexExtension({ throwOnError: false }))
  marked.use({ breaks: true })
}

export function renderMarkdown(text: string): string {
  if (!text) return ''
  configureMarked()
  try {
    return marked.parse(linkifyImplicitPaperReferences(normalizeListMathBlocks(normalizeBlockquoteMathBlocks(text)))) as string
  } catch {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')
  }
}
