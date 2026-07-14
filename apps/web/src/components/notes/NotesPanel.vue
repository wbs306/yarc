<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useNoteStore, type Note } from '@/stores/note'
import { confirm } from '@/composables/useConfirm'
import MarkdownContent from '@/components/markdown/MarkdownContent.vue'

const props = defineProps<{ paperId: string; page: number }>()
const emit = defineEmits<{ close: []; 'click-note': [note: any] }>()
const noteStore = useNoteStore()

const newNote = ref('')
const editingId = ref<string | null>(null)
const editContent = ref('')

const pageNotes = computed(() => noteStore.notes.filter(n => n.pageNumber === props.page || !n.pageNumber))

onMounted(() => noteStore.fetchNotes(props.paperId))
watch(() => props.paperId, id => { if (id) noteStore.fetchNotes(id) })

const saveNote = async () => {
  if (!newNote.value.trim()) return
  await noteStore.createNote({ paperId: props.paperId, content: newNote.value, pageNumber: props.page, kind: 'note' })
  newNote.value = ''
}

const startEdit = (note: Note) => { editingId.value = note.id; editContent.value = note.content }
const saveEdit = async () => { if (editingId.value) { await noteStore.updateNote(editingId.value, { content: editContent.value }); editingId.value = null } }
const cancelEdit = () => { editingId.value = null }
const deleteNote = async (id: string) => {
  if (await confirm({ title: '删除笔记', message: '这条笔记将被永久删除。', confirmText: '删除', danger: true, icon: 'trash' }))
    await noteStore.deleteNote(id)
}
</script>

<template>
  <div class="notes-panel">
    <div class="notes-header">
      <span>📝 笔记</span>
      <button class="close-btn" @click="emit('close')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="6 9 12 15 18 9"/></svg>
      </button>
    </div>

    <div class="notes-list">
      <div v-for="note in pageNotes" :key="note.id" class="note-card" @click="emit('click-note', note)">
        <template v-if="editingId !== note.id">
          <div class="note-head">
            <span class="note-tag">{{ note.kind === 'highlight' ? '🖍️ 高亮' : '笔记' }}{{ note.pageNumber ? ` · 第${note.pageNumber}页` : '' }}</span>
            <div class="note-actions">
              <button @click="startEdit(note)">编辑</button>
              <button @click="deleteNote(note.id)" class="danger">删除</button>
            </div>
          </div>
          <blockquote v-if="note.highlightText" class="note-quote">"{{ note.highlightText }}"</blockquote>
          <MarkdownContent class="note-content" :content="note.content" />
        </template>
        <template v-else>
          <textarea v-model="editContent" class="note-edit" rows="10" @keydown.enter.stop />
          <div class="note-edit-actions">
            <button @click="saveEdit" class="save-btn">保存</button>
            <button @click="cancelEdit" class="cancel-btn">取消</button>
          </div>
        </template>
      </div>
      <div v-if="!pageNotes.length" class="notes-empty">当前页面暂无笔记</div>
    </div>

    <div class="notes-input">
      <textarea v-model="newNote" rows="2" placeholder="添加笔记…（支持 Markdown 和 LaTeX）" @keydown.ctrl.enter="saveNote" @keydown.meta.enter="saveNote" />
      <button @click="saveNote" :disabled="!newNote.trim()" class="save-btn">保存</button>
    </div>
  </div>
</template>

<style scoped>
.notes-panel {
  height: 480px;
  display: flex;
  flex-direction: column;
  border-top: 1px solid var(--color-border);
  background: var(--color-bg-card);
  flex-shrink: 0;
}

.notes-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid var(--color-border);
  font-size: 13px;
  font-weight: 500;
  color: var(--color-text);
}

.close-btn {
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--color-text-muted);
  border-radius: 4px;
  cursor: pointer;
}
.close-btn:hover { background: var(--color-bg-muted); }

.notes-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px 12px;
}

.note-card {
  padding: 10px;
  margin-bottom: 6px;
  background: var(--color-bg-muted);
  border-radius: var(--radius-sm);
  border: 1px solid var(--color-border);
  cursor: default;
  transition: border-color var(--transition), background var(--transition);
}
.note-card:hover { border-color: var(--color-border-hover); background: var(--color-bg-hover); }

.note-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}

.note-tag { font-size: 11px; color: var(--color-text-muted); }

.note-actions { display: flex; gap: 4px; }
.note-actions button {
  border: none;
  background: none;
  font-size: 11px;
  color: var(--color-text-muted);
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 3px;
}
.note-actions button:hover { background: var(--color-bg-hover); color: var(--color-text); }
.note-actions button.danger:hover { color: var(--color-error); }

.note-quote {
  padding: 6px 10px;
  margin-bottom: 6px;
  border-left: 3px solid var(--color-warning);
  background: #fffbeb;
  border-radius: 0 4px 4px 0;
  font-size: 13px;
  line-height: 1.6;
  color: #92400e;
  cursor: text;
  user-select: text;
}
[data-theme="dark"] .note-quote { background: #451a03; color: #fde047; }

.note-content { font-size: 14px; color: var(--color-text); line-height: 1.7; cursor: text; user-select: text; }

.note-edit {
  width: 100%;
  padding: 8px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg-card);
  color: var(--color-text);
  font-size: 14px;
  line-height: 1.6;
  resize: vertical;
  font-family: inherit;
  min-height: 200px;
}
.note-edit:focus { outline: none; border-color: var(--color-primary); }

.note-edit-actions { display: flex; gap: 6px; margin-top: 6px; }

.save-btn {
  padding: 4px 12px;
  border: none;
  border-radius: var(--radius-sm);
  background: var(--color-primary);
  color: white;
  font-size: 12px;
  cursor: pointer;
  transition: background var(--transition);
}
.save-btn:hover { background: var(--color-primary-hover); }
.save-btn:disabled { opacity: 0.4; cursor: default; }

.cancel-btn {
  padding: 4px 12px;
  border: none;
  border-radius: var(--radius-sm);
  background: var(--color-bg-muted);
  color: var(--color-text-secondary);
  font-size: 12px;
  cursor: pointer;
}
.cancel-btn:hover { background: var(--color-bg-hover); }

.notes-empty {
  text-align: center;
  padding: 20px;
  font-size: 12px;
  color: var(--color-text-muted);
}

.notes-input {
  display: flex;
  gap: 8px;
  padding: 8px 12px;
  border-top: 1px solid var(--color-border);
}

.notes-input textarea {
  flex: 1;
  padding: 7px 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg-muted);
  color: var(--color-text);
  font-size: 14px;
  line-height: 1.6;
  font-family: inherit;
  resize: vertical;
}
.notes-input textarea:focus { outline: none; border-color: var(--color-primary); }
.notes-input textarea::placeholder { color: var(--color-text-muted); }
</style>
