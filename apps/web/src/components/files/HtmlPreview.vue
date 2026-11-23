<script setup lang="ts">
import { ref, watch } from 'vue'
import { useApi } from '@/composables/useApi'
import { embedHtmlPreviewAssets, findHtmlPreviewAssets, loadHtmlPreviewAssets } from '@/lib/html-preview'

const props = defineProps<{
  content: string
  name: string
  path: string
  projectId: string | null
}>()

const api = useApi()
const previewDocument = ref<string | null>(null)
const missingAssets = ref(0)
// Keep network subresources blocked in the iframe. The workbench fetches authorized
// project files as bytes and embeds them as typed data URLs, not executable markup.
const policy = "default-src 'none'; style-src 'unsafe-inline' data:; img-src data:; font-src data:; base-uri 'none'; form-action 'none'"
const wrapDocument = (content: string) =>
  `<!doctype html><meta http-equiv="Content-Security-Policy" content="${policy}">\n${content}`

watch(() => [props.content, props.path, props.projectId] as const, async ([content, path, projectId], _, onCleanup) => {
  if (!projectId) {
    previewDocument.value = wrapDocument(content)
    missingAssets.value = 0
    return
  }

  // A detached textarea decodes character references without loading any HTML resources.
  const decoder = document.createElement('textarea')
  const assets = findHtmlPreviewAssets(content, path, value => {
    if (!value.includes('&')) return value
    decoder.innerHTML = value
    return decoder.value
  })
  if (!assets.length) {
    previewDocument.value = wrapDocument(content)
    missingAssets.value = 0
    return
  }

  const controller = new AbortController()
  let stale = false
  const timeout = window.setTimeout(() => controller.abort(), 8000)
  onCleanup(() => {
    stale = true
    window.clearTimeout(timeout)
    controller.abort()
  })
  try {
    const dataUrls = await loadHtmlPreviewAssets(assets, path => api.getFileDownloadUrl(path, projectId), controller.signal)
    if (stale) return
    const result = embedHtmlPreviewAssets(content, assets, dataUrls)
    previewDocument.value = wrapDocument(result.content)
    missingAssets.value = result.missing
  } finally {
    window.clearTimeout(timeout)
  }
}, { immediate: true })
</script>

<template>
  <div class="html-preview">
    <iframe
      v-if="previewDocument !== null"
      sandbox=""
      referrerpolicy="no-referrer"
      :title="`${name} HTML 预览`"
      :srcdoc="previewDocument"
    />
    <div v-else class="html-preview-state" role="status">正在加载项目资源…</div>
    <footer>
      {{ projectId ? '静态预览 · 支持项目内的相对路径样式表与图片，不运行 JavaScript' : '静态预览 · 不运行 JavaScript，仅支持内联样式与内嵌资源' }}
      <span v-if="missingAssets" role="status"> · {{ missingAssets }} 处项目资源未能显示</span>
    </footer>
  </div>
</template>

<style scoped>
.html-preview {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.html-preview > iframe {
  flex: 1;
  width: 100%;
  min-height: 0;
  border: 0;
  background: white;
}
.html-preview-state {
  flex: 1;
  display: grid;
  place-items: center;
  color: var(--color-text-muted);
  font-size: 13px;
}
.html-preview > footer {
  flex: 0 0 auto;
  padding: 5px 12px;
  border-top: 1px solid var(--color-border);
  color: var(--color-text-muted);
  font-size: 11px;
}
</style>
