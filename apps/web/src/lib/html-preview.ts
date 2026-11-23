import { htmlLanguage } from '@codemirror/lang-html'

const imageTypes: Readonly<Record<string, string | undefined>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
}

const invalidPathCharacters = /[\\\u0000-\u001f\u007f]/

// Resolve against the file's directory, never against the web origin or a <base> tag.
export function resolveHtmlPreviewAssetPath(htmlPath: string, reference: string): string | null {
  const relative = reference.trim().split(/[?#]/, 1)[0]
  if (!relative || relative.startsWith('/') || relative.includes(':') || invalidPathCharacters.test(relative)) return null
  const path = htmlPath.split('/').slice(0, -1)
  if (path.some(segment => !segment || segment.startsWith('.') || invalidPathCharacters.test(segment))) return null
  try {
    for (const part of relative.split('/')) {
      const segment = decodeURIComponent(part)
      if (!segment || segment === '.') continue
      if (segment === '..') {
        if (!path.length) return null
        path.pop()
      } else {
        if (segment.startsWith('.') || /[/:]/.test(segment) || invalidPathCharacters.test(segment)) return null
        path.push(segment)
      }
    }
  } catch {
    return null
  }
  return path.join('/') || null
}

export interface HtmlPreviewAsset {
  path: string
  mime: string
  from: number
  to: number
}

export function findHtmlPreviewAssets(
  source: string,
  htmlPath: string,
  decodeAttribute = (value: string) => value,
): HtmlPreviewAsset[] {
  const assets: HtmlPreviewAsset[] = []
  const textOf = (node: { from: number; to: number }) => source.slice(node.from, node.to)
  htmlLanguage.parser.parse(source).iterate({
    enter(node) {
      if (node.name !== 'OpenTag' && node.name !== 'SelfClosingTag') return
      const name = node.node.getChild('TagName')
      const tag = name && textOf(name).toLowerCase()
      if (tag !== 'img' && tag !== 'link') return

      const attributes = node.node.getChildren('Attribute')
      const attribute = (name: string) => {
        const match = attributes.find(attr => {
          const attrName = attr.getChild('AttributeName')
          return attrName && textOf(attrName).toLowerCase() === name
        })
        return match?.getChild('AttributeValue') ?? match?.getChild('UnquotedAttributeValue')
      }
      const valueOf = (node: { from: number; to: number; name: string }) => {
        const text = textOf(node)
        return decodeAttribute(node.name === 'AttributeValue' ? text.slice(1, -1) : text)
      }
      if (tag === 'link') {
        const rel = attribute('rel')
        if (!rel || !valueOf(rel).toLowerCase().split(/\s+/).includes('stylesheet')) return
      }

      const reference = attribute(tag === 'img' ? 'src' : 'href')
      if (!reference) return
      const path = resolveHtmlPreviewAssetPath(htmlPath, valueOf(reference))
      if (!path) return
      const extension = /\.([a-z]+)$/i.exec(path)?.[1].toLowerCase()
      const mime = tag === 'link' ? (extension === 'css' ? 'text/css' : undefined) : imageTypes[extension ?? '']
      if (mime) assets.push({ path, mime, from: reference.from, to: reference.to })
    },
  })
  return assets
}

const MAX_ASSETS = 48
const MAX_ASSET_BYTES = 4 * 1024 * 1024
const MAX_TOTAL_BYTES = 12 * 1024 * 1024
const MAX_EMBEDDED_CHARS = 17 * 1024 * 1024

export function embedHtmlPreviewAssets(source: string, assets: HtmlPreviewAsset[], dataUrls: ReadonlyMap<string, string>) {
  const parts: string[] = []
  let offset = 0
  let missing = 0
  let remaining = MAX_EMBEDDED_CHARS
  for (const asset of assets) {
    const url = dataUrls.get(asset.path)
    // Repeated uses of a large image still count against the srcdoc size limit.
    if (!url || url.length > remaining) {
      missing++
      continue
    }
    remaining -= url.length
    parts.push(source.slice(offset, asset.from), `"${url}"`)
    offset = asset.to
  }
  parts.push(source.slice(offset))
  return { content: parts.join(''), missing }
}

async function readAsset(url: string, mime: string, maxBytes: number, signal: AbortSignal): Promise<Blob | null> {
  const response = await fetch(url, { credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store', signal })
  if (!response.ok || !response.body || Number(response.headers.get('Content-Length')) > maxBytes) {
    await response.body?.cancel()
    return null
  }
  const reader = response.body.getReader()
  const parts: BlobPart[] = []
  let bytes = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) return new Blob(parts, { type: mime })
      bytes += value.byteLength
      if (bytes > maxBytes) {
        await reader.cancel()
        return null
      }
      parts.push(new Uint8Array(value))
    }
  } finally {
    reader.releaseLock()
  }
}

const toDataUrl = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader()
  reader.onload = () => resolve(String(reader.result))
  reader.onerror = () => reject(reader.error)
  reader.readAsDataURL(blob)
})

export async function loadHtmlPreviewAssets(
  assets: HtmlPreviewAsset[],
  downloadUrl: (path: string) => string,
  signal: AbortSignal,
) {
  const unique = new Map(assets.map(asset => [asset.path, asset.mime]))
  const queue = Array.from(unique.entries()).slice(0, MAX_ASSETS).values()
  const dataUrls = new Map<string, string>()
  let remainingBytes = MAX_TOTAL_BYTES
  const loadNext = async () => {
    for (const [path, mime] of queue) {
      if (signal.aborted || remainingBytes <= 0) return
      try {
        const blob = await readAsset(downloadUrl(path), mime, Math.min(MAX_ASSET_BYTES, remainingBytes), signal)
        if (!blob || blob.size > remainingBytes || signal.aborted) continue
        remainingBytes -= blob.size
        dataUrls.set(path, await toDataUrl(blob))
      } catch {
        // An unavailable asset should not prevent the rest of the document from rendering.
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, unique.size) }, loadNext))
  return dataUrls
}
