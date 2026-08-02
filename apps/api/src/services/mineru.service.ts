import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { config } from '../lib/config.js'
import { AppError } from '../lib/errors.js'

const execFileAsync = promisify(execFile)

interface MinerUParseResult {
  text: string
  pages: Array<{
    page: number
    text: string
    images: string[]
  }>
  metadata?: Record<string, unknown>
}

const firstResultPayload = (data: any) => {
  if (Array.isArray(data?.results)) return data.results[0] || data
  if (data?.results && typeof data.results === 'object') {
    const first = Object.values(data.results)[0]
    if (first && typeof first === 'object') return first
  }
  return data?.result || data
}

const normalizePages = (data: any): MinerUParseResult['pages'] => {
  const payload = firstResultPayload(data)

  // content_list may be a JSON string (pipeline backend)
  let contentList = payload.content_list
  if (typeof contentList === 'string') {
    try { contentList = JSON.parse(contentList) } catch { contentList = null }
  }

  if (Array.isArray(contentList) && contentList.length > 0) {
    const byPage = new Map<number, string[]>()
    for (const item of contentList) {
      const pageRaw = item.page_idx ?? item.page ?? item.pageNumber
      const page = pageRaw != null ? Number(pageRaw) + 1 : 1
      const text = String(item.text || item.content || item.md || '').trim()
      if (!text) continue
      byPage.set(page, [...(byPage.get(page) || []), text])
    }
    if (byPage.size > 0) {
      return [...byPage.entries()]
        .sort(([a], [b]) => a - b)
        .map(([page, texts]) => ({ page, text: texts.join('\n\n'), images: [] }))
    }
  }

  const dataPages = payload.pages || payload.page_texts ? payload : data
  if (Array.isArray(dataPages.pages)) {
    return dataPages.pages.map((page: any, index: number) => ({
      page: Number(page.page || page.pageNumber || page.page_index || index + 1),
      text: String(page.text || page.content || page.md || ''),
      images: Array.isArray(page.images) ? page.images : [],
    }))
  }

  if (Array.isArray(dataPages.page_texts)) {
    return dataPages.page_texts.map((text: any, index: number) => ({ page: index + 1, text: String(text || ''), images: [] }))
  }

  return []
}

const normalizeText = (data: any, pages: MinerUParseResult['pages']) => {
  const payload = firstResultPayload(data)
  return String(
    payload.md_content ||
    payload.markdown ||
    payload.md ||
    payload.text ||
    payload.full_text ||
    data.text ||
    data.full_text ||
    data.markdown ||
    data.md ||
    pages.map((page) => page.text).join('\n')
  )
}

async function listFilesRecursive(root: string): Promise<string[]> {
  const files: string[] = []
  const visit = async (dir: string) => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) await visit(fullPath)
      else if (entry.isFile()) files.push(fullPath)
    }
  }
  await visit(root)
  return files
}

async function readJsonFile(path: string) {
  try {
    return JSON.parse(await readFile(path, 'utf-8'))
  } catch {
    return undefined
  }
}

export class MinerUService {
  async parsePdf(pdfPath: string, paperId?: string): Promise<MinerUParseResult> {
    // MinerU is the authoritative parser for YARC. Do not fall back to
    // pdftotext: downstream embedding/summary require content_list_v2 and
    // images from MinerU artifacts.
    const outputDir = paperId ? join(config.papersDir, paperId, 'mineru') : undefined
    return this.parseWithMinerU(pdfPath, outputDir)
  }

  async parsePdfToDirectory(pdfPath: string, outputDir: string): Promise<MinerUParseResult> {
    return this.parseWithMinerU(pdfPath, outputDir)
  }

  private async parseWithMinerU(pdfPath: string, outputDir?: string): Promise<MinerUParseResult> {
    const formData = new FormData()
    const fileBuffer = await readFile(pdfPath)
    formData.append('files', new Blob([fileBuffer], { type: 'application/pdf' }), 'paper.pdf')
    formData.append('backend', 'pipeline')
    formData.append('lang_list', 'en')
    formData.append('parse_method', 'auto')
    formData.append('formula_enable', 'true')
    formData.append('table_enable', 'true')
    formData.append('return_md', 'true')
    formData.append('return_content_list', 'true')
    formData.append('return_middle_json', 'true')
    formData.append('return_images', 'true')
    formData.append('response_format_zip', 'true')
    formData.append('return_original_file', 'false')

    const res = await fetch(`${config.mineruApiUrl}/file_parse`, {
      method: 'POST',
      body: formData,
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new AppError('MINERU_ERROR', `MinerU API error: ${res.status} ${body.slice(0, 500)}`, 502)
    }

    const contentType = res.headers.get('content-type') || ''
    const data = contentType.includes('application/zip') || contentType.includes('application/octet-stream')
      ? await this.persistZipResult(outputDir, res)
      : await res.json()

    // Check if MinerU returned a failed status
    if (data.status === 'failed') {
      throw new Error(data.error || 'MinerU returned failed status')
    }

    let pages = normalizePages(data)
    const resultPath = outputDir ? await this.persistRawResult(outputDir, data) : undefined

    // Fallback: if no pages extracted but text exists, use full text as single page
    const fullText = normalizeText(data, pages)
    if (pages.length === 0 && fullText.trim()) {
      pages = [{ page: 1, text: fullText, images: [] }]
    }

    return {
      text: fullText,
      pages,
      metadata: {
        ...(data.metadata || {}),
        mineru: {
          resultPath,
          source: 'mineru',
          parsedAt: new Date().toISOString(),
        },
      },
    }
  }

  private async persistZipResult(outputDir: string | undefined, res: Response) {
    const buffer = Buffer.from(await res.arrayBuffer())
    if (!outputDir) {
      throw new Error('ZIP MinerU response requires an output directory for artifact persistence')
    }

    const dir = outputDir
    const artifactDir = join(dir, 'artifacts')
    const extractDir = join(dir, '.mineru-extract')
    await rm(dir, { recursive: true, force: true })
    await mkdir(extractDir, { recursive: true })

    // MinerU's ZIP currently nests outputs under <input-name>/<parse-method>/
    // (for example pdf/auto/pdf.md). Do not rely on those directory names:
    // extract to a temporary directory, find the directory containing the main
    // markdown, then canonicalize its contents into mineru/artifacts/.
    const zipPath = join(dir, '.mineru-result.tmp.zip')
    await writeFile(zipPath, buffer)
    await execFileAsync('unzip', ['-q', '-o', zipPath, '-d', extractDir], { timeout: 120_000 })
    await rm(zipPath, { force: true })

    const extractedFiles = await listFilesRecursive(extractDir)
    const extractedMdPath = extractedFiles.find((file) => file.endsWith('.md'))
    const sourceDir = extractedMdPath ? dirname(extractedMdPath) : extractDir
    await mkdir(artifactDir, { recursive: true })
    await cp(sourceDir, artifactDir, { recursive: true, force: true })
    await rm(extractDir, { recursive: true, force: true })

    const files = await listFilesRecursive(artifactDir)
    const mdPath = files.find((file) => file.endsWith('.md'))
    const contentListPath = files.find((file) => /content_list\.json$/.test(file) && !/content_list_v2\.json$/.test(file))
    const contentListV2Path = files.find((file) => /content_list_v2\.json$/.test(file))
    const middleJsonPath = files.find((file) => /middle\.json$/.test(file))
    const imageFiles = files.filter((file) => /\.(png|jpe?g|webp|gif|bmp)$/i.test(file))

    const mdContent = mdPath ? await readFile(mdPath, 'utf-8') : ''
    const contentList = contentListPath ? await readJsonFile(contentListPath) : undefined
    const contentListV2 = contentListV2Path ? await readJsonFile(contentListV2Path) : undefined
    const middleJson = middleJsonPath ? await readJsonFile(middleJsonPath) : undefined
    const resultKey = mdPath ? basename(mdPath).replace(/\.md$/i, '') : 'result'

    return {
      task_id: res.headers.get('x-mineru-task-id') || undefined,
      status: res.headers.get('x-mineru-task-status') || 'completed',
      backend: 'pipeline',
      status_url: res.headers.get('x-mineru-task-status-url') || undefined,
      result_url: res.headers.get('x-mineru-task-result-url') || undefined,
      content_type: res.headers.get('content-type') || undefined,
      artifact_dir: artifactDir,
      results: {
        [resultKey]: {
          md_content: mdContent,
          content_list: contentList,
          content_list_v2: contentListV2,
          middle_json: middleJson,
          markdown_path: mdPath,
          content_list_path: contentListPath,
          content_list_v2_path: contentListV2Path,
          middle_json_path: middleJsonPath,
          images_dir: imageFiles.length ? dirname(imageFiles[0]) : undefined,
          image_files: imageFiles.map((file) => file.slice(artifactDir.length + 1)),
        },
      },
    }
  }

  private async persistRawResult(outputDir: string, data: unknown) {
    await mkdir(outputDir, { recursive: true })
    const resultPath = join(outputDir, 'result.json')
    await writeFile(resultPath, JSON.stringify(data, null, 2))
    return resultPath
  }
}

export const mineruService = new MinerUService()
