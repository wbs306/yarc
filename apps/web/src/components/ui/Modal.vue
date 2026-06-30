<script setup lang="ts">
defineProps<{
  modelValue: boolean
  title?: string
  maxWidth?: string
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
  (e: 'close'): void
}>()

const close = () => {
  emit('update:modelValue', false)
  emit('close')
}
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="modelValue" class="modal-overlay" @click.self="close">
        <div class="modal-card" :style="{ maxWidth: maxWidth || '500px' }">
          <div v-if="title || $slots.header" class="modal-header">
            <slot name="header">
              <h3>{{ title }}</h3>
            </slot>
            <button class="modal-close" @click="close">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
          <div class="modal-body">
            <slot />
          </div>
          <div v-if="$slots.footer" class="modal-footer">
            <slot name="footer" />
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(4px);
  padding: 16px;
}

.modal-card {
  width: 100%;
  background: var(--color-bg-card);
  border: 1px solid var(--color-border);
  border-radius: 12px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.2);
  display: flex;
  flex-direction: column;
  max-height: calc(100vh - 32px);
  overflow: hidden;
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
}

.modal-header h3 {
  font-size: 16px;
  font-weight: 600;
  color: var(--color-text);
  margin: 0;
}

.modal-close {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--color-text-muted);
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.modal-close:hover {
  background: var(--color-bg-muted);
  color: var(--color-text);
}

.modal-body {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 16px 20px;
  border-top: 1px solid var(--color-border);
  flex-shrink: 0;
}

.modal-enter-active,
.modal-leave-active {
  transition: all 0.25s ease;
}

.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}

.modal-enter-from .modal-card,
.modal-leave-to .modal-card {
  transform: scale(0.95) translateY(10px);
}

/* Modal footer button styles */
.modal-footer :deep(.btn) {
  padding: 9px 18px;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
  font-family: inherit;
  border: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.modal-footer :deep(.btn-ghost) {
  border: 1px solid var(--color-border);
  background: var(--color-bg);
  color: var(--color-text-secondary);
}

.modal-footer :deep(.btn-ghost:hover) {
  background: var(--color-bg-muted);
  border-color: var(--color-border-hover);
  transform: translateY(-1px);
}

.modal-footer :deep(.btn-primary) {
  background: var(--color-primary);
  color: white;
  border: 1px solid var(--color-primary);
  text-decoration: none;
}

.modal-footer :deep(.btn-primary:hover:not(:disabled)) {
  background: var(--color-primary-hover);
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
}

.modal-footer :deep(.btn-primary:disabled) {
  opacity: 0.6;
  cursor: not-allowed;
  transform: none;
}

</style>
