<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import CodeEditor from '@/components/files/CodeEditor.vue'
import ChatPanel from '@/components/chat/ChatPanel.vue'
import { useProjectsStore } from '@/stores/projects'
import { useChatStore } from '@/stores/chat'
import type { ProjectGitCommit, ProjectHistoryCheckpoint } from '@yarc/shared'

type FileNode = { name: string; path: string; type: 'file' | 'directory'; children?: FileNode[]; size?: number }

const route = useRoute()
const router = useRouter()
const store = useProjectsStore()
const chatStore = useChatStore()
const projectId = computed(() => String(route.params.id || ''))
const sideTab = ref<'files' | 'git' | 'history'>('files')
const files = ref<FileNode[]>([])
const selectedPath = ref('')
const content = ref('')
const savedContent = ref('')
const fileLoading = ref(false)
const saveState = ref<'saved' | 'dirty' | 'saving' | 'error'>('saved')
const commits = ref<ProjectGitCommit[]>([])
const history = ref<ProjectHistoryCheckpoint[]>([])
const gitDiff = ref('')
const commitMessage = ref('')
const error = ref('')
const activeBuild = ref<any>(null)
const buildTimer = ref<number | null>(null)
const conversations = ref<any[]>([])

const json = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(url, {
    credentials: 'include', ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data?.error?.message || data?.message || `Request failed (${response.status})`)
  return data as T
}

const language = computed(() => {
  const ext = selectedPath.value.split('.').pop()?.toLowerCase()
  return ({ tex: 'latex', bib: 'bibtex', md: 'markdown', json: 'json', ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', vue: 'vue', py: 'python', css: 'css', html: 'html', yaml: 'yaml', yml: 'yaml', sql: 'sql', sh: 'shell', xml: 'xml' } as Record<string,string>)[ext || ''] || 'plaintext'
})

const dirty = computed(() => content.value !== savedContent.value)
watch(dirty, value => { saveState.value = value ? 'dirty' : 'saved' })

async function loadFiles() {
  const data = await json<{ files: FileNode[] }>(`/api/projects/${projectId.value}/files`)
  files.value = data.files
}

async function openFile(path: string) {
  if (dirty.value && !window.confirm('当前文件有未保存修改，仍然切换吗？')) return
  fileLoading.value = true
  try {
    const data = await json<{ content: string }>(`/api/projects/${projectId.value}/files/content?path=${encodeURIComponent(path)}`)
    selectedPath.value = path
    content.value = data.content
    savedContent.value = data.content
    saveState.value = 'saved'
  } catch (err) { error.value = (err as Error).message }
  finally { fileLoading.value = false }
}

async function saveFile() {
  if (!selectedPath.value || !dirty.value) return
  saveState.value = 'saving'
  try {
    await json(`/api/projects/${projectId.value}/files/content`, { method: 'PUT', body: JSON.stringify({ path: selectedPath.value, content: content.value }) })
    savedContent.value = content.value
    saveState.value = 'saved'
    await Promise.all([loadGit(), loadHistory()])
  } catch (err) {
    saveState.value = 'error'
    error.value = (err as Error).message
  }
}

async function loadGit() {
  const [status, log] = await Promise.all([
    store.fetchGitStatus(projectId.value),
    json<{ commits: ProjectGitCommit[] }>(`/api/projects/${projectId.value}/git/log`),
  ])
  commits.value = log.commits
  if (selectedPath.value && status.files.some(file => file.path === selectedPath.value)) {
    gitDiff.value = (await json<{ diff: string }>(`/api/projects/${projectId.value}/git/diff?path=${encodeURIComponent(selectedPath.value)}`)).diff
  } else gitDiff.value = ''
}

async function stage(path: string) {
  await json(`/api/projects/${projectId.value}/git/stage`, { method: 'POST', body: JSON.stringify({ paths: [path] }) })
  await loadGit()
}
async function unstage(path: string) {
  await json(`/api/projects/${projectId.value}/git/unstage`, { method: 'POST', body: JSON.stringify({ paths: [path] }) })
  await loadGit()
}
async function commit() {
  if (!commitMessage.value.trim()) return
  await json(`/api/projects/${projectId.value}/git/commit`, { method: 'POST', body: JSON.stringify({ message: commitMessage.value }) })
  commitMessage.value = ''
  await loadGit()
}

async function loadHistory() {
  history.value = (await json<{ checkpoints: ProjectHistoryCheckpoint[] }>(`/api/projects/${projectId.value}/history`)).checkpoints
}
async function restoreCheckpoint(checkpointId: string) {
  if (!window.confirm('恢复该 Writing Checkpoint？当前写作状态会先自动创建 pre-restore checkpoint。')) return
  await json(`/api/projects/${projectId.value}/history/checkpoints/${checkpointId}/restore`, { method: 'POST' })
  await loadFiles()
  if (selectedPath.value) await openFile(selectedPath.value)
  await Promise.all([loadHistory(), loadGit()])
}
async function pinCheckpoint(checkpoint: ProjectHistoryCheckpoint) {
  await json(`/api/projects/${projectId.value}/history/checkpoints/${checkpoint.id}/pin`, { method: 'POST', body: JSON.stringify({ pinned: !checkpoint.pinned }) })
  await loadHistory()
}

async function startBuild() {
  const targetId = store.defaultLatexTarget || store.latexTargets[0]?.id
  if (!targetId) throw new Error('请先在 Project settings 中配置 LaTeX target')
  await saveFile()
  activeBuild.value = (await json<{ build: any }>(`/api/projects/${projectId.value}/latex/builds`, { method: 'POST', body: JSON.stringify({ targetId }) })).build
  pollBuild()
}
function pollBuild() {
  if (!activeBuild.value) return
  if (buildTimer.value) window.clearTimeout(buildTimer.value)
  buildTimer.value = window.setTimeout(async () => {
    activeBuild.value = (await json<{ build: any }>(`/api/projects/${projectId.value}/latex/builds/${activeBuild.value.id}`)).build
    if (['queued','running'].includes(activeBuild.value.status)) pollBuild()
    else await loadHistory()
  }, 900)
}

async function loadProjectConversations() {
  const data = await json<{ conversations: any[] }>(`/api/conversations?projectId=${encodeURIComponent(projectId.value)}`)
  conversations.value = data.conversations
  chatStore.conversations = data.conversations
  if (!data.conversations.some(item => item.id === chatStore.currentConvId)) {
    if (data.conversations[0]) await chatStore.selectConversation(data.conversations[0].id)
    else await newConversation()
  }
}
async function newConversation() {
  const data = await json<{ conversation: any }>('/api/conversations', { method: 'POST', body: JSON.stringify({ title: '新对话', projectId: projectId.value }) })
  conversations.value.unshift(data.conversation)
  chatStore.conversations = [...conversations.value]
  await chatStore.selectConversation(data.conversation.id)
}

function flattenNodes(nodes: FileNode[], depth = 0): Array<{ node: FileNode; depth: number }> {
  return nodes.flatMap(node => [{ node, depth }, ...(node.children ? flattenNodes(node.children, depth + 1) : [])])
}
const flatFiles = computed(() => flattenNodes(files.value))
const gitLabel = computed(() => {
  const status = store.gitStatus
  if (!status) return 'Git'
  const branch = status.branch || (status.detached ? 'detached' : 'unborn')
  return `${branch} · ${status.files.length} changes`
})

let events: EventSource | null = null
async function initialize() {
  error.value = ''
  try {
    await Promise.all([
      store.fetchProject(projectId.value), loadFiles(), loadGit(), loadHistory(), store.fetchLatexTargets(projectId.value), loadProjectConversations(),
    ])
    events = new EventSource('/api/events', { withCredentials: true })
    events.onmessage = event => {
      try {
        const data = JSON.parse(event.data)
        if (data.type === 'project-files-changed' && data.projectId === projectId.value) {
          void loadFiles(); void loadGit(); void loadHistory()
        }
      } catch {}
    }
  } catch (err) { error.value = (err as Error).message }
}

onMounted(initialize)
onBeforeUnmount(() => { events?.close(); if (buildTimer.value) window.clearTimeout(buildTimer.value) })
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
        <button @click="startBuild">Build</button>
        <button @click="newConversation">New Agent Chat</button>
      </div>
    </header>

    <p v-if="error" class="error">{{ error }}</p>

    <section class="layout">
      <aside class="left">
        <nav class="tabs">
          <button :class="{active: sideTab==='files'}" @click="sideTab='files'">Files</button>
          <button :class="{active: sideTab==='git'}" @click="sideTab='git'">Git</button>
          <button :class="{active: sideTab==='history'}" @click="sideTab='history'">History</button>
        </nav>

        <div v-if="sideTab==='files'" class="panel scroll">
          <button v-for="item in flatFiles" :key="item.node.path" class="file-row" :class="{selected:item.node.path===selectedPath}" :style="{paddingLeft:`${10+item.depth*14}px`}" :disabled="item.node.type==='directory'" @click="item.node.type==='file' && openFile(item.node.path)">
            <span>{{ item.node.type === 'directory' ? '▾' : '·' }}</span>{{ item.node.name }}
          </button>
        </div>

        <div v-else-if="sideTab==='git'" class="panel scroll">
          <div v-for="file in store.gitStatus?.files || []" :key="file.path" class="git-file">
            <button class="path" @click="openFile(file.path)">{{ file.indexStatus }}{{ file.worktreeStatus }} {{ file.path }}</button>
            <div>
              <button v-if="file.indexStatus===' ' || file.indexStatus==='?'" @click="stage(file.path)">Stage</button>
              <button v-else @click="unstage(file.path)">Unstage</button>
            </div>
          </div>
          <textarea v-model="commitMessage" rows="3" placeholder="Commit message" />
          <button class="primary" @click="commit">Commit staged</button>
          <h3>Recent commits</h3>
          <div v-for="item in commits" :key="item.hash" class="commit"><code>{{ item.shortHash }}</code> {{ item.subject }}</div>
        </div>

        <div v-else class="panel scroll">
          <div v-for="checkpoint in history" :key="checkpoint.id" class="checkpoint">
            <div><strong>{{ checkpoint.kind }}</strong><small>{{ new Date(checkpoint.createdAt).toLocaleString() }}</small></div>
            <div class="row-actions"><button @click="pinCheckpoint(checkpoint)">{{ checkpoint.pinned ? 'Unpin' : 'Pin' }}</button><button @click="restoreCheckpoint(checkpoint.id)">Restore writing</button></div>
          </div>
        </div>
      </aside>

      <section class="center">
        <div class="editor-header">
          <span>{{ selectedPath || '选择一个文件' }}</span>
          <span v-if="selectedPath" :class="`save-${saveState}`">{{ saveState }}</span>
          <button v-if="selectedPath && dirty" @click="saveFile">Save</button>
        </div>
        <div v-if="selectedPath" class="editor-wrap">
          <CodeEditor v-model="content" :language="language" @save="saveFile" />
        </div>
        <div v-else class="empty">从 Files 选择文件开始编辑。</div>
        <pre v-if="gitDiff && sideTab==='git'" class="diff">{{ gitDiff }}</pre>
        <iframe v-if="activeBuild?.status==='completed' && activeBuild.pdfAvailable" class="pdf" :src="`/api/projects/${projectId}/latex/builds/${activeBuild.id}/pdf`" title="LaTeX PDF" />
      </section>

      <aside class="chat">
        <ChatPanel @open-file="openFile" />
      </aside>
    </section>
  </main>
</template>

<style scoped>
.workspace{height:100vh;display:flex;flex-direction:column;background:var(--bg-primary,#151515);color:var(--text-primary,#e8e8e8)}.header{height:64px;display:flex;align-items:center;gap:16px;padding:0 16px;border-bottom:1px solid rgba(127,127,127,.2)}.back,.actions button,.tabs button,.panel button,.editor-header button{background:transparent;color:inherit;border:1px solid rgba(127,127,127,.24);border-radius:6px;padding:6px 9px;cursor:pointer}.project-title{min-width:0;flex:1}.project-title h1{font-size:16px;margin:0 0 4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.meta{display:flex;gap:12px;font-size:11px;opacity:.58}.actions{display:flex;gap:8px}.layout{min-height:0;flex:1;display:grid;grid-template-columns:280px minmax(420px,1fr) minmax(340px,430px)}.left,.center,.chat{min-height:0;border-right:1px solid rgba(127,127,127,.18)}.left{display:flex;flex-direction:column}.tabs{display:flex;padding:8px;gap:5px;border-bottom:1px solid rgba(127,127,127,.15)}.tabs .active{background:rgba(127,127,127,.18)}.panel{padding:8px;display:flex;flex-direction:column;gap:6px}.scroll{overflow:auto}.file-row{width:100%;border:0!important;text-align:left!important;display:flex;gap:6px}.file-row.selected{background:rgba(100,120,255,.18)}.file-row:disabled{opacity:.7;cursor:default}.git-file{display:flex;gap:4px;justify-content:space-between;align-items:center}.git-file .path{border:0;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.panel textarea{width:100%;box-sizing:border-box;background:transparent;color:inherit;border:1px solid rgba(127,127,127,.24);border-radius:6px;padding:7px}.primary{background:var(--accent-color,#6d7cff)!important;color:white!important}.panel h3{font-size:12px;margin:12px 0 2px;opacity:.6}.commit{font-size:12px;line-height:1.5}.checkpoint{padding:9px;border-bottom:1px solid rgba(127,127,127,.14);display:grid;gap:8px}.checkpoint small{display:block;opacity:.5;margin-top:3px}.row-actions{display:flex;gap:4px}.center{display:flex;flex-direction:column;overflow:hidden}.editor-header{height:40px;display:flex;align-items:center;gap:10px;padding:0 10px;border-bottom:1px solid rgba(127,127,127,.15);font-size:12px}.editor-header span:first-child{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.save-dirty{color:#e6a23c}.save-error{color:#f56c6c}.editor-wrap{flex:1;min-height:0}.empty{display:grid;place-items:center;flex:1;opacity:.45}.diff{max-height:220px;overflow:auto;border-top:1px solid rgba(127,127,127,.2);padding:12px;margin:0;font-size:11px;white-space:pre-wrap}.pdf{height:45%;border:0;border-top:1px solid rgba(127,127,127,.2);background:white}.chat{overflow:hidden}.error{margin:0;padding:8px 16px;background:rgba(210,60,60,.14);color:#e66}
@media (max-width:1100px){.layout{grid-template-columns:240px 1fr}.chat{display:none}}@media (max-width:720px){.layout{grid-template-columns:1fr}.left{display:none}.actions{display:none}}
</style>
