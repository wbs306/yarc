export async function copyToClipboard(text: string): Promise<boolean> {
  if (!text) return false

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Fall back below. Clipboard API can fail on non-secure origins,
    // unfocused windows, or stricter browser permission settings.
  }

  const activeElement = document.activeElement as HTMLElement | null
  const selection = document.getSelection()
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange()) : []

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.left = '-9999px'
  textarea.style.top = '0'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.focus()
  textarea.select()

  let ok = false
  try {
    ok = document.execCommand('copy')
  } finally {
    document.body.removeChild(textarea)
    if (selection) {
      selection.removeAllRanges()
      for (const range of ranges) selection.addRange(range)
    }
    activeElement?.focus?.()
  }

  if (!ok) throw new Error('复制失败')
  return true
}
