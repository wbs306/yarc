export function parseVectorLiteral(vec: number[]): string {
  return `[${vec.join(',')}]`
}

export function chunkText(text: string, maxChunkSize = 1000, overlap = 200): string[] {
  const chunks: string[] = []
  const stepBack = Math.max(0, Math.min(overlap, maxChunkSize - 1))
  let start = 0
  while (start < text.length) {
    const end = Math.min(start + maxChunkSize, text.length)
    chunks.push(text.slice(start, end))
    if (end >= text.length) break
    start = end - stepBack
  }
  return chunks
}
