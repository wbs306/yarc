<script setup lang="ts">
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useApi } from '@/composables/useApi'

const route = useRoute()
const router = useRouter()
const api = useApi()

const password = ref('')
const error = ref('')
const loading = ref(false)
const inputEl = ref<HTMLInputElement>()

const login = async () => {
  if (!password.value) {
    error.value = '请输入密码'
    inputEl.value?.focus()
    return
  }
  loading.value = true
  error.value = ''
  try {
    await api.login(password.value)
    localStorage.setItem('yarc_auth', '1')
    const next = typeof route.query.next === 'string' ? route.query.next : '/'
    router.push(next.startsWith('/') ? next : '/')
  } catch (err) {
    error.value = (err as Error).message || '登录失败'
    password.value = ''
    inputEl.value?.focus()
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="login-page">
    <div class="login-card">
      <!-- Logo -->
      <div class="login-logo">
        <div class="logo-icon">Y</div>
        <h1>YARC</h1>
        <p>Research Workbench</p>
      </div>

      <!-- Form -->
      <form @submit.prevent="login" class="login-form">
        <div class="input-group">
          <input
            ref="inputEl"
            v-model="password"
            type="password"
            placeholder="输入密码以继续"
            autofocus
            :class="{ error: error }"
          />
          <p v-if="error" class="input-error">{{ error }}</p>
        </div>

        <button type="submit" :disabled="loading" class="btn-primary">
          <span v-if="loading" class="spinner" />
          {{ loading ? '' : '进入' }}
        </button>
      </form>
    </div>
  </div>
</template>

<style scoped>
.login-page {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  padding: 20px;
  background: var(--color-bg);
}

.login-card {
  width: 100%;
  max-width: 360px;
}

.login-logo {
  text-align: center;
  margin-bottom: 40px;
}

.logo-icon {
  width: 56px;
  height: 56px;
  margin: 0 auto 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--color-primary);
  color: white;
  font-size: 24px;
  font-weight: 700;
  border-radius: var(--radius-lg);
  letter-spacing: -0.02em;
}

.login-logo h1 {
  font-size: 24px;
  font-weight: 700;
  letter-spacing: -0.03em;
  color: var(--color-text);
}

.login-logo p {
  font-size: 14px;
  color: var(--color-text-muted);
  margin-top: 4px;
}

.login-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.input-group input {
  width: 100%;
  padding: 12px 16px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  background: var(--color-bg-card);
  color: var(--color-text);
  font-size: 15px;
  transition: border-color var(--transition), box-shadow var(--transition);
}

.input-group input:focus {
  outline: none;
  border-color: var(--color-primary);
  box-shadow: 0 0 0 3px var(--color-primary-soft);
}

.input-group input.error {
  border-color: var(--color-error);
}

.input-error {
  font-size: 13px;
  color: var(--color-error);
  margin-top: 6px;
}

.btn-primary {
  width: 100%;
  padding: 12px;
  border: none;
  border-radius: var(--radius);
  background: var(--color-primary);
  color: white;
  font-size: 15px;
  font-weight: 500;
  cursor: pointer;
  transition: background var(--transition), opacity var(--transition);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}

.btn-primary:hover { background: var(--color-primary-hover); }
.btn-primary:disabled { opacity: 0.6; cursor: not-allowed; }

.spinner {
  width: 18px;
  height: 18px;
  border: 2px solid rgba(255,255,255,0.3);
  border-top-color: white;
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}

@keyframes spin { to { transform: rotate(360deg); } }

/* Entrance: logo, field, then button rise in sequence. */
.login-logo { animation: login-rise 0.55s cubic-bezier(0.22, 1, 0.36, 1) both; }
.login-form .input-group { animation: login-rise 0.55s cubic-bezier(0.22, 1, 0.36, 1) 0.09s both; }
.login-form .btn-primary { animation: login-rise 0.55s cubic-bezier(0.22, 1, 0.36, 1) 0.18s both; }
.logo-icon { animation: logo-pop 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) 0.1s both; }
@keyframes login-rise { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: translateY(0); } }
@keyframes logo-pop { from { opacity: 0; transform: scale(0.6); } to { opacity: 1; transform: scale(1); } }

@media (prefers-reduced-motion: reduce) {
  .login-logo, .login-form .input-group, .login-form .btn-primary, .logo-icon { animation: none; }
}
</style>
