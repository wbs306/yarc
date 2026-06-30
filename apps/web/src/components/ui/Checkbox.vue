<script setup lang="ts">
const props = defineProps<{
  modelValue: boolean
  label?: string
  disabled?: boolean
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
}>()

const toggle = () => {
  if (!props.disabled) {
    emit('update:modelValue', !props.modelValue)
  }
}
</script>

<template>
  <label class="modern-checkbox" :class="{ disabled }" @click.prevent="toggle">
    <div class="checkbox-box" :class="{ checked: modelValue }">
      <svg v-if="modelValue" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
        <polyline points="20 6 9 17 4 12" />
      </svg>
    </div>
    <span v-if="label" class="checkbox-label">{{ label }}</span>
    <slot />
  </label>
</template>

<style scoped>
.modern-checkbox {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  user-select: none;
}

.modern-checkbox.disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.checkbox-box {
  width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 2px solid var(--color-border);
  border-radius: 5px;
  background: var(--color-bg);
  transition: all 0.2s ease;
  flex-shrink: 0;
}

.modern-checkbox:hover:not(.disabled) .checkbox-box {
  border-color: var(--color-primary);
}

.checkbox-box.checked {
  background: var(--color-primary);
  border-color: var(--color-primary);
  color: white;
}

.checkbox-label {
  font-size: 13px;
  color: var(--color-text);
}
</style>
