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
  assert.equal(result.width, 320.5)
  assert.equal(result.height, 8.5)
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
