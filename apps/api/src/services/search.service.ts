import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { prisma, type Prisma } from '@yarc/db'
import { config } from '../lib/config.js'
import {
  parseVectorLiteral,
  type PaperReferenceInput,
  type PaperReferenceResolution,
  type SearchPaper,
} from '@yarc/shared'
import { cleanSnippetForDisplay } from '../lib/text-cleaning.js'
import { embeddingService } from './embedding.service.js'
import { ieeeXploreService, readIeeeJournalBrowserPreferences } from './ieee-xplore.service.js'

interface SearchResult {
  id: string
  paperId: string
  title: string
  snippet: string
  similarity: number
  pageNumber: number | null
  authors?: string[]
  year?: number | null
  url?: string | null
  doi?: string | null
  arxivId?: string | null
  journal?: string | null
  venue?: string | null
}

interface SearchResponse {
  papers: SearchPaper[]
  total: number
  page: number
  limit: number
  error?: string
}

const S2_API_BASE = 'https://api.semanticscholar.org/graph/v1'
const IEEE_BASE_URL = 'https://ieeexplore.ieee.org'

const S2_FIELDS = [
  'paperId',
  'title',
  'abstract',
  'year',
  'venue',
  'publicationVenue',
  'publicationTypes',
  'publicationDate',
  'url',
  'openAccessPdf',
  'authors',
  'externalIds',
  'citationCount',
  'referenceCount',
  'fieldsOfStudy',
  's2FieldsOfStudy',
  'tldr',
].join(',')

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function fetchJsonWithRetry(
  url: string,
  init: RequestInit = {},
  retries = 2
): Promise<any> {
  let lastError: Error | null = null

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        ...init,
        signal: init.signal || AbortSignal.timeout(30000),
      })

      if (res.ok) return res.json()

      const body = await res.text().catch(() => '')
      const retryable = [429, 500, 502, 503, 504].includes(res.status)
      if (retryable && attempt < retries) {
        await sleep(1500 * (attempt + 1))
        continue
      }

      throw new Error(`HTTP ${res.status}${body ? `: ${body}` : ''}`)
    } catch (err) {
      lastError = err as Error
      if (attempt < retries) {
        await sleep(1500 * (attempt + 1))
        continue
      }
      throw lastError
    }
  }

  throw lastError || new Error('Request failed')
}

const cleanText = (value: unknown) => {
  if (value === null || value === undefined) return null
  const text = String(value).replace(/\s+/g, ' ').trim()
  return text || null
}

const numberOrNull = (value: unknown) => {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

const extractIEEEArticleNumber = (value: unknown) => {
  const text = cleanText(value)
  if (!text) return null
  const direct = text.match(/(?:arnumber=|\/document\/)(\d+)/i)?.[1]
  if (direct) return direct
  return /^\d{4,}$/.test(text) ? text : null
}

const ieeePdfUrlForArticle = (articleNumber: unknown) => {
  const arnumber = extractIEEEArticleNumber(articleNumber)
  return arnumber ? `${IEEE_BASE_URL}/stampPDF/getPDF.jsp?tp=&arnumber=${arnumber}` : null
}

const normalizeForSearch = (value: unknown) => String(value ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
const normalizeTitle = (value: unknown) => normalizeForSearch(value)
  .normalize('NFKC')
  .replace(/[\p{P}\p{S}]+/gu, ' ')
  .replace(/\s+/g, ' ')
  .trim()
const normalizeDoi = (value: unknown) => String(value ?? '')
  .trim()
  .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
  .replace(/^doi:\s*/i, '')
  .toLowerCase()
const normalizeArxivId = (value: unknown) => String(value ?? '')
  .trim()
  .replace(/^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\//i, '')
  .replace(/\.pdf$/i, '')
  .replace(/^arxiv:\s*/i, '')
  .replace(/v\d+$/i, '')
  .toLowerCase()
const authorFamilyNames = (authors: string[] = []) => new Set(authors
  .map(author => normalizeForSearch(author).split(/\s+/).filter(Boolean).at(-1))
  .filter((name): name is string => !!name))

const readSetCookieHeaders = (headers: Headers) => {
  const values = (headers as any).getSetCookie?.()
  if (Array.isArray(values)) return values as string[]
  const combined = headers.get('set-cookie')
  return combined ? combined.split(/,(?=\s*[^;,=]+=[^;,]+)/g) : []
}

const addResponseCookies = (headers: Headers, jar: Map<string, string>) => {
  for (const cookie of readSetCookieHeaders(headers)) {
    const pair = cookie.split(';')[0]?.trim()
    if (!pair) continue
    const eq = pair.indexOf('=')
    if (eq <= 0) continue
    jar.set(pair.slice(0, eq), pair.slice(eq + 1))
  }
}

const cookieHeader = (jar: Map<string, string>) => Array.from(jar.entries())
  .map(([key, value]) => `${key}=${value}`)
  .join('; ')

const isPrivateIPv4 = (address: string) => {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return true
  const [a, b] = parts
  return a === 10 || a === 127 || a === 0 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
}

const isPrivateIPv6 = (address: string) => {
  const normalized = address.toLowerCase()
  return normalized === '::1' ||
    normalized === '::' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb') ||
    normalized.startsWith('::ffff:127.') ||
    normalized.startsWith('::ffff:10.') ||
    normalized.startsWith('::ffff:192.168.') ||
    /^::ffff:172\.(1[6-9]|2\d|3[01])\./.test(normalized)
}

const isBlockedAddress = (address: string) => {
  const version = isIP(address)
  if (version === 4) return isPrivateIPv4(address)
  if (version === 6) return isPrivateIPv6(address)
  return true
}

async function assertSafePdfDownloadUrl(rawUrl: string): Promise<void> {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new Error('Invalid PDF URL')
  }

  if (parsed.protocol !== 'https:') {
    throw new Error('Only HTTPS PDF URLs are allowed')
  }

  const hostname = parsed.hostname.toLowerCase()
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new Error('Localhost PDF URLs are not allowed')
  }

  const directIpVersion = isIP(hostname)
  const addresses = directIpVersion
    ? [{ address: hostname }]
    : await lookup(hostname, { all: true, verbatim: true })

  if (!addresses.length || addresses.some(({ address }) => isBlockedAddress(address))) {
    throw new Error('Private or local network PDF URLs are not allowed')
  }
}

async function fetchWithCookieJar(
  url: string,
  init: RequestInit = {},
  maxRedirects = 5
): Promise<Response> {
  const jar = new Map<string, string>()
  let currentUrl = url
  let response: Response | null = null

  for (let redirect = 0; redirect <= maxRedirects; redirect++) {
    await assertSafePdfDownloadUrl(currentUrl)
    const headers = new Headers(init.headers)
    if (jar.size) headers.set('Cookie', cookieHeader(jar))
    response = await fetch(currentUrl, {
      ...init,
      headers,
      redirect: 'manual',
    })
    addResponseCookies(response.headers, jar)

    if (![301, 302, 303, 307, 308].includes(response.status)) return response
    const location = response.headers.get('location')
    if (!location) return response
    currentUrl = new URL(location, currentUrl).toString()
  }

  return response || fetch(url, init)
}

export class SearchService {
  private localPaperToSearchPaper(paper: any): SearchPaper {
    const metadata = (paper.metadata || {}) as Record<string, unknown>
    return {
      id: paper.id,
      title: paper.title,
      abstract: paper.abstract,
      authors: paper.authors || [],
      year: paper.year,
      url: paper.url,
      doi: paper.doi,
      arxivId: paper.arxivId,
      journal: typeof metadata.journal === 'string' ? metadata.journal : null,
      venue: typeof metadata.venue === 'string' ? metadata.venue : null,
      source: 'local',
      filePath: paper.filePath,
      parseStatus: paper.parseStatus,
    }
  }

  private semanticScholarPaperToSearchPaper(paper: any): SearchPaper {
    const externalIds = paper.externalIds || {}
    const publicationVenue = paper.publicationVenue || {}
    return {
      id: paper.paperId,
      title: cleanText(paper.title) || '',
      abstract: cleanText(paper.abstract),
      authors: Array.isArray(paper.authors)
        ? paper.authors.map((author: any) => cleanText(author.name)).filter((author: string | null): author is string => !!author)
        : [],
      year: numberOrNull(paper.year),
      url: cleanText(paper.url),
      pdfUrl: cleanText(paper.openAccessPdf?.url),
      doi: cleanText(externalIds.DOI),
      arxivId: cleanText(externalIds.ArXiv),
      journal: cleanText(publicationVenue.name),
      venue: cleanText(paper.venue) || cleanText(publicationVenue.name),
      source: 'semantic_scholar',
      citationCount: numberOrNull(paper.citationCount),
      referenceCount: numberOrNull(paper.referenceCount),
      publicationDate: cleanText(paper.publicationDate),
      publicationTypes: paper.publicationTypes || [],
      fieldsOfStudy: paper.fieldsOfStudy || [],
      openAccessPdf: paper.openAccessPdf || null,
      tldr: cleanText(paper.tldr?.text),
    }
  }

  private async findLocalReferenceCandidates(reference: PaperReferenceInput): Promise<SearchPaper[]> {
    if (reference.localPaperId) {
      const paper = await prisma.paper.findUnique({ where: { id: reference.localPaperId } })
      return paper ? [this.localPaperToSearchPaper(paper)] : []
    }

    const doi = normalizeDoi(reference.doi)
    const arxivId = normalizeArxivId(reference.arxivId)
    const title = String(reference.title || '').trim()
    const or: Prisma.PaperWhereInput[] = []
    if (doi) or.push({ doi: { contains: doi, mode: 'insensitive' } })
    if (arxivId) or.push({ arxivId: { contains: arxivId, mode: 'insensitive' } })
    if (title) {
      or.push({ title: { contains: title, mode: 'insensitive' } })
      const titleProbe = title.split(/[^\p{L}\p{N}]+/u).filter(part => part.length >= 3).slice(0, 4).join(' ')
      if (titleProbe && titleProbe !== title) or.push({ title: { contains: titleProbe, mode: 'insensitive' } })
    }
    if (!or.length) return []

    const papers = await prisma.paper.findMany({ where: { OR: or }, take: 20, orderBy: { createdAt: 'desc' } })
    return papers.map(paper => this.localPaperToSearchPaper(paper))
  }

  private scoreReferenceCandidate(reference: PaperReferenceInput, paper: SearchPaper) {
    const doi = normalizeDoi(reference.doi)
    const arxivId = normalizeArxivId(reference.arxivId)
    if (doi && normalizeDoi(paper.doi) === doi) return 100
    if (arxivId && normalizeArxivId(paper.arxivId) === arxivId) return 100
    if (reference.semanticScholarId && paper.source === 'semantic_scholar' && paper.id === reference.semanticScholarId) return 100

    const expectedTitle = normalizeTitle(reference.title)
    const actualTitle = normalizeTitle(paper.title)
    if (!expectedTitle || !actualTitle) return 0

    let score = expectedTitle === actualTitle ? 80 : 0
    if (!score && (actualTitle.includes(expectedTitle) || expectedTitle.includes(actualTitle))) score = 55
    if (reference.year && paper.year === reference.year) score += 10

    const expectedAuthors = authorFamilyNames(reference.authors)
    const actualAuthors = authorFamilyNames(paper.authors)
    if (expectedAuthors.size && Array.from(expectedAuthors).some(author => actualAuthors.has(author))) score += 10
    return score
  }

  private async getSemanticScholarPaper(identifier: string): Promise<SearchPaper | null> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': 'YARC/2.0 SemanticScholarReferenceResolver',
    }
    if (config.semanticScholarApiKey) headers['x-api-key'] = config.semanticScholarApiKey

    try {
      const data = await fetchJsonWithRetry(
        `${S2_API_BASE}/paper/${encodeURIComponent(identifier)}?fields=${encodeURIComponent(S2_FIELDS)}`,
        { headers },
        1
      )
      return data?.paperId ? this.semanticScholarPaperToSearchPaper(data) : null
    } catch {
      return null
    }
  }

  private async resolvePaperReference(reference: PaperReferenceInput): Promise<PaperReferenceResolution> {
    const original = { ...reference }
    try {
      const localCandidates = await this.findLocalReferenceCandidates(reference)
      const rankedLocal = localCandidates
        .map(paper => ({ paper, score: reference.localPaperId && paper.id === reference.localPaperId ? 100 : this.scoreReferenceCandidate(reference, paper) }))
        .filter(item => item.score >= 55)
        .sort((a, b) => b.score - a.score)

      const localLeadIsClear = rankedLocal[0]?.score >= 80
        && (!rankedLocal[1] || rankedLocal[0].score - rankedLocal[1].score >= 10)
      if (rankedLocal[0]?.score === 100 || localLeadIsClear) {
        const matchedBy = reference.localPaperId ? 'local'
          : normalizeDoi(reference.doi) ? 'doi'
            : normalizeArxivId(reference.arxivId) ? 'arxiv'
              : 'title'
        return {
          key: reference.key,
          status: 'resolved',
          matchedBy,
          confidence: rankedLocal[0].score === 100 ? 'exact' : 'high',
          localPaper: rankedLocal[0].paper,
          paper: rankedLocal[0].paper,
          candidates: [],
          original,
        }
      }

      if (rankedLocal.length > 1) {
        return {
          key: reference.key,
          status: 'ambiguous',
          matchedBy: 'title',
          confidence: 'medium',
          localPaper: null,
          paper: null,
          candidates: rankedLocal.slice(0, 8).map(item => item.paper),
          original,
        }
      }

      const doi = normalizeDoi(reference.doi)
      const arxivId = normalizeArxivId(reference.arxivId)
      const exactIdentifier = reference.semanticScholarId
        || (doi ? `DOI:${doi}` : '')
        || (arxivId ? `ARXIV:${arxivId}` : '')
      if (exactIdentifier) {
        const paper = await this.getSemanticScholarPaper(exactIdentifier)
        if (paper) {
          return {
            key: reference.key,
            status: 'resolved',
            matchedBy: reference.semanticScholarId ? 'semantic_scholar' : doi ? 'doi' : 'arxiv',
            confidence: 'exact',
            localPaper: null,
            paper,
            candidates: [],
            original,
          }
        }
      }

      if (reference.ieeeArticleNumber) {
        const response = await this.searchIEEE(reference.ieeeArticleNumber, 'all', 1, 8)
        const exact = response.papers.filter(paper => String(paper.articleNumber || paper.id) === reference.ieeeArticleNumber)
        if (exact.length === 1 || (exact.length === 0 && response.papers.length === 1)) {
          return {
            key: reference.key,
            status: 'resolved',
            matchedBy: 'ieee',
            confidence: exact.length === 1 ? 'exact' : 'high',
            localPaper: null,
            paper: exact[0] || response.papers[0],
            candidates: [],
            original,
          }
        }
        const candidates = exact.length > 1 ? exact : response.papers
        if (candidates.length > 1) {
          return {
            key: reference.key,
            status: 'ambiguous',
            matchedBy: 'ieee',
            confidence: 'medium',
            localPaper: null,
            paper: null,
            candidates: candidates.slice(0, 8),
            original,
          }
        }
      }

      const title = String(reference.title || '').trim()
      if (title) {
        const response = await this.searchSemanticScholar(title, 'title', 1, 8, reference.year || undefined, reference.year || undefined)
        const ranked = response.papers
          .map(paper => ({ paper, score: this.scoreReferenceCandidate(reference, paper) }))
          .filter(item => item.score >= 55)
          .sort((a, b) => b.score - a.score)

        const externalLeadIsClear = ranked[0]?.score >= 80
          && (!ranked[1] || ranked[0].score - ranked[1].score >= 10)
        if (externalLeadIsClear) {
          return {
            key: reference.key,
            status: 'resolved',
            matchedBy: 'title',
            confidence: 'high',
            localPaper: null,
            paper: ranked[0].paper,
            candidates: [],
            original,
          }
        }
        if (ranked.length) {
          return {
            key: reference.key,
            status: 'ambiguous',
            matchedBy: 'title',
            confidence: 'medium',
            localPaper: null,
            paper: null,
            candidates: ranked.slice(0, 8).map(item => item.paper),
            original,
          }
        }
      }

      return { key: reference.key, status: 'not_found', localPaper: null, paper: null, candidates: [], original }
    } catch (err) {
      return {
        key: reference.key,
        status: 'error',
        localPaper: null,
        paper: null,
        candidates: [],
        original,
        error: (err as Error).message || 'Failed to resolve paper reference',
      }
    }
  }

  async resolvePaperReferences(references: PaperReferenceInput[]): Promise<PaperReferenceResolution[]> {
    const results = new Array<PaperReferenceResolution>(references.length)
    let cursor = 0
    const worker = async () => {
      while (cursor < references.length) {
        const index = cursor++
        results[index] = await this.resolvePaperReference(references[index])
      }
    }
    await Promise.all(Array.from({ length: Math.min(3, references.length) }, () => worker()))
    return results
  }

  // ── Local Vector Search (pgvector) ──────────────────────────────────────

  async searchLocalVector(
    query: string,
    limit = 20,
    threshold = 0.5,
    paperId?: string
  ): Promise<SearchResponse> {
    try {
      const embedding = await embeddingService.generate(query)
      const results = await this._vectorQuery(embedding, limit, threshold, paperId)

      const paperMap = new Map<string, SearchResult>()
      for (const r of results) {
        const existing = paperMap.get(r.paperId)
        if (!existing || r.similarity > existing.similarity) paperMap.set(r.paperId, r)
      }

      const papers: SearchPaper[] = Array.from(paperMap.values()).map((r) => ({
        id: r.paperId,
        title: r.title,
        abstract: r.snippet,
        authors: r.authors || [],
        year: r.year,
        url: r.url,
        doi: r.doi,
        arxivId: r.arxivId,
        journal: r.journal,
        venue: r.venue,
        source: 'local' as const,
        similarity: r.similarity,
        pageNumber: r.pageNumber,
      }))

      return { papers, total: papers.length, page: 1, limit }
    } catch (err) {
      console.error('Local vector search failed:', err)
      return { papers: [], total: 0, page: 1, limit, error: (err as Error).message }
    }
  }

  // Backward-compatible vector search used by papers/chat routes.
  async searchLocal(
    _query: string,
    embedding: number[],
    limit = 20,
    threshold = 0.5,
    paperId?: string
  ): Promise<SearchResult[]> {
    return this._vectorQuery(embedding, limit, threshold, paperId)
  }

  private async _vectorQuery(
    embedding: number[],
    limit: number,
    threshold: number,
    paperId?: string
  ): Promise<SearchResult[]> {
    const vectorLiteral = parseVectorLiteral(embedding)
    const values = paperId
      ? [vectorLiteral, threshold, limit, paperId]
      : [vectorLiteral, threshold, limit]

    const rows = await prisma.$queryRawUnsafe<SearchResult[]>(
      `
      SELECT
        pc.id,
        pc.paper_id AS "paperId",
        p.title,
        p.authors,
        p.year,
        p.url,
        p.doi,
        p.arxiv_id AS "arxivId",
        p.metadata->>'journal' AS journal,
        p.metadata->>'venue' AS venue,
        pc.content AS snippet,
        pc.page_number AS "pageNumber",
        1 - (pc.embedding <=> $1::vector) AS similarity
      FROM paper_chunks pc
      JOIN papers p ON pc.paper_id = p.id
      WHERE pc.embedding IS NOT NULL
        AND 1 - (pc.embedding <=> $1::vector) > $2
        ${paperId ? 'AND p.id = $4::uuid' : ''}
      ORDER BY similarity DESC
      LIMIT $3
      `,
      ...values
    )

    return rows.map((row) => ({
      ...row,
      snippet: cleanSnippetForDisplay(row.snippet),
    }))
  }

  async searchLocalHybrid(
    query: string,
    field = 'all',
    limit = 20,
    offset = 0,
    threshold = 0.5,
    paperId?: string
  ): Promise<SearchResponse> {
    const normalizedField = field || 'all'
    const shouldUseVector = normalizedField === 'all' || normalizedField === 'abstract'
    const responses: SearchResponse[] = []

    if (shouldUseVector) {
      try {
        responses.push(await this.searchLocalVector(query, Math.max(limit + offset, limit), threshold, paperId))
      } catch (err) {
        console.warn('Local hybrid vector branch failed:', err)
      }
    }

    responses.push(await this.searchLocalKeyword(query, normalizedField, Math.max(limit + offset, limit), 0, paperId))

    const merged = new Map<string, SearchPaper>()
    for (const response of responses) {
      for (const paper of response.papers) {
        const existing = merged.get(paper.id)
        if (!existing) {
          merged.set(paper.id, paper)
          continue
        }

        merged.set(paper.id, {
          ...existing,
          ...Object.fromEntries(Object.entries(paper).filter(([, value]) => value !== undefined && value !== null && value !== '')),
          abstract: existing.abstract || paper.abstract || null,
          similarity: Math.max(Number(existing.similarity || 0), Number(paper.similarity || 0)) || undefined,
          pageNumber: existing.pageNumber ?? paper.pageNumber ?? null,
        })
      }
    }

    const papers = Array.from(merged.values())
      .sort((a, b) => Number(b.similarity || 0) - Number(a.similarity || 0))
      .slice(offset, offset + limit)

    return { papers, total: merged.size, page: Math.floor(offset / limit) + 1, limit }
  }

  // ── Local Keyword Search (Prisma) ──────────────────────────────────────

  async searchLocalKeyword(
    query: string,
    field = 'all',
    limit = 20,
    offset = 0,
    paperId?: string
  ): Promise<SearchResponse> {
    const pattern = `%${query}%`
    const compactPattern = `%${query.replace(/\s+/g, '')}%`
    const year = Number(query)
    const clauses: string[] = []
    const values: unknown[] = []

    const addClause = (sql: string, ...params: unknown[]) => {
      let paramIndex = 0
      clauses.push(sql.replace(/\?/g, () => {
        values.push(params[paramIndex++])
        return `$${values.length}`
      }))
    }

    if (field === 'all' || field === 'title') {
      addClause(`p.title ILIKE ?`, pattern)
    }
    if (field === 'all' || field === 'author') {
      addClause(
        `EXISTS (
          SELECT 1
          FROM unnest(p.authors) AS author
          WHERE replace(lower(author), ' ', '') LIKE lower(?)
             OR author ILIKE ?
        )`,
        compactPattern,
        pattern
      )
    }
    if (field === 'all' || field === 'abstract') {
      addClause(`p.abstract ILIKE ?`, pattern)
      addClause(
        `EXISTS (
          SELECT 1
          FROM paper_chunks pc
          WHERE pc.paper_id = p.id
            AND pc.content ILIKE ?
        )`,
        pattern
      )
    }
    if ((field === 'all' || field === 'year') && Number.isInteger(year)) {
      addClause(`p.year = ?`, year)
    }
    if (field === 'all' || field === 'journal' || field === 'venue') {
      addClause(`(p.metadata->>'journal' ILIKE ? OR p.metadata->>'venue' ILIKE ?)`, pattern, pattern)
    }

    if (clauses.length === 0) {
      addClause(`p.title ILIKE ?`, pattern)
    }

    const whereSql = paperId
      ? `(${clauses.join(' OR ')}) AND p.id = $${values.push(paperId)}::uuid`
      : clauses.join(' OR ')

    values.push(limit, offset)
    const limitParam = values.length - 1
    const offsetParam = values.length

    const papers = await prisma.$queryRawUnsafe<any[]>(
      `
      SELECT
        p.*,
        p.metadata->>'journal' AS journal,
        p.metadata->>'venue' AS venue,
        COUNT(*) OVER()::int AS "__total"
      FROM papers p
      WHERE ${whereSql}
      ORDER BY p.created_at DESC
      LIMIT $${limitParam}
      OFFSET $${offsetParam}
      `,
      ...values
    )
    const total = papers[0]?.__total || 0
    const snippets = await this.getLocalPaperSnippets(papers.map((p) => p.id), pattern)
    const normalizedQuery = normalizeForSearch(query)

    return {
      papers: papers.map((p) => {
        const snippet = snippets.get(p.id)
        const titleMatches = normalizeForSearch(p.title).includes(normalizedQuery)
        return {
          id: p.id,
          title: p.title,
          abstract: cleanSnippetForDisplay(p.abstract || snippet?.content || '', 700) || null,
          authors: p.authors,
          year: p.year,
          url: p.url,
          doi: p.doi,
          arxivId: p.arxiv_id || p.arxivId,
          journal: p.journal || null,
          venue: p.venue || null,
          source: 'local' as const,
          similarity: titleMatches ? 1 : snippet?.matched ? 0.65 : undefined,
          pageNumber: snippet?.pageNumber ?? null,
        }
      }),
      total,
      page: Math.floor(offset / limit) + 1,
      limit,
    }
  }

  private async getLocalPaperSnippets(
    paperIds: string[],
    pattern: string
  ): Promise<Map<string, { content: string; pageNumber: number | null; matched: boolean }>> {
    if (paperIds.length === 0) return new Map()

    const rows = await prisma.$queryRawUnsafe<Array<{
      paperId: string
      content: string
      pageNumber: number | null
      matched: boolean
    }>>(
      `
      SELECT DISTINCT ON (pc.paper_id)
        pc.paper_id::text AS "paperId",
        pc.content,
        pc.page_number AS "pageNumber",
        (pc.content ILIKE $2) AS matched
      FROM paper_chunks pc
      WHERE pc.paper_id::text = ANY($1)
      ORDER BY
        pc.paper_id,
        CASE WHEN pc.content ILIKE $2 THEN 0 ELSE 1 END,
        pc.chunk_index NULLS LAST,
        pc.created_at ASC
      `,
      paperIds,
      pattern
    )

    return new Map(rows.map((row) => [row.paperId, {
      content: cleanSnippetForDisplay(row.content, 700),
      pageNumber: row.pageNumber,
      matched: row.matched,
    }]))
  }

  // ── IEEE Xplore Search (compatibility delegation) ─────────────────────

  async searchIEEE(
    query: string,
    _field = 'all',
    page = 1,
    limit = 25,
    _yearFrom?: number,
    _yearTo?: number,
    options?: { earlyAccess?: boolean; publication?: string; sort?: 'relevance' | 'newest' }
  ): Promise<SearchResponse> {
    try {
      const preferences = await readIeeeJournalBrowserPreferences()
      const publication = String(options?.publication || '').trim().toLowerCase()
      const journal = publication
        ? preferences.journals.find(item =>
          item.id.toLowerCase() === publication ||
          item.publicationNumber === publication ||
          item.publicationTitle.toLowerCase() === publication ||
          item.displayName.toLowerCase() === publication
        )
        : undefined
      // Legacy publication remains a range hint only. It is deliberately never
      // substituted for the article query.
      return await ieeeXploreService.searchArticles({
        mode: 'search',
        q: query,
        journal,
        sort: options?.sort || 'relevance',
        page,
        limit,
      })
    } catch (err) {
      return {
        papers: [],
        total: 0,
        page: Math.max(page, 1),
        limit: Math.min(Math.max(limit, 1), 25),
        error: (err as Error).message || 'IEEE search failed',
      }
    }
  }

  // ── Semantic Scholar Search (direct TypeScript integration) ────────────

  async searchSemanticScholar(
    query: string,
    _field = 'all',
    page = 1,
    limit = 20,
    yearFrom?: number,
    yearTo?: number,
    options?: {
      venue?: string
      minCitations?: number
      publicationTypes?: string
      fieldsOfStudy?: string
      openAccess?: boolean
    }
  ): Promise<SearchResponse> {
    const boundedLimit = Math.min(Math.max(limit, 1), 100)
    const offset = (Math.max(page, 1) - 1) * boundedLimit

    const params = new URLSearchParams({
      query,
      limit: String(boundedLimit),
      offset: String(offset),
      fields: S2_FIELDS,
    })

    if (yearFrom || yearTo) params.set('year', `${yearFrom || ''}-${yearTo || ''}`)
    if (options?.venue) params.set('venue', options.venue)
    if (options?.minCitations) params.set('minCitationCount', String(options.minCitations))
    if (options?.publicationTypes) params.set('publicationTypes', options.publicationTypes)
    if (options?.fieldsOfStudy) params.set('fieldsOfStudy', options.fieldsOfStudy)
    if (options?.openAccess) params.set('openAccessPdf', '')

    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': 'YARC/2.0 SemanticScholarSearch',
    }
    if (config.semanticScholarApiKey) headers['x-api-key'] = config.semanticScholarApiKey

    try {
      const data = await fetchJsonWithRetry(`${S2_API_BASE}/paper/search?${params}`, { headers })
      const papers = (data.data || []).map((p: any): SearchPaper => {
        const externalIds = p.externalIds || {}
        const publicationVenue = p.publicationVenue || {}
        return {
          id: p.paperId,
          title: cleanText(p.title) || '',
          abstract: cleanText(p.abstract),
          authors: Array.isArray(p.authors)
            ? p.authors
                .map((a: any) => cleanText(a.name))
                .filter((a: string | null): a is string => !!a)
            : [],
          year: numberOrNull(p.year),
          url: cleanText(p.url),
          doi: cleanText(externalIds.DOI),
          arxivId: cleanText(externalIds.ArXiv),
          journal: cleanText(publicationVenue.name),
          venue: cleanText(p.venue) || cleanText(publicationVenue.name),
          source: 'semantic_scholar' as const,
          citationCount: numberOrNull(p.citationCount),
          referenceCount: numberOrNull(p.referenceCount),
          publicationDate: cleanText(p.publicationDate),
          publicationTypes: p.publicationTypes || [],
          fieldsOfStudy: p.fieldsOfStudy || [],
          openAccessPdf: p.openAccessPdf || null,
          tldr: cleanText(p.tldr?.text),
        }
      })

      return {
        papers,
        total: Number(data.total || 0),
        page,
        limit: boundedLimit,
      }
    } catch (err) {
      console.error('Semantic Scholar search failed:', err)
      return {
        papers: [],
        total: 0,
        page,
        limit: boundedLimit,
        error: `Semantic Scholar search failed: ${(err as Error).message}`,
      }
    }
  }

  // ── PDF Download ───────────────────────────────────────────────────────

  async downloadPdf(url: string): Promise<Buffer | null> {
    try {
      const downloadUrl = ieeePdfUrlForArticle(url) || url
      const response = await fetchWithCookieJar(downloadUrl, {
        headers: {
          Accept: 'application/pdf,application/octet-stream;q=0.9,*/*;q=0.8',
          Referer: IEEE_BASE_URL,
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        signal: AbortSignal.timeout(60000),
      })

      if (!response.ok) throw new Error(`Failed to download: ${response.status}`)

      const contentType = response.headers.get('content-type') || ''
      const buffer = Buffer.from(await response.arrayBuffer())
      const isPdf = buffer.subarray(0, 5).toString('utf-8') === '%PDF-'
      if (!isPdf && !contentType.toLowerCase().includes('pdf')) {
        throw new Error('URL did not return a PDF file')
      }

      return buffer
    } catch (err) {
      console.error('PDF download failed:', err)
      return null
    }
  }
}

export const searchService = new SearchService()
