import { defineStore } from 'pinia'
import { ref, watch } from 'vue'

// Lightweight client-only preferences shared across components (search box, settings).
// Persisted to localStorage; reactive so changing a default in Settings updates the
// already-mounted search bar live.
export type SearchSource = 'local' | 'ieee' | 'semantic_scholar'

export const usePrefsStore = defineStore('prefs', () => {
  const searchSource = ref<SearchSource>(
    (localStorage.getItem('yarc_search_source') as SearchSource) || 'semantic_scholar'
  )
  const searchPageSize = ref<number>(Number(localStorage.getItem('yarc_search_page_size')) || 20)
  const workspaceAutoSaveOnSwitch = ref<boolean>(localStorage.getItem('yarc_workspace_auto_save_on_switch') === 'true')

  watch(searchSource, (v) => localStorage.setItem('yarc_search_source', v))
  watch(searchPageSize, (v) => localStorage.setItem('yarc_search_page_size', String(v)))
  watch(workspaceAutoSaveOnSwitch, (v) => localStorage.setItem('yarc_workspace_auto_save_on_switch', String(v)))

  return { searchSource, searchPageSize, workspaceAutoSaveOnSwitch }
})
