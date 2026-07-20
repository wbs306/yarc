import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useApi } from '@/composables/useApi'

export type ThemeMode = 'light' | 'dark' | 'auto'
export type BackgroundRotationMode = 'sequential' | 'random'

export interface EditorSettings {
  fontSize: number
  markdownFontSize: number
  tabSize: number
  lineWrap: boolean
  lineNumbers: boolean
}

export interface ThemeSettings {
  mode: ThemeMode
  primaryColor: string
  backgroundImage: string
  /** Mask tint as #rrggbb. Empty = follow the theme background color (adapts light/dark). */
  maskColor: string
  /** Mask opacity 0–100 (%). The single knob the whole frosted cascade derives from. */
  maskOpacity: number
  /** Mask blur in px, applied to the background image itself so the control is visible. */
  maskBlur: number
  backgroundRotation: string[]
  backgroundInterval: number
  backgroundRotationMode: BackgroundRotationMode
  editor: EditorSettings
}

const STORAGE_KEY = 'yarc-theme'

const DEFAULT_EDITOR: EditorSettings = {
  fontSize: 13,
  markdownFontSize: 14,
  tabSize: 2,
  lineWrap: true,
  lineNumbers: true,
}

const DEFAULT_THEME: ThemeSettings = {
  mode: 'light',
  primaryColor: '#6366f1',
  backgroundImage: '',
  maskColor: '',
  maskOpacity: 70,
  maskBlur: 12,
  backgroundRotation: [],
  backgroundInterval: 60,
  backgroundRotationMode: 'sequential',
  editor: { ...DEFAULT_EDITOR },
}

const BACKGROUND_PRESETS: Record<string, string> = {
  mountain: 'linear-gradient(135deg, #0f172a 0%, #334155 42%, #93c5fd 100%)',
  ocean: 'linear-gradient(135deg, #082f49 0%, #0891b2 48%, #bae6fd 100%)',
  forest: 'linear-gradient(135deg, #052e16 0%, #15803d 48%, #bbf7d0 100%)',
  city: 'linear-gradient(135deg, #111827 0%, #7c3aed 45%, #f0abfc 100%)',
}

export { BACKGROUND_PRESETS }

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

const normalizeHex = (color: string) => {
  const value = color.trim()
  if (/^#[0-9a-f]{6}$/i.test(value)) return value
  return DEFAULT_THEME.primaryColor
}

const hexToRgb = (hex: string) => {
  const normalized = normalizeHex(hex).slice(1)
  return {
    r: parseInt(normalized.slice(0, 2), 16),
    g: parseInt(normalized.slice(2, 4), 16),
    b: parseInt(normalized.slice(4, 6), 16),
  }
}

const rgbToHex = (r: number, g: number, b: number) =>
  `#${[r, g, b].map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('')}`

const mix = (color: string, target: { r: number; g: number; b: number }, ratio: number) => {
  const rgb = hexToRgb(color)
  return rgbToHex(
    rgb.r + (target.r - rgb.r) * ratio,
    rgb.g + (target.g - rgb.g) * ratio,
    rgb.b + (target.b - rgb.b) * ratio
  )
}

const backgroundCssValue = (value: string) => {
  if (!value) return 'none'
  if (BACKGROUND_PRESETS[value]) return BACKGROUND_PRESETS[value]
  if (/^(https?:\/\/|\/api\/|\/)/.test(value)) {
    const escaped = value.replace(/"/g, '%22')
    return `url("${escaped}")`
  }
  return 'none'
}

export const useThemeStore = defineStore('theme', () => {
  const mode = ref<ThemeMode>(DEFAULT_THEME.mode)
  const primaryColor = ref(DEFAULT_THEME.primaryColor)
  const backgroundImage = ref(DEFAULT_THEME.backgroundImage)
  const maskColor = ref(DEFAULT_THEME.maskColor)
  const maskOpacity = ref(DEFAULT_THEME.maskOpacity)
  const maskBlur = ref(DEFAULT_THEME.maskBlur)
  const backgroundRotation = ref<string[]>(DEFAULT_THEME.backgroundRotation)
  const backgroundInterval = ref(DEFAULT_THEME.backgroundInterval)
  const backgroundRotationMode = ref<BackgroundRotationMode>(DEFAULT_THEME.backgroundRotationMode)
  const editor = ref<EditorSettings>({ ...DEFAULT_EDITOR })
  const syncError = ref('')
  const syncing = ref(false)
  let rotationTimer: ReturnType<typeof setInterval> | null = null

  let saveTimer: ReturnType<typeof setTimeout> | null = null

  // Background crossfade state: which pseudo-layer (::before=a / ::after=b) is
  // showing, and the last image applied so opacity/blur tweaks don't retrigger a fade.
  let bgLayer: 'a' | 'b' = 'a'
  let shownImage = ''

  const snapshot = (): ThemeSettings => ({
    mode: mode.value,
    primaryColor: primaryColor.value,
    backgroundImage: backgroundImage.value,
    maskColor: maskColor.value,
    maskOpacity: maskOpacity.value,
    maskBlur: maskBlur.value,
    backgroundRotation: backgroundRotation.value,
    backgroundInterval: backgroundInterval.value,
    backgroundRotationMode: backgroundRotationMode.value,
    editor: { ...editor.value },
  })

  const applyThemeObject = (theme: Partial<ThemeSettings>) => {
    if (theme.mode === 'light' || theme.mode === 'dark' || theme.mode === 'auto') mode.value = theme.mode
    if (typeof theme.primaryColor === 'string') primaryColor.value = normalizeHex(theme.primaryColor)
    if (typeof theme.backgroundImage === 'string') backgroundImage.value = theme.backgroundImage
    if (typeof theme.maskColor === 'string') maskColor.value = theme.maskColor
    if (typeof theme.maskOpacity === 'number') maskOpacity.value = clamp(theme.maskOpacity, 0, 100)
    if (typeof theme.maskBlur === 'number') maskBlur.value = clamp(theme.maskBlur, 0, 40)
    if (Array.isArray(theme.backgroundRotation)) backgroundRotation.value = theme.backgroundRotation
    if (typeof theme.backgroundInterval === 'number') backgroundInterval.value = Math.max(10, theme.backgroundInterval)
    if (theme.backgroundRotationMode === 'sequential' || theme.backgroundRotationMode === 'random') {
      backgroundRotationMode.value = theme.backgroundRotationMode
    }
    if (theme.editor && typeof theme.editor === 'object') {
      const e = theme.editor
      editor.value = {
        fontSize: typeof e.fontSize === 'number' ? clamp(e.fontSize, 10, 24) : DEFAULT_EDITOR.fontSize,
        markdownFontSize: typeof e.markdownFontSize === 'number' ? clamp(e.markdownFontSize, 10, 24) : DEFAULT_EDITOR.markdownFontSize,
        tabSize: typeof e.tabSize === 'number' ? clamp(e.tabSize, 2, 8) : DEFAULT_EDITOR.tabSize,
        lineWrap: typeof e.lineWrap === 'boolean' ? e.lineWrap : DEFAULT_EDITOR.lineWrap,
        lineNumbers: typeof e.lineNumbers === 'boolean' ? e.lineNumbers : DEFAULT_EDITOR.lineNumbers,
      }
    }
  }

  const resolvedMode = () => {
    if (mode.value !== 'auto') return mode.value
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }

  const applyTheme = () => {
    const root = document.documentElement
    const body = document.body
    const resolved = resolvedMode()
    const primary = normalizeHex(primaryColor.value)
    const rgb = hexToRgb(primary)

    root.setAttribute('data-theme', resolved)
    root.style.setProperty('--color-primary', primary)
    root.style.setProperty('--color-primary-rgb', `${rgb.r}, ${rgb.g}, ${rgb.b}`)
    root.style.setProperty('--color-primary-hover', mix(primary, { r: 0, g: 0, b: 0 }, resolved === 'dark' ? 0.08 : 0.15))
    root.style.setProperty('--color-primary-soft', `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${resolved === 'dark' ? 0.18 : 0.12})`)

    // Keep the browser/PWA title bar aligned with the actual light or dark
    // background instead of using the accent color as a fixed chrome color.
    const browserThemeColor = getComputedStyle(root).getPropertyValue('--color-bg').trim()
    const themeColorMeta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    if (browserThemeColor && themeColorMeta) themeColorMeta.content = browserThemeColor

    // Background image: crossfade across two layers so rotation / manual switches
    // fade smoothly instead of snapping. Only retrigger when the image truly changes.
    const img = backgroundCssValue(backgroundImage.value)
    if (img !== shownImage) {
      shownImage = img
      bgLayer = bgLayer === 'a' ? 'b' : 'a'
      const vis = img === 'none' ? '0' : '1'
      if (bgLayer === 'a') {
        root.style.setProperty('--bg-image-a', img)
        root.style.setProperty('--bg-op-a', vis)
        root.style.setProperty('--bg-op-b', '0')
      } else {
        root.style.setProperty('--bg-image-b', img)
        root.style.setProperty('--bg-op-b', vis)
        root.style.setProperty('--bg-op-a', '0')
      }
    }
    // A single frosted mask (color / opacity / blur) tints every panel, derived
    // from one knob with small per-region offsets for layering.
    const mc = maskColor.value.trim()
    if (/^#[0-9a-f]{6}$/i.test(mc)) {
      const m = hexToRgb(mc)
      root.style.setProperty('--mask-rgb', `${m.r}, ${m.g}, ${m.b}`)
    } else {
      root.style.removeProperty('--mask-rgb') // fall back to --color-bg-rgb (adapts light/dark)
    }
    const maskOp = clamp(maskOpacity.value, 0, 100) / 100
    root.style.setProperty('--mask-opacity', String(maskOp))
    root.style.setProperty('--mask-opacity-side', String(clamp(maskOp + 0.06, 0, 1)))
    root.style.setProperty('--mask-opacity-card', String(clamp(maskOp + 0.18, 0, 0.98)))
    root.style.setProperty('--mask-blur', `${clamp(maskBlur.value, 0, 40)}px`)
    body?.setAttribute('data-app-background', backgroundImage.value ? 'on' : 'off')
  }

  const persistLocal = () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot()))
  }

  const syncRemote = async () => {
    syncing.value = true
    syncError.value = ''
    try {
      await useApi().updateTheme(snapshot())
    } catch (err) {
      syncError.value = (err as Error).message || '主题同步失败'
    } finally {
      syncing.value = false
    }
  }

  const scheduleRemoteSync = () => {
    if (saveTimer) window.clearTimeout(saveTimer)
    saveTimer = window.setTimeout(() => { void syncRemote() }, 350)
  }

  const commit = () => {
    applyTheme()
    persistLocal()
    scheduleRemoteSync()
  }

  const init = () => {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved) {
      try { applyThemeObject(JSON.parse(saved)) } catch {}
    }
    applyTheme()
    window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', applyTheme)
  }

  const loadRemote = async () => {
    try {
      const res = await useApi().getTheme()
      if (res.theme && typeof res.theme === 'object') {
        applyThemeObject(res.theme)
        applyTheme()
        persistLocal()
        startRotation()
      }
    } catch {
      // 未登录或后端不可用时保留本地主题。
    }
  }

  const setMode = (value: ThemeMode) => {
    mode.value = value
    commit()
  }

  const toggleMode = () => {
    setMode(resolvedMode() === 'light' ? 'dark' : 'light')
  }

  const setPrimaryColor = (color: string) => {
    primaryColor.value = normalizeHex(color)
    commit()
  }

  const setBackgroundImage = (value: string) => {
    backgroundImage.value = value
    commit()
  }

  const removeBackgroundImages = (values: string[]) => {
    const removed = new Set(values)
    const wasActive = removed.has(backgroundImage.value)
    const nextRotation = backgroundRotation.value.filter((image) => !removed.has(image))
    const rotationChanged = nextRotation.length !== backgroundRotation.value.length

    if (!wasActive && !rotationChanged) return
    if (wasActive) backgroundImage.value = ''
    backgroundRotation.value = nextRotation
    commit()
    if (rotationChanged) startRotation()
  }

  const removeBackgroundImage = (value: string) => removeBackgroundImages([value])

  const setMaskColor = (value: string) => {
    maskColor.value = value
    commit()
  }

  const setMaskOpacity = (value: number) => {
    maskOpacity.value = clamp(value, 0, 100)
    commit()
  }

  const setMaskBlur = (value: number) => {
    maskBlur.value = clamp(value, 0, 40)
    commit()
  }

  const setBackgroundRotation = (images: string[]) => {
    backgroundRotation.value = images
    commit()
    startRotation()
  }

  const setBackgroundInterval = (seconds: number) => {
    backgroundInterval.value = Math.max(10, seconds)
    commit()
    startRotation()
  }

  const setBackgroundRotationMode = (value: string) => {
    if (value !== 'sequential' && value !== 'random') return
    backgroundRotationMode.value = value
    commit()
  }

  const setEditorSetting = <K extends keyof EditorSettings>(key: K, value: EditorSettings[K]) => {
    editor.value = { ...editor.value, [key]: value }
    commit()
  }

  const resetAll = () => {
    applyThemeObject({ ...DEFAULT_THEME, editor: { ...DEFAULT_EDITOR } })
    backgroundRotation.value = []
    commit()
    startRotation()
  }
  const toggleRotationImage = (img: string) => {
    const idx = backgroundRotation.value.indexOf(img)
    if (idx >= 0) backgroundRotation.value.splice(idx, 1)
    else backgroundRotation.value.push(img)
    commit()
    startRotation()
  }

  const startRotation = () => {
    if (rotationTimer) { clearInterval(rotationTimer); rotationTimer = null }
    if (backgroundRotation.value.length < 2) return
    rotationTimer = setInterval(() => {
      const imgs = backgroundRotation.value
      if (!imgs.length) return
      const cur = imgs.indexOf(backgroundImage.value)
      const next = backgroundRotationMode.value === 'random'
        ? (() => {
            const candidates = cur >= 0 ? imgs.filter((image) => image !== backgroundImage.value) : imgs
            return candidates[Math.floor(Math.random() * candidates.length)]
          })()
        : imgs[(cur + 1) % imgs.length]
      backgroundImage.value = next
      applyTheme()
      persistLocal()
    }, backgroundInterval.value * 1000)
  }

  init()
  startRotation()

  return {
    mode,
    primaryColor,
    backgroundImage,
    maskColor,
    maskOpacity,
    maskBlur,
    backgroundRotation,
    backgroundInterval,
    backgroundRotationMode,
    editor,
    syncError,
    syncing,
    loadRemote,
    toggleMode,
    setMode,
    setPrimaryColor,
    setBackgroundImage,
    removeBackgroundImage,
    removeBackgroundImages,
    setMaskColor,
    setMaskOpacity,
    setMaskBlur,
    setBackgroundRotation,
    setBackgroundInterval,
    setBackgroundRotationMode,
    setEditorSetting,
    resetAll,
    toggleRotationImage,
  }
})
