import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import '@fontsource/jetbrains-mono/600.css'
import '@fontsource/jetbrains-mono/700.css'
import 'katex/dist/katex.min.css'
import './styles/main.css'

const PRELOAD_RELOAD_KEY = 'yarc_preload_reload_at'
const PRELOAD_RELOAD_COOLDOWN_MS = 10_000
let preloadReloadAt = 0
try { preloadReloadAt = Number(sessionStorage.getItem(PRELOAD_RELOAD_KEY) || 0) } catch { /* storage can be unavailable */ }

// A long-lived tab can reference an old hashed chunk after a frontend rebuild.
// Reload once so index.html and all lazy-loaded chunks come from the same build.
window.addEventListener('vite:preloadError', (event) => {
  event.preventDefault()
  const now = Date.now()
  if (now - preloadReloadAt < PRELOAD_RELOAD_COOLDOWN_MS) return
  preloadReloadAt = now
  try { sessionStorage.setItem(PRELOAD_RELOAD_KEY, String(now)) } catch { /* storage can be unavailable */ }
  window.location.reload()
})
window.setTimeout(() => {
  preloadReloadAt = 0
  try { sessionStorage.removeItem(PRELOAD_RELOAD_KEY) } catch { /* storage can be unavailable */ }
}, PRELOAD_RELOAD_COOLDOWN_MS)

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')

// Register the PWA Service Worker (currently also handles PDF caching).
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch((error: unknown) => {
    console.warn('[YARC] Service Worker registration failed:', error)
  })
}
