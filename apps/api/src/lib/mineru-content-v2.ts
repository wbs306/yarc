import { readFile } from 'node:fs/promises'
import { cleanTextForEmbedding, hasSearchableText } from './text-cleaning.js'

export interface MinerUTextBlock {
  page: number
  type: string
  text: string
  bbox?: number[]
}

export interface EmbeddingChunk {
  content: string
  pageNumber: number | null
  chunkIndex: number
}

export interface SummaryRenderOptions {
  includeReferences?: boolean
  includePageFootnotes?: boolean
  includeImages?: boolean
  includeEquations?: boolean
  includeTables?: boolean
  includeAlgorithms?: boolean
}

type JsonObject = Record<string, unknown>

const REFERENCE_TITLE_RE = /^\s*(references|reference|bibliography|参考文献)\s*:?\s*$/i
const EMBEDDING_BOILERPLATE_RE = /(?:this article has been accepted for publication|this is the author's version|content may change prior to final publication|citation information:\s*doi|personal use is permitted|for more information, see https?:\/\/creativecommons\.org|this work is licensed under a creative commons|authorized licensed use limited to|downloaded from ieee xplore|©\s*\d{4}\s*ieee|copyright\s*©\s*\d{4}\s*ieee|ieee personal use|permission from ieee must be obtained)/i
const INLINE_JOIN_LEFT_RE = /^\s*([,.;:!?%)\]}]|\b(?:and|or|of|in|to|for|with|by|from|as|is|are|was|were)\b)/i
const INLINE_JOIN_RIGHT_RE = /([(\[{])\s*$/

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }
  return []
}

function asObject(value: unknown): JsonObject {
  return isObject(value) ? value : {}
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function normalizeText(value: string): string {
  return value
    .replace(/\u0000/g, ' ')
    .replace(/[\t\r\f]+/g, ' ')
    .replace(/[ \u00a0]{2,}/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim()
}

function bboxOf(block: JsonObject): number[] | undefined {
  const bbox = block.bbox
  if (!Array.isArray(bbox) || bbox.length !== 4) return undefined
  const values = bbox.map((item) => Number(item))
  return values.every(Number.isFinite) ? values : undefined
}

function pageLists(contentListV2: unknown[]): unknown[][] {
  if (contentListV2.every(Array.isArray)) return contentListV2 as unknown[][]
  return [contentListV2]
}

function textNodeContent(node: JsonObject, includeInlineEquations: boolean): string {
  const type = asString(node.type)
  if (type === 'text') return asString(node.content)
  if (type === 'equation_inline') return includeInlineEquations ? asString(node.content) : ''
  return ''
}

function joinInline(parts: string[]): string {
  let output = ''
  for (const rawPart of parts) {
    const part = normalizeText(rawPart)
    if (!part) continue
    if (!output) {
      output = part
      continue
    }
    if (INLINE_JOIN_LEFT_RE.test(part) || INLINE_JOIN_RIGHT_RE.test(output)) output += part
    else output += ` ${part}`
  }
  return normalizeText(output)
}

function collectInlineText(nodes: unknown, options: { includeInlineEquations: boolean }): string {
  const parts: string[] = []
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    if (!isObject(value)) return
    const direct = textNodeContent(value, options.includeInlineEquations)
    if (direct) {
      parts.push(direct)
      return
    }
    const type = asString(value.type)
    if (type === 'image' || type === 'chart' || type === 'table' || type === 'equation_interline') return
    for (const child of Object.values(value)) visit(child)
  }
  visit(nodes)
  return joinInline(parts)
}

function collectTextOnly(nodes: unknown): string {
  return collectInlineText(nodes, { includeInlineEquations: false })
}

function titleText(block: JsonObject, includeInlineEquations = false): string {
  const content = asObject(block.content)
  return collectInlineText(content.title_content, { includeInlineEquations })
}

function paragraphText(block: JsonObject, includeInlineEquations: boolean): string {
  const content = asObject(block.content)
  return collectInlineText(content.paragraph_content, { includeInlineEquations })
}

function listText(block: JsonObject, includeInlineEquations: boolean): string {
  const content = asObject(block.content)
  return collectInlineText(content.list_items, { includeInlineEquations })
}

function isReferenceBlock(block: JsonObject): boolean {
  const type = asString(block.type)
  if (type === 'list' && asString(asObject(block.content).list_type) === 'reference_list') return true
  return type === 'title' && REFERENCE_TITLE_RE.test(titleText(block))
}

function removeEmbeddingBoilerplate(text: string): string {
  return text
    .replace(/this article has been accepted for publication[^\n.。]*(?:\.[^\n.。]*){0,2}/gi, ' ')
    .replace(/this is the author's version[^\n.。]*(?:\.[^\n.。]*){0,2}/gi, ' ')
    .replace(/content may change prior to final publication[^\n.。]*/gi, ' ')
    .replace(/citation information:\s*doi\s*[^\s,;。]+/gi, ' ')
    .replace(/authorized licensed use limited to[^\n.。]*(?:\.[^\n.。]*)?/gi, ' ')
    .replace(/downloaded from ieee xplore[^\n.。]*(?:\.[^\n.。]*)?/gi, ' ')
    .replace(/personal use is permitted[^\n.。]*(?:\.[^\n.。]*)?/gi, ' ')
    .replace(/permission from ieee must be obtained[^\n.。]*(?:\.[^\n.。]*)?/gi, ' ')
    .replace(/this work is licensed under a creative commons[^\n.。]*(?:\.[^\n.。]*)?/gi, ' ')
    .replace(/for more information, see https?:\/\/creativecommons\.org\/licenses\/[^\s)]+/gi, ' ')
    .replace(/article info\s+copyright\s+copyright\s*©\s*\d{4}[\s\S]{0,800}?creative commons[^\n.。]*(?:\.[^\n.。]*)?(?:\s*https?:\/\/creativecommons\.org\/licenses\/[^\s)]+)?/gi, ' ')
    .replace(/copyright:\s*©\s*\d{4}\s+by the authors\.\s*licensee[^\n.。]*\.\s*this article is an open access article[^\n.。]*creative commons[^\n.。]*(?:\.[^\n.。]*)?/gi, ' ')
    .replace(/copyright\s*©\s*\d{4}\s+by author\(s\)[\s\S]{0,800}?creative commons[^\n.。]*(?:\.[^\n.。]*)?/gi, ' ')
    .replace(/copyright:\s*©\s*\d{4}[^\n.。]*(?:creative commons|open access|license)[^\n.。]*(?:\.[^\n.。]*){0,2}/gi, ' ')
    .replace(/©\s*\d{4}\s*ieee[^\n.。]*(?:\.[^\n.。]*)?/gi, ' ')
    .replace(/article info\s+copyright(?:\.org\/licenses\/\s*by\/4\.0\/)?/gi, ' ')
    .replace(/copyright\.org\/licenses\/\s*by\/4\.0\//gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function isEmbeddingBoilerplate(text: string): boolean {
  return EMBEDDING_BOILERPLATE_RE.test(text)
}

function firstResultPayload(data: unknown): JsonObject | undefined {
  if (!isObject(data)) return undefined
  const results = data.results
  if (Array.isArray(results)) return results.find(isObject)
  if (isObject(results)) {
    for (const value of Object.values(results)) {
      if (isObject(value)) return value
    }
  }
  const result = data.result
  if (isObject(result)) return result
  return data
}

export async function loadMineruContentListV2(parseResult: unknown): Promise<unknown[]> {
  const metadata = isObject(parseResult) ? asObject(parseResult.metadata) : {}
  const mineru = asObject(metadata.mineru)
  const resultPath = asString(mineru.resultPath)
  if (!resultPath) {
    throw new Error('MinerU content_list_v2 missing: parseResult.metadata.mineru.resultPath not found; please reparse paper')
  }

  let resultJson: unknown
  try {
    resultJson = JSON.parse(await readFile(resultPath, 'utf-8'))
  } catch (err) {
    throw new Error(`MinerU content_list_v2 missing: failed to read result.json at ${resultPath}: ${(err as Error).message}`)
  }

  const payload = firstResultPayload(resultJson)
  if (!payload) throw new Error('MinerU content_list_v2 missing: invalid result.json payload; please reparse paper')

  const inlineV2 = asArray(payload.content_list_v2)
  if (inlineV2.length > 0) return inlineV2

  const v2Path = asString(payload.content_list_v2_path)
  if (v2Path) {
    try {
      const parsed = JSON.parse(await readFile(v2Path, 'utf-8')) as unknown
      const fileV2 = asArray(parsed)
      if (fileV2.length > 0) return fileV2
    } catch (err) {
      throw new Error(`MinerU content_list_v2 missing: failed to read ${v2Path}: ${(err as Error).message}`)
    }
  }

  throw new Error('MinerU content_list_v2 missing; please reparse paper')
}

export function extractEmbeddingBlocksFromV2(contentListV2: unknown[]): MinerUTextBlock[] {
  const blocks: MinerUTextBlock[] = []
  let stoppedAtReferences = false

  for (const [pageIndex, page] of pageLists(contentListV2).entries()) {
    if (stoppedAtReferences) break
    for (const rawBlock of page) {
      if (!isObject(rawBlock)) continue
      if (isReferenceBlock(rawBlock)) {
        stoppedAtReferences = true
        break
      }

      const type = asString(rawBlock.type)
      let text = ''
      if (type === 'title') text = titleText(rawBlock)
      else if (type === 'paragraph') text = paragraphText(rawBlock, false)
      else if (type === 'list') text = listText(rawBlock, false)
      else continue

      const cleaned = removeEmbeddingBoilerplate(cleanTextForEmbedding(text))
      if (!cleaned || isEmbeddingBoilerplate(cleaned)) continue
      blocks.push({
        page: pageIndex + 1,
        type,
        text: cleaned,
        bbox: bboxOf(rawBlock),
      })
    }
  }

  return blocks
}

export function buildEmbeddingChunksFromBlocks(blocks: MinerUTextBlock[], options: {
  maxChunkSize?: number
  overlap?: number
} = {}): EmbeddingChunk[] {
  const maxChunkSize = options.maxChunkSize ?? 1000
  const overlap = Math.max(0, Math.min(options.overlap ?? 200, maxChunkSize - 1))
  const chunks: EmbeddingChunk[] = []
  let buffer = ''
  let bufferPage: number | null = null

  const flush = () => {
    const cleaned = removeEmbeddingBoilerplate(cleanTextForEmbedding(buffer))
    if (hasSearchableText(cleaned)) {
      chunks.push({ content: cleaned, pageNumber: bufferPage, chunkIndex: chunks.length })
    }
    buffer = ''
    bufferPage = null
  }

  const appendText = (text: string, page: number) => {
    const cleaned = removeEmbeddingBoilerplate(cleanTextForEmbedding(text))
    if (!cleaned) return

    if (cleaned.length > maxChunkSize) {
      flush()
      let start = 0
      while (start < cleaned.length) {
        const end = Math.min(start + maxChunkSize, cleaned.length)
        const content = removeEmbeddingBoilerplate(cleanTextForEmbedding(cleaned.slice(start, end)))
        if (hasSearchableText(content)) chunks.push({ content, pageNumber: page, chunkIndex: chunks.length })
        if (end >= cleaned.length) break
        start = end - overlap
      }
      return
    }

    const next = buffer ? `${buffer}\n\n${cleaned}` : cleaned
    if (next.length > maxChunkSize && buffer) flush()
    if (!buffer) bufferPage = page
    buffer = buffer ? `${buffer}\n\n${cleaned}` : cleaned
  }

  for (const block of blocks) appendText(block.text, block.page)
  flush()

  return chunks
}

function heading(level: unknown, text: string): string {
  const n = Math.max(1, Math.min(6, Number(level) || 1))
  return `${'#'.repeat(n)} ${text}`
}

function imagePath(content: JsonObject): string {
  return asString(asObject(content.image_source).path)
}

function renderCaption(content: JsonObject, key: string, includeInlineEquations = true): string {
  return collectInlineText(content[key], { includeInlineEquations })
}

function renderTable(block: JsonObject): string {
  const content = asObject(block.content)
  const parts = ['[Table]']
  const caption = renderCaption(content, 'table_caption')
  const html = asString(content.html).trim()
  const footnote = renderCaption(content, 'table_footnote')
  if (caption) parts.push(`caption: ${caption}`)
  if (html) parts.push(`content:\n${html}`)
  if (footnote) parts.push(`footnote: ${footnote}`)
  return parts.join('\n')
}

function renderImageLike(block: JsonObject, label: 'Image' | 'Chart'): string {
  const content = asObject(block.content)
  const parts = [`[${label}]`]
  const source = imagePath(content)
  const caption = renderCaption(content, label === 'Image' ? 'image_caption' : 'chart_caption')
  const footnote = renderCaption(content, label === 'Image' ? 'image_footnote' : 'chart_footnote')
  if (source) parts.push(`image: ${source}`)
  if (caption) parts.push(`caption: ${caption}`)
  if (footnote) parts.push(`footnote: ${footnote}`)
  return parts.join('\n')
}

function renderEquation(block: JsonObject): string {
  const content = asObject(block.content)
  const math = asString(content.math_content) || asString(block.content)
  const source = imagePath(content)
  const parts = ['[Equation]']
  if (math) parts.push(math)
  if (source) parts.push(`image: ${source}`)
  return parts.join('\n')
}

function renderCodeLike(block: JsonObject, label: 'Code' | 'Algorithm'): string {
  const content = asObject(block.content)
  const caption = renderCaption(content, label === 'Code' ? 'code_caption' : 'algorithm_caption')
  const body = collectInlineText(content[label === 'Code' ? 'code_content' : 'algorithm_content'], { includeInlineEquations: true })
  const footnote = renderCaption(content, label === 'Code' ? 'code_footnote' : 'algorithm_footnote')
  const parts = [`[${label}]`]
  if (caption) parts.push(`caption: ${caption}`)
  if (body) parts.push(body)
  if (footnote) parts.push(`footnote: ${footnote}`)
  return parts.join('\n')
}

export function renderSummaryMarkdownFromV2(contentListV2: unknown[], options: SummaryRenderOptions = {}): string {
  const includeReferences = options.includeReferences ?? false
  const includePageFootnotes = options.includePageFootnotes ?? false
  const includeImages = options.includeImages ?? true
  const includeEquations = options.includeEquations ?? true
  const includeTables = options.includeTables ?? true
  const includeAlgorithms = options.includeAlgorithms ?? true

  const sections: string[] = []
  let stoppedAtReferences = false

  for (const page of pageLists(contentListV2)) {
    if (stoppedAtReferences) break
    for (const rawBlock of page) {
      if (!isObject(rawBlock)) continue
      if (!includeReferences && isReferenceBlock(rawBlock)) {
        stoppedAtReferences = true
        break
      }

      const type = asString(rawBlock.type)
      const content = asObject(rawBlock.content)
      let rendered = ''

      if (type === 'title') {
        const text = titleText(rawBlock, true)
        rendered = text ? heading(content.level, text) : ''
      } else if (type === 'paragraph') {
        rendered = paragraphText(rawBlock, true)
      } else if (type === 'list') {
        rendered = listText(rawBlock, true)
      } else if (type === 'page_footnote' && includePageFootnotes) {
        rendered = collectInlineText(content.page_footnote_content, { includeInlineEquations: true })
      } else if (type === 'equation_interline' && includeEquations) {
        rendered = renderEquation(rawBlock)
      } else if (type === 'image' && includeImages) {
        rendered = renderImageLike(rawBlock, 'Image')
      } else if (type === 'chart' && includeImages) {
        rendered = renderImageLike(rawBlock, 'Chart')
      } else if (type === 'table' && includeTables) {
        rendered = renderTable(rawBlock)
      } else if (type === 'code' && includeAlgorithms) {
        rendered = renderCodeLike(rawBlock, 'Code')
      } else if (type === 'algorithm' && includeAlgorithms) {
        rendered = renderCodeLike(rawBlock, 'Algorithm')
      }

      rendered = normalizeText(rendered)
      if (rendered) sections.push(rendered)
    }
  }

  return sections.join('\n\n').trim()
}
