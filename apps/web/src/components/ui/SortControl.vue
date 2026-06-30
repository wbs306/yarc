<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'

export interface SortOption {
  field: string
  direction: 'asc' | 'desc'
}

const props = defineProps<{
  modelValue: SortOption[]
  options: { field: string; label: string }[]
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: SortOption[]): void
}>()

const showDropdown = ref(false)

const primarySort = computed(() => props.modelValue[0] || null)
const secondarySort = computed(() => props.modelValue[1] || null)

const toggleSort = (field: string, isSecondary = false) => {
  const current = isSecondary ? secondarySort.value : primarySort.value
  let newDirection: 'asc' | 'desc' = 'desc'
  
  if (current?.field === field) {
    newDirection = current.direction === 'desc' ? 'asc' : 'desc'
  }
  
  const newSort: SortOption = { field, direction: newDirection }
  
  if (isSecondary) {
    emit('update:modelValue', [primarySort.value!, newSort])
  } else {
    emit('update:modelValue', [newSort, secondarySort.value].filter(Boolean) as SortOption[])
  }
}

const removeSort = (index: number) => {
  const newValue = [...props.modelValue]
  newValue.splice(index, 1)
  emit('update:modelValue', newValue)
}

const getSortLabel = (sort: SortOption) => {
  const opt = props.options.find(o => o.field === sort.field)
  return opt?.label || sort.field
}

const getDirectionIcon = (direction: 'asc' | 'desc') => {
  return direction === 'asc' ? '↑' : '↓'
}

const handleClickOutside = (e: MouseEvent) => {
  const target = e.target as HTMLElement
  if (!target.closest('.sort-control')) {
    showDropdown.value = false
  }
}

onMounted(() => {
  document.addEventListener('click', handleClickOutside)
})
</script>

<template>
  <div class="sort-control">
    <div class="sort-display" @click="showDropdown = !showDropdown">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="4" y1="6" x2="20" y2="6" />
        <line x1="4" y1="12" x2="16" y2="12" />
        <line x1="4" y1="18" x2="12" y2="18" />
      </svg>
      <span v-if="modelValue.length === 0" class="sort-placeholder">排序</span>
      <div v-else class="sort-tags">
        <span v-for="(sort, index) in modelValue" :key="index" class="sort-tag" @click.stop="removeSort(index)">
          {{ getSortLabel(sort) }} {{ getDirectionIcon(sort.direction) }}
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </span>
      </div>
    </div>
    
    <Transition name="dropdown">
      <div v-if="showDropdown" class="sort-dropdown">
        <div class="sort-section">
          <span class="sort-section-label">主要排序</span>
          <div class="sort-options">
            <button
              v-for="opt in options"
              :key="opt.field"
              class="sort-option"
              :class="{ active: primarySort?.field === opt.field }"
              @click="toggleSort(opt.field)"
            >
              <span>{{ opt.label }}</span>
              <span v-if="primarySort?.field === opt.field" class="direction">
                {{ getDirectionIcon(primarySort.direction) }}
              </span>
            </button>
          </div>
        </div>
        
        <div v-if="primarySort" class="sort-section">
          <span class="sort-section-label">次要排序</span>
          <div class="sort-options">
            <button
              v-for="opt in options.filter(o => o.field !== primarySort?.field)"
              :key="opt.field"
              class="sort-option"
              :class="{ active: secondarySort?.field === opt.field }"
              @click="toggleSort(opt.field, true)"
            >
              <span>{{ opt.label }}</span>
              <span v-if="secondarySort?.field === opt.field" class="direction">
                {{ getDirectionIcon(secondarySort.direction) }}
              </span>
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.sort-control {
  position: relative;
}

.sort-display {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s ease;
  min-height: 32px;
}

.sort-display:hover {
  border-color: var(--color-primary);
}

.sort-placeholder {
  font-size: 13px;
  color: var(--color-text-muted);
}

.sort-tags {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}

.sort-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  background: var(--color-primary-soft);
  color: var(--color-primary);
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
}

.sort-tag:hover {
  background: var(--color-primary);
  color: white;
}

.sort-tag svg {
  opacity: 0.7;
}

.sort-dropdown {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  min-width: 200px;
  background: var(--color-bg-card);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
  z-index: 100;
  overflow: hidden;
}

.sort-section {
  padding: 8px 0;
}

.sort-section:not(:last-child) {
  border-bottom: 1px solid var(--color-border);
}

.sort-section-label {
  display: block;
  padding: 4px 12px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--color-text-muted);
}

.sort-options {
  display: flex;
  flex-direction: column;
}

.sort-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border: none;
  background: transparent;
  color: var(--color-text);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.sort-option:hover {
  background: var(--color-bg-muted);
}

.sort-option.active {
  background: var(--color-primary-soft);
  color: var(--color-primary);
}

.direction {
  font-weight: 600;
}

.dropdown-enter-active,
.dropdown-leave-active {
  transition: all 0.2s ease;
}

.dropdown-enter-from,
.dropdown-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}
</style>
