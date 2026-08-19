<script setup lang="ts">
import { computed } from 'vue'
import { renderMarkdown, renderMarkdownWithSourceMap } from '@/lib/markdown'
import { isPaperReferenceUrl, parsePaperReference } from '@/lib/paper-reference'
import { parseWorkspaceFileReferenceHref } from '@/lib/workspace-file-reference'
import { usePaperReferenceStore } from '@/stores/paperReference'

const props = withDefaults(defineProps<{
  content: string
  inline?: boolean
  sourceMap?: boolean
  fileReferences?: boolean
}>(), {
  inline: false,
  sourceMap: false,
  fileReferences: false,
})

const emit = defineEmits<{
  openFile: [path: string]
}>()

const paperReferences = usePaperReferenceStore()
const html = computed(() => {
  const options = { fileReferences: props.fileReferences }
  return props.sourceMap
    ? renderMarkdownWithSourceMap(props.content || '', options)
    : renderMarkdown(props.content || '', options)
})

const onClick = (event: MouseEvent) => {
  const target = event.target as HTMLElement | null
  const anchor = target?.closest<HTMLAnchorElement>('a[href]')
  if (!anchor) return
  const href = anchor.getAttribute('href') || ''
  const filePath = parseWorkspaceFileReferenceHref(href)
  if (filePath) {
    event.preventDefault()
    event.stopPropagation()
    emit('openFile', filePath)
    return
  }
  if (!isPaperReferenceUrl(href)) return

  const title = anchor.textContent?.replace(/^《|》$/g, '').trim()
  const reference = parsePaperReference(href, title, anchor.closest('p, li, blockquote')?.textContent || title)
  if (!reference) return

  event.preventDefault()
  event.stopPropagation()
  const rect = anchor.getBoundingClientRect()
  void paperReferences.resolve(reference, false, {
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    left: rect.left,
    width: rect.width,
    height: rect.height,
  }, anchor)
}
</script>

<template>
  <component :is="inline ? 'span' : 'div'" class="md markdown-content" v-html="html" @click="onClick" />
</template>
