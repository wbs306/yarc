import assert from 'node:assert/strict'
import test from 'node:test'
import { createLatexBuildApi } from './useApi'

test('background build APIs retain project/global scope across route changes', async (t) => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const location = { pathname: '/projects/project-a' }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location } })
  t.after(() => {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  })
  const calls: { url: string; method: string }[] = []
  t.mock.method(globalThis, 'fetch', async (url: string, options?: RequestInit) => {
    calls.push({ url, method: options?.method || 'GET' })
    return new Response(JSON.stringify({ build: { id: 'build-1' }, log: '', diagnostics: [] }), {
      headers: { 'Content-Type': 'application/json' },
    })
  })
  const project = createLatexBuildApi('project-a')
  const global = createLatexBuildApi(null)
  location.pathname = '/projects/project-b'
  await project.getLatexBuild('build-1')
  await project.getLatexBuildLog('build-1')
  await project.getLatexSyncTex('build-1', { direction: 'forward', file: 'main.tex' })
  await project.cancelLatexBuild('build-1')
  await global.getLatexBuild('build-2')
  assert.ok(calls.slice(0, 4).every(call => call.url.startsWith('/api/projects/project-a/latex/builds/')))
  assert.equal(calls[4].url, '/api/latex/builds/build-2')
  assert.ok(project.getLatexPdfUrl('build-1').startsWith('/api/projects/project-a/latex/builds/'))
  assert.equal(global.getLatexPdfUrl('build-2'), '/api/latex/builds/build-2/pdf')
  assert.equal(calls.filter(call => call.method === 'POST').length, 1) // Explicit cancellation only.
  await project.compileLatex('main.tex', 'xelatex', 'target-1')
  assert.equal(calls.at(-1)?.url, '/api/projects/project-a/latex/builds')
  assert.equal(calls.at(-1)?.method, 'POST')
})
