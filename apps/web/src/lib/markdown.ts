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

function normalizeListMathBlocks(markdown: string): string {
  const lines = markdown.split('\n')
  const normalized = [...lines]
  let inCodeFence = false
  let codeFenceChar = ''
  let codeFenceLength = 0

  for (let index = 0; index < lines.length; index++) {
    const fenceMatch = lines[index].trimStart().match(codeFenceRule)
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
      continue
    }

    if (inCodeFence) continue

    const listItemMatch = lines[index].match(listItemRule)
    const mathStartIndex = index + 1
    const isListMathDelimiter = (line: string | undefined) =>
      !!line
      && displayMathLineRule.test(line)
      && line.startsWith(listItemMatch?.[1] ?? '')
      && line.trim() === '$$'
    if (!listItemMatch || !isListMathDelimiter(lines[mathStartIndex])) continue

    const mathEndIndex = lines.findIndex((line, lineIndex) =>
      lineIndex > mathStartIndex && isListMathDelimiter(line))
    if (mathEndIndex === -1) continue

    // A display-math block at the list item's indentation ends the list in
    // CommonMark. Indent this common editor input as list-item content instead.
    const contentIndent = listItemMatch[0].replace(/[^\t]/g, ' ')
    for (let lineIndex = mathStartIndex; lineIndex <= mathEndIndex; lineIndex++) {
      const content = lines[lineIndex].slice(listItemMatch[1].length)
      // Otherwise Marked recognizes a standalone minus inside the formula as
      // a nested list marker before the math extension sees the block.
      const normalizedContent = content.trim() === '-' ? content.replace('-', '\\mathbin{-}') : content
      normalized[lineIndex] = `${contentIndent}${normalizedContent}`
    }
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
