import type { ObjectDirective } from 'vue'
import type { MarkdownRenderBlock } from './markdown'

interface RenderedBlock {
  html: string
  startLine: number
  nodes: Node[]
}

const rendered = new WeakMap<HTMLElement, Map<number, RenderedBlock>>()

// Vue owns the container; this directive owns only its children. Reconcile the
// actual top-level nodes rather than wrapping blocks (which changes HTML/list
// layout). Unchanged formulas, images and text selections keep their DOM.
function patchBlocks(root: HTMLElement, blocks: MarkdownRenderBlock[]) {
  const previous = rendered.get(root) ?? new Map<number, RenderedBlock>()
  const next = new Map<number, RenderedBlock>()
  for (const block of blocks) {
    let entry = previous.get(block.key)
    // A retained key has the same source and reference context. Inserted lines
    // only shift source-map attributes, not the rendered content or its nodes.
    if (entry && entry.startLine !== block.startLine) {
      const delta = block.startLine - entry.startLine
      for (const node of entry.nodes) {
        if (node.nodeType !== 1) continue
        const element = node as HTMLElement
        const mapped = [element, ...element.querySelectorAll<HTMLElement>('[data-md-source-line]')]
        for (const anchor of mapped) {
          for (const name of ['data-md-source-line', 'data-md-source-line-end']) {
            const line = anchor.getAttribute(name)
            if (line !== null) anchor.setAttribute(name, String(Number(line) + delta))
          }
        }
      }
      entry.html = block.html
      entry.startLine = block.startLine
    }
    if (!entry || entry.html !== block.html) {
      const template = document.createElement('template')
      template.innerHTML = block.html
      entry = { html: block.html, startLine: block.startLine, nodes: Array.from(template.content.childNodes) }
    }
    next.set(block.key, entry)
  }
  // Remove replaced blocks before finding the insertion cursor. Otherwise an
  // obsolete leading node makes every unchanged later node appear out of order.
  for (const [key, entry] of previous) {
    if (next.get(key) === entry) continue
    for (const node of entry.nodes) {
      if (node.parentNode === root) root.removeChild(node)
    }
  }
  let cursor = root.firstChild
  for (const entry of next.values()) {
    for (const node of entry.nodes) {
      if (node === cursor) cursor = cursor.nextSibling
      else root.insertBefore(node, cursor)
    }
  }
  rendered.set(root, next)
}

export const markdownBlockDom: ObjectDirective<HTMLElement, MarkdownRenderBlock[]> = {
  mounted: (root, binding) => patchBlocks(root, binding.value),
  updated: (root, binding) => {
    if (binding.value !== binding.oldValue) patchBlocks(root, binding.value)
  },
  unmounted: root => { rendered.delete(root) },
}
