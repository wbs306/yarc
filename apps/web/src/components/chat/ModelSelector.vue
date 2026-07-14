<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'

interface Model {
  id: string
  name: string
  reasoning?: boolean
}

const props = defineProps<{
  modelValue: string
  models: Model[]
  disabled?: boolean
}>()

const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const open = ref(false)
const container = ref<HTMLElement | null>(null)

const options = computed(() =>
  props.models.map(m => ({ value: m.id, label: m.name || m.id, reasoning: !!m.reasoning }))
)
const selected = computed(() => options.value.find(o => o.value === props.modelValue))

const select = (value: string) => {
  emit('update:modelValue', value)
  open.value = false
}

const openDropdown = () => {
  if (!props.disabled) open.value = true
}

defineExpose({ openDropdown })

const onDocClick = (e: MouseEvent) => {
  if (container.value && !container.value.contains(e.target as Node)) open.value = false
}

onMounted(() => document.addEventListener('mousedown', onDocClick))
onUnmounted(() => document.removeEventListener('mousedown', onDocClick))
</script>

<template>
  <div ref="container" class="model-selector">
    <button class="model-trigger" :class="{ open }" :disabled="disabled" @click="open = !open">
      <span class="model-trigger-label">{{ selected?.label || '选择模型' }}</span>
      <svg class="model-chevron" :class="{ rotated: open }" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="6 9 12 15 18 9"/></svg>
    </button>

    <Transition name="model-drop">
      <div v-if="open" class="model-dropdown">
        <button
          v-for="opt in options"
          :key="opt.value"
          class="model-option"
          :class="{ active: opt.value === modelValue }"
          @click="select(opt.value)"
        >
          <span class="model-option-name">{{ opt.label }}</span>
          <svg v-if="opt.value === modelValue" class="model-check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>
        </button>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.model-selector {
  position: relative;
  min-width: 0;
}

.model-trigger {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-width: 0;
  padding: 6px 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg-muted);
  color: var(--color-text);
  font-size: 12px;
  cursor: pointer;
  transition: border-color var(--transition), box-shadow var(--transition);
}
.model-trigger:hover { border-color: var(--color-primary); }
.model-trigger.open { border-color: var(--color-primary); box-shadow: 0 0 0 2px var(--color-primary-soft); }
.model-trigger:disabled { opacity: 0.5; cursor: default; }

.model-trigger-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
}

.model-chevron {
  flex-shrink: 0;
  color: var(--color-text-muted);
  transition: transform 0.2s ease;
}
.model-chevron.rotated { transform: rotate(180deg); }

.model-dropdown {
  position: absolute;
  left: 0;
  right: 0;
  bottom: calc(100% + 4px);
  z-index: 50;
  min-width: 280px;
  width: max-content;
  max-width: 400px;
  background: var(--color-bg-card);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  box-shadow: 0 8px 24px rgba(0,0,0,0.12);
  max-height: 320px;
  overflow-y: auto;
  padding: 4px;
}

.model-option {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 10px;
  border: none;
  background: transparent;
  color: var(--color-text-secondary);
  font-size: 12px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  text-align: left;
  transition: background var(--transition), color var(--transition);
}
.model-option:hover { background: var(--color-bg-muted); color: var(--color-text); }
.model-option.active { background: var(--color-primary-soft); color: var(--color-primary); font-weight: 500; }

.model-option-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.model-check { flex-shrink: 0; color: var(--color-primary); }

.model-drop-enter-active, .model-drop-leave-active { transition: opacity 0.15s ease, transform 0.15s ease; }
.model-drop-enter-from, .model-drop-leave-to { opacity: 0; transform: translateY(4px); }
</style>
