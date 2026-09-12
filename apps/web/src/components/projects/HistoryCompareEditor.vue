<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { EditorState, RangeSetBuilder, type Extension } from '@codemirror/state'
import { EditorView, Decoration, lineNumbers } from '@codemirror/view'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
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
  before: string
  after: string
  beforeLabel?: string
  afterLabel?: string
  language?: string
}>(), {
  beforeLabel: '历史版本',
  afterLabel: '当前版本',
  language: 'plaintext',
})

type ChangedLines = { removed: Set<number>; added: Set<number> }

const beforeHost = ref<HTMLDivElement>()
const afterHost = ref<HTMLDivElement>()
let beforeView: EditorView | null = null
let afterView: EditorView | null = null

const splitLines = (value: string) => value.split('\n')

const findChangedLines = (before: string, after: string): ChangedLines => {
  const a = splitLines(before)
  const b = splitLines(after)
  const removed = new Set<number>()
  const added = new Set<number>()

  if (a.length * b.length > 250_000) {
    a.forEach((_, index) => removed.add(index + 1))
    b.forEach((_, index) => added.add(index + 1))
    return { removed, added }
  }

  const table = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }

  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      i++
      j++
    } else if (j < b.length && (i >= a.length || table[i][j + 1] >= table[i + 1][j])) {
      added.add(j + 1)
      j++
    } else if (i < a.length) {
      removed.add(i + 1)
      i++
    }
  }
  return { removed, added }
}

const languageExtension = (language: string): Extension => {
  switch (language.toLowerCase()) {
    case 'typescript': return javascript({ typescript: true, jsx: true })
    case 'javascript': return javascript({ jsx: true })
    case 'vue': return vue()
    case 'json': return json()
    case 'markdown': return markdown()
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

const highlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword], color: 'var(--color-primary)' },
  { tag: [t.string, t.special(t.string)], color: 'var(--color-success)' },
  { tag: [t.number, t.bool, t.atom], color: 'var(--color-warning)' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--color-text-muted)', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--color-primary-hover)' },
  { tag: [t.typeName, t.className, t.propertyName, t.attributeName], color: 'var(--color-text)' },
])

const editorTheme = EditorView.theme({
  '&': {
    height: '100%',
    color: 'var(--color-text)',
    backgroundColor: 'transparent',
  },
  '.cm-scroller': {
    overflow: 'auto',
    fontFamily: "'JetBrains Mono', 'Fira Code', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    lineHeight: '1.55',
  },
  '.cm-content': { padding: '8px 0 24px' },
  '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--color-text-muted)', border: 'none' },
  '.cm-line.yarc-diff-removed': { backgroundColor: 'rgba(239, 68, 68, .13)' },
  '.cm-line.yarc-diff-added': { backgroundColor: 'rgba(34, 197, 94, .13)' },
  '.cm-line.yarc-diff-removed::before, .cm-line.yarc-diff-added::before': {
    position: 'absolute',
    left: '0',
    width: '3px',
    height: '100%',
    content: '""',
  },
  '.cm-line.yarc-diff-removed::before': { backgroundColor: 'var(--color-error)' },
  '.cm-line.yarc-diff-added::before': { backgroundColor: 'var(--color-success)' },
}, { dark: false })

const decorationsFor = (doc: EditorState['doc'], lines: Set<number>, className: string) => {
  const builder = new RangeSetBuilder<Decoration>()
  for (const lineNumber of [...lines].sort((a, b) => a - b)) {
    if (lineNumber > doc.lines) continue
    const line = doc.line(lineNumber)
    builder.add(line.from, line.from, Decoration.line({ class: className }))
  }
  return builder.finish()
}

const createEditor = (parent: HTMLElement, content: string, changedLines: Set<number>, className: string) => {
  const state = EditorState.create({
    doc: content,
    extensions: [
      lineNumbers(),
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      editorTheme,
      syntaxHighlighting(highlightStyle),
      languageExtension(props.language),
      EditorView.decorations.of(decorationsFor(EditorState.create({ doc: content }).doc, changedLines, className)),
    ],
  })
  return new EditorView({ state, parent })
}

const render = () => {
  beforeView?.destroy()
  afterView?.destroy()
  beforeView = null
  afterView = null
  if (!beforeHost.value || !afterHost.value) return

  const changed = findChangedLines(props.before, props.after)
  beforeView = createEditor(beforeHost.value, props.before, changed.removed, 'yarc-diff-removed')
  afterView = createEditor(afterHost.value, props.after, changed.added, 'yarc-diff-added')
}

onMounted(render)
watch(() => [props.before, props.after, props.language] as const, render)
onBeforeUnmount(() => {
  beforeView?.destroy()
  afterView?.destroy()
})
</script>

<template>
  <div class="history-code-diff">
    <section class="history-code-pane history">
      <header><strong>{{ beforeLabel }}</strong><span>删除项</span></header>
      <div ref="beforeHost" class="history-code-host" />
    </section>
    <section class="history-code-pane current">
      <header><strong>{{ afterLabel }}</strong><span>新增项</span></header>
      <div ref="afterHost" class="history-code-host" />
    </section>
  </div>
</template>

<style scoped>
.history-code-diff { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; min-height: 0; height: 100%; }
.history-code-pane { display: flex; min-width: 0; min-height: 0; flex-direction: column; overflow: hidden; border: 1px solid var(--color-border); border-radius: var(--radius-sm); background: color-mix(in srgb, var(--color-bg-muted) 26%, transparent); }
.history-code-pane header { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 10px; border-bottom: 1px solid var(--color-border); }
.history-code-pane header strong { color: var(--color-text); font-size: 11px; }.history-code-pane header span { color: var(--color-text-muted); font-size: 10px; }
.history-code-pane.history header { background: color-mix(in srgb, var(--color-error) 7%, transparent); }.history-code-pane.current header { background: color-mix(in srgb, var(--color-success) 8%, transparent); }
.history-code-host { flex: 1; min-height: 0; }
:deep(.cm-editor) { height: 100%; font-size: 11px; }
:deep(.cm-content), :deep(.cm-gutters) { min-height: 100%; }
@media (max-width: 800px) { .history-code-diff { grid-template-columns: 1fr; grid-template-rows: repeat(2, minmax(0, 1fr)); } }
</style>
