<script setup lang="ts">
import { computed, ref } from 'vue'
import { useChatStore, type AgentInteractionRequest, type AgentInteractionResponse } from '@/stores/chat'
import QuestionnaireDialog from './QuestionnaireDialog.vue'
import GenericInteractionDialog from './GenericInteractionDialog.vue'
import ExtensionTuiSurface from './ExtensionTuiSurface.vue'

const chatStore = useChatStore()
const error = ref('')
const submitting = ref(false)

const active = computed(() => chatStore.activeInteraction)
const notifications = computed(() => chatStore.notificationInteractions)
// Keep pending questionnaires mounted while hidden so their answer drafts survive.
const questionnaires = computed(() => Object.values(chatStore.interactions)
  .filter(request => request.kind === 'questionnaire'))
const overlaySurfaces = computed(() => Object.values(chatStore.tuiSurfaces)
  .filter(surface => surface.overlay || surface.kind === 'custom'))

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
  <ExtensionTuiSurface
    v-for="surface in overlaySurfaces"
    :key="surface.surfaceId"
    :surface="surface"
  />

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

  <div v-show="active" class="agent-interaction-host">
    <QuestionnaireDialog
      v-for="request in questionnaires"
      :key="request.requestId"
      v-show="active?.requestId === request.requestId"
      :visible="active?.requestId === request.requestId"
      :request="request"
      :submitting="submitting"
      :error="error"
      @submit="submit"
      @cancel="cancel"
      @chat="chat"
      @hide="chatStore.hideInteraction(request.requestId)"
    />
    <GenericInteractionDialog
      v-if="active && active.kind !== 'questionnaire'"
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

</style>
