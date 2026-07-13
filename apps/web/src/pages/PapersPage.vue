<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { usePaperStore, type Paper } from '@/stores/paper'
import { useChatStore } from '@/stores/chat'
import { useNoteStore, type Note } from '@/stores/note'
import { useThemeStore } from '@/stores/theme'
import { useApi } from '@/composables/useApi'
import { useLiveFiles, type LiveFileClient } from '@/composables/useLiveFiles'
import { confirm, confirmChoice } from '@/composables/useConfirm'
import { usePrefsStore } from '@/stores/prefs'

import PdfViewer from '@/components/pdf/PdfViewer.vue'
import ChatPanel from '@/components/chat/ChatPanel.vue'
import FileTree from '@/components/files/FileTree.vue'
import CodeEditor from '@/components/files/CodeEditor.vue'
import OfficePreview from '@/components/files/OfficePreview.vue'
import SettingsContent from '@/components/settings/SettingsContent.vue'
import UploadDialog from '@/components/papers/UploadDialog.vue'
import TopSearchBar from '@/components/search/TopSearchBar.vue'
import SaveToCategoryDialog from '@/components/search/SaveToCategoryDialog.vue'
import ImportToLibraryDialog from '@/components/search/ImportToLibraryDialog.vue'
import JournalRankingBadge from '@/components/rankings/JournalRankingBadge.vue'
import Modal from '@/components/ui/Modal.vue'
import MarkdownContent from '@/components/markdown/MarkdownContent.vue'
import Select from '@/components/ui/Select.vue'
import SortControl, { type SortOption } from '@/components/ui/SortControl.vue'

const route = useRoute()
const router = useRouter()
const api = useApi()
const liveFiles = useLiveFiles()
const paperStore = usePaperStore()
const chatStore = useChatStore()
const noteStore = useNoteStore()
const theme = useThemeStore()
const prefs = usePrefsStore()

const sidebarOpen = ref(true)
const chatOpen = ref(true)
const mobileSidebar = ref(false)
const mobileChat = ref(false)
const showUpload = ref(false)
// Open-papers switcher: a header dropdown listing every open paper.
const tabsMenuOpen = ref(false)
const tabsMenuRef = ref<HTMLElement>()
const onTabsMenuDocClick = (e: MouseEvent) => {
  if (!tabsMenuRef.value?.contains(e.target as Node)) tabsMenuOpen.value = false
}
watch(tabsMenuOpen, (open) => {
  if (open) document.addEventListener('mousedown', onTabsMenuDocClick)
  else document.removeEventListener('mousedown', onTabsMenuDocClick)
})
// Library header shrinks to a compact bar once the paper list is scrolled.
const libraryScrolled = ref(false)
const onLibraryScroll = (e: Event) => { libraryScrolled.value = (e.target as HTMLElement).scrollTop > 12 }
const pdfViewer = ref<Record<string, any>>({})
const showConfirm = (message: string, danger = false): Promise<boolean> =>
  confirm({ message, danger, confirmText: danger ? '删除' : '确认', icon: danger ? 'trash' : 'alert' })

const isMobile = ref(window.innerWidth < 768)
const sidebarWidth = ref(300)
const chatWidth = ref(380)
const sidebarPanelWidth = computed(() => (sidebarOpen.value ? sidebarWidth.value : 0))
const chatPanelWidth = computed(() => (chatOpen.value ? chatWidth.value : 0))

const query = ref('')
const selectedCategory = ref<string | null>(localStorage.getItem('yarc_category') || null)
// Route takes precedence over localStorage for sidebar mode
const getInitialSidebarMode = (): 'library' | 'files' | 'settings' => {
  if (route.name === 'files') return 'files'
  if (route.name === 'settings') return 'settings'
  return (localStorage.getItem('yarc_sidebar_mode') as 'library' | 'files' | 'settings') || 'library'
}
const sidebarMode = ref<'library' | 'files' | 'settings'>(getInitialSidebarMode())
const settingsSection = ref('general')

// Multi-select mode for papers
const selectionMode = ref(false)
const selectedPaperIds = ref<Set<string>>(new Set())
const showMoveDialog = ref(false)
const moveTargetCategory = ref('')

const toggleSelectionMode = () => {
  selectionMode.value = !selectionMode.value
  if (!selectionMode.value) {
    selectedPaperIds.value.clear()
  }
}
const togglePaperSelection = (paperId: string) => {
  if (selectedPaperIds.value.has(paperId)) {
    selectedPaperIds.value.delete(paperId)
  } else {
    selectedPaperIds.value.add(paperId)
  }
}
const selectAllPapers = () => {
  filteredPapers.value.forEach(p => selectedPaperIds.value.add(p.id))
}
const clearSelection = () => {
  selectedPaperIds.value.clear()
}
const isAllSelected = computed(() => {
  return filteredPapers.value.length > 0 &&
         filteredPapers.value.every(p => selectedPaperIds.value.has(p.id))
})

// Flatten categories for dropdown
const flattenedCategories = computed(() => {
  const result: Array<{ value: string; label: string; level: number }> = []
  const traverse = (cats: CategoryNode[], level = 0) => {
    for (const cat of cats) {
      const indent = level > 0 ? '　'.repeat(level) + '└ ' : ''
      result.push({ value: cat.id, label: `${indent}${cat.name}`, level })
      if (cat.children?.length) {
        traverse(cat.children, level + 1)
      }
    }
  }
  traverse(treeCategories.value)
  return result
})

interface FileNode {
  name: string
  path: string
  type: 'file' | 'directory'
  children?: FileNode[]
  size?: number
  modified?: string
  extension?: string
  mime?: string
  editable?: boolean
  office?: boolean
  legacyOffice?: boolean
  readonly?: boolean
}

interface WorkspaceFileTab {
  file: FileNode
  content: string
  savedContent: string
  language: string
  modified: string
  markdownPreview: boolean
  lastAccessedAt: number
}

const OFFICE_EXTENSIONS = new Set(['.docx', '.xlsx', '.pptx'])
const LEGACY_OFFICE_EXTENSIONS = new Set(['.doc', '.xls', '.ppt'])
const isOfficeFile = (node?: FileNode | null) => node?.type === 'file' && (!!node.office || OFFICE_EXTENSIONS.has(node.extension || ''))
const isLegacyOfficeFile = (node?: FileNode | null) => node?.type === 'file' && (!!node.legacyOffice || LEGACY_OFFICE_EXTENSIONS.has(node.extension || ''))
const isWorkspaceFile = (node?: FileNode | null): node is FileNode => node?.type === 'file'

const loadRecentWorkspaceFiles = (): FileNode[] => {
  try {
    const raw = localStorage.getItem('yarc_recent_workspace_files')
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter(isWorkspaceFile).slice(0, 6) : []
  } catch {
    return []
  }
}

const workspaceFiles = ref<FileNode[]>([])
const selectedWorkspaceFile = ref<FileNode | null>(null)
const recentWorkspaceFiles = ref<FileNode[]>(loadRecentWorkspaceFiles())
const openWorkspaceTabs = ref<WorkspaceFileTab[]>([])
const filesLoading = ref(false)
const filesError = ref('')
const workspaceContent = ref('')
const workspaceSavedContent = ref('')
const workspaceLanguage = ref('plaintext')
const workspaceModified = ref('')
const currentLiveClient = shallowRef<LiveFileClient | null>(null)
const workspaceContentLoading = ref(false)
const workspaceSaving = ref(false)
const workspaceUploading = ref(false)
const workspaceOpeningSystem = ref(false)
const workspaceUploadInput = ref<HTMLInputElement | null>(null)
const workspaceUploadTargetPath = ref('')
const selectedWorkspacePath = computed(() => selectedWorkspaceFile.value?.path || '')
const workspaceDirty = computed(() => {
  const live = currentLiveClient.value
  if (live && selectedWorkspacePath.value === live.path) return live.dirty.value || live.saving.value || live.conflict.value
  return workspaceContent.value !== workspaceSavedContent.value
})
const workspaceCanEdit = computed(() => selectedWorkspaceFile.value?.type === 'file' && selectedWorkspaceFile.value.editable && !selectedWorkspaceFile.value.readonly)
const workspaceIsImage = computed(() => selectedWorkspaceFile.value?.type === 'file' && selectedWorkspaceFile.value.mime?.startsWith('image/'))
const workspaceIsOffice = computed(() => isOfficeFile(selectedWorkspaceFile.value))
const workspaceIsLegacyOffice = computed(() => isLegacyOfficeFile(selectedWorkspaceFile.value))
const workspaceIsPdf = computed(() => selectedWorkspaceFile.value?.type === 'file' && selectedWorkspaceFile.value.extension === '.pdf')
const workspaceIsMarkdown = computed(() => workspaceLanguage.value === 'markdown')
const markdownPreview = ref(false)

watch(() => currentLiveClient.value?.content.value, (content) => {
  if (currentLiveClient.value && content !== undefined) workspaceContent.value = content
})
watch(() => currentLiveClient.value?.language.value, (language) => {
  if (currentLiveClient.value && language) workspaceLanguage.value = language
})
watch(() => currentLiveClient.value?.modified.value, (modified) => {
  if (currentLiveClient.value && modified) workspaceModified.value = modified
})
watch(() => currentLiveClient.value?.error.value, (message) => {
  if (currentLiveClient.value) filesError.value = message || ''
})

const persistRecentWorkspaceFiles = () => {
  const items = recentWorkspaceFiles.value.filter(isWorkspaceFile).map(({ children, ...node }) => node)
  localStorage.setItem('yarc_recent_workspace_files', JSON.stringify(items.slice(0, 6)))
}

const touchWorkspaceFile = (node: FileNode) => {
  if (!isWorkspaceFile(node)) return
  const item = { ...node, children: undefined }
  recentWorkspaceFiles.value = [item, ...recentWorkspaceFiles.value.filter((file) => file.path !== node.path)].slice(0, 6)
  persistRecentWorkspaceFiles()
}

const removeRecentWorkspacePath = (path: string) => {
  for (const livePath of Array.from(liveFiles.clients.keys())) {
    if (livePath === path || livePath.startsWith(`${path}/`)) void liveFiles.release(livePath)
  }
  recentWorkspaceFiles.value = recentWorkspaceFiles.value.filter((file) => file.path !== path && !file.path.startsWith(`${path}/`))
  openWorkspaceTabs.value = openWorkspaceTabs.value.filter((tab) => tab.file.path !== path && !tab.file.path.startsWith(`${path}/`))
  persistRecentWorkspaceFiles()
}

const snapshotCurrentWorkspaceTab = () => {
  const file = selectedWorkspaceFile.value
  if (!isWorkspaceFile(file)) return
  const tab: WorkspaceFileTab = {
    file: { ...file, children: undefined },
    content: workspaceContent.value,
    savedContent: workspaceSavedContent.value,
    language: workspaceLanguage.value,
    modified: workspaceModified.value,
    markdownPreview: markdownPreview.value,
    lastAccessedAt: Date.now(),
  }
  openWorkspaceTabs.value = [tab, ...openWorkspaceTabs.value.filter((item) => item.file.path !== file.path)].slice(0, 8)
}

const restoreWorkspaceTab = (tab: WorkspaceFileTab, node: FileNode) => {
  currentLiveClient.value = liveFiles.get(node.path)
  selectedWorkspaceFile.value = node
  workspaceContent.value = currentLiveClient.value?.content.value ?? tab.content
  workspaceSavedContent.value = currentLiveClient.value?.content.value ?? tab.savedContent
  workspaceLanguage.value = currentLiveClient.value?.language.value ?? tab.language
  workspaceModified.value = currentLiveClient.value?.modified.value ?? tab.modified
  markdownPreview.value = tab.markdownPreview
  workspaceContentLoading.value = false
  tab.lastAccessedAt = Date.now()
}

const workspaceSwitcherItems = computed(() => {
  const byPath = new Map<string, FileNode>()
  if (isWorkspaceFile(selectedWorkspaceFile.value)) byPath.set(selectedWorkspaceFile.value.path, selectedWorkspaceFile.value)
  for (const tab of [...openWorkspaceTabs.value].sort((a, b) => b.lastAccessedAt - a.lastAccessedAt)) {
    if (isWorkspaceFile(tab.file)) byPath.set(tab.file.path, tab.file)
  }
  for (const file of recentWorkspaceFiles.value) {
    if (isWorkspaceFile(file)) byPath.set(file.path, file)
  }
  return Array.from(byPath.values()).slice(0, 8)
})

// File context menu
const fileContextMenu = ref<{
  visible: boolean
  x: number
  y: number
  node: FileNode | null
}>({ visible: false, x: 0, y: 0, node: null })

const openFileContextMenu = (e: MouseEvent, node: FileNode | null) => {
  const menuW = 200, menuH = 300, pad = 8
  let x = e.clientX, y = e.clientY
  if (x + menuW > window.innerWidth - pad) x = window.innerWidth - menuW - pad
  if (y + menuH > window.innerHeight - pad) y = window.innerHeight - menuH - pad
  fileContextMenu.value = { visible: true, x, y, node }
}

const closeFileContextMenu = () => {
  fileContextMenu.value.visible = false
}

const fileTreeRef = ref<any>(null)

// Inline create state
const creatingParentPath = ref<string | undefined>(undefined) // undefined = not creating, '' = root, 'path' = inside dir
const creatingType = ref<'file' | 'directory'>('file')

function isPapersWorkspacePath(path?: string | null) {
  const normalized = (path || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')
  return normalized === 'papers' || normalized.startsWith('papers/')
}

const startCreate = (parentPath: string, type: 'file' | 'directory') => {
  if (isPapersWorkspacePath(parentPath)) {
    filesError.value = 'papers/ 是受保护目录，不能在文件管理器中修改'
    return
  }
  creatingParentPath.value = parentPath
  creatingType.value = type
}

const cancelCreate = () => {
  creatingParentPath.value = undefined
}

const openWorkspaceUploadPicker = (parentPath = '') => {
  if (isPapersWorkspacePath(parentPath)) {
    filesError.value = 'papers/ 是受保护目录，不能在文件管理器中修改'
    return
  }
  workspaceUploadTargetPath.value = parentPath
  if (workspaceUploadInput.value) workspaceUploadInput.value.value = ''
  workspaceUploadInput.value?.click()
}

const uploadWorkspaceFiles = async (files: File[], parentPath = '') => {
  if (workspaceUploading.value) return
  const uploadFiles = files.filter((file) => file.size >= 0)
  if (!uploadFiles.length) return
  if (isPapersWorkspacePath(parentPath)) {
    filesError.value = 'papers/ 是受保护目录，不能在文件管理器中修改'
    return
  }

  workspaceUploading.value = true
  filesError.value = ''
  const uploaded: FileNode[] = []
  const errors: string[] = []

  for (const file of uploadFiles) {
    try {
      const res = await api.uploadFile(parentPath, file)
      uploaded.push(res.file as FileNode)
    } catch (err) {
      errors.push(`${file.name}: ${(err as Error).message || '上传失败'}`)
    }
  }

  try {
    await loadWorkspaceFiles(true)
    if (uploaded.length === 1) {
      const uploadedNode = findWorkspaceNode(workspaceFiles.value, uploaded[0].path) || uploaded[0]
      if (uploadedNode.type === 'file') await selectWorkspaceFile(uploadedNode)
    }
  } finally {
    workspaceUploading.value = false
  }

  if (errors.length) {
    filesError.value = uploaded.length
      ? `已上传 ${uploaded.length} 个文件，${errors.length} 个失败：${errors.join('；')}`
      : `上传失败：${errors.join('；')}`
  }
}

const handleWorkspaceUploadInput = (event: Event) => {
  const files = Array.from((event.target as HTMLInputElement).files || [])
  void uploadWorkspaceFiles(files, workspaceUploadTargetPath.value)
}

const handleCreate = async (parentPath: string, name: string, type: 'file' | 'directory') => {
  creatingParentPath.value = undefined
  const path = joinWorkspacePath(parentPath, name)
  try {
    if (type === 'directory') {
      await api.createDirectory(path)
    } else {
      await api.createFile(path)
    }
    await loadWorkspaceFiles(true)
  } catch (err) {
    filesError.value = (err as Error).message || `创建${type === 'directory' ? '文件夹' : '文件'}失败`
  }
}

const settingsSections = [
  { id: 'general', label: '通用', icon: '⚙️' },
  { id: 'ai', label: 'AI', icon: '🤖' },
  { id: 'appearance', label: '外观', icon: '🎨' },
  { id: 'integrations', label: '集成', icon: '🔌' },
  { id: 'data', label: '数据', icon: '📊' },
  { id: 'system', label: '系统', icon: '🔧' },
]

const findWorkspaceNode = (nodes: FileNode[], path: string): FileNode | null => {
  for (const node of nodes) {
    if (node.path === path) return node
    if (node.children) {
      const child = findWorkspaceNode(node.children, path)
      if (child) return child
    }
  }
  return null
}

const clearWorkspaceEditor = () => {
  currentLiveClient.value = null
  workspaceContent.value = ''
  workspaceSavedContent.value = ''
  workspaceLanguage.value = 'plaintext'
  workspaceModified.value = ''
  markdownPreview.value = false
}

const workspaceParentPath = (path: string) => {
  const parts = path.split('/').filter(Boolean)
  parts.pop()
  return parts.join('/')
}

const joinWorkspacePath = (...parts: Array<string | undefined | null>) =>
  parts.filter(Boolean).join('/').replace(/\/+/g, '/').replace(/^\//, '')

const fileContextCreateParentPath = () => {
  const node = fileContextMenu.value.node
  return node?.type === 'directory' ? node.path : workspaceParentPath(node?.path || '')
}

const canCreateInFileContext = () => !isPapersWorkspacePath(fileContextCreateParentPath())

const loadWorkspaceFiles = async (silent = false) => {
  if (!silent) filesLoading.value = true
  filesError.value = ''
  try {
    const res = await api.getFileTree()
    workspaceFiles.value = res.files
    if (selectedWorkspacePath.value) {
      selectedWorkspaceFile.value = findWorkspaceNode(workspaceFiles.value, selectedWorkspacePath.value) || selectedWorkspaceFile.value
    }
  } catch (err) {
    filesError.value = (err as Error).message || '加载文件失败'
  } finally {
    if (!silent) filesLoading.value = false
  }
}

const setSidebarMode = (mode: 'library' | 'files' | 'settings') => {
  sidebarMode.value = mode
  localStorage.setItem('yarc_sidebar_mode', mode)
  // Sync URL for bookmarking (silent, no navigation)
  const targetPath = mode === 'files' ? '/files' : mode === 'settings' ? '/settings' : '/'
  if (route.path !== targetPath) {
    router.replace(targetPath).catch(() => {})
  }
  if (mode === 'files' && !workspaceFiles.value.length) void loadWorkspaceFiles()
}

const prepareWorkspaceSwitch = async () => {
  if (currentLiveClient.value && selectedWorkspacePath.value === currentLiveClient.value.path) {
    snapshotCurrentWorkspaceTab()
    return true
  }

  if (!workspaceDirty.value) {
    snapshotCurrentWorkspaceTab()
    return true
  }

  if (prefs.workspaceAutoSaveOnSwitch) {
    await saveWorkspaceFile()
    if (workspaceDirty.value) return false
    snapshotCurrentWorkspaceTab()
    return true
  }

  const choice = await confirmChoice({
    title: '保存文件修改？',
    message: `「${selectedWorkspaceFile.value?.name || '当前文件'}」有未保存修改。切换前可以保存修改、放弃修改，或取消切换。`,
    cancelText: '取消切换',
    icon: 'alert',
    actions: [
      { label: '保存修改', value: 'save', variant: 'primary' },
      { label: '放弃修改', value: 'discard', variant: 'danger' },
    ],
  })
  if (choice === 'save') {
    await saveWorkspaceFile()
    if (workspaceDirty.value) return false
  } else if (choice === 'discard') {
    workspaceContent.value = workspaceSavedContent.value
  } else {
    return false
  }
  snapshotCurrentWorkspaceTab()
  return true
}

const selectWorkspaceFile = async (node: FileNode) => {
  // Folder clicks are handled by FileTree expansion only. Keep the current editor
  // (or the default empty page) unchanged instead of replacing it with a folder panel.
  if (node.type === 'directory') return

  if (selectedWorkspacePath.value && selectedWorkspacePath.value !== node.path && !(await prepareWorkspaceSwitch())) return
  if (selectedWorkspacePath.value && selectedWorkspacePath.value === node.path) snapshotCurrentWorkspaceTab()

  selectedWorkspaceFile.value = node
  touchWorkspaceFile(node)
  localStorage.setItem('yarc_workspace_file', node.path)
  filesError.value = ''

  const existingTab = openWorkspaceTabs.value.find((tab) => tab.file.path === node.path && isWorkspaceFile(tab.file))
  markdownPreview.value = existingTab?.markdownPreview ?? false

  if (node.type !== 'file' || !node.editable) {
    currentLiveClient.value = null
    if (existingTab) restoreWorkspaceTab(existingTab, node)
    else {
      clearWorkspaceEditor()
      snapshotCurrentWorkspaceTab()
    }
    return
  }

  workspaceContentLoading.value = true
  currentLiveClient.value = null
  try {
    const client = await liveFiles.open(node.path)
    currentLiveClient.value = client
    workspaceContent.value = client.content.value
    workspaceSavedContent.value = client.content.value
    workspaceLanguage.value = client.language.value
    workspaceModified.value = client.modified.value
    snapshotCurrentWorkspaceTab()
  } catch (err) {
    clearWorkspaceEditor()
    filesError.value = (err as Error).message || '读取文件失败'
  } finally {
    workspaceContentLoading.value = false
  }
}

const saveWorkspaceFile = async () => {
  if (!selectedWorkspaceFile.value || !workspaceCanEdit.value || workspaceSaving.value) return
  const live = currentLiveClient.value
  workspaceSaving.value = true
  filesError.value = ''
  try {
    if (live && live.path === selectedWorkspaceFile.value.path) {
      await live.flush()
      workspaceSavedContent.value = live.content.value
    } else if (workspaceDirty.value) {
      const contentToSave = workspaceContent.value
      await api.saveFileContent(selectedWorkspaceFile.value.path, contentToSave)
      workspaceSavedContent.value = contentToSave
    }
    snapshotCurrentWorkspaceTab()
    await loadWorkspaceFiles(true)
  } catch (err) {
    filesError.value = (err as Error).message || '保存失败'
  } finally {
    workspaceSaving.value = false
  }
}

const resolveCurrentLiveConflict = async (strategy: 'use-live' | 'use-disk') => {
  const live = currentLiveClient.value
  if (!live) return
  filesError.value = ''
  try {
    await live.resolveConflict(strategy)
    workspaceSavedContent.value = live.content.value
    snapshotCurrentWorkspaceTab()
    await loadWorkspaceFiles(true)
  } catch (err) {
    filesError.value = (err as Error).message || '冲突处理失败'
  }
}

const saveWorkspaceTab = async (tab: WorkspaceFileTab) => {
  if (tab.file.type !== 'file' || !tab.file.editable || tab.file.readonly) return true
  const live = liveFiles.get(tab.file.path)
  filesError.value = ''
  try {
    if (live) {
      await live.flush()
      tab.content = live.content.value
      tab.savedContent = live.content.value
    } else {
      if (tab.content === tab.savedContent) return true
      await api.saveFileContent(tab.file.path, tab.content)
      tab.savedContent = tab.content
    }
    return true
  } catch (err) {
    filesError.value = (err as Error).message || '保存失败'
    return false
  }
}

const openWorkspaceFileWithSystemApp = async (node: FileNode) => {
  if (node.type !== 'file') return
  workspaceOpeningSystem.value = true
  filesError.value = ''
  try {
    await api.openFileWithSystemApp(node.path)
  } catch (err) {
    filesError.value = (err as Error).message || '无法使用系统应用打开文件'
  } finally {
    workspaceOpeningSystem.value = false
  }
}

const closeWorkspaceTab = async (event: Event, path: string) => {
  event.stopPropagation()
  if (selectedWorkspacePath.value === path) snapshotCurrentWorkspaceTab()

  const isCurrent = selectedWorkspacePath.value === path
  const tab = openWorkspaceTabs.value.find((item) => item.file.path === path)
  const file = (isCurrent ? selectedWorkspaceFile.value : null)
    || tab?.file
    || recentWorkspaceFiles.value.find((item) => item.path === path)
  const live = liveFiles.get(path)
  const isDirty = live ? (live.dirty.value || live.saving.value || live.conflict.value) : (isCurrent ? workspaceDirty.value : !!tab && tab.content !== tab.savedContent)

  if (live?.conflict.value) {
    const choice = await confirmChoice({
      title: '关闭冲突文件？',
      message: `「${file?.name || '当前文件'}」存在外部修改冲突。关闭后不会自动覆盖磁盘版本。`,
      cancelText: '取消关闭',
      icon: 'alert',
      actions: [
        { label: '保留编辑器版本并保存', value: 'save', variant: 'primary' },
        { label: '直接关闭', value: 'discard', variant: 'danger' },
      ],
    })
    if (choice === 'save') {
      await live.resolveConflict('use-live').catch((err) => { filesError.value = (err as Error).message || '冲突处理失败' })
      if (live.conflict.value) return
    } else if (choice !== 'discard') return
  } else if (live && (live.dirty.value || live.saving.value)) {
    await live.flush().catch(() => {})
  } else if (isDirty) {
    if (prefs.workspaceAutoSaveOnSwitch) {
      if (isCurrent) {
        await saveWorkspaceFile()
        if (workspaceDirty.value) return
      } else if (tab && !(await saveWorkspaceTab(tab))) {
        return
      }
    } else {
      const choice = await confirmChoice({
        title: '关闭文件？',
        message: `「${file?.name || '当前文件'}」有未保存修改。关闭前可以保存修改、放弃修改，或取消关闭。`,
        cancelText: '取消关闭',
        icon: 'alert',
        actions: [
          { label: '保存修改', value: 'save', variant: 'primary' },
          { label: '放弃修改', value: 'discard', variant: 'danger' },
        ],
      })
      if (choice === 'save') {
        if (isCurrent) {
          await saveWorkspaceFile()
          if (workspaceDirty.value) return
        } else if (tab && !(await saveWorkspaceTab(tab))) {
          return
        }
      } else if (choice !== 'discard') {
        return
      }
    }
  }

  await liveFiles.release(path)

  recentWorkspaceFiles.value = recentWorkspaceFiles.value.filter((item) => item.path !== path)
  openWorkspaceTabs.value = openWorkspaceTabs.value.filter((item) => item.file.path !== path)
  persistRecentWorkspaceFiles()

  if (!isCurrent) return

  // The current file has been removed from the workspace tab list. Clear the
  // active selection before selecting a fallback tab; otherwise selectWorkspaceFile
  // will run the normal switch preparation and snapshot the just-closed file back
  // into openWorkspaceTabs.
  selectedWorkspaceFile.value = null
  localStorage.removeItem('yarc_workspace_file')
  clearWorkspaceEditor()

  const nextTab = [...openWorkspaceTabs.value].filter((tab) => isWorkspaceFile(tab.file)).sort((a, b) => b.lastAccessedAt - a.lastAccessedAt)[0]
  if (nextTab) {
    const node = findWorkspaceNode(workspaceFiles.value, nextTab.file.path) || nextTab.file
    await selectWorkspaceFile(node)
  }
}

const formatWorkspaceSize = (size?: number) => {
  if (size === undefined) return ''
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

const downloadWorkspaceFile = (node: FileNode) => {
  if (node.type !== 'file') return
  const a = document.createElement('a')
  a.href = api.getFileDownloadUrl(node.path)
  a.download = node.name
  document.body.appendChild(a)
  a.click()
  a.remove()
}

const renameWorkspaceNode = async (node: FileNode, newName?: string) => {
  if (node.readonly) return
  const name = newName ?? window.prompt('新的名称', node.name)?.trim()
  if (!name || name === node.name) return
  filesError.value = ''
  try {
    const oldPath = node.path
    const target = joinWorkspacePath(workspaceParentPath(oldPath), name)
    const res = await api.renamePath(oldPath, target)
    removeRecentWorkspacePath(oldPath)
    await loadWorkspaceFiles(true)
    const renamed = (findWorkspaceNode(workspaceFiles.value, res.file.path) || res.file) as FileNode
    await selectWorkspaceFile(renamed)
  } catch (err) {
    filesError.value = (err as Error).message || '重命名失败'
  }
}

const handleTreeRename = (node: FileNode, newName: string) => {
  void renameWorkspaceNode(node, newName)
}

const workspaceRootDropActive = ref(false)

const isWorkspaceFileNodeDragTarget = (event: DragEvent) =>
  !!(event.target as HTMLElement | null)?.closest('.file-node')

const readDraggedWorkspaceNode = (event: DragEvent): FileNode | null => {
  const raw = event.dataTransfer?.getData('application/x-yarc-file-node')
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as FileNode
    return parsed?.path && parsed?.name && parsed?.type ? parsed : null
  } catch {
    return null
  }
}

const isExternalWorkspaceFileDrag = (event: DragEvent) => Array.from(event.dataTransfer?.types || []).includes('Files')
const getDroppedWorkspaceFiles = (event: DragEvent) => Array.from(event.dataTransfer?.files || [])

const handleWorkspaceRootDragOver = (event: DragEvent) => {
  if (isWorkspaceFileNodeDragTarget(event)) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = isExternalWorkspaceFileDrag(event) ? 'copy' : 'move'
  workspaceRootDropActive.value = true
}

const handleWorkspaceRootDragLeave = (event: DragEvent) => {
  if ((event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) return
  workspaceRootDropActive.value = false
}

const handleWorkspaceRootDrop = (event: DragEvent) => {
  if (isWorkspaceFileNodeDragTarget(event)) return
  event.preventDefault()
  workspaceRootDropActive.value = false

  const files = getDroppedWorkspaceFiles(event)
  if (files.length) {
    void uploadWorkspaceFiles(files, '')
    return
  }

  const node = readDraggedWorkspaceNode(event)
  if (node) void moveWorkspaceNode(node, '')
}

const moveWorkspaceNode = async (node: FileNode, targetDirPath: string) => {
  if (node.readonly) return

  const targetDir = targetDirPath.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')
  if (isPapersWorkspacePath(targetDir)) {
    filesError.value = 'papers/ 是受保护目录，不能在文件管理器中修改'
    return
  }
  if (node.type === 'directory' && (targetDir === node.path || targetDir.startsWith(`${node.path}/`))) {
    filesError.value = '不能把文件夹移动到自身或其子文件夹中'
    return
  }

  const targetPath = joinWorkspacePath(targetDir, node.name)
  if (!targetPath || targetPath === node.path) return

  const selectedBeforeMove = selectedWorkspacePath.value
  const selectedWasInsideMove = selectedBeforeMove === node.path || selectedBeforeMove.startsWith(`${node.path}/`)
  if (selectedWasInsideMove && workspaceDirty.value && !(await prepareWorkspaceSwitch())) return

  filesError.value = ''
  try {
    const res = await api.renamePath(node.path, targetPath)
    removeRecentWorkspacePath(node.path)
    await loadWorkspaceFiles(true)

    if (selectedWasInsideMove) {
      const nextSelectedPath = selectedBeforeMove === node.path
        ? res.file.path
        : joinWorkspacePath(res.file.path, selectedBeforeMove.slice(node.path.length + 1))
      const movedSelectedNode = findWorkspaceNode(workspaceFiles.value, nextSelectedPath)
      selectedWorkspaceFile.value = null
      localStorage.removeItem('yarc_workspace_file')
      clearWorkspaceEditor()
      if (movedSelectedNode) await selectWorkspaceFile(movedSelectedNode)
      else filesError.value = `文件已移动，但未能重新打开：${nextSelectedPath}`
    }
  } catch (err) {
    filesError.value = (err as Error).message || '移动失败'
  }
}

const deleteWorkspaceNode = async (node: FileNode) => {
  if (node.readonly) return
  const label = node.type === 'directory' ? '文件夹' : '文件'
  if (!(await confirm({
    title: `删除${label}`,
    message: `「${node.name}」将被永久删除，此操作不可撤销。`,
    confirmText: '删除',
    danger: true,
    icon: 'trash',
  }))) return
  filesError.value = ''
  try {
    await api.deletePath(node.path)
    if (selectedWorkspacePath.value === node.path || selectedWorkspacePath.value.startsWith(`${node.path}/`)) {
      selectedWorkspaceFile.value = null
      localStorage.removeItem('yarc_workspace_file')
      clearWorkspaceEditor()
    }
    removeRecentWorkspacePath(node.path)
    await loadWorkspaceFiles(true)
  } catch (err) {
    filesError.value = (err as Error).message || '删除失败'
  }
}

// Context menu actions
const fileCtxNewFolder = () => {
  const parentPath = fileContextCreateParentPath()
  closeFileContextMenu()
  startCreate(parentPath, 'directory')
}

const fileCtxNewFile = () => {
  const parentPath = fileContextCreateParentPath()
  closeFileContextMenu()
  startCreate(parentPath, 'file')
}

const fileCtxUpload = () => {
  const parentPath = fileContextCreateParentPath()
  closeFileContextMenu()
  openWorkspaceUploadPicker(parentPath)
}

const fileCtxRename = () => {
  const node = fileContextMenu.value.node
  closeFileContextMenu()
  if (!node || node.readonly) return
  // Trigger inline rename via FileTree ref
  fileTreeRef.value?.startRename(node)
}

const fileCtxDelete = () => {
  const node = fileContextMenu.value.node
  closeFileContextMenu()
  if (!node) return
  void deleteWorkspaceNode(node)
}

const fileCtxDownload = () => {
  const node = fileContextMenu.value.node
  closeFileContextMenu()
  if (!node) return
  downloadWorkspaceFile(node)
}

watch(() => route.name, (name) => {
  if (name === 'files') setSidebarMode('files')
  else if (name === 'settings') setSidebarMode('settings')
  else if (name === 'home') setSidebarMode('library')
}, { immediate: true })

// Sort options with localStorage persistence
const sortOptions: { field: string; label: string }[] = [
  { field: 'createdAt', label: '添加时间' },
  { field: 'year', label: '论文年份' },
  { field: 'title', label: '标题' },
  { field: 'authors', label: '作者' },
  { field: 'journal', label: '期刊/会议' },
  { field: 'ccf', label: 'CCF 排名' },
  { field: 'sci', label: 'SCI 分区' },
]

const savedSort = localStorage.getItem('yarc_sort')
const sortBy = ref<SortOption[]>(savedSort ? JSON.parse(savedSort) : [{ field: 'createdAt', direction: 'desc' }])
const ccfFilter = ref(localStorage.getItem('yarc_ccf_filter') || 'all')
const sciFilter = ref(localStorage.getItem('yarc_sci_filter') || 'all')

watch(sortBy, (val) => {
  localStorage.setItem('yarc_sort', JSON.stringify(val))
}, { deep: true })
watch(ccfFilter, (val) => localStorage.setItem('yarc_ccf_filter', val))
watch(sciFilter, (val) => localStorage.setItem('yarc_sci_filter', val))

const categories = ref<any[]>([])
// Load expanded categories from localStorage
const loadExpandedCategories = (): Record<string, boolean> => {
  try {
    const saved = localStorage.getItem('yarc_expanded_categories')
    return saved ? JSON.parse(saved) : {}
  } catch {
    return {}
  }
}
const expandedCategories = ref<Record<string, boolean>>(loadExpandedCategories())
const contextMenu = ref<{ visible: boolean; x: number; y: number; categoryId: string; categoryName: string; isBlank: boolean; isChild: boolean }>({ visible: false, x: 0, y: 0, categoryId: '', categoryName: '', isBlank: false, isChild: false })
const renamingCategoryId = ref<string | null>(null)
const renamingValue = ref('')
const addingToParentId = ref<string | null>('__hidden') // '__hidden' = hidden, null = adding top-level, string = adding child of that id
const addingCategoryName = ref('')
const paperContextMenu = ref<{ visible: boolean; x: number; y: number; paperId: string; paperTitle: string }>({ visible: false, x: 0, y: 0, paperId: '', paperTitle: '' })
const searchCategoryContextMenu = ref<{ visible: boolean; x: number; y: number; categoryId: string; categoryName: string }>({ visible: false, x: 0, y: 0, categoryId: '', categoryName: '' })
const searchPaperContextMenu = ref<{ visible: boolean; x: number; y: number; paperId: string; paperTitle: string }>({ visible: false, x: 0, y: 0, paperId: '', paperTitle: '' })
const paperCategoryPicker = ref(false)
const paperDetails = ref<any>(null)
const flyoutPos = ref({ x: 0, y: 0 })
const flyoutHovered = ref(false)
const subFlyoutCategoryId = ref<string | null>(null)
const subFlyoutPos = ref({ x: 0, y: 0 })
let closePickerTimer: ReturnType<typeof setTimeout> | null = null
const notesDraft = ref('')
const editingNoteId = ref<string | null>(null)
const editingNoteContent = ref('')

// Search related state
const showSaveToCategory = ref(false)
const papersToSave = ref<any[]>([])
const showImportToLibrary = ref(false)
const papersToImport = ref<any[]>([])
const searchCategories = ref<any[]>([])
const selectedSearchCategory = ref<string | null>(null)
const searchCategoryPapers = ref<any[]>([])
const loadingSearchPapers = ref(false)
const showSearchPaperDetail = ref(false)
const selectedSearchPaper = ref<any>(null)
const showPaperDetailsModal = ref(false)
const pendingSearchPage = ref<number | null>(null)
const expandedAbstracts = ref<Set<string>>(new Set())
const isSearchCategoryView = computed(() => !!selectedSearchCategory.value)

const activePaperId = computed(() => (typeof route.params.id === 'string' ? route.params.id : ''))
const hasPaper = computed(() => !!activePaperId.value)
const readerTabs = ref<Array<{ paper: Paper; lastAccessedAt: number }>>([])
const readerTabLimit = computed(() => (isMobile.value ? 4 : 6))
const activePaper = computed(() => {
  const id = activePaperId.value
  if (!id) return null
  if (paperStore.currentPaper?.id === id) return paperStore.currentPaper
  return readerTabs.value.find((tab) => tab.paper.id === id)?.paper || null
})
const workSwitcherLabel = computed(() => {
  if (hasPaper.value) return activePaper.value?.title || `${readerTabs.value.length} 篇已打开`
  if (sidebarMode.value === 'files' && selectedWorkspaceFile.value) return `${workspaceDirty.value ? '• ' : ''}${selectedWorkspaceFile.value.name}`
  if (readerTabs.value.length) return `${readerTabs.value.length} 篇已打开`
  if (selectedWorkspaceFile.value) return `${workspaceDirty.value ? '• ' : ''}${selectedWorkspaceFile.value.name}`
  return '工作区'
})
const workSwitcherTitle = computed(() => {
  if (hasPaper.value) return activePaper.value?.title || '切换工作项'
  if (selectedWorkspaceFile.value) return selectedWorkspaceFile.value.path || selectedWorkspaceFile.value.name
  return '切换工作项'
})

const switchWorkspaceTab = async (path: string) => {
  tabsMenuOpen.value = false
  if (!workspaceFiles.value.length) await loadWorkspaceFiles()
  const node = findWorkspaceNode(workspaceFiles.value, path) || recentWorkspaceFiles.value.find((file) => file.path === path)
  if (node && selectedWorkspacePath.value !== path) await selectWorkspaceFile(node)
  if (!node) filesError.value = `文件不存在或已被移动：${path}`
  setSidebarMode('files')
}
const uncategorizedCount = computed(() => paperStore.papers.filter((paper) => !paper.categoryId).length)
const categoryNameById = computed(() => new Map(categories.value.map((cat) => [cat.id, cat.name])))
const cleanAbstract = (abstract?: string | null) =>
  abstract?.replace(/^\s*(?:abstract|摘要)?\s*[\-–—:：]+\s*/i, '').trim() || ''

const isAbstractExpanded = (paperId: string) => expandedAbstracts.value.has(paperId)

const toggleAbstract = (e: Event, paperId: string) => {
  e.stopPropagation()
  const next = new Set(expandedAbstracts.value)
  if (next.has(paperId)) next.delete(paperId)
  else next.add(paperId)
  expandedAbstracts.value = next
}

// Category tree helpers
interface CategoryNode {
  id: string; name: string; color: string; parentId: string | null
  paperCount: number; children: CategoryNode[]
}

const treeCategories = computed(() => {
  const map = new Map<string, CategoryNode>()
  const roots: CategoryNode[] = []
  for (const cat of categories.value) {
    map.set(cat.id, {
      id: cat.id, name: cat.name, color: cat.color || '#a1a1aa',
      parentId: cat.parentId ?? null, paperCount: cat._count?.papers || 0,
      children: [],
    })
  }
  for (const node of map.values()) {
    if (node.parentId && map.has(node.parentId)) map.get(node.parentId)!.children.push(node)
    else roots.push(node)
  }
  return roots
})

const categoryDescendantIds = (id: string): string[] => {
  const result: string[] = [id]
  const stack = [id]
  while (stack.length) {
    const current = stack.pop()!
    for (const cat of categories.value) {
      if (cat.parentId === current && !result.includes(cat.id)) {
        result.push(cat.id)
        stack.push(cat.id)
      }
    }
  }
  return result
}

const toggleCategoryExpand = (id: string) => {
  expandedCategories.value[id] = !expandedCategories.value[id]
  // Persist to localStorage
  localStorage.setItem('yarc_expanded_categories', JSON.stringify(expandedCategories.value))
}

const selectCategory = (id: string | null) => {
  selectedSearchCategory.value = null
  selectedCategory.value = id
  if (id === null) {
    // “全部文献” should mean the complete library, not merely all categories
    // while stale ranking filters continue hiding otherwise valid papers.
    ccfFilter.value = 'all'
    sciFilter.value = 'all'
  }
  clearSelection()
  localStorage.setItem('yarc_category', id || '')
  // Category changes also act as an explicit refresh. This recovers cleanly if
  // a background import completed while its SSE event was missed or delayed.
  void refreshLibrary().catch(() => {})
}

const getPaperRankings = (paper: any): { ccf: string | null; sci: string | null } => ({
  ccf: paper.rankings?.ccf || paper.ranking?.ccf || null,
  sci: paper.rankings?.sci || paper.ranking?.sci || null,
})

const ccfRankValue = (rank?: string | null) => {
  if (rank === 'CCF-A') return 1
  if (rank === 'CCF-B') return 2
  if (rank === 'CCF-C') return 3
  return 99
}

const sciRankValue = (rank?: string | null) => {
  if (rank === 'Q1') return 1
  if (rank === 'Q2') return 2
  if (rank === 'Q3') return 3
  if (rank === 'Q4') return 4
  return 99
}

const matchesRankingFilters = (paper: any) => {
  const ranks = getPaperRankings(paper)
  const ccfOk = ccfFilter.value === 'all'
    || (ccfFilter.value === 'none' ? !ranks.ccf : ranks.ccf === ccfFilter.value)
  const sciOk = sciFilter.value === 'all'
    || (sciFilter.value === 'none' ? !ranks.sci : ranks.sci === sciFilter.value)
  return ccfOk && sciOk
}

const comparePaperSort = (a: any, b: any, field: string) => {
  if (field === 'createdAt') {
    const dateA = new Date(a.createdAt || a.savedAt || 0).getTime()
    const dateB = new Date(b.createdAt || b.savedAt || 0).getTime()
    return dateA - dateB
  }
  if (field === 'year') return (a.year || 0) - (b.year || 0)
  if (field === 'title') return String(a.title || '').localeCompare(String(b.title || ''))
  if (field === 'authors') {
    const authorA = a.authors?.[0] || ''
    const authorB = b.authors?.[0] || ''
    return authorA.localeCompare(authorB)
  }
  if (field === 'journal') {
    const journalA = a.journal || a.venue || ''
    const journalB = b.journal || b.venue || ''
    return journalA.localeCompare(journalB)
  }
  if (field === 'ccf') return ccfRankValue(getPaperRankings(b).ccf) - ccfRankValue(getPaperRankings(a).ccf)
  if (field === 'sci') return sciRankValue(getPaperRankings(b).sci) - sciRankValue(getPaperRankings(a).sci)
  return 0
}

const sortPaperList = <T extends any>(list: T[]): T[] => {
  if (sortBy.value.length === 0) return list
  return [...list].sort((a, b) => {
    for (const sort of sortBy.value) {
      const comparison = comparePaperSort(a, b, sort.field)
      if (comparison !== 0) return sort.direction === 'asc' ? comparison : -comparison
    }
    return 0
  })
}

const filteredPapers = computed(() => {
  // If viewing search category, show search category papers
  if (selectedSearchCategory.value) {
    const q = query.value.trim().toLowerCase()
    let list = searchCategoryPapers.value

    if (q) {
      list = list.filter((paper) =>
        paper.title.toLowerCase().includes(q) ||
        paper.authors?.some((author: string) => author.toLowerCase().includes(q)) ||
        (paper.year ? String(paper.year).includes(q) : false)
      )
    }

    list = list.filter(matchesRankingFilters)

    return sortPaperList(list)
  }

  // Otherwise show library papers
  let list = paperStore.papers
  if (selectedCategory.value === '__uncategorized') list = list.filter((paper) => !paper.categoryId)
  else if (selectedCategory.value) {
    const ids = categoryDescendantIds(selectedCategory.value)
    list = list.filter((paper) => paper.categoryId && ids.includes(paper.categoryId))
  }

  const q = query.value.trim().toLowerCase()
  if (q) {
    list = list.filter((paper) =>
      paper.title.toLowerCase().includes(q) ||
      paper.authors.some((author) => author.toLowerCase().includes(q)) ||
      paper.tags.some((tag) => tag.toLowerCase().includes(q)) ||
      (paper.year ? String(paper.year).includes(q) : false)
    )
  }

  list = list.filter(matchesRankingFilters)

  return sortPaperList(list)
})

const sortedNotes = computed(() => [...noteStore.notes].sort((a, b) => {
  const pageA = a.pageNumber ?? Number.MAX_SAFE_INTEGER
  const pageB = b.pageNumber ?? Number.MAX_SAFE_INTEGER
  if (pageA !== pageB) return pageA - pageB
  return new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime()
}))

const statusMap: Record<string, string> = {
  pending: '待处理',
  processing: '解析中',
  completed: '已完成',
  failed: '失败',
}

const currentCategoryLabel = computed(() => {
  if (selectedSearchCategory.value) {
    const cat = searchCategories.value.find(c => c.id === selectedSearchCategory.value)
    return cat?.name || '搜索收藏'
  }
  if (selectedCategory.value === '__uncategorized') return '未分类'
  if (!selectedCategory.value) return '全部文献'
  return categoryNameById.value.get(selectedCategory.value) || '分类'
})

const touchReaderTab = (paper: Paper) => {
  const now = Date.now()
  const existing = readerTabs.value.find((tab) => tab.paper.id === paper.id)
  if (existing) {
    existing.paper = { ...existing.paper, ...paper }
    existing.lastAccessedAt = now
  } else {
    readerTabs.value.push({ paper, lastAccessedAt: now })
  }

  while (readerTabs.value.length > readerTabLimit.value) {
    const candidates = readerTabs.value.filter((tab) => tab.paper.id !== paper.id)
    const evict = candidates.sort((a, b) => a.lastAccessedAt - b.lastAccessedAt)[0]
    if (!evict) break
    readerTabs.value = readerTabs.value.filter((tab) => tab.paper.id !== evict.paper.id)
  }
}

const switchReaderTab = async (paperId: string) => {
  if (!hasPaper.value && sidebarMode.value === 'files' && selectedWorkspaceFile.value && !(await prepareWorkspaceSwitch())) return
  const tab = readerTabs.value.find((item) => item.paper.id === paperId)
  if (tab) tab.lastAccessedAt = Date.now()
  void router.push(`/paper/${paperId}`)
}

const closeReaderTab = (event: Event, paperId: string) => {
  event.stopPropagation()
  const idx = readerTabs.value.findIndex((tab) => tab.paper.id === paperId)
  if (idx < 0) return
  const wasActive = activePaperId.value === paperId
  readerTabs.value.splice(idx, 1)
  if (!wasActive) return
  const next = readerTabs.value[Math.min(idx, readerTabs.value.length - 1)] || readerTabs.value[idx - 1]
  if (next) void router.push(`/paper/${next.paper.id}`)
  else void router.push('/')
}

// ── Responsive ───────────────────────────────────────────────────────────────

const onResize = () => {
  isMobile.value = window.innerWidth < 768
  if (!isMobile.value) {
    mobileSidebar.value = false
    mobileChat.value = false
  }
}

const isSaveShortcut = (event: KeyboardEvent) =>
  (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 's'

const onDocumentKeydown = (event: KeyboardEvent) => {
  if (!isSaveShortcut(event)) return
  if (hasPaper.value || sidebarMode.value !== 'files' || !selectedWorkspaceFile.value || !workspaceCanEdit.value) return

  event.preventDefault()
  event.stopPropagation()
  void saveWorkspaceFile()
}

onMounted(async () => {
  window.addEventListener('resize', onResize)
  window.addEventListener('yarc-open-chat', openChatPanel)
  document.addEventListener('click', onDocumentClick)
  document.addEventListener('keydown', onDocumentKeydown)
  document.addEventListener('scroll', closeAllContextMenus, true)
  const saved = localStorage.getItem('yarc-sidebar-width')
  if (saved) sidebarWidth.value = parseInt(saved)
  const savedChat = localStorage.getItem('yarc-chat-width')
  if (savedChat) chatWidth.value = parseInt(savedChat)

  await Promise.all([
    paperStore.fetchPapers({ limit: 500 }),
    api.getCategories().then((res) => { categories.value = res.categories }).catch(() => {}),
    chatStore.fetchConversations(),
    chatStore.fetchModels(),
    fetchSearchCategories()
  ])

  // Restore workspace file if in files mode
  if (sidebarMode.value === 'files') {
    await loadWorkspaceFiles()
    const savedPath = localStorage.getItem('yarc_workspace_file')
    if (savedPath && workspaceFiles.value.length) {
      const node = findWorkspaceNode(workspaceFiles.value, savedPath)
      if (node) await selectWorkspaceFile(node)
    }
  }
})

onBeforeUnmount(() => {
  void liveFiles.releaseAll()
  window.removeEventListener('resize', onResize)
  window.removeEventListener('yarc-open-chat', openChatPanel)
  document.removeEventListener('click', onDocumentClick)
  document.removeEventListener('keydown', onDocumentKeydown)
  document.removeEventListener('scroll', closeAllContextMenus, true)
})

// ── Drag resize ──────────────────────────────────────────────────────────────

let resizing: 'left' | 'right' | null = null
let startX = 0
let startW = 0
let dragRaf = 0
let pendingDragX: number | null = null

const startResize = (side: 'left' | 'right', e: MouseEvent) => {
  resizing = side
  startX = e.clientX
  startW = side === 'left' ? sidebarWidth.value : chatWidth.value
  document.addEventListener('mousemove', onDrag)
  document.addEventListener('mouseup', stopResize)
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
  document.body.classList.add('resizing-panels')
  // Force-disable transitions on the actual elements.
  const sidebar = document.querySelector('.app-sidebar') as HTMLElement
  const chat = document.querySelector('.app-chat') as HTMLElement
  if (sidebar) sidebar.style.transition = 'none'
  if (chat) chat.style.transition = 'none'
}

const applyDrag = () => {
  dragRaf = 0
  if (!resizing || pendingDragX === null) return
  const x = pendingDragX
  pendingDragX = null
  const d = x - startX
  if (resizing === 'left') sidebarWidth.value = Math.min(460, Math.max(240, startW + d))
  else chatWidth.value = Math.min(600, Math.max(300, startW - d))
}

const onDrag = (e: MouseEvent) => {
  if (!resizing) return
  pendingDragX = e.clientX
  if (!dragRaf) dragRaf = requestAnimationFrame(applyDrag)
}

const stopResize = () => {
  resizing = null
  pendingDragX = null
  if (dragRaf) {
    cancelAnimationFrame(dragRaf)
    dragRaf = 0
  }
  document.removeEventListener('mousemove', onDrag)
  document.removeEventListener('mouseup', stopResize)
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
  document.body.classList.remove('resizing-panels')
  // Restore transitions.
  const sidebar = document.querySelector('.app-sidebar') as HTMLElement
  const chat = document.querySelector('.app-chat') as HTMLElement
  if (sidebar) sidebar.style.transition = ''
  if (chat) chat.style.transition = ''
  localStorage.setItem('yarc-sidebar-width', String(sidebarWidth.value))
  localStorage.setItem('yarc-chat-width', String(chatWidth.value))
}

// ── Paper / note selection ──────────────────────────────────────────────────

watch(() => route.params.id, async (id) => {
  if (id && typeof id === 'string') {
    await paperStore.fetchPaper(id)
    if (paperStore.currentPaper) touchReaderTab(paperStore.currentPaper)
    await noteStore.fetchNotes(id)
    if (isMobile.value) mobileSidebar.value = false
  } else {
    noteStore.notes = []
    notesDraft.value = ''
    editingNoteId.value = null
  }
}, { immediate: true })

const openPaper = async (id: string) => {
  if (!hasPaper.value && sidebarMode.value === 'files' && selectedWorkspaceFile.value && !(await prepareWorkspaceSwitch())) return
  void router.push(`/paper/${id}`)
}
const backToLibrary = () => router.push('/')
const setPdfViewer = (paperId: string, viewer: any) => {
  if (viewer) pdfViewer.value[paperId] = viewer
  else delete pdfViewer.value[paperId]
}
const getActivePdfViewer = () => pdfViewer.value[activePaperId.value]
const onNoteClick = (note: Note) => { getActivePdfViewer()?.scrollToNote(note) }

const openUpload = () => {
  showUpload.value = true
  mobileSidebar.value = false
}

// Get current category ID for upload
const uploadCategoryId = computed(() => {
  if (!selectedCategory.value || selectedCategory.value === '__uncategorized') return null
  return selectedCategory.value
})

const openChatPanel = (e?: Event) => {
  if (isMobile.value) {
    mobileChat.value = true
    mobileSidebar.value = false
  } else {
    chatOpen.value = true
  }
  const prompt = (e as CustomEvent)?.detail?.prompt
  if (prompt) chatStore.pendingPrompt = prompt
}

const refreshLibrary = async () => {
  await Promise.all([
    paperStore.fetchPapers({ limit: 500 }),
    api.getCategories().then((res) => { categories.value = res.categories }).catch(() => {}),
  ])
}

let libraryRefreshTimer: number | null = null
let searchCategoryRefreshTimer: number | null = null

const refreshLibrarySoon = () => {
  if (libraryRefreshTimer !== null) window.clearTimeout(libraryRefreshTimer)
  libraryRefreshTimer = window.setTimeout(() => {
    libraryRefreshTimer = null
    refreshLibrary().catch(() => {})
  }, 200)
}

const refreshSearchCategoriesSoon = () => {
  if (searchCategoryRefreshTimer !== null) window.clearTimeout(searchCategoryRefreshTimer)
  searchCategoryRefreshTimer = window.setTimeout(() => {
    searchCategoryRefreshTimer = null
    fetchSearchCategories().catch(() => {})
  }, 200)
}

const onRealtimeLibraryChanged = () => refreshLibrarySoon()
const onRealtimeCategoriesChanged = () => refreshLibrarySoon()
const onRealtimeSearchCategoriesChanged = () => refreshSearchCategoriesSoon()
const onPiConfigChanged = () => {
  chatStore.fetchModels().catch(() => {})
}
const onRealtimeNotesChanged = (event: Event) => {
  const paperId = (event as CustomEvent)?.detail?.paperId
  const currentId = typeof route.params.id === 'string' ? route.params.id : ''
  if (paperId && currentId === paperId) noteStore.fetchNotes(paperId).catch(() => {})
}

const normalizeWorkspaceFilePath = (path?: string | null) => (path || '').replace(/\\/g, '/').replace(/^\/+/, '')

const refreshOpenWorkspaceFileContent = async (changedPath?: string) => {
  const normalizedChangedPath = normalizeWorkspaceFilePath(changedPath)
  const candidatePaths = new Set<string>()

  if (isWorkspaceFile(selectedWorkspaceFile.value) && selectedWorkspaceFile.value.editable) {
    candidatePaths.add(selectedWorkspaceFile.value.path)
  }
  for (const tab of openWorkspaceTabs.value) {
    if (isWorkspaceFile(tab.file) && tab.file.editable && !tab.file.readonly) candidatePaths.add(tab.file.path)
  }

  for (const path of candidatePaths) {
    // On exact save/create events we only need to refresh the affected file. For
    // watcher `external-change` events, still refresh every open tab because the
    // backend watcher intentionally coalesces quick filesystem changes.
    if (normalizedChangedPath && path !== normalizedChangedPath) continue

    try {
      const live = liveFiles.get(path)
      if (live && (live.dirty.value || live.saving.value || live.conflict.value)) continue
      const res = await api.getFileContent(path, { refreshLive: !!live })
      if (live) {
        if (!live.dirty.value && !live.saving.value && !live.conflict.value) live.syncContent(res.content)
        live.language.value = res.language
        live.modified.value = res.modified
        const isCurrentLive = selectedWorkspacePath.value === path
        const tabLive = openWorkspaceTabs.value.find((item) => item.file.path === path)
        if (isCurrentLive) {
          workspaceContent.value = live.content.value
          workspaceSavedContent.value = live.content.value
          workspaceLanguage.value = res.language
          workspaceModified.value = res.modified
          snapshotCurrentWorkspaceTab()
        }
        if (tabLive) {
          tabLive.content = live.content.value
          tabLive.savedContent = live.content.value
          tabLive.language = res.language
          tabLive.modified = res.modified
        }
        continue
      }
      const isCurrent = selectedWorkspacePath.value === path
      const tab = openWorkspaceTabs.value.find((item) => item.file.path === path)
      const previousSavedContent = isCurrent ? workspaceSavedContent.value : tab?.savedContent
      const isDirty = isCurrent ? workspaceDirty.value : !!tab && tab.content !== tab.savedContent
      const diskContentChanged = previousSavedContent !== undefined && previousSavedContent !== res.content

      if (isCurrent) {
        workspaceLanguage.value = res.language
        workspaceModified.value = res.modified
        workspaceSavedContent.value = res.content
        if (!isDirty) workspaceContent.value = res.content
      }

      if (tab) {
        tab.language = res.language
        tab.modified = res.modified
        tab.savedContent = res.content
        if (!isDirty) tab.content = res.content
      }

      if (isCurrent) {
        if (isDirty && diskContentChanged && workspaceContent.value !== res.content) {
          filesError.value = '文件已在磁盘更新；当前有未保存修改，未自动覆盖。'
        }
        snapshotCurrentWorkspaceTab()
      }
    } catch (err) {
      if (selectedWorkspacePath.value === path) {
        filesError.value = (err as Error).message || '刷新文件内容失败'
      }
    }
  }
}

const onRealtimeFilesChanged = (event: Event) => {
  const detail = (event as CustomEvent)?.detail || {}
  const action = typeof detail.action === 'string' ? detail.action : ''
  const changedPath = typeof detail.path === 'string' ? detail.path : ''

  if (sidebarMode.value === 'files' && action !== 'live-save') {
    void loadWorkspaceFiles(true)
  }

  if (action === 'external-change') {
    void refreshOpenWorkspaceFileContent()
  } else if (changedPath && ['save', 'create-file'].includes(action)) {
    void refreshOpenWorkspaceFileContent(changedPath)
  }
}

onMounted(() => {
  window.addEventListener('yarc-library-changed', onRealtimeLibraryChanged)
  window.addEventListener('yarc-categories-changed', onRealtimeCategoriesChanged)
  window.addEventListener('yarc-search-categories-changed', onRealtimeSearchCategoriesChanged)
  window.addEventListener('yarc-pi-config-changed', onPiConfigChanged)
  window.addEventListener('yarc-notes-changed', onRealtimeNotesChanged)
  window.addEventListener('yarc-files-changed', onRealtimeFilesChanged)
})

onBeforeUnmount(() => {
  window.removeEventListener('yarc-library-changed', onRealtimeLibraryChanged)
  window.removeEventListener('yarc-categories-changed', onRealtimeCategoriesChanged)
  window.removeEventListener('yarc-search-categories-changed', onRealtimeSearchCategoriesChanged)
  window.removeEventListener('yarc-pi-config-changed', onPiConfigChanged)
  window.removeEventListener('yarc-notes-changed', onRealtimeNotesChanged)
  window.removeEventListener('yarc-files-changed', onRealtimeFilesChanged)
  if (libraryRefreshTimer !== null) window.clearTimeout(libraryRefreshTimer)
  if (searchCategoryRefreshTimer !== null) window.clearTimeout(searchCategoryRefreshTimer)
})

const openContextMenu = (e: Event, cat?: { id: string; name: string; parentId?: string | null }) => {
  e.preventDefault()
  e.stopPropagation()
  const me = e as MouseEvent
  if (cat) {
    const isChild = !!cat.parentId
    contextMenu.value = { visible: true, x: me.clientX, y: me.clientY, categoryId: cat.id, categoryName: cat.name, isBlank: false, isChild }
  } else {
    contextMenu.value = { visible: true, x: me.clientX, y: me.clientY, categoryId: '', categoryName: '', isBlank: true, isChild: false }
  }
}

const closeContextMenu = () => { contextMenu.value.visible = false }
const closeAllContextMenus = () => {
  if (contextMenu.value.visible) closeContextMenu()
  if (paperContextMenu.value.visible) closePaperContextMenu()
  if (searchCategoryContextMenu.value.visible) closeSearchCategoryContextMenu()
  if (searchPaperContextMenu.value.visible) closeSearchPaperContextMenu()
  if (fileContextMenu.value.visible) closeFileContextMenu()
}

const contextAddChild = () => {
  addingToParentId.value = contextMenu.value.isBlank ? null : contextMenu.value.categoryId
  addingCategoryName.value = ''
  closeContextMenu()
}

const confirmAddCategory = async () => {
  const name = addingCategoryName.value.trim()
  if (!name) { addingToParentId.value = '__hidden'; return }
  try {
    await api.createCategory({ name, parentId: addingToParentId.value || undefined })
    await refreshLibrary()
  } catch (err) { alert((err as Error).message) }
  addingToParentId.value = '__hidden'
  addingCategoryName.value = ''
}

const contextRename = () => {
  renamingCategoryId.value = contextMenu.value.categoryId
  renamingValue.value = contextMenu.value.categoryName
  closeContextMenu()
}

const confirmRename = async () => {
  const name = renamingValue.value.trim()
  const id = renamingCategoryId.value
  renamingCategoryId.value = null
  if (!name || !id) return
  const original = categories.value.find(c => c.id === id)?.name
  if (name === original) return
  try {
    await api.updateCategory(id, { name })
    await refreshLibrary()
  } catch (err) { alert((err as Error).message) }
}

const contextDelete = async () => {
  const id = contextMenu.value.categoryId
  const name = contextMenu.value.categoryName
  closeContextMenu()
  if (!await showConfirm(`删除分类「${name}」？文献将变为未分类。`, true)) return
  api.deleteCategory(id).then(() => {
    if (selectedCategory.value === id) selectedCategory.value = null
    refreshLibrary()
  }).catch((err) => alert(err.message))
}

const onDocumentClick = () => {
  if (contextMenu.value.visible) closeContextMenu()
  if (paperContextMenu.value.visible) closePaperContextMenu()
  if (searchCategoryContextMenu.value.visible) closeSearchCategoryContextMenu()
  if (searchPaperContextMenu.value.visible) closeSearchPaperContextMenu()
  if (fileContextMenu.value.visible) closeFileContextMenu()
}

const openPaperContextMenu = (e: MouseEvent, paper: any) => {
  if (isSearchCategoryView.value) {
    openSearchPaperContextMenu(e, paper)
    return
  }

  e.preventDefault()
  e.stopPropagation()
  // Estimate max height: 4 items + sub-menu with categories (~6 items)
  const menuH = Math.min(400, window.innerHeight * 0.8)
  const menuW = 220, pad = 8
  let x = e.clientX, y = e.clientY
  if (x + menuW > window.innerWidth - pad) x = window.innerWidth - menuW - pad
  if (y + menuH > window.innerHeight - pad) y = Math.max(pad, window.innerHeight - menuH - pad)
  if (y < pad) y = pad
  paperContextMenu.value = { visible: true, x, y, paperId: paper.id, paperTitle: paper.title }
  paperCategoryPicker.value = false
}
const closePaperContextMenu = () => {
  paperContextMenu.value.visible = false
  paperCategoryPicker.value = false
  subFlyoutCategoryId.value = null
  flyoutHovered.value = false
  if (closePickerTimer) { clearTimeout(closePickerTimer); closePickerTimer = null }
}

const onCategoryPickerHover = (e: MouseEvent) => {
  if (closePickerTimer) { clearTimeout(closePickerTimer); closePickerTimer = null }
  paperCategoryPicker.value = true
  const target = e.currentTarget as HTMLElement
  const rect = target.getBoundingClientRect()
  const flyoutW = 200, flyoutH = Math.min(320, window.innerHeight * 0.7), pad = 8
  let x = rect.right + 4
  let y = rect.top
  if (x + flyoutW > window.innerWidth - pad) x = rect.left - flyoutW - 4
  if (y + flyoutH > window.innerHeight - pad) y = window.innerHeight - flyoutH - pad
  if (y < pad) y = pad
  flyoutPos.value = { x, y }
}

const scheduleClosePicker = () => {
  closePickerTimer = setTimeout(() => {
    if (!flyoutHovered.value) { paperCategoryPicker.value = false; subFlyoutCategoryId.value = null }
  }, 150)
}

const onFlyoutEnter = () => {
  flyoutHovered.value = true
  if (closePickerTimer) { clearTimeout(closePickerTimer); closePickerTimer = null }
}
const onFlyoutLeave = () => {
  flyoutHovered.value = false
  scheduleClosePicker()
}

const onSubCategoryHover = (e: MouseEvent, catId: string) => {
  subFlyoutCategoryId.value = catId
  const target = e.currentTarget as HTMLElement
  const rect = target.getBoundingClientRect()
  const flyoutW = 180, flyoutH = Math.min(260, window.innerHeight * 0.6), pad = 8
  let x = rect.right + 4
  let y = rect.top
  if (x + flyoutW > window.innerWidth - pad) x = rect.left - flyoutW - 4
  if (y + flyoutH > window.innerHeight - pad) y = window.innerHeight - flyoutH - pad
  if (y < pad) y = pad
  subFlyoutPos.value = { x, y }
}

const paperCmiViewDetails = async () => {
  const paperId = paperContextMenu.value.paperId
  const p = paperStore.papers.find(p => p.id === paperContextMenu.value.paperId)
  paperDetails.value = p || null
  closePaperContextMenu()
  showPaperDetailsModal.value = true
  if (!paperId) return
  try {
    const res = await api.getPaper(paperId)
    paperDetails.value = res.paper
  } catch {
    // Keep the list item details visible if the detail request fails.
  }
}

const showPaperDetails = () => {
  paperDetails.value = activePaper.value
  showPaperDetailsModal.value = true
}

const paperCmiAiSummary = async (paper?: any) => {
  const target = paper || paperStore.papers.find(p => p.id === paperContextMenu.value.paperId)
  if (!target) { closePaperContextMenu(); return }
  closePaperContextMenu()
  try {
    await api.summarizePaper(target.id)
    await refreshLibrary()
  } catch (err) {
    alert((err as Error).message)
  }
}

const paperCmiReparse = async () => {
  const id = paperContextMenu.value.paperId
  closePaperContextMenu()
  if (!id) return
  if (!await showConfirm('重新解析会清空现有解析结果并重新生成向量，确认继续？')) return
  try {
    await api.reparsePaper(id)
    await refreshLibrary()
    if (route.params.id === id) await paperStore.fetchPaper(id)
  } catch (err) {
    alert((err as Error).message)
  }
}

const paperCmiDelete = async () => {
  const id = paperContextMenu.value.paperId
  closePaperContextMenu()
  if (!await showConfirm('确认删除此文献？', true)) return
  await paperStore.deletePaper(id)
  readerTabs.value = readerTabs.value.filter((tab) => tab.paper.id !== id)
  if (route.params.id === id) await backToLibrary()
  await refreshLibrary()
}

const assignPaperCategory = async (categoryId: string | null) => {
  const id = paperContextMenu.value.paperId
  closePaperContextMenu()
  await useApi().updatePaper(id, { categoryId })
  await refreshLibrary()
}

const onCategoryListBlankClick = (e: MouseEvent) => {
  // If click landed on an input inside adding/rename row, let it handle naturally
  const target = e.target as HTMLElement
  if (target.tagName === 'INPUT') return
  // If adding or renaming, confirm (which cancels if empty/unchanged)
  if (addingToParentId.value !== '__hidden') confirmAddCategory()
  if (renamingCategoryId.value) confirmRename()
  if (addingSearchCategory.value) confirmAddSearchCategory()
}

const handleDeletePaper = async (e: Event, id: string) => {
  e.stopPropagation()
  if (isSearchCategoryView.value) {
    await handleDeleteSearchPaper(e, id)
    return
  }
  if (!await showConfirm('确认删除此文献？', true)) return
  await paperStore.deletePaper(id)
  readerTabs.value = readerTabs.value.filter((tab) => tab.paper.id !== id)
  if (route.params.id === id) await backToLibrary()
  await refreshLibrary()
}

const handlePaperRowActivate = (paper: any) => {
  if (isSearchCategoryView.value) {
    showSearchPaperPopup(paper)
    return
  }
  void openPaper(paper.id)
}

const openPaperSource = (e: Event, url?: string) => {
  e.stopPropagation()
  if (!url) return
  window.open(url, '_blank', 'noopener')
}

const handleDeleteSearchPaper = async (e: Event, id: string) => {
  e.stopPropagation()
  const categoryId = selectedSearchCategory.value
  if (!categoryId) return
  if (!await showConfirm('确认从搜索收藏中删除此论文？', true)) return
  try {
    await api.removePaperFromSearchCategory(categoryId, id)
    searchCategoryPapers.value = searchCategoryPapers.value.filter((paper) => paper.id !== id)
    selectedPaperIds.value.delete(id)
    await fetchSearchCategories()
  } catch (err) {
    alert((err as Error).message)
  }
}

// Batch operations
const handleBatchDelete = async () => {
  const count = selectedPaperIds.value.size
  if (count === 0) return

  if (isSearchCategoryView.value) {
    const categoryId = selectedSearchCategory.value
    if (!categoryId) return
    if (!await showConfirm(`确认从搜索收藏中删除选中的 ${count} 篇论文？`, true)) return
    const ids = Array.from(selectedPaperIds.value)
    try {
      await Promise.all(ids.map((id) => api.removePaperFromSearchCategory(categoryId, id)))
      searchCategoryPapers.value = searchCategoryPapers.value.filter((paper) => !ids.includes(paper.id))
      clearSelection()
      await fetchSearchCategories()
    } catch (err) {
      console.error('Batch delete search papers failed:', err)
      alert((err as Error).message)
    }
    return
  }

  if (!await showConfirm(`确认删除选中的 ${count} 篇文献？`, true)) return

  const ids = Array.from(selectedPaperIds.value)
  try {
    await api.batchDeletePapers(ids)
    // Remove deleted papers from reader tabs
    readerTabs.value = readerTabs.value.filter((tab) => !ids.includes(tab.paper.id))
    // If current paper is deleted, go back to library
    if (route.params.id && ids.includes(route.params.id as string)) {
      await backToLibrary()
    }
    clearSelection()
    await refreshLibrary()
  } catch (err) {
    console.error('Batch delete failed:', err)
  }
}

const handleBatchMove = async () => {
  const count = selectedPaperIds.value.size
  if (count === 0) return

  // Open move dialog
  moveTargetCategory.value = ''
  showMoveDialog.value = true
}

const handleBatchSummarize = async () => {
  const count = selectedPaperIds.value.size
  if (count === 0 || isSearchCategoryView.value) return
  if (!await showConfirm(`为选中的 ${count} 篇文献生成总结笔记？任务会进入后台队列，并按队列限制调用 LLM。`)) return

  const ids = Array.from(selectedPaperIds.value)
  try {
    const result = await api.batchSummarizePapers(ids)
    clearSelection()
    await refreshLibrary()
    if (result.errors?.length) {
      alert(`已入队 ${result.enqueued} 篇，失败 ${result.errors.length} 篇。`)
    }
  } catch (err) {
    console.error('Batch summarize failed:', err)
    alert((err as Error).message)
  }
}

const confirmBatchMove = async () => {
  const categoryId = moveTargetCategory.value === 'uncategorized' ? null : (moveTargetCategory.value || null)
  const ids = Array.from(selectedPaperIds.value)

  // Check if any paper is already in this category
  const papersToMove = paperStore.papers.filter(p => ids.includes(p.id))
  const allSameCategory = papersToMove.every(p => p.categoryId === categoryId)

  if (allSameCategory && papersToMove.length > 0) {
    // All papers already in target category, do nothing
    showMoveDialog.value = false
    clearSelection()
    return
  }

  try {
    await api.batchMovePapers(ids, categoryId)
    showMoveDialog.value = false
    clearSelection()
    await refreshLibrary()
  } catch (err) {
    console.error('Batch move failed:', err)
  }
}

const createSideNote = async () => {
  const paperId = activePaper.value?.id
  const content = notesDraft.value.trim()
  if (!paperId || !content) return
  await noteStore.createNote({ paperId, content, kind: 'note' })
  notesDraft.value = ''
}

const startEditNote = (e: Event, note: Note) => {
  e.stopPropagation()
  editingNoteId.value = note.id
  editingNoteContent.value = note.content || ''
}

const saveEditNote = async (e?: Event) => {
  e?.stopPropagation()
  if (!editingNoteId.value) return
  await noteStore.updateNote(editingNoteId.value, { content: editingNoteContent.value })
  editingNoteId.value = null
  editingNoteContent.value = ''
}

const cancelEditNote = (e?: Event) => {
  e?.stopPropagation()
  editingNoteId.value = null
  editingNoteContent.value = ''
}

const deleteNote = async (e: Event, id: string) => {
  e.stopPropagation()
  if (!await showConfirm('确认删除这条笔记？', true)) return
  await noteStore.deleteNote(id)
}

// Search related functions
const jumpToPendingSearchPage = async () => {
  const page = pendingSearchPage.value
  if (!page) return

  await nextTick()
  let attempts = 0
  const tryJump = () => {
    const viewer = getActivePdfViewer()
    if (viewer?.goToPage) {
      viewer.goToPage(page)
      pendingSearchPage.value = null
      return
    }
    if (attempts++ < 20) window.setTimeout(tryJump, 120)
  }
  tryJump()
}

const handleSearchSelect = async (paper: any) => {
  if (paper?.source === 'local' && paper.id) {
    pendingSearchPage.value = Number.isFinite(Number(paper.pageNumber)) ? Number(paper.pageNumber) : null
    if (route.params.id !== paper.id) {
      await router.push(`/paper/${paper.id}`)
    }
    await jumpToPendingSearchPage()
    return
  }

  showSearchPaperPopup(paper)
}

const handleSearchSave = (papers: any[]) => {
  papersToSave.value = papers
  showSaveToCategory.value = true
}

const handleSearchImportPdf = (papers: any[]) => {
  papersToImport.value = papers
  showImportToLibrary.value = true
}

const handleImportStarted = (job: any) => {
  showImportToLibrary.value = false
  papersToImport.value = []
  console.info('PDF import job started:', job?.id)
}

const handlePapersSaved = async (count: number) => {
  showSaveToCategory.value = false
  papersToSave.value = []
  await refreshLibrary()
  alert(`成功保存 ${count} 篇论文`)
}

// Search categories functions
const fetchSearchCategories = async () => {
  try {
    const res = await fetch('/api/search-categories/flat')
    const data = await res.json()
    searchCategories.value = data.categories || []
  } catch (err) {
    console.error('Failed to fetch search categories:', err)
  }
}

// Search category inline add
const addingSearchCategory = ref(false)
const addingSearchCategoryName = ref('')

const startAddSearchCategory = () => {
  addingSearchCategory.value = true
  addingSearchCategoryName.value = ''
}

const openSearchCategoryContextMenu = (e: MouseEvent, cat: { id: string; name: string }) => {
  e.preventDefault()
  e.stopPropagation()
  searchCategoryContextMenu.value = { visible: true, x: e.clientX, y: e.clientY, categoryId: cat.id, categoryName: cat.name }
}

const closeSearchCategoryContextMenu = () => {
  searchCategoryContextMenu.value.visible = false
}

const deleteSearchCategoryFromMenu = async () => {
  const id = searchCategoryContextMenu.value.categoryId
  const name = searchCategoryContextMenu.value.categoryName
  closeSearchCategoryContextMenu()
  if (!id) return
  if (!await showConfirm(`删除搜索收藏分类「${name}」？其中收藏的论文也会移除。`, true)) return
  try {
    await api.deleteSearchCategory(id)
    if (selectedSearchCategory.value === id) {
      selectedSearchCategory.value = null
      searchCategoryPapers.value = []
      clearSelection()
    }
    await fetchSearchCategories()
  } catch (err) {
    alert((err as Error).message)
  }
}

const openSearchPaperContextMenu = (e: MouseEvent, paper: any) => {
  e.preventDefault()
  e.stopPropagation()
  const menuH = 132
  const menuW = 180
  const pad = 8
  let x = e.clientX
  let y = e.clientY
  if (x + menuW > window.innerWidth - pad) x = window.innerWidth - menuW - pad
  if (y + menuH > window.innerHeight - pad) y = Math.max(pad, window.innerHeight - menuH - pad)
  searchPaperContextMenu.value = { visible: true, x, y, paperId: paper.id, paperTitle: paper.title }
}

const closeSearchPaperContextMenu = () => {
  searchPaperContextMenu.value.visible = false
}

const searchPaperFromMenu = computed(() =>
  searchCategoryPapers.value.find((paper) => paper.id === searchPaperContextMenu.value.paperId) || null
)

const viewSearchPaperFromMenu = () => {
  const paper = searchPaperFromMenu.value
  closeSearchPaperContextMenu()
  if (paper) showSearchPaperPopup(paper)
}

const openSearchPaperSourceFromMenu = () => {
  const url = searchPaperFromMenu.value?.url
  closeSearchPaperContextMenu()
  if (url) window.open(url, '_blank', 'noopener')
}

const deleteSearchPaperFromMenu = async () => {
  const id = searchPaperContextMenu.value.paperId
  closeSearchPaperContextMenu()
  if (!id) return
  await handleDeleteSearchPaper(new Event('delete'), id)
}

const confirmAddSearchCategory = async () => {
  const name = addingSearchCategoryName.value.trim()
  if (!name) {
    addingSearchCategory.value = false
    return
  }
  
  try {
    await api.createSearchCategory({ name })
    await fetchSearchCategories()
  } catch (err) {
    console.error('Failed to add search category:', err)
    alert('添加分类失败')
  }
  addingSearchCategory.value = false
  addingSearchCategoryName.value = ''
}

const selectSearchCategory = async (id: string) => {
  selectedSearchCategory.value = id
  selectedCategory.value = null
  clearSelection()
  loadingSearchPapers.value = true
  searchCategoryPapers.value = []

  try {
    const res = await api.getSearchCategoryPapers(id)
    searchCategoryPapers.value = res.papers || []
  } catch (err) {
    console.error('Failed to load search category papers:', err)
    searchCategoryPapers.value = []
  } finally {
    loadingSearchPapers.value = false
  }
}

const showSearchPaperPopup = (paper: any) => {
  selectedSearchPaper.value = paper
  showSearchPaperDetail.value = true
}
</script>

<template>
  <div class="app-layout">
    <!-- ── Header ─────────────────────────────────────────────────────────── -->
    <header class="app-header">
      <div class="header-left">
        <button class="icon-btn" @click="isMobile ? (mobileSidebar = !mobileSidebar) : (sidebarOpen = !sidebarOpen)">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 12h18M3 6h18M3 18h18"/></svg>
        </button>
        <span class="brand">YARC</span>
        <div v-if="readerTabs.length || workspaceSwitcherItems.length" ref="tabsMenuRef" class="tabs-menu" :class="{ reading: hasPaper }">
          <button class="tabs-menu-trigger" :class="{ open: tabsMenuOpen }" @click="tabsMenuOpen = !tabsMenuOpen" title="切换工作项">
            <svg class="tabs-menu-doc" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            <span class="tabs-menu-label" :title="workSwitcherTitle">{{ workSwitcherLabel }}</span>
            <svg class="tabs-menu-caret" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
          </button>
          <Transition name="dropdown">
            <div v-if="tabsMenuOpen" class="tabs-menu-dropdown" role="listbox" aria-label="工作项切换">
              <template v-if="readerTabs.length">
                <div class="tabs-menu-section">已打开论文</div>
                <button
                  v-for="tab in readerTabs"
                  :key="tab.paper.id"
                  type="button"
                  class="tabs-menu-item"
                  :class="{ active: tab.paper.id === activePaperId }"
                  role="option"
                  :aria-selected="tab.paper.id === activePaperId"
                  @click="switchReaderTab(tab.paper.id); tabsMenuOpen = false"
                >
                  <span v-if="tab.paper.id === activePaperId" class="tabs-menu-dot" />
                  <span class="tabs-menu-item-title" :title="tab.paper.title">{{ tab.paper.title }}</span>
                  <span class="tabs-menu-item-close" title="关闭" @click.stop="closeReaderTab($event, tab.paper.id)">×</span>
                </button>
              </template>
              <template v-if="workspaceSwitcherItems.length">
                <div class="tabs-menu-section" :class="{ separated: readerTabs.length }">文件</div>
                <button
                  v-for="file in workspaceSwitcherItems"
                  :key="file.path"
                  type="button"
                  class="tabs-menu-item"
                  :class="{ active: !hasPaper && sidebarMode === 'files' && file.path === selectedWorkspacePath }"
                  role="option"
                  :aria-selected="!hasPaper && sidebarMode === 'files' && file.path === selectedWorkspacePath"
                  @click="switchWorkspaceTab(file.path)"
                >
                  <span v-if="!hasPaper && sidebarMode === 'files' && file.path === selectedWorkspacePath" class="tabs-menu-dot" />
                  <span class="tabs-menu-file-icon">{{ file.type === 'directory' ? '📂' : '📄' }}</span>
                  <span class="tabs-menu-item-title" :title="file.path">{{ file.name }}</span>
                  <span v-if="file.path === selectedWorkspacePath && workspaceDirty" class="tabs-menu-dirty" title="有未保存修改" />
                  <span class="tabs-menu-item-close" title="关闭文件" @click.stop="closeWorkspaceTab($event, file.path)">×</span>
                </button>
              </template>
            </div>
          </Transition>
        </div>
      </div>

      <div class="header-center">
        <TopSearchBar
          @select="handleSearchSelect"
          @save="handleSearchSave"
          @importPdf="handleSearchImportPdf"
        />
      </div>

      <div class="header-right">
        <button v-if="hasPaper" class="icon-btn" @click="backToLibrary" title="返回文献列表">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/></svg>
        </button>
        <button class="icon-btn" @click="openUpload" title="上传 PDF">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
        </button>
        <button class="icon-btn" @click="theme.toggleMode()" :title="theme.mode === 'light' ? '暗色模式' : '浅色模式'">
          <svg v-if="theme.mode === 'light'" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>
          <svg v-else width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
        </button>
        <button class="icon-btn chat-toggle" :class="{ active: chatOpen }" @click="isMobile ? (mobileChat = !mobileChat) : (chatOpen = !chatOpen)" title="AI 对话">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>
        </button>
      </div>
    </header>

    <!-- ── Body ────────────────────────────────────────────────────────────── -->
    <div class="app-body">
      <div v-if="isMobile && mobileSidebar" class="mobile-overlay" @click="mobileSidebar = false" />

      <!-- Left side: category page or notes page -->
      <aside
        v-show="isMobile ? mobileSidebar : true"
        class="app-sidebar"
        :class="{ 'mobile-drawer': isMobile, closed: !isMobile && !sidebarOpen }"
        :style="!isMobile ? { width: sidebarPanelWidth + 'px', minWidth: sidebarPanelWidth + 'px' } : {}"
      >
        <section v-if="!hasPaper" class="side-panel category-panel">
          <div class="side-header">
            <h2>{{ sidebarMode === 'library' ? '文献库' : sidebarMode === 'files' ? '文件' : '设置' }}</h2>
            <button v-if="sidebarMode === 'files'" class="side-mini-btn" :disabled="filesLoading" @click="loadWorkspaceFiles()">刷新</button>
          </div>

          <Transition name="panel" mode="out-in">
          <div v-if="sidebarMode === 'library'" key="m-library" class="category-list" @contextmenu="openContextMenu($event)" @click="onCategoryListBlankClick">
            <div class="section-divider">
              <span class="divider-text">文献库</span>
              <button class="add-search-cat-btn" @click.stop="addingToParentId = null" title="新建分类">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                  <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </button>
            </div>

            <button class="category-item" :class="{ active: !selectedCategory }" @click="selectCategory(null)" @contextmenu="openContextMenu($event)">
              <span class="cat-spacer" />
              <span class="cat-name">全部</span>
              <span class="cat-count">{{ paperStore.total || paperStore.papers.length }}</span>
            </button>

            <!-- Inline add input for top-level -->
            <div v-if="addingToParentId === null && !contextMenu.visible" class="category-item adding-row">
              <span class="cat-spacer" />
              <input
                v-model="addingCategoryName"
                class="cat-rename-input"
                placeholder="分类名称…"
                @keydown.enter="confirmAddCategory"
                @keydown.escape="addingToParentId = '__hidden'"
                @blur="confirmAddCategory"
                autofocus
              />
            </div>
            <template v-for="cat in treeCategories" :key="cat.id">
              <div class="category-node">
                <div
                  class="category-item"
                  :class="{ active: selectedCategory === cat.id }"
                  @click="cat.children.length ? toggleCategoryExpand(cat.id) : selectCategory(cat.id)"
                  @contextmenu="openContextMenu($event, cat)"
                >
                  <span v-if="cat.children.length" class="cat-toggle">
                    {{ expandedCategories[cat.id] ? '▾' : '▸' }}
                  </span>
                  <span v-else class="cat-spacer" />
                  <template v-if="renamingCategoryId === cat.id">
                    <input
                      v-model="renamingValue"
                      class="cat-rename-input"
                      @keydown.enter="confirmRename"
                      @keydown.escape="renamingCategoryId = null"
                      @blur="confirmRename"
                      @click.stop
                      autofocus
                    />
                  </template>
                  <template v-else>
                    <span class="cat-name" @click.stop="selectCategory(cat.id)">{{ cat.name }}</span>
                    <span class="cat-count">{{ cat.children.length ? categoryDescendantIds(cat.id).reduce((s, id) => s + (categories.find(c => c.id === id)?._count?.papers || 0), 0) : cat.paperCount }}</span>
                  </template>
                </div>
                <!-- Inline add input for child -->
                <div v-if="addingToParentId === cat.id" class="category-children">
                  <div class="category-item child adding-row">
                    <span class="cat-spacer" />
                    <input
                      v-model="addingCategoryName"
                      class="cat-rename-input"
                      placeholder="子分类名称…"
                      @keydown.enter="confirmAddCategory"
                      @keydown.escape="addingToParentId = '__hidden'"
                      @blur="confirmAddCategory"
                      autofocus
                    />
                  </div>
                </div>
                <div v-if="cat.children.length && expandedCategories[cat.id]" class="category-children">
                  <div
                    v-for="child in cat.children"
                    :key="child.id"
                    class="category-item child"
                    :class="{ active: selectedCategory === child.id }"
                    @click="selectCategory(child.id)"
                    @contextmenu="openContextMenu($event, child)"
                  >
                    <span class="cat-spacer" />
                    <template v-if="renamingCategoryId === child.id">
                      <input
                        v-model="renamingValue"
                        class="cat-rename-input"
                        @keydown.enter="confirmRename"
                        @keydown.escape="renamingCategoryId = null"
                        @blur="confirmRename"
                        @click.stop
                        autofocus
                      />
                    </template>
                    <template v-else>
                      <span class="cat-name">{{ child.name }}</span>
                      <span class="cat-count">{{ child.paperCount }}</span>
                    </template>
                  </div>
                </div>
              </div>
            </template>
            <button
              v-if="uncategorizedCount"
              class="category-item"
              :class="{ active: selectedCategory === '__uncategorized' }"
              @click="selectCategory('__uncategorized')"
            >
              <span class="cat-spacer" />
              <span class="cat-name">未分类</span>
              <span class="cat-count">{{ uncategorizedCount }}</span>
            </button>
            
            <!-- Search Categories Section -->
            <div class="search-categories-section">
              <div class="section-divider">
                <span class="divider-text">搜索收藏</span>
                <button class="add-search-cat-btn" @click.stop="startAddSearchCategory" title="添加搜索分类">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                </button>
              </div>
              
              <!-- Inline add input for search category -->
              <div v-if="addingSearchCategory" class="category-item adding-row">
                <span class="cat-spacer" />
                <input
                  v-model="addingSearchCategoryName"
                  class="cat-rename-input"
                  placeholder="分类名称…"
                  @keydown.enter="confirmAddSearchCategory"
                  @keydown.escape="addingSearchCategory = false"
                  @blur="confirmAddSearchCategory"
                  autofocus
                />
              </div>
              
              <div v-for="cat in searchCategories" :key="cat.id" class="search-category-item">
                <div
                  class="category-item"
                  :class="{ active: selectedSearchCategory === cat.id }"
                  @click="selectSearchCategory(cat.id)"
                  @contextmenu="openSearchCategoryContextMenu($event, cat)"
                >
                  <span class="cat-spacer" />
                  <span class="cat-name">{{ cat.name }}</span>
                  <span class="cat-count">{{ cat.papers?.length || 0 }}</span>
                </div>
              </div>
            </div>
          </div>

          <div
            v-else-if="sidebarMode === 'files'"
            key="m-files"
            class="category-list files-inline-list"
            :class="{ 'root-drop-target': workspaceRootDropActive }"
            @contextmenu.prevent="openFileContextMenu($event, null)"
            @dragover="handleWorkspaceRootDragOver"
            @dragleave="handleWorkspaceRootDragLeave"
            @drop="handleWorkspaceRootDrop"
          >
            <div class="section-divider">
              <span class="divider-text">data/</span>
              <button class="add-search-cat-btn" :disabled="workspaceUploading" @click.stop="openWorkspaceUploadPicker('')" title="上传文件">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
              </button>
            </div>
            <input ref="workspaceUploadInput" class="visually-hidden-input" type="file" multiple @change="handleWorkspaceUploadInput" />
            <div v-if="workspaceUploading" class="side-empty">正在上传文件…</div>
            <div v-else-if="filesLoading" class="side-empty">正在加载文件…</div>
            <div v-else-if="filesError" class="side-empty error-text">{{ filesError }}</div>
            <div v-else-if="!workspaceFiles.length" class="side-empty">暂无文件</div>
            <FileTree
              ref="fileTreeRef"
              :nodes="workspaceFiles"
              :selected-path="selectedWorkspacePath"
              :creating-parent-path="creatingParentPath"
              :creating-type="creatingType"
              @select="selectWorkspaceFile"
              @context-menu="openFileContextMenu"
              @rename="handleTreeRename"
              @create="handleCreate"
              @cancel-create="cancelCreate"
              @move="moveWorkspaceNode"
              @upload="(targetDirPath, files) => uploadWorkspaceFiles(files, targetDirPath)"
            />
          </div>

          <div v-else key="m-settings" class="category-list settings-inline-list">
            <button
              v-for="section in settingsSections"
              :key="section.id"
              class="category-item"
              :class="{ active: settingsSection === section.id }"
              @click="settingsSection = section.id"
            >
              <span class="cat-spacer" />
              <span class="cat-name">{{ section.label }}</span>
            </button>
          </div>
          </Transition>

          <!-- Context menu -->
          <Teleport to="body">
            <div
              v-if="contextMenu.visible"
              class="cat-context-menu"
              :style="{ left: contextMenu.x + 'px', top: contextMenu.y + 'px' }"
              @click.stop
            >
              <button v-if="!contextMenu.isChild" class="ctx-item" @click="contextAddChild">📂 {{ contextMenu.isBlank ? '添加分类' : '添加子分类' }}</button>
              <template v-if="!contextMenu.isBlank">
                <button class="ctx-item" @click="contextRename">✏️ 重命名</button>
                <div class="ctx-sep" />
                <button class="ctx-item danger" @click="contextDelete">🗑️ 删除</button>
              </template>
            </div>
          </Teleport>

          <!-- Search category context menu -->
          <Teleport to="body">
            <div
              v-if="searchCategoryContextMenu.visible"
              class="cat-context-menu"
              :style="{ left: searchCategoryContextMenu.x + 'px', top: searchCategoryContextMenu.y + 'px' }"
              @click.stop
            >
              <button class="ctx-item danger" @click="deleteSearchCategoryFromMenu">🗑️ 删除搜索分类</button>
            </div>
          </Teleport>

          <!-- Paper context menu -->
          <Teleport to="body">
            <div
              v-if="paperContextMenu.visible"
              class="cat-context-menu paper-ctx"
              :style="{ left: paperContextMenu.x + 'px', top: paperContextMenu.y + 'px' }"
              @click.stop
              @mouseleave="scheduleClosePicker"
            >
              <button class="ctx-item" @click="paperCmiViewDetails">📄 查看详细信息</button>
              <button class="ctx-item" @click="paperCmiAiSummary()">🤖 生成总结笔记</button>
              <button class="ctx-item" @click="paperCmiReparse">↻ 重新解析</button>
              <button
                class="ctx-item has-sub"
                @mouseenter="onCategoryPickerHover($event)"
                @click="onCategoryPickerHover($event)"
              >📂 加入分类 ▸</button>
              <div class="ctx-sep" />
              <button class="ctx-item danger" @click="paperCmiDelete">🗑️ 删除</button>
            </div>

            <!-- Category flyout -->
            <div
              v-if="paperCategoryPicker"
              class="cat-context-menu ctx-flyout"
              :style="{ left: flyoutPos.x + 'px', top: flyoutPos.y + 'px' }"
              @click.stop
              @mouseenter="onFlyoutEnter"
              @mouseleave="onFlyoutLeave"
            >
              <button class="ctx-item" @click="assignPaperCategory(null)">⊘ 移除分类</button>
              <template v-for="cat in treeCategories" :key="cat.id">
                <button
                  class="ctx-item"
                  :class="{ 'has-sub': cat.children.length }"
                  @mouseenter="cat.children.length ? onSubCategoryHover($event, cat.id) : (subFlyoutCategoryId = null)"
                  @click="assignPaperCategory(cat.id)"
                >{{ cat.name }}{{ cat.children.length ? ' ▸' : '' }}</button>
              </template>
            </div>

            <!-- Subcategory flyout -->
            <div
              v-if="subFlyoutCategoryId"
              class="cat-context-menu ctx-flyout"
              :style="{ left: subFlyoutPos.x + 'px', top: subFlyoutPos.y + 'px' }"
              @click.stop
              @mouseenter="onFlyoutEnter"
              @mouseleave="onFlyoutLeave"
            >
              <button
                v-for="child in (treeCategories.find(c => c.id === subFlyoutCategoryId)?.children || [])"
                :key="child.id"
                class="ctx-item"
                @click="assignPaperCategory(child.id)"
              >└ {{ child.name }}</button>
            </div>
          </Teleport>

          <!-- Search paper context menu -->
          <Teleport to="body">
            <div
              v-if="searchPaperContextMenu.visible"
              class="cat-context-menu paper-ctx"
              :style="{ left: searchPaperContextMenu.x + 'px', top: searchPaperContextMenu.y + 'px' }"
              @click.stop
            >
              <button class="ctx-item" @click="viewSearchPaperFromMenu">📄 查看详细信息</button>
              <button class="ctx-item" :disabled="!searchPaperFromMenu?.url" @click="openSearchPaperSourceFromMenu">↗ 前往原文</button>
              <div class="ctx-sep" />
              <button class="ctx-item danger" @click="deleteSearchPaperFromMenu">🗑️ 从收藏中删除</button>
            </div>
          </Teleport>

          <!-- File context menu -->
          <Teleport to="body">
            <div
              v-if="fileContextMenu.visible"
              class="cat-context-menu"
              :style="{ left: fileContextMenu.x + 'px', top: fileContextMenu.y + 'px' }"
              @click.stop
              @contextmenu.prevent
            >
              <button class="ctx-item" :disabled="!canCreateInFileContext()" @click="fileCtxNewFolder">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg>
                新建文件夹
              </button>
              <button class="ctx-item" :disabled="!canCreateInFileContext()" @click="fileCtxNewFile">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg>
                新建文件
              </button>
              <button class="ctx-item" :disabled="!canCreateInFileContext() || workspaceUploading" @click="fileCtxUpload">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                上传文件
              </button>
              <template v-if="fileContextMenu.node">
                <div class="ctx-sep" />
                <button class="ctx-item" :disabled="fileContextMenu.node.readonly" @click="fileCtxRename">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                  重命名
                </button>
                <button v-if="fileContextMenu.node.type === 'file'" class="ctx-item" @click="fileCtxDownload">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                  下载
                </button>
                <div class="ctx-sep" />
                <button class="ctx-item danger" :disabled="fileContextMenu.node.readonly" @click="fileCtxDelete">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
                  删除
                </button>
              </template>
            </div>
          </Teleport>

          <div class="side-bottom">
            <button v-if="sidebarMode !== 'library'" class="settings-link" @click="setSidebarMode('library')">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
              <span>文献库</span>
            </button>
            <button v-if="sidebarMode !== 'files'" class="settings-link" @click="setSidebarMode('files')">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
              </svg>
              <span>文件</span>
            </button>
            <button v-if="sidebarMode !== 'settings'" class="settings-link" @click="setSidebarMode('settings')">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
              <span>设置</span>
            </button>
          </div>
        </section>

        <section v-else class="side-panel notes-panel">
          <div class="side-header notes-side-header">
            <h2>笔记</h2>
            <div class="note-count">{{ sortedNotes.length }} 条</div>
          </div>

          <div class="note-paper-title">{{ activePaper?.title }}</div>

          <div class="notes-list">
            <div v-if="noteStore.loading" class="side-empty">正在加载笔记…</div>
            <div
              v-for="note in sortedNotes"
              :key="note.id"
              role="button"
              tabindex="0"
              class="note-card"
              @click="onNoteClick(note)"
              @keydown.enter.prevent="onNoteClick(note)"
              @keydown.space.prevent="onNoteClick(note)"
            >
              <template v-if="editingNoteId !== note.id">
                <div class="note-head">
                  <span class="note-tag">{{ note.kind === 'highlight' ? '高亮' : note.kind === 'summary' ? '总结' : '笔记' }}{{ note.pageNumber ? ` · 第${note.pageNumber}页` : '' }}</span>
                  <span class="note-actions">
                    <button @click="startEditNote($event, note)">编辑</button>
                    <button class="danger" @click="deleteNote($event, note.id)">删除</button>
                  </span>
                </div>
                <blockquote v-if="note.highlightText" class="note-quote">{{ note.highlightText }}</blockquote>
                <MarkdownContent class="note-content" :content="note.content || (note.kind === 'highlight' ? '高亮' : '')" />
              </template>
              <template v-else>
                <textarea v-model="editingNoteContent" class="note-edit" rows="12" @click.stop @keydown.enter.stop />
                <div class="note-edit-actions">
                  <button class="save-note-btn" @click="saveEditNote($event)">保存</button>
                  <button class="cancel-note-btn" @click="cancelEditNote($event)">取消</button>
                </div>
              </template>
            </div>
            <div v-if="!noteStore.loading && !sortedNotes.length" class="side-empty">这篇文献还没有笔记</div>
          </div>

          <div class="note-input">
            <textarea v-model="notesDraft" rows="3" placeholder="给这篇文献添加笔记…" />
            <button :disabled="!notesDraft.trim()" @click="createSideNote">保存笔记</button>
          </div>
        </section>
      </aside>

      <div v-if="!isMobile && sidebarOpen" class="resizer side-resizer" :class="{ active: resizing === 'left' }" @mousedown="startResize('left', $event)" />

      <!-- Center: paper list page or PDF page -->
      <main class="app-main">
        <PdfViewer
          v-for="tab in readerTabs"
          :key="tab.paper.id"
          :ref="(viewer) => setPdfViewer(tab.paper.id, viewer)"
          v-show="hasPaper && tab.paper.id === activePaperId"
          :paper="tab.paper"
          @back="backToLibrary"
          @show-details="showPaperDetails"
        />

        <section v-show="!hasPaper && sidebarMode === 'library'" class="paper-library">
          <div class="library-header" :class="{ condensed: libraryScrolled }">
            <div class="library-header-titles">
              <h1>{{ currentCategoryLabel }}</h1>
              <p>{{ filteredPapers.length }} / {{ isSearchCategoryView ? searchCategoryPapers.length : paperStore.papers.length }} 篇文献</p>
            </div>
            <div class="header-actions">
              <div class="ranking-filters" aria-label="排名筛选">
                <select v-model="ccfFilter" class="ranking-filter" title="按 CCF 排名筛选">
                  <option value="all">全部 CCF</option>
                  <option value="CCF-A">CCF-A</option>
                  <option value="CCF-B">CCF-B</option>
                  <option value="CCF-C">CCF-C</option>
                  <option value="none">无 CCF</option>
                </select>
                <select v-model="sciFilter" class="ranking-filter" title="按 SCI 分区筛选">
                  <option value="all">全部 SCI</option>
                  <option value="Q1">Q1</option>
                  <option value="Q2">Q2</option>
                  <option value="Q3">Q3</option>
                  <option value="Q4">Q4</option>
                  <option value="none">无 SCI</option>
                </select>
              </div>
              <SortControl v-model="sortBy" :options="sortOptions" />
              <button class="primary-btn" @click="openUpload">上传 PDF</button>
              <button class="secondary-btn" @click="toggleSelectionMode">
                {{ selectionMode ? '取消选择' : '批量操作' }}
              </button>
            </div>
          </div>

          <!-- Batch operations toolbar -->
          <div v-if="selectionMode" class="batch-toolbar">
            <div class="batch-info">
              <label class="batch-checkbox">
                <input
                  type="checkbox"
                  :checked="isAllSelected"
                  @change="isAllSelected ? clearSelection() : selectAllPapers()"
                />
                <span>已选中 {{ selectedPaperIds.size }} 篇</span>
              </label>
            </div>
            <div class="batch-actions">
              <button
                v-if="!isSearchCategoryView"
                class="batch-btn"
                :disabled="selectedPaperIds.size === 0"
                @click="handleBatchMove"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                </svg>
                移动到分类
              </button>
              <button
                v-if="!isSearchCategoryView"
                class="batch-btn"
                :disabled="selectedPaperIds.size === 0"
                @click="handleBatchSummarize"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M12 2L9 9 2 12l7 3 3 7 3-7 7-3-7-3z" />
                </svg>
                生成总结
              </button>
              <button
                class="batch-btn danger"
                :disabled="selectedPaperIds.size === 0"
                @click="handleBatchDelete"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="3 6 5 6 21 6"/>
                  <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
                </svg>
                删除
              </button>
            </div>
          </div>

          <div class="paper-table" @scroll="onLibraryScroll">
            <div
              v-for="paper in filteredPapers"
              :key="paper.id"
              role="button"
              tabindex="0"
              class="paper-row"
              :class="{ selected: selectedPaperIds.has(paper.id) }"
              @click="selectionMode ? togglePaperSelection(paper.id) : handlePaperRowActivate(paper)"
              @contextmenu="openPaperContextMenu($event, paper)"
              @keydown.enter.prevent="selectionMode ? togglePaperSelection(paper.id) : handlePaperRowActivate(paper)"
              @keydown.space.prevent="selectionMode ? togglePaperSelection(paper.id) : handlePaperRowActivate(paper)"
            >
              <div v-if="selectionMode" class="paper-checkbox">
                <input
                  type="checkbox"
                  :checked="selectedPaperIds.has(paper.id)"
                  @click.stop
                  @change="togglePaperSelection(paper.id)"
                />
              </div>
              <div class="paper-row-main">
                <h3>{{ paper.title }}</h3>
                <p class="paper-authors">{{ paper.authors.slice(0, 1).join(', ') || '未知作者' }}{{ paper.year ? ` · ${paper.year}` : '' }}</p>
                <div class="paper-meta">
                  <span v-if="paper.journal || paper.venue" class="paper-venue">{{ paper.journal || paper.venue }}</span>
                  <JournalRankingBadge :journal-name="paper.journal" :venue-name="paper.venue" />
                  <span v-if="paper.createdAt" class="paper-date">添加于 {{ new Date(paper.createdAt).toLocaleDateString() }}</span>
                </div>
                <div v-if="paper.tags?.length" class="paper-tags">
                  <span v-for="tag in paper.tags.slice(0, 3)" :key="tag" class="paper-tag">{{ tag }}</span>
                  <span v-if="paper.tags.length > 3" class="paper-tag more">+{{ paper.tags.length - 3 }}</span>
                </div>
                <div v-if="paper.abstract" class="paper-abstract-wrap">
                  <p class="paper-abstract" :class="{ expanded: isAbstractExpanded(paper.id) }">{{ cleanAbstract(paper.abstract) }}</p>
                  <button class="abstract-toggle" @click="toggleAbstract($event, paper.id)">{{ isAbstractExpanded(paper.id) ? '收起' : '展开' }}</button>
                </div>
              </div>
              <div class="paper-row-side">
                <span v-if="!selectedCategory && !isSearchCategoryView" class="category-pill">{{ paper.categoryId ? (categoryNameById.get(paper.categoryId) || '分类') : '未分类' }}</span>
                <span v-if="isSearchCategoryView && paper.savedAt" class="category-pill">收藏于 {{ new Date(paper.savedAt).toLocaleDateString() }}</span>
                <div class="paper-actions">
                  <template v-if="isSearchCategoryView">
                    <button class="paper-action-btn" @click.stop="showSearchPaperPopup(paper)" title="查看详细信息">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
                    </button>
                    <button v-if="paper.url" class="paper-action-btn" @click="openPaperSource($event, paper.url)" title="前往原文">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                    </button>
                    <button class="paper-action-btn danger" @click="handleDeleteSearchPaper($event, paper.id)" title="从收藏中删除">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
                    </button>
                  </template>
                  <template v-else>
                    <button class="paper-action-btn" @click.stop="paperCmiAiSummary(paper)" title="生成总结笔记">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L9 9 2 12l7 3 3 7 3-7 7-3-7-3z"/></svg>
                    </button>
                    <button class="paper-action-btn danger" @click="handleDeletePaper($event, paper.id)" title="删除">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
                    </button>
                  </template>
                </div>
              </div>
            </div>

            <div v-if="isSearchCategoryView && loadingSearchPapers" class="library-empty">正在加载搜索收藏…</div>
            <div v-else-if="!isSearchCategoryView && paperStore.loading" class="library-empty">正在加载文献…</div>
            <div v-else-if="!filteredPapers.length" class="library-empty">
              {{ query ? '没有匹配的文献' : (isSearchCategoryView ? '当前搜索收藏暂无论文' : '当前分类暂无文献') }}
            </div>
          </div>
        </section>

        <section v-show="!hasPaper && sidebarMode === 'files'" class="paper-library workspace-panel">
          <div v-if="filesError" class="workspace-error">{{ filesError }}</div>

          <div v-if="!selectedWorkspaceFile" class="workspace-empty">
            <div class="empty-icon">📁</div>
            <h2>选择一个文件开始查看或编辑</h2>
            <p>左侧显示 data 工作区文件；papers/ 为受保护目录。</p>
          </div>

          <section v-else class="workspace-editor-shell">
            <div class="workspace-editor-head">
              <div class="workspace-file-summary">
                <h2>{{ selectedWorkspaceFile.name }}</h2>
                <p>{{ selectedWorkspaceFile.path || 'data/' }}</p>
              </div>
              <div class="workspace-file-meta">
                <span v-if="selectedWorkspaceFile.readonly" class="readonly-pill">受保护</span>
                <span v-if="selectedWorkspaceFile.type === 'file'">{{ formatWorkspaceSize(selectedWorkspaceFile.size) }}</span>
                <span v-if="selectedWorkspaceFile.type === 'file'">{{ workspaceLanguage }}</span>
                <template v-if="selectedWorkspaceFile.type === 'file' && selectedWorkspaceFile.editable && !workspaceContentLoading">
                  <div v-if="workspaceIsMarkdown" class="md-view-toggle">
                    <button :class="{ active: !markdownPreview }" @click="markdownPreview = false">编辑</button>
                    <button :class="{ active: markdownPreview }" @click="markdownPreview = true">预览</button>
                  </div>
                  <span
                    :class="['dirty-dot', { active: workspaceDirty, conflict: currentLiveClient?.conflict.value }]"
                    :title="currentLiveClient?.conflict.value ? '有外部修改冲突' : currentLiveClient?.saving.value ? '同步保存中' : workspaceDirty ? '等待同步' : '已同步'"
                  />
                  <button class="save-workspace-btn" :disabled="(!workspaceDirty && !currentLiveClient) || !workspaceCanEdit || workspaceSaving" title="立即保存（Ctrl/⌘+S）" @click="saveWorkspaceFile">
                    {{ workspaceSaving || currentLiveClient?.saving.value ? '保存中…' : currentLiveClient?.conflict.value ? '有冲突' : currentLiveClient ? '立即保存' : '保存' }}
                  </button>
                </template>
                <button
                  v-if="selectedWorkspaceFile.type === 'file' && !workspaceCanEdit"
                  class="open-system-btn"
                  :disabled="workspaceOpeningSystem"
                  @click="openWorkspaceFileWithSystemApp(selectedWorkspaceFile)"
                >
                  {{ workspaceOpeningSystem ? '打开中…' : '系统打开' }}
                </button>
              </div>
            </div>

            <div v-if="selectedWorkspaceFile.type === 'directory'" class="workspace-empty compact">
              <div class="empty-icon">📂</div>
              <h2>{{ selectedWorkspaceFile.name }}</h2>
              <p>当前目录：{{ selectedWorkspaceFile.path || 'data/' }}</p>
            </div>

            <div v-else-if="workspaceContentLoading" class="workspace-empty compact">正在读取文件…</div>

            <div v-else-if="selectedWorkspaceFile.editable" class="workspace-text-editor-wrap">
              <MarkdownContent
                v-show="workspaceIsMarkdown && markdownPreview"
                class="workspace-md-preview"
                :style="{ fontSize: `${theme.editor.markdownFontSize}px` }"
                :content="workspaceContent"
              />
              <div v-if="currentLiveClient?.conflict.value" class="workspace-live-conflict">
                文件在磁盘被外部程序修改，无法安全自动合并。
                <button @click="resolveCurrentLiveConflict('use-live')">保留编辑器版本</button>
                <button @click="resolveCurrentLiveConflict('use-disk')">使用磁盘版本</button>
              </div>
              <CodeEditor
                :key="selectedWorkspacePath"
                v-show="!(workspaceIsMarkdown && markdownPreview)"
                v-model="workspaceContent"
                :language="workspaceLanguage"
                :readonly="!workspaceCanEdit"
                :font-size="theme.editor.fontSize"
                :tab-size="theme.editor.tabSize"
                :line-wrap="theme.editor.lineWrap"
                :line-numbers="theme.editor.lineNumbers"
                :collab-y-text="currentLiveClient?.ytext || null"
                class="workspace-code-editor"
                @save="saveWorkspaceFile"
              />
            </div>

            <div v-else-if="workspaceIsImage" class="workspace-preview-panel">
              <img :src="api.getFileImageUrl(selectedWorkspaceFile.path)" :alt="selectedWorkspaceFile.name" />
            </div>

            <div v-else-if="workspaceIsOffice" class="workspace-office-preview-wrap">
              <OfficePreview :path="selectedWorkspaceFile.path" :name="selectedWorkspaceFile.name" />
            </div>

            <div v-else-if="workspaceIsLegacyOffice" class="workspace-empty compact">
              <div class="empty-icon">📝</div>
              <h2>暂不支持预览旧版 Office 格式</h2>
              <p>.doc / .xls / .ppt 是旧版二进制 Office 格式，当前 officecli 预览仅支持 .docx / .xlsx / .pptx。请先转换为新版格式后再预览。</p>
              <button v-if="selectedWorkspaceFile.type === 'file'" class="primary-btn" @click="downloadWorkspaceFile(selectedWorkspaceFile)">下载文件</button>
            </div>

            <div v-else class="workspace-empty compact">
              <div class="empty-icon">{{ workspaceIsPdf ? '📕' : '📄' }}</div>
              <h2>此文件不能直接编辑</h2>
              <p>支持直接编辑常见文本文件。二进制文件、PDF 和超过大小限制的文件请下载后处理。</p>
              <button v-if="selectedWorkspaceFile.type === 'file'" class="primary-btn" @click="downloadWorkspaceFile(selectedWorkspaceFile)">下载文件</button>
            </div>
          </section>
        </section>

        <section v-show="!hasPaper && sidebarMode === 'settings'" class="paper-library workspace-panel settings-workspace-panel">
          <div class="library-header">
            <div>
              <h1>设置</h1>
              <p>{{ settingsSections.find(section => section.id === settingsSection)?.label }}</p>
            </div>
          </div>
          <SettingsContent :active-tab="settingsSection" />
        </section>
      </main>

      <div v-if="!isMobile && chatOpen" class="resizer side-resizer" :class="{ active: resizing === 'right' }" @mousedown="startResize('right', $event)" />

      <div v-if="isMobile && mobileChat" class="mobile-overlay" @click="mobileChat = false" />

      <aside
        v-show="isMobile ? mobileChat : true"
        class="app-chat"
        :class="{ 'mobile-drawer': isMobile, 'bg-active': !!theme.backgroundImage, closed: !isMobile && !chatOpen }"
        :style="!isMobile ? { width: chatPanelWidth + 'px', minWidth: chatPanelWidth + 'px' } : {}"
      >
        <ChatPanel @close="isMobile ? (mobileChat = false) : (chatOpen = false)" />
      </aside>
    </div>

    <UploadDialog v-if="showUpload" :categoryId="uploadCategoryId" @close="showUpload = false; refreshLibrary()" />
    <SaveToCategoryDialog
      v-model="showSaveToCategory"
      :papers="papersToSave"
      @saved="handlePapersSaved"
    />
    <ImportToLibraryDialog
      v-model="showImportToLibrary"
      :papers="papersToImport"
      @started="handleImportStarted"
    />
    
    <!-- Search Paper Detail Popup -->
    <Modal
      v-model="showSearchPaperDetail"
      title="论文详情"
      maxWidth="600px"
    >
      <template v-if="selectedSearchPaper">
        <div class="paper-detail-content">
          <h4 class="detail-title">{{ selectedSearchPaper.title }}</h4>
          
          <div class="detail-grid">
            <div class="detail-row">
              <span class="detail-label">作者</span>
              <span>{{ selectedSearchPaper.authors?.join(', ') || '未知' }}</span>
            </div>
            <div v-if="selectedSearchPaper.year" class="detail-row">
              <span class="detail-label">年份</span>
              <span>{{ selectedSearchPaper.year }}</span>
            </div>
            <div v-if="selectedSearchPaper.journal || selectedSearchPaper.venue" class="detail-row">
              <span class="detail-label">期刊/会议</span>
              <span>{{ selectedSearchPaper.journal || selectedSearchPaper.venue }}</span>
            </div>
            <div v-if="selectedSearchPaper.doi" class="detail-row">
              <span class="detail-label">DOI</span>
              <span>{{ selectedSearchPaper.doi }}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">来源</span>
              <span>{{ selectedSearchPaper.source }}</span>
            </div>
          </div>
          
          <div v-if="selectedSearchPaper.abstract" class="detail-abstract">
            <span class="detail-label">摘要</span>
            <p>{{ selectedSearchPaper.abstract }}</p>
          </div>
        </div>
      </template>
      
      <template #footer>
        <button class="btn btn-ghost" @click="showSearchPaperDetail = false">关闭</button>
        <a v-if="selectedSearchPaper?.url" :href="selectedSearchPaper.url" target="_blank" class="btn btn-primary">
          查看原文
        </a>
      </template>
    </Modal>

    <!-- Paper Details Modal -->
    <Modal
      v-model="showPaperDetailsModal"
      title="论文详情"
      maxWidth="600px"
    >
      <template v-if="paperDetails">
        <div class="paper-detail-content">
          <h4 class="detail-title">{{ paperDetails.title }}</h4>
          
          <div class="detail-grid">
            <div class="detail-row">
              <span class="detail-label">作者</span>
              <span>{{ paperDetails.authors?.join(', ') || '未知' }}</span>
            </div>
            <div v-if="paperDetails.year" class="detail-row">
              <span class="detail-label">年份</span>
              <span>{{ paperDetails.year }}</span>
            </div>
            <div v-if="paperDetails.doi" class="detail-row">
              <span class="detail-label">DOI</span>
              <span>{{ paperDetails.doi }}</span>
            </div>
            <div v-if="paperDetails.journal" class="detail-row">
              <span class="detail-label">期刊</span>
              <span>{{ paperDetails.journal }}</span>
            </div>
            <div v-if="paperDetails.venue" class="detail-row">
              <span class="detail-label">会议</span>
              <span>{{ paperDetails.venue }}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">分类</span>
              <span>{{ paperDetails.categoryId ? (categoryNameById.get(paperDetails.categoryId) || '—') : '未分类' }}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">解析状态</span>
              <span>{{ statusMap[paperDetails.parseStatus] || paperDetails.parseStatus }}</span>
            </div>
            <div v-if="paperDetails.createdAt" class="detail-row">
              <span class="detail-label">上传时间</span>
              <span>{{ new Date(paperDetails.createdAt).toLocaleString() }}</span>
            </div>
          </div>
          
          <div v-if="paperDetails.abstract" class="detail-abstract">
            <span class="detail-label">摘要</span>
            <p>{{ paperDetails.abstract }}</p>
          </div>
        </div>
      </template>
    </Modal>

    <!-- Batch Move Dialog -->
    <Modal v-model="showMoveDialog" title="移动到分类">
      <template #default>
        <div class="move-dialog-content">
          <p class="move-dialog-hint">将选中的 {{ selectedPaperIds.size }} 篇文献移动到：</p>
          <Select
            v-model="moveTargetCategory"
            :options="[
              { value: 'uncategorized', label: '未分类' },
              ...flattenedCategories.map(cat => ({ value: cat.value, label: cat.label }))
            ]"
            placeholder="请选择分类"
          />
        </div>
      </template>
      <template #footer>
        <button class="btn btn-ghost" @click="showMoveDialog = false">取消</button>
        <button
          class="btn btn-primary"
          :disabled="!moveTargetCategory"
          @click="confirmBatchMove"
        >
          移动
        </button>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
.app-layout {
  display: flex;
  flex-direction: column;
  height: 100vh;
  height: 100dvh;
  overflow: hidden;
}

/* ── Header ──────────────────────────────────────────────────────────────── */

.app-header {
  height: var(--header-height);
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 640px) minmax(0, 1fr);
  column-gap: 8px;
  align-items: center;
  padding: 0 12px;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-bg-card);
  flex-shrink: 0;
  z-index: 20;
  position: relative;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 2px;
  width: 100%;
  min-width: 0;
  max-width: 100%;
  overflow: visible;
  justify-self: stretch;
  position: relative;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
  justify-self: end;
}

.header-center {
  display: flex;
  justify-content: center;
  align-items: center;
  width: 100%;
  min-width: 0;
  justify-self: stretch;
}

.brand {
  font-size: 15px;
  font-weight: 700;
  letter-spacing: -0.04em;
  color: var(--color-primary);
  margin-left: 6px;
  flex-shrink: 0;
}

.header-paper-title {
  margin-left: 12px;
  font-size: 13px;
  color: var(--color-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.icon-btn {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--color-text-muted);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background var(--transition), color var(--transition), transform var(--transition);
}

.icon-btn:hover {
  background: var(--color-bg-muted);
  color: var(--color-text-secondary);
}
.icon-btn:active { transform: scale(0.92); }

.icon-btn.active {
  color: var(--color-primary);
  background: var(--color-primary-soft);
}

.chat-toggle.active {
  color: var(--color-primary);
  background: var(--color-primary-soft);
}

/* ── Open-papers dropdown (header) ─────────────────────────────────────────── */
.tabs-menu {
  position: absolute;
  left: 84px;
  top: 50%;
  transform: translateY(-50%);
  flex: none;
  margin-left: 0;
  min-width: 0;
  max-width: min(320px, calc(100% - 84px));
  z-index: 2;
}
.tabs-menu-trigger {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  width: auto;
  max-width: 100%;
  height: 30px;
  padding: 0 8px 0 10px;
  border: 1px solid var(--color-border);
  border-radius: 999px;
  background: var(--color-bg-muted);
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: background var(--transition), border-color var(--transition), color var(--transition);
}
.tabs-menu-trigger:hover { background: var(--color-bg-hover); color: var(--color-text); }
.tabs-menu-trigger.open {
  background: var(--color-bg-card);
  border-color: var(--color-border-hover);
  color: var(--color-text);
}
.tabs-menu-doc { flex-shrink: 0; color: var(--color-primary); }
.tabs-menu-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
  font-weight: 500;
}
.tabs-menu-caret { flex-shrink: 0; color: var(--color-text-muted); transition: transform var(--transition); }
.tabs-menu-trigger.open .tabs-menu-caret { transform: rotate(180deg); }

.tabs-menu-dropdown {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  z-index: 60;
  width: max-content;
  min-width: 240px;
  max-width: 360px;
  max-height: 60vh;
  overflow-y: auto;
  padding: 5px;
  background: var(--color-bg-card);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-lg);
}
.tabs-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 8px 7px 10px;
  border: none;
  background: transparent;
  border-radius: var(--radius-sm);
  color: var(--color-text-secondary);
  cursor: pointer;
  text-align: left;
  transition: background var(--transition), color var(--transition);
}
.tabs-menu-item:hover { background: var(--color-bg-muted); color: var(--color-text); }
.tabs-menu-item.active { color: var(--color-text); }
.tabs-menu-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-primary);
  flex-shrink: 0;
}
.tabs-menu-item:not(.active) > .tabs-menu-item-title:first-child { margin-left: 14px; }
.tabs-menu-section {
  padding: 5px 8px 4px;
  font-size: 11px;
  font-weight: 600;
  color: var(--color-text-muted);
  letter-spacing: 0.03em;
}
.tabs-menu-section.separated {
  margin-top: 5px;
  padding-top: 8px;
  border-top: 1px solid var(--color-border);
}
.tabs-menu-file-icon {
  width: 16px;
  flex-shrink: 0;
  font-size: 13px;
  line-height: 1;
}
.tabs-menu-dirty {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--color-warning);
  flex-shrink: 0;
}
.tabs-menu-item-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 500;
}
.tabs-menu-item-close {
  width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  color: var(--color-text-muted);
  font-size: 15px;
  line-height: 1;
  flex-shrink: 0;
  opacity: 0.6;
  transition: background var(--transition), color var(--transition), opacity var(--transition);
}
.tabs-menu-item:hover .tabs-menu-item-close { opacity: 1; }
.tabs-menu-item-close:hover { background: var(--color-error); color: #fff; opacity: 1; }

.dropdown-enter-active, .dropdown-leave-active { transition: opacity 0.16s ease, transform 0.16s cubic-bezier(0.34, 1.4, 0.64, 1); transform-origin: top left; }
.dropdown-enter-from, .dropdown-leave-to { opacity: 0; transform: translateY(-6px) scale(0.97); }

/* ── Body ─────────────────────────────────────────────────────────────────── */

.app-body {
  flex: 1;
  display: flex;
  overflow: hidden;
  position: relative;
}

.app-sidebar {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--color-bg-card);
  border-right: 1px solid var(--color-border);
  flex-shrink: 0;
  transform: translateX(0);
  transition: transform 180ms ease, width 180ms ease, min-width 180ms ease;
  will-change: transform, width;
  position: relative;
  z-index: 1;
}
.app-sidebar.closed {
  pointer-events: none;
  transform: translateX(-100%);
}

.app-main {
  flex: 1;
  overflow: hidden;
  min-width: 0;
}

.app-chat {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--color-bg-card);
  border-left: 1px solid var(--color-border);
  flex-shrink: 0;
  transform: translateX(0);
  transition: transform 180ms ease, width 180ms ease, min-width 180ms ease;
  will-change: transform, width;
  position: relative;
  z-index: 1;
}
.app-chat.closed {
  pointer-events: none;
  transform: translateX(100%);
}
.resizer {
  width: 4px;
  background: transparent;
  cursor: col-resize;
  flex-shrink: 0;
  transition: background var(--transition);
  z-index: 5;
}
.resizer:hover, .resizer.active { background: var(--color-primary-soft); }
:global(body.resizing-panels) .app-sidebar,
:global(body.resizing-panels) .app-chat {
  transition: none !important;
  will-change: auto;
}

/* ── Shared side panels ───────────────────────────────────────────────────── */

.side-panel {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.side-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--color-border);
}

.side-header h2 {
  font-size: 16px;
  font-weight: 600;
  color: var(--color-text);
  margin: 0;
}

.side-upload, .primary-btn {
  border: none;
  background: var(--color-primary);
  color: #fff;
  border-radius: var(--radius-sm);
  padding: 7px 12px;
  font-size: 13px;
  cursor: pointer;
  transition: background var(--transition), transform var(--transition);
}
.side-upload:hover, .primary-btn:hover { background: var(--color-primary-hover); }
.side-upload:active, .primary-btn:active { transform: scale(0.97); }

.category-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 10px 8px calc(10px + var(--list-scroll-bottom-gap, 84px));
  scroll-padding-bottom: var(--list-scroll-bottom-gap, 84px);
}

.category-item {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 9px 10px;
  border: none;
  background: transparent;
  color: var(--color-text-secondary);
  border-radius: var(--radius-sm);
  cursor: pointer;
  text-align: left;
  font-size: 13.5px;
  transition: background var(--transition), color var(--transition);
}
.category-item:hover { background: var(--color-bg-muted); color: var(--color-text); }
.category-item.active { background: var(--color-primary-soft); color: var(--color-primary); font-weight: 600; }

.cat-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cat-count {
  font-size: 11px;
  color: var(--color-text-muted);
}
.cat-toggle, .cat-spacer {
  width: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--color-text-muted);
  cursor: pointer;
  user-select: none;
  line-height: 1;
}
.cat-icon {
  width: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  font-size: 15px;
  line-height: 1;
}
.cat-toggle:hover { color: var(--color-text); }
.category-node { margin-bottom: 1px; }
.category-children {
  padding-left: 20px;
  position: relative;
}
.category-children::before {
  content: '';
  position: absolute;
  left: 8px;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--color-border);
  opacity: 0.5;
}
.category-item.child {
  padding-left: 8px;
  font-size: 13px;
}
.cat-rename-input {
  flex: 1;
  min-width: 0;
  padding: 2px 6px;
  border: 1px solid var(--color-primary);
  border-radius: 4px;
  background: var(--color-bg-card);
  color: var(--color-text);
  font-size: inherit;
  line-height: inherit;
  outline: none;
}
.adding-row { cursor: default; }
.adding-row:hover { background: transparent; }
.cat-context-menu {
  position: fixed;
  z-index: 200;
  min-width: 160px;
  background: var(--color-bg-card);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  box-shadow: 0 6px 20px rgba(0,0,0,0.14);
  padding: 4px;
}
.ctx-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 12px;
  border: none;
  background: transparent;
  color: var(--color-text-secondary);
  border-radius: var(--radius-sm);
  font-size: 13px;
  cursor: pointer;
  text-align: left;
}
.ctx-item:hover { background: var(--color-bg-muted); color: var(--color-text); }
.ctx-item.danger:hover { background: rgba(239,68,68,0.10); color: var(--color-error); }
.ctx-sep {
  height: 1px;
  background: var(--color-border);
  margin: 4px 8px;
}
.paper-ctx { min-width: 200px; }
.has-sub { position: relative; }
.has-sub::after { content: '▸'; position: absolute; right: 10px; opacity: 0.5; }
.ctx-flyout {
  min-width: 180px;
  max-height: 70vh;
  overflow-y: auto;
}
.ctx-flyout .has-sub { position: relative; }
.ctx-flyout .has-sub::after { content: ''; }

.modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 300;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0,0,0,0.4);
}
.modal-card {
  background: var(--color-bg-card);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  box-shadow: 0 12px 40px rgba(0,0,0,0.18);
  padding: 24px;
  max-width: 520px;
  width: 90vw;
  max-height: 80vh;
  overflow-y: auto;
}
.modal-card h3 { margin: 0 0 16px; font-size: 18px; line-height: 1.4; }
.detail-grid { display: flex; flex-direction: column; gap: 8px; }
.detail-row { display: flex; gap: 12px; font-size: 13px; }
.detail-label { flex-shrink: 0; width: 64px; color: var(--color-text-muted); font-weight: 500; }
.detail-abstract { margin-top: 12px; font-size: 13px; }
.detail-abstract .detail-label { display: block; width: auto; margin-bottom: 4px; }
.detail-abstract p { color: var(--color-text-secondary); line-height: 1.6; margin: 0; }
.detail-actions { margin-top: 20px; display: flex; justify-content: flex-end; }

.side-bottom {
  margin-top: auto;
  padding: 12px;
  border-top: 1px solid var(--color-border);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.settings-link {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 10px 14px;
  border: none;
  background: var(--color-bg-muted);
  color: var(--color-text-secondary);
  border-radius: 8px;
  font-size: 13px;
  font-weight: 500;
  text-decoration: none;
  cursor: pointer;
  transition: all 0.2s ease;
}

.settings-link:hover,
.settings-link.active {
  background: var(--color-primary-soft);
  color: var(--color-primary);
}

.settings-link svg {
  flex-shrink: 0;
  opacity: 0.7;
}

.settings-link:hover svg,
.settings-link.active svg {
  opacity: 1;
}

.side-mini-btn {
  border: none;
  border-radius: var(--radius-sm);
  padding: 5px 9px;
  background: var(--color-bg-muted);
  color: var(--color-text-secondary);
  font-size: 12px;
  cursor: pointer;
}
.side-mini-btn:hover:not(:disabled) { background: var(--color-primary-soft); color: var(--color-primary); }
.side-mini-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.error-text { color: var(--color-error); }
.files-inline-list {
  padding: 8px 4px calc(8px + var(--list-scroll-bottom-gap, 84px));
}
.files-inline-list.root-drop-target {
  outline: 1px dashed rgba(var(--color-primary-rgb), 0.45);
  outline-offset: -4px;
  background: rgba(var(--color-primary-rgb), 0.05);
}
.files-inline-list :deep(.file-tree) {
  padding: 0;
}
.files-inline-list :deep(.section-divider) {
  padding: 0 8px;
}

.workspace-panel { height: 100%; min-height: 0; display: flex; flex-direction: column; }
.workspace-empty {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px;
  text-align: center;
  color: var(--color-text-secondary);
}
.workspace-empty.compact { min-height: 260px; flex: none; }
.workspace-empty .empty-icon { font-size: 42px; margin-bottom: 12px; }
.workspace-empty h2 { font-size: 18px; color: var(--color-text); margin-bottom: 8px; }
.workspace-empty p { max-width: 520px; line-height: 1.7; }
.workspace-error {
  margin: 12px 16px 0;
  padding: 9px 12px;
  border: 1px solid rgba(239, 68, 68, 0.35);
  border-radius: var(--radius);
  background: rgba(239, 68, 68, 0.08);
  color: var(--color-error);
  font-size: 13px;
}
.workspace-editor-shell { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.workspace-editor-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-bg-card);
}
.workspace-file-summary { min-width: 0; }
.workspace-file-summary h2 { font-size: 14px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.workspace-file-summary p { margin-top: 2px; color: var(--color-text-muted); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.workspace-file-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; color: var(--color-text-muted); font-size: 12px; }
.readonly-pill { color: var(--color-warning); border: 1px solid rgba(245, 158, 11, 0.35); border-radius: 999px; padding: 2px 8px; }
.workspace-text-editor-wrap { flex: 1; min-height: 0; display: flex; flex-direction: column; background: var(--color-bg-card); }
.dirty-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--color-border-hover); flex-shrink: 0; }
.dirty-dot.active { background: var(--color-warning); }
.dirty-dot.conflict { background: var(--color-error); }
.workspace-live-conflict {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid rgba(239, 68, 68, 0.25);
  background: rgba(239, 68, 68, 0.08);
  color: var(--color-error);
  font-size: 12px;
}
.workspace-live-conflict button {
  border: 1px solid rgba(239, 68, 68, 0.35);
  background: var(--color-bg-card);
  color: var(--color-error);
  border-radius: var(--radius-sm);
  padding: 3px 8px;
  cursor: pointer;
}
.save-workspace-btn {
  padding: 5px 12px;
  border: none;
  background: var(--color-primary);
  color: #fff;
  border-radius: var(--radius-sm);
  font-size: 12px;
  cursor: pointer;
}
.save-workspace-btn:hover:not(:disabled) { background: var(--color-primary-hover); }
.save-workspace-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.open-system-btn {
  padding: 5px 12px;
  border: 1px solid var(--color-border);
  background: var(--color-bg);
  color: var(--color-text-secondary);
  border-radius: var(--radius-sm);
  font-size: 12px;
  cursor: pointer;
}
.open-system-btn:hover:not(:disabled) { border-color: rgba(var(--color-primary-rgb), 0.35); color: var(--color-primary); background: rgba(var(--color-primary-rgb), 0.08); }
.open-system-btn:disabled { opacity: 0.5; cursor: wait; }
.workspace-code-editor { flex: 1; min-height: 0; }
.md-view-toggle { display: flex; gap: 2px; padding: 2px; border-radius: var(--radius-sm); background: var(--color-bg-muted); }
.md-view-toggle button {
  padding: 3px 12px;
  border: none;
  background: transparent;
  color: var(--color-text-muted);
  font-size: 12px;
  border-radius: calc(var(--radius-sm) - 2px);
  cursor: pointer;
}
.md-view-toggle button.active { background: var(--color-bg-card); color: var(--color-text); box-shadow: 0 1px 2px rgba(0,0,0,0.08); }
.workspace-md-preview {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 24px 28px 32px;
  scroll-padding-bottom: 32px;
  color: var(--color-text);
}
.workspace-md-preview :deep(h1) { font-size: 1.7em; font-weight: 700; margin: 1.4em 0 0.7em; }
.workspace-md-preview :deep(h2) { font-size: 1.4em; font-weight: 700; margin: 1.3em 0 0.65em; padding-bottom: 0.4em; border-bottom: 1px solid var(--color-border); }
.workspace-md-preview :deep(h3) { font-size: 1.2em; font-weight: 600; margin: 1.2em 0 0.6em; }
.workspace-md-preview :deep(h4) { font-size: 1.05em; font-weight: 600; margin: 1.1em 0 0.5em; }
.workspace-md-preview :deep(:first-child) { margin-top: 0; }
.workspace-md-preview :deep(a) { color: var(--color-primary); text-decoration: underline; }
.workspace-md-preview :deep(img) { max-width: 100%; border-radius: var(--radius); }
.workspace-md-preview :deep(hr) { border: none; border-top: 1px solid var(--color-border); margin: 18px 0; }
.workspace-md-preview :deep(table) { border-collapse: collapse; margin-bottom: 12px; }
.workspace-md-preview :deep(th), .workspace-md-preview :deep(td) { border: 1px solid var(--color-border); padding: 6px 12px; }
.workspace-md-preview :deep(th) { background: var(--color-bg-muted); }
.workspace-preview-panel { flex: 1; min-height: 0; overflow: auto; padding: 24px; display: flex; justify-content: center; align-items: flex-start; }
.workspace-preview-panel img { max-width: 100%; height: auto; border-radius: var(--radius); box-shadow: var(--shadow-lg); background: var(--color-bg-card); }
.workspace-office-preview-wrap { flex: 1; min-height: 0; padding: 16px; background: var(--color-bg-card); }
.paper-library.settings-workspace-panel { overflow-y: auto; }
.settings-workspace-panel :deep(.settings-content) { width: min(760px, calc(100% - 48px)); padding: 0 24px 24px; }

/* ── Notes side ───────────────────────────────────────────────────────────── */

.notes-side-header {
  padding: 12px 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.notes-side-header h2 {
  font-size: 16px;
  font-weight: 600;
  color: var(--color-text);
  margin: 0;
}

.note-count {
  font-size: 12px;
  color: var(--color-text-muted);
}
.back-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  border: none;
  background: var(--color-bg-muted);
  color: var(--color-text-secondary);
  border-radius: var(--radius-sm);
  padding: 7px 10px;
  cursor: pointer;
  font-size: 13px;
}
.back-btn:hover { color: var(--color-primary); }
.note-count { font-size: 12px; color: var(--color-text-muted); }
.note-paper-title {
  padding: 10px 14px;
  border-bottom: 1px solid var(--color-border);
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text);
  line-height: 1.45;
  word-break: break-word;
  overflow-wrap: break-word;
}
.notes-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 10px 10px calc(10px + var(--list-scroll-bottom-gap, 84px));
  scroll-padding-bottom: var(--list-scroll-bottom-gap, 84px);
}
.note-card {
  display: block;
  width: 100%;
  border: 1px solid var(--color-border);
  background: var(--color-bg-muted);
  border-radius: var(--radius-sm);
  padding: 10px;
  margin-bottom: 8px;
  text-align: left;
  cursor: pointer;
  transition: border-color var(--transition), background var(--transition);
}
.note-card:hover { border-color: var(--color-primary); background: var(--color-bg-card); }
.note-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 7px;
}
.note-tag { font-size: 11px; color: var(--color-text-muted); }
.note-actions { display: flex; gap: 4px; }
.note-actions button {
  border: none;
  background: transparent;
  color: var(--color-text-muted);
  font-size: 11px;
  border-radius: 4px;
  padding: 2px 4px;
  cursor: pointer;
}
.note-actions button:hover { color: var(--color-primary); background: var(--color-bg-muted); }
.note-actions button.danger:hover { color: var(--color-error); }
.note-quote {
  margin: 0 0 7px;
  padding: 7px 9px;
  border-left: 3px solid var(--color-warning);
  background: rgba(245, 158, 11, 0.10);
  border-radius: 0 5px 5px 0;
  color: var(--color-text-secondary);
  font-size: 12px;
  line-height: 1.45;
  display: -webkit-box;
  -webkit-line-clamp: 4;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.note-content {
  color: var(--color-text);
  font-size: 13px;
  line-height: 1.5;
  word-break: break-word;
  overflow-wrap: anywhere;
}
.note-content :deep(p) { margin-bottom: 6px; }
.note-content :deep(p:last-child) { margin-bottom: 0; }
.note-content :deep(code) {
  background: var(--color-bg-muted);
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 12px;
}
.note-content :deep(pre) {
  background: var(--color-bg-muted);
  padding: 8px;
  border-radius: var(--radius-sm);
  overflow-x: auto;
  margin-bottom: 6px;
}
.note-content :deep(pre code) { padding: 0; background: none; }
.note-content :deep(ul), .note-content :deep(ol) { padding-left: 18px; margin-bottom: 6px; }
.note-content :deep(blockquote) {
  border-left: 3px solid var(--color-primary);
  padding-left: 10px;
  margin: 0 0 6px;
  color: var(--color-text-muted);
}
.note-content :deep(a) { color: var(--color-primary); text-decoration: none; }
.note-content :deep(a:hover) { text-decoration: underline; }
.note-edit {
  width: 100%;
  padding: 8px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg-card);
  color: var(--color-text);
  font-size: 13px;
  resize: vertical;
  font-family: inherit;
  min-height: 240px;
}
.note-edit:focus { outline: none; border-color: var(--color-primary); }
.note-edit-actions { display: flex; gap: 8px; margin-top: 8px; }
.save-note-btn, .cancel-note-btn {
  border: none;
  border-radius: var(--radius-sm);
  padding: 5px 10px;
  font-size: 12px;
  cursor: pointer;
}
.save-note-btn { background: var(--color-primary); color: white; }
.cancel-note-btn { background: var(--color-bg-muted); color: var(--color-text-secondary); }
.note-input {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border-top: 1px solid var(--color-border);
}
.note-input textarea {
  width: 100%;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg-muted);
  color: var(--color-text);
  font-size: 13px;
  padding: 8px;
  resize: vertical;
  font-family: inherit;
}
.note-input textarea:focus { outline: none; border-color: var(--color-primary); background: var(--color-bg-card); }
.note-input button {
  border: none;
  border-radius: var(--radius-sm);
  background: var(--color-primary);
  color: #fff;
  padding: 7px 10px;
  font-size: 13px;
  cursor: pointer;
}
.note-input button:disabled { opacity: 0.45; cursor: default; }
.side-empty {
  padding: 24px 10px;
  color: var(--color-text-muted);
  text-align: center;
  font-size: 13px;
}

/* ── Paper library center ─────────────────────────────────────────────────── */

.paper-library {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--color-bg);
}

.library-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding: 24px 28px 16px;
  transition: padding var(--transition);
}
.library-header h1 {
  font-size: 24px;
  font-weight: 700;
  color: var(--color-text);
  letter-spacing: -0.03em;
  transition: font-size var(--transition);
}
.library-header p {
  margin-top: 4px;
  font-size: 13px;
  color: var(--color-text-muted);
  max-height: 22px;
  overflow: hidden;
  transition: opacity var(--transition), max-height var(--transition), margin-top var(--transition);
}
/* Scrolled: collapse into a slim sticky-feeling bar so the list gets more room. */
.library-header.condensed { padding: 10px 28px; }
.library-header.condensed h1 { font-size: 16px; }
.library-header.condensed p { opacity: 0; max-height: 0; margin-top: 0; }
.header-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-shrink: 0;
}
.ranking-filters {
  display: flex;
  align-items: center;
  gap: 6px;
}
.ranking-filter {
  height: 32px;
  padding: 0 26px 0 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg-card);
  color: var(--color-text-secondary);
  font-size: 12px;
  cursor: pointer;
  appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg width='10' height='6' viewBox='0 0 10 6' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1L5 5L9 1' stroke='%239ca3af' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 9px center;
}
.ranking-filter:hover,
.ranking-filter:focus {
  outline: none;
  border-color: var(--color-primary);
  color: var(--color-text);
}
.library-search {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0 28px 16px;
  padding: 10px 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  background: var(--color-bg-card);
  color: var(--color-text-muted);
}
.library-search input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--color-text);
  font-size: 14px;
}
.paper-table {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 8px 28px calc(28px + var(--list-scroll-bottom-gap, 84px));
  scroll-padding-bottom: var(--list-scroll-bottom-gap, 84px);
}
.batch-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 18px;
  margin: 0 28px 12px;
  background: var(--color-bg-card);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  gap: 16px;
}
.paper-row {
  display: flex;
  align-items: stretch;
  justify-content: space-between;
  gap: 20px;
  width: 100%;
  padding: 16px 18px;
  margin-bottom: 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  background: var(--color-bg-card);
  text-align: left;
  cursor: pointer;
  transition: transform var(--transition), box-shadow var(--transition), border-color var(--transition);
}
.paper-row:hover {
  transform: translateY(-1px);
  border-color: var(--color-primary);
  box-shadow: var(--shadow);
}
.paper-row.selected {
  border-color: var(--color-primary);
  background: var(--color-primary-soft);
}
.paper-checkbox {
  display: flex;
  align-items: center;
  padding-right: 12px;
}
.paper-checkbox input[type="checkbox"] {
  width: 18px;
  height: 18px;
  cursor: pointer;
}
.batch-info {
  display: flex;
  align-items: center;
  gap: 12px;
}
.batch-checkbox {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  font-size: 14px;
  color: var(--color-text);
}
.batch-checkbox input[type="checkbox"] {
  width: 18px;
  height: 18px;
  cursor: pointer;
}
.batch-actions {
  display: flex;
  gap: 8px;
}
.batch-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  border: 1px solid var(--color-border);
  background: var(--color-bg-card);
  color: var(--color-text);
  border-radius: var(--radius-sm);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all var(--transition);
}
.batch-btn svg {
  flex-shrink: 0;
  stroke: currentColor;
}
.batch-btn:hover:not(:disabled) {
  background: var(--color-bg-muted);
  border-color: var(--color-primary);
  transform: translateY(-1px);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
}
.batch-btn.danger {
  color: #ffffff !important;
  border-color: var(--color-danger);
  background: var(--color-danger);
}
.batch-btn.danger svg {
  stroke: #ffffff !important;
}
.batch-btn.danger:hover:not(:disabled) {
  background: #dc2626;
  border-color: #dc2626;
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(239, 68, 68, 0.4);
}
.batch-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.secondary-btn {
  padding: 8px 16px;
  border: 1px solid var(--color-border);
  background: var(--color-bg-card);
  color: var(--color-text);
  border-radius: var(--radius-sm);
  font-size: 13px;
  cursor: pointer;
  transition: all var(--transition);
}
.secondary-btn:hover {
  background: var(--color-bg-muted);
  border-color: var(--color-primary);
}
.move-dialog-content {
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: 4px 0;
}
.move-dialog-hint {
  margin: 0;
  color: var(--color-text);
  font-size: 14px;
}
.paper-row-main {
  flex: 1;
  min-width: 0;
}
.paper-row-main h3 {
  font-size: 15px;
  font-weight: 650;
  color: var(--color-text);
  line-height: 1.45;
  word-break: break-word;
  overflow-wrap: break-word;
}
.paper-authors {
  margin-top: 5px;
  color: var(--color-text-muted);
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.paper-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
  font-size: 12px;
  color: var(--color-text-muted);
}
.paper-venue {
  color: var(--color-text-secondary);
  font-weight: 500;
}
.paper-date {
  color: var(--color-text-muted);
}
.paper-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 6px;
}
.paper-tag {
  display: inline-flex;
  align-items: center;
  padding: 2px 6px;
  background: var(--color-bg-muted);
  color: var(--color-text-secondary);
  border-radius: 4px;
  font-size: 11px;
}
.paper-tag.more {
  background: var(--color-primary-soft);
  color: var(--color-primary);
}
.paper-abstract-wrap {
  margin-top: 8px;
}
.paper-abstract {
  margin: 0;
  color: var(--color-text-secondary);
  font-size: 13px;
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.paper-abstract.expanded {
  display: block;
  -webkit-line-clamp: unset;
  overflow: visible;
}
.abstract-toggle {
  padding: 0;
  border: none;
  background: transparent;
  color: var(--color-primary);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  margin-top: 2px;
  display: inline-block;
}
.abstract-toggle:hover {
  text-decoration: underline;
}
.paper-row-side {
  width: 80px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
}
.category-pill, .badge {
  display: inline-flex;
  align-items: center;
  max-width: 100%;
  padding: 3px 7px;
  border-radius: 999px;
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.category-pill { background: var(--color-bg-muted); color: var(--color-text-muted); }
.badge { background: var(--color-bg-muted); color: var(--color-text-muted); }
.badge-completed { background: rgba(34, 197, 94, 0.12); color: #16a34a; }
.badge-processing { background: rgba(59, 130, 246, 0.12); color: #2563eb; }
.badge-failed { background: rgba(239, 68, 68, 0.12); color: #dc2626; }
.paper-actions {
  margin-top: auto;
  display: flex;
  gap: 2px;
  opacity: 0;
  transition: opacity 0.15s;
}
.paper-row:hover .paper-actions {
  opacity: 1;
}
.paper-action-btn {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  border-radius: 4px;
}
.paper-action-btn:hover {
  background: var(--color-primary-soft);
  color: var(--color-primary);
}
.paper-action-btn.danger {
  background: rgba(239, 68, 68, 0.12);
  color: var(--color-error);
}
.paper-action-btn.danger:hover {
  background: rgba(239, 68, 68, 0.25);
}
.library-empty {
  padding: 48px 16px;
  text-align: center;
  color: var(--color-text-muted);
  font-size: 14px;
}

/* ── Search Categories Section ────────────────────────────────────────────── */

.search-categories-section {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--color-border);
}

.section-divider {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 10px 8px;
}

.divider-text {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--color-text-muted);
}

.add-search-cat-btn {
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--color-text-muted);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: all var(--transition);
}

.add-search-cat-btn:hover:not(:disabled) {
  background: var(--color-bg-muted);
  color: var(--color-primary);
}
.add-search-cat-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.visually-hidden-input {
  position: fixed;
  left: -9999px;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
}

.search-category-item {
  margin-bottom: 1px;
}

/* ── Paper Detail Content ────────────────────────────────────────────────── */

.paper-detail-content {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.detail-title {
  font-size: 18px;
  font-weight: 600;
  color: var(--color-text);
  margin: 0;
  line-height: 1.4;
}

.detail-grid {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.detail-row {
  display: flex;
  gap: 12px;
  font-size: 14px;
  align-items: baseline;
}

.detail-label {
  flex-shrink: 0;
  width: 70px;
  color: var(--color-text-muted);
  font-weight: 500;
  font-size: 13px;
}

.detail-abstract {
  padding-top: 16px;
  border-top: 1px solid var(--color-border);
}

.detail-abstract .detail-label {
  display: block;
  width: auto;
  margin-bottom: 8px;
  font-weight: 600;
}

.detail-abstract p {
  color: var(--color-text-secondary);
  line-height: 1.7;
  margin: 0;
  font-size: 14px;
}

/* ── Buttons ─────────────────────────────────────────────────────────────── */

.btn {
  padding: 9px 18px;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
  font-family: inherit;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.btn-ghost {
  border: 1px solid var(--color-border);
  background: var(--color-bg);
  color: var(--color-text-secondary);
}

.btn-ghost:hover {
  background: var(--color-bg-muted);
  border-color: var(--color-border-hover);
}

.btn-primary {
  border: none;
  background: var(--color-primary);
  color: white;
  text-decoration: none;
}

.btn-primary:hover {
  background: var(--color-primary-hover);
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
}
.btn:active { transform: translateY(0) scale(0.98); }

/* ── Mobile ───────────────────────────────────────────────────────────────── */

.mobile-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  z-index: 30;
  animation: fade-in 0.2s ease;
}

@keyframes fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}

.mobile-drawer {
  position: fixed;
  top: var(--header-height);
  bottom: 0;
  z-index: 40;
  width: min(92vw, 390px) !important;
  max-width: 390px !important;
  min-width: 0 !important;
  animation: slide-in 0.2s ease;
  box-shadow: var(--shadow-lg);
  padding-bottom: env(safe-area-inset-bottom, 0px);
}

:global(body[data-app-background="on"]) .app-sidebar.mobile-drawer,
:global(body[data-app-background="on"]) .app-chat.mobile-drawer {
  background: rgba(var(--mask-rgb), var(--mask-opacity-card)) !important;
}

.app-chat.mobile-drawer {
  right: 0;
  left: auto;
  border-left: 1px solid var(--color-border);
  border-right: none;
}

@keyframes slide-in {
  from { transform: translateX(-100%); }
  to { transform: translateX(0); }
}

.app-chat.mobile-drawer { animation: slide-in-right 0.2s ease; }

@keyframes slide-in-right {
  from { transform: translateX(100%); }
  to { transform: translateX(0); }
}

/* ── Responsive ───────────────────────────────────────────────────────────── */

@media (max-width: 768px) {
  .app-header {
    grid-template-columns: auto minmax(0, 1fr) auto;
    column-gap: 4px;
  }
  .app-sidebar, .app-chat { border: none; }
  .brand { display: none; }
  .header-left { width: auto; gap: 0; }
  .header-right { width: auto; gap: 0; }
  .tabs-menu { left: 36px; max-width: 160px; }
  .tabs-menu-trigger { max-width: 100%; }
  .library-header {
    padding: 18px 16px 12px;
    align-items: flex-start;
    flex-direction: column;
  }
  .header-actions {
    width: 100%;
    flex-wrap: wrap;
  }
  .ranking-filters {
    width: 100%;
  }
  .ranking-filter {
    flex: 1;
    min-width: 0;
  }
  .library-header h1 { font-size: 20px; }
  .library-search { margin: 0 16px 12px; }
  .paper-table { padding: 0 16px 16px; }
  .paper-row {
    flex-direction: column;
    gap: 10px;
    padding: 14px;
  }
  .paper-row-side {
    width: 100%;
    flex-direction: row;
    align-items: center;
    justify-content: flex-start;
  }
  .paper-delete { margin-left: auto; margin-top: 0; }
}

@media (max-width: 480px) {
  .app-header { padding: 0 8px; }
  .primary-btn { padding: 7px 10px; }
}

/* ── Installed PWA title-bar integration ───────────────────────────────────
   In Window Controls Overlay mode the app header becomes the draggable title
   bar. The dynamic insets reserve the system controls on either the left
   (macOS-style) or right (Windows/Linux-style), so app actions stay clickable. */
@media (display-mode: window-controls-overlay) {
  .app-layout {
    --header-height: max(48px, env(titlebar-area-height, 48px));
  }

  .app-header {
    padding-left: max(12px, env(titlebar-area-x, 0px));
    padding-right: max(
      12px,
      calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw))
    );
    app-region: drag;
    -webkit-app-region: drag;
  }

  .app-header :is(
    button,
    a,
    input,
    select,
    textarea,
    [role='button'],
    [role='listbox'],
    [contenteditable='true']
  ) {
    app-region: no-drag;
    -webkit-app-region: no-drag;
  }
}

</style>
