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
      path: '/projects',
      name: 'projects',
      component: () => import('@/pages/ProjectsPage.vue'),
    },
    {
      path: '/projects/:id',
      name: 'project-workspace',
      component: () => import('@/pages/ProjectWorkspacePage.vue'),
    },
    {
      path: '/projects/:id/settings',
      name: 'project-settings',
      component: () => import('@/pages/ProjectSettingsPage.vue'),
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
