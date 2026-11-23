import assert from 'node:assert/strict'
import test from 'node:test'
import { retainPdfReader, type CachedPdfReader } from './pdf-reader-cache'

const reader = (scope: string, path = 'paper.pdf', version = '1'): CachedPdfReader => ({
  key: JSON.stringify([scope, path]),
  documentId: JSON.stringify([scope, path, version]),
  sourceUrl: `/api/${scope}/download?path=${encodeURIComponent(path)}&v=${version}`,
  title: path,
})

test('PDF to text to PDF retains the reader and its document identity', () => {
  const pdf = reader('global')
  const open = new Set([pdf.key])
  const opened = retainPdfReader([], pdf, open, 8)
  const background = retainPdfReader(opened, null, open, 8)
  const reopened = retainPdfReader(background, { ...pdf }, open, 8)
  assert.equal(reopened[0], pdf)
  assert.equal(reopened[0].documentId, opened[0].documentId)
})

test('same paths in two projects and global files keep independent readers', () => {
  const files = [reader('global'), reader('project-a'), reader('project-b')]
  const open = new Set(files.map(file => file.key))
  let cache: CachedPdfReader[] = []
  for (const file of files) cache = retainPdfReader(cache, file, open, 8)
  cache = retainPdfReader(cache, files[0], open, 8)
  assert.equal(cache.length, 3)
  assert.equal(new Set(cache.map(file => file.documentId)).size, 3)
  assert.equal(cache[2], files[0])
})

test('a changed file version replaces only its own document', () => {
  const first = reader('project-a')
  const second = reader('project-b')
  const changed = reader('project-a', 'paper.pdf', '2')
  const cache = retainPdfReader([first, second], changed, new Set([first.key, second.key]), 8)
  assert.deepEqual(cache, [second, changed])
  assert.notEqual(changed.documentId, first.documentId)
})

test('closing or deleting a tab disposes its reader without reopening it', () => {
  const first = reader('global')
  const second = reader('project-a')
  const cache = retainPdfReader([first, second], first, new Set([second.key]), 8)
  assert.deepEqual(cache, [second])
})

test('cache is bounded and evicts the least recently visited reader', () => {
  const first = reader('global', 'first.pdf')
  const second = reader('global', 'second.pdf')
  const third = reader('global', 'third.pdf')
  const open = new Set([first.key, second.key, third.key])
  const revisited = retainPdfReader([first, second], first, open, 2)
  assert.deepEqual(retainPdfReader(revisited, third, open, 2), [first, third])
})
