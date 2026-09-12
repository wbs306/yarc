<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { requestJson } from '@/lib/api-request'
import type {
  ProjectGitBranch,
  ProjectGitCommit,
  ProjectGitFileStatus,
  ProjectGitStatus,
  ProjectHistoryCheckpoint,
  ProjectHistoryRevision,
} from '@yarc/shared'

const props = defineProps<{
  projectId: string
  mode: 'git' | 'history'
  selectedPath?: string
}>()
type HistoryCompareRequest =
  | { kind: 'revision'; revision: FileRevision }
  | { kind: 'checkpoint'; checkpoint: ProjectHistoryCheckpoint }
const emit = defineEmits<{
  'open-file': [path: string]
  'compare-history': [request: HistoryCompareRequest]
}>()

type GitRemote = { name: string; fetch?: string; push?: string }
type FileRevision = ProjectHistoryRevision & { checkpoint?: ProjectHistoryCheckpoint }

const loading = ref(false)
const error = ref('')
const gitStatus = ref<ProjectGitStatus | null>(null)
const commits = ref<ProjectGitCommit[]>([])
const branches = ref<ProjectGitBranch[]>([])
const remotes = ref<GitRemote[]>([])
const selectedPaths = ref<string[]>([])
const commitMessage = ref('')
const checkpoints = ref<ProjectHistoryCheckpoint[]>([])
const revisions = ref<FileRevision[]>([])
const preview = ref<{ title: string; content: string | null } | null>(null)

const apiRoot = computed(() => `/api/projects/${encodeURIComponent(props.projectId)}`)
const gitGroups = computed(() => {
  const groups = new Map<string, ProjectGitFileStatus[]>()
  for (const file of gitStatus.value?.files || []) {
    const ext = file.path.split('.').pop()?.toLowerCase() || ''
    const group = ['tex', 'bib', 'sty', 'cls', 'bst'].includes(ext)
      ? '文档'
      : ['py', 'r', 'jl', 'm', 'c', 'h', 'cpp', 'hpp', 'ts', 'tsx', 'js', 'jsx', 'vue', 'sh', 'sql'].includes(ext)
        ? '代码'
        : '其他'
    const items = groups.get(group) || []
    items.push(file)
    groups.set(group, items)
  }
  return [...groups.entries()]
})

const changedFileCount = computed(() => gitStatus.value?.files.length || 0)
const stagedFileCount = computed(() => (gitStatus.value?.files || []).filter(file => file.indexStatus !== ' ' && file.indexStatus !== '?').length)
const checkpointCount = computed(() => checkpoints.value.length)
const revisionCount = computed(() => revisions.value.length)
const checkpointFileCount = (checkpoint: ProjectHistoryCheckpoint) =>
  checkpoint.snapshotFileCount ?? checkpoint.snapshotRevisions?.length ?? checkpoint.revisions?.length ?? 0

const gitFileState = (file: ProjectGitFileStatus) => {
  if (file.indexStatus === 'U' || file.worktreeStatus === 'U') return { label: '冲突', tone: 'conflict' }
  if (file.indexStatus === '?' || file.worktreeStatus === '?') return { label: '未跟踪', tone: 'untracked' }
  if (file.indexStatus !== ' ' && file.worktreeStatus !== ' ') return { label: '已暂存 · 修改', tone: 'staged' }
  if (file.indexStatus !== ' ') return { label: '已暂存', tone: 'staged' }
  return { label: '已修改', tone: 'modified' }
}

const loadGit = async () => {
  const [status, log, branchData, remoteData] = await Promise.all([
    requestJson<{ status: ProjectGitStatus }>(`${apiRoot.value}/git/status`),
    requestJson<{ commits: ProjectGitCommit[] }>(`${apiRoot.value}/git/log`),
    requestJson<{ branches: ProjectGitBranch[] }>(`${apiRoot.value}/git/branches`),
    requestJson<{ remotes: GitRemote[] }>(`${apiRoot.value}/git/remotes`),
  ])
  gitStatus.value = status.status
  commits.value = log.commits
  branches.value = branchData.branches
  remotes.value = remoteData.remotes
  selectedPaths.value = selectedPaths.value.filter(path => status.status.files.some(file => file.path === path))
}

const loadHistory = async () => {
  const history = await requestJson<{ checkpoints: ProjectHistoryCheckpoint[] }>(`${apiRoot.value}/history`)
  checkpoints.value = history.checkpoints
  if (props.selectedPath) {
    const file = await requestJson<{ revisions: FileRevision[] }>(`${apiRoot.value}/history/files?path=${encodeURIComponent(props.selectedPath)}`)
    revisions.value = file.revisions
  } else revisions.value = []
}

const reload = async (options: { flushHistory?: boolean } = {}) => {
  loading.value = true
  error.value = ''
  try {
    if (props.mode === 'git') await loadGit()
    else {
      if (options.flushHistory) await requestJson(`${apiRoot.value}/history/flush`, { method: 'POST' })
      await loadHistory()
    }
  } catch (err) {
    error.value = (err as Error).message || '加载项目数据失败'
  } finally {
    loading.value = false
  }
}
const manualReload = () => { void reload({ flushHistory: props.mode === 'history' }) }

let refreshTimer: number | null = null
const scheduleReload = () => {
  if (refreshTimer !== null) window.clearTimeout(refreshTimer)
  refreshTimer = window.setTimeout(() => {
    refreshTimer = null
    void reload()
  }, 160)
}
const onProjectFilesChanged = (event: Event) => {
  const detail = (event as CustomEvent).detail || {}
  if (detail.projectId === props.projectId) scheduleReload()
}

onMounted(() => window.addEventListener('yarc-project-files-changed', onProjectFilesChanged))
onBeforeUnmount(() => {
  window.removeEventListener('yarc-project-files-changed', onProjectFilesChanged)
  if (refreshTimer !== null) window.clearTimeout(refreshTimer)
})

watch(() => [props.projectId, props.mode, props.selectedPath] as const, () => { void reload() }, { immediate: true })

const runMutation = async (operation: () => Promise<void>) => {
  error.value = ''
  try {
    await operation()
  } catch (err) {
    error.value = (err as Error).message || '项目操作失败'
  }
}
const stage = (path: string) => runMutation(async () => {
  await requestJson(`${apiRoot.value}/git/stage`, { method: 'POST', body: JSON.stringify({ paths: [path] }) })
  await loadGit()
})
const unstage = (path: string) => runMutation(async () => {
  await requestJson(`${apiRoot.value}/git/unstage`, { method: 'POST', body: JSON.stringify({ paths: [path] }) })
  await loadGit()
})
const stageSelected = () => runMutation(async () => {
  if (!selectedPaths.value.length) return
  await requestJson(`${apiRoot.value}/git/stage`, { method: 'POST', body: JSON.stringify({ paths: selectedPaths.value }) })
  selectedPaths.value = []
  await loadGit()
})
const commit = () => runMutation(async () => {
  if (!commitMessage.value.trim()) return
  await requestJson(`${apiRoot.value}/git/commit`, { method: 'POST', body: JSON.stringify({ message: commitMessage.value.trim() }) })
  commitMessage.value = ''
  await loadGit()
})
const createBranch = async () => {
  const name = window.prompt('新分支名称')?.trim()
  if (!name) return
  await runMutation(async () => {
    await requestJson(`${apiRoot.value}/git/branches`, { method: 'POST', body: JSON.stringify({ name }) })
    await loadGit()
  })
}
const switchBranch = async (name: string) => {
  if (!name || name === gitStatus.value?.branch) return
  if (!window.confirm(`切换到分支 ${name}？`)) return
  await runMutation(async () => {
    await requestJson(`${apiRoot.value}/git/branches/switch`, { method: 'POST', body: JSON.stringify({ name }) })
    await loadGit()
  })
}
const pinCheckpoint = (checkpoint: ProjectHistoryCheckpoint) => runMutation(async () => {
  await requestJson(`${apiRoot.value}/history/checkpoints/${checkpoint.id}/pin`, { method: 'POST', body: JSON.stringify({ pinned: !checkpoint.pinned }) })
  await loadHistory()
})
const restoreCheckpoint = async (checkpoint: ProjectHistoryCheckpoint) => {
  if (!window.confirm(`恢复写作检查点“${checkpoint.label || checkpoint.kind}”？当前状态会先自动留痕。`)) return
  await runMutation(async () => {
    await requestJson(`${apiRoot.value}/history/checkpoints/${checkpoint.id}/restore`, { method: 'POST' })
    await loadHistory()
  })
}
const previewRevision = (revision: FileRevision) => runMutation(async () => {
  const data = await requestJson<{ revision: FileRevision; content: string | null }>(`${apiRoot.value}/history/revisions/${revision.id}`)
  preview.value = { title: `${revision.path} · ${new Date(revision.createdAt).toLocaleString()}`, content: data.content }
})
const restoreRevision = async (revision: FileRevision) => {
  if (!window.confirm(`恢复文件“${revision.path}”到该版本？`)) return
  await runMutation(async () => {
    await requestJson(`${apiRoot.value}/history/revisions/${revision.id}/restore`, { method: 'POST' })
    emit('open-file', revision.path)
    await loadHistory()
  })
}
</script>

<template>
  <section class="project-tools-panel" :class="`project-tools-${mode}`">
    <div class="project-tools-header">
      <div class="project-tools-heading">
        <span class="project-tools-icon" aria-hidden="true">
          <svg v-if="mode === 'git'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="6" cy="6" r="2.2" /><circle cx="18" cy="6" r="2.2" /><circle cx="12" cy="18" r="2.2" /><path d="M8.2 6h7.6M7.4 7.8l3.2 7.9M16.6 7.8l-3.2 7.9" />
          </svg>
          <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M6 3v18M6 5h11l-2.8 3L17 11H6" /><circle cx="6" cy="21" r="1" />
          </svg>
        </span>
        <div>
          <p class="project-tools-kicker">项目工作区</p>
          <h1>{{ mode === 'git' ? 'Git' : 'Writing History' }}</h1>
          <p class="project-tools-subtitle">{{ mode === 'git' ? '整理变更并创建可追踪的版本' : '查看写作留痕，安全回到任意版本' }}</p>
        </div>
      </div>
      <button class="project-tools-refresh" :disabled="loading" :title="mode === 'history' ? '刷新历史；必要时同步待处理记录' : '刷新'" @click="manualReload">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 0 0-14.7-4L4 9" /><path d="M4 4v5h5" /><path d="M4 13a8 8 0 0 0 14.7 4L20 15" /><path d="M20 20v-5h-5" /></svg>
        <span>刷新</span>
      </button>
    </div>

    <p v-if="error" class="project-tools-error"><span>!</span>{{ error }}</p>
    <div v-else-if="loading" class="project-tools-loading" aria-live="polite">
      <span class="loading-line wide" /><span class="loading-line" /><span class="loading-line short" />
      <span class="loading-card" /><span class="loading-card" />
    </div>

    <template v-else-if="mode === 'git'">
      <div class="project-tools-toolbar">
        <label class="project-branch-control">
          <span>当前分支</span>
          <select :value="gitStatus?.branch || ''" @change="switchBranch(($event.target as HTMLSelectElement).value)">
            <option v-for="branch in branches" :key="branch.name" :value="branch.name">{{ branch.name }}</option>
          </select>
        </label>
        <div class="project-tools-actions">
          <button class="project-tool-button" @click="createBranch"><span class="button-symbol">＋</span>新建分支</button>
          <button class="project-tool-button" :disabled="!selectedPaths.length" @click="stageSelected"><span class="button-symbol">✓</span>暂存所选</button>
        </div>
      </div>

      <div class="project-git-summary" aria-label="Git 状态摘要">
        <div class="project-stat-card">
          <span class="project-stat-label"><i class="stat-dot changes" />工作区</span>
          <strong>{{ changedFileCount ? `${changedFileCount} 项修改` : '干净' }}</strong>
          <small>{{ gitStatus?.dirty ? '有未提交变更' : '当前没有未提交变更' }}</small>
        </div>
        <div class="project-stat-card">
          <span class="project-stat-label"><i class="stat-dot staged" />暂存区</span>
          <strong>{{ stagedFileCount }} 项</strong>
          <small>{{ gitStatus?.branch || '未命名分支' }}</small>
        </div>
      </div>

      <div v-if="!gitStatus?.files.length" class="project-tools-empty project-tools-empty-card">
        <span class="empty-state-icon">✓</span>
        <strong>工作区很干净</strong>
        <span>没有待提交的文件变更。</span>
      </div>
      <section v-for="[group, files] in gitGroups" v-else :key="group" class="project-tools-group">
        <div class="project-tools-group-heading">
          <div><span class="group-kicker">变更文件</span><h2>{{ group }}</h2></div>
          <span class="group-count">{{ files.length }}</span>
        </div>
        <div class="project-git-list">
          <div v-for="file in files" :key="file.path" class="project-git-row" :class="{ selected: selectedPaths.includes(file.path) }">
            <label class="project-git-check" :title="selectedPaths.includes(file.path) ? '取消选择' : '选择暂存'">
              <input v-model="selectedPaths" type="checkbox" :value="file.path" :disabled="file.indexStatus !== ' ' && file.indexStatus !== '?'" />
              <span aria-hidden="true" />
            </label>
            <button class="project-path-button" :title="file.path" @click="emit('open-file', file.path)">
              <span class="git-status-badge" :class="`tone-${gitFileState(file).tone}`">{{ gitFileState(file).label }}</span>
              <span class="git-path">{{ file.path }}</span>
            </button>
            <button class="git-row-action" :title="file.indexStatus === ' ' || file.indexStatus === '?' ? '暂存文件' : '取消暂存'" @click="file.indexStatus === ' ' || file.indexStatus === '?' ? stage(file.path) : unstage(file.path)">
              {{ file.indexStatus === ' ' || file.indexStatus === '?' ? '暂存' : '取消' }}
            </button>
          </div>
        </div>
      </section>

      <div class="project-commit-box">
        <div class="project-commit-heading"><div><span class="group-kicker">下一步</span><strong>创建提交</strong></div><span>{{ stagedFileCount }} 项已暂存</span></div>
        <textarea v-model="commitMessage" rows="3" placeholder="写下这次变更的说明…" aria-label="提交说明" />
        <button class="project-primary" :disabled="!commitMessage.trim()" @click="commit"><span>提交暂存内容</span><span aria-hidden="true">↗</span></button>
      </div>

      <details v-if="commits.length" class="project-tools-details">
        <summary><span>最近提交</span><span class="details-count">{{ commits.length }}</span></summary>
        <div v-for="item in commits" :key="item.hash" class="project-commit-row"><code>{{ item.shortHash }}</code><span>{{ item.subject }}</span></div>
      </details>
      <details v-if="remotes.length" class="project-tools-details">
        <summary><span>远程仓库</span><span class="details-count">{{ remotes.length }}</span></summary>
        <div v-for="remote in remotes" :key="remote.name" class="project-commit-row"><strong>{{ remote.name }}</strong><span>{{ remote.fetch || remote.push }}</span></div>
      </details>
    </template>

    <template v-else>
      <div v-if="selectedPath" class="project-selected-history">
        <span class="history-file-icon">⌁</span>
        <div><span>当前文件</span><code :title="selectedPath">{{ selectedPath }}</code></div>
        <strong>{{ revisionCount }} 次留痕</strong>
      </div>
      <div v-if="selectedPath && !revisions.length" class="project-tools-empty project-tools-empty-card">
        <span class="empty-state-icon">⌁</span>
        <strong>还没有文件历史</strong>
        <span>保存几次后，这里会出现可预览的版本。</span>
      </div>

      <section v-if="revisions.length" class="project-history-section">
        <div class="project-history-heading"><div><span class="group-kicker">当前文件</span><h2>版本留痕</h2></div><span class="group-count">{{ revisionCount }}</span></div>
        <div class="project-history-timeline">
          <article v-for="revision in revisions" :key="revision.id" class="project-history-row">
            <span class="history-marker" aria-hidden="true" />
            <div class="history-row-content">
              <div class="history-row-top"><strong>{{ revision.checkpoint?.label || revision.checkpoint?.kind || '自动留痕' }}</strong><span class="history-kind">{{ revision.deleted ? '已删除' : '自动保存' }}</span></div>
              <small>{{ new Date(revision.createdAt).toLocaleString() }} · {{ revision.deleted ? '文件已删除' : `${revision.size} B` }}</small>
              <div class="project-row-actions"><button @click="previewRevision(revision)">预览</button><button @click="emit('compare-history', { kind: 'revision', revision })">对比当前</button><button @click="restoreRevision(revision)">恢复</button></div>
            </div>
          </article>
        </div>
      </section>

      <section class="project-history-section">
        <div class="project-history-heading"><div><span class="group-kicker">项目时间线</span><h2>写作检查点</h2></div><span class="group-count">{{ checkpointCount }}</span></div>
        <div v-if="!checkpoints.length" class="project-tools-empty project-tools-empty-card compact"><span>暂时还没有写作检查点。</span></div>
        <div v-else class="project-history-timeline">
          <article v-for="checkpoint in checkpoints" :key="checkpoint.id" class="project-history-row" :class="{ pinned: checkpoint.pinned }">
            <span class="history-marker" :class="{ pinned: checkpoint.pinned }" aria-hidden="true">{{ checkpoint.pinned ? '★' : '' }}</span>
            <div class="history-row-content">
              <div class="history-row-top"><strong>{{ checkpoint.label || checkpoint.kind }}</strong><span v-if="checkpoint.pinned" class="history-kind pinned-label">已固定</span></div>
              <small>{{ new Date(checkpoint.createdAt).toLocaleString() }} · {{ checkpointFileCount(checkpoint) }} 个文件</small>
              <div class="project-row-actions"><button @click="pinCheckpoint(checkpoint)">{{ checkpoint.pinned ? '取消固定' : '固定' }}</button><button @click="emit('compare-history', { kind: 'checkpoint', checkpoint })">对比当前</button><button @click="restoreCheckpoint(checkpoint)">恢复写作状态</button></div>
            </div>
          </article>
        </div>
      </section>
    </template>

    <div v-if="preview" class="project-history-preview">
      <header><div><span class="group-kicker">版本预览</span><strong :title="preview.title">{{ preview.title }}</strong></div><button title="关闭预览" @click="preview = null">×</button></header>
      <pre>{{ preview.content ?? '[deleted]' }}</pre>
    </div>
  </section>
</template>

<style scoped>
.project-tools-panel {
  height: 100%;
  min-height: 0;
  overflow: auto;
  padding: 16px 12px 24px;
  background: transparent;
  color: var(--color-text);
}
.project-tools-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 16px;
}
.project-tools-heading { display: flex; align-items: flex-start; gap: 9px; min-width: 0; }
.project-tools-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  flex: 0 0 30px;
  border: 1px solid color-mix(in srgb, var(--color-primary) 28%, var(--color-border));
  border-radius: 9px;
  background: color-mix(in srgb, var(--color-primary) 10%, transparent);
  color: var(--color-primary);
}
.project-tools-icon svg { width: 17px; height: 17px; }
.project-tools-kicker,.group-kicker {
  margin: 0 0 4px;
  color: var(--color-text-muted);
  font-size: 9px;
  font-weight: 700;
  letter-spacing: .12em;
  text-transform: uppercase;
}
.project-tools-header h1 { margin: 0; font-size: 18px; font-weight: 700; letter-spacing: -.02em; }
.project-tools-subtitle { margin-top: 3px; color: var(--color-text-muted); font-size: 11px; line-height: 1.45; }
.project-tools-refresh {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: 0 0 auto;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  padding: 6px 8px;
  background: transparent;
  color: var(--color-text-secondary);
  font-size: 11px;
  cursor: pointer;
  transition: background var(--transition), border-color var(--transition), color var(--transition), transform var(--transition);
}
.project-tools-refresh svg { width: 13px; height: 13px; }
.project-tools-refresh:hover:not(:disabled) { border-color: var(--color-primary); background: var(--color-primary-soft); color: var(--color-primary); }
.project-tools-refresh:active:not(:disabled) { transform: scale(.96); }
.project-tools-refresh:disabled { cursor: wait; opacity: .5; }
.project-tools-error {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  margin: 0 0 12px;
  padding: 10px;
  border: 1px solid color-mix(in srgb, var(--color-error) 26%, var(--color-border));
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--color-error) 10%, transparent);
  color: var(--color-error);
  font-size: 11px;
  line-height: 1.45;
}
.project-tools-error span { display: inline-grid; place-items: center; width: 16px; height: 16px; flex: 0 0 16px; border-radius: 50%; background: color-mix(in srgb, var(--color-error) 18%, transparent); font-weight: 700; }
.project-tools-loading { display: grid; gap: 8px; padding: 6px 0; }
.loading-line,.loading-card { display: block; border-radius: 999px; background: color-mix(in srgb, var(--color-text-muted) 16%, transparent); animation: project-tools-pulse 1.1s ease-in-out infinite alternate; }
.loading-line { width: 70%; height: 9px; }.loading-line.wide { width: 92%; }.loading-line.short { width: 46%; }.loading-card { width: 100%; height: 54px; border-radius: 10px; }.loading-card + .loading-card { animation-delay: .12s; }
@keyframes project-tools-pulse { from { opacity: .45; } to { opacity: .9; } }
.project-tools-toolbar { display: grid; gap: 8px; margin-bottom: 12px; }
.project-branch-control { display: grid; gap: 5px; color: var(--color-text-muted); font-size: 11px; font-weight: 600; }
.project-branch-control select {
  width: 100%;
  min-width: 0;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  padding: 8px 9px;
  background: color-mix(in srgb, var(--color-bg-card) 48%, transparent);
  color: var(--color-text);
  font-size: 12px;
  cursor: pointer;
}
.project-branch-control select:focus { outline: none; border-color: var(--color-primary); }
.project-tools-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.project-tool-button,.git-row-action,.project-row-actions button {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  padding: 7px 8px;
  background: color-mix(in srgb, var(--color-bg-card) 40%, transparent);
  color: var(--color-text-secondary);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
  transition: background var(--transition), border-color var(--transition), color var(--transition), transform var(--transition);
}
.project-tool-button:hover:not(:disabled),.git-row-action:hover,.project-row-actions button:hover { border-color: var(--color-primary); background: var(--color-primary-soft); color: var(--color-primary); }
.project-tool-button:active:not(:disabled),.git-row-action:active,.project-row-actions button:active { transform: scale(.97); }
.project-tool-button:disabled { cursor: not-allowed; opacity: .45; }
.button-symbol { margin-right: 3px; color: var(--color-primary); }
.project-git-summary { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; margin-bottom: 12px; }
.project-stat-card {
  display: grid;
  gap: 4px;
  min-width: 0;
  padding: 9px;
  border: 1px solid color-mix(in srgb, var(--color-border) 80%, transparent);
  border-radius: 10px;
  background: color-mix(in srgb, var(--color-bg-card) 42%, transparent);
}
.project-stat-label { display: flex; align-items: center; gap: 5px; color: var(--color-text-muted); font-size: 11px; }
.stat-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--color-text-muted); }.stat-dot.changes { background: var(--color-warning); }.stat-dot.staged { background: var(--color-success); }
.project-stat-card strong { overflow: hidden; color: var(--color-text); font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
.project-stat-card small { overflow: hidden; color: var(--color-text-muted); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.project-tools-empty { color: var(--color-text-muted); font-size: 11px; line-height: 1.5; text-align: center; }
.project-tools-empty-card { display: grid; place-items: center; gap: 4px; padding: 24px 14px; border: 1px dashed color-mix(in srgb, var(--color-border) 90%, transparent); border-radius: 10px; background: color-mix(in srgb, var(--color-bg-card) 24%, transparent); }
.project-tools-empty-card strong { color: var(--color-text-secondary); font-size: 12px; }.project-tools-empty-card.compact { padding: 18px 12px; }.empty-state-icon { display: inline-grid; place-items: center; width: 26px; height: 26px; margin-bottom: 2px; border-radius: 50%; background: color-mix(in srgb, var(--color-success) 13%, transparent); color: var(--color-success); font-size: 15px; }
.project-tools-group,.project-history-section { margin: 0 0 12px; border: 1px solid color-mix(in srgb, var(--color-border) 82%, transparent); border-radius: 10px; background: color-mix(in srgb, var(--color-bg-card) 30%, transparent); overflow: hidden; }
.project-tools-group-heading,.project-history-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 10px 8px; }
.project-tools-group-heading h2,.project-history-heading h2 { margin: 0; color: var(--color-text); font-size: 13px; font-weight: 650; }
.group-kicker { margin-bottom: 2px; font-size: 9px; }.group-count,.details-count { display: inline-flex; align-items: center; justify-content: center; min-width: 20px; height: 20px; padding: 0 6px; border-radius: 999px; background: var(--color-bg-muted); color: var(--color-text-muted); font-size: 11px; }
.project-git-list { border-top: 1px solid color-mix(in srgb, var(--color-border) 64%, transparent); }
.project-git-row { display: flex; align-items: center; gap: 5px; min-width: 0; padding: 7px 8px; border-bottom: 1px solid color-mix(in srgb, var(--color-border) 54%, transparent); transition: background var(--transition); }
.project-git-row:last-child { border-bottom: 0; }.project-git-row:hover,.project-git-row.selected { background: color-mix(in srgb, var(--color-primary) 7%, transparent); }
.project-git-check { position: relative; display: inline-flex; align-items: center; justify-content: center; width: 17px; height: 17px; flex: 0 0 17px; cursor: pointer; }.project-git-check input { position: absolute; opacity: 0; width: 1px; height: 1px; }.project-git-check span { width: 14px; height: 14px; border: 1px solid var(--color-border-hover); border-radius: 4px; background: transparent; transition: background var(--transition), border-color var(--transition); }.project-git-check input:checked + span { border-color: var(--color-primary); background: var(--color-primary); box-shadow: inset 0 0 0 3px var(--color-bg-card); }.project-git-check input:disabled + span { opacity: .4; }.project-git-check input:focus-visible + span { outline: 2px solid var(--color-primary); outline-offset: 2px; }
.project-path-button { display: flex; align-items: center; gap: 6px; min-width: 0; flex: 1; border: 0; background: transparent; color: var(--color-text-secondary); text-align: left; font: inherit; cursor: pointer; }.project-path-button:hover { color: var(--color-primary); }.git-status-badge { flex: 0 0 auto; padding: 2px 5px; border-radius: 999px; font-size: 9px; font-weight: 650; white-space: nowrap; }.tone-modified { background: color-mix(in srgb, var(--color-warning) 15%, transparent); color: #b45309; }.tone-staged { background: color-mix(in srgb, var(--color-success) 14%, transparent); color: #15803d; }.tone-untracked { background: color-mix(in srgb, var(--color-primary) 13%, transparent); color: var(--color-primary); }.tone-conflict { background: color-mix(in srgb, var(--color-error) 13%, transparent); color: var(--color-error); }
[data-theme="dark"] .tone-modified { color: #fbbf24; }[data-theme="dark"] .tone-staged { color: #86efac; }
.git-path { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }.git-row-action { flex: 0 0 auto; padding: 5px 6px; font-size: 11px; }
.project-commit-box { display: grid; gap: 8px; margin: 14px 0 12px; padding: 11px; border: 1px solid color-mix(in srgb, var(--color-primary) 22%, var(--color-border)); border-radius: 10px; background: color-mix(in srgb, var(--color-primary) 5%, transparent); }.project-commit-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; }.project-commit-heading strong { display: block; font-size: 13px; }.project-commit-heading > span { color: var(--color-text-muted); font-size: 11px; }.project-commit-box textarea { width: 100%; min-height: 66px; box-sizing: border-box; resize: vertical; border: 1px solid var(--color-border); border-radius: var(--radius-sm); padding: 8px; background: color-mix(in srgb, var(--color-bg-card) 55%, transparent); color: inherit; font: inherit; font-size: 12px; }.project-commit-box textarea:focus { outline: none; border-color: var(--color-primary); }.project-primary { display: flex; align-items: center; justify-content: space-between; gap: 8px; width: 100%; border: 0; border-radius: var(--radius-sm); padding: 8px 10px; background: var(--color-primary); color: #fff; font: inherit; font-size: 12px; cursor: pointer; transition: background var(--transition), transform var(--transition); }.project-primary:hover:not(:disabled) { background: var(--color-primary-hover); }.project-primary:active:not(:disabled) { transform: scale(.98); }.project-primary:disabled { cursor: not-allowed; opacity: .45; }
.project-tools-details { margin: 10px 0; border-top: 1px solid color-mix(in srgb, var(--color-border) 70%, transparent); padding-top: 9px; }.project-tools-details summary { display: flex; align-items: center; justify-content: space-between; gap: 8px; cursor: pointer; color: var(--color-text-secondary); font-size: 12px; }.project-tools-details summary::marker { color: var(--color-primary); }.project-commit-row { display: flex; align-items: baseline; gap: 8px; min-width: 0; padding: 7px 2px; color: var(--color-text-secondary); font-size: 11px; }.project-commit-row code { flex: 0 0 auto; color: var(--color-primary); font-size: 11px; }.project-commit-row span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.project-commit-row strong { flex: 0 0 auto; }.project-commit-row strong + span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.project-selected-history { display: flex; align-items: center; gap: 8px; min-width: 0; margin-bottom: 12px; padding: 9px; border: 1px solid color-mix(in srgb, var(--color-primary) 22%, var(--color-border)); border-radius: 10px; background: color-mix(in srgb, var(--color-primary) 6%, transparent); }.history-file-icon { display: inline-grid; place-items: center; width: 24px; height: 24px; flex: 0 0 24px; border-radius: 7px; background: var(--color-primary-soft); color: var(--color-primary); font-size: 14px; }.project-selected-history > div { display: grid; gap: 2px; min-width: 0; flex: 1; }.project-selected-history > div > span { color: var(--color-text-muted); font-size: 10px; }.project-selected-history code { overflow: hidden; color: var(--color-text); font: 11px var(--font-mono, ui-monospace, monospace); text-overflow: ellipsis; white-space: nowrap; }.project-selected-history strong { flex: 0 0 auto; color: var(--color-primary); font-size: 11px; }
.project-history-section { padding-bottom: 3px; }.project-history-timeline { position: relative; display: grid; gap: 2px; padding: 0 8px 6px 10px; }.project-history-timeline::before { content: ''; position: absolute; top: 6px; bottom: 12px; left: 17px; width: 1px; background: color-mix(in srgb, var(--color-primary) 20%, var(--color-border)); }.project-history-row { position: relative; display: flex; align-items: flex-start; gap: 8px; min-width: 0; padding: 8px 2px; border-radius: 7px; transition: background var(--transition); }.project-history-row:hover { background: color-mix(in srgb, var(--color-primary) 6%, transparent); }.history-marker { z-index: 1; display: inline-grid; place-items: center; width: 15px; height: 15px; flex: 0 0 15px; margin-top: 2px; border: 3px solid var(--color-bg-card); border-radius: 50%; background: var(--color-primary); color: #fff; font-size: 7px; }.history-marker.pinned { border: 0; border-radius: 5px; background: color-mix(in srgb, var(--color-warning) 16%, transparent); color: var(--color-warning); font-size: 11px; }.history-row-content { min-width: 0; flex: 1; }.history-row-top { display: flex; align-items: center; gap: 6px; min-width: 0; }.history-row-top strong { min-width: 0; overflow: hidden; color: var(--color-text); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }.history-kind { flex: 0 0 auto; padding: 2px 5px; border-radius: 999px; background: var(--color-bg-muted); color: var(--color-text-muted); font-size: 9px; }.history-kind.pinned-label { background: color-mix(in srgb, var(--color-warning) 15%, transparent); color: #b45309; }.project-history-row small { display: block; margin-top: 3px; color: var(--color-text-muted); font-size: 10px; line-height: 1.45; }.project-row-actions { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 7px; }.project-row-actions button { padding: 5px 7px; font-size: 11px; }
.project-history-preview { position: sticky; bottom: 0; z-index: 2; margin-top: 12px; border: 1px solid var(--color-border); border-radius: 10px; background: color-mix(in srgb, var(--color-bg-card) 88%, transparent); box-shadow: var(--shadow-lg); overflow: hidden; backdrop-filter: blur(12px); }.project-history-preview header { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 10px; border-bottom: 1px solid var(--color-border); }.project-history-preview header > div { display: grid; min-width: 0; }.project-history-preview header strong { overflow: hidden; color: var(--color-text); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }.project-history-preview header button { border: 0; background: transparent; color: var(--color-text-muted); font-size: 18px; line-height: 1; cursor: pointer; }.project-history-preview header button:hover { color: var(--color-text); }.project-history-preview pre { max-height: 260px; overflow: auto; margin: 0; padding: 10px; color: var(--color-text-secondary); white-space: pre-wrap; font: 11px/1.55 var(--font-mono, ui-monospace, monospace); }
@media (prefers-reduced-motion: reduce) { .project-tools-panel *, .project-tools-panel *::before, .project-tools-panel *::after { animation-duration: .01ms !important; transition-duration: .01ms !important; } }
</style>
