<script setup lang="ts">
import { ref, watch } from 'vue'
import { useApi } from '@/composables/useApi'

const props = defineProps<{
  journalName?: string
  venueName?: string
}>()

const api = useApi()

const rankings = ref<{
  ccf: string | null
  sci: string | null
}>({ ccf: null, sci: null })

const loading = ref(false)

const fetchRankings = async () => {
  const name = props.journalName || props.venueName
  if (!name) {
    rankings.value = { ccf: null, sci: null }
    return
  }

  loading.value = true
  try {
    const data = await api.getRankings(name)
    rankings.value = { ccf: data.ccf || null, sci: data.sci || null }
  } catch (err) {
    console.error('Failed to fetch rankings:', err)
    rankings.value = { ccf: null, sci: null }
  } finally {
    loading.value = false
  }
}

watch(() => [props.journalName, props.venueName], fetchRankings, { immediate: true })

const getRankingColor = (ranking: string | null) => {
  if (!ranking) return 'var(--color-text-muted)'
  if (ranking.includes('A') || ranking === 'Q1') return '#16a34a'
  if (ranking.includes('B') || ranking === 'Q2') return '#2563eb'
  if (ranking.includes('C') || ranking === 'Q3') return '#d97706'
  if (ranking === 'Q4') return '#dc2626'
  return 'var(--color-text-muted)'
}

const getRankingBg = (ranking: string | null) => {
  if (!ranking) return 'var(--color-bg-muted)'
  if (ranking.includes('A') || ranking === 'Q1') return 'rgba(22, 163, 74, 0.1)'
  if (ranking.includes('B') || ranking === 'Q2') return 'rgba(37, 99, 235, 0.1)'
  if (ranking.includes('C') || ranking === 'Q3') return 'rgba(217, 119, 6, 0.1)'
  if (ranking === 'Q4') return 'rgba(220, 38, 38, 0.1)'
  return 'var(--color-bg-muted)'
}
</script>

<template>
  <div v-if="rankings.ccf || rankings.sci" class="ranking-badges">
    <span
      v-if="rankings.ccf"
      class="ranking-badge ccf"
      :style="{ color: getRankingColor(rankings.ccf), backgroundColor: getRankingBg(rankings.ccf) }"
    >
      {{ rankings.ccf }}
    </span>
    <span
      v-if="rankings.sci"
      class="ranking-badge sci"
      :style="{ color: getRankingColor(rankings.sci), backgroundColor: getRankingBg(rankings.sci) }"
    >
      {{ rankings.sci }}
    </span>
  </div>
  <div v-else-if="loading" class="ranking-loading">
    <span class="loading-dot"></span>
  </div>
</template>

<style scoped>
.ranking-badges {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}

.ranking-badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.02em;
  line-height: 1;
}

.ranking-badge.ccf {
  border: 1px solid currentColor;
}

.ranking-badge.sci {
  border: 1px solid currentColor;
}

.ranking-loading {
  display: inline-flex;
  align-items: center;
}

.loading-dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--color-text-muted);
  animation: pulse 1.5s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 0.3; }
  50% { opacity: 0.6; }
}
</style>
