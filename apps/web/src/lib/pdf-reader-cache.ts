export interface CachedPdfReader {
  key: string
  documentId: string
  sourceUrl: string
  title: string
}

// Only readers actually visited are mounted. Reuse their identity until the
// underlying file changes, the tab closes, or the bounded cache evicts it.
export function retainPdfReader(
  previous: CachedPdfReader[],
  current: CachedPdfReader | null,
  openKeys: ReadonlySet<string>,
  limit: number,
): CachedPdfReader[] {
  const kept = previous.filter(reader => openKeys.has(reader.key))
  if (!current || !openKeys.has(current.key)) return kept
  const existing = kept.find(reader => reader.key === current.key)
  const reader = existing?.documentId === current.documentId && existing.sourceUrl === current.sourceUrl
    ? (existing.title === current.title ? existing : { ...existing, title: current.title })
    : current
  return [...kept.filter(item => item.key !== current.key), reader].slice(-limit)
}

export const missingTemporaryReaderMessage =
  '临时阅读会话已失效，论文文件可能已被清理。请从搜索结果或原始链接重新打开；需要长期保留的论文请导入文献库。'
