import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useApi } from '@/composables/useApi'

export interface Note {
  id: string
  paperId: string
  title: string
  content: string
  pageNumber: number | null
  highlightText: string | null
  highlightRect: any
  kind: string
  createdAt: string
  updatedAt: string
}

export const useNoteStore = defineStore('note', () => {
  const api = useApi()

  const notes = ref<Note[]>([])
  const loading = ref(false)

  const fetchNotes = async (paperId: string) => {
    loading.value = true
    try {
      const res = await api.getNotes(paperId)
      notes.value = res.notes
    } finally {
      loading.value = false
    }
  }

  const createNote = async (data: {
    paperId: string
    title?: string
    content?: string
    pageNumber?: number
    highlightText?: string
    highlightRect?: any
    kind?: string
  }) => {
    const res = await api.createNote(data.paperId, data)
    notes.value.unshift(res.note)
    return res.note
  }

  const updateNote = async (id: string, data: {
    title?: string
    content?: string
    pageNumber?: number
    highlightText?: string
    highlightRect?: any
  }) => {
    const res = await api.updateNote(id, data)
    const idx = notes.value.findIndex((n) => n.id === id)
    if (idx !== -1) notes.value[idx] = res.note
    return res.note
  }

  const deleteNote = async (id: string) => {
    await api.deleteNote(id)
    notes.value = notes.value.filter((n) => n.id !== id)
  }

  return { notes, loading, fetchNotes, createNote, updateNote, deleteNote }
})
