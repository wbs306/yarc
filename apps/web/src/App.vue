<script setup lang="ts">
import { watch } from 'vue'
import { useRoute } from 'vue-router'
import { useThemeStore } from '@/stores/theme'
import { usePaperStore } from '@/stores/paper'
import { useWebDavSyncStore } from '@/stores/webdavSync'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import PaperReferenceDialog from '@/components/papers/PaperReferenceDialog.vue'

const theme = useThemeStore()
const paperStore = usePaperStore()
const webDavSyncStore = useWebDavSyncStore()

const route = useRoute()
watch(() => !!route.name && route.name !== 'login', (authenticatedPage) => {
  if (!authenticatedPage) return
  void theme.loadRemote()
  paperStore.connectSSE()
  webDavSyncStore.initialize()
}, { immediate: true })
</script>

<template>
  <router-view v-slot="{ Component }">
    <component :is="Component" v-if="Component" />
    <div v-else class="startup-shell" aria-busy="true">
      <div class="app-header startup-header">YARC</div>
      <main class="app-main startup-main" role="status">正在加载工作台…</main>
    </div>
  </router-view>
  <ConfirmDialog />
  <PaperReferenceDialog />
</template>

<style scoped>
.startup-shell { height: 100dvh; display: flex; flex-direction: column; }
.startup-header { height: 56px; flex-shrink: 0; display: flex; align-items: center; padding: 0 24px; font-weight: 700; border-bottom: 1px solid var(--color-border); }
.startup-main { flex: 1; display: grid; place-items: center; color: var(--color-text-muted); }
</style>
