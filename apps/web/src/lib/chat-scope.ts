import type { CurrentChatResource } from '@yarc/shared'

// Mirrors apps/api/src/services/global-shared-file.service.ts: these data
// roots are never reachable from a project chat through ../../ references.
const PROTECTED_SHARED_ROOTS = new Set(['papers', 'projects', '.pi', '.project-history'])

/** Whether a data-root-relative path may be referenced as ../../path from a project chat. */
export const isPublicSharedFilePath = (path: string) => {
  const segments = path.replace(/\\/g, '/').split('/')
  if (!segments.length || segments.some(segment => !segment || segment === '.' || segment === '..')) return false
  if (PROTECTED_SHARED_ROOTS.has(segments[0])) return false
  return segments.every(segment => !segment.startsWith('.') || segment === '.env.example')
}

export type ScopedChatResource =
  | { resource: CurrentChatResource; notice: '' }
  | { resource: null; notice: string }

/**
 * Adapt the resource shown in the main view to the chat's workspace.
 *
 * The chat scope (global or one project) is independent of the visible page,
 * while file paths in a message are resolved relative to the conversation's
 * workspace. A file owned by another workspace must therefore be translated
 * (public global files become ../../ references in a project chat) or rejected.
 *
 * @param resourceProjectId Workspace owning a file resource; null for the global data root.
 * @param chatProjectId Workspace of the active chat; null for global conversations.
 */
export const scopeChatResource = (
  resource: CurrentChatResource,
  resourceProjectId: string | null,
  chatProjectId: string | null,
): ScopedChatResource => {
  if (resource.type === 'paper' || resourceProjectId === chatProjectId) return { resource, notice: '' }
  if (chatProjectId && !resourceProjectId) {
    return isPublicSharedFilePath(resource.path)
      ? { resource: { ...resource, path: `../../${resource.path}` }, notice: '' }
      : { resource: null, notice: '当前文件位于受保护目录，项目对话无法通过 @current 引用' }
  }
  return {
    resource: null,
    notice: chatProjectId
      ? '当前文件属于其他科研项目，请切换到该项目的对话后再使用 @current'
      : '当前文件属于科研项目，请将对话切换到该项目后再使用 @current',
  }
}
