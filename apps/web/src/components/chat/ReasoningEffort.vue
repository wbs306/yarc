<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  modelValue: string
  levels?: string[]
}>()
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const LABELS: Record<string, string> = {
  off: '关',
  minimal: '极低',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '超高',
  max: '极高',
}

const DEFAULT_LEVELS = ['low', 'medium', 'high', 'xhigh']

// Model metadata contains actual provider thinking levels only. `off` is a
// chat/session toggle and must be available for every reasoning-capable model.
const effectiveLevels = computed(() => {
  const configured = props.levels ?? DEFAULT_LEVELS
  return ['off', ...new Set(configured.filter(level => level !== 'off'))]
})
const activeIndex = computed(() => Math.max(0, effectiveLevels.value.indexOf(props.modelValue)))
</script>

<template>
  <div class="effort-bar">
    <div class="effort-slider" :style="{ left: `${(activeIndex * 100) / effectiveLevels.length}%`, width: `${100 / effectiveLevels.length}%` }" />
    <button
      v-for="level in effectiveLevels"
      :key="level"
      class="effort-btn"
      :class="{ active: level === modelValue }"
      @click="emit('update:modelValue', level)"
    >{{ LABELS[level] || level }}</button>
  </div>
</template>

<style scoped>
.effort-bar {
  position: relative;
  display: flex;
  gap: 2px;
  padding: 3px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg-muted);
  min-width: 150px;
}

.effort-slider {
  position: absolute;
  top: 3px;
  height: calc(100% - 6px);
  border-radius: 4px;
  background: var(--color-bg-card);
  box-shadow: 0 1px 3px rgba(0,0,0,0.08);
  transition: left 0.25s ease, width 0.25s ease;
  pointer-events: none;
}

.effort-btn {
  position: relative;
  z-index: 1;
  flex: 1;
  padding: 4px 0;
  border: none;
  background: transparent;
  color: var(--color-text-muted);
  font-size: 11px;
  font-weight: 500;
  border-radius: 4px;
  cursor: pointer;
  transition: color var(--transition);
  white-space: nowrap;
}
.effort-btn:hover { color: var(--color-text); }
.effort-btn.active { color: var(--color-primary); }
</style>
