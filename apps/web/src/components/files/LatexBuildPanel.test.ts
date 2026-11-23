import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRenderer, h, nextTick, ref, type Component } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import ts from 'typescript'
import type { createLatexBuildApi } from '@/composables/useApi'

type BuildApi = ReturnType<typeof createLatexBuildApi>
interface Node {
  type: string
  text: string
  children: Node[]
  parent: Node | null
}
const node = (type: string, text = ''): Node => ({ type, text, children: [], parent: null })
const flush = async () => {
  for (let index = 0; index < 12; index++) await Promise.resolve()
  await nextTick()
}

// Compile the actual SFC, stubbing only its PDF engine and default network API.
// A Vue custom renderer exercises mounting/polling without a browser or Docker.
async function loadPanel(t: { after: (callback: () => Promise<void>) => void }): Promise<Component> {
  const filename = new URL('./LatexBuildPanel.vue', import.meta.url)
  let source = await readFile(filename, 'utf8')
  source = source.replace("import { createLatexBuildApi } from '@/composables/useApi'",
    "const createLatexBuildApi = () => { throw new Error('Use the mock build API') }")
    .replace("import PdfViewer from '@/components/pdf/PdfViewer.vue'",
      "import { h as stubH } from 'vue'\nconst PdfViewer = { render: () => stubH('pdf-stub') }")
  const { descriptor } = parse(source, { filename: filename.pathname })
  const script = compileScript(descriptor, { id: 'latex-panel-test', inlineTemplate: true })
  const content = ts.transpileModule(script.content, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText.replace(/from (["'])vue\1/g, `from ${JSON.stringify(import.meta.resolve('vue'))}`)
  const directory = await mkdtemp(join(tmpdir(), 'yarc-latex-panel-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const output = join(directory, 'panel.mjs')
  await writeFile(output, content)
  return (await import(pathToFileURL(output).href)).default
}

function mountPanel(component: Component, api: BuildApi, active = ref(true), resumeBuildId = 'existing-build') {
  const panel = ref<{ startBuild: () => Promise<void> } | null>(null)
  let pdfMounts = 0
  const renderer = createRenderer<Node, Node>({
    patchProp() {},
    createElement: type => { if (type === 'pdf-stub') pdfMounts++; return node(type) },
    createText: text => node('#text', text),
    createComment: text => node('#comment', text),
    setText: (element, text) => { element.text = text },
    setElementText: (element, text) => { element.text = text; element.children = [] },
    parentNode: element => element.parent,
    nextSibling: element => element.parent?.children[element.parent.children.indexOf(element) + 1] || null,
    insert(element, parent, anchor) {
      if (element.parent) element.parent.children.splice(element.parent.children.indexOf(element), 1)
      element.parent = parent
      const index = anchor ? parent.children.indexOf(anchor) : -1
      if (index < 0) parent.children.push(element)
      else parent.children.splice(index, 0, element)
    },
    remove(element) {
      if (element.parent) element.parent.children.splice(element.parent.children.indexOf(element), 1)
      element.parent = null
    },
  })
  const root = node('root')
  const app = renderer.createApp({
    setup: () => () => h(component, {
      ref: panel, path: 'main.tex', name: 'main.tex', resumeBuildId, active: active.value, buildApi: api,
    }),
  })
  app.mount(root)
  return { app, root, panel, pdfMounts: () => pdfMounts }
}

const completed = {
  id: 'existing-build', path: 'main.tex', engine: 'xelatex' as const,
  status: 'completed' as const, createdAt: '2026-01-01T00:00:00Z',
  pdfAvailable: true, synctexAvailable: false, diagnostics: [],
}
const apiMock = () => {
  const calls = { compile: 0, get: 0, sync: 0 }
  const api: BuildApi = {
    compileLatex: async () => { calls.compile++; return { build: completed } },
    getLatexBuild: async () => { calls.get++; return { build: completed } },
    getLatexBuildLog: async () => ({ id: completed.id, log: '', diagnostics: [] }),
    cancelLatexBuild: async () => ({ build: completed }),
    getLatexPdfUrl: () => '/mock/existing-build.pdf',
    getLatexSyncTex: async () => { calls.sync++; throw new Error('Unexpected automatic SyncTeX request') },
  }
  return { api, calls }
}

const text = (element: Node): string => element.text + element.children.map(text).join(' ')

test('refresh reattaches to an existing PDF without recompiling or auto-jumping', async (t) => {
  const component = await loadPanel(t)
  const { api, calls } = apiMock()
  const active = ref(true)
  const mounted = mountPanel(component, api, active)
  t.after(() => mounted.app.unmount())
  await flush()
  assert.equal(calls.compile, 0)
  assert.equal(calls.get, 1)
  assert.equal(calls.sync, 0)
  assert.equal(mounted.pdfMounts(), 1)
  active.value = false
  await flush()
  active.value = true
  await flush()
  assert.equal(calls.get, 1)
  assert.equal(mounted.pdfMounts(), 1)
})

test('a resumed running build keeps polling in the background and displays its PDF', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const component = await loadPanel(t)
  const { api, calls } = apiMock()
  api.getLatexBuild = async () => {
    calls.get++
    return { build: calls.get === 1 ? { ...completed, status: 'running', pdfAvailable: false } : completed }
  }
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { setTimeout, clearTimeout } })
  const mounted = mountPanel(component, api, ref(false))
  t.after(() => {
    mounted.app.unmount()
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  })
  await flush()
  assert.equal(mounted.pdfMounts(), 0)
  t.mock.timers.tick(700)
  await flush()
  assert.equal(calls.get, 2)
  assert.equal(calls.compile, 0)
  assert.equal(mounted.pdfMounts(), 1)
})

test('a new compilation finishes in the background and reuses its PDF on return', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const component = await loadPanel(t)
  const { api, calls } = apiMock()
  api.compileLatex = async () => {
    calls.compile++
    return { build: { ...completed, status: 'queued', pdfAvailable: false } }
  }
  api.getLatexBuild = async () => {
    calls.get++
    return { build: calls.get === 1
      ? { ...completed, status: 'running', pdfAvailable: false }
      : { ...completed, synctexAvailable: true } }
  }
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { setTimeout, clearTimeout } })
  const active = ref(true)
  const mounted = mountPanel(component, api, active, '')
  t.after(() => {
    mounted.app.unmount()
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  })
  await mounted.panel.value!.startBuild()
  assert.equal(calls.compile, 1)
  active.value = false
  await flush()
  t.mock.timers.tick(700)
  await flush()
  assert.equal(mounted.pdfMounts(), 1)
  assert.equal(calls.sync, 0)
  active.value = true
  await flush()
  assert.equal(mounted.pdfMounts(), 1)
  assert.equal(calls.get, 2)
  assert.equal(calls.compile, 1)
})

test('an expired build shows recovery guidance without automatically compiling', async (t) => {
  const component = await loadPanel(t)
  const { api, calls } = apiMock()
  api.getLatexBuild = async () => { throw new Error('LaTeX build not found') }
  const mounted = mountPanel(component, api)
  t.after(() => mounted.app.unmount())
  await flush()
  assert.match(text(mounted.root), /无法恢复上次编译结果/)
  assert.match(text(mounted.root), /未自动重新编译/)
  assert.equal(calls.compile, 0)
  assert.equal(mounted.pdfMounts(), 0)
})
