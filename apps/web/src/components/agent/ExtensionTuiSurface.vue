<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useChatStore } from '@/stores/chat'
import type { PiTuiSurfaceState } from '@yarc/shared'

const props = defineProps<{ surface: PiTuiSurfaceState; embedded?: boolean }>()
const chatStore = useChatStore()
const host = ref<HTMLElement | null>(null)
let observer: ResizeObserver | null = null

const escapeHtml = (value: string) => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')

const overlayStyle = computed(() => {
  const options = props.surface.overlayOptions || {}
  const size = (value: number | string | undefined, unit: string) => {
    if (typeof value === 'number' && Number.isFinite(value)) return `${value}${unit}`
    if (typeof value === 'string' && /^\d+(?:\.\d+)?%$/.test(value)) return value
    return undefined
  }
  const margin = typeof options.margin === 'number'
    ? `${options.margin * 4}px`
    : options.margin && typeof options.margin === 'object'
      ? `${(options.margin.top || 0) * 4}px ${(options.margin.right || 0) * 4}px ${(options.margin.bottom || 0) * 4}px ${(options.margin.left || 0) * 4}px`
      : undefined
  return {
    width: size(options.width, 'ch'),
    minWidth: size(options.minWidth, 'ch'),
    maxHeight: size(options.maxHeight, 'em'),
    margin,
    transform: `translate(${Number(options.offsetX || 0) * 8}px, ${Number(options.offsetY || 0) * 18}px)`,
  }
})

const overlayClass = computed(() => `anchor-${props.surface.overlayOptions?.anchor || 'center'}`)

const ansiHtml = computed(() => {
  const colors = ['#111827', '#ef4444', '#22c55e', '#eab308', '#60a5fa', '#c084fc', '#22d3ee', '#e5e7eb']
  let bold = false
  let dim = false
  let foreground = ''
  let cursor = 0
  let html = ''
  const ansi = props.surface.ansi || props.surface.plainText || ''
  const pattern = /\u001b\[([0-9;]*)m/g
  const style = () => [foreground ? `color:${foreground}` : '', bold ? 'font-weight:700' : '', dim ? 'opacity:.68' : ''].filter(Boolean).join(';')
  const append = (text: string) => {
    const escaped = escapeHtml(text)
    const css = style()
    html += css ? `<span style="${css}">${escaped}</span>` : escaped
  }
  for (let match = pattern.exec(ansi); match; match = pattern.exec(ansi)) {
    append(ansi.slice(cursor, match.index))
    const codes = (match[1] || '0').split(';').map(Number)
    for (let index = 0; index < codes.length; index++) {
      const code = codes[index]
      if (code === 0) { bold = false; dim = false; foreground = '' }
      else if (code === 1) bold = true
      else if (code === 2) dim = true
      else if (code === 22) { bold = false; dim = false }
      else if (code === 39) foreground = ''
      else if (code >= 30 && code <= 37) foreground = colors[code - 30]
      else if (code >= 90 && code <= 97) foreground = colors[code - 90]
      else if (code === 38 && codes[index + 1] === 2 && codes.length > index + 4) {
        foreground = `rgb(${codes[index + 2]},${codes[index + 3]},${codes[index + 4]})`
        index += 4
      }
    }
    cursor = pattern.lastIndex
  }
  append(ansi.slice(cursor))
  return html
})

const keyData = (event: KeyboardEvent): string | null => {
  if (event.key === 'Enter' && event.shiftKey) return '\u001b[13;2u'
  if (event.key === 'Enter' && event.ctrlKey) return '\u001b[13;5u'
  if (event.altKey && !event.ctrlKey && !event.metaKey && event.key.length === 1) return `\u001b${event.key}`
  if (event.ctrlKey && !event.altKey && !event.metaKey && event.key.length === 1) {
    const code = event.key.toUpperCase().charCodeAt(0)
    if (code >= 64 && code <= 95) return String.fromCharCode(code - 64)
  }
  const special: Record<string, string> = {
    Enter: '\r',
    Escape: '\u001b',
    Backspace: '\u007f',
    Tab: event.shiftKey ? '\u001b[Z' : '\t',
    ArrowUp: '\u001b[A',
    ArrowDown: '\u001b[B',
    ArrowRight: '\u001b[C',
    ArrowLeft: '\u001b[D',
    Home: '\u001b[H',
    End: '\u001b[F',
    Delete: '\u001b[3~',
    PageUp: '\u001b[5~',
    PageDown: '\u001b[6~',
  }
  if (special[event.key]) return special[event.key]
  if (!event.ctrlKey && !event.metaKey && !event.altKey && event.key.length === 1) return event.key
  return null
}

const onKeydown = (event: KeyboardEvent) => {
  const data = keyData(event)
  if (data === null) return
  event.preventDefault()
  event.stopPropagation()
  void chatStore.sendTuiInput(props.surface.surfaceId, data)
}

const reportSize = () => {
  const element = host.value
  if (!element) return
  const rect = element.getBoundingClientRect()
  const cols = Math.max(20, Math.floor(rect.width / 8))
  const rows = Math.max(4, Math.floor(Math.max(rect.height, 180) / 18))
  if (cols !== props.surface.cols || rows !== props.surface.rows) {
    void chatStore.resizeTui(props.surface.surfaceId, cols, rows)
  }
}

const focus = () => {
  if (props.surface.overlayOptions?.nonCapturing) return
  nextTick(() => host.value?.focus())
}

onMounted(() => {
  observer = new ResizeObserver(reportSize)
  if (host.value) observer.observe(host.value)
  reportSize()
  focus()
})

watch(() => props.surface.revision, focus)
onBeforeUnmount(() => observer?.disconnect())
</script>

<template>
  <div
    v-show="!surface.hidden"
    :class="['extension-tui', overlayClass, { embedded, overlay: surface.overlay && !embedded }]"
    role="application"
    aria-label="Pi extension terminal UI"
  >
    <div v-if="surface.overlay && !embedded" class="extension-tui-backdrop" @click.self="chatStore.closeTui(surface.surfaceId)" />
    <section ref="host" class="extension-tui-screen" :style="overlayStyle" tabindex="0" @keydown="onKeydown">
      <div class="extension-tui-toolbar">
        <span>Pi Extension · {{ surface.kind }}</span>
        <button type="button" title="关闭" @click="chatStore.closeTui(surface.surfaceId)">×</button>
      </div>
      <pre v-html="ansiHtml" />
    </section>
  </div>
</template>

<style scoped>
.extension-tui.overlay { position: absolute; inset: 0; z-index: 80; display: grid; place-items: center; padding: 20px; }
.extension-tui.overlay.anchor-top-left { place-items: start; }
.extension-tui.overlay.anchor-top-right { place-items: start end; }
.extension-tui.overlay.anchor-bottom-left { place-items: end start; }
.extension-tui.overlay.anchor-bottom-right { place-items: end; }
.extension-tui.overlay.anchor-top-center { place-items: start center; }
.extension-tui.overlay.anchor-bottom-center { place-items: end center; }
.extension-tui.overlay.anchor-left-center { place-items: center start; }
.extension-tui.overlay.anchor-right-center { place-items: center end; }
.extension-tui-backdrop { position: absolute; inset: 0; background: color-mix(in srgb, #000 45%, transparent); backdrop-filter: blur(2px); }
.extension-tui-screen { position: relative; width: min(760px, 96%); max-height: min(70vh, 620px); min-height: 180px; overflow: auto; border: 1px solid var(--color-border); border-radius: 10px; background: #101318; color: #e8edf2; box-shadow: 0 18px 60px rgba(0,0,0,.35); outline: none; }
.extension-tui-screen:focus { border-color: var(--color-primary); box-shadow: 0 18px 60px rgba(0,0,0,.35), 0 0 0 2px color-mix(in srgb, var(--color-primary) 30%, transparent); }
.extension-tui-toolbar { position: sticky; top: 0; display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 6px 10px; border-bottom: 1px solid #2d3440; background: #171c23; color: #9aa7b5; font: 11px/1.4 system-ui, sans-serif; z-index: 1; }
.extension-tui-toolbar button { border: 0; background: transparent; color: #b8c2ce; font-size: 18px; line-height: 1; cursor: pointer; }
pre { margin: 0; padding: 14px 16px 18px; min-width: max-content; white-space: pre; font: 13px/1.45 'JetBrains Mono', ui-monospace, SFMono-Regular, Consolas, monospace; tab-size: 2; }
.extension-tui.embedded .extension-tui-screen { width: 100%; max-height: 280px; min-height: 90px; border-radius: 7px; box-shadow: none; }
.extension-tui.embedded .extension-tui-backdrop { display: none; }
</style>
