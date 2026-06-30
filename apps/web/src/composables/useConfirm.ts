import { ref, shallowRef } from 'vue'

export type ConfirmIcon = 'trash' | 'alert' | 'reset'

export interface ConfirmAction<T extends string = string> {
  label: string
  value: T
  variant?: 'primary' | 'danger' | 'ghost'
}

export interface ConfirmOptions<T extends string = string> {
  /** Bold heading. Optional — falls back to a neutral default. */
  title?: string
  /** Body text explaining what will happen. */
  message: string
  /** Label for the affirmative button. */
  confirmText?: string
  /** Label for the dismissive button. */
  cancelText?: string
  /** Optional explicit actions. If set, confirmText is ignored. */
  actions?: ConfirmAction<T>[]
  /** Red styling for destructive actions. */
  danger?: boolean
  /** Glyph shown in the badge. Defaults to 'trash' for danger, else 'alert'. */
  icon?: ConfirmIcon
}

const open = ref(false)
const current = shallowRef<ConfirmOptions | null>(null)
let resolver: ((value: any) => void) | null = null

/**
 * Imperative confirmation. Resolves true if the user confirms, false otherwise.
 *
 *   if (await confirm({ title: '删除对话', message: '…', danger: true })) { … }
 *
 * A single <ConfirmDialog /> host (mounted in App.vue) renders the state.
 */
export function confirm(options: ConfirmOptions | string): Promise<boolean> {
  const opts = typeof options === 'string' ? { message: options } : options
  // A second call before the first resolves cancels the first.
  if (resolver) { resolver(false); resolver = null }
  current.value = opts
  open.value = true
  return new Promise<boolean>((resolve) => { resolver = resolve })
}

export function confirmChoice<T extends string>(options: ConfirmOptions<T> & { actions: ConfirmAction<T>[] }): Promise<T | false> {
  if (resolver) { resolver(false); resolver = null }
  current.value = options
  open.value = true
  return new Promise<T | false>((resolve) => { resolver = resolve })
}

function settle(value: any) {
  if (!open.value) return
  open.value = false
  if (resolver) { resolver(value); resolver = null }
}

/** Consumed by the host component only. */
export function useConfirm() {
  return {
    open,
    current,
    accept: () => settle(current.value?.actions?.[0]?.value ?? true),
    choose: (value: string) => settle(value),
    cancel: () => settle(false),
  }
}
