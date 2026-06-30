const HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

const decodeHtmlEntities = (text: string) => text.replace(/&(#\d+|#x[\da-f]+|[a-z]+);/gi, (match, entity: string) => {
  const key = entity.toLowerCase()
  if (key.startsWith('#x')) {
    const code = Number.parseInt(key.slice(2), 16)
    return Number.isFinite(code) ? String.fromCodePoint(code) : match
  }
  if (key.startsWith('#')) {
    const code = Number.parseInt(key.slice(1), 10)
    return Number.isFinite(code) ? String.fromCodePoint(code) : match
  }
  return HTML_ENTITIES[key] ?? match
})

const removeMathBlocks = (text: string) => text
  .replace(/\$\$[\s\S]*?\$\$/g, ' ')
  .replace(/\\\[[\s\S]*?\\\]/g, ' ')
  .replace(/\\\([\s\S]*?\\\)/g, ' ')
  .replace(/\\begin\{(?:equation\*?|align\*?|gather\*?|multline\*?|split|cases|matrix|pmatrix|bmatrix|array)\}[\s\S]*?\\end\{(?:equation\*?|align\*?|gather\*?|multline\*?|split|cases|matrix|pmatrix|bmatrix|array)\}/g, ' ')
  .replace(/(?<!\\)\$[^$\n]{1,500}(?<!\\)\$/g, ' ')

const removeLatexCommands = (text: string) => text
  .replace(/\\(?:cite|ref|eqref|label|url|href)\*?(?:\[[^\]]*\])?\{[^{}]*\}(?:\{[^{}]*\})?/g, ' ')
  .replace(/\\(?:textbf|textit|emph|underline|mathrm|mathbf|mathit|operatorname)\*?\{([^{}]*)\}/g, '$1')
  .replace(/\\[a-zA-Z]+\*?(?:\[[^\]]*\])?/g, ' ')
  .replace(/[{}_^~]/g, ' ')

export function cleanTextForEmbedding(input: string): string {
  let text = input.replace(/\u0000/g, ' ')
  text = decodeHtmlEntities(text)
  text = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/<img\b[^>]*>/gi, ' ')
    .replace(/\[[^\]]{0,120}\]\((?:images?|figures?|tables?|attachments?)\/[^)]*\)/gi, ' ')
    .replace(/\[([^\]]{1,200})\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\*\*\*([^*\n]{1,300})\*\*\*/g, '$1')
    .replace(/\*\*([^*\n]{1,300})\*\*/g, '$1')
    .replace(/\*([^*\n]{1,300})\*/g, '$1')
    .replace(/__([^_\n]{1,300})__/g, '$1')
    .replace(/_([^_\n]{1,300})_/g, '$1')
    .replace(/`([^`\n]{1,300})`/g, '$1')

  text = removeMathBlocks(text)
  text = removeLatexCommands(text)

  text = text
    .replace(/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/gm, ' ')
    .replace(/\s*\|\s*/g, ' ')
    .replace(/\b(?:Fig(?:ure)?|Table)\s*\d+\s*[:.\-–—]?/gi, ' ')
    .replace(/\bimages?\/[\w./-]+\.(?:png|jpe?g|webp|gif|svg)\b/gi, ' ')
    .replace(/[$]/g, ' ')
    .replace(/[\t\r\f]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \u00a0]{2,}/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim()

  return text
}

export function hasSearchableText(text: string): boolean {
  const letters = text.match(/[\p{L}\p{N}]/gu)?.length ?? 0
  return letters >= 40
}

export function cleanSnippetForDisplay(input: string, maxLength?: number): string {
  const cleaned = cleanTextForEmbedding(input).replace(/\s+/g, ' ').trim()
  if (!maxLength || cleaned.length <= maxLength) return cleaned
  return `${cleaned.slice(0, maxLength).trim()}…`
}
