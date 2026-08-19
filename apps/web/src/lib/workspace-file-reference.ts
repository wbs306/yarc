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

export const parseWorkspaceFileReferenceHref = (href?: string | null): string | null => {
  if (!href?.startsWith(WORKSPACE_FILE_REFERENCE_PREFIX)) return null
  try {
    return normalizeWorkspaceFileReferencePath(decodeURIComponent(href.slice(WORKSPACE_FILE_REFERENCE_PREFIX.length)))
  } catch {
    return null
  }
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

    const path = normalizeWorkspaceFileReferencePath(rawPath)
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
