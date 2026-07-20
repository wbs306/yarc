import type {
  IeeeJournalBrowserPreferences,
  IeeeSearchMode,
  IeeeSearchResponse,
  IeeeSearchSort,
  NoteFileSyncResult,
  PaperReferenceInput,
  PaperReferenceResolution,
} from '@yarc/shared'

const API_BASE = '/api'

interface RequestInitExt extends RequestInit {
  params?: Record<string, string>
}

export type OfficeViewMode = 'html' | 'text' | 'outline' | 'issues' | 'stats'

async function request<T>(endpoint: string, options: RequestInitExt = {}): Promise<T> {
  const { params, ...fetchOptions } = options

  let url = `${API_BASE}${endpoint}`
  if (params) {
    const searchParams = new URLSearchParams(params)
    url += `?${searchParams.toString()}`
  }

  const headers: Record<string, string> = {
    ...((fetchOptions.headers as Record<string, string>) || {}),
  }

  if (fetchOptions.body && !(fetchOptions.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json'
  }

  const res = await fetch(url, {
    ...fetchOptions,
    headers,
    credentials: 'include',
  })

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: { message: res.statusText } }))

    if (res.status === 401 && endpoint !== '/auth/login') {
      localStorage.removeItem('yarc_auth')
      const current = `${window.location.pathname}${window.location.search}`
      if (window.location.pathname !== '/login') {
        window.location.assign(`/login?next=${encodeURIComponent(current)}`)
      }
    }

    throw new Error(error.error?.message || `HTTP ${res.status}`)
  }

  return res.json()
}

export function useApi() {
  return {
    // Auth
    login: (password: string) =>
      request<{ token: string }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ password }),
      }),

    logout: () => request('/auth/logout', { method: 'POST' }),

    getMe: () => request<{ user: { id: string } }>('/auth/me'),

    // Papers
    getPapers: (params?: {
      category?: string
      q?: string
      field?: string
      page?: number
      limit?: number
    }) => {
      const queryParams: Record<string, string> = {}
      if (params?.category) queryParams.category = params.category
      if (params?.q) queryParams.q = params.q
      if (params?.field) queryParams.field = params.field
      if (params?.page) queryParams.page = String(params.page)
      if (params?.limit) queryParams.limit = String(params.limit)
      return request<{ papers: any[]; total: number }>('/papers', { params: queryParams })
    },

    getPaper: (id: string) => request<{ paper: any }>(`/papers/${id}`),

    createPaper: (data: any) =>
      request<{ paper: any }>('/papers', {
        method: 'POST',
        body: JSON.stringify(data),
      }),

    updatePaper: (id: string, data: any) =>
      request<{ paper: any }>(`/papers/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),

    deletePaper: (id: string) =>
      request(`/papers/${id}`, { method: 'DELETE' }),

    batchDeletePapers: (ids: string[]) =>
      request('/papers/batch/delete', {
        method: 'POST',
        body: JSON.stringify({ ids }),
      }),

    batchMovePapers: (ids: string[], categoryId: string | null) =>
      request('/papers/batch/move', {
        method: 'POST',
        body: JSON.stringify({ ids, categoryId }),
      }),

    batchSummarizePapers: (ids: string[]) =>
      request<{ enqueued: number; errors?: { id: string; message: string }[] }>('/papers/batch/summarize', {
        method: 'POST',
        body: JSON.stringify({ ids }),
      }),

    uploadPaper: async (file: File, title?: string, categoryId?: string | null) => {
      const formData = new FormData()
      formData.append('file', file)
      if (title) formData.append('title', title)
      if (categoryId) formData.append('categoryId', categoryId)
      return request<{ paper: any }>('/papers/upload', {
        method: 'POST',
        body: formData as any,
      })
    },

    uploadPapers: async (files: File[], categoryId?: string | null) => {
      const formData = new FormData()
      for (const file of files) formData.append('files', file)
      if (categoryId) formData.append('categoryId', categoryId)
      return request<{ papers: any[]; errors?: { fileName: string; message: string }[] }>('/papers/upload', {
        method: 'POST',
        body: formData as any,
      })
    },

    importPapersFromSearch: (data: { papers: any[]; categoryId?: string | null; requirePdf?: boolean; extractMetadata?: boolean }) =>
      request<{ job: any }>('/papers/import-from-search', {
        method: 'POST',
        body: JSON.stringify(data),
      }),

    getImportJob: (id: string) => request<{ job: any }>(`/papers/import-jobs/${id}`),

    summarizePaper: (id: string) =>
      request(`/papers/${id}/summarize`, { method: 'POST' }),

    enrichPaper: (id: string) =>
      request(`/papers/${id}/enrich`, { method: 'POST' }),

    reparsePaper: (id: string) =>
      request(`/papers/${id}/reparse`, { method: 'POST' }),

    searchLocal: (q: string, limit?: number, threshold?: number) =>
      request<{ results: any[] }>('/papers/search', {
        params: { q, ...(limit && { limit: String(limit) }), ...(threshold && { threshold: String(threshold) }) },
      }),

    // Categories
    getCategories: () => request<{ categories: any[] }>('/categories'),

    createCategory: (data: { name: string; parentId?: string; color?: string }) =>
      request<{ category: any }>('/categories', {
        method: 'POST',
        body: JSON.stringify(data),
      }),

    updateCategory: (id: string, data: any) =>
      request<{ category: any }>(`/categories/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),

    deleteCategory: (id: string) =>
      request(`/categories/${id}`, { method: 'DELETE' }),

    // Notes
    getNotes: (paperId: string) =>
      request<{ notes: any[] }>(`/notes/${paperId}`),

    createNote: (paperId: string, data: any) =>
      request<{ note: any }>(`/notes/${paperId}`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),

    updateNote: (id: string, data: any) =>
      request<{ note: any }>(`/notes/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),

    deleteNote: (id: string) =>
      request(`/notes/${id}`, { method: 'DELETE' }),

    syncNotesFromFiles: (paperIds?: string[]) =>
      request<{ result: NoteFileSyncResult }>('/notes/sync', {
        method: 'POST',
        body: JSON.stringify(paperIds?.length ? { paperIds } : {}),
      }),

    // Conversations
    getConversations: () => request<{ conversations: any[] }>('/conversations'),

    createConversation: (data?: { paperId?: string; title?: string; model?: string }) =>
      request<{ conversation: any }>('/conversations', {
        method: 'POST',
        body: JSON.stringify(data || {}),
      }),

    deleteConversation: (id: string) =>
      request(`/conversations/${id}`, { method: 'DELETE' }),

    getStreamingMessage: (convId: string) =>
      request<{ message: any | null; userMessage?: any | null; events?: any[]; fromBuffer?: boolean }>(`/conversations/${convId}/streaming-message`),

    stopStreamingMessage: (convId: string, messageId: string) =>
      request<{ ok: boolean }>(`/conversations/${convId}/streaming-message/${messageId}/stop`, { method: 'POST' }),

    respondAgentInteraction: (requestId: string, body: { requestId: string; action: 'submit' | 'cancel' | 'chat'; value?: unknown; conversationId?: string }) =>
      request<{ ok: boolean; resolved?: boolean; message?: string }>(`/agent-interactions/${requestId}/respond`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),

    getBranches: (convId: string) =>
      request<{ branches: any[] }>(`/conversations/${convId}/branches`),

    getConversationContextUsage: (convId: string, branchId?: string) =>
      request<{ contextUsage: { tokens: number | null; contextWindow: number; percent: number | null; model?: string } | null }>(`/conversations/${convId}/context-usage`, {
        params: branchId ? { branchId } : undefined,
      }),

    switchBranch: (convId: string, branchId: string) =>
      request<{ messages: any[] }>(`/conversations/${convId}/switch-branch/${branchId}`, { method: 'POST' }),

    updateConversationTitle: (id: string, title: string) =>
      request(`/conversations/${id}/title`, {
        method: 'PUT',
        body: JSON.stringify({ title }),
      }),

    askBtw: (convId: string, body: { question: string; branchId?: string; model?: string; reasoningEffort?: string }) =>
      request<{ answer: string; thinking?: string; events?: any[] }>(`/conversations/${convId}/btw`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),

    startBtw: (convId: string, body: { question: string; branchId?: string; model?: string; reasoningEffort?: string }) =>
      request<{ runId: string; status: string }>(`/conversations/${convId}/btw`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),

    getBtwRuns: (convId: string) =>
      request<{ runs: Array<{ id: string; question: string; answer: string; thinking?: string; status: string; error?: string; createdAt: string }> }>(`/conversations/${convId}/btw/runs`),

    cancelBtw: (convId: string, runId: string) =>
      request<{ ok: boolean }>(`/conversations/${convId}/btw/${runId}/cancel`, { method: 'POST' }),

    deleteBtw: (convId: string, runId: string) =>
      request<{ ok: boolean }>(`/conversations/${convId}/btw/${runId}`, { method: 'DELETE' }),

    // Rankings
    getRankings: (name: string) =>
      request<{ ccf: string | null; sci: string | null }>(`/rankings/${encodeURIComponent(name)}`),

    getAllRankings: () =>
      request<{ entries: Array<{ name: string; ccf: string | null; sci: string | null; custom?: boolean }> }>('/rankings/all'),

    updateCustomRankings: (entries: Array<{ name: string; ccf: string | null; sci: string | null }>) =>
      request<{ entries: Array<{ name: string; ccf: string | null; sci: string | null; custom?: boolean }> }>('/rankings/custom', {
        method: 'PUT',
        body: JSON.stringify({ entries }),
      }),

    // Search
    searchExternal: (q: string, source?: string, field?: string, page?: number) =>
      request('/search', {
        params: { q, ...(source && { source }), ...(field && { field }), ...(page && { page: String(page) }) },
      }),

    searchIeee: (params: {
      mode?: IeeeSearchMode
      q?: string
      journalId?: string
      articleNumber?: string
      sort?: IeeeSearchSort
      page?: number
      limit?: number
      refresh?: boolean
    }) => {
      const query: Record<string, string> = {
        source: 'ieee',
        ieee_mode: params.mode || 'search',
      }
      if (params.q) query.q = params.q
      if (params.journalId) query.journal_id = params.journalId
      if (params.articleNumber) query.article_number = params.articleNumber
      if (params.sort) query.sort = params.sort
      if (params.page) query.page = String(params.page)
      if (params.limit) query.limit = String(params.limit)
      if (params.refresh) query.refresh = '1'
      return request<IeeeSearchResponse>('/search', { params: query })
    },

    getIeeeArticleAbstract: (articleNumber: string) =>
      request<IeeeSearchResponse>('/search', {
        params: { source: 'ieee', ieee_mode: 'article_abstract', article_number: articleNumber },
      }),

    resolvePaperReferences: (references: PaperReferenceInput[]) =>
      request<{ results: PaperReferenceResolution[] }>('/search/resolve', {
        method: 'POST',
        body: JSON.stringify({ references }),
      }),

    // Search Categories
    getSearchCategories: () =>
      request<{ categories: any[] }>('/search-categories'),

    getSearchCategoryPapers: (categoryId: string) =>
      request<{ papers: any[] }>(`/search-categories/${categoryId}/papers`),

    createSearchCategory: (data: { name: string }) =>
      request<{ category: any }>('/search-categories', {
        method: 'POST',
        body: JSON.stringify(data),
      }),

    updateSearchCategory: (id: string, data: { name?: string; parentId?: string | null }) =>
      request<{ category: any }>(`/search-categories/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),

    deleteSearchCategory: (id: string) =>
      request(`/search-categories/${id}`, { method: 'DELETE' }),

    addPaperToSearchCategory: (categoryId: string, paper: any) =>
      request(`/search-categories/${categoryId}/papers`, {
        method: 'POST',
        body: JSON.stringify({ paper }),
      }),

    removePaperFromSearchCategory: (categoryId: string, paperId: string) =>
      request(`/search-categories/${categoryId}/papers/${encodeURIComponent(paperId)}`, { method: 'DELETE' }),

    // Tasks
    getTasks: (status?: string, limit?: number, order?: 'asc' | 'desc') =>
      request<{ tasks: any[] }>('/tasks', {
        params: { ...(status ? { status } : {}), ...(limit !== undefined ? { limit: String(limit) } : {}), ...(order ? { order } : {}) },
      }),

    getTaskStats: () => request<{ pending: number; active: number; completed: number; failed: number }>('/tasks/stats'),

    getTaskConcurrency: () => request<{ concurrency: any }>('/tasks/concurrency'),

    updateTaskConcurrency: (concurrency: any) =>
      request<{ concurrency: any }>('/tasks/concurrency', {
        method: 'PUT',
        body: JSON.stringify(concurrency),
      }),

    cancelTask: (id: string) => request<{ task: any }>(`/tasks/${id}/cancel`, { method: 'POST' }),

    retryTask: (id: string) => request(`/tasks/${id}/retry`, { method: 'POST' }),

    // Files
    getFileTree: (path?: string) =>
      request<{ files: any[] }>('/files', { params: path ? { path } : {} }),

    getFileContent: (path: string, options?: { refreshLive?: boolean }) =>
      request<{ content: string; language: string; modified: string }>('/files/content', {
        params: { path, ...(options?.refreshLive ? { refreshLive: '1' } : {}) },
      }),

    saveFileContent: (path: string, content: string) =>
      request('/files/content', {
        method: 'PUT',
        body: JSON.stringify({ path, content }),
      }),

    openFileWithSystemApp: (path: string) =>
      request<{ message: string }>('/files/open-system', {
        method: 'POST',
        body: JSON.stringify({ path }),
      }),

    createFile: (path: string, content = '') =>
      request<{ file: any }>('/files/file', {
        method: 'POST',
        body: JSON.stringify({ path, content }),
      }),

    createDirectory: (path: string) =>
      request<{ file: any }>('/files/directory', {
        method: 'POST',
        body: JSON.stringify({ path }),
      }),

    renamePath: (from: string, to: string) =>
      request<{ file: any }>('/files/path', {
        method: 'PATCH',
        body: JSON.stringify({ from, to }),
      }),

    deletePath: (path: string) =>
      request('/files/path', { method: 'DELETE', params: { path } }),

    uploadFile: (path: string, file: File) => {
      const formData = new FormData()
      formData.append('path', path)
      formData.append('file', file)
      return request<{ file: any }>('/files/upload', {
        method: 'POST',
        body: formData as any,
      })
    },

    getFileDownloadUrl: (path: string) => `${API_BASE}/files/download?path=${encodeURIComponent(path)}`,
    getFileImageUrl: (path: string) => `${API_BASE}/files/image?path=${encodeURIComponent(path)}`,

    getOfficeView: (path: string, mode: OfficeViewMode) =>
      request<{ mode: OfficeViewMode; content: string }>('/files/office/view', { params: { path, mode } }),

    // Settings
    getSettings: () => request<{ settings: Record<string, any> }>('/settings'),

    getIeeeJournalBrowserPreferences: () =>
      request<{ preferences: IeeeJournalBrowserPreferences }>('/settings/ieee-journal-browser'),

    updateIeeeJournalBrowserPreferences: (preferences: IeeeJournalBrowserPreferences) =>
      request<{ preferences: IeeeJournalBrowserPreferences }>('/settings/ieee-journal-browser', {
        method: 'PUT',
        body: JSON.stringify({ preferences }),
      }),

    getSystemStatus: () => request<{ status: any }>('/settings/system-status'),

    runMaintenanceAction: (action: 'embeddings' | 'mineru' | 'summaries', data: { scope?: 'needed' | 'all'; limit?: number }) =>
      request<{ action: string; scope: string; matched: number; enqueued: number; limitedTo: number; errors: Array<{ id: string; message: string }> }>(`/settings/maintenance/${action}`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),

    updateSetting: (key: string, value: any) =>
      request(`/settings/${key}`, {
        method: 'PUT',
        body: JSON.stringify({ value }),
      }),

    getModels: (refresh = false) =>
      request<{ models: any[]; source?: string; error?: string }>('/settings/models', {
        params: refresh ? { refresh: '1' } : {},
      }),

    getPromptDefaults: () => request<{ defaults: { summary_prompt: string; system_prompt: string } }>('/settings/prompt-defaults'),

    getTheme: () => request<{ theme: any }>('/settings/themes/active'),

    updateTheme: (theme: any) =>
      request('/settings/themes/active', {
        method: 'PUT',
        body: JSON.stringify(theme),
      }),

    getPiEnabledModels: () => request<{ enabledModels: string[] }>('/settings/pi-enabled-models'),

    updatePiEnabledModels: (enabledModels: string[]) =>
      request('/settings/pi-enabled-models', {
        method: 'PUT',
        body: JSON.stringify({ enabledModels }),
      }),

    getPiModels: () => request<{ providers: Record<string, any> }>('/settings/pi-models'),

    updatePiModels: (providers: Record<string, any>) =>
      request('/settings/pi-models', {
        method: 'PUT',
        body: JSON.stringify({ providers }),
      }),

    fetchProviderModels: (baseUrl: string, apiKey?: string, api?: string) =>
      request<{
        models: Array<{ id: string; name?: string }>
        url?: string
        catalog?: {
          models: Array<{ id: string; name: string; provider: string; contextWindow: number; maxTokens: number; reasoning: boolean; input: string[] }>
          total: number
          source: string
          error?: string
        }
      }>('/settings/pi-models/fetch', {
        method: 'POST',
        body: JSON.stringify({ baseUrl, apiKey, api }),
      }),

    fetchModelCatalog: () =>
      request<{ models: Array<{ id: string; name: string; provider: string; contextWindow: number; maxTokens: number; reasoning: boolean; input: string[] }>; source?: string }>('/settings/pi-models/catalog'),

    refreshModelCatalog: () =>
      request<{ models: Array<{ id: string; name: string; provider: string; contextWindow: number; maxTokens: number; reasoning: boolean; input: string[] }>; total: number; source: string }>('/settings/pi-models/catalog/refresh', {
        method: 'POST',
      }),

    getPiSettings: () => request<{ settings: Record<string, any> }>('/settings/pi-settings'),

    updatePiSettings: (settings: Record<string, any>) =>
      request('/settings/pi-settings', {
        method: 'PUT',
        body: JSON.stringify(settings),
      }),

    getPiAuth: () => request<{ entries: Record<string, { type: string; hasKey: boolean; expires?: number }> }>('/settings/pi-auth'),

    updatePiAuth: (entries: Record<string, any>) =>
      request('/settings/pi-auth', {
        method: 'PUT',
        body: JSON.stringify({ entries }),
      }),

    getBackgroundImages: () => request<{ images: Array<{ src: string; thumb: string }> }>('/settings/background-images'),

    uploadBackgroundImage: (file: File) => {
      const formData = new FormData()
      formData.append('file', file)
      return request<{ image: { src: string; thumb: string } }>('/settings/background-images', {
        method: 'POST',
        body: formData as any,
      })
    },

    // Subagent control
    subagentAction: (runId: string, action: string, body?: Record<string, unknown>) =>
      request<{ result: string }>(`/subagents/${runId}/${action}`, {
        method: 'POST',
        body: JSON.stringify(body || {}),
      }),

    // Subagent run tracking
    trackSubagentRun: (runId: string, body: { conversationId: string; messageId: string; branchId?: string }) =>
      request<{ run: { runId: string; status: string; currentState?: string; result?: any } }>(`/subagent-runs/${runId}/track`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),

    getSubagentRuns: (conversationId: string) =>
      request<{ runs: Array<{ runId: string; conversationId: string; messageId: string; status: string; currentState?: string; result?: any }> }>(`/subagent-runs?conversationId=${encodeURIComponent(conversationId)}`),

    untrackSubagentRun: (runId: string) =>
      request<{ ok: boolean }>(`/subagent-runs/${runId}`, { method: 'DELETE' }),

    // Extension management
    getExtensions: () =>
      request<{ extensions: Array<{
        id: string
        name: string
        source: string
        type: 'npm' | 'git' | 'local'
        enabled: boolean
        installed: boolean
        description: string | null
        version: string | null
        packageName: string | null
        entryFile: string | null
      }>, paths: { agentDir: string; extensionsDir: string; npmDir: string; gitDir: string } }>('/extensions'),

    enableExtension: (id: string) =>
      request<{ ok: boolean }>(`/extensions/${encodeURIComponent(id)}/enable`, { method: 'POST' }),

    disableExtension: (id: string) =>
      request<{ ok: boolean }>(`/extensions/${encodeURIComponent(id)}/disable`, { method: 'POST' }),

    installExtension: (source: string) =>
      request<{ ok: boolean; id: string; type: string }>('/extensions/install', {
        method: 'POST',
        body: JSON.stringify({ source }),
      }),

    uninstallExtension: (id: string) =>
      request<{ ok: boolean }>(`/extensions/${encodeURIComponent(id)}`, { method: 'DELETE' }),

    // WeChat integration
    getWechatStatus: () =>
      request<{
        runtimePluginExists: boolean
        runtimePluginPath: string
        storageDir: string
        storageExists: boolean
        bridgeLoaded: boolean
        diagnostics: string[]
        status: {
          loaded: boolean
          connected: boolean
          loginState: string
          accountId: string | null
          userId: string | null
          activeUserId: string | null
          isStreaming: boolean
          lastQrUrl: string | null
          lastError: string | null
          updatedAt: string
        } | null
      }>('/settings/wechat/status'),

    loginWechat: (force = false) =>
      request<{ ok: boolean; status: any }>('/settings/wechat/login', {
        method: 'POST',
        body: JSON.stringify({ force }),
      }),

    logoutWechat: () =>
      request<{ ok: boolean; status: any }>('/settings/wechat/logout', { method: 'POST' }),

    reconnectWechat: (force = false) =>
      request<{ ok: boolean; status: any }>('/settings/wechat/reconnect', {
        method: 'POST',
        body: JSON.stringify({ force }),
      }),

    initWechatExtension: () =>
      request<{ ok: boolean }>('/settings/wechat/init', { method: 'POST' }),
  }
}

export function usePdfUrl(paperId: string): string {
  return `${API_BASE}/papers/${paperId}/pdf`
}

export function useTemporaryPdfUrl(sourceUrl: string): string {
  return `${API_BASE}/search/pdf?url=${encodeURIComponent(sourceUrl)}`
}
