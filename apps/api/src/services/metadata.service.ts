interface ExtractedPdfMetadata {
  title?: string
  authors?: string[]
  year?: number
  doi?: string
  arxivId?: string
  abstract?: string
  journal?: string
  venue?: string
  url?: string
  source: string
  raw?: Record<string, unknown>
}

interface CrossrefWork {
  title?: string[]
  author?: Array<{ given?: string; family?: string; name?: string }>
  issued?: { 'date-parts'?: number[][] }
  published?: { 'date-parts'?: number[][] }
  'published-print'?: { 'date-parts'?: number[][] }
  'published-online'?: { 'date-parts'?: number[][] }
  DOI?: string
  URL?: string
  abstract?: string
  'container-title'?: string[]
}

const DOI_REGEX = /10\.\d{4,9}\/[\w.()/:;\-]+/i
const ARXIV_REGEX = /arXiv[:\s]*([0-9]{4}\.[0-9]{4,5}(?:v\d+)?)/i

const cleanDoi = (value?: string | null) => {
  if (!value) return undefined
  const match = value.match(DOI_REGEX)
  if (!match) return undefined
  return match[0].replace(/[).,;\]\s]+$/g, '')
}

const normalizeWhitespace = (value?: string | null) =>
  value?.replace(/\s+/g, ' ').trim() || undefined

const decodeUtf16Be = (bytes: Buffer) => {
  const swapped = Buffer.alloc(bytes.length)
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    swapped[i] = bytes[i + 1]
    swapped[i + 1] = bytes[i]
  }
  return swapped.toString('utf16le')
}

const decodePdfString = (value?: string) => {
  if (!value) return undefined
  let text = value
  if (text.startsWith('<') && text.endsWith('>')) {
    const hex = text.slice(1, -1).replace(/\s+/g, '')
    if (/^[0-9a-f]+$/i.test(hex) && hex.length >= 2) {
      const bytes = Buffer.from(hex, 'hex')
      if (bytes[0] === 0xfe && bytes[1] === 0xff) return normalizeWhitespace(decodeUtf16Be(bytes.subarray(2)))
      return normalizeWhitespace(bytes.toString('utf8')) || normalizeWhitespace(bytes.toString('latin1'))
    }
  }

  if (text.startsWith('(') && text.endsWith(')')) text = text.slice(1, -1)
  // Convert octal escape sequences to bytes for proper encoding detection
  const bytes: number[] = []
  let i = 0
  while (i < text.length) {
    if (text[i] === '\\' && i + 1 < text.length && /[0-7]/.test(text[i + 1])) {
      let octal = ''
      let j = i + 1
      while (j < text.length && j < i + 4 && /[0-7]/.test(text[j])) {
        octal += text[j]
        j++
      }
      bytes.push(parseInt(octal, 8))
      i = j
    } else {
      bytes.push(text.charCodeAt(i))
      i++
    }
  }
  // Check for UTF-16 BE BOM (0xFE 0xFF)
  if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) {
    const raw = Buffer.from(bytes.slice(2))
    return normalizeWhitespace(decodeUtf16Be(raw))
  }
  text = String.fromCharCode(...bytes)
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\\\/g, '\\')
  return normalizeWhitespace(text)
}

const getPdfInfoField = (source: string, field: string) => {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const literal = new RegExp(`/${escaped}\\s*(\\((?:\\\\.|[^\\)]){0,1200}\\)|<[^>]{2,2400}>)`, 'i').exec(source)?.[1]
  return decodePdfString(literal)
}

const stripXml = (value?: string) => normalizeWhitespace(value?.replace(/<[^>]+>/g, ' '))

const extractAbstractFromText = (text: string) => {
  const normalized = text.replace(/\r/g, '\n')
  // Normalize common PDF parsing artifacts:
  // - "Abstra ct" -> "Abstract"
  // - "A B S T R A C T" -> "ABSTRACT"
  const cleaned = normalized
    .replace(/Abstra\s+ct/gi, 'Abstract')
    .replace(/A\s+B\s+S\s+T\s+R\s+A\s+C\s+T/gi, 'ABSTRACT')
  // Support multiple abstract formats:
  // - Abstract / 摘要 (standard IEEE, ACM, etc.)
  // - Summary / SUMMARY (some journals)
  // - In brief / In Brief (Cell Press journals)
  // - Public Summary / PUBLIC SUMMARY (The Innovation)
  // - Highlights (some journals)
  const match = cleaned.match(
    /(?:^|\n)\s*(?:#{1,6}\s*)?(?:abstract|摘要|summary|in brief|public summary|highlights)\s*[:：\-—–]?\s*\n?([\s\S]{80,8000}?)(?=\n\s*(?:#{1,6}\s*)?(?:keywords?|index terms|introduction|1\.?\s+introduction|i\.?\s+introduction|关键词|引言|简介|article|graphical abstract|THE BIGGER PICTURE|PUBLIC SIGNIFICANCE|manuscript received)\b|$)/i
  )
  if (match) return normalizeWhitespace(match[1]?.replace(/^[\s\-–—:：]+/, ''))

  // Fallback: Scientific Reports / Nature format (no explicit abstract label)
  // Pattern: title + authors + abstract text + Keywords
  // Look for text between title/authors and Keywords section
  const keywordsMatch = normalized.match(/\n\s*(?:#{1,6}\s*)?Keywords?\s*[:：\-—–\s]?\s*[A-Z\n]/i)
  if (keywordsMatch?.index && keywordsMatch.index > 200) {
    const beforeKeywords = normalized.slice(0, keywordsMatch.index)
    const lines = beforeKeywords.split('\n')
    
    // Find where the abstract starts (skip title, authors, metadata)
    let abstractStartLine = 0
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()
      if (!line) continue
      // Skip common non-abstract lines
      if (/^www\.|^OPEN|^Check for updates|^Received|^Published|^Copyright|^\d+$/.test(line)) {
        abstractStartLine = i + 1
        continue
      }
      // Skip title lines (start with #)
      if (/^#/.test(line)) {
        abstractStartLine = i + 1
        continue
      }
      // Skip author lines (contain sup tags, numbers, or are short)
      if (/^<sup>|@.*\.edu|@.*\.ac|@.*\.org/.test(line)) {
        abstractStartLine = i + 1
        continue
      }
      // Skip lines that look like author names (contain <sup> tags or are short)
      if (/<sup>/.test(line) || (line.length < 150 && /^[A-Z][a-z]+ [A-Z]/.test(line))) {
        abstractStartLine = i + 1
        continue
      }
      // If line is long enough and doesn't look like metadata, it's likely the abstract
      if (line.length > 100 && !/^Keywords|^Received|^Published|^Copyright/i.test(line)) {
        abstractStartLine = i
        break
      }
    }
    
    // Get the abstract text
    const abstractLines = lines.slice(abstractStartLine)
    const abstractText = abstractLines.join('\n').replace(/^\s+/gm, '').trim()
    
    // Only use if it's substantial (80+ chars)
    if (abstractText.length >= 80) {
      return normalizeWhitespace(abstractText)
    }
  }

  return undefined
}

const getXmpField = (source: string, tag: string) => {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]{0,3000}?)</${tag}>`, 'i').exec(source)
  return stripXml(match?.[1])
}

const splitAuthors = (value?: string) => {
  const text = normalizeWhitespace(value)
  if (!text) return []
  return text
    .split(/\s*(?:;|,\s+and\s+|\band\b|\|)\s*/i)
    .map((item) => normalizeWhitespace(item))
    .filter((item): item is string => !!item && item.length > 1)
    .slice(0, 30)
}

const yearFromCrossref = (work: CrossrefWork) => {
  const candidates = [work['published-print'], work['published-online'], work.published, work.issued]
  for (const item of candidates) {
    const year = item?.['date-parts']?.[0]?.[0]
    if (Number.isInteger(year) && year! > 1800 && year! < 2200) return year
  }
  return undefined
}

const crossrefAuthors = (authors?: CrossrefWork['author']) =>
  authors
    ?.map((author) => normalizeWhitespace(author.name || [author.given, author.family].filter(Boolean).join(' ')))
    .filter((item): item is string => !!item)
    .slice(0, 50) || []

const mergeMetadata = (base: ExtractedPdfMetadata, extra?: Partial<ExtractedPdfMetadata>): ExtractedPdfMetadata => ({
  ...base,
  ...Object.fromEntries(Object.entries(extra || {}).filter(([, value]) => value !== undefined && value !== null && (!(Array.isArray(value)) || value.length > 0))),
  raw: { ...(base.raw || {}), ...(extra?.raw || {}) },
})

const ARXIV_API = 'http://export.arxiv.org/api/query'
const CROSSREF_WORKS = 'https://api.crossref.org/works'

const fetchWithTimeout = async (url: string, ms = 10000) => {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), ms)
  try {
    return await fetch(url, {
      signal: ac.signal,
      headers: { 'User-Agent': 'YARC/2.0 (metadata lookup; mailto:unknown@example.invalid)' },
    })
  } finally {
    clearTimeout(timer)
  }
}

export class MetadataService {
  extractFromPdfBuffer(buffer: Buffer, fileName: string): ExtractedPdfMetadata {
    // This intentionally avoids a heavyweight PDF parser. It reads the binary as
    // text-like data and extracts common Info/XMP fields plus DOI/arXiv IDs. MinerU
    // remains the authoritative full-text parser later in the upload pipeline.
    const latin = buffer.toString('latin1')
    const utf8 = buffer.toString('utf8')
    const combined = `${latin}\n${utf8}`

    const title = normalizeWhitespace(
      getPdfInfoField(latin, 'Title') ||
      getXmpField(utf8, 'dc:title') ||
      getXmpField(utf8, 'pdf:Title')
    )
    const authorText = getPdfInfoField(latin, 'Author') || getXmpField(utf8, 'dc:creator') || getXmpField(utf8, 'pdf:Author')
    const doi = cleanDoi(combined)
    const arxivId = ARXIV_REGEX.exec(combined)?.[1]
    const yearMatch = combined.match(/(?:19|20)\d{2}/)

    return {
      title: title && !/^untitled$/i.test(title) ? title : undefined,
      authors: splitAuthors(authorText),
      year: yearMatch ? Number(yearMatch[0]) : undefined,
      doi,
      arxivId,
      source: 'pdf-metadata',
      raw: {
        fileName,
        pdfInfoTitle: title,
        pdfInfoAuthor: authorText,
      },
    }
  }

  async lookupByDoi(doi?: string | null): Promise<ExtractedPdfMetadata | null> {
    const clean = cleanDoi(doi)
    if (!clean) return null
    try {
      const res = await fetchWithTimeout(`${CROSSREF_WORKS}/${encodeURIComponent(clean)}`)
      if (!res.ok) return null
      const body = await res.json() as { message?: CrossrefWork }
      const work = body.message
      if (!work) return null

      const title = normalizeWhitespace(work.title?.[0])
      const abstract = stripXml(work.abstract)
      return {
        title,
        authors: crossrefAuthors(work.author),
        year: yearFromCrossref(work),
        doi: work.DOI || clean,
        url: work.URL || `https://doi.org/${clean}`,
        abstract,
        journal: normalizeWhitespace(work['container-title']?.[0]),
        source: 'crossref',
        raw: { containerTitle: work['container-title']?.[0] },
      }
    } catch {
      return null
    }
  }

  async lookupByArxivId(arxivId?: string | null): Promise<ExtractedPdfMetadata | null> {
    if (!arxivId) return null
    try {
      const res = await fetchWithTimeout(`${ARXIV_API}?id_list=${encodeURIComponent(arxivId)}`)
      if (!res.ok) return null
      const xml = await res.text()

      // 简单 XML 解析
      const entry = xml.match(/<entry>([\s\S]*?)<\/entry>/)?.[1]
      if (!entry) return null

      const title = normalizeWhitespace(
        entry.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.replace(/\s+/g, ' ')
      )
      const abstract = normalizeWhitespace(
        entry.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.replace(/\s+/g, ' ')
      )
      const authors = [...entry.matchAll(/<author>\s*<name>(.*?)<\/name>\s*<\/author>/g)]
        .map(m => normalizeWhitespace(m[1]))
        .filter((s): s is string => !!s)
      const published = entry.match(/<published>(\d{4})-/)?.[1]
      const year = published ? Number(published) : undefined
      const doiMatch = entry.match(/<arxiv:doi>(.*?)<\/arxiv:doi>/)?.[1]
      const link = entry.match(/<link[^>]*href="([^"]+)"[^>]*title="pdf"/)?.[1]

      return {
        title,
        authors,
        year,
        doi: cleanDoi(doiMatch),
        arxivId,
        abstract,
        url: link || `https://arxiv.org/abs/${arxivId}`,
        source: 'arxiv',
        raw: {},
      }
    } catch {
      return null
    }
  }

  async lookupByTitle(title?: string | null, originalAuthors?: string[]): Promise<ExtractedPdfMetadata | null> {
    if (!title || title.length < 10) return null

    // 优先用 arXiv 标题搜索 (精确匹配)
    const arxivResult = await this.searchArxivByTitle(title, originalAuthors)
    if (arxivResult) return arxivResult

    // 降级到 Crossref 标题搜索
    return this.searchCrossrefByTitle(title, originalAuthors)
  }

  private async searchArxivByTitle(title: string, originalAuthors?: string[]): Promise<ExtractedPdfMetadata | null> {
    try {
      const cleaned = title.replace(/[:]/g, ' ').replace(/\s+/g, ' ').trim()
      const query = encodeURIComponent(`ti:"${cleaned}"`)
      const res = await fetchWithTimeout(`${ARXIV_API}?search_query=${query}&max_results=1`)
      if (!res.ok) return null
      const xml = await res.text()

      const entry = xml.match(/<entry>([\s\S]*?)<\/entry>/)?.[1]
      if (!entry) return null

      const entryTitle = normalizeWhitespace(
        entry.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.replace(/\s+/g, ' ')
      )
      const abstract = normalizeWhitespace(
        entry.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.replace(/\s+/g, ' ')
      )
      const authors = [...entry.matchAll(/<author>\s*<name>(.*?)<\/name>\s*<\/author>/g)]
        .map(m => normalizeWhitespace(m[1]))
        .filter((s): s is string => !!s)
      const published = entry.match(/<published>(\d{4})/)?.[1]
      const year = published ? Number(published) : undefined
      const arxivId = entry.match(/<id>.*?\/abs\/(.+?)<\/id>/)?.[1]?.replace(/v\d+$/, '')
      const doiMatch = entry.match(/<arxiv:doi>(.*?)<\/arxiv:doi>/)?.[1]
      const link = entry.match(/<link[^>]*href="([^"]+)"[^>]*title="pdf"/)?.[1]

      // 综合相似度: 标题词重叠 (权重 0.8) + 首作者姓氏匹配 (权重 0.2)
      if (entryTitle) {
        const origWords = title.toLowerCase().split(/\s+/).filter(w => w.length > 2)
        const matchWords = entryTitle.toLowerCase().split(/\s+/).filter(w => w.length > 2)
        const titleScore = origWords.filter(w => matchWords.includes(w)).length / Math.max(origWords.length, 1)
        let authorScore = 0
        if (originalAuthors && originalAuthors.length > 0 && authors.length > 0) {
          const firstAuthor = originalAuthors[0].toLowerCase().split(/\s+/).pop() || ''
          if (firstAuthor.length > 2 && authors.some(a => a.toLowerCase().includes(firstAuthor))) {
            authorScore = 1
          }
        }
        const score = titleScore * 0.8 + authorScore * 0.2
        if (score < 0.5) return null
      }

      return {
        title: entryTitle,
        authors,
        year,
        doi: cleanDoi(doiMatch),
        arxivId,
        abstract,
        url: link || (arxivId ? `https://arxiv.org/abs/${arxivId}` : undefined),
        source: 'arxiv-title',
        raw: {},
      }
    } catch {
      return null
    }
  }

  private async searchCrossrefByTitle(title: string, originalAuthors?: string[]): Promise<ExtractedPdfMetadata | null> {
    try {
      const cleaned = title
        .replace(/^[^:]+:\s*/, '')
        .replace(/\b(the|a|an|of|for|in|on|to|with|and|or|is|are|by|from|using)\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim()
      const query = encodeURIComponent(cleaned)
      const res = await fetchWithTimeout(`${CROSSREF_WORKS}?query.bibliographic=${query}&rows=5&select=DOI,title,author,published-print,published-online,published,issued,URL,abstract,container-title`)
      if (!res.ok) return null
      const body = await res.json() as { message?: { items?: CrossrefWork[] } }
      const items = body.message?.items || []

      const origWords = title.toLowerCase().split(/\s+/).filter(w => w.length > 2)
      let best: { work: CrossrefWork; score: number } | null = null
      for (const work of items) {
        const candidate = normalizeWhitespace(work.title?.[0]) || ''
        const matchWords = candidate.toLowerCase().split(/\s+/).filter(w => w.length > 2)
        const titleScore = origWords.filter(w => matchWords.includes(w)).length / Math.max(origWords.length, 1)
        // 作者加分: 首作者姓氏匹配
        let authorScore = 0
        if (originalAuthors && originalAuthors.length > 0) {
          const firstAuthor = originalAuthors[0].toLowerCase().split(/\s+/).pop() || ''
          const candidateAuthors = crossrefAuthors(work.author)
          if (firstAuthor.length > 2 && candidateAuthors.some(a => a.toLowerCase().includes(firstAuthor))) {
            authorScore = 1
          }
        }
        const score = titleScore * 0.8 + authorScore * 0.2
        if (!best || score > best.score) best = { work, score }
      }

      if (!best || best.score < 0.7) return null

      const work = best.work
      const abstract = stripXml(work.abstract)
      return {
        title: normalizeWhitespace(work.title?.[0]),
        authors: crossrefAuthors(work.author),
        year: yearFromCrossref(work),
        doi: work.DOI,
        url: work.URL || (work.DOI ? `https://doi.org/${work.DOI}` : undefined),
        abstract,
        journal: normalizeWhitespace(work['container-title']?.[0]),
        source: 'crossref-title',
        raw: { containerTitle: work['container-title']?.[0], matchScore: best.score },
      }
    } catch {
      return null
    }
  }

  async extractAndLookup(buffer: Buffer, fileName: string): Promise<ExtractedPdfMetadata> {
    const extracted = this.extractFromPdfBuffer(buffer, fileName)
    const crossref = await this.lookupByDoi(extracted.doi)
    return crossref ? mergeMetadata(extracted, crossref) : extracted
  }

  extractFromParsedContent(parseResult: any): ExtractedPdfMetadata {
    // 只取第一页文本，避免匹配到参考文献中的 DOI/arXiv ID
    const pages = parseResult?.pages
    let firstPageText: string
    let frontMatterText: string
    if (Array.isArray(pages) && pages.length > 1) {
      firstPageText = String(pages[0].text || '')
      frontMatterText = pages.slice(0, 2).map((page: any) => String(page.text || '')).join('\n').slice(0, 8000)
    } else if (Array.isArray(pages) && pages.length === 1) {
      firstPageText = String(pages[0].text || '').slice(0, 3000)
      frontMatterText = String(pages[0].text || '').slice(0, 8000)
    } else {
      firstPageText = String(parseResult?.text || '').slice(0, 3000)
      frontMatterText = String(parseResult?.text || '').slice(0, 8000)
    }
    const ids = this.extractIdsFromText(firstPageText)
    // 从第一页提取标题 (首个 # 开头的行)
    const parsedTitle = firstPageText.match(/^\s*#\s+(.+)/m)?.[1]?.trim()
    // 提取作者: 标题后的第一个非空行
    const titleMatch = firstPageText.match(/^\s*#\s+.+/m)
    let parsedAuthors: string[] = []
    if (titleMatch) {
      const afterTitle = firstPageText.slice(titleMatch.index! + titleMatch[0].length)
      const authorLine = afterTitle.match(/\n\s*([^\n#]+?)\s*\n/)?.[1]?.trim()
      if (authorLine && authorLine.length > 3 && authorLine.length < 300 && !/abstract|keywords|\d{4}/i.test(authorLine)) {
        parsedAuthors = splitAuthors(authorLine)
      }
    }
    return {
      doi: ids.doi,
      arxivId: ids.arxivId,
      title: parsedTitle,
      authors: parsedAuthors,
      abstract: extractAbstractFromText(frontMatterText),
      source: 'parsed-text',
      raw: { textSample: firstPageText.slice(0, 1000) },
    }
  }

  extractIdsFromText(text: string) {
    return {
      doi: cleanDoi(text),
      arxivId: ARXIV_REGEX.exec(text)?.[1],
    }
  }
}

export const metadataService = new MetadataService()
