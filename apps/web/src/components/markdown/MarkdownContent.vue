<script setup lang="ts">
import { computed } from 'vue'
import { renderMarkdown, renderMarkdownWithSourceMap } from '@/lib/markdown'
import { isPaperReferenceUrl, parsePaperReference } from '@/lib/paper-reference'
import { usePaperReferenceStore } from '@/stores/paperReference'

const props = withDefaults(defineProps<{
  content: string
  inline?: boolean
  sourceMap?: boolean
}>(), {
  inline: false,
  sourceMap: false,
})

const paperReferences = usePaperReferenceStore()
const html = computed(() => props.sourceMap
  ? renderMarkdownWithSourceMap(props.content || '')
  : renderMarkdown(props.content || ''))

const onClick = (event: MouseEvent) => {
  const target = event.target as HTMLElement | null
  const anchor = target?.closest<HTMLAnchorElement>('a[href]')
  if (!anchor) return
  const href = anchor.getAttribute('href') || ''
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
