<script setup lang="ts">
import { computed } from 'vue'
import { renderInlineLatex } from '@/lib/markdown'

const props = defineProps<{
  content: string
}>()

const html = computed(() => renderInlineLatex(props.content || ''))
</script>

<template>
  <span class="inline-latex" v-html="html" />
</template>

<style scoped>
.inline-latex :deep(.katex) { white-space: nowrap; }
</style>
