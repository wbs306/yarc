<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { EditorState, EditorSelection, Compartment } from '@codemirror/state'
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, dropCursor } from '@codemirror/view'
import * as Y from 'yjs'
import { yCollab } from 'y-codemirror.next'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { search, searchKeymap, openSearchPanel } from '@codemirror/search'
import { bracketMatching, foldGutter, indentOnInput, indentUnit, HighlightStyle, syntaxHighlighting, LanguageDescription } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { xml } from '@codemirror/lang-xml'
import { yaml } from '@codemirror/lang-yaml'
import { sql } from '@codemirror/lang-sql'
import { vue } from '@codemirror/lang-vue'

const props = withDefaults(defineProps<{
  modelValue: string
  language?: string
  readonly?: boolean
  fontSize?: number
  tabSize?: number
  lineWrap?: boolean
  lineNumbers?: boolean
  collabYText?: Y.Text | null
}>(), {
  language: 'plaintext',
  readonly: false,
  fontSize: 13,
  tabSize: 2,
  lineWrap: true,
  lineNumbers: true,
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
  save: []
}>()

// Cursor position and selection size for the status bar. Doc-level counts are
// derived from modelValue by the parent, so only view-local state lives here.
const cursorLine = ref(1)
const cursorColumn = ref(1)
const selectedChars = ref(0)
const selectedWords = ref(0)

const host = ref<HTMLDivElement>()
const minimap = ref<HTMLDivElement>()
const minimapCanvas = ref<HTMLCanvasElement>()
const view = shallowRef<EditorView>()
const minimapViewportStyle = ref<Record<string, string>>({ top: '0px', height: '100%' })

const languageConf = new Compartment()
const editableConf = new Compartment()
const fontConf = new Compartment()
const tabConf = new Compartment()
const wrapConf = new Compartment()
const gutterConf = new Compartment()
const collabConf = new Compartment()

const fontTheme = (size: number) => EditorView.theme({ '&': { fontSize: `${size}px` } })
const tabExtension = (n: number) => [EditorState.tabSize.of(n), indentUnit.of(' '.repeat(n))]
const gutterExtension = (on: boolean) => (on ? [lineNumbers(), highlightActiveLineGutter(), foldGutter()] : [])
const surroundPairs: Record<string, readonly [string, string]> = {
  "'": ["'", "'"],
  '"': ['"', '"'],
  '`': ['`', '`'],
  '(': ['(', ')'],
  ')': ['(', ')'],
  '[': ['[', ']'],
  ']': ['[', ']'],
  '{': ['{', '}'],
  '}': ['{', '}'],
  '<': ['<', '>'],
  '>': ['<', '>'],
}

// Reuse the already-installed language packs to highlight fenced code blocks in markdown.
const mdCodeLanguages = [
  LanguageDescription.of({ name: 'javascript', alias: ['js', 'jsx'], load: async () => javascript({ jsx: true }) }),
  LanguageDescription.of({ name: 'typescript', alias: ['ts', 'tsx'], load: async () => javascript({ typescript: true, jsx: true }) }),
  LanguageDescription.of({ name: 'json', load: async () => json() }),
  LanguageDescription.of({ name: 'python', alias: ['py'], load: async () => python() }),
  LanguageDescription.of({ name: 'css', alias: ['scss'], load: async () => css() }),
  LanguageDescription.of({ name: 'html', load: async () => html() }),
  LanguageDescription.of({ name: 'xml', load: async () => xml() }),
  LanguageDescription.of({ name: 'yaml', alias: ['yml'], load: async () => yaml() }),
  LanguageDescription.of({ name: 'sql', load: async () => sql() }),
  LanguageDescription.of({ name: 'vue', load: async () => vue() }),
]

function languageExtension(lang: string) {
  switch (lang) {
    case 'typescript': return javascript({ typescript: true, jsx: true })
    case 'javascript': return javascript({ jsx: true })
    case 'vue': return vue()
    case 'json': return json()
    case 'markdown': return markdown({ codeLanguages: mdCodeLanguages })
    case 'python': return python()
    case 'css':
    case 'scss': return css()
    case 'html': return html()
    case 'xml': return xml()
    case 'yaml': return yaml()
    case 'sql': return sql()
    default: return []
  }
}

// Colors resolve from CSS variables so highlighting tracks the active light/dark theme.
const highlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.operatorKeyword], color: 'var(--color-primary)' },
  { tag: [t.controlKeyword, t.moduleKeyword], color: 'var(--color-primary)', fontWeight: '600' },
  { tag: [t.string, t.special(t.string)], color: 'var(--color-success)' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--color-warning)' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--color-text-muted)', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--color-primary-hover)' },
  { tag: [t.typeName, t.className, t.namespace], color: 'var(--color-primary-hover)' },
  { tag: [t.propertyName, t.attributeName], color: 'var(--color-text)' },
  { tag: [t.tagName], color: 'var(--color-error)' },
  { tag: [t.heading], color: 'var(--color-primary)', fontWeight: '600' },
  { tag: [t.link, t.url], color: 'var(--color-primary)', textDecoration: 'underline' },
  { tag: [t.emphasis], fontStyle: 'italic' },
  { tag: [t.strong], fontWeight: '700' },
  { tag: [t.meta, t.processingInstruction], color: 'var(--color-text-secondary)' },
  { tag: [t.invalid], color: 'var(--color-error)' },
])

// Transparent surface so the panel's background image / frosted scrim shows through.
const baseTheme = EditorView.theme({
  '&': {
    height: '100%',
    color: 'var(--color-text)',
    backgroundColor: 'transparent',
  },
  '.cm-scroller': {
    fontFamily: "'JetBrains Mono', 'Fira Code', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    lineHeight: '1.65',
  },
  '.cm-content': {
    padding: '14px 0 var(--editor-scroll-bottom-gap, min(42vh, 360px))',
    caretColor: 'var(--color-primary)',
  },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--color-text-muted)',
    border: 'none',
  },
  '.cm-activeLine': { backgroundColor: 'rgba(var(--color-primary-rgb), 0.06)' },
  '.cm-activeLineGutter': { backgroundColor: 'rgba(var(--color-primary-rgb), 0.06)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--color-primary)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'rgba(var(--color-primary-rgb), 0.22)',
  },
  '.cm-matchingBracket': {
    backgroundColor: 'rgba(var(--color-primary-rgb), 0.18)',
    outline: '1px solid rgba(var(--color-primary-rgb), 0.4)',
  },
  '.cm-foldPlaceholder': {
    backgroundColor: 'var(--color-bg-muted)',
    border: 'none',
    color: 'var(--color-text-muted)',
  },
}, { dark: false })

function isDark() {
  return document.documentElement.getAttribute('data-theme') === 'dark'
}

function surroundSelectedText(view: EditorView, open: string, close: string) {
  if (props.readonly || view.state.selection.ranges.every((range) => range.empty)) return false

  view.dispatch({
    ...view.state.changeByRange((range) => {
      if (range.empty) return { range }
      const selectedText = view.state.sliceDoc(range.from, range.to)
      return {
        changes: { from: range.from, to: range.to, insert: `${open}${selectedText}${close}` },
        range: EditorSelection.range(range.from + open.length, range.to + open.length),
      }
    }),
    scrollIntoView: true,
    userEvent: 'input.type',
  })
  return true
}

function handleSurroundSelectionKeydown(event: KeyboardEvent, view: EditorView) {
  if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.key.length !== 1) return false
  const pair = surroundPairs[event.key]
  if (!pair || !surroundSelectedText(view, pair[0], pair[1])) return false

  event.preventDefault()
  return true
}

function collabExtension() {
  return props.collabYText ? yCollab(props.collabYText, null) : []
}

function buildExtensions() {
  return [
    gutterConf.of(gutterExtension(props.lineNumbers)),
    history(),
    drawSelection(),
    dropCursor(),
    indentOnInput(),
    bracketMatching(),
    highlightActiveLine(),
    syntaxHighlighting(highlightStyle),
    EditorView.domEventHandlers({ keydown: handleSurroundSelectionKeydown }),
    search({ top: true }),
    keymap.of([
      {
        key: 'Mod-s',
        preventDefault: true,
        run: () => {
          emit('save')
          return true
        },
      },
      ...searchKeymap,
      ...defaultKeymap,
      ...historyKeymap,
      indentWithTab,
    ]),
    baseTheme,
    fontConf.of(fontTheme(props.fontSize)),
    tabConf.of(tabExtension(props.tabSize)),
    wrapConf.of(props.lineWrap ? EditorView.lineWrapping : []),
    languageConf.of(languageExtension(props.language)),
    editableConf.of([
      EditorView.editable.of(!props.readonly),
      EditorState.readOnly.of(props.readonly),
    ]),
    collabConf.of(collabExtension()),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        const value = update.state.doc.toString()
        if (value !== props.modelValue) emit('update:modelValue', value)
        scheduleMinimapDraw()
      }
      if (update.docChanged || update.selectionSet) updateCursorStats(update.state)
    }),
  ]
}

// Same CJK-aware counting as the parent's document stats: CJK per codepoint,
// latin runs per word.
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]/g
function countWords(text: string) {
  const cjk = text.match(CJK_RE)?.length || 0
  const latin = text.replace(CJK_RE, ' ').match(/[A-Za-z0-9_'\u2019-]+/g)?.length || 0
  return cjk + latin
}

function updateCursorStats(state: EditorState) {
  const main = state.selection.main
  const line = state.doc.lineAt(main.head)
  cursorLine.value = line.number
  cursorColumn.value = main.head - line.from + 1
  let chars = 0
  let words = 0
  for (const range of state.selection.ranges) {
    if (range.empty) continue
    chars += range.to - range.from
    words += countWords(state.sliceDoc(range.from, range.to))
  }
  selectedChars.value = chars
  selectedWords.value = words
}

const cssVar = (name: string, fallback: string) => {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}

const minimapLineColor = (line: string) => {
  const trimmed = line.trim()
  if (!trimmed) return cssVar('--color-border', '#e4e4e7')
  if (/^(\/\/|#|<!--|\*)/.test(trimmed)) return cssVar('--color-text-muted', '#a1a1aa')
  if (/^([<{]|[-*]\s|\d+\.)/.test(trimmed)) return cssVar('--color-primary', '#6366f1')
  if (/["'`].*["'`]$/.test(trimmed)) return cssVar('--color-success', '#22c55e')
  return cssVar('--color-text-secondary', '#71717a')
}

let minimapFrame: number | undefined
let minimapResizeObserver: ResizeObserver | undefined

function scheduleMinimapDraw() {
  if (minimapFrame !== undefined) window.cancelAnimationFrame(minimapFrame)
  minimapFrame = window.requestAnimationFrame(() => {
    minimapFrame = undefined
    drawMinimap()
    updateMinimapViewport()
  })
}

function drawMinimap() {
  const canvas = minimapCanvas.value
  const rail = minimap.value
  if (!canvas || !rail) return

  const rect = rail.getBoundingClientRect()
  if (!rect.width || !rect.height) return

  const dpr = window.devicePixelRatio || 1
  const width = Math.max(1, Math.floor(rect.width * dpr))
  const height = Math.max(1, Math.floor(rect.height * dpr))
  if (canvas.width !== width) canvas.width = width
  if (canvas.height !== height) canvas.height = height
  canvas.style.width = `${rect.width}px`
  canvas.style.height = `${rect.height}px`

  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, width, height)
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

  const lines = props.modelValue.split(/\r?\n/)
  const total = Math.max(lines.length, 1)
  const maxMarks = Math.max(1, Math.floor(rect.height * 1.8))
  const step = Math.max(1, Math.ceil(total / maxMarks))
  const minPitch = 4
  const denseRows = Math.max(total, Math.ceil(rect.height / minPitch))
  const isShortFile = total < denseRows
  const linePitch = isShortFile
    ? minPitch
    : Math.max(1, rect.height / total)
  const lineHeight = isShortFile
    ? 2
    : Math.max(1, Math.min(3, linePitch * 0.72))
  const topPadding = isShortFile ? 8 : 0
  const usableWidth = Math.max(12, rect.width - 14)

  for (let i = 0; i < total; i += step) {
    const line = lines[i] || ''
    const trimmedLength = line.trim().length
    const y = isShortFile
      ? topPadding + i * linePitch
      : Math.min(rect.height - lineHeight, i * linePitch)
    if (y > rect.height - lineHeight) break
    const w = Math.max(4, Math.min(usableWidth, 4 + Math.sqrt(trimmedLength) * 5.8))
    ctx.globalAlpha = trimmedLength ? 0.34 : 0.10
    ctx.fillStyle = minimapLineColor(line)
    ctx.fillRect(7, y, w, lineHeight)
  }
  ctx.globalAlpha = 1
}

function updateMinimapViewport() {
  const scroller = view.value?.scrollDOM
  const rail = minimap.value
  if (!scroller || !rail) return

  const railHeight = rail.clientHeight
  const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
  if (!railHeight || maxScroll <= 0) {
    minimapViewportStyle.value = { top: '0px', height: `${railHeight}px` }
    return
  }

  const handleHeight = Math.max(24, Math.min(railHeight, (scroller.clientHeight / scroller.scrollHeight) * railHeight))
  const top = (scroller.scrollTop / maxScroll) * (railHeight - handleHeight)
  minimapViewportStyle.value = { top: `${top}px`, height: `${handleHeight}px` }
}

function scrollFromMinimap(clientY: number) {
  const scroller = view.value?.scrollDOM
  const rail = minimap.value
  if (!scroller || !rail) return

  const rect = rail.getBoundingClientRect()
  const ratio = Math.max(0, Math.min(1, (clientY - rect.top) / Math.max(1, rect.height)))
  const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
  scroller.scrollTop = ratio * maxScroll
  updateMinimapViewport()
}

const onMinimapPointerMove = (e: PointerEvent) => scrollFromMinimap(e.clientY)
const onMinimapPointerUp = () => {
  window.removeEventListener('pointermove', onMinimapPointerMove)
  window.removeEventListener('pointerup', onMinimapPointerUp)
}

function handleMinimapPointerDown(e: PointerEvent) {
  e.preventDefault()
  scrollFromMinimap(e.clientY)
  window.addEventListener('pointermove', onMinimapPointerMove)
  window.addEventListener('pointerup', onMinimapPointerUp)
}

onMounted(() => {
  view.value = new EditorView({
    parent: host.value!,
    state: EditorState.create({ doc: props.collabYText?.toString() ?? props.modelValue, extensions: buildExtensions() }),
  })
  view.value.scrollDOM.addEventListener('scroll', updateMinimapViewport, { passive: true })
  minimapResizeObserver = new ResizeObserver(scheduleMinimapDraw)
  if (minimap.value) minimapResizeObserver.observe(minimap.value)
  scheduleMinimapDraw()
  updateCursorStats(view.value.state)
  // CodeMirror's dark flag only affects a few built-in defaults; keep it in sync.
  themeObserver = new MutationObserver(syncDark)
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  syncDark()
})

let themeObserver: MutationObserver | undefined
let lastDark: boolean | undefined
function syncDark() {
  const dark = isDark()
  if (dark === lastDark || !view.value) return
  lastDark = dark
  // Re-dispatch nothing structural; the CSS-var colors already track. Reconfigure base
  // theme dark flag for selection/caret default behavior.
  view.value.dispatch({
    effects: editableConf.reconfigure([
      EditorView.editable.of(!props.readonly),
      EditorState.readOnly.of(props.readonly),
      EditorView.theme({}, { dark }),
    ]),
  })
  scheduleMinimapDraw()
}

watch(() => props.modelValue, (value) => {
  const v = view.value
  if (!v || props.collabYText) return
  if (value === v.state.doc.toString()) return
  v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } })
  scheduleMinimapDraw()
})

watch(() => props.collabYText, (ytext) => {
  const v = view.value
  if (!v) return
  const nextDoc = ytext?.toString() ?? props.modelValue
  v.dispatch({
    changes: { from: 0, to: v.state.doc.length, insert: nextDoc },
    effects: collabConf.reconfigure(collabExtension()),
  })
  scheduleMinimapDraw()
})

watch(() => props.language, (lang) => {
  view.value?.dispatch({ effects: languageConf.reconfigure(languageExtension(lang)) })
})

watch(() => props.readonly, (ro) => {
  view.value?.dispatch({
    effects: editableConf.reconfigure([
      EditorView.editable.of(!ro),
      EditorState.readOnly.of(ro),
    ]),
  })
})

watch(() => props.fontSize, (size) => {
  view.value?.dispatch({ effects: fontConf.reconfigure(fontTheme(size)) })
})

watch(() => props.tabSize, (n) => {
  view.value?.dispatch({ effects: tabConf.reconfigure(tabExtension(n)) })
})

watch(() => props.lineWrap, (on) => {
  view.value?.dispatch({ effects: wrapConf.reconfigure(on ? EditorView.lineWrapping : []) })
})

watch(() => props.lineNumbers, (on) => {
  view.value?.dispatch({ effects: gutterConf.reconfigure(gutterExtension(on)) })
})

defineExpose({
  openSearch: () => {
    const v = view.value
    if (!v) return
    v.focus()
    openSearchPanel(v)
  },
})

onBeforeUnmount(() => {
  themeObserver?.disconnect()
  minimapResizeObserver?.disconnect()
  if (minimapFrame !== undefined) window.cancelAnimationFrame(minimapFrame)
  window.removeEventListener('pointermove', onMinimapPointerMove)
  window.removeEventListener('pointerup', onMinimapPointerUp)
  view.value?.scrollDOM.removeEventListener('scroll', updateMinimapViewport)
  view.value?.destroy()
})
</script>

<template>
  <div class="code-editor-outer">
    <div class="code-editor-shell">
      <div ref="host" class="code-editor" />
      <div ref="minimap" class="code-minimap" title="拖动或点击可快速跳转" @pointerdown="handleMinimapPointerDown">
        <canvas ref="minimapCanvas" class="code-minimap-canvas" />
        <div class="code-minimap-thumb" :style="minimapViewportStyle" />
      </div>
    </div>
    <slot name="statusbar" :line="cursorLine" :column="cursorColumn" :selected="selectedChars" :selected-words="selectedWords" />
  </div>
</template>

<style scoped>
.code-editor-outer {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.code-editor-shell {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
.code-editor {
  flex: 1;
  min-width: 0;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}
.code-editor :deep(.cm-editor) { height: 100%; }
.code-editor :deep(.cm-editor.cm-focused) { outline: none; }
.code-editor :deep(.cm-scroller) {
  overflow: auto;
  scroll-padding-bottom: var(--editor-scroll-bottom-gap, min(42vh, 360px));
}
.code-minimap {
  position: relative;
  width: 74px;
  min-width: 74px;
  height: 100%;
  border-left: 1px solid rgba(var(--color-primary-rgb), 0.08);
  background: transparent;
  cursor: pointer;
  user-select: none;
  touch-action: none;
  overflow: hidden;
  opacity: 0.62;
  transition: opacity var(--transition), background var(--transition), border-color var(--transition);
}
.code-minimap:hover {
  border-left-color: rgba(var(--color-primary-rgb), 0.18);
  background: rgba(var(--color-bg-card-rgb), 0.14);
  opacity: 0.92;
}
.code-minimap-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}
.code-minimap-thumb {
  position: absolute;
  left: 4px;
  right: 4px;
  min-height: 24px;
  border: 1px solid rgba(var(--color-primary-rgb), 0.22);
  border-radius: 5px;
  background: rgba(var(--color-primary-rgb), 0.06);
  box-shadow: none;
  pointer-events: none;
}
.code-minimap:hover .code-minimap-thumb {
  border-color: rgba(var(--color-primary-rgb), 0.38);
  background: rgba(var(--color-primary-rgb), 0.10);
}
@media (max-width: 900px) {
  .code-minimap { display: none; }
}

/* CodeMirror's search panel ships unstyled defaults; match the app shell. */
.code-editor :deep(.cm-panels) {
  border: none;
  background: transparent;
  color: var(--color-text);
}
.code-editor :deep(.cm-panels-top) { border-bottom: none; }
.code-editor :deep(.cm-panel.cm-search) {
  position: relative;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin: 8px 10px;
  padding: 7px 34px 7px 12px;
  border: 1px solid color-mix(in srgb, var(--color-border) 80%, transparent);
  border-radius: 14px;
  background: rgba(var(--color-bg-card-rgb), 0.88);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  box-shadow: 0 6px 24px rgba(15, 23, 42, 0.14), 0 1px 3px rgba(15, 23, 42, 0.08);
  font-family: inherit;
  font-size: 12px;
}
.code-editor :deep(.cm-panel.cm-search br) { display: none; }
.code-editor :deep(.cm-panel.cm-search label) {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin: 0;
  color: var(--color-text-secondary);
  font-size: 12px;
  white-space: nowrap;
}
.code-editor :deep(.cm-panel.cm-search input[type='checkbox']) { margin: 0; accent-color: var(--color-primary); }
.code-editor :deep(.cm-panel.cm-search input[type='text']) {
  min-width: 150px;
  padding: 5px 10px;
  border: 1px solid var(--color-border);
  border-radius: 999px;
  background: rgba(var(--color-bg-rgb), 0.6);
  color: var(--color-text);
  font-family: inherit;
  font-size: 12px;
  outline: none;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.code-editor :deep(.cm-panel.cm-search input[type='text']:focus) {
  border-color: var(--color-primary);
  box-shadow: 0 0 0 3px rgba(var(--color-primary-rgb), 0.16);
}
.code-editor :deep(.cm-panel.cm-search button:not([name='close'])) {
  padding: 4px 11px;
  border: none;
  border-radius: 999px;
  background: var(--color-bg-muted);
  background-image: none;
  color: var(--color-text-secondary);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
  transition: color 0.15s ease, background 0.15s ease;
}
.code-editor :deep(.cm-panel.cm-search button:not([name='close']):hover) {
  background: rgba(var(--color-primary-rgb), 0.12);
  color: var(--color-primary);
}
.code-editor :deep(.cm-panel.cm-search [name='close']) {
  position: absolute;
  top: 50%;
  right: 10px;
  transform: translateY(-50%);
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: none;
  border-radius: 999px;
  background: transparent;
  color: var(--color-text-muted);
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
  transition: color 0.15s ease, background 0.15s ease;
}
.code-editor :deep(.cm-panel.cm-search [name='close']:hover) {
  background: rgba(239, 68, 68, 0.1);
  color: var(--color-error);
}
.code-editor :deep(.cm-searchMatch) {
  background: rgba(var(--color-primary-rgb), 0.22);
  border-radius: 3px;
}
.code-editor :deep(.cm-searchMatch-selected) {
  background: var(--color-warning);
  color: #18181b;
}
</style>
