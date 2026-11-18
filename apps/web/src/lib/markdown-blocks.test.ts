import assert from 'node:assert/strict'
import test from 'node:test'
import { renderMarkdownBlocks, renderMarkdownWithSourceMap } from './markdown'

const samples = [
  '# 标题\n\n中文**加粗，**文字 $x+1$。\n\n$$\nx^2\n$$\n',
  '- item\n  - nested $y$\n\n> quote\n>\n> $$\n> x+1\n> $$\n',
  'paragraph\n\n```ts\nconst x = 1\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |\n',
  '[reference][link]\n\n[link]: https://example.com\n',
  '<div>\n\nHTML content\n\n</div>\n',
  '<span>inline HTML\n\nacross paragraphs</span>\n',
  '| a | b |\n| - | - |\n| <span>x</span> | y |\n',
  '> nested **<i>HTML</i>**\n\n- <b>item</b>\n',
  '---\n\n## Heading\n\n![image](https://example.com/image.png)\n',
]

for (const [index, sample] of samples.entries()) {
  test(`block rendering preserves full-render HTML and source lines (${index})`, () => {
    assert.equal(renderMarkdownBlocks(sample).map(block => block.html).join(''), renderMarkdownWithSourceMap(sample))
  })
}

test('ordinary edits reuse unaffected block objects/keys and rendered formulas', () => {
  const before = renderMarkdownBlocks('# Title\n\nparagraph\n\n$$\nx+1\n$$\n')
  const after = renderMarkdownBlocks('# Title\n\nparagraph edited\n\n$$\nx+1\n$$\n', before)
  assert.equal(after[0].key, before[0].key)
  assert.equal(after[2].key, before[2].key)
  assert.equal(after[2].html, before[2].html)
  assert.notEqual(after[1].key, before[1].key)
})

test('newline insertion shifts cached nested source mappings without changing identities', () => {
  const source = '# Title\n\n- first\n- second\n\n$$\nx+1\n$$\n'
  const before = renderMarkdownBlocks(source)
  const after = renderMarkdownBlocks('\n\n' + source, before)
  assert.deepEqual(after.map(block => block.key), before.map(block => block.key))
  assert.equal(after.map(block => block.html).join(''), renderMarkdownWithSourceMap('\n\n' + source))
})

test('reference definition changes invalidate rendered links; duplicate blocks keep unique keys', () => {
  const source = '[reference][link]\n\nsame\n\nsame\n\n[link]: https://example.com/old\n'
  const before = renderMarkdownBlocks(source)
  assert.equal(new Set(before.map(block => block.key)).size, before.length)
  const after = renderMarkdownBlocks(source.replace('/old', '/new'), before)
  assert.match(after[0].html, /example.com\/new/)
  assert.equal(after.map(block => block.html).join(''), renderMarkdownWithSourceMap(source.replace('/old', '/new')))
  assert.deepEqual(renderMarkdownBlocks('', after), [])
})
