import { prisma } from '@yarc/db'
import { config } from './config.js'

export function toVectorLiteral(values: number[], expectedDimensions = config.embeddingDimensions): string {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('Embedding vector is empty')
  }

  if (expectedDimensions > 0 && values.length !== expectedDimensions) {
    throw new Error(`Embedding dimension mismatch: expected ${expectedDimensions}, got ${values.length}`)
  }

  for (const value of values) {
    if (!Number.isFinite(value)) {
      throw new Error('Embedding vector contains non-finite values')
    }
  }

  return `[${values.join(',')}]`
}

export async function insertPaperChunkWithEmbedding(params: {
  paperId: string
  content: string
  pageNumber?: number | null
  chunkIndex: number
  embedding: number[]
}): Promise<void> {
  const vectorLiteral = toVectorLiteral(params.embedding)

  await prisma.$executeRaw`
    INSERT INTO paper_chunks (
      paper_id,
      content,
      page_number,
      chunk_index,
      embedding
    )
    VALUES (
      ${params.paperId}::uuid,
      ${params.content},
      ${params.pageNumber ?? null},
      ${params.chunkIndex},
      ${vectorLiteral}::vector
    )
  `
}
