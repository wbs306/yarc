<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useThemeStore } from '@/stores/theme'
import { usePaperStore } from '@/stores/paper'
import { useWebDavSyncStore } from '@/stores/webdavSync'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import PaperReferenceDialog from '@/components/papers/PaperReferenceDialog.vue'

const route = useRoute()
const router = useRouter()
const theme = useThemeStore()
const paperStore = usePaperStore()
const webDavSyncStore = useWebDavSyncStore()
const showWorkspaceNav = computed(() => route.name !== 'login')
const activeArea = computed(() => {
  if (String(route.path).startsWith('/projects')) return 'projects'
  if (route.name === 'files') return 'files'
  if (route.name === 'settings') return 'settings'
  return 'papers'
})

onMounted(() => {
  void theme.loadRemote()
  paperStore.connectSSE()
  webDavSyncStore.initialize()
})
</script>

<template>
  <router-view />
  <nav v-if="showWorkspaceNav" class="workspace-nav" aria-label="YARC workspace navigation">
    <button :class="{ active: activeArea === 'papers' }" @click="router.push('/')">文献</button>
    <button :class="{ active: activeArea === 'projects' }" @click="router.push('/projects')">项目</button>
    <button :class="{ active: activeArea === 'files' }" @click="router.push('/files')">文件</button>
    <button :class="{ active: activeArea === 'settings' }" @click="router.push('/settings')">设置</button>
  </nav>
  <ConfirmDialog />
  <PaperReferenceDialog />
</template>

<style scoped>
.workspace-nav{position:fixed;z-index:1200;left:50%;bottom:12px;transform:translateX(-50%);display:flex;gap:3px;padding:4px;border:1px solid color-mix(in srgb,var(--text-primary,#eee) 18%,transparent);border-radius:10px;background:color-mix(in srgb,var(--bg-primary,#171717) 92%,transparent);box-shadow:0 8px 30px rgba(0,0,0,.28);backdrop-filter:blur(12px)}
.workspace-nav button{border:0;border-radius:7px;padding:6px 11px;background:transparent;color:var(--text-secondary,#aaa);font-size:12px;cursor:pointer}.workspace-nav button.active{background:color-mix(in srgb,var(--accent-color,#6d7cff) 24%,transparent);color:var(--text-primary,#fff)}
@media(max-width:640px){.workspace-nav{bottom:7px}.workspace-nav button{padding:6px 8px}}
</style>
