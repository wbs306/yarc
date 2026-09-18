import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { formatPathRelativeToWorkspace } from './agent-file-path.js'

describe('formatPathRelativeToWorkspace', () => {
  const dataDir = '/srv/yarc/data'

  it('keeps paths relative to the global data workspace', () => {
    assert.equal(
      formatPathRelativeToWorkspace('temporary-pdfs/abc/content.md', dataDir, dataDir),
      'temporary-pdfs/abc/content.md',
    )
  })

  it('points project agents at the shared temporary PDF directory', () => {
    assert.equal(
      formatPathRelativeToWorkspace('temporary-pdfs/abc/content.md', `${dataDir}/projects/demo`, dataDir),
      '../../temporary-pdfs/abc/content.md',
    )
  })

  it('normalizes path separators for the agent tool', () => {
    assert.equal(
      formatPathRelativeToWorkspace('temporary-pdfs\\abc\\content.md', `${dataDir}/projects/demo`, dataDir),
      '../../temporary-pdfs/abc/content.md',
    )
  })
})
