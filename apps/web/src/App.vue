<script setup lang="ts">
import { onMounted } from 'vue'
import { useThemeStore } from '@/stores/theme'
import { usePaperStore } from '@/stores/paper'
import { useWebDavSyncStore } from '@/stores/webdavSync'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import PaperReferenceDialog from '@/components/papers/PaperReferenceDialog.vue'

const theme = useThemeStore()
const paperStore = usePaperStore()
const webDavSyncStore = useWebDavSyncStore()

onMounted(() => {
  void theme.loadRemote()
  paperStore.connectSSE()
  webDavSyncStore.initialize()
})
</script>

<template>
  <router-view />
  <ConfirmDialog />
  <PaperReferenceDialog />
</template>
