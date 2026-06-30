<script setup lang="ts">
const emit = defineEmits<{ upload: [] }>()
</script>

<template>
  <div class="empty">
    <div class="empty-content">
      <div class="empty-icon">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
          <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
          <line x1="12" y1="18" x2="12" y2="12"/>
          <line x1="9" y1="15" x2="15" y2="15"/>
        </svg>
      </div>
      <h2>选择或上传文献</h2>
      <p>请在左侧选择文献，或上传新的 PDF</p>
      <button class="upload-btn" @click="emit('upload')">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
        上传 PDF
      </button>
    </div>
  </div>
</template>

<style scoped>
.empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  padding: 24px;
}

.empty-content {
  text-align: center;
  max-width: 320px;
}

.empty-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 80px;
  height: 80px;
  border-radius: var(--radius-xl);
  background: var(--color-bg-muted);
  color: var(--color-text-muted);
  margin-bottom: 20px;
}

h2 {
  font-size: 18px;
  font-weight: 600;
  color: var(--color-text);
  margin-bottom: 8px;
  letter-spacing: -0.02em;
}

p {
  font-size: 14px;
  color: var(--color-text-muted);
  margin-bottom: 24px;
  line-height: 1.5;
}

.upload-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 10px 20px;
  border: none;
  border-radius: var(--radius);
  background: var(--color-primary);
  color: white;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: background var(--transition), transform var(--transition);
}

.upload-btn:hover {
  background: var(--color-primary-hover);
  transform: translateY(-1px);
}
</style>
