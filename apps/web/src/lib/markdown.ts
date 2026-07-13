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
const blockRule = /^(\${1,2})\n((?:\\[^]|[^\\])+?)\n\1(?:\n|$)/
const inlineBoundaryChar = /^[\s\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{P}]$/u
const blockquoteLineRule = /^((?:[ \t]*>[ \t]?)+)(.*)$/
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
    return marked.parse(linkifyImplicitPaperReferences(normalizeBlockquoteMathBlocks(text))) as string
  } catch {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')
  }
}
