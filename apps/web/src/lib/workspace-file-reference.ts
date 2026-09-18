const WORKSPACE_FILE_REFERENCE_PREFIX = '#workspace-file='
const fileReferenceRule = /\[FILE:([^\]\r\n]+)\]/gi
const fenceRule = /^[ \t]{0,3}(`{3,}|~{3,})/

const isEscaped = (text: string, index: number) => {
  let backslashes = 0
  for (let cursor = index - 1; cursor >= 0 && text.charAt(cursor) === '\\'; cursor--) backslashes++
  return backslashes % 2 === 1
}

const encodePath = (path: string) => encodeURIComponent(path)
  .replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)

const escapeMarkdownLabel = (text: string) => text.replace(/[\\`*_{}\[\]<>]/g, '\\$&')

const isAbsoluteFilePath = (value: string) => /^(?:\/|[A-Za-z]:[\\/]|\\\\|\/\/)/.test(value)

const normalizeAbsoluteFileReferencePath = (input?: string | null): string | null => {
  if (!input) return null
  const value = input.trim().replace(/\\/g, '/')
  if (!value || /[\u0000-\u001f\u007f]/.test(value) || !isAbsoluteFilePath(value)) return null

  let prefix = '/'
  let remainder = value.slice(1)
  if (value.startsWith('//')) {
    prefix = '//'
    remainder = value.slice(2)
  } else if (/^[A-Za-z]:\//.test(value)) {
    prefix = value.slice(0, 3)
    remainder = value.slice(3)
  }

  const segments = remainder.split('/')
  if (!segments.length || segments.some(segment => !segment || segment === '.' || segment === '..')) return null
  return `${prefix}${segments.join('/')}`
}

export const normalizeWorkspaceFileReferencePath = (input?: string | null): string | null => {
  if (!input) return null
  const value = input.trim().replace(/\\/g, '/').replace(/^\/+/, '')
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) return null

  const segments: string[] = []
  for (const segment of value.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') return null
    segments.push(segment)
  }
  return segments.length ? segments.join('/') : null
}

// Project agents may reference a public file in the shared data workspace by
// walking from the project root to data/ with exactly two parent segments.
// Keep this separate from normal project paths so arbitrary traversal is never
// accepted by the UI link handler.
export const normalizeProjectSharedFileReferencePath = (input?: string | null): string | null => {
  if (!input) return null
  const value = input.trim().replace(/\\/g, '/')
  if (!value || /[\u0000-\u001f\u007f]/.test(value) || !value.startsWith('../../')) return null

  const segments = value.slice('../../'.length).split('/')
  if (!segments.length || segments.some(segment => !segment || segment === '.' || segment === '..')) return null
  if (new Set(['papers', 'projects', '.pi', '.project-history']).has(segments[0])) return null
  if (segments.some(segment => segment.startsWith('.') && segment !== '.env.example')) return null
  return `../../${segments.join('/')}`
}

export const normalizeFileReferencePath = (input?: string | null): string | null =>
  normalizeAbsoluteFileReferencePath(input)
  || normalizeWorkspaceFileReferencePath(input)
  || normalizeProjectSharedFileReferencePath(input)

export const parseWorkspaceFileReferenceHref = (href?: string | null): string | null => {
  if (!href?.startsWith(WORKSPACE_FILE_REFERENCE_PREFIX)) return null
  try {
    return normalizeFileReferencePath(decodeURIComponent(href.slice(WORKSPACE_FILE_REFERENCE_PREFIX.length)))
  } catch {
    return null
  }
}

export const parseMarkdownFileReferenceHref = (href?: string | null): string | null => {
  if (!href) return null
  let value = href.trim()
  if (!value || value.startsWith('#')) return null

  try {
    value = decodeURIComponent(value)
  } catch {
    return null
  }
  if (value.startsWith('<') && value.endsWith('>')) value = value.slice(1, -1).trim()
  if (/^file:\/\//i.test(value)) value = value.slice('file://'.length)
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/i.test(value) && !/^[A-Za-z]:[\\/]/.test(value)) return null
  if (value.startsWith('//')) return null

  const suffixStart = value.search(/[?#]/)
  if (suffixStart >= 0) value = value.slice(0, suffixStart)
  return normalizeFileReferencePath(value)
}

const linkifyLine = (line: string) => {
  let output = ''
  let cursor = 0
  fileReferenceRule.lastIndex = 0

  while (cursor < line.length) {
    const codeStart = line.indexOf('`', cursor)
    fileReferenceRule.lastIndex = cursor
    const reference = fileReferenceRule.exec(line)
    const referenceStart = reference?.index ?? -1

    if (codeStart !== -1 && (referenceStart === -1 || codeStart < referenceStart)) {
      output += line.slice(cursor, codeStart)
      let delimiterEnd = codeStart + 1
      while (line.charAt(delimiterEnd) === '`') delimiterEnd++
      const delimiter = line.slice(codeStart, delimiterEnd)
      const codeEnd = line.indexOf(delimiter, delimiterEnd)
      if (codeEnd === -1) {
        output += line.slice(codeStart)
        break
      }
      const protectedEnd = codeEnd + delimiter.length
      output += line.slice(codeStart, protectedEnd)
      cursor = protectedEnd
      continue
    }

    if (!reference || referenceStart === -1) {
      output += line.slice(cursor)
      break
    }

    output += line.slice(cursor, referenceStart)
    const rawReference = reference[0]
    const rawPath = reference[1]
    const referenceEnd = referenceStart + rawReference.length
    const suffix = line.slice(referenceEnd)
    const alreadyLinked = /^[ \t]*(?:\(|\[)/.test(suffix)
    const outerLabelStart = line.lastIndexOf('[', referenceStart - 1)
    const outerLabelEnd = line.indexOf(']', referenceEnd)
    const insideMarkdownLink = outerLabelStart !== -1
      && outerLabelEnd !== -1
      && !line.slice(outerLabelStart + 1, referenceStart).includes(']')
      && /^[ \t]*(?:\(|\[)/.test(line.slice(outerLabelEnd + 1))
    const inAngleBrackets = line.lastIndexOf('<', referenceStart) > line.lastIndexOf('>', referenceStart)

    if (isEscaped(line, referenceStart) || alreadyLinked || insideMarkdownLink || inAngleBrackets) {
      output += rawReference
      cursor = referenceEnd
      continue
    }

    const path = normalizeFileReferencePath(rawPath)
    if (!path) {
      output += rawReference
      cursor = referenceEnd
      continue
    }

    const label = escapeMarkdownLabel(rawReference.slice(1, -1))
    output += `[&#91;${label}&#93;](${WORKSPACE_FILE_REFERENCE_PREFIX}${encodePath(path)})`
    cursor = referenceEnd
  }

  return output
}

export const linkifyWorkspaceFileReferences = (markdown: string) => {
  const lines = markdown.split('\n')
  let fenceChar = ''
  let fenceLength = 0

  return lines.map(line => {
    const fence = line.match(fenceRule)?.[1]
    if (fence) {
      const char = fence.charAt(0)
      if (!fenceChar) {
        fenceChar = char
        fenceLength = fence.length
      } else if (char === fenceChar && fence.length >= fenceLength) {
        fenceChar = ''
        fenceLength = 0
      }
      return line
    }
    return fenceChar ? line : linkifyLine(line)
  }).join('\n')
}
