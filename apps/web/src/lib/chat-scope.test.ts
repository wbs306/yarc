import assert from 'node:assert/strict'
import test from 'node:test'
import { isPublicSharedFilePath, scopeChatResource } from './chat-scope'

test('library papers are available to every chat scope', () => {
  const paper = { type: 'paper' as const, paperId: 'p1', title: 'Paper' }
  assert.deepEqual(scopeChatResource(paper, null, null), { resource: paper, notice: '' })
  assert.deepEqual(scopeChatResource(paper, null, 'project-a'), { resource: paper, notice: '' })
})

test('files keep their path when chat and file share a workspace', () => {
  const file = { type: 'file' as const, path: 'notes/a.md', name: 'a.md' }
  assert.deepEqual(scopeChatResource(file, null, null), { resource: file, notice: '' })
  assert.deepEqual(scopeChatResource(file, 'project-a', 'project-a'), { resource: file, notice: '' })
})

test('project chats reference public global files through ../../', () => {
  const file = { type: 'file' as const, path: 'temporary-pdfs/x/content.md', name: 'x.md' }
  assert.deepEqual(scopeChatResource(file, null, 'project-a'), {
    resource: { ...file, path: '../../temporary-pdfs/x/content.md' },
    notice: '',
  })
})

test('protected global files and other workspaces are rejected with a notice', () => {
  const protectedFile = { type: 'file' as const, path: 'papers/p1/full.md' }
  assert.equal(scopeChatResource(protectedFile, null, 'project-a').resource, null)

  const projectFile = { type: 'file' as const, path: 'main.tex' }
  const fromGlobal = scopeChatResource(projectFile, 'project-a', null)
  assert.equal(fromGlobal.resource, null)
  assert.match(fromGlobal.notice, /切换到该项目/)

  const fromOtherProject = scopeChatResource(projectFile, 'project-a', 'project-b')
  assert.equal(fromOtherProject.resource, null)
  assert.match(fromOtherProject.notice, /其他科研项目/)
})

test('public shared paths exclude protected roots, hidden segments and traversal', () => {
  assert.equal(isPublicSharedFilePath('notes/a.md'), true)
  assert.equal(isPublicSharedFilePath('.env.example'), true)
  assert.equal(isPublicSharedFilePath('projects/x/main.tex'), false)
  assert.equal(isPublicSharedFilePath('.pi/agent/auth.json'), false)
  assert.equal(isPublicSharedFilePath('notes/.secret'), false)
  assert.equal(isPublicSharedFilePath('notes/../papers/a.md'), false)
  assert.equal(isPublicSharedFilePath(''), false)
})
