<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useRouter } from 'vue-router'
import { useProjectsStore } from '@/stores/projects'

const props = withDefaults(defineProps<{ embedded?: boolean }>(), { embedded: false })
const route = useRoute()
const router = useRouter()
const store = useProjectsStore()
const creating = ref(false)
const name = ref('')
const directoryName = ref('')
const description = ref('')
const formError = ref('')

const load = async () => { await store.fetchProjects(false) }
onMounted(() => { void load(); if (route.query.create === '1') creating.value = true })
watch(() => route.query.create, value => { if (value === '1') creating.value = true })

const renameProject = async (id: string, currentName: string) => {
  const next = window.prompt('新的项目名称', currentName)?.trim()
  if (!next || next === currentName) return
  await store.updateProject(id, { name: next })
}

const archiveProject = async (id: string, name: string) => {
  if (!window.confirm(`归档项目“${name}”？项目文件和历史会保留。`)) return
  await store.archiveProject(id)
}

const deleteProject = async (id: string, name: string) => {
  const confirmation = window.prompt(`永久删除项目“${name}”？请输入项目名称确认。`)
  if (confirmation !== name) return
  await store.deleteProject(id)
}

const create = async () => {
  formError.value = ''
  try {
    const project = await store.createProject({
      name: name.value,
      directoryName: directoryName.value.trim() || undefined,
      description: description.value.trim() || undefined,
    })
    creating.value = false
    name.value = ''
    directoryName.value = ''
    description.value = ''
    await router.push(`/projects/${project.id}`)
  } catch (error) {
    formError.value = (error as Error).message
  }
}

</script>

<template>
  <main class="projects-page" :class="{ embedded: props.embedded }">
    <header class="page-header">
      <div>
        <p class="eyebrow">科研工作区</p>
        <h1>项目</h1>
        <p class="muted">从左侧选择项目。项目文件、编辑器和 Agent 会在同一个工作区中打开。</p>
      </div>
      <button class="primary" @click="creating = !creating">{{ creating ? '取消' : '新建项目' }}</button>
    </header>

    <form v-if="creating" class="create-card" @submit.prevent="create">
      <label>名称<input v-model="name" required placeholder="MIMO Channel Estimation" /></label>
      <label>目录名<input v-model="directoryName" placeholder="留空自动生成" /></label>
      <small>目录名是项目的文件系统身份，创建后不会改变。</small>
      <label>说明<textarea v-model="description" rows="2" /></label>
      <p v-if="formError" class="error">{{ formError }}</p>
      <button class="primary" type="submit">创建并打开项目</button>
    </form>

    <p v-if="store.error" class="error">{{ store.error }}</p>
    <section v-else-if="store.loading" class="project-empty-state"><p>正在加载项目…</p></section>
    <section v-else-if="store.activeProjects.length" class="project-list" aria-label="项目列表">
      <article v-for="project in store.activeProjects" :key="project.id" class="project-list-row" role="button" tabindex="0" @click="router.push(`/projects/${project.id}`)" @keydown.enter="router.push(`/projects/${project.id}`)">
        <span class="project-list-icon">▰</span>
        <span class="project-list-main"><strong>{{ project.name }}</strong><small>{{ project.directoryName }}{{ project.description ? ` · ${project.description}` : '' }}</small></span>
        <span class="project-list-actions" @click.stop>
          <button type="button" @click="renameProject(project.id, project.name)">重命名</button>
          <button type="button" @click="archiveProject(project.id, project.name)">归档</button>
          <button type="button" class="danger" @click="deleteProject(project.id, project.name)">删除</button>
        </span>
      </article>
    </section>
    <div v-else class="project-empty-state">
      <div class="project-empty-icon">▰</div>
      <h2>还没有项目</h2>
      <p>点击右上角“新建项目”，创建后即可从左侧或这里进入项目文件工作区。</p>
    </div>
  </main>
</template>

<style scoped>
.projects-page{height:100%;min-height:0;overflow:auto;padding:32px;color:var(--color-text)}.page-header{display:flex;align-items:flex-start;justify-content:space-between;gap:24px;margin-bottom:28px}.eyebrow{margin:0 0 8px;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--color-text-muted)}h1{margin:0 0 8px;font-size:28px}.muted{margin:0;color:var(--color-text-secondary)}.primary{border:0;border-radius:var(--radius-sm,6px);padding:8px 12px;background:var(--color-primary,#6366f1);color:white;cursor:pointer}.create-card{display:grid;gap:14px;max-width:620px;margin-bottom:24px;padding:20px;border:1px solid var(--color-border);border-radius:var(--radius,10px);background:var(--color-bg-card)}.project-list{display:grid;gap:8px;max-width:920px}.project-list-row{display:flex;align-items:center;gap:12px;width:100%;padding:13px 14px;border:1px solid var(--color-border);border-radius:var(--radius-sm,8px);background:var(--color-bg-card);color:var(--color-text);text-align:left;cursor:pointer;transition:border-color var(--transition),background var(--transition),transform var(--transition)}.project-list-row:hover,.project-list-row:focus-visible{border-color:color-mix(in srgb,var(--color-primary) 45%,var(--color-border));background:var(--color-bg-hover);transform:translateY(-1px);outline:none}.project-list-icon{color:var(--color-primary);font-size:17px}.project-list-main{display:grid;gap:3px;min-width:0;flex:1}.project-list-main strong{font-size:14px;font-weight:600}.project-list-main small{overflow:hidden;color:var(--color-text-muted);font-size:11px;text-overflow:ellipsis;white-space:nowrap}.project-list-actions{display:flex;gap:5px;flex-shrink:0}.project-list-actions button{border:1px solid var(--color-border);border-radius:var(--radius-sm);padding:5px 7px;background:transparent;color:var(--color-text-secondary);font-size:11px;cursor:pointer}.project-list-actions button:hover{background:var(--color-bg-muted);color:var(--color-text)}.project-list-actions button.danger:hover{color:var(--color-error);border-color:var(--color-error)}.create-card label{display:grid;gap:6px;font-size:13px}.create-card small{color:var(--color-text-muted)}.create-card input,.create-card textarea{box-sizing:border-box;border:1px solid var(--color-border);border-radius:var(--radius-sm,6px);padding:9px;background:var(--color-bg-muted);color:inherit}.project-empty-state{display:grid;place-items:center;align-content:center;min-height:320px;text-align:center;color:var(--color-text-secondary)}.project-empty-state h2{margin:12px 0 6px;color:var(--color-text);font-size:18px}.project-empty-state p{max-width:420px;margin:0;line-height:1.6}.project-empty-icon{font-size:34px;color:var(--color-primary);opacity:.7}.error{color:var(--color-error)}
@media(max-width:680px){.projects-page{padding:20px}.page-header{flex-direction:column;gap:16px}}
</style>
