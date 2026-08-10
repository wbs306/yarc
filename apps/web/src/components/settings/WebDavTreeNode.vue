<script setup lang="ts">
import { computed } from 'vue'
import type { WebDavSyncTreeNode } from '@yarc/shared'

defineOptions({ name: 'WebDavTreeNode' })

const props = withDefaults(defineProps<{
  node: WebDavSyncTreeNode
  selectedPaths: string[]
  depth?: number
}>(), { depth: 0 })

const emit = defineEmits<{
  toggle: [path: string, selected: boolean]
}>()

const selected = computed(() => props.selectedPaths.includes(props.node.path))
const coveredByAncestor = computed(() => props.selectedPaths.some(path => props.node.path.startsWith(`${path}/`)))
const effectivelySelected = computed(() => selected.value || coveredByAncestor.value)
const childSelected = computed(() => props.node.type === 'directory' && props.selectedPaths.some(path => path.startsWith(`${props.node.path}/`)))

const formatSize = (size?: number) => {
  if (size == null) return ''
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`
  return `${(size / 1024 / 1024 / 1024).toFixed(1)} GB`
}
</script>

<template>
  <div class="tree-node">
    <details v-if="node.type === 'directory'" :open="depth < 1">
      <summary class="node-row">
        <input
          type="checkbox"
          :checked="effectivelySelected"
          :disabled="coveredByAncestor"
          :indeterminate="childSelected && !selected && !coveredByAncestor"
          :class="{ partial: childSelected && !selected }"
          :aria-label="`选择目录 ${node.path}`"
          @click.stop
          @change="emit('toggle', node.path, ($event.target as HTMLInputElement).checked)"
        />
        <span class="node-icon">📁</span>
        <span class="node-name" :title="node.path">{{ node.name }}</span>
        <span v-if="selected" class="directory-note">包含全部子项</span>
        <span v-else-if="coveredByAncestor" class="directory-note">已由上级包含</span>
      </summary>
      <div class="children">
        <WebDavTreeNode
          v-for="child in node.children || []"
          :key="child.path"
          :node="child"
          :selected-paths="selectedPaths"
          :depth="depth + 1"
          @toggle="(path, checked) => emit('toggle', path, checked)"
        />
        <div v-if="!node.children?.length" class="empty-directory">空目录</div>
      </div>
    </details>

    <label v-else class="node-row file-row">
      <input
        type="checkbox"
        :checked="effectivelySelected"
        :disabled="coveredByAncestor"
        :aria-label="`选择文件 ${node.path}`"
        @change="emit('toggle', node.path, ($event.target as HTMLInputElement).checked)"
      />
      <span class="node-icon">📄</span>
      <span class="node-name" :title="node.path">{{ node.name }}</span>
      <span class="node-size">{{ formatSize(node.size) }}</span>
    </label>
  </div>
</template>

<style scoped>
.tree-node { min-width: 0; }
.node-row {
  min-height: 32px;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 3px 8px;
  border-radius: 6px;
  color: var(--color-text-secondary);
  font-size: 13px;
  cursor: pointer;
  user-select: none;
}
.node-row:hover { background: var(--color-bg-muted); color: var(--color-text); }
summary { list-style: none; }
summary::-webkit-details-marker { display: none; }
summary::before {
  content: '›';
  width: 12px;
  color: var(--color-text-muted);
  transition: transform 120ms ease;
}
details[open] > summary::before { transform: rotate(90deg); }
.file-row { padding-left: 27px; }
.node-row input { accent-color: var(--color-primary); }
.node-row input.partial { opacity: .65; }
.node-icon { width: 18px; text-align: center; font-size: 14px; }
.node-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.node-size,
.directory-note { margin-left: auto; color: var(--color-text-muted); font-size: 11px; white-space: nowrap; }
.children { margin-left: 16px; border-left: 1px solid var(--color-border); padding-left: 4px; }
.empty-directory { padding: 5px 12px 5px 36px; color: var(--color-text-muted); font-size: 12px; }
</style>
