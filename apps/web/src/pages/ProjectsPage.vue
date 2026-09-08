<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useProjectsStore } from '@/stores/projects'

const router = useRouter()
const store = useProjectsStore()
const creating = ref(false)
const name = ref('')
const directoryName = ref('')
const description = ref('')
const formError = ref('')

onMounted(() => { void store.fetchProjects() })

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
  if (!window.confirm('Archive this project? Files and Git history will be kept.')) return
  await store.archiveProject(id)
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
      <button class="primary" @click="creating = !creating">{{ creating ? '取消' : '新建项目' }}</button>
    </header>

    <form v-if="creating" class="create-card" @submit.prevent="create">
      <label>名称<input v-model="name" required placeholder="MIMO Channel Estimation" /></label>
      <label>目录名<input v-model="directoryName" placeholder="mimo-channel-estimation（留空自动生成）" /></label>
      <label>说明<textarea v-model="description" rows="2" /></label>
      <p v-if="formError" class="error">{{ formError }}</p>
      <button class="primary" type="submit">创建并初始化 Git</button>
    </form>

    <p v-if="store.error" class="error">{{ store.error }}</p>
    <div v-if="store.loading" class="empty">加载中…</div>
    <div v-else-if="!store.activeProjects.length" class="empty">还没有项目。</div>
    <section v-else class="grid">
      <article v-for="project in store.activeProjects" :key="project.id" class="card" @click="router.push(`/projects/${project.id}`)">
        <div>
          <h2>{{ project.name }}</h2>
          <code>{{ project.directoryName }}</code>
          <p>{{ project.description || '暂无说明' }}</p>
        </div>
        <button class="ghost" @click.stop="archive(project.id)">Archive</button>
      </article>
    </section>
  </main>
</template>

<style scoped>
.projects-page{min-height:100vh;padding:36px;max-width:1180px;margin:0 auto;color:var(--text-primary,#e8e8e8)}
.page-header{display:flex;justify-content:space-between;gap:24px;align-items:flex-start;margin-bottom:28px}.eyebrow{font-size:12px;text-transform:uppercase;letter-spacing:.12em;opacity:.55;margin:0 0 8px}h1{font-size:32px;margin:0 0 8px}.muted{opacity:.62;margin:0}.primary,.ghost{border:0;border-radius:8px;padding:9px 14px;cursor:pointer}.primary{background:var(--accent-color,#6d7cff);color:white}.ghost{background:transparent;color:inherit;border:1px solid rgba(127,127,127,.25)}
.create-card,.card{border:1px solid rgba(127,127,127,.22);background:rgba(127,127,127,.06);border-radius:12px}.create-card{display:grid;gap:14px;padding:20px;margin-bottom:24px}.create-card label{display:grid;gap:6px;font-size:13px}.create-card input,.create-card textarea{background:transparent;color:inherit;border:1px solid rgba(127,127,127,.3);border-radius:7px;padding:9px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px}.card{padding:18px;cursor:pointer;display:flex;justify-content:space-between;gap:12px;min-height:130px}.card h2{margin:0 0 6px;font-size:18px}.card code{font-size:12px;opacity:.6}.card p{opacity:.65;font-size:13px}.empty{text-align:center;padding:60px;opacity:.5}.error{color:#d85b5b}
</style>
