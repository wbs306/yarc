import assert from 'node:assert/strict'
import test from 'node:test'
import {
  linkifyWorkspaceFileReferences,
  normalizeFileReferencePath,
  normalizeProjectSharedFileReferencePath,
  normalizeWorkspaceFileReferencePath,
  parseMarkdownFileReferenceHref,
  parseWorkspaceFileReferenceHref,
} from './workspace-file-reference'

test('normalizes local workspace references and rejects ordinary traversal', () => {
  assert.equal(normalizeWorkspaceFileReferencePath('./src/./main.ts'), 'src/main.ts')
  assert.equal(normalizeWorkspaceFileReferencePath('../main.ts'), null)
  assert.equal(normalizeWorkspaceFileReferencePath('src/../main.ts'), null)
  assert.equal(normalizeWorkspaceFileReferencePath(''), null)
})

test('accepts only the project shared-data reference form', () => {
  assert.equal(normalizeProjectSharedFileReferencePath('../../notes/plan.md'), '../../notes/plan.md')
  assert.equal(normalizeFileReferencePath('../../notes/plan.md'), '../../notes/plan.md')
  assert.equal(normalizeProjectSharedFileReferencePath('../notes/plan.md'), null)
  assert.equal(normalizeProjectSharedFileReferencePath('../../../notes/plan.md'), null)
  assert.equal(normalizeProjectSharedFileReferencePath('../../notes/../plan.md'), null)
  assert.equal(normalizeProjectSharedFileReferencePath('../../papers/paper.pdf'), null)
  assert.equal(normalizeProjectSharedFileReferencePath('../../.hidden/plan.md'), null)
})

test('linkifies and parses shared-data references without changing their scope marker', () => {
  const markdown = linkifyWorkspaceFileReferences('See [FILE:../../notes/plan.md].')
  assert.match(markdown, /#workspace-file=\.\.%2F\.\.%2Fnotes%2Fplan\.md/)
  assert.equal(parseWorkspaceFileReferenceHref('#workspace-file=..%2F..%2Fnotes%2Fplan.md'), '../../notes/plan.md')
})

test('preserves safe absolute paths and recognizes file-like Markdown links', () => {
  assert.equal(normalizeFileReferencePath('/home/wbs/data/notes/plan.md'), '/home/wbs/data/notes/plan.md')
  assert.equal(normalizeFileReferencePath('C:\\data\\notes\\plan.md'), 'C:/data/notes/plan.md')
  assert.equal(parseMarkdownFileReferenceHref('notes/plan.md#section'), 'notes/plan.md')
  assert.equal(parseMarkdownFileReferenceHref('file:///home/wbs/data/notes/plan.md'), '/home/wbs/data/notes/plan.md')
  assert.equal(parseMarkdownFileReferenceHref('https://example.com/notes/plan.md'), null)
  assert.equal(parseMarkdownFileReferenceHref('#notes'), null)
})
