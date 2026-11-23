import assert from 'node:assert/strict'
import test from 'node:test'
import { embedHtmlPreviewAssets, findHtmlPreviewAssets, resolveHtmlPreviewAssetPath } from './html-preview'

const entry = 'reports/gallery/index.html'

test('resolves URL-encoded local assets without crossing the project root', () => {
  assert.equal(resolveHtmlPreviewAssetPath(entry, './figures/one%20two.svg?rev=2'), 'reports/gallery/figures/one two.svg')
  assert.equal(resolveHtmlPreviewAssetPath(entry, '../../shared.css'), 'shared.css')
  for (const ref of [
    '../../../shared.css', '../../%2e%2e/shared.css', '../%2fhidden.svg', 'a%5cb.svg',
    '%00x.svg', 'invalid%xy.svg', '/pic.svg', '//host/pic.svg', 'https://host/a.css',
    'C:\\dir\\pic.svg', 'data:image/svg+xml;charset=utf-8,content', '../../.git/pic.svg',
    '../../.pi/pic.svg', '#anchor',
  ]) assert.equal(resolveHtmlPreviewAssetPath(entry, ref), null, ref)
})

test('identifies supported images and stylesheet attributes without treating HTML text as assets', () => {
  const source = `<!doctype html><html lang="zh"><head>
    <base href="https://elsewhere.test/">
    <LINK REL='stylesheet' href=main.css><link rel="icon" href="icon.png">
    <link rel="stylesheet" href="https://remote.test/main.css"></head><body>
    <!-- <img src="comment.svg"> -->
    <script>const html = '<img src="script.svg">'</script>
    <img SRC="./figures/chart.svg" src="ignored.svg" width="42">
    <img src='../picture.JPG'><img src='not-an-image.txt'>
    <a href="other.svg">link</a></body></html>`
  const assets = findHtmlPreviewAssets(source, entry)
  assert.deepEqual(assets.map(({ path, mime }) => [path, mime]), [
    ['reports/gallery/main.css', 'text/css'],
    ['reports/gallery/figures/chart.svg', 'image/svg+xml'],
    ['reports/picture.JPG', 'image/jpeg'],
  ])
  const { content, missing } = embedHtmlPreviewAssets(source, assets, new Map([
    ['reports/gallery/main.css', 'data:text/css;base64,AA=='],
    ['reports/gallery/figures/chart.svg', 'data:image/svg+xml;base64,AA=='],
  ]))
  assert.equal(missing, 1)
  assert.ok(content.includes('<html lang="zh">'))
  assert.ok(content.includes('href="data:text/css;base64,AA=="'))
  assert.ok(content.includes('SRC="data:image/svg+xml;base64,AA==" src="ignored.svg" width="42"'))
  assert.ok(content.includes("src='../picture.JPG'"))
  assert.ok(content.includes('<a href="other.svg">'))
})

test('limits growth when the same asset is referenced repeatedly', () => {
  const source = '<img src="chart.svg">'.repeat(8)
  const assets = findHtmlPreviewAssets(source, entry)
  const result = embedHtmlPreviewAssets(source, assets, new Map([
    ['reports/gallery/chart.svg', `data:image/svg+xml;base64,${'A'.repeat(4 * 1024 * 1024)}`],
  ]))
  assert.equal(result.missing, 4)
  assert.ok(result.content.length < 17 * 1024 * 1024)
})
