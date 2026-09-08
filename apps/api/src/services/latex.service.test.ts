import assert from 'node:assert/strict'
import test from 'node:test'
import { parseSyncTexBackwardOutput, parseSyncTexForwardOutput } from './latex.service.js'

test('parses SyncTeX forward output into PDF coordinates', () => {
  const result = parseSyncTexForwardOutput(
    [
      'SyncTeX result begin',
      'Output:main.pdf',
      'Page:2',
      'x:123.4',
      'y:456.7',
      'h:110.2',
      'v:449.6',
      'W:320.5',
      'H:8.5',
      'SyncTeX result end',
    ].join('\n'),
    'main.tex',
    18,
    1,
  )

  assert.equal(result.direction, 'forward')
  assert.equal(result.file, 'main.tex')
  assert.equal(result.line, 18)
  assert.equal(result.page, 2)
  assert.equal(result.x, 123.4)
  assert.equal(result.y, 456.7)
  assert.equal(result.boxX, 110.2)
  assert.equal(result.boxY, 449.6 - 8.5)
  assert.equal(result.width, 320.5)
  assert.equal(result.height, 8.5)
  assert.deepEqual(result.rectangles, [
    { page: 2, x: 110.2, y: 449.6 - 8.5, width: 320.5, height: 8.5 },
  ])
})

test('keeps wrapped lines and page breaks, deduplicating enclosing boxes', () => {
  const record = (page: number, h: number, v: number, width: number, height: number) =>
    `Output:main.pdf\nPage:${page}\nx:${h}\ny:${v - 2}\nh:${h}\nv:${v}\nW:${width}\nH:${height}`
  const first = record(1, 72, 110, 320, 10)
  const result = parseSyncTexForwardOutput([
    'SyncTeX result begin',
    first,
    first,
    record(1, 72, 122, 320, 10),
    record(1, 72, 134, 125, 10),
    record(2, 72, 82, 180, 10),
    'SyncTeX result end',
  ].join('\n'), 'main.tex', 20, 1)

  assert.equal(result.page, 1)
  assert.equal(result.y, 108)
  assert.deepEqual(result.rectangles, [
    { page: 1, x: 72, y: 100, width: 320, height: 10 },
    { page: 1, x: 72, y: 112, width: 320, height: 10 },
    { page: 1, x: 72, y: 124, width: 125, height: 10 },
    { page: 2, x: 72, y: 72, width: 180, height: 10 },
  ])
})

test('normalizes signed widths and preserves tall formula boxes', () => {
  const result = parseSyncTexForwardOutput(
    'Page:1\nx:200\ny:210\nh:72\nv:240\nW:-320\nH:60', 'main.tex', 10, 1,
  )
  assert.deepEqual(result.rectangles, [{ page: 1, x: 72, y: 180, width: 320, height: 60 }])
})

test('does not borrow missing box fields from another record', () => {
  const result = parseSyncTexForwardOutput([
    'Page:1\nx:80\ny:100\nh:72\nv:102\nW:320',
    'Page:2\nx:80\ny:200\nh:72\nv:202\nW:320\nH:10',
  ].join('\n'), 'main.tex', 10, 1)
  assert.equal(result.page, 1)
  assert.equal(result.boxY, undefined)
  assert.deepEqual(result.rectangles, [{ page: 2, x: 72, y: 192, width: 320, height: 10 }])
})

test('keeps separate column boxes and handles CRLF output', () => {
  const result = parseSyncTexForwardOutput([
    'Page:1', 'x:72', 'y:110',
    'Page:1', 'h:72', 'v:110', 'W:180', 'H:10',
    'Page:1', 'h:300', 'v:110', 'W:180', 'H:10',
  ].join('\r\n'), 'main.tex', 10, 1)
  assert.equal(result.boxX, undefined)
  assert.deepEqual(result.rectangles, [
    { page: 1, x: 72, y: 100, width: 180, height: 10 },
    { page: 1, x: 300, y: 100, width: 180, height: 10 },
  ])
})

test('ignores invalid boxes without inventing a thin highlight', () => {
  for (const record of [
    'Page:0\nh:72\nv:100\nW:320\nH:10',
    'Page:1\nh:NaN\nv:100\nW:320\nH:10',
    'Page:1\nh:72\nv:Infinity\nW:320\nH:10',
    'Page:1\nh:72\nv:100\nW:0\nH:10',
    'Page:1\nh:72\nv:100\nW:320\nH:-1',
    'Page:1\nh:72\nv:100\nW:320\nH:0',
    'SyncTeX result begin\nSyncTeX result end',
  ]) {
    assert.deepEqual(parseSyncTexForwardOutput(record, 'main.tex', 10, 1).rectangles, [])
  }
})

test('maps SyncTeX backward input paths to workspace-relative paths', () => {
  const result = parseSyncTexBackwardOutput(
    [
      'SyncTeX result begin',
      'Input:/workspace/./chapters/method.tex',
      'Line:48',
      'Column:2',
      'SyncTeX result end',
    ].join('\n'),
    3,
    100,
    200,
    '/tmp/build/source',
  )

  assert.equal(result.direction, 'backward')
  assert.equal(result.file, 'chapters/method.tex')
  assert.equal(result.line, 48)
  assert.equal(result.column, 2)
})
