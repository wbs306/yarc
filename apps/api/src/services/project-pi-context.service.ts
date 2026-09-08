import { config } from '../lib/config.js'
import { withAgentWorkspaceCwd } from '../lib/agent-workspace.js'
import { resolveConversationWorkspace } from '../lib/conversation-workspace.js'
import { piService } from './pi.service.js'
import { projectLiveFileManager } from './project-live-file.service.js'

const service = piService as any
let installed = false

const workspaceForConversation = async (conversationId?: string) => {
  if (!conversationId) return { kind: 'global' as const, cwd: config.dataDir, projectId: undefined }
  const workspace = await resolveConversationWorkspace(conversationId)
  if (workspace.projectId) await projectLiveFileManager.get(workspace.projectId)
  return workspace
}

const wrapPromiseMethod = (name: string, conversationIdFromArgs: (args: any[]) => string | undefined) => {
  const original = service[name]?.bind(piService)
  if (typeof original !== 'function') return
  service[name] = async (...args: any[]) => {
    const workspace = await workspaceForConversation(conversationIdFromArgs(args))
    return withAgentWorkspaceCwd(workspace.cwd, () => original(...args))
  }
}

const wrapGeneratorMethod = (name: string, conversationIdFromArgs: (args: any[]) => string | undefined) => {
  const original = service[name]?.bind(piService)
  if (typeof original !== 'function') return
  service[name] = async function* (...args: any[]) {
    const workspace = await workspaceForConversation(conversationIdFromArgs(args))
    const generator = withAgentWorkspaceCwd(workspace.cwd, () => original(...args)) as AsyncGenerator<any>
    try {
      while (true) {
        const step = await withAgentWorkspaceCwd(workspace.cwd, () => generator.next())
        if (step.done) return step.value
        yield step.value
      }
    } finally {
      if (typeof generator.return === 'function') {
        await withAgentWorkspaceCwd(workspace.cwd, () => generator.return!(undefined)).catch(() => undefined)
      }
    }
  }
}

export const installProjectPiContextBridge = () => {
  if (installed) return
  installed = true

  // PiService intentionally owns one global agentDir/sessionDir, but legacy
  // helper paths read ensureAgentWorkspace().cwd while constructing tools and
  // fallback sessions. AsyncLocalStorage lets those paths observe the current
  // Conversation workspace without changing the shared Pi configuration.
  const originalCreateRuntimeToolHost = service.createRuntimeToolHost?.bind(piService)
  if (typeof originalCreateRuntimeToolHost === 'function') {
    service.createRuntimeToolHost = async (context: any) => {
      const cwd = context?.cwd || config.dataDir
      if (context?.projectId) await projectLiveFileManager.get(context.projectId)
      return withAgentWorkspaceCwd(cwd, () => originalCreateRuntimeToolHost(context))
    }
  }

  wrapGeneratorMethod('completeEvents', args => args[0]?.conversationId)
  wrapGeneratorMethod('compactEvents', args => args[0]?.conversationId)
  wrapPromiseMethod('answerSideQuestion', args => args[0]?.conversationId)
  wrapPromiseMethod('getConversationContextUsage', args => args[0])
  wrapPromiseMethod('forkSessionForBranch', args => args[0])
  wrapPromiseMethod('persistFailedTurn', args => args[0]?.conversationId)
}

export const projectPiContextService = {
  install: installProjectPiContextBridge,
  async reloadProject(projectId: string, reason = 'project-config') {
    const registry = service.runtimeRegistry
    if (registry?.reloadProject) await registry.reloadProject(projectId, reason)
  },
  async disposeProject(projectId: string, reason = 'project_deleted') {
    const registry = service.runtimeRegistry
    if (registry?.disposeProject) await registry.disposeProject(projectId, reason)
  },
}
