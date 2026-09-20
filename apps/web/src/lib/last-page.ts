import { START_LOCATION, type Router } from 'vue-router'

export const LAST_PAGE_STORAGE_KEY = 'yarc_last_page'

const restorablePages = new Set([
  'home', 'files', 'projects', 'project-workspace', 'project-settings',
  'paper-detail', 'settings',
])

// Register before authentication so a login redirect can retain the restored
// destination in its `next` query. Only a fresh visit to the bare root resumes.
export function installLastPageRestoration(router: Router, storage: Pick<Storage, 'getItem' | 'setItem'>) {
  router.beforeEach((to, from) => {
    if (from !== START_LOCATION || to.fullPath !== '/' || to.redirectedFrom) return
    try {
      const saved = storage.getItem(LAST_PAGE_STORAGE_KEY)
      if (!saved || saved === '/' || !saved.startsWith('/') || saved.startsWith('//')) return
      const target = router.resolve(saved)
      if (!restorablePages.has(String(target.name)) || target.fullPath === '/') return
      return { path: target.path, query: target.query, hash: target.hash, replace: true }
    } catch {
      // Unavailable storage or invalid stale records must not block navigation.
    }
  })

  router.afterEach((to, _from, failure) => {
    if (failure || !restorablePages.has(String(to.name))) return
    try {
      storage.setItem(LAST_PAGE_STORAGE_KEY, to.fullPath)
    } catch {
      // Browsing still works when persistence is unavailable.
    }
  })
}
