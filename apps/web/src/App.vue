<script setup lang="ts">
import { onMounted } from 'vue'
import { useThemeStore } from '@/stores/theme'
import { usePaperStore } from '@/stores/paper'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'

const theme = useThemeStore()
const paperStore = usePaperStore()

onMounted(() => {
  void theme.loadRemote()
  paperStore.connectSSE()
})
</script>

<template>
  <router-view />
  <ConfirmDialog />
</template>
