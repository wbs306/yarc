<script setup lang="ts">
import { ref, watch } from 'vue'
import { useApi, type OfficeViewMode } from '@/composables/useApi'

const props = defineProps<{
  path: string
  name: string
}>()

const api = useApi()

const modes: Array<{ value: OfficeViewMode; label: string }> = [
  { value: 'html', label: '预览' },
  { value: 'text', label: '文本' },
  { value: 'outline', label: '大纲' },
  { value: 'issues', label: '问题' },
  { value: 'stats', label: '统计' },
]

const activeMode = ref<OfficeViewMode>('html')
const content = ref('')
const loading = ref(false)
const error = ref('')
let requestSeq = 0

const loadPreview = async () => {
  const seq = ++requestSeq
  loading.value = true
  error.value = ''
  try {
    const res = await api.getOfficeView(props.path, activeMode.value)
    if (seq !== requestSeq) return
    content.value = res.content
  } catch (err) {
    if (seq !== requestSeq) return
    content.value = ''
    error.value = (err as Error).message || 'Office 预览失败'
  } finally {
    if (seq === requestSeq) loading.value = false
  }
}

watch(
  () => [props.path, activeMode.value] as const,
  () => { void loadPreview() },
  { immediate: true }
)
</script>

<template>
  <div class="office-preview">
    <div class="office-preview-toolbar">
      <div class="office-preview-title">
        <span class="office-preview-icon">📝</span>
        <span>{{ name }}</span>
      </div>
      <div class="office-preview-tabs" role="tablist" aria-label="Office 预览模式">
        <button
          v-for="mode in modes"
          :key="mode.value"
          type="button"
          :class="{ active: activeMode === mode.value }"
          :disabled="loading && activeMode === mode.value"
          @click="activeMode = mode.value"
        >
          {{ mode.label }}
        </button>
      </div>
    </div>

    <div v-if="loading" class="office-preview-state">正在用 officecli 生成预览…</div>
    <div v-else-if="error" class="office-preview-state error">
      <strong>无法预览 Office 文件</strong>
      <span>{{ error }}</span>
    </div>
    <iframe
      v-else-if="activeMode === 'html'"
      class="office-preview-frame"
      sandbox=""
      :title="`${name} 预览`"
      :srcdoc="content"
    />
    <pre v-else class="office-preview-text">{{ content || '没有可显示的内容。' }}</pre>
  </div>
</template>

<style scoped>
.office-preview {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  border: 1px solid var(--color-border);
  border-radius: 16px;
  overflow: hidden;
  background: rgba(var(--color-bg-rgb), 0.72);
}

.office-preview-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-bg-muted);
}

.office-preview-title {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  color: var(--color-text);
  font-size: 13px;
  font-weight: 600;
}

.office-preview-title span:last-child {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.office-preview-icon {
  flex: 0 0 auto;
}

.office-preview-tabs {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px;
}

.office-preview-tabs button {
  border: 1px solid var(--color-border);
  border-radius: 999px;
  padding: 5px 10px;
  background: var(--color-bg);
  color: var(--color-text-secondary);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.office-preview-tabs button:hover:not(:disabled),
.office-preview-tabs button.active {
  border-color: rgba(var(--color-primary-rgb), 0.4);
  background: rgba(var(--color-primary-rgb), 0.12);
  color: var(--color-primary);
}

.office-preview-tabs button:disabled {
  cursor: wait;
  opacity: 0.7;
}

.office-preview-frame {
  flex: 1;
  width: 100%;
  min-height: 0;
  border: 0;
  background: white;
}

.office-preview-text {
  flex: 1;
  min-height: 0;
  margin: 0;
  padding: 16px;
  overflow: auto;
  color: var(--color-text);
  background: transparent;
  font-family: 'JetBrains Mono', 'Fira Code', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
  line-height: 1.65;
  white-space: pre-wrap;
}

.office-preview-state {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px;
  color: var(--color-text-secondary);
  text-align: center;
}

.office-preview-state.error {
  color: var(--color-error);
}

.office-preview-state span {
  max-width: 520px;
  color: var(--color-text-secondary);
}
</style>
