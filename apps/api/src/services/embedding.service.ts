import { config } from '../lib/config.js'
import { AppError } from '../lib/errors.js'

interface EmbeddingResponse {
  data: Array<{ embedding: number[] }>
}

export class EmbeddingService {
  async generate(text: string): Promise<number[]> {
    const res = await fetch(config.embeddingApiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.embeddingModel,
        input: text,
        dimensions: config.embeddingDimensions,
      }),
    })

    if (!res.ok) {
      const body = await res.text()
      throw new AppError('EMBEDDING_ERROR', `Embedding API error: ${res.status} ${body}`, 502)
    }

    const data: EmbeddingResponse = await res.json()
    if (!data.data?.[0]?.embedding) {
      throw new AppError('EMBEDDING_ERROR', 'No embedding returned', 502)
    }

    const emb = data.data[0].embedding
    // MRL 截断: 只取前 N 维
    return config.embeddingDimensions > 0 && emb.length > config.embeddingDimensions
      ? emb.slice(0, config.embeddingDimensions)
      : emb
  }

  async generateBatch(texts: string[]): Promise<number[][]> {
    const res = await fetch(config.embeddingApiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.embeddingModel,
        input: texts,
        dimensions: config.embeddingDimensions,
      }),
    })

    if (!res.ok) {
      throw new AppError('EMBEDDING_ERROR', `Embedding API error: ${res.status}`, 502)
    }

    const data: EmbeddingResponse = await res.json()
    return data.data.map((d) => d.embedding)
  }
}

export const embeddingService = new EmbeddingService()
