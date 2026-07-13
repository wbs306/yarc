import type { PaperReferenceInput } from '@yarc/shared'

const clean = (value: string | null | undefined) => value?.trim() || undefined

const parseYearFromText = (text?: string) => {
  const match = text?.match(/\b(19|20)\d{2}\b/)
  return match ? Number(match[0]) : undefined
}

export const isPaperReferenceUrl = (href: string) => {
  if (href.startsWith('paper://')) return true
  return /(?:doi\.org\/|arxiv\.org\/(?:abs|pdf)\/|semanticscholar\.org\/paper\/|ieeexplore\.ieee\.org\/(?:document\/|.*[?&]arnumber=))/i.test(href)
}

export const parsePaperReference = (href: string, title?: string, rawText?: string): PaperReferenceInput | null => {
  const reference: PaperReferenceInput = {
    title: clean(title),
    rawText: clean(rawText),
    year: parseYearFromText(rawText),
  }

  if (href.startsWith('paper://')) {
    try {
      const url = new URL(href)
      const kind = url.hostname.toLowerCase()
      const value = decodeURIComponent(url.pathname.replace(/^\//, ''))
      if (kind === 'local') reference.localPaperId = clean(value)
      else if (kind === 'doi') reference.doi = clean(value)
      else if (kind === 'arxiv') reference.arxivId = clean(value)
      else if (kind === 's2' || kind === 'semantic-scholar') reference.semanticScholarId = clean(value)
      else if (kind === 'ieee') reference.ieeeArticleNumber = clean(value)
      else if (kind === 'search') {
        reference.title = clean(url.searchParams.get('title')) || reference.title
        const year = Number(url.searchParams.get('year'))
        if (Number.isInteger(year)) reference.year = year
      } else return null
      return reference
    } catch {
      return null
    }
  }

  let url: URL
  try { url = new URL(href) } catch { return null }
  reference.url = href
  const host = url.hostname.toLowerCase()

  if (host === 'doi.org' || host === 'dx.doi.org') {
    reference.doi = decodeURIComponent(url.pathname.replace(/^\//, ''))
  } else if (host === 'arxiv.org' || host === 'www.arxiv.org') {
    reference.arxivId = decodeURIComponent(url.pathname.replace(/^\/(?:abs|pdf)\//, '').replace(/\.pdf$/i, ''))
  } else if (host.endsWith('semanticscholar.org')) {
    const parts = url.pathname.split('/').filter(Boolean)
    const paperIndex = parts.indexOf('paper')
    reference.semanticScholarId = clean(parts[paperIndex + 2] || parts[paperIndex + 1])
  } else if (host.endsWith('ieee.org')) {
    reference.ieeeArticleNumber = clean(url.pathname.match(/\/document\/(\d+)/)?.[1] || url.searchParams.get('arnumber'))
  } else {
    return null
  }

  return reference
}

export const linkifyImplicitPaperReferences = (markdown: string) => {
  const lines = markdown.split('\n')
  let fence = ''
  return lines.map(line => {
    const fenceMatch = line.trimStart().match(/^(`{3,}|~{3,})/)
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1][0]
      else if (fenceMatch[1][0] === fence) fence = ''
      return line
    }
    if (fence) return line

    const protectedSegments: string[] = []
    let next = line.replace(/`[^`]*`|\[[^\]]*\]\([^)]+\)|<https?:\/\/[^>]+>/g, segment => {
      const index = protectedSegments.push(segment) - 1
      return `\u0000${index}\u0000`
    })
    next = next.replace(/\[\[paper:([^\]]{3,500})\]\]/gi, (_, title: string) => {
      const trimmed = title.trim()
      return `[${trimmed}](paper://search?title=${encodeURIComponent(trimmed)})`
    })
    next = next.replace(/(?<!\[)《([^》\n]{6,300})》/g, (_, title: string) => {
      const trimmed = title.trim()
      return `[《${trimmed}》](paper://search?title=${encodeURIComponent(trimmed)})`
    })
    next = next.replace(/(?<![\w/\[])(?:doi\s*:\s*)?(10\.\d{4,9}\/[-._;()/:a-z0-9]+)/gi, (raw: string, doi: string) => {
      const normalized = doi.replace(/[.,;]+$/, '')
      const suffix = doi.slice(normalized.length)
      const label = raw.slice(0, raw.length - suffix.length)
      return `[${label}](paper://doi/${encodeURIComponent(normalized)})${suffix}`
    })
    next = next.replace(/(?<![\w/])arxiv\s*:\s*((?:\d{4}\.\d{4,5}|[a-z-]+\/\d{7})(?:v\d+)?)/gi, (raw: string, arxivId: string) =>
      `[${raw}](paper://arxiv/${encodeURIComponent(arxivId)})`)
    return next.replace(/\u0000(\d+)\u0000/g, (_, index: string) => protectedSegments[Number(index)] || '')
  }).join('\n')
}
