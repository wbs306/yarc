import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { FileNode } from '@yarc/shared'
import { FileService } from './file.service.js'

let testRoot = ''

const findNode = (nodes: FileNode[], path: string) => nodes.find(node => node.path === path)

before(async () => {
  testRoot = await mkdtemp(join(tmpdir(), 'yarc-file-service-test-'))
  await mkdir(join(testRoot, 'small', 'nested'), { recursive: true })
  await writeFile(join(testRoot, 'root.md'), '# root\n')
  await writeFile(join(testRoot, 'small', 'note.md'), '# note\n')
  await writeFile(join(testRoot, 'small', 'nested', 'deep.txt'), 'deep\n')

  await mkdir(join(testRoot, 'large', 'one'), { recursive: true })
  await mkdir(join(testRoot, 'large', 'two'), { recursive: true })
  await mkdir(join(testRoot, 'large', 'three'), { recursive: true })
  await writeFile(join(testRoot, 'large', 'one', 'a.txt'), 'a\n')
  await writeFile(join(testRoot, 'large', 'two', 'b.txt'), 'b\n')
  await writeFile(join(testRoot, 'large', 'three', 'c.txt'), 'c\n')

  await mkdir(join(testRoot, '.git'), { recursive: true })
  await mkdir(join(testRoot, '.venv'), { recursive: true })
  await mkdir(join(testRoot, 'node_modules', 'pkg'), { recursive: true })
  await writeFile(join(testRoot, '.git', 'config'), '[core]\n')
  await writeFile(join(testRoot, '.venv', 'ignored.py'), 'pass\n')
  await writeFile(join(testRoot, 'node_modules', 'pkg', 'ignored.js'), 'module.exports = {}\n')
})

after(async () => {
  await rm(testRoot, { recursive: true, force: true })
})

describe('FileService adaptive file tree', () => {
  it('returns a complete recursive tree when the visible subtree is below the limit', async () => {
    const service = new FileService({ rootDir: testRoot, eagerTreeLimit: 20 })
    const tree = await service.getFileTree('small')

    const nested = findNode(tree, 'small/nested')
    assert.equal(nested?.type, 'directory')
    assert.deepEqual(nested?.children?.map(node => node.path), ['small/nested/deep.txt'])
    assert.equal(findNode(tree, 'small/note.md')?.type, 'file')
  })

  it('falls back to shallow directory nodes when the subtree exceeds the limit', async () => {
    const service = new FileService({ rootDir: testRoot, eagerTreeLimit: 3 })
    const tree = await service.getFileTree('large')

    assert.deepEqual(tree.map(node => node.path), ['large/one', 'large/three', 'large/two'])
    assert.ok(tree.every(node => node.type === 'directory' && node.children === undefined))
  })

  it('indexes nested files while excluding generated dependency and virtualenv folders', async () => {
    const service = new FileService({ rootDir: testRoot, eagerTreeLimit: 3 })
    const files = await service.getFileIndex()

    assert.ok(files.includes('small/nested/deep.txt'))
    assert.ok(files.includes('large/three/c.txt'))
    assert.ok(!files.some(path => path.startsWith('.git/')))
    assert.ok(!files.some(path => path.startsWith('.venv/')))
    assert.ok(!files.some(path => path.startsWith('node_modules/')))
  })
})
