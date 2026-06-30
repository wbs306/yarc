import { createRouter, createWebHistory } from 'vue-router'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      name: 'home',
      component: () => import('@/pages/PapersPage.vue'),
    },
    {
      path: '/login',
      name: 'login',
      component: () => import('@/pages/LoginPage.vue'),
    },
    {
      path: '/papers',
      redirect: '/',
    },
    {
      path: '/paper/:id',
      name: 'paper-detail',
      component: () => import('@/pages/PapersPage.vue'),
    },
    {
      path: '/files',
      name: 'files',
      component: () => import('@/pages/PapersPage.vue'),
    },
    {
      path: '/settings',
      name: 'settings',
      component: () => import('@/pages/PapersPage.vue'),
    },
  ],
})

async function hasValidSession(): Promise<boolean> {
  try {
    const res = await fetch('/api/auth/me', { credentials: 'include' })
    if (res.ok) {
      localStorage.setItem('yarc_auth', '1')
      return true
    }
  } catch {}
  localStorage.removeItem('yarc_auth')
  return false
}

// Auth guard checks the real HttpOnly cookie, not only localStorage. This avoids
// showing an empty app when localStorage says logged-in but the API cookie is
// missing for the current host/port.
router.beforeEach(async (to) => {
  const loggedIn = await hasValidSession()

  if (to.name === 'login') {
    return loggedIn ? { name: 'home' } : true
  }

  if (!loggedIn) {
    return { name: 'login', query: { next: to.fullPath } }
  }

  return true
})

export default router
