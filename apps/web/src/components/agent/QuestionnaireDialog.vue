<script setup lang="ts">
import { computed, reactive, ref, watch, onMounted, onBeforeUnmount } from 'vue'
import type { AgentInteractionRequest } from '@/stores/chat'
import { renderMarkdown as renderMd } from '@/lib/markdown'

interface QuestionOption {
  label: string
  description: string
  preview?: string
}

interface QuestionItem {
  question: string
  header: string
  options: QuestionOption[]
  multiSelect?: boolean
}

interface QuestionnairePayload {
  questions?: QuestionItem[]
}

type AnswerMode = 'option' | 'custom' | 'chat'

interface AnswerState {
  selected?: string
  selectedMany: string[]
  customText: string
  notes: string
  mode?: AnswerMode
}

const props = defineProps<{
  request: AgentInteractionRequest
  submitting?: boolean
  error?: string
}>()

const emit = defineEmits<{
  submit: [value: unknown]
  cancel: []
  chat: [value: unknown]
}>()

const activeIndex = ref(0)
const focusedLabels = reactive<Record<number, string>>({})
const validationError = ref('')
const answers = reactive<AnswerState[]>([])

const questions = computed(() => {
  const payload = props.request.payload as QuestionnairePayload
  return Array.isArray(payload?.questions) ? payload.questions : []
})

const ensureAnswerState = () => {
  answers.splice(0, answers.length, ...questions.value.map(() => ({ selectedMany: [], customText: '', notes: '' })))
  activeIndex.value = 0
  validationError.value = ''
  for (const key of Object.keys(focusedLabels)) delete focusedLabels[Number(key)]
}

// E3: Keyboard shortcuts
const onKeydown = (e: KeyboardEvent) => {
  // Esc → cancel
  if (e.key === 'Escape') {
    e.preventDefault()
    emit('cancel')
    return
  }
  // Enter (non-textarea) → submit
  if (e.key === 'Enter' && !e.shiftKey) {
    const target = e.target as HTMLElement
    if (target?.tagName === 'TEXTAREA') return // let textarea handle Enter
    e.preventDefault()
    submit()
    return
  }
  // Ctrl/Cmd+Enter → submit (from anywhere including textarea)
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault()
    submit()
    return
  }
  // 1-4 → select option for current question
  if (e.key >= '1' && e.key <= '4' && !(e.target as HTMLElement)?.matches?.('textarea, input')) {
    const idx = Number(e.key) - 1
    const question = activeQuestion.value
    if (question && idx < question.options.length) {
      selectOption(activeIndex.value, question.options[idx])
    }
  }
}

onMounted(() => { document.addEventListener('keydown', onKeydown) })
onBeforeUnmount(() => { document.removeEventListener('keydown', onKeydown) })

watch(() => props.request.requestId, ensureAnswerState, { immediate: true })

const activeQuestion = computed(() => questions.value[activeIndex.value])
const activeAnswer = computed(() => answers[activeIndex.value])
const hasPreview = computed(() => !!activeQuestion.value?.options?.some((option) => option.preview))
const activePreview = computed(() => {
  const question = activeQuestion.value
  if (!question) return ''
  const answer = activeAnswer.value
  const label = focusedLabels[activeIndex.value] || answer?.selected || question.options.find((option) => option.preview)?.label
  return question.options.find((option) => option.label === label)?.preview || ''
})

const escapeHtml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const renderPreview = (value: string) => {
  try { return renderMd(value) } catch { return escapeHtml(value).replace(/\n/g, '<br>') }
}

const selectOption = (questionIndex: number, option: QuestionOption) => {
  const question = questions.value[questionIndex]
  const answer = answers[questionIndex]
  if (!question || !answer) return
  focusedLabels[questionIndex] = option.label

  if (question.multiSelect) {
    const existing = answer.selectedMany.indexOf(option.label)
    if (existing >= 0) answer.selectedMany.splice(existing, 1)
    else answer.selectedMany.push(option.label)
    answer.mode = answer.selectedMany.length ? 'option' : undefined
    return
  }

  answer.selected = option.label
  answer.mode = 'option'
}

const setCustomMode = (questionIndex: number) => {
  const answer = answers[questionIndex]
  if (!answer) return
  if (answer.customText.trim()) answer.mode = 'custom'
}

const answerSummary = (questionIndex: number) => {
  const answer = answers[questionIndex]
  if (!answer?.mode) return ''
  if (answer.mode === 'custom') return answer.customText.trim() ? '已填写' : ''
  if (questions.value[questionIndex]?.multiSelect) return answer.selectedMany.length ? `已选 ${answer.selectedMany.length}` : ''
  return answer.selected || ''
}

const buildAnswers = (forceKind?: 'chat') => questions.value.map((question, questionIndex) => {
  const answer = answers[questionIndex]
  if (forceKind === 'chat') {
    return {
      questionIndex,
      question: question.question,
      kind: 'chat',
      answer: null,
      notes: 'User clicked Chat about this',
    }
  }

  if (answer?.mode === 'custom') {
    return {
      questionIndex,
      question: question.question,
      kind: 'custom',
      answer: answer.customText.trim(),
      notes: answer.notes?.trim() || undefined,
    }
  }

  if (question.multiSelect) {
    return {
      questionIndex,
      question: question.question,
      kind: 'multi',
      answer: answer?.selectedMany.join(', ') || null,
      selected: [...(answer?.selectedMany || [])],
      notes: answer?.notes?.trim() || undefined,
    }
  }

  const selected = answer?.selected || ''
  const option = question.options.find((item) => item.label === selected)
  return {
    questionIndex,
    question: question.question,
    kind: 'option',
    answer: selected,
    preview: option?.preview,
    notes: answer?.notes?.trim() || undefined,
  }
})

const validateAnswers = () => {
  for (const [questionIndex, question] of questions.value.entries()) {
    const answer = answers[questionIndex]
    const ok = answer?.mode === 'custom'
      ? !!answer.customText.trim()
      : question.multiSelect
        ? !!answer?.selectedMany.length
        : !!answer?.selected
    if (!ok) {
      activeIndex.value = questionIndex
      validationError.value = `请先回答「${question.header || `问题 ${questionIndex + 1}`}」`
      return false
    }
  }
  validationError.value = ''
  return true
}

const submit = () => {
  if (!validateAnswers()) return
  emit('submit', { answers: buildAnswers() })
}

const chatAboutThis = () => {
  validationError.value = ''
  emit('chat', { answers: buildAnswers('chat') })
}
</script>

<template>
  <section class="questionnaire-dialog" role="dialog" aria-modal="true">
    <header class="questionnaire-header">
      <div>
        <h3>{{ request.title || 'Agent 需要确认一些问题' }}</h3>
        <p>{{ request.message || '请选择或输入答案，提交后 Agent 会继续。' }}</p>
      </div>
      <button type="button" class="icon-btn" :disabled="submitting" title="取消" @click="emit('cancel')">✕</button>
    </header>

    <nav class="question-tabs" aria-label="问题列表">
      <button
        v-for="(question, index) in questions"
        :key="`${index}-${question.header}`"
        type="button"
        :class="['question-tab', { active: index === activeIndex, answered: !!answerSummary(index) }]"
        @click="activeIndex = index"
      >
        <span>{{ question.header || `问题 ${index + 1}` }}</span>
        <small v-if="answerSummary(index)">{{ answerSummary(index) }}</small>
      </button>
    </nav>

    <div v-if="activeQuestion" class="question-body" :class="{ 'with-preview': hasPreview }">
      <div class="question-main">
        <h4>{{ activeQuestion.question }}</h4>

        <div class="options-list">
          <button
            v-for="option in activeQuestion.options"
            :key="option.label"
            type="button"
            class="option-card"
            :class="{
              selected: activeQuestion.multiSelect
                ? activeAnswer?.selectedMany.includes(option.label)
                : activeAnswer?.selected === option.label,
            }"
            @mouseenter="focusedLabels[activeIndex] = option.label"
            @focus="focusedLabels[activeIndex] = option.label"
            @click="selectOption(activeIndex, option)"
          >
            <span class="option-control">{{ activeQuestion.multiSelect ? (activeAnswer?.selectedMany.includes(option.label) ? '☑' : '☐') : (activeAnswer?.selected === option.label ? '●' : '○') }}</span>
            <span class="option-content">
              <strong>{{ option.label }}</strong>
              <small>{{ option.description }}</small>
            </span>
          </button>
        </div>

        <label class="custom-answer">
          <span>自定义回答</span>
          <textarea
            v-model="activeAnswer.customText"
            rows="2"
            placeholder="如果以上选项不合适，可以在这里输入…"
            @input="setCustomMode(activeIndex)"
            @focus="activeAnswer.mode = activeAnswer.customText.trim() ? 'custom' : activeAnswer.mode"
          />
        </label>

        <label class="notes-field">
          <span>补充说明（可选）</span>
          <textarea
            v-model="activeAnswer.notes"
            rows="2"
            placeholder="补充上下文或说明…"
          />
        </label>
      </div>

      <aside v-if="hasPreview" class="preview-pane">
        <div class="preview-title">Preview</div>
        <div v-if="activePreview" class="preview-content" v-html="renderPreview(activePreview)" />
        <div v-else class="preview-empty">聚焦或选择带 preview 的选项后显示内容。</div>
      </aside>
    </div>

    <div v-else class="question-empty">该交互请求没有可显示的问题。</div>

    <footer class="questionnaire-footer">
      <p v-if="validationError || error" class="form-error">{{ validationError || error }}</p>
      <span v-else class="footer-hint">请求 ID: {{ request.requestId.slice(0, 8) }}</span>
      <div class="footer-actions">
        <button type="button" class="ghost-btn" :disabled="submitting" @click="chatAboutThis">继续聊天</button>
        <button type="button" class="ghost-btn" :disabled="submitting" @click="emit('cancel')">取消</button>
        <button type="button" class="primary-btn" :disabled="submitting || !questions.length" @click="submit">
          {{ submitting ? '提交中…' : '提交' }}
        </button>
      </div>
    </footer>
  </section>
</template>

<style scoped>
.questionnaire-dialog {
  width: min(760px, 100%);
  max-height: min(760px, calc(100vh - 56px));
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--color-border);
  border-radius: calc(var(--radius) + 4px);
  background: var(--color-bg-card);
  color: var(--color-text);
  box-shadow: 0 24px 70px rgba(0, 0, 0, 0.22);
}
.questionnaire-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 16px 18px 12px;
  border-bottom: 1px solid var(--color-border);
}
.questionnaire-header h3 { margin: 0; font-size: 16px; }
.questionnaire-header p { margin: 4px 0 0; color: var(--color-text-secondary); font-size: 12px; line-height: 1.5; }
.icon-btn {
  width: 28px;
  height: 28px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
}
.icon-btn:hover { background: var(--color-bg-muted); color: var(--color-text); }
.question-tabs {
  display: flex;
  gap: 6px;
  padding: 10px 14px;
  overflow-x: auto;
  border-bottom: 1px solid var(--color-border);
}
.question-tab {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  min-width: 92px;
  padding: 7px 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg);
  color: var(--color-text-secondary);
  cursor: pointer;
}
.question-tab.active { border-color: var(--color-primary); color: var(--color-primary); background: var(--color-primary-soft); }
.question-tab.answered:not(.active) { border-color: rgba(34, 197, 94, 0.35); }
.question-tab span { font-size: 12px; font-weight: 600; }
.question-tab small { max-width: 150px; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10px; color: var(--color-text-muted); }
.question-body {
  min-height: 0;
  display: grid;
  grid-template-columns: 1fr;
  gap: 14px;
  padding: 16px 18px;
  overflow: auto;
}
.question-body.with-preview { grid-template-columns: minmax(0, 1fr) minmax(240px, 0.8fr); }
.question-main { min-width: 0; }
.question-main h4 { margin: 0 0 12px; font-size: 14px; line-height: 1.5; }
.options-list { display: flex; flex-direction: column; gap: 8px; }
.option-card {
  width: 100%;
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 10px 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  background: var(--color-bg);
  color: var(--color-text);
  text-align: left;
  cursor: pointer;
}
.option-card:hover { border-color: var(--color-primary); background: var(--color-bg-muted); }
.option-card.selected { border-color: var(--color-primary); background: var(--color-primary-soft); }
.option-control { width: 18px; color: var(--color-primary); font-size: 13px; line-height: 1.35; }
.option-content { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.option-content strong { font-size: 13px; }
.option-content small { color: var(--color-text-secondary); font-size: 12px; line-height: 1.45; }
.custom-answer { display: flex; flex-direction: column; gap: 6px; margin-top: 14px; color: var(--color-text-secondary); font-size: 12px; }
.custom-answer textarea {
  resize: vertical;
  min-height: 60px;
  padding: 8px 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg);
  color: var(--color-text);
  font-family: inherit;
  font-size: 13px;
}
.custom-answer textarea:focus { outline: none; border-color: var(--color-primary); }
.notes-field { display: flex; flex-direction: column; gap: 6px; margin-top: 14px; color: var(--color-text-muted); font-size: 12px; }
.notes-field textarea {
  resize: vertical;
  min-height: 48px;
  padding: 8px 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg);
  color: var(--color-text);
  font-family: inherit;
  font-size: 13px;
}
.notes-field textarea:focus { outline: none; border-color: var(--color-primary); }
.preview-pane {
  min-width: 0;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  background: var(--color-bg-muted);
  overflow: hidden;
}
.preview-title {
  padding: 8px 10px;
  border-bottom: 1px solid var(--color-border);
  color: var(--color-text-secondary);
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.preview-content {
  padding: 10px;
  max-height: 360px;
  overflow: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
  line-height: 1.55;
  white-space: normal;
}
.preview-content :deep(pre) { margin: 0; white-space: pre-wrap; }
.preview-content :deep(p) { margin: 0 0 8px; }
.preview-content :deep(p:last-child) { margin-bottom: 0; }
.preview-empty { padding: 16px; color: var(--color-text-muted); font-size: 12px; }
.question-empty { padding: 24px; color: var(--color-text-muted); font-size: 13px; }
.questionnaire-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 14px;
  border-top: 1px solid var(--color-border);
  background: var(--color-bg-muted);
}
.footer-hint { color: var(--color-text-muted); font-size: 11px; }
.form-error { margin: 0; color: var(--color-error); font-size: 12px; }
.footer-actions { display: flex; gap: 8px; flex-shrink: 0; }
.ghost-btn, .primary-btn {
  padding: 8px 12px;
  border-radius: var(--radius-sm);
  font-size: 13px;
  cursor: pointer;
}
.ghost-btn { border: 1px solid var(--color-border); background: var(--color-bg-card); color: var(--color-text-secondary); }
.ghost-btn:hover { color: var(--color-text); border-color: var(--color-primary); }
.primary-btn { border: 1px solid var(--color-primary); background: var(--color-primary); color: white; }
.primary-btn:hover { background: var(--color-primary-hover); }
.ghost-btn:disabled, .primary-btn:disabled { opacity: 0.55; cursor: default; }
@media (max-width: 720px) {
  .questionnaire-dialog { max-height: calc(100vh - 32px); }
  .question-body.with-preview { grid-template-columns: 1fr; }
  .questionnaire-footer { align-items: stretch; flex-direction: column; }
  .footer-actions { justify-content: flex-end; }
}
</style>
