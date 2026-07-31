import { prisma } from '@yarc/db'
import type {
  IeeeBrowseMode,
  IeeeJournalBrowserPreferences,
  IeeeJournalConfig,
  IeeeSearchRequest,
  IeeeSearchResponse,
  SearchPaper,
} from '@yarc/shared'

const IEEE_BASE_URL = 'https://ieeexplore.ieee.org'
const IEEE_REST_SEARCH_ENDPOINT = `${IEEE_BASE_URL}/rest/search`
const JOURNAL_PREFERENCES_KEY = 'ieee_journal_browser'
const DIRECTORY_CACHE_TTL_MS = 24 * 60 * 60 * 1000
const REQUEST_TIMEOUT_MS = 20_000
const MAX_JOURNALS = 50
const ieeeSessionCookies = new Map<string, string>()

const readSetCookieHeaders = (headers: Headers) => {
  const values = (headers as any).getSetCookie?.()
  if (Array.isArray(values)) return values as string[]
  const combined = headers.get('set-cookie')
  return combined ? combined.split(/,(?=\s*[^;,=]+=[^;,]+)/g) : []
}

export const captureIeeeSessionCookies = (headers: Headers) => {
  for (const cookie of readSetCookieHeaders(headers)) {
    const pair = cookie.split(';')[0]?.trim()
    if (!pair) continue
    const eq = pair.indexOf('=')
    if (eq <= 0) continue
    const name = pair.slice(0, eq)
    const value = pair.slice(eq + 1)
    if (value && value !== '_remove_') ieeeSessionCookies.set(name, value)
    else ieeeSessionCookies.delete(name)
  }
}

export const getIeeeSessionCookieJar = () => ieeeSessionCookies

const ieeeSessionCookieHeader = () => Array.from(ieeeSessionCookies.entries())
  .map(([key, value]) => `${key}=${value}`)
  .join('; ')

interface CachedValue<T> {
  value: T
  expiresAt: number
}

interface IeeeRestSearchData {
  records?: unknown[]
  totalRecords?: unknown
  total_records?: unknown
  total?: unknown
  userInfo?: unknown
}

export interface IeeeJournalLinks {
  currentIssueUrl: string
  earlyAccessUrl: string
  currentIssueNumber: string
  earlyAccessIssueNumber: string
}

export class IeeeXploreError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 502
  ) {
    super(message)
    this.name = 'IeeeXploreError'
  }
}

const cleanText = (value: unknown): string | null => {
  if (value === null || value === undefined) return null
  const text = String(value).replace(/\s+/g, ' ').trim()
  return text || null
}

const decodeHtml = (value: string) => value
  .replace(/&nbsp;/gi, ' ')
  .replace(/&amp;/gi, '&')
  .replace(/&lt;/gi, '<')
  .replace(/&gt;/gi, '>')
  .replace(/&quot;/gi, '"')
  .replace(/&#39;|&#x27;/gi, "'")

const stripHtml = (value: unknown) => cleanText(
  decodeHtml(String(value ?? '').replace(/\[::|::\]/g, '').replace(/<[^>]+>/g, ' '))
)

const numberOrNull = (value: unknown) => {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

const parseCount = (value: unknown) => {
  const number = Number(String(value ?? '').replace(/,/g, ''))
  return Number.isFinite(number) ? number : 0
}

const articleNumberFrom = (value: unknown) => {
  const text = cleanText(value)
  if (!text) return null
  return text.match(/(?:arnumber=|\/document\/)(\d+)/i)?.[1] || (/^\d{4,}$/.test(text) ? text : null)
}

const ieeePdfUrl = (articleNumber: string | null) => articleNumber
  ? `${IEEE_BASE_URL}/stampPDF/getPDF.jsp?tp=&arnumber=${articleNumber}`
  : null

const absoluteIeeeUrl = (value: unknown) => {
  const raw = cleanText(value)
  if (!raw) return null
  try {
    return new URL(raw, IEEE_BASE_URL).toString()
  } catch {
    return null
  }
}

const isExpectedJournalUrl = (value: string, path: '/xpl/mostRecentIssue.jsp' | '/xpl/tocresult.jsp') => {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname === 'ieeexplore.ieee.org' && url.pathname === path
  } catch {
    return false
  }
}

const normalizePublicationNumber = (value: unknown) => String(value ?? '').trim()

export const emptyIeeeJournalBrowserPreferences = (): IeeeJournalBrowserPreferences => ({
  journals: [],
  defaultRankingKeywords: '',
})

export function normalizeIeeeJournalBrowserPreferences(value: unknown): IeeeJournalBrowserPreferences {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const journalsValue = Array.isArray(raw.journals) ? raw.journals : []
  if (journalsValue.length > MAX_JOURNALS) {
    throw new IeeeXploreError('INVALID_IEEE_JOURNAL_PREFERENCES', `At most ${MAX_JOURNALS} IEEE journals can be configured`, 400)
  }

  const publicationNumbers = new Set<string>()
  const ids = new Set<string>()
  const journals: IeeeJournalConfig[] = journalsValue.map((entry, index) => {
    const item = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {}
    const id = String(item.id ?? '').trim()
    const displayName = String(item.displayName ?? '').trim()
    const publicationTitle = String(item.publicationTitle ?? '').trim()
    const publicationNumber = normalizePublicationNumber(item.publicationNumber)
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id)) {
      throw new IeeeXploreError('INVALID_IEEE_JOURNAL_PREFERENCES', `Journal ${index + 1} has an invalid id`, 400)
    }
    if (!displayName || displayName.length > 120 || !publicationTitle || publicationTitle.length > 500) {
      throw new IeeeXploreError('INVALID_IEEE_JOURNAL_PREFERENCES', `Journal ${index + 1} needs a display name and publication title`, 400)
    }
    if (!/^\d{1,20}$/.test(publicationNumber)) {
      throw new IeeeXploreError('INVALID_IEEE_JOURNAL_PREFERENCES', `Journal ${index + 1} has an invalid publication number`, 400)
    }
    if (ids.has(id)) {
      throw new IeeeXploreError('INVALID_IEEE_JOURNAL_PREFERENCES', 'Journal ids must be unique', 400)
    }
    if (publicationNumbers.has(publicationNumber)) {
      throw new IeeeXploreError('INVALID_IEEE_JOURNAL_PREFERENCES', 'Publication numbers must be unique', 400)
    }
    ids.add(id)
    publicationNumbers.add(publicationNumber)
    return { id, displayName, publicationTitle, publicationNumber }
  })

  const defaultRankingKeywords = String(raw.defaultRankingKeywords ?? '').trim().slice(0, 500)
  return { journals, defaultRankingKeywords }
}

export async function readIeeeJournalBrowserPreferences(): Promise<IeeeJournalBrowserPreferences> {
  const setting = await prisma.setting.findUnique({ where: { key: JOURNAL_PREFERENCES_KEY } })
  return normalizeIeeeJournalBrowserPreferences(setting?.value || emptyIeeeJournalBrowserPreferences())
}

const requestHeaders = (referer: string) => ({
  Accept: 'application/json, text/plain, */*',
  Origin: IEEE_BASE_URL,
  Referer: referer,
  'cache-http-response': 'true',
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
})

export class IeeeXploreService {
  private readonly linksCache = new Map<string, CachedValue<IeeeJournalLinks>>()
  private readonly browseCache = new Map<string, CachedValue<IeeeSearchResponse>>()
  private readonly articleAbstractCache = new Map<string, CachedValue<IeeeSearchResponse>>()
  private nextRequestAt = 0
  private rateLimitQueue: Promise<void> = Promise.resolve()

  async execute(request: IeeeSearchRequest): Promise<IeeeSearchResponse> {
    if (request.mode === 'search') return this.searchArticles(request)
    if (request.mode === 'article_abstract') return this.fetchArticleAbstract(request.articleNumber || '', request.refresh)
    if (!request.journal) throw new IeeeXploreError('MISSING_JOURNAL_ID', 'journal_id is required', 400)
    return request.mode === 'current_issue'
      ? this.browseCurrentIssue(request.journal, request.refresh, request.page, request.limit)
      : this.browseEarlyAccess(request.journal, request.refresh, request.page, request.limit)
  }

  async searchArticles(request: IeeeSearchRequest): Promise<IeeeSearchResponse> {
    const query = request.q?.trim()
    if (!query) throw new IeeeXploreError('MISSING_QUERY', 'q is required for IEEE article search', 400)

    const limit = Math.min(Math.max(request.limit || 20, 1), 25)
    const page = Math.max(request.page || 1, 1)
    const refinements = request.journal ? [`Publication Number:${request.journal.publicationNumber}`] : []
    // IEEE's existing crawler accepts `newest`; relevance is the remote default.
    // Do not invent a second sort enum for an upstream service we do not control.
    const body = {
      newsearch: true,
      queryText: query,
      highlight: true,
      returnFacets: ['ALL'],
      returnType: 'SEARCH',
      matchPubs: true,
      pageNumber: page,
      rowsPerPage: limit,
      ...(request.sort === 'newest' ? { sortType: 'newest' } : {}),
      ...(refinements.length ? { refinements } : {}),
    }

    const data = await this.fetchJson<IeeeRestSearchData>(IEEE_REST_SEARCH_ENDPOINT, {
      method: 'POST',
      headers: { ...requestHeaders(`${IEEE_BASE_URL}/search/searchresult.jsp?queryText=${encodeURIComponent(query)}`), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const papers = (Array.isArray(data.records) ? data.records : []).map(record => this.mapRestRecord(record, data.userInfo))
    return {
      papers,
      total: parseCount(data.totalRecords ?? data.total_records ?? data.total) || papers.length,
      page,
      limit,
      ieee: {
        mode: 'search',
        ...(request.journal ? { journal: request.journal } : {}),
        sourceUrl: `${IEEE_BASE_URL}/search/searchresult.jsp?queryText=${encodeURIComponent(query)}`,
        fetchedAt: new Date().toISOString(),
        cached: false,
      },
    }
  }

  async fetchArticleAbstract(articleNumber: string, refresh = false): Promise<IeeeSearchResponse> {
    if (!/^\d{4,20}$/.test(articleNumber)) {
      throw new IeeeXploreError('INVALID_IEEE_ARTICLE_NUMBER', 'article_number must contain only digits', 400)
    }
    const cached = this.articleAbstractCache.get(articleNumber)
    if (!refresh && cached && cached.expiresAt > Date.now()) {
      return { ...cached.value, ieee: { ...cached.value.ieee!, cached: true } }
    }

    const sourceUrl = `${IEEE_BASE_URL}/document/${articleNumber}/`
    const data = await this.fetchJson<Record<string, any>>(`${IEEE_BASE_URL}/rest/document/${articleNumber}/abstract`, {
      headers: requestHeaders(sourceUrl),
    })
    const abstract = stripHtml(data.abstract)
    const title = stripHtml(data.displayDocTitle || data.title || data.articleTitle) || ''
    const authors = Array.isArray(data.authors)
      ? data.authors.map((author: any) => cleanText(author?.preferredName || author?.fullName || author?.name || author?.normalizedName)).filter((author): author is string => !!author)
      : []
    const paper: SearchPaper = {
      id: articleNumber,
      title,
      abstract,
      authors,
      year: numberOrNull(data.publicationYear),
      publicationDate: cleanText(data.displayPublicationDate || data.publicationDate),
      url: sourceUrl,
      doi: cleanText(data.doi),
      arxivId: null,
      journal: stripHtml(data.displayPublicationTitle || data.publicationTitle),
      venue: stripHtml(data.displayPublicationTitle || data.publicationTitle),
      source: 'ieee',
      articleNumber,
      publicationNumber: cleanText(data.publicationNumber),
      contentType: cleanText(data.contentTypeDisplay || data.contentType),
      pdfUrl: ieeePdfUrl(articleNumber),
      provider: 'ieee_xplore_document_abstract',
      isEarlyAccess: data.isEarlyAccess === true,
    }
    const response: IeeeSearchResponse = {
      papers: [paper],
      total: 1,
      page: 1,
      limit: 1,
      ieee: { mode: 'article_abstract', sourceUrl, fetchedAt: new Date().toISOString(), cached: false },
    }
    this.articleAbstractCache.set(articleNumber, { value: response, expiresAt: Date.now() + DIRECTORY_CACHE_TTL_MS })
    return response
  }

  async browseCurrentIssue(journal: IeeeJournalConfig, refresh = false, page = 1, limit = 20): Promise<IeeeSearchResponse> {
    return this.browseJournal(journal, 'current_issue', refresh, page, limit)
  }

  async browseEarlyAccess(journal: IeeeJournalConfig, refresh = false, page = 1, limit = 20): Promise<IeeeSearchResponse> {
    return this.browseJournal(journal, 'early_access', refresh, page, limit)
  }

  private invalidateDirectoryCache(publicationNumber: string): void {
    for (const key of this.browseCache.keys()) {
      if (key.startsWith(`${publicationNumber}:`)) this.browseCache.delete(key)
    }
    this.linksCache.delete(publicationNumber)
  }

  private async browseJournal(journal: IeeeJournalConfig, mode: IeeeBrowseMode, refresh: boolean, page: number, limit: number): Promise<IeeeSearchResponse> {
    const cacheKey = `${journal.publicationNumber}:${mode}:${page}:${limit}`
    if (refresh) this.invalidateDirectoryCache(journal.publicationNumber)
    const cached = this.browseCache.get(cacheKey)
    if (!refresh && cached && cached.expiresAt > Date.now()) {
      return { ...cached.value, ieee: { ...cached.value.ieee!, cached: true } }
    }

    const links = await this.discoverJournalLinks(journal.publicationNumber, refresh)
    const sourceUrl = mode === 'current_issue' ? links.currentIssueUrl : links.earlyAccessUrl
    const issueNumber = mode === 'current_issue' ? links.currentIssueNumber : links.earlyAccessIssueNumber
    // The structured TOC endpoint is the page's own data source. Use an HTML
    // parse only as a fallback so each normal directory page costs one IEEE TOC request.
    let papers: SearchPaper[]
    let total = 0
    try {
      const result = await this.fetchDirectoryPage(journal.publicationNumber, issueNumber, sourceUrl, page, limit)
      papers = result.papers
      total = result.total
    } catch {
      const html = await this.fetchText(sourceUrl)
      const allPapers = this.extractArticleList(html, mode)
      if (!allPapers.length && !/no\s+(articles?|results?)|0\s+results?/i.test(html)) {
        throw new IeeeXploreError('IEEE_ARTICLE_LIST_PARSE_FAILED', 'IEEE returned a journal page, but its article list could not be parsed')
      }
      const offset = (page - 1) * limit
      papers = allPapers.slice(offset, offset + limit)
      total = allPapers.length
    }

    const response: IeeeSearchResponse = {
      papers,
      total,
      page,
      limit,
      ieee: {
        mode,
        journal,
        sourceUrl,
        fetchedAt: new Date().toISOString(),
        cached: false,
      },
    }
    this.browseCache.set(cacheKey, { value: response, expiresAt: Date.now() + DIRECTORY_CACHE_TTL_MS })
    return response
  }

  private async fetchDirectoryPage(
    publicationNumber: string,
    issueNumber: string,
    sourceUrl: string,
    page: number,
    limit: number
  ): Promise<{ papers: SearchPaper[]; total: number }> {
    const data = await this.fetchJson<IeeeRestSearchData>(
      `${IEEE_REST_SEARCH_ENDPOINT}/pub/${publicationNumber}/issue/${issueNumber}/toc`,
      {
        method: 'POST',
        headers: { ...requestHeaders(sourceUrl), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          punumber: publicationNumber,
          isnumber: issueNumber,
          pageNumber: page,
          rowsPerPage: limit,
          sortType: 'newest',
        }),
      }
    )
    const records = Array.isArray(data.records) ? data.records : []
    return {
      papers: records.map(record => this.mapRestRecord(record, data.userInfo)),
      total: parseCount(data.totalRecords ?? data.total_records ?? data.total) || records.length,
    }
  }

  async discoverJournalLinks(publicationNumber: string, refresh = false): Promise<IeeeJournalLinks> {
    if (!/^\d{1,20}$/.test(publicationNumber)) {
      throw new IeeeXploreError('INVALID_PUBLICATION_NUMBER', 'publicationNumber must contain only digits', 400)
    }
    const cached = this.linksCache.get(publicationNumber)
    if (!refresh && cached && cached.expiresAt > Date.now()) return cached.value

    const sourceUrl = `${IEEE_BASE_URL}/xpl/RecentIssue.jsp?punumber=${encodeURIComponent(publicationNumber)}`
    // The page is the discovery entry point. Modern IEEE pages render their
    // links client-side, so use the page's own structured metadata request to
    // obtain the changing issue numbers rather than hard-coding them.
    await this.fetchText(sourceUrl)
    const metadata = await this.fetchJson<Record<string, unknown>>(
      `${IEEE_BASE_URL}/rest/publication/home/metadata?pubid=${encodeURIComponent(publicationNumber)}`,
      { headers: requestHeaders(sourceUrl) }
    )
    const links = this.extractJournalLinksFromMetadata(metadata, publicationNumber)
    this.linksCache.set(publicationNumber, { value: links, expiresAt: Date.now() + DIRECTORY_CACHE_TTL_MS })
    return links
  }

  extractJournalLinks(html: string): IeeeJournalLinks {
    const hrefs = Array.from(html.matchAll(/href\s*=\s*(["'])(.*?)\1/gi), match => decodeHtml(match[2]))
    const resolved = hrefs.map(href => absoluteIeeeUrl(href)).filter((url): url is string => !!url)
    const currentIssueUrl = resolved.find(url => isExpectedJournalUrl(url, '/xpl/mostRecentIssue.jsp'))
    const earlyAccessUrl = resolved.find(url => isExpectedJournalUrl(url, '/xpl/tocresult.jsp'))
    const currentIssueNumber = currentIssueUrl ? new URL(currentIssueUrl).searchParams.get('isnumber') : null
    const earlyAccessIssueNumber = earlyAccessUrl ? new URL(earlyAccessUrl).searchParams.get('isnumber') : null
    if (!currentIssueUrl || !earlyAccessUrl || !currentIssueNumber || !earlyAccessIssueNumber || !/^\d+$/.test(currentIssueNumber) || !/^\d+$/.test(earlyAccessIssueNumber)) {
      throw new IeeeXploreError('IEEE_JOURNAL_LINK_PARSE_FAILED', 'IEEE journal page did not contain validated Current Issue and Early Access links')
    }
    return { currentIssueUrl, earlyAccessUrl, currentIssueNumber, earlyAccessIssueNumber }
  }

  private extractJournalLinksFromMetadata(metadata: Record<string, unknown>, publicationNumber: string): IeeeJournalLinks {
    const current = metadata.currentIssue as Record<string, unknown> | undefined
    const early = metadata.preprintIssue as Record<string, unknown> | undefined
    const currentIssueNumber = cleanText(current?.issueNumber)
    const earlyAccessIssueNumber = cleanText(early?.issueNumber)
    if (!currentIssueNumber || !earlyAccessIssueNumber || !/^\d+$/.test(currentIssueNumber) || !/^\d+$/.test(earlyAccessIssueNumber)) {
      throw new IeeeXploreError('IEEE_JOURNAL_LINK_PARSE_FAILED', 'IEEE journal metadata did not contain valid Current Issue and Early Access issue numbers')
    }
    const currentIssueUrl = `${IEEE_BASE_URL}/xpl/mostRecentIssue.jsp?punumber=${encodeURIComponent(publicationNumber)}`
    const earlyAccessUrl = `${IEEE_BASE_URL}/xpl/tocresult.jsp?isnumber=${encodeURIComponent(earlyAccessIssueNumber)}`
    if (!isExpectedJournalUrl(currentIssueUrl, '/xpl/mostRecentIssue.jsp') || !isExpectedJournalUrl(earlyAccessUrl, '/xpl/tocresult.jsp')) {
      throw new IeeeXploreError('IEEE_JOURNAL_LINK_PARSE_FAILED', 'IEEE journal metadata produced an invalid directory URL')
    }
    return { currentIssueUrl, earlyAccessUrl, currentIssueNumber, earlyAccessIssueNumber }
  }

  mapRestRecord(record: unknown, userInfo?: unknown): SearchPaper {
    const item = record && typeof record === 'object' ? record as Record<string, any> : {}
    const authors = Array.isArray(item.authors)
      ? item.authors.map((author: any) => cleanText(author?.preferredName || author?.fullName || author?.name || author?.normalizedName)).filter((author): author is string => !!author)
      : []
    const doi = cleanText(item.doi)
    const title = stripHtml(item.articleTitle) || ''
    const articleNumber = cleanText(item.articleNumber) || articleNumberFrom(item.documentLink || item.htmlLink)
    const venue = stripHtml(item.displayPublicationTitle || item.publicationTitle)
    return {
      id: articleNumber || doi || title,
      title,
      abstract: stripHtml(item.abstract),
      authors,
      year: numberOrNull(item.publicationYear),
      url: absoluteIeeeUrl(item.documentLink || item.htmlLink) || (articleNumber ? `${IEEE_BASE_URL}/document/${articleNumber}/` : null),
      doi,
      arxivId: null,
      journal: venue,
      venue,
      source: 'ieee',
      articleNumber,
      publicationNumber: cleanText(item.publicationNumber),
      contentType: cleanText(item.contentType || item.displayContentType),
      citationCount: numberOrNull(item.citationCount),
      downloadCount: numberOrNull(item.downloadCount),
      accessType: cleanText(item.accessType?.type || item.accessType?.message),
      pdfUrl: ieeePdfUrl(articleNumber) || absoluteIeeeUrl(item.pdfLink),
      provider: 'ieee_xplore_rest_crawler',
      isEarlyAccess: item.isEarlyAccess === true || /early\s+access/i.test(String(item.displayContentType || item.contentType || item.articleContentType || '')),
      institutionName: cleanText((userInfo as Record<string, any> | undefined)?.institutionName),
      publicationDate: cleanText(item.publicationDate || item.insertDate || item.onlineDate),
    }
  }

  extractArticleList(html: string, mode: IeeeBrowseMode): SearchPaper[] {
    const fromStructuredData = this.extractStructuredRecords(html)
    const fromHtml = this.extractHtmlArticleRecords(html, mode)
    const seen = new Set<string>()
    return [...fromStructuredData, ...fromHtml].filter(paper => {
      const key = paper.articleNumber || paper.id
      if (!key || seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

  private extractStructuredRecords(html: string): SearchPaper[] {
    const records: unknown[] = []
    const collect = (value: unknown) => {
      if (Array.isArray(value)) {
        value.forEach(collect)
      } else if (value && typeof value === 'object') {
        const item = value as Record<string, unknown>
        if ((item.articleNumber || item.articleTitle) && (item.documentLink || item.articleNumber)) records.push(item)
        Object.values(item).forEach(collect)
      }
    }
    for (const match of html.matchAll(/<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
      try { collect(JSON.parse(match[1])) } catch { /* Ignore unrelated invalid JSON script tags. */ }
    }
    for (const match of html.matchAll(/(?:xplGlobal\.)?(?:document|issue|toc)\.(?:metadata|records)\s*=\s*(\{[\s\S]{2,200000}?\}|\[[\s\S]{2,200000}?\])\s*;/gi)) {
      try { collect(JSON.parse(match[1])) } catch { /* The HTML fallback handles non-JSON assignments. */ }
    }
    return records.map(record => this.mapRestRecord(record))
  }

  private extractHtmlArticleRecords(html: string, mode: IeeeBrowseMode): SearchPaper[] {
    const papers: SearchPaper[] = []
    const anchors = /<a\b[^>]*href\s*=\s*(["'])([^"']*\/document\/\d+\/?[^"']*)\1[^>]*>([\s\S]*?)<\/a>/gi
    for (const match of html.matchAll(anchors)) {
      const articleNumber = articleNumberFrom(match[2])
      if (!articleNumber) continue
      const index = match.index || 0
      const start = Math.max(
        html.lastIndexOf('<li', index),
        html.lastIndexOf('<article', index),
        html.lastIndexOf('<div', index)
      )
      const fragment = html.slice(start >= 0 ? start : index, Math.min(html.length, index + 8_000))
      const title = stripHtml(match[3]) || ''
      const doi = cleanText(decodeHtml(fragment).match(/\b10\.\d{4,9}\/[\w.()/:;-]+/i)?.[0])
      const date = cleanText(stripHtml(fragment.match(/(?:publication|online|date)[^>]{0,100}>\s*([^<]{4,80})/i)?.[1]))
      const authorText = stripHtml(fragment.match(/(?:author|authors)[^>]{0,120}>\s*([\s\S]{0,1200}?)(?:<\/[a-z]+>|<a\b)/i)?.[1])
      const contentType = stripHtml(fragment.match(/(?:content[-_ ]?type|article[-_ ]?type)[^>]{0,120}>\s*([^<]{2,120})/i)?.[1])
      papers.push({
        id: articleNumber,
        title,
        abstract: stripHtml(fragment.match(/(?:abstract|description)[^>]{0,120}>\s*([\s\S]{0,2500}?)(?:<\/[a-z]+>|<a\b)/i)?.[1]),
        authors: authorText ? authorText.split(/\s*(?:;|,|\band\b)\s*/i).filter(Boolean) : [],
        year: numberOrNull(date?.match(/\b(19|20)\d{2}\b/)?.[0]),
        publicationDate: date,
        url: `${IEEE_BASE_URL}/document/${articleNumber}/`,
        doi,
        arxivId: null,
        journal: null,
        venue: null,
        source: 'ieee',
        articleNumber,
        publicationNumber: null,
        contentType,
        pdfUrl: ieeePdfUrl(articleNumber),
        provider: 'ieee_xplore_journal_html',
        isEarlyAccess: mode === 'early_access' || /early\s+access/i.test(`${contentType || ''} ${fragment.slice(0, 1_500)}`),
      })
    }
    return papers
  }

  private async fetchJson<T>(url: string, init: RequestInit): Promise<T> {
    const response = await this.fetch(url, init)
    try {
      return await response.json() as T
    } catch {
      throw new IeeeXploreError('IEEE_INVALID_RESPONSE', 'IEEE returned a non-JSON search response')
    }
  }

  private async fetchText(url: string): Promise<string> {
    const response = await this.fetch(url, { headers: requestHeaders(IEEE_BASE_URL) })
    return response.text()
  }

  private async waitForRequestSlot(): Promise<void> {
    const previous = this.rateLimitQueue
    let release!: () => void
    this.rateLimitQueue = new Promise<void>(resolve => { release = resolve })
    await previous
    const wait = Math.max(0, this.nextRequestAt - Date.now())
    if (wait) await new Promise(resolve => setTimeout(resolve, wait))
    this.nextRequestAt = Date.now() + 250
    release()
  }

  private async fetch(url: string, init: RequestInit): Promise<Response> {
    await this.waitForRequestSlot()
    let lastError: unknown
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const headers = new Headers(init.headers)
        const cookie = ieeeSessionCookieHeader()
        if (cookie) headers.set('Cookie', cookie)
        const response = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
        captureIeeeSessionCookies(response.headers)
        if (response.ok) return response
        const retryable = [429, 500, 502, 503, 504].includes(response.status)
        if (retryable && attempt === 0) {
          await new Promise(resolve => setTimeout(resolve, 750))
          continue
        }
        const code = response.status === 403 ? 'IEEE_ACCESS_DENIED'
          : response.status === 429 ? 'IEEE_RATE_LIMITED'
            : 'IEEE_REQUEST_FAILED'
        throw new IeeeXploreError(code, `IEEE request failed with HTTP ${response.status}`)
      } catch (error) {
        lastError = error
        if (error instanceof IeeeXploreError || attempt === 1) break
        await new Promise(resolve => setTimeout(resolve, 750))
      }
    }
    if (lastError instanceof IeeeXploreError) throw lastError
    if (lastError instanceof Error && lastError.name === 'TimeoutError') {
      throw new IeeeXploreError('IEEE_TIMEOUT', 'IEEE request timed out')
    }
    throw new IeeeXploreError('IEEE_NETWORK_ERROR', `IEEE request failed: ${(lastError as Error)?.message || 'network error'}`)
  }
}

export const ieeeXploreService = new IeeeXploreService()
