import { prisma, type Prisma } from '@yarc/db'
import { cache } from '../lib/cache.js'
import { AppError } from '../lib/errors.js'
import { config } from '../lib/config.js'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { v4 as uuid } from 'uuid'
import { jobQueue } from './job-queue.service.js'
import { metadataService } from './metadata.service.js'
import { rankingService } from './ranking.service.js'

export class PaperService {
  async list(params: {
    categoryId?: string
    query?: string
    field?: string
    page?: number
    limit?: number
  }) {
    const { categoryId, query, field, page = 1, limit = 50 } = params
    const cacheKey = `papers:list:${categoryId || ''}:${query || ''}:${field || ''}:${page}:${limit}`
    const cached = cache.get<any>(cacheKey)
    if (cached) return cached

    const where: any = {}
    if (categoryId) where.categoryId = categoryId
    if (query) {
      if (field === 'title') {
        where.title = { contains: query, mode: 'insensitive' }
      } else if (field === 'author') {
        where.authors = { has: query }
      } else {
        where.OR = [
          { title: { contains: query, mode: 'insensitive' } },
          { abstract: { contains: query, mode: 'insensitive' } },
          { authors: { has: query } },
        ]
      }
    }

    const skip = (page - 1) * limit
    const [papers, total] = await Promise.all([
      prisma.paper.findMany({
        where,
        select: {
          id: true,
          title: true,
          abstract: true,
          authors: true,
          year: true,
          doi: true,
          url: true,
          filePath: true,
          fileSize: true,
          categoryId: true,
          parseStatus: true,
          embeddingStatus: true,
          summaryStatus: true,
          metadata: true,
          tags: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.paper.count({ where }),
    ])

    // Extract journal/venue and ranking data for frontend sorting/filtering.
    const enrichedPapers = await Promise.all(papers.map(async p => {
      const meta = (p.metadata || {}) as any
      const journal = meta.journal || null
      const venue = meta.venue || null
      const rankingName = journal || venue || ''
      const rankings = rankingName ? await rankingService.getRankingsWithCustom(rankingName) : { ccf: null, sci: null }
      return {
        ...p,
        journal,
        venue,
        rankings,
      }
    }))

    const result = { papers: enrichedPapers, total, page, limit }
    cache.set(cacheKey, result, 60_000) // 1 min
    return result
  }

  async getById(id: string) {
    const cached = cache.get<any>(`paper:${id}`)
    if (cached) return cached

    const paper = await prisma.paper.findUnique({ where: { id } })
    if (!paper) throw new AppError('NOT_FOUND', 'Paper not found', 404)

    const meta = (paper.metadata || {}) as any
    const journal = meta.journal || null
    const venue = meta.venue || null
    const rankingName = journal || venue || ''
    const enrichedPaper = {
      ...paper,
      journal,
      venue,
      rankings: rankingName ? await rankingService.getRankingsWithCustom(rankingName) : { ccf: null, sci: null },
    }

    cache.set(`paper:${id}`, enrichedPaper, 300_000) // 5 min
    return enrichedPaper
  }

  async create(data: {
    title: string
    abstract?: string
    authors?: string[]
    year?: number
    doi?: string
    arxivId?: string
    url?: string
    categoryId?: string
    tags?: string[]
    metadata?: Prisma.InputJsonValue
  }) {
    const paper = await prisma.paper.create({ data: data as any })
    cache.invalidatePrefix('papers:list')
    return paper
  }

  async update(id: string, data: Partial<{
    title: string
    abstract: string
    authors: string[]
    year: number
    doi: string
    arxivId: string
    url: string
    categoryId: string
    tags: string[]
    metadata: Record<string, unknown>
  }>) {
    const paper = await prisma.paper.update({ where: { id }, data: data as any })
    cache.delete(`paper:${id}`)
    cache.invalidatePrefix('papers:list')
    return paper
  }

  async delete(id: string) {
    const paper = await prisma.paper.findUnique({ where: { id } })
    if (!paper) throw new AppError('NOT_FOUND', 'Paper not found', 404)

    // Delete entire paper directory (PDF, mineru, notes)
    const paperDir = join(config.papersDir, id)
    try {
      await rm(paperDir, { recursive: true, force: true })
    } catch {}

    await prisma.paper.delete({ where: { id } })
    cache.delete(`paper:${id}`)
    cache.invalidatePrefix('papers:list')
  }

  async deleteMany(ids: string[]) {
    const uniqueIds = [...new Set(ids)]
    const existing = await prisma.paper.findMany({
      where: { id: { in: uniqueIds } },
      select: { id: true },
    })
    const existingIds = existing.map((paper) => paper.id)

    for (const id of existingIds) {
      const paperDir = join(config.papersDir, id)
      try {
        await rm(paperDir, { recursive: true, force: true })
      } catch {}
      cache.delete(`paper:${id}`)
    }
    const result = await prisma.paper.deleteMany({ where: { id: { in: existingIds } } })
    cache.invalidatePrefix('papers:list')
    return {
      requested: ids.length,
      matched: existingIds.length,
      deleted: result.count,
      missing: uniqueIds.length - result.count,
    }
  }

  async updateCategory(ids: string[], categoryId: string | null) {
    const uniqueIds = [...new Set(ids)]
    const result = await prisma.paper.updateMany({
      where: { id: { in: uniqueIds } },
      data: { categoryId }
    })
    for (const id of uniqueIds) {
      cache.delete(`paper:${id}`)
    }
    cache.invalidatePrefix('papers:list')
    return {
      requested: ids.length,
      updated: result.count,
      missing: uniqueIds.length - result.count,
    }
  }

  async upload(
    file: File,
    title?: string,
    categoryId?: string,
    extractMetadata: boolean = true,
    options: { sourceUrl?: string; skipMetadataEnrichment?: boolean } = {}
  ) {
    const id = uuid()
    const ext = '.pdf'
    const fileName = `pdf${ext}`
    const paperDir = join(config.papersDir, id)
    const filePath = join(paperDir, fileName)

    await mkdir(paperDir, { recursive: true })
    const buffer = Buffer.from(await file.arrayBuffer())
    await writeFile(filePath, buffer)

    const fallbackTitle = file.name.replace(/\.pdf$/i, '') || 'Untitled'

    let metadata: any = {}
    if (extractMetadata) {
      metadata = await metadataService.extractAndLookup(buffer, file.name)
    }

    const paperTitle = title || metadata.title || fallbackTitle
    const journal = metadata.journal || metadata.venue
    const paper = await prisma.paper.create({
      data: {
        id,
        title: paperTitle,
        abstract: metadata.abstract,
        authors: metadata.authors || [],
        year: metadata.year,
        doi: metadata.doi,
        arxivId: metadata.arxivId,
        url: metadata.url,
        filePath,
        fileSize: buffer.length,
        parseStatus: 'pending',
        embeddingStatus: 'pending',
        summaryStatus: 'pending',
        metadata: {
          upload: {
            originalFileName: file.name,
            storedFileName: fileName,
            extractMetadata,
            ...(options.sourceUrl ? { sourceUrl: options.sourceUrl } : {}),
          },
          ...(options.skipMetadataEnrichment ? {
            processing: {
              skipMetadataEnrichment: true,
            },
          } : {}),
          ...(journal ? { journal } : {}),
          ...(extractMetadata ? {
            uploadMetadata: {
              source: metadata.source,
              extracted: metadata.raw || {},
              enrichedAt: new Date().toISOString(),
            }
          } : {}),
        } as any,
        ...(categoryId ? { category: { connect: { id: categoryId } } } : {}),
      },
    })

    // Enqueue parse job
    jobQueue.add('parse_pdf', id)

    cache.invalidatePrefix('papers:list')
    return {
      ...paper,
      journal: journal || null,
      venue: metadata.venue || null,
    }
  }

  async importFromSearchResult(
    sourcePaper: any,
    pdfBuffer: Buffer,
    categoryId?: string,
    extractMetadata: boolean = false
  ) {
    if (!pdfBuffer.length || pdfBuffer.subarray(0, 5).toString('utf-8') !== '%PDF-') {
      throw new AppError('INVALID_PDF', 'Downloaded file is not a valid PDF', 400)
    }

    const id = uuid()
    const fileName = 'pdf.pdf'
    const paperDir = join(config.papersDir, id)
    const filePath = join(paperDir, fileName)

    await mkdir(paperDir, { recursive: true })
    await writeFile(filePath, pdfBuffer)

    let extracted: any = {}
    if (extractMetadata) {
      extracted = await metadataService.extractAndLookup(pdfBuffer, `${sourcePaper.title || id}.pdf`)
    }

    const title = sourcePaper.title || extracted.title || 'Untitled'
    const authors = Array.isArray(sourcePaper.authors) && sourcePaper.authors.length
      ? sourcePaper.authors
      : extracted.authors || []
    const year = sourcePaper.year ?? extracted.year
    const abstract = sourcePaper.abstract ?? extracted.abstract
    const doi = sourcePaper.doi ?? extracted.doi
    const arxivId = sourcePaper.arxivId ?? extracted.arxivId
    const url = sourcePaper.url ?? extracted.url
    const journal = sourcePaper.journal || sourcePaper.venue || extracted.journal || extracted.venue
    const venue = sourcePaper.venue || sourcePaper.journal || extracted.venue || extracted.journal

    const paper = await prisma.paper.create({
      data: {
        id,
        title,
        abstract,
        authors,
        year,
        doi,
        arxivId,
        url,
        filePath,
        fileSize: pdfBuffer.length,
        parseStatus: 'pending',
        embeddingStatus: 'pending',
        summaryStatus: 'pending',
        metadata: {
          source: sourcePaper.source || 'external',
          provider: sourcePaper.provider,
          journal,
          venue,
          importedAt: new Date().toISOString(),
          import: {
            sourcePaperId: sourcePaper.id,
            articleNumber: sourcePaper.articleNumber,
            publicationNumber: sourcePaper.publicationNumber,
            contentType: sourcePaper.contentType,
            isEarlyAccess: sourcePaper.isEarlyAccess,
            pdfUrl: sourcePaper.pdfUrl,
            accessType: sourcePaper.accessType,
          },
          upload: {
            originalFileName: `${title}.pdf`,
            storedFileName: fileName,
            extractMetadata,
          },
          ...(!extractMetadata ? {
            processing: {
              skipMetadataEnrichment: true,
            },
          } : {}),
          ...(extractMetadata ? {
            uploadMetadata: {
              source: extracted.source,
              extracted: extracted.raw || {},
              enrichedAt: new Date().toISOString(),
            },
          } : {}),
        } as any,
        ...(categoryId ? { category: { connect: { id: categoryId } } } : {}),
      },
    })

    jobQueue.add('parse_pdf', id)
    cache.invalidatePrefix('papers:list')
    return {
      ...paper,
      journal: journal || null,
      venue: venue || null,
    }
  }

  async getPdfPath(id: string): Promise<string> {
    const paper = await prisma.paper.findUnique({
      where: { id },
      select: { filePath: true },
    })
    if (!paper?.filePath) throw new AppError('NOT_FOUND', 'PDF not found', 404)
    return paper.filePath
  }

  async summarize(id: string) {
    const paper = await prisma.paper.findUnique({ where: { id } })
    if (!paper) throw new AppError('NOT_FOUND', 'Paper not found', 404)

    await prisma.paper.update({
      where: { id },
      data: { summaryStatus: 'pending' },
    })

    jobQueue.add('summarize', id)
    cache.delete(`paper:${id}`)
  }

  async enrich(id: string) {
    const paper = await prisma.paper.findUnique({ where: { id } })
    if (!paper) throw new AppError('NOT_FOUND', 'Paper not found', 404)

    jobQueue.add('enrich_metadata', id)
  }

  async reparse(id: string) {
    const paper = await prisma.paper.findUnique({ where: { id } })
    if (!paper) throw new AppError('NOT_FOUND', 'Paper not found', 404)

    await prisma.paper.update({
      where: { id },
      data: {
        parseStatus: 'pending',
        embeddingStatus: 'pending',
        summaryStatus: 'pending',
      },
    })
    jobQueue.add('parse_pdf', id)
    cache.invalidatePrefix('papers:list')
    cache.delete(`paper:${id}`)
  }

  // Update paper parse/embed/summary status (called by job workers)
  async updateStatus(id: string, _field: string, data: Record<string, unknown>) {
    await prisma.paper.update({ where: { id }, data })
    cache.delete(`paper:${id}`)
    cache.invalidatePrefix('papers:list')
  }
}

export const paperService = new PaperService()
