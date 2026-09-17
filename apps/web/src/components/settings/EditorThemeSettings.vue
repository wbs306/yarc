<script setup lang="ts">
import { computed, ref } from 'vue'
import { useThemeStore } from '@/stores/theme'
import { editorThemeGroups, normalizeEditorTheme } from '@/lib/editor-theme-options'
import Select from '@/components/ui/Select.vue'
import CodeEditor from '@/components/files/CodeEditor.vue'

const theme = useThemeStore()
const previewLanguage = ref('latex')
const previewLanguages = [
  { value: 'latex', label: 'LaTeX' },
  { value: 'typescript', label: 'TypeScript' },
]
const editorPreview = computed(() => previewLanguage.value === 'latex'
  ? String.raw`% 主题预览：命令、环境、注释与公式
\documentclass{article}
\usepackage{amsmath}
\begin{document}
\section{Introduction}
Hello, \textbf{YARC}!
\begin{equation}
  E = mc^{2} + \alpha
\end{equation}
\end{document}`
  : `// Theme preview: keywords, strings and numbers
interface Paper { title: string; year: number }
const paper: Paper = { title: 'Research notes', year: 2026 }
function describe(item: Paper): string {
  return item.title + ' (' + item.year + ')'
}
console.log(describe(paper))`)
</script>

<template>
  <div class="settings-card">
    <div class="card-header">
      <h3>代码配色</h3>
      <p>使用现成主题包的语法高亮，应用于文件编辑器和历史对比；背景、行号、光标和选区保持 YARC 外观。</p>
    </div>
    <div class="card-body">
      <div class="setting-row">
        <div class="row-info">
          <div class="row-label">配色主题</div>
          <div class="row-desc">按浅色、深色主题分组，选择后立即生效并自动保存；只改变代码配色，不切换背景。</div>
        </div>
        <div class="row-control">
          <Select :model-value="theme.editor.theme" :groups="editorThemeGroups" @update:model-value="theme.setEditorSetting('theme', normalizeEditorTheme($event))" />
        </div>
      </div>
      <div class="setting-row">
        <div class="row-info">
          <div class="row-label">实时预览</div>
          <div class="row-desc">只读示例，不会修改任何项目文件。</div>
        </div>
        <div class="row-control">
          <Select v-model="previewLanguage" :options="previewLanguages" min-width="140px" />
        </div>
      </div>
      <div class="editor-theme-preview">
        <CodeEditor :model-value="editorPreview" :language="previewLanguage" readonly :font-size="theme.editor.fontSize" :tab-size="theme.editor.tabSize" :line-wrap="theme.editor.lineWrap" :line-numbers="theme.editor.lineNumbers" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.settings-card { background: color-mix(in srgb, var(--color-bg-card) 96%, var(--color-bg)); border: 1px solid var(--color-border); border-radius: 16px; overflow: hidden; }
.card-header { padding: 24px 28px 20px; }
.card-header h3 { margin: 0 0 6px; font-size: 17px; font-weight: 680; color: var(--color-text); }
.card-header p { margin: 0; font-size: 13px; line-height: 1.55; color: var(--color-text-muted); }
.setting-row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 16px; padding: 16px 28px; border-top: 1px solid var(--color-border); }
.row-info { flex: 1; min-width: 180px; }
.row-label { font-size: 14.5px; font-weight: 560; color: var(--color-text); }
.row-desc { margin-top: 4px; font-size: 12.5px; line-height: 1.45; color: var(--color-text-muted); }
.row-control { width: 270px; max-width: 100%; }
.editor-theme-preview {
  margin: 0 28px 24px;
  height: 280px;
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  --editor-scroll-bottom-gap: 16px;
}
</style>
