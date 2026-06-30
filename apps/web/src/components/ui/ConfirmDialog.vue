<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useConfirm, type ConfirmIcon } from '@/composables/useConfirm'

const { open, current, accept, choose, cancel } = useConfirm()

const confirmBtn = ref<HTMLButtonElement>()
const setPrimaryActionRef = (el: any) => {
  confirmBtn.value = (el as HTMLButtonElement | null) || undefined
}

const icon = computed<ConfirmIcon>(() => current.value?.icon ?? (current.value?.danger ? 'trash' : 'alert'))

// Esc / Enter while the dialog is open; focus the primary action on open.
const onKeydown = (e: KeyboardEvent) => {
  if (!open.value) return
  if (e.key === 'Escape') { e.preventDefault(); cancel() }
  else if (e.key === 'Enter') { e.preventDefault(); accept() }
}
watch(open, (isOpen) => {
  if (isOpen) {
    document.addEventListener('keydown', onKeydown)
    nextTick(() => confirmBtn.value?.focus())
  } else {
    document.removeEventListener('keydown', onKeydown)
  }
})
</script>

<template>
  <Teleport to="body">
    <Transition name="confirm">
      <div
        v-if="open && current"
        class="confirm-overlay"
        role="alertdialog"
        aria-modal="true"
        @click.self="cancel"
      >
        <div class="confirm-card" :class="{ danger: current.danger }">
          <div class="confirm-badge" :class="{ danger: current.danger }">
            <span class="confirm-badge-ring" aria-hidden="true"></span>
            <svg v-if="icon === 'trash'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><line x1="10" y1="11" x2="10" y2="17" /><line x1="14" y1="11" x2="14" y2="17" />
            </svg>
            <svg v-else-if="icon === 'reset'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="1 4 1 10 7 10" /><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
            </svg>
            <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          </div>

          <div class="confirm-text">
            <h3 v-if="current.title" class="confirm-title">{{ current.title }}</h3>
            <p class="confirm-message">{{ current.message }}</p>
          </div>

          <div class="confirm-actions">
            <button class="confirm-btn cancel" @click="cancel">{{ current.cancelText ?? '取消' }}</button>
            <template v-if="current.actions?.length">
              <button
                v-for="(action, index) in current.actions"
                :key="action.value"
                :ref="index === 0 ? setPrimaryActionRef : undefined"
                class="confirm-btn ok"
                :class="{ danger: action.variant === 'danger', ghost: action.variant === 'ghost' }"
                @click="choose(action.value)"
              >
                {{ action.label }}
              </button>
            </template>
            <button v-else ref="confirmBtn" class="confirm-btn ok" :class="{ danger: current.danger }" @click="accept">
              {{ current.confirmText ?? '确认' }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.confirm-overlay {
  position: fixed;
  inset: 0;
  z-index: 1200;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  background: rgba(9, 9, 16, 0.42);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
}

.confirm-card {
  width: 100%;
  max-width: 384px;
  display: grid;
  grid-template-columns: auto 1fr;
  grid-template-areas:
    'badge text'
    'actions actions';
  column-gap: 16px;
  row-gap: 18px;
  padding: 24px;
  background: var(--color-bg-card);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  box-shadow:
    0 1px 0 rgba(255, 255, 255, 0.04) inset,
    0 24px 60px -12px rgba(0, 0, 0, 0.32),
    0 8px 20px -8px rgba(0, 0, 0, 0.2);
}

/* ── Icon badge ─────────────────────────────────────────────────────────── */
.confirm-badge {
  grid-area: badge;
  position: relative;
  width: 44px;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 12px;
  color: var(--color-primary);
  background: color-mix(in srgb, var(--color-primary) 12%, transparent);
}
.confirm-badge.danger {
  color: var(--color-error);
  background: color-mix(in srgb, var(--color-error) 13%, transparent);
}
.confirm-badge svg { width: 22px; height: 22px; }

/* One-shot ring that blooms out of the badge as the dialog enters — the eye
   lands on the warning before reading the buttons. */
.confirm-badge-ring {
  position: absolute;
  inset: 0;
  border-radius: inherit;
  border: 1.5px solid currentColor;
  opacity: 0;
}
.confirm-enter-active .confirm-badge-ring { animation: badge-ring 0.6s ease-out 0.08s; }
@keyframes badge-ring {
  0%   { opacity: 0.5; transform: scale(1); }
  100% { opacity: 0; transform: scale(1.55); }
}

/* ── Text ───────────────────────────────────────────────────────────────── */
.confirm-text { grid-area: text; align-self: center; min-width: 0; }
.confirm-title {
  font-size: 15.5px;
  font-weight: 650;
  letter-spacing: -0.01em;
  color: var(--color-text);
  margin: 0 0 4px;
}
.confirm-message {
  font-size: 13.5px;
  line-height: 1.6;
  color: var(--color-text-secondary);
  margin: 0;
  word-break: break-word;
}

/* ── Actions ────────────────────────────────────────────────────────────── */
.confirm-actions {
  grid-area: actions;
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}
.confirm-btn {
  padding: 8px 18px;
  border: 1px solid transparent;
  border-radius: var(--radius);
  font-size: 13px;
  font-weight: 550;
  cursor: pointer;
  transition: transform var(--transition), background var(--transition), border-color var(--transition), box-shadow var(--transition);
}
.confirm-btn:active { transform: scale(0.97); }

.confirm-btn.cancel {
  background: transparent;
  border-color: var(--color-border);
  color: var(--color-text-secondary);
}
.confirm-btn.cancel:hover {
  background: var(--color-bg-muted);
  border-color: var(--color-border-hover);
  color: var(--color-text);
}

.confirm-btn.ok {
  background: var(--color-primary);
  color: #fff;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12);
}
.confirm-btn.ok:hover { background: var(--color-primary-hover); }
.confirm-btn.ok.danger { background: var(--color-error); }
.confirm-btn.ok.danger:hover { background: #dc2626; }
.confirm-btn.ok.ghost {
  background: transparent;
  border-color: var(--color-border);
  color: var(--color-text-secondary);
  box-shadow: none;
}
.confirm-btn.ok.ghost:hover {
  background: var(--color-bg-muted);
  border-color: var(--color-border-hover);
  color: var(--color-text);
}

/* ── Enter / leave motion ─────────────────────────────────────────────────── */
.confirm-enter-active { transition: opacity 0.2s ease; }
.confirm-leave-active { transition: opacity 0.16s ease; }
.confirm-enter-from, .confirm-leave-to { opacity: 0; }

.confirm-enter-active .confirm-card {
  animation: confirm-pop 0.34s cubic-bezier(0.34, 1.56, 0.64, 1);
}
.confirm-leave-active .confirm-card {
  transition: transform 0.16s ease, opacity 0.16s ease;
}
.confirm-leave-to .confirm-card { transform: scale(0.97); opacity: 0; }
@keyframes confirm-pop {
  from { transform: scale(0.92) translateY(14px); opacity: 0; }
  to   { transform: scale(1) translateY(0); opacity: 1; }
}

@media (prefers-reduced-motion: reduce) {
  .confirm-enter-active .confirm-card,
  .confirm-leave-active .confirm-card { animation: none; transition: none; }
  .confirm-enter-active .confirm-badge-ring { animation: none; }
  .confirm-btn:active { transform: none; }
}
</style>
