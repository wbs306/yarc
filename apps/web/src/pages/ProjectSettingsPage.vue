<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  DEFAULT_PROJECT_HISTORY_SETTINGS,
  type LatexEngine,
  type ProjectHistorySettings,
  type ProjectLatexTarget,
} from '@yarc/shared'
import { requestJson } from '@/lib/api-request'

const props = withDefaults(defineProps<{ embedded?: boolean }>(), { embedded: false })
const route = useRoute()
const router = useRouter()
const projectId = String(route.params.id || '')
const projectName = ref('Project')
const loading = ref(true)
const saving = ref(false)
const error = ref('')
const saved = ref(false)
const includeText = ref('')
const excludeText = ref('')
const settings = ref<ProjectHistorySettings>({
  ...DEFAULT_PROJECT_HISTORY_SETTINGS,
  include: [...DEFAULT_PROJECT_HISTORY_SETTINGS.include],
  exclude: [...DEFAULT_PROJECT_HISTORY_SETTINGS.exclude],
})
const latexTargets = ref<ProjectLatexTarget[]>([])
const defaultLatexTarget = ref('')
const latexSaving = ref(false)
const latexSaved = ref(false)
const latexError = ref('')
const latexEngines: { value: LatexEngine; label: string }[] = [
  { value: 'xelatex', label: 'XeLaTeX' },
  { value: 'pdflatex', label: 'pdfLaTeX' },
  { value: 'lualatex', label: 'LuaLaTeX' },
]

const syncPatternText = () => {
  includeText.value = settings.value.include.join('\n')
  excludeText.value = settings.value.exclude.join('\n')
}

const parsePatterns = (value: string) => value
  .split(/\r?\n/)
  .map(item => item.trim())
  .filter(Boolean)

const load = async () => {
  loading.value = true
  error.value = ''
  try {
    const [projectData, historyData, latexData] = await Promise.all([
      requestJson<{ project: { name: string } }>(`/api/projects/${projectId}`),
      requestJson<{ settings: ProjectHistorySettings }>(`/api/projects/${projectId}/history/settings`),
      requestJson<{ defaultTarget: string | null; targets: ProjectLatexTarget[] }>(`/api/projects/${projectId}/latex/targets`),
    ])
    projectName.value = projectData.project.name
    settings.value = { ...historyData.settings }
    latexTargets.value = latexData.targets.map(target => ({ ...target }))
    defaultLatexTarget.value = latexData.defaultTarget || ''
    syncPatternText()
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    loading.value = false
  }
}

const createLatexTarget = (): ProjectLatexTarget => {
  const usedIds = new Set(latexTargets.value.map(target => target.id))
  let id = 'paper-main'
  let suffix = 2
  while (usedIds.has(id)) id = `paper-main-${suffix++}`
  return {
    id,
    name: 'Paper',
    entry: 'paper/main.tex',
    sourceRoot: 'paper',
    engine: 'xelatex',
  }
}

const addLatexTarget = () => {
  const target = createLatexTarget()
  latexTargets.value.push(target)
  if (!defaultLatexTarget.value) defaultLatexTarget.value = target.id
}

const removeLatexTarget = (index: number) => {
  const [removed] = latexTargets.value.splice(index, 1)
  if (removed?.id === defaultLatexTarget.value) defaultLatexTarget.value = latexTargets.value[0]?.id || ''
}

const save = async () => {
  saving.value = true
  saved.value = false
  error.value = ''
  try {
    const payload: ProjectHistorySettings = {
      ...settings.value,
      include: parsePatterns(includeText.value),
      exclude: parsePatterns(excludeText.value),
    }
    const data = await requestJson<{ settings: ProjectHistorySettings }>(`/api/projects/${projectId}/history/settings`, {
      method: 'PUT',
      body: JSON.stringify({ settings: payload }),
    })
    settings.value = { ...data.settings }
    syncPatternText()
    saved.value = true
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    saving.value = false
  }
}

const saveLatex = async () => {
  latexSaving.value = true
  latexSaved.value = false
  latexError.value = ''
  try {
    const validDefault = latexTargets.value.some(target => target.id === defaultLatexTarget.value)
    await requestJson(`/api/projects/${projectId}/latex/targets`, {
      method: 'PUT',
      body: JSON.stringify({
        defaultTarget: validDefault ? defaultLatexTarget.value : '',
        targets: latexTargets.value,
      }),
    })
    const data = await requestJson<{ defaultTarget: string | null; targets: ProjectLatexTarget[] }>(`/api/projects/${projectId}/latex/targets`)
    latexTargets.value = data.targets.map(target => ({ ...target }))
    defaultLatexTarget.value = data.defaultTarget || ''
    latexSaved.value = true
  } catch (err) {
    latexError.value = (err as Error).message || '保存 LaTeX 配置失败'
  } finally {
    latexSaving.value = false
  }
}

onMounted(load)
</script>

<template>
  <main class="settings-page" :class="{ embedded: props.embedded }">
    <header>
      <button class="ghost" @click="router.push(`/projects/${projectId}`)">← {{ projectName }}</button>
      <div>
        <p class="eyebrow">Project Settings</p>
        <h1>项目设置</h1>
        <p>配置 LaTeX 编译目标和版本历史。Git 仍只由用户显式提交，这里的设置不会自动创建 Git commit。</p>
      </div>
    </header>

    <p v-if="error" class="error">{{ error }}</p>
    <div v-if="loading" class="empty">加载中…</div>

    <template v-else>
    <form class="card" @submit.prevent="save">
      <label class="check"><input v-model="settings.enabled" type="checkbox" /> 启用版本历史</label>

      <div class="grid two">
        <label>Idle debounce（秒）<input v-model.number="settings.idleDebounceSeconds" type="number" min="1" max="3600" /></label>
        <label>Max interval（秒）<input v-model.number="settings.maxIntervalSeconds" type="number" min="1" max="86400" /></label>
        <label>Retention（天）<input v-model.number="settings.retentionDays" type="number" min="1" max="3650" /></label>
        <label>最大存储（MB）<input v-model.number="settings.maxStorageMb" type="number" min="1" max="102400" /></label>
      </div>

      <div class="grid two">
        <label>Include patterns<textarea v-model="includeText" rows="7" spellcheck="false" /><small>每行一个 glob。默认跟踪 Markdown / tex / bib / sty / cls / bst。</small></label>
        <label>Exclude patterns<textarea v-model="excludeText" rows="7" spellcheck="false" /><small>每行一个 glob；匹配项不会进入版本历史。</small></label>
      </div>

      <div class="actions">
        <button class="primary" type="submit" :disabled="saving">{{ saving ? '保存中…' : '保存版本历史设置' }}</button>
        <span v-if="saved" class="saved">已保存</span>
      </div>
    </form>

    <form class="card latex-card" @submit.prevent="saveLatex">
      <div class="card-heading">
        <div>
          <p class="card-kicker">LaTeX</p>
          <h2>编译目标</h2>
          <p>为论文指定源文件根目录。比如将 <code>paper/</code> 设置为根目录后，项目根目录下的其他文件不会进入 LaTeX 编译快照。</p>
        </div>
        <button class="primary" type="submit" :disabled="latexSaving">{{ latexSaving ? '保存中…' : '保存 LaTeX 设置' }}</button>
      </div>

      <p v-if="latexError" class="error">{{ latexError }}</p>
      <div v-if="!latexTargets.length" class="latex-empty">
        <strong>还没有编译目标</strong>
        <span>添加一个目标，例如 sourceRoot 填写 <code>paper</code>，entry 填写 <code>paper/main.tex</code>。</span>
      </div>

      <section v-for="(target, index) in latexTargets" :key="index" class="latex-target-card">
        <div class="latex-target-heading">
          <strong>编译目标 {{ index + 1 }}</strong>
          <button class="danger-button" type="button" @click="removeLatexTarget(index)">移除</button>
        </div>
        <div class="grid two">
          <label>目标 ID<input v-model="target.id" maxlength="64" placeholder="paper-main" /></label>
          <label>显示名称<input v-model="target.name" maxlength="120" placeholder="Paper" /></label>
          <label>源根目录<input v-model="target.sourceRoot" placeholder="paper" /><small>相对于项目根目录；填写 <code>.</code> 表示整个项目。</small></label>
          <label>入口文件<input v-model="target.entry" placeholder="paper/main.tex" /><small>必须位于源根目录内。</small></label>
          <label>编译引擎<select v-model="target.engine"><option v-for="engine in latexEngines" :key="engine.value" :value="engine.value">{{ engine.label }}</option></select></label>
        </div>
      </section>

      <div class="actions latex-actions">
        <button class="secondary" type="button" @click="addLatexTarget">＋ 添加编译目标</button>
        <label v-if="latexTargets.length" class="default-target">默认目标<select v-model="defaultLatexTarget"><option v-for="target in latexTargets" :key="target.id" :value="target.id">{{ target.name || target.id }}</option></select></label>
        <span v-if="latexSaved" class="saved">已保存</span>
      </div>
    </form>
    </template>
  </main>
</template>

<style scoped>
.settings-page{min-height:100vh;max-width:980px;margin:0 auto;padding:36px;color:var(--color-text,#18181b)}.settings-page.embedded{height:100%;min-height:0;max-width:none;overflow:auto;padding:28px 32px;background:transparent}
header{display:flex;gap:20px;align-items:flex-start;margin-bottom:28px}header>div{flex:1}.eyebrow{font-size:12px;text-transform:uppercase;letter-spacing:.12em;opacity:.55;margin:0 0 7px}h1{margin:0 0 8px;font-size:28px}header p:last-child{margin:0;opacity:.62;line-height:1.5}.card{display:grid;gap:22px;padding:22px;border:1px solid rgba(127,127,127,.22);border-radius:12px;background:rgba(127,127,127,.06)}.latex-card{margin-top:18px}.card-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:20px}.card-heading h2{margin:0 0 7px;font-size:20px}.card-heading p{margin:0;opacity:.62;line-height:1.5}.card-kicker{margin:0 0 5px;font-size:11px;letter-spacing:.12em;text-transform:uppercase;opacity:.55}.latex-target-card{display:grid;gap:16px;padding:16px;border:1px solid rgba(127,127,127,.2);border-radius:9px;background:rgba(127,127,127,.04)}.latex-target-heading{display:flex;align-items:center;justify-content:space-between;gap:12px}.latex-empty{display:grid;gap:6px;padding:16px;border:1px dashed rgba(127,127,127,.32);border-radius:9px;opacity:.72}.latex-actions{flex-wrap:wrap}.default-target{display:flex;align-items:center;gap:8px;margin-left:auto}.default-target select{min-width:150px}.secondary,.danger-button{border-radius:8px;padding:8px 12px;cursor:pointer}.secondary{border:1px solid rgba(127,127,127,.3);background:transparent;color:inherit}.danger-button{border:1px solid rgba(210,60,60,.35);background:transparent;color:#d85c5c}.card code,.latex-empty code,.latex-target-card code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.92em}.grid{display:grid;gap:14px}.two{grid-template-columns:repeat(2,minmax(0,1fr))}label{display:grid;gap:7px;font-size:13px}.check{display:flex;align-items:center;gap:8px}.check input{width:auto}input,textarea{box-sizing:border-box;width:100%;background:transparent;color:inherit;border:1px solid rgba(127,127,127,.3);border-radius:7px;padding:9px}textarea{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;resize:vertical}small{opacity:.55;line-height:1.4}.actions{display:flex;align-items:center;gap:12px}.primary,.ghost{border-radius:8px;padding:9px 14px;cursor:pointer}.primary{border:0;background:var(--accent-color,#6d7cff);color:white}.primary:disabled{opacity:.55;cursor:default}.ghost{background:transparent;color:inherit;border:1px solid rgba(127,127,127,.25)}.saved{color:#67c23a;font-size:13px}.error{padding:10px 12px;border-radius:8px;background:rgba(210,60,60,.14);color:#e66}.empty{padding:60px;text-align:center;opacity:.55}
@media(max-width:720px){.settings-page{padding:20px}.two{grid-template-columns:1fr}header{flex-direction:column}.card-heading{flex-direction:column}.default-target{margin-left:0;flex-wrap:wrap}}
</style>
