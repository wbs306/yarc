import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { Project, ProjectGitStatus, ProjectLatexTarget } from '@yarc/shared'

const request = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(url, {
    credentials: 'include',
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload?.error?.message || payload?.message || `Request failed (${response.status})`)
  return payload as T
}

export const useProjectsStore = defineStore('projects', () => {
  const projects = ref<Project[]>([])
  const currentProject = ref<Project | null>(null)
  const gitStatus = ref<ProjectGitStatus | null>(null)
  const latexTargets = ref<ProjectLatexTarget[]>([])
  const defaultLatexTarget = ref<string | null>(null)
  const loading = ref(false)
  const error = ref('')

  const activeProjects = computed(() => projects.value.filter(project => !project.archivedAt))

  async function fetchProjects(archived = false) {
    loading.value = true
    error.value = ''
    try {
      const data = await request<{ projects: Project[] }>(`/api/projects${archived ? '?archived=true' : ''}`)
      projects.value = data.projects
      return data.projects
    } catch (err) {
      error.value = (err as Error).message
      throw err
    } finally {
      loading.value = false
    }
  }

  async function fetchProject(id: string) {
    const data = await request<{ project: Project }>(`/api/projects/${encodeURIComponent(id)}`)
    currentProject.value = data.project
    return data.project
  }

  async function createProject(input: { name: string; directoryName?: string; description?: string }) {
    const data = await request<{ project: Project }>('/api/projects', { method: 'POST', body: JSON.stringify(input) })
    projects.value.unshift(data.project)
    return data.project
  }

  async function updateProject(id: string, patch: Partial<Pick<Project, 'name' | 'description' | 'settings'>>) {
    const data = await request<{ project: Project }>(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })
    const index = projects.value.findIndex(project => project.id === id)
    if (index >= 0) projects.value[index] = data.project
    if (currentProject.value?.id === id) currentProject.value = data.project
    return data.project
  }

  async function archiveProject(id: string) {
    const data = await request<{ project: Project }>(`/api/projects/${id}/archive`, { method: 'POST' })
    projects.value = projects.value.filter(project => project.id !== id)
    return data.project
  }

  async function unarchiveProject(id: string) {
    return (await request<{ project: Project }>(`/api/projects/${id}/unarchive`, { method: 'POST' })).project
  }

  async function deleteProject(id: string) {
    await request(`/api/projects/${id}`, { method: 'DELETE' })
    projects.value = projects.value.filter(project => project.id !== id)
    if (currentProject.value?.id === id) currentProject.value = null
  }

  async function fetchGitStatus(id: string) {
    const data = await request<{ status: ProjectGitStatus }>(`/api/projects/${id}/git/status`)
    gitStatus.value = data.status
    return data.status
  }

  async function fetchLatexTargets(id: string) {
    const data = await request<{ defaultTarget: string | null; targets: ProjectLatexTarget[] }>(`/api/projects/${id}/latex/targets`)
    defaultLatexTarget.value = data.defaultTarget
    latexTargets.value = data.targets
    return data
  }

  return {
    projects, activeProjects, currentProject, gitStatus, latexTargets, defaultLatexTarget, loading, error,
    fetchProjects, fetchProject, createProject, updateProject, archiveProject, unarchiveProject, deleteProject,
    fetchGitStatus, fetchLatexTargets,
  }
})
