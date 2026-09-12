<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useProjectsStore } from '@/stores/projects'

const props = withDefaults(defineProps<{ workspace?: boolean; embedded?: boolean }>(), { workspace: false, embedded: false })
const route = useRoute()
const router = useRouter()
const projects = useProjectsStore()
const activeId = computed(() => typeof route.params.id === 'string' ? route.params.id : '')
const contextMenu = ref<{ visible: boolean; x: number; y: number; id: string; name: string }>({ visible: false, x: 0, y: 0, id: '', name: '' })

onMounted(() => { if (!projects.projects.length) void projects.fetchProjects() })

const openProject = (id: string) => router.push(`/projects/${id}`)
const openProjectList = () => router.push('/projects')
const openArea = (path: string) => router.push(path)
const openCreate = () => router.push({ path: '/projects', query: { create: '1' } })
const showContextMenu = (event: MouseEvent, project: { id: string; name: string }) => {
  event.preventDefault()
  contextMenu.value = { visible: true, x: Math.min(event.clientX, window.innerWidth - 190), y: Math.min(event.clientY, window.innerHeight - 130), id: project.id, name: project.name }
}
const closeContextMenu = () => { contextMenu.value.visible = false }
const renameProject = async () => {
  const item = contextMenu.value
  closeContextMenu()
  const name = window.prompt('新的项目名称', item.name)?.trim()
  if (!name || name === item.name) return
  try { await projects.updateProject(item.id, { name }) } catch (error) { projects.error = (error as Error).message }
}
const archiveProject = async () => {
  const item = contextMenu.value
  closeContextMenu()
  if (!window.confirm(`归档项目“${item.name}”？项目文件和历史都会保留。`)) return
  try { await projects.archiveProject(item.id) } catch (error) { projects.error = (error as Error).message }
}
const deleteProject = async () => {
  const item = contextMenu.value
  closeContextMenu()
  const confirmation = window.prompt(`永久删除项目“${item.name}”及其文件？请输入项目名称确认。`)
  if (confirmation !== item.name) return
  try {
    await projects.deleteProject(item.id)
    if (activeId.value === item.id) await openProjectList()
  } catch (error) { projects.error = (error as Error).message }
}
</script>

<template>
  <div class="project-navigation" :class="{ embedded: props.embedded }" @click="closeContextMenu">
    <div v-if="!props.embedded" class="side-header project-nav-header">
      <h2>项目</h2>
      <button class="side-mini-btn" title="新建项目" @click.stop="openCreate">＋ 新建</button>
    </div>
    <TransitionGroup tag="div" name="project-list" class="category-list project-navigation-list">
      <div key="project-section" class="section-divider"><span class="divider-text">项目</span></div>
      <button key="all-projects" class="category-item" :class="{ active: !activeId }" @click="openProjectList">
        <span class="cat-icon">⌂</span><span class="cat-name">所有项目</span><span class="cat-count">{{ projects.activeProjects.length }}</span>
      </button>
      <div v-if="projects.loading" key="project-loading" class="side-empty">正在加载项目…</div>
      <div v-else-if="projects.error" key="project-error" class="side-empty error-text">{{ projects.error }}</div>
      <div v-else-if="!projects.activeProjects.length" key="project-empty" class="side-empty">还没有项目</div>
      <template v-else>
        <button v-for="project in projects.activeProjects" :key="project.id" class="category-item" :class="{ active: activeId === project.id }" @click="openProject(project.id)" @contextmenu="showContextMenu($event, project)">
          <span class="cat-icon">▰</span><span class="cat-name"><strong>{{ project.name }}</strong><small>{{ project.directoryName }}</small></span>
        </button>
      </template>
    </TransitionGroup>
    <div v-if="!props.embedded" class="side-bottom project-nav-bottom">
      <button class="settings-link" @click="openArea('/')">文献库</button>
      <button class="settings-link" @click="openArea('/files')">文件</button>
      <button v-if="!props.embedded" class="settings-link active" @click="openProjectList">项目</button>
      <button class="settings-link" @click="openArea('/settings')">设置</button>
    </div>

    <Teleport to="body">
      <div v-if="contextMenu.visible" class="project-context-menu" :style="{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }" @click.stop>
        <button @click="renameProject">✏️ 重命名</button>
        <button @click="archiveProject">📦 归档</button>
        <div class="project-context-sep" />
        <button class="danger" @click="deleteProject">🗑️ 删除项目</button>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.project-navigation{height:100%;display:flex;flex-direction:column;min-height:0;color:var(--color-text)}.project-navigation.embedded{background:transparent}.project-navigation.embedded .project-navigation-list{padding-top:8px;position:relative}.project-navigation.embedded .project-nav-bottom{display:none}.project-list-enter-active,.project-list-leave-active,.project-list-move{transition:opacity 180ms ease,transform 180ms cubic-bezier(.4,0,.2,1)}.project-list-enter-from{opacity:0;transform:translateY(-6px)}.project-list-leave-to{opacity:0;transform:translateX(-10px)}.project-list-leave-active{position:absolute;left:8px;right:8px;z-index:0}.project-nav-workspace-head{display:grid;gap:12px;padding:16px 14px 14px;border-bottom:1px solid var(--color-border)}.project-nav-back{justify-self:start;padding:6px 8px;border:0;border-radius:var(--radius-sm);background:transparent;color:var(--color-text-secondary);cursor:pointer;font:inherit}.project-nav-back:hover{background:var(--color-bg-hover);color:var(--color-primary)}.project-nav-current{display:flex;align-items:center;gap:8px;min-width:0}.project-nav-current strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px}.project-nav-workspace-note{padding:12px 16px 0;font-size:11px;color:var(--color-text-muted)}.project-nav-workspace-spacer{flex:1}.project-nav-workspace-foot{padding:12px}.project-nav-workspace-foot .project-nav-switcher{grid-template-columns:repeat(2,1fr);margin-top:0}
.project-nav-head{display:flex;align-items:flex-start;justify-content:space-between;padding:18px 16px 12px;border-bottom:1px solid var(--color-border)}
.project-nav-kicker{margin:0 0 4px;font-size:10px;letter-spacing:.14em;color:var(--color-text-muted)}.project-nav-head h2{margin:0;font-size:18px;font-weight:600}
.project-nav-add{width:28px;height:28px;border:1px solid var(--color-border);border-radius:var(--radius-sm);background:transparent;color:var(--color-text-secondary);font-size:19px;line-height:1;cursor:pointer}.project-nav-add:hover{background:var(--color-bg-hover);color:var(--color-primary)}
.project-nav-all,.project-nav-item{display:flex;align-items:center;gap:9px;width:calc(100% - 16px);margin:8px 8px 0;padding:8px 9px;border:0;border-radius:var(--radius-sm);background:transparent;color:var(--color-text-secondary);text-align:left;cursor:pointer;font:inherit}.project-nav-all:hover,.project-nav-item:hover{background:var(--color-bg-muted);color:var(--color-text)}.project-nav-all.active,.project-nav-item.active{background:var(--color-primary-soft);color:var(--color-primary)}
.project-nav-icon,.project-nav-folder{width:18px;text-align:center;color:var(--color-text-muted);font-size:13px}.project-nav-count{margin-left:auto;font-size:11px;color:var(--color-text-muted)}
.project-nav-list{overflow:auto;padding:4px 0 10px}.project-nav-item{margin-top:2px}.project-nav-item.active .project-nav-folder{color:var(--color-primary)}.project-nav-label{min-width:0;display:grid;gap:2px}.project-nav-label strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:500}.project-nav-label small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--color-text-muted)}
.project-nav-empty{padding:26px 18px;color:var(--color-text-muted);font-size:12px;text-align:center}.project-nav-empty.error{color:var(--color-error)}.project-nav-foot{margin-top:auto;padding:10px 12px;border-top:1px solid var(--color-border)}.project-nav-new{display:flex!important;justify-content:center!important;background:var(--color-primary-soft)!important;color:var(--color-primary)!important;margin-bottom:8px}.project-context-menu{position:fixed;z-index:1000;min-width:170px;padding:5px;background:var(--color-bg-card);border:1px solid var(--color-border);border-radius:var(--radius-sm);box-shadow:var(--shadow-lg,0 12px 30px rgba(0,0,0,.2))}.project-context-menu button{display:block;width:100%;padding:8px 10px;border:0;border-radius:4px;background:transparent;color:var(--color-text);text-align:left;cursor:pointer;font:inherit;font-size:12px}.project-context-menu button:hover{background:var(--color-bg-hover)}.project-context-menu .danger{color:var(--color-error)}.project-context-sep{height:1px;margin:4px 0;background:var(--color-border)}.project-nav-foot>button{display:flex;justify-content:space-between;width:100%;padding:7px 8px;border:0;border-radius:var(--radius-sm);background:transparent;color:var(--color-text-secondary);cursor:pointer;text-align:left}.project-nav-foot>button:hover{background:var(--color-bg-muted);color:var(--color-text)}.project-nav-switcher{display:grid;grid-template-columns:repeat(3,1fr);gap:4px;margin-top:8px}.project-nav-switcher button{justify-content:center;padding:6px 3px;border:1px solid transparent;border-radius:var(--radius-sm);background:transparent;color:var(--color-text-muted);font-size:11px;cursor:pointer}.project-nav-switcher button:hover{background:var(--color-bg-muted);color:var(--color-text)}.project-nav-switcher button.active{background:var(--color-primary-soft);color:var(--color-primary)}
.project-nav-header{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 16px;border-bottom:1px solid var(--color-border)}.project-nav-header h2{margin:0;font-size:16px;font-weight:600;color:var(--color-text)}.project-nav-header .side-mini-btn{border:0;border-radius:var(--radius-sm);padding:5px 9px;background:var(--color-bg-muted);color:var(--color-text-secondary);font-size:12px;cursor:pointer}.project-nav-header .side-mini-btn:hover{background:var(--color-primary-soft);color:var(--color-primary)}
.project-navigation-list{flex:1;min-height:0;overflow-y:auto;padding:10px 8px calc(10px + var(--list-scroll-bottom-gap,84px));scroll-padding-bottom:var(--list-scroll-bottom-gap,84px)}.project-navigation-list .section-divider{display:flex;align-items:center;justify-content:space-between;padding:0 8px 7px}.project-navigation-list .divider-text{font-size:11px;font-weight:600;color:var(--color-text-muted);text-transform:uppercase;letter-spacing:.06em}.project-navigation-list .category-item{width:100%;display:flex;align-items:center;gap:9px;padding:9px 10px;border:0;background:transparent;color:var(--color-text-secondary);border-radius:var(--radius-sm);cursor:pointer;text-align:left;font-size:13.5px;transition:background var(--transition),color var(--transition)}.project-navigation-list .category-item:hover{background:var(--color-bg-muted);color:var(--color-text)}.project-navigation-list .category-item.active{background:var(--color-primary-soft);color:var(--color-primary);font-weight:600}.project-navigation-list .cat-icon{width:20px;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:15px;line-height:1;color:var(--color-text-muted)}.project-navigation-list .cat-count{font-size:11px;color:var(--color-text-muted)}.project-navigation-list .cat-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:flex;flex-direction:column;gap:2px}.project-navigation-list .cat-name strong{font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.project-navigation-list .cat-name small{font-size:11px;font-weight:400;color:var(--color-text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.project-navigation-list .side-empty{padding:26px 18px;color:var(--color-text-muted);font-size:12px;text-align:center}.project-navigation-list .error-text{color:var(--color-error)}.project-nav-bottom{margin-top:auto;padding:12px;border-top:1px solid var(--color-border);display:flex;flex-direction:column;gap:8px}.project-nav-bottom .settings-link{display:flex;align-items:center;gap:10px;width:100%;padding:10px 14px;border:0;background:var(--color-bg-muted);color:var(--color-text-secondary);border-radius:8px;font-size:13px;font-weight:500;cursor:pointer;text-align:left}.project-nav-bottom .settings-link:hover,.project-nav-bottom .settings-link.active{background:var(--color-primary-soft);color:var(--color-primary)}
</style>
