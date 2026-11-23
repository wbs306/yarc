<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'

// Keep the panel in one stable DOM location. Only its overlay geometry follows
// the editor's preview slot; moving/unmounting the editor cannot reset PDFium.
const props = defineProps<{
  target: HTMLElement | null
  active: boolean
}>()
const root = ref<HTMLElement | null>(null)
const bounds = ref<Record<string, string>>({ width: '50%', height: '100%', right: '0', top: '0' })
let observer: ResizeObserver | null = null

const measure = () => {
  const parent = root.value?.offsetParent
  if (!props.active || !props.target || !(parent instanceof HTMLElement)) return
  const target = props.target.getBoundingClientRect()
  if (!target.width || !target.height) return
  const container = parent.getBoundingClientRect()
  bounds.value = {
    left: `${target.left - container.left}px`,
    top: `${target.top - container.top}px`,
    width: `${target.width}px`,
    height: `${target.height}px`,
  }
}

watch(() => [props.target, props.active] as const, async (_, __, onCleanup) => {
  observer?.disconnect()
  let stale = false
  onCleanup(() => { stale = true; observer?.disconnect() })
  await nextTick()
  if (stale || !props.target || !props.active) return
  measure()
  observer = new ResizeObserver(measure)
  observer.observe(props.target)
  const parent = root.value?.offsetParent
  if (parent instanceof HTMLElement) observer.observe(parent)
}, { immediate: true, flush: 'post' })

onBeforeUnmount(() => { observer?.disconnect() })
</script>

<template>
  <div
    ref="root"
    class="latex-preview-surface"
    :class="{ background: !active || !target }"
    :style="bounds"
    :inert="!active || !target"
    :aria-hidden="!active || !target"
  >
    <slot />
  </div>
</template>

<style scoped>
.latex-preview-surface { position: absolute; z-index: 1; min-width: 0; min-height: 0; overflow: hidden; }
.background { visibility: hidden; pointer-events: none; }
</style>
