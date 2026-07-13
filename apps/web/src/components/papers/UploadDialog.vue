<script setup lang="ts">
import { ref } from 'vue'
import { usePaperStore } from '@/stores/paper'
import { useApi } from '@/composables/useApi'

const props = defineProps<{
  categoryId?: string | null
}>()

const emit = defineEmits<{ close: [] }>()
const api = useApi()
const paperStore = usePaperStore()

const dragover = ref(false)
const uploading = ref(false)
const progress = ref(0)
const error = ref('')
const done = ref(0)
const total = ref(0)
const errors = ref<string[]>([])

const handleDrop = async (e: DragEvent) => {
  e.preventDefault()
  dragover.value = false
  const files = e.dataTransfer?.files
  if (files?.length) await uploadFiles(Array.from(files).filter(f => f.name.toLowerCase().endsWith('.pdf')))
}

const handleFileSelect = async (e: Event) => {
  const fileList = (e.target as HTMLInputElement).files
  if (fileList?.length) await uploadFiles(Array.from(fileList))
}

const uploadFiles = async (files: File[]) => {
  if (!files.length) {
    error.value = '请选择 PDF 文件'
    return
  }
  uploading.value = true
  error.value = ''
  errors.value = []
  done.value = 0
  total.value = files.length
  progress.value = 0

  try {
    if (files.length === 1) {
      // Single file — use backward-compatible endpoint
      await api.uploadPaper(files[0], undefined, props.categoryId)
      done.value = 1
      progress.value = 100
    } else {
      // Batch upload
      const res = await api.uploadPapers(files, props.categoryId)
      done.value = res.papers?.length || 0
      progress.value = 100
      if (res.errors?.length) {
        errors.value = res.errors.map(e => `${e.fileName}: ${e.message}`)
      }
    }
    await paperStore.fetchPapers()
    setTimeout(() => emit('close'), 600)
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    uploading.value = false
  }
}
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div class="dialog">
      <div class="dialog-header">
        <h3>上传文献</h3>
        <button class="close-btn" @click="emit('close')">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>

      <div
        class="dropzone"
        :class="{ dragover, uploading }"
        @dragover.prevent="dragover = true"
        @dragleave="dragover = false"
        @drop="handleDrop"
        @click="($refs.fileInput as HTMLInputElement)?.click()"
      >
        <input ref="fileInput" type="file" accept=".pdf" multiple class="hidden" @change="handleFileSelect" />

        <template v-if="!uploading">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" class="drop-icon">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
          </svg>
          <p class="drop-text">拖拽 PDF 到此处，或点击选择</p>
          <p class="drop-hint">支持多选，最大 50MB / 个</p>
        </template>

        <template v-else>
          <div class="progress-ring">
            <svg width="48" height="48" viewBox="0 0 48 48">
              <circle cx="24" cy="24" r="20" fill="none" stroke="var(--color-bg-muted)" stroke-width="3" />
              <circle cx="24" cy="24" r="20" fill="none" stroke="var(--color-primary)" stroke-width="3" stroke-linecap="round"
                :stroke-dasharray="125.6" :stroke-dashoffset="125.6 * (1 - progress / 100)"
                transform="rotate(-90 24 24)" style="transition: stroke-dashoffset 0.3s" />
            </svg>
            <span class="progress-text">{{ total > 1 ? `${done}/${total}` : `${progress}%` }}</span>
          </div>
        </template>
      </div>

      <p v-if="error" class="error-text">{{ error }}</p>
      <div v-if="errors.length" class="error-text">
        <p v-for="e in errors" :key="e">{{ e }}</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  min-height: 100dvh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.5);
  z-index: 100;
  padding: 20px;
  padding-bottom: calc(20px + env(safe-area-inset-bottom, 0px));
}

.dialog {
  width: 100%;
  max-width: 420px;
  max-height: calc(100dvh - 40px - env(safe-area-inset-bottom, 0px));
  background: var(--color-bg-card);
  border-radius: var(--radius-lg);
  border: 1px solid var(--color-border);
  box-shadow: var(--shadow-lg);
  overflow: auto;
}

.dialog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--color-border);
}

.dialog-header h3 {
  font-size: 15px;
  font-weight: 600;
  color: var(--color-text);
}

.close-btn {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--color-text-muted);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background var(--transition);
}

.close-btn:hover { background: var(--color-bg-muted); }

.dropzone {
  margin: 20px;
  padding: 40px 20px;
  border: 2px dashed var(--color-border);
  border-radius: var(--radius);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  transition: border-color var(--transition), background var(--transition);
}

.dropzone:hover, .dropzone.dragover {
  border-color: var(--color-primary);
  background: var(--color-primary-soft);
}

.drop-icon { color: var(--color-text-muted); }
.dropzone:hover .drop-icon, .dropzone.dragover .drop-icon { color: var(--color-primary); }

.drop-text { font-size: 14px; color: var(--color-text-secondary); }
.drop-hint { font-size: 12px; color: var(--color-text-muted); }

.progress-ring {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
}

.progress-text {
  position: absolute;
  font-size: 12px;
  font-weight: 600;
  color: var(--color-primary);
}

.error-text {
  padding: 0 20px 16px;
  font-size: 13px;
  color: var(--color-error);
  text-align: center;
}

.hidden { display: none; }
</style>
