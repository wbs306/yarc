<script setup lang="ts">
import { computed, ref, onMounted, onBeforeUnmount } from 'vue'
import { useChatStore, type AgentInteractionRequest, type AgentInteractionResponse } from '@/stores/chat'
import QuestionnaireDialog from './QuestionnaireDialog.vue'
import GenericInteractionDialog from './GenericInteractionDialog.vue'

const chatStore = useChatStore()
const error = ref('')
const submitting = ref(false)

const active = computed(() => chatStore.activeInteraction)
const notifications = computed(() => chatStore.notificationInteractions)

// E1: Timeout countdown
const now = ref(Date.now())
let countdownTimer: ReturnType<typeof setInterval> | null = null

onMounted(() => { countdownTimer = setInterval(() => { now.value = Date.now() }, 1000) })
onBeforeUnmount(() => { if (countdownTimer) clearInterval(countdownTimer) })

const remainingMs = computed(() => {
  const req = active.value
  if (!req?.timeoutMs || !req.createdAt) return null
  const elapsed = now.value - new Date(req.createdAt).getTime()
  return Math.max(0, req.timeoutMs - elapsed)
})

const remainingLabel = computed(() => {
  const ms = remainingMs.value
  if (ms === null) return ''
  const totalSec = Math.ceil(ms / 1000)
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
})

const countdownClass = computed(() => {
  const ms = remainingMs.value
  if (ms === null) return ''
  if (ms <= 10_000) return 'critical'
  if (ms <= 30_000) return 'warning'
  return ''
})

const respond = async (response: AgentInteractionResponse) => {
  error.value = ''
  submitting.value = true
  try {
    await chatStore.respondInteraction(response.requestId, response)
  } catch (err) {
    error.value = (err as Error).message || '提交交互响应失败'
  } finally {
    submitting.value = false
  }
}

const submit = (value: unknown) => {
  if (!active.value) return
  respond({ requestId: active.value.requestId, action: 'submit', value })
}

const cancel = () => {
  if (!active.value) return
  respond({ requestId: active.value.requestId, action: 'cancel' })
}

const chat = (value: unknown) => {
  if (!active.value) return
  respond({ requestId: active.value.requestId, action: 'chat', value })
}

const notificationMessage = (request: AgentInteractionRequest) => {
  const payload = request.payload as any
  return payload?.message || request.message || request.title || 'Agent notification'
}

const notificationType = (request: AgentInteractionRequest) => {
  const payload = request.payload as any
  return payload?.notifyType || 'info'
}
</script>

<template>
  <div class="agent-notifications" v-if="notifications.length">
    <button
      v-for="item in notifications"
      :key="item.requestId"
      type="button"
      class="agent-notification"
      :class="notificationType(item)"
      @click="chatStore.dismissInteraction(item.requestId)"
    >
      <strong>{{ item.title || 'Agent 通知' }}</strong>
      <span>{{ notificationMessage(item) }}</span>
    </button>
  </div>

  <div v-if="active" class="agent-interaction-host">
    <div v-if="remainingLabel" class="interaction-countdown" :class="countdownClass">
      剩余 {{ remainingLabel }}
    </div>
    <QuestionnaireDialog
      v-if="active.kind === 'questionnaire'"
      :request="active"
      :submitting="submitting"
      :error="error"
      @submit="submit"
      @cancel="cancel"
      @chat="chat"
    />
    <GenericInteractionDialog
      v-else
      :request="active"
      :submitting="submitting"
      :error="error"
      @submit="submit"
      @cancel="cancel"
    />
  </div>
</template>

<style scoped>
.agent-interaction-host {
  position: absolute;
  inset: 0;
  z-index: 40;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 18px;
  background: rgba(15, 23, 42, 0.22);
}
.agent-notifications {
  position: absolute;
  top: 54px;
  right: 12px;
  z-index: 60;
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: min(340px, calc(100% - 24px));
}
.agent-notification {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 10px 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  background: var(--color-bg-card);
  color: var(--color-text);
  text-align: left;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.16);
  cursor: pointer;
}
.agent-notification strong { font-size: 12px; }
.agent-notification span { color: var(--color-text-secondary); font-size: 12px; line-height: 1.45; }
.agent-notification.warning { border-color: rgba(245, 158, 11, 0.45); }
.agent-notification.error { border-color: rgba(239, 68, 68, 0.45); }

.interaction-countdown {
  position: absolute;
  top: 12px;
  right: 12px;
  z-index: 50;
  padding: 4px 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  background: var(--color-bg-muted);
  color: var(--color-text-secondary);
  border: 1px solid var(--color-border);
}
.interaction-countdown.warning {
  background: rgba(245, 158, 11, 0.12);
  color: #b45309;
  border-color: rgba(245, 158, 11, 0.35);
}
.interaction-countdown.critical {
  background: rgba(239, 68, 68, 0.12);
  color: #ef4444;
  border-color: rgba(239, 68, 68, 0.35);
  animation: pulse-countdown 1s ease-in-out infinite;
}
@keyframes pulse-countdown {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.6; }
}
</style>
