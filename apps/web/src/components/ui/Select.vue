<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'

interface Option {
  value: string
  label: string
  disabled?: boolean
  level?: number
}

interface OptionGroup {
  label: string
  options: Option[]
}

const props = withDefaults(defineProps<{
  modelValue: string
  options?: Option[]
  groups?: OptionGroup[]
  placeholder?: string
  disabled?: boolean
  minWidth?: string
}>(), {
  options: () => [],
  groups: () => [],
  placeholder: '请选择',
  minWidth: '0',
})

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
}>()

const isOpen = ref(false)
const triggerRef = ref<HTMLElement>()
const dropdownRef = ref<HTMLElement>()
const dropdownPos = ref({ top: 0, left: 0, width: 0, openUp: false })

const flatOptions = computed(() =>
  props.groups.length ? props.groups.flatMap(g => g.options) : props.options
)

const selectedLabel = computed(() => {
  const opt = flatOptions.value.find(o => o.value === props.modelValue)
  return opt?.label || props.placeholder
})

const hasGroups = computed(() => props.groups.length > 0)

const winHeight = ref(window.innerHeight)
const handleResize = () => { winHeight.value = window.innerHeight; if (isOpen.value) updatePosition() }

const updatePosition = () => {
  if (!triggerRef.value) return
  const rect = triggerRef.value.getBoundingClientRect()
  const gap = 4
  const maxH = 260
  const spaceBelow = winHeight.value - rect.bottom - gap
  const spaceAbove = rect.top - gap
  const openUp = spaceBelow < maxH && spaceAbove > spaceBelow

  dropdownPos.value = {
    top: openUp ? rect.top - gap : rect.bottom + gap,
    left: rect.left,
    width: rect.width,
    openUp,
  }
}

const toggle = () => {
  if (props.disabled) return
  if (!isOpen.value) {
    updatePosition()
    isOpen.value = true
  } else {
    isOpen.value = false
  }
}

const select = (value: string) => {
  emit('update:modelValue', value)
  isOpen.value = false
}

const handleClickOutside = (e: MouseEvent) => {
  if (
    triggerRef.value && !triggerRef.value.contains(e.target as Node) &&
    dropdownRef.value && !dropdownRef.value.contains(e.target as Node)
  ) {
    isOpen.value = false
  }
}

const handleScroll = () => {
  if (isOpen.value) updatePosition()
}

onMounted(() => {
  document.addEventListener('mousedown', handleClickOutside)
  window.addEventListener('scroll', handleScroll, true)
  window.addEventListener('resize', handleResize)
})

onUnmounted(() => {
  document.removeEventListener('mousedown', handleClickOutside)
  window.removeEventListener('scroll', handleScroll, true)
  window.removeEventListener('resize', handleResize)
})
</script>

<template>
  <div ref="triggerRef" class="modern-select" :class="{ open: isOpen, disabled }" :style="{ minWidth }" @click="toggle">
    <div class="select-display">
      <span class="select-value" :class="{ placeholder: !modelValue }">{{ selectedLabel }}</span>
      <svg class="select-arrow" :class="{ rotated: isOpen }" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="6 9 12 15 18 9" />
      </svg>
    </div>
  </div>

  <Teleport to="body">
    <Transition name="select-pop">
      <div
        v-if="isOpen"
        ref="dropdownRef"
        class="select-dropdown-portal"
        :style="{
          position: 'fixed',
          top: dropdownPos.openUp ? 'auto' : dropdownPos.top + 'px',
          bottom: dropdownPos.openUp ? (winHeight - dropdownPos.top) + 'px' : 'auto',
          left: dropdownPos.left + 'px',
          width: dropdownPos.width + 'px',
          transformOrigin: dropdownPos.openUp ? 'bottom center' : 'top center',
        }"
      >
        <!-- Flat options -->
        <template v-if="!hasGroups">
          <div
            v-for="opt in options"
            :key="opt.value"
            class="select-option"
            :class="{ active: opt.value === modelValue, disabled: opt.disabled, child: (opt.level || 0) > 0 }"
            :style="{ paddingLeft: `${10 + Math.max(opt.level || 0, 0) * 16}px` }"
            @mousedown.prevent="!opt.disabled && select(opt.value)"
          >
            <span v-if="(opt.level || 0) > 0" class="select-option-tree" aria-hidden="true">└</span>
            {{ opt.label }}
          </div>
        </template>
        <!-- Grouped options -->
        <template v-else>
          <template v-for="(group, gi) in groups" :key="gi">
            <div class="select-group-label">{{ group.label }}</div>
            <div
              v-for="opt in group.options"
              :key="opt.value"
              class="select-option"
              :class="{ active: opt.value === modelValue, disabled: opt.disabled, child: (opt.level || 0) > 0 }"
              :style="{ paddingLeft: `${10 + Math.max(opt.level || 0, 0) * 16}px` }"
              @mousedown.prevent="!opt.disabled && select(opt.value)"
            >
              <span v-if="(opt.level || 0) > 0" class="select-option-tree" aria-hidden="true">└</span>
              {{ opt.label }}
            </div>
          </template>
        </template>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.modern-select {
  position: relative;
  cursor: pointer;
  user-select: none;
  flex: 1;
  min-width: 0;
}

.modern-select.disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.select-display {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 7px 10px;
  background: var(--color-bg-card);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  transition: border-color 0.15s ease, box-shadow 0.15s ease, background-color 0.15s ease;
}

.modern-select:hover:not(.disabled) .select-display {
  border-color: var(--color-border-hover);
  background: var(--color-bg-muted);
}

.modern-select.open .select-display {
  border-color: var(--color-primary);
  box-shadow: 0 0 0 3px var(--color-primary-soft);
  background: var(--color-bg-card);
}

.select-value {
  font-size: 13px;
  font-weight: 500;
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.select-value.placeholder {
  color: var(--color-text-muted);
  font-weight: 400;
}

.select-arrow {
  color: var(--color-text-muted);
  transition: transform 0.2s ease;
  flex-shrink: 0;
}

.select-arrow.rotated {
  transform: rotate(180deg);
}
</style>

<style>
/* Global: dropdown is portaled to body so cannot be scoped */
.select-dropdown-portal {
  background: var(--color-bg-card);
  border: 1px solid var(--color-border);
  border-radius: 10px;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.12), 0 2px 8px rgba(0, 0, 0, 0.06);
  z-index: 9999;
  max-height: 260px;
  overflow-y: auto;
  padding: 4px;
}

.select-group-label {
  padding: 7px 10px 3px;
  font-size: 11px;
  font-weight: 600;
  color: var(--color-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.select-group-label:not(:first-child) {
  margin-top: 4px;
  border-top: 1px solid var(--color-border);
  padding-top: 9px;
}

.select-option {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 8px 10px;
  font-size: 13px;
  font-weight: 500;
  color: var(--color-text);
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.1s ease, color 0.1s ease;
}

.select-option-tree {
  color: var(--color-text-muted);
  font-weight: 400;
}

.select-option:hover {
  background: var(--color-bg-muted);
  color: var(--color-primary);
}

.select-option.active {
  background: var(--color-primary-soft);
  color: var(--color-primary);
  font-weight: 600;
}

.select-option.disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.select-pop-enter-active,
.select-pop-leave-active {
  transition: opacity 0.15s ease, transform 0.15s cubic-bezier(0.34, 1.3, 0.64, 1);
}

.select-pop-enter-from,
.select-pop-leave-to {
  opacity: 0;
  transform: scale(0.97);
}
</style>
