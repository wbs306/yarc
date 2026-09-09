<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'
import CodeEditor from '@/components/files/CodeEditor.vue'
import ChatPanel from '@/components/chat/ChatPanel.vue'
import { useProjectsStore } from '@/stores/projects'
import { useChatStore } from '@/stores/chat'
import { useProjectLiveFiles, type ProjectLiveFileClient } from '@/composables/useProjectLiveFiles'
import type {
  ProjectGitBranch,
  ProjectGitCommit,
  ProjectHistoryCheckpoint,
  ProjectHistoryRevision,
  ProjectLatexTarget,
} from '@yarc/shared'

type FileNode = { name: string; path: string; type: 'file' | 'directory'; children?: FileNode[]; size?: number }
type FileRevision = ProjectHistoryRevision & { checkpoint?: ProjectHistoryCheckpoint }
type GitRemote = { name: string; fetch?: string; push?: string }
type HistoryPreview = {
  revision: FileRevision
  content: string | null
  mode: 'preview' | 'current' | 'previous'
  baseLabel?: string
  baseContent?: string | null
}
type DiffLine = { kind: 'same' | 'add' | 'remove'; text: string }

const EDITABLE_EXTENSIONS = new Set([
  'tex','bib','sty','cls','bst','txt','md','markdown','json','jsonl','yaml','yml','toml','ini','cfg','conf','csv','tsv',
  'py','r','jl','m','c','h','cc','cpp','hpp','ts','tsx','js','jsx','vue','css','scss','html','xml','sh','zsh','fish','sql','log',
])
const EDITABLE_NAMES = new Set(['.gitignore', '.gitattributes', 'Dockerfile', 'Makefile'])

const route = useRoute()
const router = useRouter()
const store = useProjectsStore()
const chatStore = useChatStore()
const projectLiveFiles = useProjectLiveFiles()
const projectId = computed(() => String(route.params.id || ''))
const sideTab = ref<'files' | 'git' | 'history' | 'latex'>('files')
const files = ref<FileNode[]>([])
const selectedPath = ref('')
const content = ref('')
const currentLive = shallowRef<ProjectLiveFileClient | null>(null)
const fileLoading = ref(false)
const commits = ref<ProjectGitCommit[]>([])
const branches = ref<ProjectGitBranch[]>([])
const remotes = ref<GitRemote[]>([])
const history = ref<ProjectHistoryCheckpoint[]>([])
const fileHistory = ref<FileRevision[]>([])
const historyPreview = ref<HistoryPreview | null>(null)
const gitDiff = ref('')
const commitMessage = ref('')
const newPath = ref('')
const error = ref('')
const activeBuild = ref<any>(null)
const buildLog = ref('')
const buildTimer = ref<number | null>(null)
const conversations = ref<any[]>([])
const uploadInput = ref<HTMLInputElement | null>(null)
const latexTargetsDraft = ref<ProjectLatexTarget[]>([])
const defaultLatexTargetDraft = ref('')
const activeTargetId = ref('')

const json = async <T = any>(url: string, init?: RequestInit): Promise<T> => {
  const isForm = init?.body instanceof FormData
  const response = await fetch(url, {
    credentials: 'include',
    ...init,
    headers: isForm ? init?.headers : { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data?.error?.message || data?.message || `Request failed (${response.status})`)
  return data as T
}

const fileName = (path: string) => path.split('/').pop() || path
const isEditablePath = (path: string) => {
  const name = fileName(path)
  if (EDITABLE_NAMES.has(name)) return true
  const dot = name.lastIndexOf('.')
  return dot >= 0 && EDITABLE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase())
}
const selectedEditable = computed(() => !!selectedPath.value && isEditablePath(selectedPath.value))

const language = computed(() => {
  const ext = selectedPath.value.split('.').pop()?.toLowerCase()
  return ({ tex: 'latex', bib: 'bibtex', sty: 'latex', cls: 'latex', md: 'markdown', json: 'json', ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', vue: 'vue', py: 'python', css: 'css', html: 'html', yaml: 'yaml', yml: 'yaml', sql: 'sql', sh: 'shell', xml: 'xml' } as Record<string,string>)[ext || ''] || 'plaintext'
})

const liveState = computed(() => {
  const live = currentLive.value
  if (!live) return selectedEditable.value ? (selectedPath.value ? 'loading' : 'idle') : 'external'
  if (live.conflict.value) return 'conflict'
  if (live.saving.value) return 'saving'
  if (live.dirty.value) return 'dirty'
  return live.connected.value ? 'saved' : 'offline'
})

const currentResource = computed(() => selectedPath.value
  ? { type: 'file' as const, path: selectedPath.value, name: fileName(selectedPath.value) }
  : null)

watch(() => currentLive.value?.content.value, next => {
  if (typeof next === 'string' && next !== content.value) content.value = next
})
watch(() => currentLive.value?.error.value, next => {
  if (next) error.value = next
})
watch(content, next => {
  const live = currentLive.value
  if (live && next !== live.content.value) live.syncContent(next)
})

function flattenNodes(nodes: FileNode[], depth = 0): Array<{ node: FileNode; depth: number }> {
  return nodes.flatMap(node => [{ node, depth }, ...(node.children ? flattenNodes(node.children, depth + 1) : [])])
}
const flatFiles = computed(() => flattenNodes(files.value))

async function loadFiles() {
  files.value = (await json<{ files: FileNode[] }>(`/api/projects/${projectId.value}/files`)).files
}

async function settleCurrentLiveFile() {
  const live = currentLive.value
  if (!live) return true
  if (live.conflict.value) {
    error.value = '当前文件存在冲突；请先选择 Keep editor 或 Use disk，再切换文件。'
    return false
  }
  if (!live.dirty.value) return true
  try {
    await live.flush()
    return true
  } catch (err) {
    error.value = (err as Error).message
    return false
  }
}

async function openSystemFile(path = selectedPath.value) {
  if (!path) return
  try {
    await json(`/api/projects/${projectId.value}/files/open-system`, { method: 'POST', body: JSON.stringify({ path }) })
  } catch (err) { error.value = (err as Error).message }
}

async function openFile(path: string) {
  if (path === selectedPath.value && (currentLive.value || !isEditablePath(path))) return
  if (!(await settleCurrentLiveFile())) return
  currentLive.value?.close()
  currentLive.value = null
  selectedPath.value = path
  content.value = ''
  historyPreview.value = null
  fileLoading.value = true
  error.value = ''
  try {
    if (!isEditablePath(path)) {
      fileHistory.value = []
      await loadGit()
      return
    }
    const [disk, live] = await Promise.all([
      json<{ content: string }>(`/api/projects/${projectId.value}/files/content?path=${encodeURIComponent(path)}`),
      projectLiveFiles.open(projectId.value, path),
    ])
    currentLive.value = live
    content.value = live.ready.value ? live.content.value : disk.content
    await Promise.all([loadFileHistory(), loadGit()])
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    fileLoading.value = false
  }
}

async function flushFile() {
  if (!currentLive.value) return
  try { await currentLive.value.flush() }
  catch (err) { error.value = (err as Error).message }
}

async function resolveLiveConflict(strategy: 'use-live' | 'use-disk') {
  if (!currentLive.value) return
  try {
    await currentLive.value.resolveConflict(strategy)
    content.value = currentLive.value.content.value
    await Promise.all([loadGit(), loadHistory(), loadFileHistory()])
  } catch (err) { error.value = (err as Error).message }
}

async function createFile() {
  const path = newPath.value.trim() || window.prompt('新文件路径，例如 sections/intro.tex')?.trim()
  if (!path) return
  try {
    await json(`/api/projects/${projectId.value}/files/file`, { method: 'POST', body: JSON.stringify({ path }) })
    newPath.value = ''
    await loadFiles()
    await openFile(path)
  } catch (err) { error.value = (err as Error).message }
}

async function createDirectory() {
  const path = window.prompt('新目录路径')?.trim()
  if (!path) return
  try {
    await json(`/api/projects/${projectId.value}/files/directory`, { method: 'POST', body: JSON.stringify({ path }) })
    await loadFiles()
  } catch (err) { error.value = (err as Error).message }
}

async function renameSelected() {
  if (!selectedPath.value || !(await settleCurrentLiveFile())) return
  const from = selectedPath.value
  const to = window.prompt('重命名为', from)?.trim()
  if (!to || to === from) return
  try {
    currentLive.value?.close()
    currentLive.value = null
    await json(`/api/projects/${projectId.value}/files/path`, { method: 'PATCH', body: JSON.stringify({ from, to }) })
    await loadFiles()
    await openFile(to)
  } catch (err) { error.value = (err as Error).message }
}

async function deleteSelected() {
  if (!selectedPath.value || !(await settleCurrentLiveFile())) return
  if (!window.confirm(`永久删除 ${selectedPath.value}？Writing History 会记录删除前状态。`)) return
  const path = selectedPath.value
  try {
    currentLive.value?.close()
    currentLive.value = null
    await json(`/api/projects/${projectId.value}/files/path?path=${encodeURIComponent(path)}`, { method: 'DELETE' })
    selectedPath.value = ''
    content.value = ''
    fileHistory.value = []
    await Promise.all([loadFiles(), loadGit(), loadHistory()])
  } catch (err) { error.value = (err as Error).message }
}

async function uploadFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  const directory = selectedPath.value.includes('/') ? selectedPath.value.split('/').slice(0, -1).join('/') : ''
  const form = new FormData()
  form.append('file', file)
  form.append('path', directory)
  try {
    await json(`/api/projects/${projectId.value}/files/upload`, { method: 'POST', body: form })
    await Promise.all([loadFiles(), loadGit()])
  } catch (err) { error.value = (err as Error).message }
  finally { if (uploadInput.value) uploadInput.value.value = '' }
}

async function loadGit() {
  const [status, log, branchData, remoteData] = await Promise.all([
    store.fetchGitStatus(projectId.value),
    json<{ commits: ProjectGitCommit[] }>(`/api/projects/${projectId.value}/git/log`),
    json<{ branches: ProjectGitBranch[] }>(`/api/projects/${projectId.value}/git/branches`),
    json<{ remotes: GitRemote[] }>(`/api/projects/${projectId.value}/git/remotes`),
  ])
  commits.value = log.commits
  branches.value = branchData.branches
  remotes.value = remoteData.remotes
  if (selectedPath.value && status.files.some(file => file.path === selectedPath.value)) {
    gitDiff.value = (await json<{ diff: string }>(`/api/projects/${projectId.value}/git/diff?path=${encodeURIComponent(selectedPath.value)}`)).diff
  } else gitDiff.value = ''
}

async function stage(path: string) {
  try {
    await json(`/api/projects/${projectId.value}/git/stage`, { method: 'POST', body: JSON.stringify({ paths: [path] }) })
    await loadGit()
  } catch (err) { error.value = (err as Error).message }
}
async function unstage(path: string) {
  try {
    await json(`/api/projects/${projectId.value}/git/unstage`, { method: 'POST', body: JSON.stringify({ paths: [path] }) })
    await loadGit()
  } catch (err) { error.value = (err as Error).message }
}
async function commit() {
  if (!commitMessage.value.trim()) return
  try {
    await json(`/api/projects/${projectId.value}/git/commit`, { method: 'POST', body: JSON.stringify({ message: commitMessage.value }) })
    commitMessage.value = ''
    await loadGit()
  } catch (err) { error.value = (err as Error).message }
}
async function createBranch() {
  const name = window.prompt('新分支名称')?.trim()
  if (!name) return
  try {
    await json(`/api/projects/${projectId.value}/git/branches`, { method: 'POST', body: JSON.stringify({ name }) })
    await loadGit()
  } catch (err) { error.value = (err as Error).message }
}
async function switchBranch(name: string) {
  if (!name || name === store.gitStatus?.branch) return
  if (!window.confirm(`切换到分支 ${name}？当前 LiveFile 会先落盘并创建 Writing checkpoint。`)) return
  try {
    await json(`/api/projects/${projectId.value}/git/branches/switch`, { method: 'POST', body: JSON.stringify({ name }) })
    currentLive.value?.close()
    currentLive.value = null
    const reopen = selectedPath.value
    await Promise.all([loadFiles(), loadGit(), loadHistory()])
    if (reopen) {
      try { await openFile(reopen) }
      catch { selectedPath.value = ''; content.value = '' }
    }
  } catch (err) {
    error.value = (err as Error).message
    await loadGit().catch(() => undefined)
  }
}
function onBranchChange(event: Event) {
  void switchBranch((event.target as HTMLSelectElement).value)
}

async function loadHistory() {
  history.value = (await json<{ checkpoints: ProjectHistoryCheckpoint[] }>(`/api/projects/${projectId.value}/history`)).checkpoints
}

async function loadFileHistory() {
  if (!selectedPath.value || !isEditablePath(selectedPath.value)) { fileHistory.value = []; return }
  fileHistory.value = (await json<{ revisions: FileRevision[] }>(`/api/projects/${projectId.value}/history/files?path=${encodeURIComponent(selectedPath.value)}`)).revisions
}

async function revisionContent(revision: FileRevision) {
  return json<{ revision: FileRevision; content: string | null }>(`/api/projects/${projectId.value}/history/revisions/${revision.id}`)
}

async function previewRevision(revision: FileRevision, mode: HistoryPreview['mode'] = 'preview') {
  try {
    const selected = await revisionContent(revision)
    if (mode === 'preview') {
      historyPreview.value = { ...selected, mode }
      return
    }
    if (mode === 'current') {
      historyPreview.value = { ...selected, mode, baseLabel: 'Current', baseContent: content.value }
      return
    }
    const index = fileHistory.value.findIndex(item => item.id === revision.id)
    const previous = index >= 0 ? fileHistory.value[index + 1] : undefined
    if (!previous) {
      historyPreview.value = { ...selected, mode: 'preview' }
      error.value = '该 revision 没有更早的版本可比较。'
      return
    }
    const prior = await revisionContent(previous)
    historyPreview.value = {
      ...selected,
      mode,
      baseLabel: `Previous · ${new Date(previous.createdAt).toLocaleString()}`,
      baseContent: prior.content,
    }
  } catch (err) { error.value = (err as Error).message }
}

const lineDiff = (before: string, after: string): DiffLine[] => {
  const a = before.split('\n')
  const b = after.split('\n')
  if (a.length * b.length > 250_000) {
    return [
      ...a.map(text => ({ kind: 'remove' as const, text })),
      ...b.map(text => ({ kind: 'add' as const, text })),
    ]
  }
  const rows = a.length + 1
  const cols = b.length + 1
  const table = Array.from({ length: rows }, () => new Uint32Array(cols))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }
  const out: DiffLine[] = []
  let i = 0, j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { out.push({ kind: 'same', text: a[i] }); i++; j++; continue }
    if (j < b.length && (i >= a.length || table[i][j + 1] >= table[i + 1][j])) { out.push({ kind: 'add', text: b[j++] }); continue }
    if (i < a.length) out.push({ kind: 'remove', text: a[i++] })
  }
  return out
}

const historyDiff = computed<DiffLine[]>(() => {
  const preview = historyPreview.value
  if (!preview || preview.mode === 'preview') return []
  const revisionText = preview.content ?? ''
  if (preview.mode === 'current') return lineDiff(revisionText, preview.baseContent ?? '')
  return lineDiff(preview.baseContent ?? '', revisionText)
})

function checkpointTitle(checkpoint: ProjectHistoryCheckpoint) {
  if (checkpoint.kind !== 'build') return checkpoint.kind
  const meta = (checkpoint.metadata || {}) as Record<string, any>
  const state = meta.success === true ? '✓' : meta.success === false ? '✕' : '…'
  return `Build ${state}${meta.target ? ` · ${meta.target}` : ''}`
}

async function restoreRevision(revision: FileRevision) {
  if (!window.confirm(`恢复 ${revision.path} 到该版本？当前内容会先创建 pre-restore checkpoint。`)) return
  try {
    await json(`/api/projects/${projectId.value}/history/revisions/${revision.id}/restore`, { method: 'POST' })
    currentLive.value?.close()
    currentLive.value = null
    await openFile(revision.path)
    await Promise.all([loadHistory(), loadGit(), loadFileHistory()])
  } catch (err) { error.value = (err as Error).message }
}

async function restoreCheckpoint(checkpointId: string) {
  if (!window.confirm('恢复该 Writing Checkpoint？当前写作状态会先自动创建 pre-restore checkpoint。')) return
  try {
    await json(`/api/projects/${projectId.value}/history/checkpoints/${checkpointId}/restore`, { method: 'POST' })
    currentLive.value?.close()
    currentLive.value = null
    const reopen = selectedPath.value
    await loadFiles()
    if (reopen) {
      try { await openFile(reopen) } catch { selectedPath.value = ''; content.value = '' }
    }
    await Promise.all([loadHistory(), loadGit()])
  } catch (err) { error.value = (err as Error).message }
}

async function pinCheckpoint(checkpoint: ProjectHistoryCheckpoint) {
  try {
    await json(`/api/projects/${projectId.value}/history/checkpoints/${checkpoint.id}/pin`, { method: 'POST', body: JSON.stringify({ pinned: !checkpoint.pinned }) })
    await loadHistory()
  } catch (err) { error.value = (err as Error).message }
}

async function loadLatexTargets() {
  const data = await store.fetchLatexTargets(projectId.value)
  latexTargetsDraft.value = data.targets.map(target => ({ ...target }))
  defaultLatexTargetDraft.value = data.defaultTarget || data.targets[0]?.id || ''
  if (!activeTargetId.value || !data.targets.some(target => target.id === activeTargetId.value)) activeTargetId.value = defaultLatexTargetDraft.value
}

function addLatexTarget() {
  const id = `target-${Date.now().toString(36)}`
  latexTargetsDraft.value.push({ id, name: 'LaTeX', entry: 'main.tex', sourceRoot: '.', engine: 'xelatex' })
  activeTargetId.value = id
  if (!defaultLatexTargetDraft.value) defaultLatexTargetDraft.value = id
}

async function saveLatexTargets() {
  try {
    await json(`/api/projects/${projectId.value}/latex/targets`, {
      method: 'PUT',
      body: JSON.stringify({ defaultTarget: defaultLatexTargetDraft.value || undefined, targets: latexTargetsDraft.value }),
    })
    await loadLatexTargets()
  } catch (err) { error.value = (err as Error).message }
}

async function startBuild() {
  const targetId = activeTargetId.value || defaultLatexTargetDraft.value || latexTargetsDraft.value[0]?.id
  if (!targetId) { error.value = '请先配置 LaTeX target'; return }
  try {
    if (!(await settleCurrentLiveFile())) return
    activeBuild.value = (await json<{ build: any }>(`/api/projects/${projectId.value}/latex/builds`, { method: 'POST', body: JSON.stringify({ targetId }) })).build
    buildLog.value = ''
    pollBuild()
  } catch (err) { error.value = (err as Error).message }
}
function pollBuild() {
  if (!activeBuild.value) return
  if (buildTimer.value) window.clearTimeout(buildTimer.value)
  buildTimer.value = window.setTimeout(async () => {
    try {
      activeBuild.value = (await json<{ build: any }>(`/api/projects/${projectId.value}/latex/builds/${activeBuild.value.id}`)).build
      if (['queued','running'].includes(activeBuild.value.status)) pollBuild()
      else {
        buildLog.value = (await json<{ log: string }>(`/api/projects/${projectId.value}/latex/builds/${activeBuild.value.id}/log`)).log || ''
        await loadHistory()
      }
    } catch (err) { error.value = (err as Error).message }
  }, 900)
}

const originalCreateConversation = chatStore.createConversation
async function createProjectConversation() {
  const data = await json<{ conversation: any }>('/api/conversations', { method: 'POST', body: JSON.stringify({ title: '新对话', projectId: projectId.value, model: chatStore.currentModel || undefined }) })
  conversations.value.unshift(data.conversation)
  chatStore.conversations = [...conversations.value]
  await chatStore.selectConversation(data.conversation.id)
  return data.conversation
}

async function loadProjectConversations() {
  const data = await json<{ conversations: any[] }>(`/api/conversations?projectId=${encodeURIComponent(projectId.value)}`)
  conversations.value = data.conversations
  chatStore.conversations = data.conversations
  if (!data.conversations.some(item => item.id === chatStore.currentConvId)) {
    if (data.conversations[0]) await chatStore.selectConversation(data.conversations[0].id)
    else await createProjectConversation()
  }
}

const gitLabel = computed(() => {
  const status = store.gitStatus
  if (!status) return 'Git'
  const branch = status.branch || (status.detached ? 'detached' : 'unborn')
  return `${branch} · ${status.files.length} changes`
})

let events: EventSource | null = null
async function initialize() {
  error.value = ''
  ;(chatStore as any).createConversation = createProjectConversation
  try {
    await Promise.all([
      store.fetchProject(projectId.value), loadFiles(), loadGit(), loadHistory(), loadLatexTargets(), loadProjectConversations(),
    ])
    events = new EventSource('/api/events', { withCredentials: true })
    events.onmessage = event => {
      try {
        const data = JSON.parse(event.data)
        if (data.type === 'project-files-changed' && data.projectId === projectId.value) {
          void loadFiles(); void loadGit(); void loadHistory()
          if (selectedPath.value) void loadFileHistory()
        }
      } catch {}
    }
  } catch (err) { error.value = (err as Error).message }
}

onBeforeRouteLeave(async () => {
  const live = currentLive.value
  if (!live) return true
  if (live.conflict.value) {
    return window.confirm('当前 Project 文件存在未解决冲突。离开会放弃浏览器中的本地冲突缓冲，确定离开吗？')
  }
  if (live.dirty.value) {
    try { await live.flush() }
    catch (err) { error.value = (err as Error).message; return false }
  }
  return true
})

onMounted(initialize)
onBeforeUnmount(() => {
  events?.close()
  currentLive.value?.close()
  if (buildTimer.value) window.clearTimeout(buildTimer.value)
  ;(chatStore as any).createConversation = originalCreateConversation
  void chatStore.fetchConversations().catch(() => undefined)
})
</script>

<template>
  <main class="workspace">
    <header class="header">
      <button class="back" @click="router.push('/projects')">← 项目</button>
      <div class="project-title">
        <h1>{{ store.currentProject?.name || 'Project' }}</h1>
        <div class="meta">
          <span>{{ gitLabel }}</span>
          <span v-if="store.gitStatus?.head">HEAD {{ store.gitStatus.head.slice(0, 7) }}</span>
          <span v-if="activeBuild">LaTeX {{ activeBuild.status }}</span>
        </div>
      </div>
      <div class="actions">
        <button @click="router.push('/')">文献</button>
        <button @click="startBuild">Build</button>
        <button @click="createProjectConversation">New Agent Chat</button>
      </div>
    </header>

    <p v-if="error" class="error">{{ error }}</p>

    <section class="layout">
      <aside class="left">
        <nav class="tabs">
          <button :class="{active: sideTab==='files'}" @click="sideTab='files'">Files</button>
          <button :class="{active: sideTab==='git'}" @click="sideTab='git'">Git</button>
          <button :class="{active: sideTab==='history'}" @click="sideTab='history'">History</button>
          <button :class="{active: sideTab==='latex'}" @click="sideTab='latex'">LaTeX</button>
        </nav>

        <div v-if="sideTab==='files'" class="panel scroll">
          <div class="toolbar">
            <input v-model="newPath" placeholder="path/to/file.tex" @keyup.enter="createFile" />
            <button @click="createFile">+File</button>
            <button @click="createDirectory">+Dir</button>
            <button @click="uploadInput?.click()">Upload</button>
            <input ref="uploadInput" type="file" hidden @change="uploadFile" />
          </div>
          <button v-for="item in flatFiles" :key="item.node.path" class="file-row" :class="{selected:item.node.path===selectedPath}" :style="{paddingLeft:`${10+item.depth*14}px`}" :disabled="item.node.type==='directory'" @click="item.node.type==='file' && openFile(item.node.path)">
            <span>{{ item.node.type === 'directory' ? '▾' : '·' }}</span>{{ item.node.name }}
          </button>
          <div v-if="selectedPath" class="toolbar bottom">
            <button v-if="!selectedEditable" @click="openSystemFile()">Open system</button>
            <button @click="renameSelected">Rename</button><button class="danger" @click="deleteSelected">Delete</button>
          </div>
        </div>

        <div v-else-if="sideTab==='git'" class="panel scroll">
          <div class="branch-row">
            <select :value="store.gitStatus?.branch || ''" @change="onBranchChange">
              <option v-for="branch in branches" :key="branch.name" :value="branch.name">{{ branch.name }}</option>
            </select>
            <button @click="createBranch">+ Branch</button>
          </div>
          <div v-for="file in store.gitStatus?.files || []" :key="file.path" class="git-file">
            <button class="path" @click="openFile(file.path)">
              {{ file.indexStatus }}{{ file.worktreeStatus }} {{ file.originalPath ? `${file.originalPath} → ${file.path}` : file.path }}
            </button>
            <div><button v-if="file.indexStatus===' ' || file.indexStatus==='?'" @click="stage(file.path)">Stage</button><button v-else @click="unstage(file.path)">Unstage</button></div>
          </div>
          <textarea v-model="commitMessage" rows="3" placeholder="Commit message" />
          <button class="primary" @click="commit">Commit staged</button>
          <h3>Remotes</h3>
          <div v-if="!remotes.length" class="muted-row">No remotes configured</div>
          <div v-for="remote in remotes" :key="remote.name" class="remote"><strong>{{ remote.name }}</strong><small v-if="remote.fetch">fetch · {{ remote.fetch }}</small><small v-if="remote.push && remote.push !== remote.fetch">push · {{ remote.push }}</small></div>
          <h3>Recent commits</h3>
          <div v-for="item in commits" :key="item.hash" class="commit"><code>{{ item.shortHash }}</code> {{ item.subject }}</div>
        </div>

        <div v-else-if="sideTab==='history'" class="panel scroll">
          <template v-if="selectedPath && selectedEditable">
            <h3>{{ selectedPath }}</h3>
            <div v-for="revision in fileHistory" :key="revision.id" class="checkpoint">
              <div><strong>{{ checkpointTitle(revision.checkpoint || ({ kind: 'revision', metadata: {} } as any)) }}</strong><small>{{ new Date(revision.createdAt).toLocaleString() }} · {{ revision.deleted ? 'deleted' : `${revision.size} B` }}</small></div>
              <div class="row-actions">
                <button @click="previewRevision(revision, 'preview')">Preview</button>
                <button @click="previewRevision(revision, 'current')">Diff current</button>
                <button @click="previewRevision(revision, 'previous')">Diff previous</button>
                <button @click="restoreRevision(revision)">Restore file</button>
              </div>
            </div>
          </template>
          <h3>Writing checkpoints</h3>
          <div v-for="checkpoint in history" :key="checkpoint.id" class="checkpoint">
            <div><strong>{{ checkpointTitle(checkpoint) }}</strong><small>{{ new Date(checkpoint.createdAt).toLocaleString() }}</small></div>
            <div class="row-actions"><button @click="pinCheckpoint(checkpoint)">{{ checkpoint.pinned ? 'Unpin' : 'Pin' }}</button><button @click="restoreCheckpoint(checkpoint.id)">Restore writing</button></div>
          </div>
        </div>

        <div v-else class="panel scroll">
          <div class="latex-head"><strong>Targets</strong><button @click="addLatexTarget">+ Target</button></div>
          <label>Default<select v-model="defaultLatexTargetDraft"><option v-for="target in latexTargetsDraft" :key="target.id" :value="target.id">{{ target.name }}</option></select></label>
          <div v-for="target in latexTargetsDraft" :key="target.id" class="target-card" :class="{selected:activeTargetId===target.id}" @click="activeTargetId=target.id">
            <input v-model="target.name" placeholder="Target name" />
            <input v-model="target.entry" placeholder="main.tex" />
            <input v-model="target.sourceRoot" placeholder="." />
            <select v-model="target.engine"><option value="pdflatex">pdflatex</option><option value="xelatex">xelatex</option><option value="lualatex">lualatex</option></select>
          </div>
          <button class="primary" @click="saveLatexTargets">Save targets</button>
          <button @click="startBuild">Build selected target</button>
          <pre v-if="buildLog" class="build-log">{{ buildLog }}</pre>
        </div>
      </aside>

      <section class="center">
        <div class="editor-header">
          <span>{{ selectedPath || '选择一个文件' }}</span>
          <span v-if="selectedPath" :class="`save-${liveState}`">{{ liveState }}</span>
          <button v-if="currentLive?.dirty.value" @click="flushFile">Flush</button>
          <template v-if="currentLive?.conflict.value"><button @click="resolveLiveConflict('use-live')">Keep editor</button><button @click="resolveLiveConflict('use-disk')">Use disk</button></template>
        </div>
        <div v-if="selectedPath && selectedEditable" class="editor-wrap"><CodeEditor v-model="content" :language="language" @save="flushFile" /></div>
        <div v-else-if="selectedPath" class="empty external-file"><div><strong>{{ fileName(selectedPath) }}</strong><p>该文件不通过文本 LiveFile 编辑。可使用系统应用打开，Git 仍会正常追踪它。</p><button @click="openSystemFile()">Open system</button></div></div>
        <div v-else class="empty">从 Files 选择文件开始编辑。</div>

        <section v-if="historyPreview" class="history-compare">
          <header><strong>Writing History · {{ historyPreview.revision.path }}</strong><button @click="historyPreview=null">×</button></header>
          <div v-if="historyPreview.mode==='preview'" class="history-preview"><small>Revision</small><pre>{{ historyPreview.content ?? '[deleted]' }}</pre></div>
          <div v-else class="diff-lines" role="region" aria-label="Writing History text diff">
            <small>{{ historyPreview.mode === 'current' ? 'Revision → Current' : `${historyPreview.baseLabel || 'Previous'} → Revision` }}</small>
            <pre><span v-for="(line, index) in historyDiff" :key="index" :class="`diff-${line.kind}`">{{ line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' ' }} {{ line.text }}
</span></pre>
          </div>
        </section>
        <pre v-if="gitDiff && sideTab==='git'" class="diff">{{ gitDiff }}</pre>
        <iframe v-if="activeBuild?.status==='completed' && activeBuild.pdfAvailable" class="pdf" :src="`/api/projects/${projectId}/latex/builds/${activeBuild.id}/pdf`" title="LaTeX PDF" />
      </section>

      <aside class="chat"><ChatPanel :current-resource="currentResource" current-resource-notice="请先在 Project Files 中选择一个文件" @open-file="openFile" /></aside>
    </section>
  </main>
</template>

<style scoped>
.workspace{height:100vh;display:flex;flex-direction:column;background:var(--bg-primary,#151515);color:var(--text-primary,#e8e8e8)}.header{height:64px;display:flex;align-items:center;gap:16px;padding:0 16px;border-bottom:1px solid rgba(127,127,127,.2)}button,input,select,textarea{font:inherit}.back,.actions button,.tabs button,.panel button,.editor-header button,.external-file button{background:transparent;color:inherit;border:1px solid rgba(127,127,127,.24);border-radius:6px;padding:6px 9px;cursor:pointer}.project-title{min-width:0;flex:1}.project-title h1{font-size:16px;margin:0 0 4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.meta{display:flex;gap:12px;font-size:11px;opacity:.58}.actions{display:flex;gap:8px}.layout{min-height:0;flex:1;display:grid;grid-template-columns:310px minmax(420px,1fr) minmax(340px,430px)}.left,.center,.chat{min-height:0;border-right:1px solid rgba(127,127,127,.18)}.left{display:flex;flex-direction:column}.tabs{display:flex;padding:8px;gap:5px;border-bottom:1px solid rgba(127,127,127,.15)}.tabs button{padding:5px 7px}.tabs .active{background:rgba(127,127,127,.18)}.panel{padding:8px;display:flex;flex-direction:column;gap:6px}.scroll{overflow:auto}.toolbar{display:flex;gap:4px;flex-wrap:wrap}.toolbar input{min-width:0;flex:1}.toolbar.bottom{margin-top:8px}.file-row{width:100%;border:0!important;text-align:left!important;display:flex;gap:6px}.file-row.selected,.target-card.selected{background:rgba(100,120,255,.18)}.file-row:disabled{opacity:.7;cursor:default}.git-file{display:flex;gap:4px;justify-content:space-between;align-items:center}.git-file .path{border:0;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.panel input,.panel select,.panel textarea{box-sizing:border-box;background:transparent;color:inherit;border:1px solid rgba(127,127,127,.24);border-radius:6px;padding:7px}.panel textarea{width:100%}.primary{background:var(--accent-color,#6d7cff)!important;color:white!important}.danger{color:#f56c6c!important}.panel h3{font-size:12px;margin:12px 0 2px;opacity:.68}.commit{font-size:12px;line-height:1.5}.remote{font-size:11px;padding:6px 4px;display:grid;gap:2px;word-break:break-all}.remote small,.muted-row{opacity:.55}.checkpoint{padding:9px;border-bottom:1px solid rgba(127,127,127,.14);display:grid;gap:8px}.checkpoint small{display:block;opacity:.5;margin-top:3px}.row-actions,.branch-row,.latex-head{display:flex;gap:4px;align-items:center;flex-wrap:wrap}.branch-row select{flex:1}.latex-head{justify-content:space-between}.panel label{display:grid;gap:4px;font-size:11px;opacity:.8}.target-card{padding:8px;border:1px solid rgba(127,127,127,.16);border-radius:7px;display:grid;gap:5px;cursor:pointer}.center{display:flex;flex-direction:column;overflow:hidden}.editor-header{height:40px;display:flex;align-items:center;gap:10px;padding:0 10px;border-bottom:1px solid rgba(127,127,127,.15);font-size:12px}.editor-header span:first-child{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.save-dirty{color:#e6a23c}.save-conflict{color:#f56c6c}.save-saved{color:#67c23a}.save-offline{color:#909399}.save-external{opacity:.55}.editor-wrap{flex:1;min-height:0}.empty{display:grid;place-items:center;flex:1;opacity:.55;text-align:center;padding:20px}.external-file p{max-width:460px;font-size:12px}.diff,.build-log{max-height:220px;overflow:auto;border-top:1px solid rgba(127,127,127,.2);padding:12px;margin:0;font-size:11px;white-space:pre-wrap}.history-compare{max-height:42%;display:flex;flex-direction:column;border-top:1px solid rgba(127,127,127,.2)}.history-compare header{height:34px;padding:0 9px;display:flex;align-items:center;justify-content:space-between}.history-compare header button{background:transparent;border:0;color:inherit;cursor:pointer}.history-preview,.diff-lines{min-height:0;overflow:auto;padding:8px}.history-preview small,.diff-lines small{opacity:.55}.history-preview pre,.diff-lines pre{font-size:11px;white-space:pre-wrap;margin:5px 0}.diff-lines pre span{display:block;min-height:1.3em}.diff-add{background:rgba(70,160,90,.12)}.diff-remove{background:rgba(200,80,80,.12)}.diff-same{opacity:.7}.pdf{height:45%;border:0;border-top:1px solid rgba(127,127,127,.2);background:white}.chat{overflow:hidden}.error{margin:0;padding:8px 16px;background:rgba(210,60,60,.14);color:#e66}
@media (max-width:1100px){.layout{grid-template-columns:260px 1fr}.chat{display:none}}@media (max-width:720px){.layout{grid-template-columns:1fr}.left{display:none}.actions{display:none}}
</style>
