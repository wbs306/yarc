<script setup lang="ts">
import { computed, ref, watch, onMounted, onBeforeUnmount } from 'vue'
import type { AgentInteractionRequest } from '@/stores/chat'

const props = defineProps<{
  request: AgentInteractionRequest
  submitting?: boolean
  error?: string
}>()

const emit = defineEmits<{
  submit: [value: unknown]
  cancel: []
}>()

const inputValue = ref('')
const selectedValue = ref('')
const selectedMany = ref<string[]>([])

const payload = computed(() => (props.request.payload || {}) as any)
const options = computed(() => Array.isArray(payload.value.options) ? payload.value.options : [])
const isMulti = computed(() => !!payload.value.multi)

watch(() => props.request.requestId, () => {
  inputValue.value = typeof payload.value.defaultValue === 'string' ? payload.value.defaultValue : ''
  selectedValue.value = ''
  selectedMany.value = []
}, { immediate: true })

const optionValue = (option: any) => String(option?.value ?? option?.label ?? option)
const optionLabel = (option: any) => String(option?.label ?? option?.value ?? option)
const optionDescription = (option: any) => typeof option?.description === 'string' ? option.description : ''

const toggleMulti = (value: string) => {
  const index = selectedMany.value.indexOf(value)
  if (index >= 0) selectedMany.value.splice(index, 1)
  else selectedMany.value.push(value)
}

// E3: Keyboard shortcuts for generic dialogs
const onKeydown = (e: KeyboardEvent) => {
  if (e.key === 'Escape') {
    e.preventDefault()
    emit('cancel')
    return
  }
  // Enter → submit (non-textarea)
  if (e.key === 'Enter' && !e.shiftKey) {
    const target = e.target as HTMLElement
    if (target?.tagName === 'TEXTAREA') return
    e.preventDefault()
    submit()
    return
  }
  // Ctrl/Cmd+Enter → submit from textarea
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault()
    submit()
    return
  }
  // 1-4 for select options
  if (props.request.kind === 'select' && e.key >= '1' && e.key <= '4' && !(e.target as HTMLElement)?.matches?.('textarea, input')) {
    const idx = Number(e.key) - 1
    if (idx < options.value.length) {
      const val = optionValue(options.value[idx])
      if (isMulti.value) toggleMulti(val)
      else selectedValue.value = val
    }
  }
}

onMounted(() => { document.addEventListener('keydown', onKeydown) })
onBeforeUnmount(() => { document.removeEventListener('keydown', onKeydown) })

const submit = () => {
  if (props.request.kind === 'confirm') {
    emit('submit', { confirmed: true })
    return
  }
  if (props.request.kind === 'select') {
    emit('submit', isMulti.value ? { value: [...selectedMany.value] } : { value: selectedValue.value })
    return
  }
  if (props.request.kind === 'input') {
    emit('submit', { value: inputValue.value })
  }
}
</script>

<template>
  <section class="generic-dialog" role="dialog" aria-modal="true">
    <header>
      <div>
        <h3>{{ request.title || payload.title || 'Agent 请求交互' }}</h3>
        <p v-if="request.message || payload.message">{{ request.message || payload.message }}</p>
      </div>
      <button type="button" class="icon-btn" :disabled="submitting" @click="emit('cancel')">✕</button>
    </header>

    <main>
      <template v-if="request.kind === 'confirm'">
        <p class="confirm-message">{{ payload.message || request.message || '请确认是否继续。' }}</p>
      </template>

      <template v-else-if="request.kind === 'select'">
        <div class="select-options">
          <button
            v-for="option in options"
            :key="optionValue(option)"
            type="button"
            class="select-option"
            :class="{ selected: isMulti ? selectedMany.includes(optionValue(option)) : selectedValue === optionValue(option) }"
            @click="isMulti ? toggleMulti(optionValue(option)) : selectedValue = optionValue(option)"
          >
            <span>{{ isMulti ? (selectedMany.includes(optionValue(option)) ? '☑' : '☐') : (selectedValue === optionValue(option) ? '●' : '○') }}</span>
            <strong>{{ optionLabel(option) }}</strong>
            <small v-if="optionDescription(option)">{{ optionDescription(option) }}</small>
          </button>
        </div>
      </template>

      <template v-else-if="request.kind === 'input'">
        <textarea
          v-if="payload.multiline"
          v-model="inputValue"
          rows="8"
          :placeholder="payload.placeholder || '请输入…'"
          class="text-input multiline"
        />
        <input
          v-else
          v-model="inputValue"
          :placeholder="payload.placeholder || '请输入…'"
          class="text-input"
          autofocus
        />
      </template>

      <p v-if="error" class="form-error">{{ error }}</p>
    </main>

    <footer>
      <button type="button" class="ghost-btn" :disabled="submitting" @click="emit('cancel')">
        {{ payload.cancelText || '取消' }}
      </button>
      <button
        type="button"
        class="primary-btn"
        :class="{ danger: payload.danger }"
        :disabled="submitting || (request.kind === 'select' && (isMulti ? !selectedMany.length : !selectedValue))"
        @click="submit"
      >
        {{ submitting ? '提交中…' : (payload.confirmText || '提交') }}
      </button>
    </footer>
  </section>
</template>

<style scoped>
.generic-dialog {
  width: min(520px, 100%);
  overflow: hidden;
  border: 1px solid var(--color-border);
  border-radius: calc(var(--radius) + 4px);
  background: var(--color-bg-card);
  color: var(--color-text);
  box-shadow: 0 24px 70px rgba(0, 0, 0, 0.22);
}
header { display: flex; justify-content: space-between; gap: 12px; padding: 16px 18px 12px; border-bottom: 1px solid var(--color-border); }
h3 { margin: 0; font-size: 16px; }
p { margin: 4px 0 0; color: var(--color-text-secondary); font-size: 13px; line-height: 1.5; }
main { padding: 16px 18px; }
footer { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 14px; border-top: 1px solid var(--color-border); background: var(--color-bg-muted); }
.icon-btn { width: 28px; height: 28px; border: none; border-radius: var(--radius-sm); background: transparent; color: var(--color-text-muted); cursor: pointer; }
.icon-btn:hover { background: var(--color-bg-muted); color: var(--color-text); }
.confirm-message { margin: 0; white-space: pre-wrap; }
.select-options { display: flex; flex-direction: column; gap: 8px; }
.select-option { display: grid; grid-template-columns: auto 1fr; gap: 4px 8px; align-items: start; width: 100%; padding: 10px 12px; border: 1px solid var(--color-border); border-radius: var(--radius); background: var(--color-bg); color: var(--color-text); text-align: left; cursor: pointer; }
.select-option:hover, .select-option.selected { border-color: var(--color-primary); background: var(--color-primary-soft); }
.select-option small { grid-column: 2; color: var(--color-text-secondary); font-size: 12px; line-height: 1.45; }
.text-input { width: 100%; box-sizing: border-box; padding: 9px 10px; border: 1px solid var(--color-border); border-radius: var(--radius-sm); background: var(--color-bg); color: var(--color-text); font: inherit; }
.text-input.multiline { resize: vertical; }
.text-input:focus { outline: none; border-color: var(--color-primary); }
.form-error { color: var(--color-error); }
.ghost-btn, .primary-btn { padding: 8px 12px; border-radius: var(--radius-sm); font-size: 13px; cursor: pointer; }
.ghost-btn { border: 1px solid var(--color-border); background: var(--color-bg-card); color: var(--color-text-secondary); }
.primary-btn { border: 1px solid var(--color-primary); background: var(--color-primary); color: white; }
.primary-btn.danger { border-color: var(--color-error); background: var(--color-error); }
.ghost-btn:disabled, .primary-btn:disabled { opacity: 0.55; cursor: default; }
</style>
