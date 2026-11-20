<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { WorkbenchTab } from '@/lib/workbench-tabs'

const props = defineProps<{
  /** The library and open papers: the left part of the strip. */
  papers: WorkbenchTab[]
  /** Workspace files: the right part of the strip. */
  files: WorkbenchTab[]
}>()

const emit = defineEmits<{
  select: [key: string]
  close: [key: string]
}>()

// A part without tabs is not rendered, and neither is its divider.
const groups = computed(() => [
  { id: 'papers', tabs: props.papers },
  { id: 'files', tabs: props.files },
].filter(group => group.tabs.length))

const activeKey = computed(() => [...props.papers, ...props.files].find(tab => tab.active)?.key || '')
const list = ref<HTMLElement | null>(null)

// Scroll only the strip itself; scrollIntoView could move ancestors too.
const revealActiveTab = () => {
  const strip = list.value
  const tab = strip?.querySelector<HTMLElement>('.workbench-tab.active')
  if (!strip || !tab) return
  const tabRect = tab.getBoundingClientRect()
  const stripRect = strip.getBoundingClientRect()
  if (tabRect.left < stripRect.left) strip.scrollLeft -= stripRect.left - tabRect.left
  else if (tabRect.right > stripRect.right) strip.scrollLeft += tabRect.right - stripRect.right
}
watch([activeKey, () => props.papers.length + props.files.length], () => { void nextTick(revealActiveTab) })

// The strip also narrows without any tab changing: the actions on its right
// appear once a file has loaded, and side panels or the window are resized.
let resizeObserver: ResizeObserver | null = null
onMounted(() => {
  revealActiveTab()
  if (!list.value || typeof ResizeObserver === 'undefined') return
  resizeObserver = new ResizeObserver(revealActiveTab)
  resizeObserver.observe(list.value)
})
onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  resizeObserver = null
})

// A vertical mouse wheel scrolls an overflowing strip sideways.
const onWheel = (event: WheelEvent) => {
  const strip = event.currentTarget as HTMLElement
  if (strip.scrollWidth <= strip.clientWidth || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return
  event.preventDefault()
  strip.scrollLeft += event.deltaY
}

const onAuxClick = (event: MouseEvent, key: string) => {
  if (event.button === 1) emit('close', key)
}
</script>

<template>
  <div class="workbench-tabs">
    <div ref="list" class="workbench-tab-list" role="tablist" aria-label="已打开的文献和文件" @wheel="onWheel">
      <template v-for="(group, index) in groups" :key="group.id">
        <span v-if="index > 0" class="workbench-tab-divider" role="separator" aria-orientation="vertical" />
        <div
          v-for="tab in group.tabs"
          :key="tab.key"
          class="workbench-tab"
          :class="[`kind-${tab.kind}`, { active: tab.active }]"
          role="tab"
          tabindex="0"
          :aria-selected="tab.active"
          :title="tab.tooltip"
          @click="emit('select', tab.key)"
          @keydown.enter.prevent="emit('select', tab.key)"
          @keydown.space.prevent="emit('select', tab.key)"
          @mousedown.middle.prevent
          @auxclick="onAuxClick($event, tab.key)"
        >
          <span v-if="tab.badge" class="workbench-tab-badge" aria-hidden="true">{{ tab.badge }}</span>
          <svg v-else class="workbench-tab-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <template v-if="tab.kind === 'library'">
              <path d="M4 4v16" /><path d="M8 8v12" /><path d="M12 6v14" /><path d="m16 6 4 14" />
            </template>
            <template v-else-if="tab.kind === 'paper'">
              <path d="M2 4h6a4 4 0 0 1 4 4v13a3 3 0 0 0-3-3H2z" /><path d="M22 4h-6a4 4 0 0 0-4 4v13a3 3 0 0 1 3-3h7z" />
            </template>
            <template v-else>
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" />
            </template>
          </svg>
          <span class="workbench-tab-title">{{ tab.title }}</span>
          <span v-if="tab.hint" class="workbench-tab-hint">{{ tab.hint }}</span>
          <button
            type="button"
            class="workbench-tab-close"
            :class="tab.status ? ['has-status', `status-${tab.status}`] : undefined"
            :title="tab.status && tab.statusTitle ? `${tab.statusTitle}（点击关闭）` : '关闭'"
            :aria-label="`关闭 ${tab.title}`"
            @click.stop="emit('close', tab.key)"
            @keydown.stop
          >
            <span v-if="tab.status" class="workbench-tab-status" />
            <svg class="workbench-tab-x" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </template>
    </div>
    <div v-if="$slots.actions" class="workbench-tab-actions">
      <slot name="actions" />
    </div>
  </div>
</template>

<style scoped>
.workbench-tabs {
  display: flex;
  align-items: stretch;
  flex: 0 0 auto;
  height: 32px;
  min-width: 0;
  background: var(--color-bg-muted);
  /* Drawn as a shadow so the opaque active tab can sit on top of the line. */
  box-shadow: inset 0 -1px 0 var(--color-border);
  user-select: none;
  /* Lets slotted actions drop secondary details when the strip is narrow. */
  container: workbench-tabs / inline-size;
}

/* Paper tabs shrink first; the strip scrolls once they cannot shrink more. */
.workbench-tab-list {
  display: flex;
  flex: 1 1 auto;
  min-width: 0;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
}
.workbench-tab-list::-webkit-scrollbar { display: none; }

/* An empty gap bounded by tab borders separates papers from files. */
.workbench-tab-divider {
  flex: none;
  width: 12px;
  border-right: 1px solid var(--color-border);
}

.workbench-tab {
  display: flex;
  align-items: center;
  gap: 6px;
  /* File names are short and identify the tab, so they keep their width. */
  flex: 0 0 auto;
  min-width: 64px;
  max-width: 200px;
  padding: 0 5px 0 10px;
  border-right: 1px solid var(--color-border);
  color: var(--color-text-secondary);
  font-size: 12.5px;
  cursor: pointer;
  transition: background var(--transition), color var(--transition);
}
/* Paper titles are long: cap them and let them give way to other tabs. */
.workbench-tab.kind-paper { flex-shrink: 1; min-width: 104px; max-width: 184px; }
.workbench-tab:hover {
  background: color-mix(in srgb, var(--color-text) 5%, transparent);
  color: var(--color-text);
}
.workbench-tab.active {
  background: var(--color-bg-card);
  color: var(--color-text);
  box-shadow: inset 0 2px 0 var(--color-primary);
}
.workbench-tab:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: -2px;
}

.workbench-tab-icon { flex: none; opacity: 0.7; }
.workbench-tab.active .workbench-tab-icon { color: var(--color-primary); opacity: 1; }

/* Marks a project file. Same footprint as the icon, so widths never change. */
.workbench-tab-badge {
  display: grid;
  place-items: center;
  flex: none;
  width: 15px;
  height: 15px;
  margin: 0 -1px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--color-text) 10%, transparent);
  font-size: 9.5px;
  font-weight: 700;
  line-height: 1;
}
.workbench-tab.active .workbench-tab-badge { background: var(--color-primary-soft); color: var(--color-primary); }

.workbench-tab-title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.workbench-tab-hint {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 96px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text-muted);
  font-size: 11px;
}

.workbench-tab-close {
  display: grid;
  place-items: center;
  flex: none;
  width: 18px;
  height: 18px;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  opacity: 0;
  transition: background var(--transition), opacity var(--transition);
}
.workbench-tab:hover .workbench-tab-close,
.workbench-tab.active .workbench-tab-close,
.workbench-tab-close:focus-visible { opacity: 0.7; }
.workbench-tab-close.has-status,
.workbench-tab .workbench-tab-close:hover { opacity: 1; }
.workbench-tab-close:hover { background: color-mix(in srgb, var(--color-text) 12%, transparent); }

/* Like an editor tab: the state dot turns into the close button on hover. */
.workbench-tab-status {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--color-warning);
}
.workbench-tab-close.status-conflict .workbench-tab-status { background: var(--color-error); }
.workbench-tab-close.has-status .workbench-tab-x,
.workbench-tab-close.has-status:hover .workbench-tab-status { display: none; }
.workbench-tab-close.has-status:hover .workbench-tab-x { display: block; }

.workbench-tab-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 0 0 auto;
  padding: 0 14px 0 8px;
}
/* The slot may render nothing, e.g. for a plain text file. */
.workbench-tab-actions:empty { display: none; }

/* Touch devices have no hover to reveal the close button. */
@media (hover: none) {
  .workbench-tab-close { opacity: 0.6; }
}

@media (max-width: 768px) {
  .workbench-tab { max-width: 150px; }
  .workbench-tab.kind-paper { min-width: 84px; max-width: 150px; }
  .workbench-tab-hint { max-width: 64px; }
  .workbench-tab-actions { padding: 0 6px 0 4px; }
}

/* With an app background image the strip itself is see-through (main.css). */
:global(body[data-app-background="on"] .workbench-tab.active) {
  background: rgba(var(--color-bg-card-rgb), 0.6);
}
</style>
