<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useProjectsStore } from '@/stores/projects'

const router = useRouter()
const store = useProjectsStore()
const creating = ref(false)
const showingArchived = ref(false)
const name = ref('')
const directoryName = ref('')
const description = ref('')
const formError = ref('')
const visibleProjects = computed(() => showingArchived.value ? store.projects : store.activeProjects)

const load = async () => { await store.fetchProjects(showingArchived.value) }
onMounted(() => { void load() })

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

const archive = async (id: string) => {
  if (!window.confirm('归档这个项目？工作区文件、Git 历史和 Writing History 都会保留。')) return
  await store.archiveProject(id)
}

const unarchive = async (id: string) => {
  await store.unarchiveProject(id)
  await load()
}

const renameProject = async (id: string, currentName: string) => {
  const next = window.prompt('新的项目显示名称（目录名不会改变）', currentName)?.trim()
  if (!next || next === currentName) return
  await store.updateProject(id, { name: next })
}

const permanentlyDelete = async (id: string, projectName: string) => {
  const confirmation = window.prompt(`永久删除项目“${projectName}”及其整个工作目录、独立 Git 仓库？\n请输入项目名称确认。`)
  if (confirmation !== projectName) return
  await store.deleteProject(id)
  await load()
}

const toggleArchived = async () => {
  showingArchived.value = !showingArchived.value
  await load()
}
</script>

<template>
  <main class="projects-page">
    <header class="page-header">
      <div>
        <p class="eyebrow">科研工作区</p>
        <h1>项目</h1>
        <p class="muted">每个项目拥有独立 Git repository、Writing History 和 Agent 工作目录。</p>
      </div>
      <div class="header-actions">
        <button class="ghost" @click="toggleArchived">{{ showingArchived ? '活动项目' : '已归档' }}</button>
        <button v-if="!showingArchived" class="primary" @click="creating = !creating">{{ creating ? '取消' : '新建项目' }}</button>
      </div>
    </header>

    <form v-if="creating && !showingArchived" class="create-card" @submit.prevent="create">
      <label>名称<input v-model="name" required placeholder="MIMO Channel Estimation" /></label>
      <label>目录名<input v-model="directoryName" placeholder="mimo-channel-estimation（留空自动生成）" /></label>
      <small>目录名是 Project 的不可变文件系统身份；创建后只允许修改显示名称。</small>
      <label>说明<textarea v-model="description" rows="2" /></label>
      <p v-if="formError" class="error">{{ formError }}</p>
      <button class="primary" type="submit">创建并初始化 Git</button>
    </form>

    <p v-if="store.error" class="error">{{ store.error }}</p>
    <div v-if="store.loading" class="empty">加载中…</div>
    <div v-else-if="!visibleProjects.length" class="empty">{{ showingArchived ? '没有已归档项目。' : '还没有项目。' }}</div>
    <section v-else class="grid">
      <article v-for="project in visibleProjects" :key="project.id" class="card" @click="!showingArchived && router.push(`/projects/${project.id}`)">
        <div class="card-main">
          <h2>{{ project.name }}</h2>
          <code>{{ project.directoryName }}</code>
          <p>{{ project.description || '暂无说明' }}</p>
        </div>
        <div class="card-actions" @click.stop>
          <template v-if="showingArchived">
            <button class="ghost" @click="unarchive(project.id)">Restore</button>
            <button class="danger" @click="permanentlyDelete(project.id, project.name)">Delete permanently</button>
          </template>
          <template v-else>
            <button class="ghost" @click="router.push(`/projects/${project.id}/settings`)">Settings</button>
            <button class="ghost" @click="renameProject(project.id, project.name)">Rename</button>
            <button class="ghost" @click="archive(project.id)">Archive</button>
          </template>
        </div>
      </article>
    </section>
  </main>
</template>

<style scoped>
.projects-page{min-height:100vh;padding:36px;max-width:1180px;margin:0 auto;color:var(--text-primary,#e8e8e8)}
.page-header{display:flex;justify-content:space-between;gap:24px;align-items:flex-start;margin-bottom:28px}.header-actions{display:flex;gap:8px}.eyebrow{font-size:12px;text-transform:uppercase;letter-spacing:.12em;opacity:.55;margin:0 0 8px}h1{font-size:32px;margin:0 0 8px}.muted{opacity:.62;margin:0}.primary,.ghost,.danger{border-radius:8px;padding:9px 14px;cursor:pointer}.primary{border:0;background:var(--accent-color,#6d7cff);color:white}.ghost,.danger{background:transparent;color:inherit;border:1px solid rgba(127,127,127,.25)}.danger{color:#ef7777;border-color:rgba(239,119,119,.35)}
.create-card,.card{border:1px solid rgba(127,127,127,.22);background:rgba(127,127,127,.06);border-radius:12px}.create-card{display:grid;gap:14px;padding:20px;margin-bottom:24px}.create-card label{display:grid;gap:6px;font-size:13px}.create-card small{opacity:.55}.create-card input,.create-card textarea{background:transparent;color:inherit;border:1px solid rgba(127,127,127,.3);border-radius:7px;padding:9px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:14px}.card{padding:18px;cursor:pointer;display:flex;justify-content:space-between;gap:12px;min-height:130px}.card-main{min-width:0}.card h2{margin:0 0 6px;font-size:18px}.card code{font-size:12px;opacity:.6}.card p{opacity:.65;font-size:13px}.card-actions{display:flex;flex-direction:column;gap:7px;align-items:stretch}.empty{text-align:center;padding:60px;opacity:.5}.error{color:#d85b5b}
@media(max-width:680px){.projects-page{padding:20px}.page-header,.card{flex-direction:column}.card-actions{flex-direction:row}.header-actions{flex-wrap:wrap}}
</style>
