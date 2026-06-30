import { Hono } from 'hono'
import { prisma } from '@yarc/db'
import { piService } from '../services/pi.service.js'
import { paperService } from '../services/paper.service.js'
import { jobQueue } from '../services/job-queue.service.js'
import { config } from '../lib/config.js'
import { DEFAULT_SUMMARY_PROMPT, DEFAULT_CHAT_SYSTEM_PROMPT } from '../lib/prompts.js'
import {
  agentWorkspacePaths,
  readAgentMd,
  readAgentSettings,
  readAgentSkills,
  readAgentSummaryPrompt,
  readAgentSystemPrompt,
  writeAgentMd,
  writeAgentSettings,
  writeAgentSkills,
  writeAgentSummaryPrompt,
  writeAgentSystemPrompt,
} from '../lib/agent-workspace.js'
import { spawn } from 'node:child_process'
import { access, mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises'
import { dirname, extname, join, parse, resolve } from 'node:path'
import { readModelCatalog, fetchAndCacheModelCatalog } from '../lib/model-catalog.js'
import { randomUUID } from 'node:crypto'

const settings = new Hono()

const DEFAULT_THEME = {
  mode: 'light',
  primaryColor: '#6366f1',
  backgroundImage: '',
  maskColor: '',
  maskOpacity: 70,
  maskBlur: 12,
}

const BACKGROUND_MAX_SIZE = 20 * 1024 * 1024
const BACKGROUND_MIME_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
}

const zeroIfMissing = async (path: string) => {
  try {
    return await stat(path)
  } catch {
    return null
  }
}

const walkDirStats = async (root: string): Promise<{ bytes: number; files: number; dirs: number }> => {
  let bytes = 0
  let files = 0
  let dirs = 0

  const visit = async (dir: string) => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        dirs++
        await visit(fullPath)
      } else if (entry.isFile()) {
        const info = await zeroIfMissing(fullPath)
        if (info) {
          files++
          bytes += info.size
        }
      }
    }
  }

  await visit(root)
  return { bytes, files, dirs }
}

// GET /api/settings/models
settings.get('/models', async (c) => {
  const result = await piService.listModels(c.req.query('refresh') === '1')
  return c.json(result)
})

// GET /api/settings/prompt-defaults
settings.get('/prompt-defaults', (c) => {
  return c.json({
    defaults: {
      summary_prompt: DEFAULT_SUMMARY_PROMPT,
      system_prompt: DEFAULT_CHAT_SYSTEM_PROMPT,
    },
  })
})

// GET /api/settings
settings.get('/', async (c) => {
  const all = await prisma.setting.findMany()
  const result: Record<string, unknown> = {}
  for (const s of all) {
    if (s.key === 'password_hash') continue
    result[s.key] = s.value
  }
  // Read from filesystem (seeded at startup, kept in sync by PUT handlers).
  // No ensureAgentWorkspace() here — it writes files and triggers SSE storms.
  result.summary_prompt = await readAgentSummaryPrompt()
  result.system_prompt = await readAgentSystemPrompt()
  result.agent_md = await readAgentMd()
  result.skills = await readAgentSkills()
  return c.json({ settings: result })
})

// GET /api/settings/system-status
// Live status snapshot for the Settings → System page. This endpoint does not
// persist or cache metrics; it scans data/papers and runs aggregate DB queries
// at request time so the display reflects the current backend state.
settings.get('/system-status', async (c) => {
  const papersDir = config.papersDir
  const dataDir = config.dataDir

  const [
    paperOverviewRows,
    summaryCoverageRows,
    parseStatusRows,
    embeddingStatusRows,
    summaryStatusRows,
    taskStatusRows,
    chunkRows,
    chunkDimRows,
    indexRows,
  ] = await Promise.all([
    prisma.$queryRaw<Array<{
      total: number
      withPdfPath: number
      missingPdfPath: number
      parseCompleted: number
      unparsed: number
      parseFailed: number
      parseProcessing: number
      parsePending: number
      parseResultMissing: number
      completedWithoutMineruMetadata: number
      missingSummary: number
      summaryCompleted: number
      summaryFailed: number
      summaryProcessing: number
      summaryPending: number
      embeddingCompleted: number
      embeddingFailed: number
      embeddingProcessing: number
      embeddingPending: number
      totalPdfBytes: number
      totalSummaryChars: number
      totalParsedTextChars: number
    }>>`
      SELECT
        COUNT(*)::int AS "total",
        COUNT(*) FILTER (WHERE file_path IS NOT NULL AND file_path <> '')::int AS "withPdfPath",
        COUNT(*) FILTER (WHERE file_path IS NULL OR file_path = '')::int AS "missingPdfPath",
        COUNT(*) FILTER (WHERE parse_status = 'completed')::int AS "parseCompleted",
        COUNT(*) FILTER (WHERE parse_status IS DISTINCT FROM 'completed')::int AS "unparsed",
        COUNT(*) FILTER (WHERE parse_status = 'failed')::int AS "parseFailed",
        COUNT(*) FILTER (WHERE parse_status = 'processing')::int AS "parseProcessing",
        COUNT(*) FILTER (WHERE parse_status = 'pending')::int AS "parsePending",
        COUNT(*) FILTER (WHERE parse_result IS NULL)::int AS "parseResultMissing",
        COUNT(*) FILTER (
          WHERE parse_status = 'completed'
            AND (parse_result->'metadata'->'mineru') IS NULL
        )::int AS "completedWithoutMineruMetadata",
        COUNT(*) FILTER (WHERE summary IS NULL OR btrim(summary) = '')::int AS "missingSummary",
        COUNT(*) FILTER (WHERE summary_status = 'completed')::int AS "summaryCompleted",
        COUNT(*) FILTER (WHERE summary_status = 'failed')::int AS "summaryFailed",
        COUNT(*) FILTER (WHERE summary_status = 'processing')::int AS "summaryProcessing",
        COUNT(*) FILTER (WHERE summary_status = 'pending')::int AS "summaryPending",
        COUNT(*) FILTER (WHERE embedding_status = 'completed')::int AS "embeddingCompleted",
        COUNT(*) FILTER (WHERE embedding_status = 'failed')::int AS "embeddingFailed",
        COUNT(*) FILTER (WHERE embedding_status = 'processing')::int AS "embeddingProcessing",
        COUNT(*) FILTER (WHERE embedding_status = 'pending')::int AS "embeddingPending",
        COALESCE(SUM(file_size), 0)::float8 AS "totalPdfBytes",
        COALESCE(SUM(length(COALESCE(summary, ''))), 0)::float8 AS "totalSummaryChars",
        COALESCE(SUM(length(COALESCE(parse_result->>'text', ''))), 0)::float8 AS "totalParsedTextChars"
      FROM papers
    `,
    prisma.$queryRaw<Array<{
      paperSummaryFilled: number
      summaryNotePapers: number
      organizedNotePapers: number
      summaryLikeNotePapers: number
      summaryCovered: number
      missingSummaryEffective: number
      completedWithoutSummaryField: number
      summaryFieldWithoutCompletedStatus: number
    }>>`
      WITH note_flags AS (
        SELECT
          paper_id,
          BOOL_OR(kind = 'summary') AS has_summary_note,
          BOOL_OR(kind = 'organized') AS has_organized_note,
          BOOL_OR(
            kind IN ('summary', 'organized')
            OR title ~* '(总结|summary|文献总结|概括|综述|导入笔记)'
          ) AS has_summary_like_note
        FROM notes
        GROUP BY paper_id
      )
      SELECT
        COUNT(*) FILTER (WHERE p.summary IS NOT NULL AND btrim(p.summary) <> '')::int AS "paperSummaryFilled",
        COUNT(*) FILTER (WHERE COALESCE(n.has_summary_note, false))::int AS "summaryNotePapers",
        COUNT(*) FILTER (WHERE COALESCE(n.has_organized_note, false))::int AS "organizedNotePapers",
        COUNT(*) FILTER (WHERE COALESCE(n.has_summary_like_note, false))::int AS "summaryLikeNotePapers",
        COUNT(*) FILTER (
          WHERE (p.summary IS NOT NULL AND btrim(p.summary) <> '')
             OR COALESCE(n.has_summary_like_note, false)
        )::int AS "summaryCovered",
        COUNT(*) FILTER (
          WHERE (p.summary IS NULL OR btrim(p.summary) = '')
            AND NOT COALESCE(n.has_summary_like_note, false)
        )::int AS "missingSummaryEffective",
        COUNT(*) FILTER (
          WHERE p.summary_status = 'completed'
            AND (p.summary IS NULL OR btrim(p.summary) = '')
        )::int AS "completedWithoutSummaryField",
        COUNT(*) FILTER (
          WHERE p.summary_status IS DISTINCT FROM 'completed'
            AND p.summary IS NOT NULL
            AND btrim(p.summary) <> ''
        )::int AS "summaryFieldWithoutCompletedStatus"
      FROM papers p
      LEFT JOIN note_flags n ON n.paper_id = p.id
    `,
    prisma.paper.groupBy({ by: ['parseStatus'], _count: { _all: true } }),
    prisma.paper.groupBy({ by: ['embeddingStatus'], _count: { _all: true } }),
    prisma.paper.groupBy({ by: ['summaryStatus'], _count: { _all: true } }),
    prisma.task.groupBy({ by: ['type', 'status'], _count: { _all: true } }),
    prisma.$queryRaw<Array<{
      totalChunks: number
      chunksWithEmbedding: number
      chunksWithoutEmbedding: number
      papersWithChunks: number
      avgChunksPerPaper: number
      avgChunkChars: number
      maxChunkChars: number
      tableBytes: number
      indexBytes: number
      totalBytes: number
    }>>`
      SELECT
        COUNT(*)::int AS "totalChunks",
        COUNT(*) FILTER (WHERE embedding IS NOT NULL)::int AS "chunksWithEmbedding",
        COUNT(*) FILTER (WHERE embedding IS NULL)::int AS "chunksWithoutEmbedding",
        COUNT(DISTINCT paper_id)::int AS "papersWithChunks",
        CASE WHEN COUNT(DISTINCT paper_id) = 0 THEN 0 ELSE (COUNT(*)::float8 / COUNT(DISTINCT paper_id)) END AS "avgChunksPerPaper",
        COALESCE(AVG(length(content)), 0)::float8 AS "avgChunkChars",
        COALESCE(MAX(length(content)), 0)::int AS "maxChunkChars",
        pg_relation_size('paper_chunks')::float8 AS "tableBytes",
        pg_indexes_size('paper_chunks')::float8 AS "indexBytes",
        pg_total_relation_size('paper_chunks')::float8 AS "totalBytes"
      FROM paper_chunks
    `,
    prisma.$queryRaw<Array<{ dimensions: number | null; count: number }>>`
      SELECT vector_dims(embedding)::int AS "dimensions", COUNT(*)::int AS "count"
      FROM paper_chunks
      WHERE embedding IS NOT NULL
      GROUP BY vector_dims(embedding)
      ORDER BY vector_dims(embedding)
    `,
    prisma.$queryRaw<Array<{ name: string; sizeBytes: number; definition: string }>>`
      SELECT
        i.relname AS "name",
        pg_relation_size(i.oid)::float8 AS "sizeBytes",
        pg_get_indexdef(i.oid) AS "definition"
      FROM pg_class t
      JOIN pg_index ix ON t.oid = ix.indrelid
      JOIN pg_class i ON i.oid = ix.indexrelid
      WHERE t.relname = 'paper_chunks'
      ORDER BY i.relname
    `,
  ])

  const paperOverview = paperOverviewRows[0]
  const summaryCoverage = summaryCoverageRows[0]
  const chunkStats = chunkRows[0]

  const paperDirs = await readdir(papersDir, { withFileTypes: true }).catch(() => [])
  const paperDirNames = paperDirs.filter((entry) => entry.isDirectory()).map((entry) => entry.name)

  const mineru = {
    resultJson: 0,
    missingResultJson: 0,
    resultBytes: 0,
    fallbackResults: 0,
    rawMineruResults: 0,
    resultWithPages: 0,
    resultWithText: 0,
    backendCounts: {} as Record<string, number>,
    statusCounts: {} as Record<string, number>,
    sourceCounts: {} as Record<string, number>,
  }

  let pdfFiles = 0
  let pdfBytes = 0
  let missingPdfFile = 0

  for (const paperId of paperDirNames) {
    const dir = join(papersDir, paperId)
    const pdfInfo = await zeroIfMissing(join(dir, 'pdf.pdf'))
    if (pdfInfo?.isFile()) {
      pdfFiles++
      pdfBytes += pdfInfo.size
    } else {
      missingPdfFile++
    }

    const resultPath = join(dir, 'mineru', 'result.json')
    const resultInfo = await zeroIfMissing(resultPath)
    if (!resultInfo?.isFile()) {
      mineru.missingResultJson++
      continue
    }

    mineru.resultJson++
    mineru.resultBytes += resultInfo.size

    try {
      const result = JSON.parse(await readFile(resultPath, 'utf-8')) as any
      const backend = typeof result.backend === 'string' && result.backend ? result.backend : 'unknown'
      const status = typeof result.status === 'string' && result.status ? result.status : 'unknown'
      const source = typeof result.source === 'string' && result.source ? result.source : 'mineru'
      mineru.backendCounts[backend] = (mineru.backendCounts[backend] || 0) + 1
      mineru.statusCounts[status] = (mineru.statusCounts[status] || 0) + 1
      mineru.sourceCounts[source] = (mineru.sourceCounts[source] || 0) + 1
      if (source === 'pdftotext-fallback') mineru.fallbackResults++
      else mineru.rawMineruResults++
      if (Array.isArray(result.pages) || result.results) mineru.resultWithPages++
      if (typeof result.text === 'string' || result.results) mineru.resultWithText++
    } catch {
      mineru.statusCounts.invalid_json = (mineru.statusCounts.invalid_json || 0) + 1
    }
  }

  const [dataDirStats, papersDirStats] = await Promise.all([
    walkDirStats(dataDir),
    walkDirStats(papersDir),
  ])

  return c.json({
    status: {
      generatedAt: new Date().toISOString(),
      source: 'live',
      note: '实时扫描文件系统并执行聚合查询；不写入统计缓存。',
      papers: {
        ...paperOverview,
        summaryCoverage,
        parseStatus: Object.fromEntries(parseStatusRows.map((row) => [row.parseStatus, row._count._all])),
        embeddingStatus: Object.fromEntries(embeddingStatusRows.map((row) => [row.embeddingStatus, row._count._all])),
        summaryStatus: Object.fromEntries(summaryStatusRows.map((row) => [row.summaryStatus, row._count._all])),
      },
      mineru: {
        ...mineru,
        paperDirs: paperDirNames.length,
        notMineruParsed: mineru.missingResultJson + mineru.fallbackResults,
      },
      chunks: {
        ...chunkStats,
        papersWithoutChunks: Math.max(0, paperOverview.total - chunkStats.papersWithChunks),
        dimensions: chunkDimRows,
        indexes: indexRows,
      },
      tasks: {
        byTypeStatus: taskStatusRows.map((row) => ({ type: row.type, status: row.status, count: row._count._all })),
      },
      storage: {
        dataDir: { path: dataDir, ...dataDirStats },
        papersDir: { path: papersDir, ...papersDirStats },
        pdfFiles,
        pdfBytes,
        missingPdfFile,
        mineruResultBytes: mineru.resultBytes,
        paperChunkBytes: chunkStats.totalBytes,
        paperChunkTableBytes: chunkStats.tableBytes,
        paperChunkIndexBytes: chunkStats.indexBytes,
      },
    },
  })
})

const limitTargets = (ids: string[], limit: unknown) => {
  const parsedLimit = Number(limit)
  if (!Number.isInteger(parsedLimit) || parsedLimit <= 0) return ids
  return ids.slice(0, parsedLimit)
}

// POST /api/settings/maintenance/:action
settings.post('/maintenance/:action', async (c) => {
  const action = c.req.param('action')
  const body = await c.req.json().catch(() => ({})) as { scope?: string; limit?: number }
  const scope = body.scope === 'all' ? 'all' : 'needed'

  let targetRows: Array<{ id: string }> = []

  if (action === 'embeddings') {
    targetRows = scope === 'all'
      ? await prisma.$queryRaw<Array<{ id: string }>>`
          SELECT id::text AS id
          FROM papers
          WHERE parse_status = 'completed'
          ORDER BY updated_at DESC
        `
      : await prisma.$queryRaw<Array<{ id: string }>>`
          SELECT p.id::text AS id
          FROM papers p
          LEFT JOIN paper_chunks pc ON pc.paper_id = p.id
          WHERE p.parse_status = 'completed'
          GROUP BY p.id
          HAVING COUNT(pc.id) = 0 OR p.embedding_status IS DISTINCT FROM 'completed'
          ORDER BY p.updated_at DESC
        `
  } else if (action === 'summaries') {
    targetRows = scope === 'all'
      ? await prisma.$queryRaw<Array<{ id: string }>>`
          SELECT id::text AS id
          FROM papers
          WHERE parse_status = 'completed'
          ORDER BY updated_at DESC
        `
      : await prisma.$queryRaw<Array<{ id: string }>>`
          WITH note_flags AS (
            SELECT paper_id, BOOL_OR(kind = 'summary') AS has_summary_note
            FROM notes
            GROUP BY paper_id
          )
          SELECT p.id::text AS id
          FROM papers p
          LEFT JOIN note_flags n ON n.paper_id = p.id
          WHERE p.parse_status = 'completed'
            AND (p.summary IS NULL OR btrim(p.summary) = '')
            AND NOT COALESCE(n.has_summary_note, false)
          ORDER BY p.updated_at DESC
        `
  } else if (action === 'mineru') {
    targetRows = scope === 'all'
      ? await prisma.$queryRaw<Array<{ id: string }>>`
          SELECT id::text AS id
          FROM papers
          WHERE file_path IS NOT NULL AND file_path <> ''
          ORDER BY updated_at DESC
        `
      : await prisma.$queryRaw<Array<{ id: string }>>`
          SELECT id::text AS id
          FROM papers
          WHERE file_path IS NOT NULL AND file_path <> ''
            AND (
              parse_status IS DISTINCT FROM 'completed'
              OR parse_result IS NULL
              OR (parse_result->'metadata'->'mineru') IS NULL
              OR (parse_result->'metadata'->'mineru'->>'source') IS DISTINCT FROM 'mineru'
              OR (metadata->'mineru'->>'source') IS DISTINCT FROM 'mineru'
            )
          ORDER BY updated_at DESC
        `
  } else {
    return c.json({ error: { code: 'INVALID_ACTION', message: 'Unknown maintenance action' } }, 400)
  }

  const ids = limitTargets(targetRows.map((row) => row.id), body.limit)
  const errors: Array<{ id: string; message: string }> = []

  for (const id of ids) {
    try {
      if (action === 'embeddings') {
        await paperService.updateStatus(id, 'embeddingStatus', {
          embeddingStatus: 'pending',
          embeddingProgress: 0,
        })
        jobQueue.add('generate_embedding', id)
      } else if (action === 'summaries') {
        await paperService.summarize(id)
      } else if (action === 'mineru') {
        await paperService.reparse(id)
      }
    } catch (err) {
      errors.push({ id, message: (err as Error).message })
    }
  }

  return c.json({
    action,
    scope,
    matched: targetRows.length,
    enqueued: ids.length - errors.length,
    limitedTo: ids.length,
    errors,
  })
})

// GET /api/settings/themes/active
settings.get('/themes/active', async (c) => {
  const theme = await prisma.setting.findUnique({ where: { key: 'theme' } })
  return c.json({ theme: theme?.value || DEFAULT_THEME })
})

// PUT /api/settings/themes/active
settings.put('/themes/active', async (c) => {
  const incoming = await c.req.json()
  const theme = { ...DEFAULT_THEME, ...(incoming && typeof incoming === 'object' ? incoming : {}) }
  await prisma.setting.upsert({
    where: { key: 'theme' },
    create: { key: 'theme', value: theme },
    update: { value: theme, updatedAt: new Date() },
  })
  return c.json({ theme })
})

const readPiSettings = async () => {
  return readAgentSettings()
}

const writePiSettings = async (data: any) => {
  await writeAgentSettings(data)
}

const fileExists = async (path: string) => {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

const ensureBackgroundThumb = async (srcPath: string, thumbPath: string) => {
  if (await fileExists(thumbPath)) return true

  await mkdir(dirname(thumbPath), { recursive: true })

  const args = [
    srcPath,
    '-auto-orient',
    '-resize',
    '360x225^',
    '-gravity',
    'center',
    '-extent',
    '360x225',
    '-strip',
    '-quality',
    '72',
    thumbPath,
  ]

  return await new Promise<boolean>((resolveThumb) => {
    const proc = spawn('magick', args, { stdio: 'ignore' })
    proc.on('error', () => resolveThumb(false))
    proc.on('close', (code) => resolveThumb(code === 0))
  })
}

const backgroundDir = () => resolve(config.dataDir, 'backgrounds')

const sanitizeBaseName = (name: string) => {
  const base = parse(name).name
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  return base || 'background'
}

const uniqueBackgroundFileName = async (originalName: string, mimeType: string) => {
  const ext = BACKGROUND_MIME_EXT[mimeType] || extname(originalName).toLowerCase()
  const base = sanitizeBaseName(originalName)
  const stamp = Date.now().toString(36)
  const random = randomUUID().slice(0, 8)
  return `${base}-${stamp}-${random}${ext}`
}

const buildBackgroundImageEntry = async (fileName: string) => {
  const bgDir = backgroundDir()
  const thumbDir = join(bgDir, 'thumbs')
  const thumbName = `${parse(fileName).name}.jpg`
  const thumbOk = await ensureBackgroundThumb(join(bgDir, fileName), join(thumbDir, thumbName))
  return {
    src: `/bg/${fileName}`,
    thumb: thumbOk ? `/bg/thumbs/${thumbName}` : `/bg/${fileName}`,
  }
}

// GET /api/settings/pi-enabled-models
settings.get('/pi-enabled-models', async (c) => {
  const pi = await readPiSettings()
  return c.json({ enabledModels: pi.enabledModels || [] })
})

// GET /api/settings/background-images
settings.get('/background-images', async (c) => {
  const bgDir = backgroundDir()
  try {
    const entries = await readdir(bgDir)
    const imageFiles = entries
      .filter(f => /\.(jpg|jpeg|png|webp|gif)$/i.test(f))
    const images = await Promise.all(imageFiles.map(buildBackgroundImageEntry))
    return c.json({ images })
  } catch {
    return c.json({ images: [] })
  }
})

// POST /api/settings/background-images
settings.post('/background-images', async (c) => {
  const formData = await c.req.formData()
  const file = formData.get('file') as File | null

  if (!file) {
    return c.json({ error: { code: 'MISSING_FILE', message: 'Background image is required' } }, 400)
  }
  if (!BACKGROUND_MIME_EXT[file.type]) {
    return c.json({ error: { code: 'INVALID_FILE_TYPE', message: 'Only JPG, PNG, WebP, and GIF images are supported' } }, 400)
  }
  if (file.size > BACKGROUND_MAX_SIZE) {
    return c.json({ error: { code: 'FILE_TOO_LARGE', message: 'Background image exceeds 20MB limit' } }, 400)
  }

  const bgDir = backgroundDir()
  await mkdir(bgDir, { recursive: true })
  const fileName = await uniqueBackgroundFileName(file.name, file.type)
  const filePath = join(bgDir, fileName)
  const buffer = Buffer.from(await file.arrayBuffer())
  await writeFile(filePath, buffer)

  const image = await buildBackgroundImageEntry(fileName)
  return c.json({ image }, 201)
})

// PUT /api/settings/pi-enabled-models
settings.put('/pi-enabled-models', async (c) => {
  const { enabledModels } = await c.req.json()
  if (!Array.isArray(enabledModels)) return c.json({ error: 'enabledModels must be array' }, 400)
  const pi = await readPiSettings()
  pi.enabledModels = enabledModels
  await writePiSettings(pi)
  await piService.reload('settings:enabledModels')
  return c.json({ enabledModels })
})

// GET /api/settings/pi-models — read custom models.json
settings.get('/pi-models', async (c) => {
  const paths = agentWorkspacePaths()
  let providers: Record<string, any> = {}
  try {
    const raw = await readFile(paths.models, 'utf-8')
    const parsed = JSON.parse(raw)
    providers = parsed.providers || {}
  } catch { /* file doesn't exist or invalid JSON */ }
  return c.json({ providers })
})

// PUT /api/settings/pi-models — write custom models.json and reload Pi
settings.put('/pi-models', async (c) => {
  const { providers } = await c.req.json()
  if (!providers || typeof providers !== 'object') {
    return c.json({ error: { code: 'INVALID_BODY', message: 'providers must be an object' } }, 400)
  }
  const paths = agentWorkspacePaths()
  await writeFile(paths.models, JSON.stringify({ providers }, null, 2) + '\n', 'utf-8')
  await piService.reload('settings:pi-models')
  return c.json({ providers })
})

// GET /api/settings/pi-settings — read pi settings.json
settings.get('/pi-settings', async (c) => {
  const data = await readAgentSettings()
  return c.json({ settings: data })
})

// PUT /api/settings/pi-settings — write pi settings.json and reload
settings.put('/pi-settings', async (c) => {
  const body = await c.req.json()
  if (!body || typeof body !== 'object') {
    return c.json({ error: { code: 'INVALID_BODY', message: 'body must be an object' } }, 400)
  }
  console.log('[Settings] Writing pi-settings:', JSON.stringify(body).slice(0, 200))
  try {
    await writeAgentSettings(body)
    console.log('[Settings] writeAgentSettings succeeded')
  } catch (err) {
    console.error('[Settings] writeAgentSettings failed:', err)
    return c.json({ error: { code: 'WRITE_FAILED', message: (err as Error).message } }, 500)
  }
  try {
    await piService.reload('settings:pi-settings')
    console.log('[Settings] piService.reload succeeded')
  } catch (err) {
    console.error('[Settings] piService.reload failed:', err)
    // Don't fail the request if reload fails — settings were saved
  }
  return c.json({ settings: body })
})

// GET /api/settings/pi-auth — read auth.json (keys masked)
settings.get('/pi-auth', async (c) => {
  const paths = agentWorkspacePaths()
  let entries: Record<string, { type: string; hasKey: boolean; expires?: number }> = {}
  try {
    const raw = await readFile(paths.auth, 'utf-8')
    const parsed = JSON.parse(raw)
    for (const [provider, val] of Object.entries(parsed)) {
      if (!val || typeof val !== 'object') continue
      const v = val as any
      if (v.type === 'api_key') {
        entries[provider] = { type: 'api_key', hasKey: !!v.key }
      } else if (v.type === 'oauth') {
        entries[provider] = { type: 'oauth', hasKey: !!v.access, expires: v.expires }
      }
    }
  } catch { /* file doesn't exist */ }
  return c.json({ entries })
})

// PUT /api/settings/pi-auth — upsert auth entries (merge with existing)
settings.put('/pi-auth', async (c) => {
  const { entries } = await c.req.json()
  if (!entries || typeof entries !== 'object') {
    return c.json({ error: { code: 'INVALID_BODY', message: 'entries must be an object' } }, 400)
  }
  const paths = agentWorkspacePaths()
  let existing: Record<string, any> = {}
  try {
    const raw = await readFile(paths.auth, 'utf-8')
    existing = JSON.parse(raw)
  } catch { /* file doesn't exist */ }
  // Merge: new entries overwrite, null removes
  for (const [provider, val] of Object.entries(entries)) {
    if (val === null) { delete existing[provider]; continue }
    if (val && typeof val === 'object') {
      existing[provider] = { ...val }
    }
  }
  await writeFile(paths.auth, JSON.stringify(existing, null, 2) + '\n', 'utf-8')
  await piService.reload('settings:pi-auth')
  // Return masked
  const masked: Record<string, { type: string; hasKey: boolean; expires?: number }> = {}
  for (const [k, v] of Object.entries(existing)) {
    if (!v || typeof v !== 'object') continue
    if (v.type === 'api_key') masked[k] = { type: 'api_key', hasKey: !!v.key }
    else if (v.type === 'oauth') masked[k] = { type: 'oauth', hasKey: !!v.access, expires: v.expires }
  }
  return c.json({ entries: masked })
})

// POST /api/settings/pi-auth/oauth-start — placeholder for OAuth flow initiation
// In a real implementation, this would start the OAuth flow and return the auth URL.
// For now, we just indicate that OAuth login needs to be done via `pi` CLI.
settings.post('/pi-auth/oauth-start', async (c) => {
  return c.json({ error: { code: 'NOT_SUPPORTED', message: 'OAuth 登录请使用 pi CLI 的 /login 命令完成。在终端运行 pi，然后输入 /login 选择 Provider。' } }, 400)
})

// PUT /api/settings/:key — generic setting update (MUST be after all specific PUT routes)
settings.put('/:key', async (c) => {
  const key = c.req.param('key')
  const { value } = await c.req.json()

  if (key === 'summary_prompt') await writeAgentSummaryPrompt(typeof value === 'string' ? value : '')
  if (key === 'system_prompt') await writeAgentSystemPrompt(typeof value === 'string' ? value : '')
  if (key === 'agent_md') await writeAgentMd(typeof value === 'string' ? value : '')
  if (key === 'skills') await writeAgentSkills(value)
  if (['summary_prompt', 'system_prompt', 'agent_md', 'skills'].includes(key)) {
    await piService.reload(`settings:${key}`)
  }

  await prisma.setting.upsert({
    where: { key },
    create: { key, value },
    update: { value, updatedAt: new Date() },
  })

  return c.json({ message: 'Updated' })
})

// POST /api/settings/pi-models/fetch — fetch models from a provider's API
settings.post('/pi-models/fetch', async (c) => {
  const { baseUrl, apiKey } = await c.req.json()
  if (!baseUrl) return c.json({ error: { code: 'MISSING_URL', message: 'baseUrl is required' } }, 400)

  // Build the models endpoint URL
  let modelsUrl = baseUrl.replace(/\/+$/, '')
  if (modelsUrl.endsWith('/v1')) {
    modelsUrl += '/models'
  } else if (!modelsUrl.endsWith('/models')) {
    modelsUrl += '/v1/models'
  }

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`

    const res = await fetch(modelsUrl, { headers, signal: AbortSignal.timeout(10000) })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return c.json({ error: { code: 'FETCH_FAILED', message: `Provider returned ${res.status}: ${text.slice(0, 200)}` } }, 422)
    }

    const data = await res.json() as any
    // OpenAI-compatible format: { data: [{ id: "model-id", ... }] }
    const models = (data.data || data.models || []).map((m: any) => {
      const entry: any = {
        id: m.id || m.name || '',
        name: m.name || m.id || '',
      }
      // Preserve extra fields that some providers include
      if (m.context_window != null) entry.contextWindow = m.context_window
      if (m.max_tokens != null) entry.maxTokens = m.max_tokens
      if (m.reasoning != null) entry.reasoning = m.reasoning
      if (m.modalities?.input) entry.input = m.modalities.input
      return entry
    }).filter((m: any) => m.id)

    return c.json({ models, url: modelsUrl })
  } catch (err) {
    return c.json({ error: { code: 'FETCH_ERROR', message: (err as Error).message } }, 422)
  }
})

// GET /api/settings/pi-models/catalog — read local catalog, refresh from models.dev if empty
settings.get('/pi-models/catalog', async (c) => {
  // Try local cache first
  let models = await readModelCatalog()
  let source = 'local'

  if (!models.length) {
    // Local file missing or empty — try fetching
    try {
      const result = await fetchAndCacheModelCatalog()
      models = result.models
      source = 'remote'
    } catch {
      return c.json({ models: [], total: 0, source: 'none', error: '本地无缓存且 models.dev 不可达' })
    }
  }

  return c.json({ models, total: models.length, source })
})

// POST /api/settings/pi-models/catalog/refresh — force re-fetch from models.dev
settings.post('/pi-models/catalog/refresh', async (c) => {
  try {
    const result = await fetchAndCacheModelCatalog()
    return c.json({ models: result.models, total: result.total, source: 'remote' })
  } catch (err) {
    return c.json({ error: { code: 'FETCH_ERROR', message: (err as Error).message } }, 422)
  }
})

export default settings
