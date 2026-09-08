<script setup lang="ts">
import { ref, watch } from 'vue'

const props = defineProps<{
  documentId: string
  pageIndex: number
  load: (pageIndex: number) => Promise<string | null>
}>()

const src = ref<string | null>(null)
watch(() => [props.documentId, props.pageIndex, props.load] as const, (_, __, onCleanup) => {
  let active = true
  src.value = null
  onCleanup(() => { active = false })
  void props.load(props.pageIndex).then((url) => {
    if (active) src.value = url
  })
}, { immediate: true })
</script>

<template>
  <img v-if="src" :src="src" class="pdf-page-preview" alt="" aria-hidden="true" />
</template>

<style scoped>
.pdf-page-preview {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
</style>
