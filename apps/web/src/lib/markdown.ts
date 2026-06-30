import { marked } from 'marked'
import markedKatex from 'marked-katex-extension'

let configured = false

export function configureMarked() {
  if (configured) return
  configured = true

  marked.use(markedKatex({ throwOnError: false }))
  marked.use({ breaks: true })
}

export function renderMarkdown(text: string): string {
  if (!text) return ''
  configureMarked()
  try {
    return marked.parse(text) as string
  } catch {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')
  }
}
