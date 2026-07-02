<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'

defineOptions({ name: 'FileTree' })

export interface FileNode {
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

const props = withDefaults(defineProps<{
  nodes: FileNode[]
  selectedPath?: string
  level?: number
  creatingParentPath?: string | undefined
  creatingType?: 'file' | 'directory'
  parentPath?: string
}>(), {
  selectedPath: '',
  level: 0,
  creatingParentPath: undefined,
  creatingType: 'file',
  parentPath: '',
})

const emit = defineEmits<{
  select: [node: FileNode]
  contextMenu: [e: MouseEvent, node: FileNode | null]
  rename: [node: FileNode, newName: string]
  create: [parentPath: string, name: string, type: 'file' | 'directory']
  cancelCreate: []
  move: [node: FileNode, targetDirPath: string]
}>()

const loadExpandedPaths = () => {
  try {
    const parsed = JSON.parse(localStorage.getItem('yarc_workspace_expanded_dirs') || '[]')
    return new Set(Array.isArray(parsed) ? parsed.filter((path) => typeof path === 'string') : [])
  } catch {
    return new Set<string>()
  }
}

const persistExpandedPath = (path: string, isExpanded: boolean) => {
  const next = loadExpandedPaths()
  if (isExpanded) next.add(path)
  else next.delete(path)
  localStorage.setItem('yarc_workspace_expanded_dirs', JSON.stringify(Array.from(next)))
}

const expanded = ref<Set<string>>(loadExpandedPaths())
const renamingPath = ref<string | null>(null)
const renamingValue = ref('')
const renameInput = ref<HTMLInputElement | null>(null)
const creatingValue = ref('')
const treeRoot = ref<HTMLElement | null>(null)
const draggingPath = ref<string | null>(null)
const dropTargetPath = ref<string | null>(null)
// Guard to prevent double-submission
const createSubmitted = ref(false)

const hasCreateInputInThisTree = (path: string) => {
  if (props.level === 0 && path === '') return true
  return props.nodes.some((node) => node.type === 'directory' && node.path === path)
}

// Focus the create input owned by this FileTree instance. Root-level creation
// and directory-child creation now use the same `.file-node.creating` markup and
// the same component-scoped focus path.
watch(
  () => [props.creatingParentPath, props.creatingType] as const,
  async ([path]) => {
    if (path === undefined || !hasCreateInputInThisTree(path)) return

    creatingValue.value = ''
    createSubmitted.value = false
    await nextTick()

    const input = treeRoot.value?.querySelector<HTMLInputElement>('.file-node.creating .rename-input')
    input?.focus()
    input?.select()
  }
)

const isExpanded = (node: FileNode) => expanded.value.has(node.path)

const toggle = (node: FileNode) => {
  if (node.type !== 'directory') return
  const next = new Set(expanded.value)
  const willExpand = !next.has(node.path)
  if (willExpand) next.add(node.path)
  else next.delete(node.path)
  expanded.value = next
  persistExpandedPath(node.path, willExpand)
}

const handleNodeClick = (node: FileNode) => {
  if (renamingPath.value) return
  if (node.type === 'directory') {
    toggle(node)
    return
  }
  emit('select', node)
}

const handleContextMenu = (e: MouseEvent, node: FileNode | null) => {
  e.preventDefault()
  e.stopPropagation()
  emit('contextMenu', e, node)
}

const startRename = async (node: FileNode) => {
  if (node.readonly) return
  renamingPath.value = node.path
  renamingValue.value = node.name
  await nextTick()
  renameInput.value?.focus()
  renameInput.value?.select()
}

const confirmRename = (node: FileNode) => {
  const newName = renamingValue.value.trim()
  renamingPath.value = null
  if (!newName || newName === node.name) return
  emit('rename', node, newName)
}

const cancelRename = () => {
  renamingPath.value = null
  renamingValue.value = ''
}

const handleRenameKeydown = (e: KeyboardEvent, node: FileNode) => {
  if (e.key === 'Enter') {
    e.preventDefault()
    confirmRename(node)
  } else if (e.key === 'Escape') {
    e.preventDefault()
    cancelRename()
  }
}

const confirmCreate = () => {
  // Prevent double-submission (blur can fire after we've already submitted)
  if (createSubmitted.value) return
  if (props.creatingParentPath === undefined) return

  const name = creatingValue.value.trim()
  const parentPath = props.creatingParentPath
  const type = props.creatingType

  createSubmitted.value = true
  emit('cancelCreate')

  if (!name) return
  emit('create', parentPath, name, type)
}

const cancelCreate = () => {
  createSubmitted.value = true
  emit('cancelCreate')
  creatingValue.value = ''
}

const handleCreateKeydown = (e: KeyboardEvent) => {
  if (e.key === 'Enter') {
    e.preventDefault()
    confirmCreate()
  } else if (e.key === 'Escape') {
    e.preventDefault()
    cancelCreate()
  }
}

// Check if this is the level where we should show the create input
const shouldShowCreateInput = (nodePath: string) => {
  return props.creatingParentPath === nodePath
}

const isRootCreating = () => {
  return props.level === 0 && props.creatingParentPath === ''
}

// Cancel empty creation when clicking on blank space
const handleTreeClick = (e: MouseEvent) => {
  // Don't cancel if clicking on the input itself
  const target = e.target as HTMLElement
  if (target.tagName === 'INPUT') return
  if (props.creatingParentPath !== undefined && creatingValue.value.trim() === '') {
    cancelCreate()
  }
  if (renamingPath.value && renamingValue.value.trim() === '') {
    cancelRename()
  }
}

const formatSize = (size?: number) => {
  if (size === undefined) return ''
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

const OFFICE_EXTENSIONS = new Set(['.docx', '.xlsx', '.pptx'])
const LEGACY_OFFICE_EXTENSIONS = new Set(['.doc', '.xls', '.ppt'])
const isOfficeNode = (node: FileNode) => node.office || OFFICE_EXTENSIONS.has(node.extension || '')
const isLegacyOfficeNode = (node: FileNode) => node.legacyOffice || LEGACY_OFFICE_EXTENSIONS.has(node.extension || '')

const fileColor = (node: FileNode) => {
  if (node.type === 'directory') return 'var(--color-primary)'
  if (node.mime?.startsWith('image/')) return '#8b5cf6'
  if (node.extension === '.pdf') return '#ef4444'
  if (isOfficeNode(node)) return '#2563eb'
  if (isLegacyOfficeNode(node)) return '#94a3b8'
  if (node.extension === '.md' || node.extension === '.txt') return '#22c55e'
  if (node.extension === '.json' || node.extension === '.yaml' || node.extension === '.yml') return '#f59e0b'
  if (node.extension === '.ts' || node.extension === '.js' || node.extension === '.vue') return '#3b82f6'
  return '#71717a'
}

const normalizePath = (path?: string | null) => (path || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')
const isProtectedDropDir = (path?: string | null) => {
  const normalized = normalizePath(path)
  return normalized === 'papers' || normalized.startsWith('papers/')
}
const canDragNode = (node: FileNode) => !node.readonly && renamingPath.value !== node.path && props.creatingParentPath === undefined
const canDropIntoDir = (path: string, readonly = false) => !readonly && !isProtectedDropDir(path)

const handleDragStart = (event: DragEvent, node: FileNode) => {
  if (!canDragNode(node)) {
    event.preventDefault()
    return
  }
  draggingPath.value = node.path
  event.dataTransfer?.setData('application/x-yarc-file-node', JSON.stringify({ ...node, children: undefined }))
  event.dataTransfer?.setData('text/plain', node.path)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}

const handleDragEnd = () => {
  draggingPath.value = null
  dropTargetPath.value = null
}

const handleDirectoryDragOver = (event: DragEvent, node: FileNode) => {
  if (node.type !== 'directory' || !canDropIntoDir(node.path, node.readonly)) return
  event.preventDefault()
  event.stopPropagation()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  dropTargetPath.value = node.path
}

const handleDirectoryDragLeave = (event: DragEvent, node: FileNode) => {
  if ((event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) return
  if (dropTargetPath.value === node.path) dropTargetPath.value = null
}

const readDroppedNode = (event: DragEvent): FileNode | null => {
  const raw = event.dataTransfer?.getData('application/x-yarc-file-node')
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as FileNode
    return parsed?.path && parsed?.name && parsed?.type ? parsed : null
  } catch {
    return null
  }
}

const handleDirectoryDrop = (event: DragEvent, targetDirPath: string) => {
  event.preventDefault()
  event.stopPropagation()
  dropTargetPath.value = null
  const node = readDroppedNode(event)
  if (!node || node.path === targetDirPath || targetDirPath.startsWith(`${node.path}/`)) return
  emit('move', node, targetDirPath)
}

const handleTreeDragOver = (event: DragEvent) => {
  const target = event.target as HTMLElement | null
  if (target?.closest('.file-node')) return
  if (!canDropIntoDir(props.parentPath)) return
  event.preventDefault()
  event.stopPropagation()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  dropTargetPath.value = props.parentPath
}

const handleTreeDragLeave = (event: DragEvent) => {
  if ((event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) return
  if (dropTargetPath.value === props.parentPath) dropTargetPath.value = null
}

const handleTreeDrop = (event: DragEvent) => {
  const target = event.target as HTMLElement | null
  if (target?.closest('.file-node')) return
  if (!canDropIntoDir(props.parentPath)) return
  handleDirectoryDrop(event, props.parentPath)
}

const handleTreeContextMenu = (event: MouseEvent) => {
  if ((event.target as HTMLElement | null)?.closest('.file-node')) return
  event.preventDefault()
  event.stopPropagation()
  emit('contextMenu', event, null)
}

const isDropTarget = (path: string) => dropTargetPath.value === path

defineExpose({ startRename })
</script>

<template>
  <div
    ref="treeRoot"
    class="file-tree"
    :class="{ 'tree-drop-target': isDropTarget(parentPath) }"
    :style="{ '--tree-level': level }"
    @click="handleTreeClick"
    @contextmenu="handleTreeContextMenu"
    @dragover="handleTreeDragOver"
    @dragleave="handleTreeDragLeave"
    @drop="handleTreeDrop"
  >
    <!-- Create input at root level -->
    <div v-if="isRootCreating()" class="file-node-wrap creating">
      <div class="file-node creating" :style="{ paddingLeft: `${4 + level * 16}px` }">
        <span class="file-toggle" />
        <span class="file-icon">
          <svg v-if="creatingType === 'directory'" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-primary)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
          </svg>
          <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#71717a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
            <path d="M14 2v6h6" />
          </svg>
        </span>
        <input
          v-model="creatingValue"
          class="rename-input"
          :placeholder="creatingType === 'directory' ? '文件夹名称…' : '文件名称…'"
          @click.stop
          @keydown="handleCreateKeydown"
          @blur="confirmCreate"
        />
      </div>
    </div>

    <div v-for="node in nodes" :key="node.path" class="file-node-wrap">
      <div
        class="file-node"
        :class="{
          active: selectedPath === node.path,
          directory: node.type === 'directory',
          readonly: node.readonly,
          renaming: renamingPath === node.path,
          dragging: draggingPath === node.path,
          'drop-target': isDropTarget(node.path),
        }"
        :style="{ paddingLeft: `${4 + level * 16}px` }"
        role="button"
        tabindex="0"
        :title="node.path"
        :draggable="canDragNode(node)"
        @click="handleNodeClick(node)"
        @contextmenu="handleContextMenu($event, node)"
        @keydown.enter.prevent="handleNodeClick(node)"
        @keydown.space.prevent="handleNodeClick(node)"
        @dragstart.stop="handleDragStart($event, node)"
        @dragend.stop="handleDragEnd"
        @dragover="handleDirectoryDragOver($event, node)"
        @dragleave="handleDirectoryDragLeave($event, node)"
        @drop="handleDirectoryDrop($event, node.path)"
      >
        <span class="file-toggle" :class="{ expanded: isExpanded(node), visible: node.type === 'directory' }">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M4.5 3L7.5 6L4.5 9" />
          </svg>
        </span>
        
        <span class="file-icon">
          <svg v-if="node.type === 'directory' && isExpanded(node)" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" fill="currentColor" opacity="0.15" />
            <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
          </svg>
          <svg v-else-if="node.type === 'directory'" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
          </svg>
          <svg v-else-if="node.extension === '.pdf'" width="16" height="16" viewBox="0 0 24 24" fill="none" :stroke="fileColor(node)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
            <path d="M14 2v6h6" />
            <path d="M9 15h6M9 11h6" />
          </svg>
          <svg v-else-if="node.mime?.startsWith('image/')" width="16" height="16" viewBox="0 0 24 24" fill="none" :stroke="fileColor(node)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <path d="M21 15l-5-5L5 21" />
          </svg>
          <svg v-else-if="isOfficeNode(node) || isLegacyOfficeNode(node)" width="16" height="16" viewBox="0 0 24 24" fill="none" :stroke="fileColor(node)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
            <path d="M14 2v6h6" />
            <path d="M8 13h8M8 17h5" />
          </svg>
          <svg v-else-if="node.editable" width="16" height="16" viewBox="0 0 24 24" fill="none" :stroke="fileColor(node)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
            <path d="M14 2v6h6" />
            <path d="M16 13H8M16 17H8M10 9H8" />
          </svg>
          <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" :stroke="fileColor(node)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
            <path d="M14 2v6h6" />
          </svg>
        </span>
        
        <!-- Normal file name display -->
        <span v-if="renamingPath !== node.path" class="file-name">{{ node.name }}</span>
        
        <!-- Inline rename input -->
        <input
          v-else
          ref="renameInput"
          v-model="renamingValue"
          class="rename-input"
          @click.stop
          @keydown="handleRenameKeydown($event, node)"
          @blur="confirmRename(node)"
        />
        
        <span v-if="node.readonly" class="file-lock">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0110 0v4" />
          </svg>
        </span>
        
        <span v-if="node.type === 'file' && node.size !== undefined" class="file-size">{{ formatSize(node.size) }}</span>
      </div>

      <!-- Create input inside directory -->
      <div v-if="node.type === 'directory' && shouldShowCreateInput(node.path)" class="category-children">
        <div class="file-node creating" :style="{ paddingLeft: `${4 + (level + 1) * 16}px` }">
          <span class="file-toggle" />
          <span class="file-icon">
            <svg v-if="creatingType === 'directory'" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-primary)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
            </svg>
            <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#71717a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
              <path d="M14 2v6h6" />
            </svg>
          </span>
          <input
            v-model="creatingValue"
            class="rename-input"
            :placeholder="creatingType === 'directory' ? '文件夹名称…' : '文件名称…'"
            @click.stop
            @keydown="handleCreateKeydown"
            @blur="confirmCreate"
          />
        </div>
      </div>

      <Transition name="tree-expand">
        <FileTree
          v-if="node.type === 'directory' && node.children?.length && isExpanded(node)"
          :nodes="node.children"
          :selected-path="selectedPath"
          :level="level + 1"
          :creating-parent-path="creatingParentPath"
          :creating-type="creatingType"
          :parent-path="node.path"
          @select="emit('select', $event)"
          @context-menu="(e, child) => emit('contextMenu', e, child)"
          @rename="(child, newName) => emit('rename', child, newName)"
          @create="(parentPath, name, type) => emit('create', parentPath, name, type)"
          @cancel-create="emit('cancelCreate')"
          @move="(child, targetDirPath) => emit('move', child, targetDirPath)"
        />
      </Transition>
    </div>
  </div>
</template>

<style scoped>
.file-tree {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 2px 0;
}

.file-node-wrap {
  position: relative;
}

.file-node {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 32px;
  padding: 4px 10px 4px 0;
  border-radius: 6px;
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: all 0.15s ease;
  user-select: none;
  position: relative;
  margin: 0 6px;
}

.file-node:hover {
  background: var(--color-bg-muted);
  color: var(--color-text);
}

.file-node.active {
  background: var(--color-primary-soft);
  color: var(--color-primary);
}

.file-node.dragging {
  opacity: 0.48;
}

.file-node.drop-target {
  background: rgba(var(--color-primary-rgb), 0.12);
  box-shadow: inset 0 0 0 1px rgba(var(--color-primary-rgb), 0.35);
}

.file-tree.tree-drop-target {
  outline: 1px dashed rgba(var(--color-primary-rgb), 0.45);
  outline-offset: -2px;
  border-radius: 8px;
}

.file-node.drop-target .file-icon {
  transform: scale(1.08);
}

.file-node.active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 4px;
  bottom: 4px;
  width: 3px;
  border-radius: 0 2px 2px 0;
  background: var(--color-primary);
}

.file-node.readonly {
  opacity: 0.7;
}

.file-node.renaming,
.file-node.creating {
  cursor: text;
  background: var(--color-primary-soft);
}

/* Toggle arrow */
.file-toggle {
  width: 0;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  opacity: 0;
  transition: all 0.15s ease;
  color: var(--color-text-muted);
  overflow: hidden;
}

.file-toggle.visible {
  width: 14px;
  opacity: 0.5;
}

.file-toggle.expanded {
  transform: rotate(90deg);
  opacity: 0.7;
}

.file-node:hover .file-toggle.visible {
  opacity: 1;
}

/* File icon */
.file-icon {
  width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: transform 0.15s ease;
}

.file-node:hover .file-icon {
  transform: scale(1.08);
}

/* File name */
.file-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 450;
  letter-spacing: -0.01em;
}

.file-node.active .file-name {
  font-weight: 550;
}

.file-node:not(.readonly) .file-name {
  color: var(--color-text);
}

.file-node:not(.readonly) .file-icon svg {
  filter: brightness(1.2);
}

/* Rename input */
.rename-input {
  flex: 1;
  min-width: 0;
  padding: 2px 6px;
  border: 1px solid var(--color-primary);
  border-radius: 4px;
  background: var(--color-bg-card);
  color: var(--color-text);
  font-size: 13px;
  font-weight: 450;
  outline: none;
  box-shadow: 0 0 0 2px rgba(var(--color-primary-rgb), 0.15);
}

/* File size */
.file-size {
  font-size: 11px;
  color: var(--color-text-muted);
  flex-shrink: 0;
  opacity: 0;
  transition: opacity 0.15s ease;
}

.file-node:hover .file-size {
  opacity: 0.7;
}

/* Lock icon */
.file-lock {
  display: flex;
  align-items: center;
  color: var(--color-text-muted);
  opacity: 0.6;
}

/* Category children (for create input inside directory) */
.category-children {
  padding-left: 0;
}

/* Tree expand animation */
.tree-expand-enter-active {
  animation: tree-slide-in 0.15s ease-out;
}

.tree-expand-leave-active {
  animation: tree-slide-in 0.12s ease-in reverse;
}

@keyframes tree-slide-in {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
</style>
