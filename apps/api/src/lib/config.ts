import 'dotenv/config'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Resolve to project-root/data so paths work regardless of CWD
// (e.g. when running via pnpm --filter @yarc/api from apps/api/).
const defaultDataDir = resolve(__dirname, '../../../..', 'data')

const dataDir = process.env.DATA_DIR || defaultDataDir

export const config = {
  port: parseInt(process.env.PORT || '3000'),
  databaseUrl: process.env.DATABASE_URL || 'postgresql://yarc:yarc@localhost:5432/yarc',
  jwtSecret: process.env.JWT_SECRET || 'dev-secret',
  passwordHash: process.env.PASSWORD_HASH || '',
  nodeEnv: process.env.NODE_ENV || 'development',
  dataDir,
  filesDir: process.env.FILES_DIR || dataDir,
  papersDir: process.env.PAPERS_DIR || resolve(dataDir, 'papers'),
  mineruApiUrl: process.env.MINERU_API_URL || 'http://localhost:8000',
  embeddingApiUrl: process.env.EMBEDDING_API_URL || 'http://localhost:15263/v1/embeddings',
  embeddingModel: process.env.EMBEDDING_MODEL || 'Qwen3-Embedding-8B',
  embeddingDimensions: parseInt(process.env.EMBEDDING_DIMENSIONS || '1536'),
  piCliCommand: process.env.PI_CLI_COMMAND || 'pi',
  piChatTimeoutMs: parseInt(process.env.PI_CHAT_TIMEOUT_MS || '120000'),
  // Timeout for AI summary generation (longer than chat, as it processes
  // the full paper text)
  summaryTimeoutMs: parseInt(process.env.SUMMARY_TIMEOUT_MS || '300000'),
  // Tools exposed to Pi for web chat. Default 'all' lets Pi use its own
  // config (including skill tools). Set PI_CHAT_TOOLS=none to disable all,
  // or comma-separated tool names to restrict to a specific set.
  piChatTools: process.env.PI_CHAT_TOOLS || 'all',
  piRuntimeIdleTtlMs: parseInt(process.env.PI_RUNTIME_IDLE_TTL_MS || '900000'),
  piRuntimeMaxActive: parseInt(process.env.PI_RUNTIME_MAX_ACTIVE || '12'),
  piRuntimeStartTimeoutMs: parseInt(process.env.PI_RUNTIME_START_TIMEOUT_MS || '30000'),
  piRuntimeJournalRetentionMs: parseInt(process.env.PI_RUNTIME_JOURNAL_RETENTION_MS || '86400000'),
  piExtensionUiTimeoutMs: parseInt(process.env.PI_EXTENSION_UI_TIMEOUT_MS || '300000'),
  piSessionDurability: process.env.PI_SESSION_DURABILITY === 'normal' ? 'normal' : 'strict',
  maxFileSize: 50 * 1024 * 1024, // 50MB
  pdfCacheDays: parseInt(process.env.PDF_CACHE_DAYS || '2'),
  cors: {
    origin: process.env.CORS_ORIGIN || 'http://localhost:3000',
  },
  // IEEE Xplore API key (get from https://developer.ieee.org/)
  ieeeApiKey: process.env.IEEE_API_KEY || '',
  // Semantic Scholar API key (optional, improves rate limits)
  semanticScholarApiKey: process.env.SEMANTIC_SCHOLAR_API_KEY || '',
}
