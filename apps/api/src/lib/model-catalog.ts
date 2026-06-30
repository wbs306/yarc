import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { config } from './config.js'

export type CatalogModel = {
  id: string
  name: string
  provider: string
  contextWindow: number
  maxTokens: number
  reasoning: boolean
  input: string[]
}

// Common Ollama / local-model aliases that models.dev doesn't cover.
// Merged into the catalog so enrichment works for local providers.
const OLLAMA_ALIASES: CatalogModel[] = [
  { id: 'llama3.3', name: 'Llama 3.3 70B', provider: 'ollama', contextWindow: 131072, maxTokens: 16384, reasoning: false, input: ['text'] },
  { id: 'llama3.2', name: 'Llama 3.2', provider: 'ollama', contextWindow: 131072, maxTokens: 8192, reasoning: false, input: ['text'] },
  { id: 'llama3.1', name: 'Llama 3.1', provider: 'ollama', contextWindow: 131072, maxTokens: 8192, reasoning: false, input: ['text'] },
  { id: 'llama3', name: 'Llama 3', provider: 'ollama', contextWindow: 8192, maxTokens: 8192, reasoning: false, input: ['text'] },
  { id: 'qwen2.5', name: 'Qwen 2.5', provider: 'ollama', contextWindow: 32768, maxTokens: 8192, reasoning: false, input: ['text'] },
  { id: 'qwen2.5-coder', name: 'Qwen 2.5 Coder', provider: 'ollama', contextWindow: 32768, maxTokens: 8192, reasoning: false, input: ['text'] },
  { id: 'qwen3', name: 'Qwen 3', provider: 'ollama', contextWindow: 32768, maxTokens: 8192, reasoning: true, input: ['text'] },
  { id: 'deepseek-r1', name: 'DeepSeek R1', provider: 'ollama', contextWindow: 65536, maxTokens: 16384, reasoning: true, input: ['text'] },
  { id: 'deepseek-v3', name: 'DeepSeek V3', provider: 'ollama', contextWindow: 65536, maxTokens: 8192, reasoning: false, input: ['text'] },
  { id: 'mistral', name: 'Mistral 7B', provider: 'ollama', contextWindow: 32768, maxTokens: 8192, reasoning: false, input: ['text'] },
  { id: 'mixtral', name: 'Mixtral 8x7B', provider: 'ollama', contextWindow: 32768, maxTokens: 8192, reasoning: false, input: ['text'] },
  { id: 'codellama', name: 'CodeLlama', provider: 'ollama', contextWindow: 16384, maxTokens: 8192, reasoning: false, input: ['text'] },
  { id: 'gemma2', name: 'Gemma 2', provider: 'ollama', contextWindow: 8192, maxTokens: 8192, reasoning: false, input: ['text'] },
  { id: 'gemma3', name: 'Gemma 3', provider: 'ollama', contextWindow: 131072, maxTokens: 8192, reasoning: false, input: ['text', 'image'] },
  { id: 'phi4', name: 'Phi 4', provider: 'ollama', contextWindow: 16384, maxTokens: 8192, reasoning: false, input: ['text'] },
  { id: 'command-r', name: 'Command R', provider: 'ollama', contextWindow: 128000, maxTokens: 8192, reasoning: false, input: ['text'] },
  { id: 'yi', name: 'Yi', provider: 'ollama', contextWindow: 4096, maxTokens: 4096, reasoning: false, input: ['text'] },
  { id: 'dolphin-mixtral', name: 'Dolphin Mixtral', provider: 'ollama', contextWindow: 32768, maxTokens: 8192, reasoning: false, input: ['text'] },
  { id: 'solar', name: 'Solar', provider: 'ollama', contextWindow: 4096, maxTokens: 4096, reasoning: false, input: ['text'] },
  { id: 'phi3', name: 'Phi 3', provider: 'ollama', contextWindow: 4096, maxTokens: 4096, reasoning: false, input: ['text'] },
  { id: 'tinyllama', name: 'TinyLlama', provider: 'ollama', contextWindow: 2048, maxTokens: 2048, reasoning: false, input: ['text'] },
  { id: 'vicuna', name: 'Vicuna', provider: 'ollama', contextWindow: 2048, maxTokens: 2048, reasoning: false, input: ['text'] },
]

const catalogPath = resolve(config.dataDir, 'model-catalog.json')

let _remoteCache: CatalogModel[] | null = null

/**
 * Read the local model catalog JSON file (remote models),
 * then merge in Ollama aliases.
 * Returns [] only if both sources are empty.
 */
export async function readModelCatalog(): Promise<CatalogModel[]> {
  if (!_remoteCache) {
    try {
      const raw = await readFile(catalogPath, 'utf-8')
      const parsed = JSON.parse(raw)
      _remoteCache = Array.isArray(parsed) ? parsed : (parsed.models || [])
    } catch {
      _remoteCache = []
    }
  }
  // Merge: remote first, then fill in Ollama aliases that don't already exist
  const result = [...(_remoteCache ?? [])]
  for (const alias of OLLAMA_ALIASES) {
    if (!result.some(m => m.id === alias.id)) result.push(alias)
  }
  return result
}

/**
 * Write the model catalog to the local JSON file and refresh the in-memory cache.
 */
export async function writeModelCatalog(models: CatalogModel[]): Promise<void> {
  await mkdir(dirname(catalogPath), { recursive: true })
  const data = { models, fetchedAt: new Date().toISOString() }
  await writeFile(catalogPath, JSON.stringify(data, null, 2) + '\n', 'utf-8')
  _remoteCache = models
}

/**
 * Fetch the latest catalog from models.dev, write to local file, and return the result.
 * Throws on network / parse failure.
 */
export async function fetchAndCacheModelCatalog(): Promise<{ models: CatalogModel[]; total: number }> {
  const res = await fetch('https://models.dev/models.json', {
    headers: { 'User-Agent': 'YARC/1.0' },
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) throw new Error(`models.dev returned ${res.status}`)

  const data = await res.json() as Record<string, any>
  const models: CatalogModel[] = Object.values(data).map((m: any) => ({
    id: m.id,
    name: m.name || m.id,
    provider: m.id?.split('/')[0] || '',
    reasoning: m.reasoning ?? false,
    input: (m.modalities?.input || ['text']).filter((i: string) => i === 'text' || i === 'image'),
    contextWindow: m.limit?.context || 128000,
    maxTokens: m.limit?.output || 16384,
  })).filter((m: any) => m.id)

  await writeModelCatalog(models)
  // Return merged result (remote + Ollama aliases) so the frontend gets the full set
  const merged = await readModelCatalog()
  return { models: merged, total: merged.length }
}

/**
 * Look up a model by id in the catalog.
 */
export async function lookupCatalogModel(id: string): Promise<CatalogModel | undefined> {
  const catalog = await readModelCatalog()
  const lower = id.toLowerCase()
  const stripped = lower.includes('/') ? lower.split('/').slice(1).join('/') : lower
  const normalized = stripped.replace(/:[\w.-]+$/, '')

  return catalog.find(c => {
    const cid = c.id.toLowerCase()
    return (
      cid === lower ||
      cid === stripped ||
      cid === normalized ||
      cid.endsWith('/' + stripped) ||
      cid.endsWith('/' + normalized) ||
      c.name?.toLowerCase() === lower ||
      c.name?.toLowerCase() === normalized
    )
  })
}
