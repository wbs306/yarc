import { AsyncLocalStorage } from 'node:async_hooks'
import { config } from '../lib/config.js'
import { withAgentWorkspaceCwd } from '../lib/agent-workspace.js'
import { resolveConversationWorkspace } from '../lib/conversation-workspace.js'
import { piService } from './pi.service.js'
import { projectLiveFileManager } from './project-live-file.service.js'

const service = piService as any
const projectPromptContext = new AsyncLocalStorage<boolean>()
const preparedRegistries = new WeakSet<object>()
let installed = false

const workspaceForConversation = async (conversationId?: string) => {
  if (!conversationId) return { kind: 'global' as const, cwd: config.dataDir, projectId: undefined }
  const workspace = await resolveConversationWorkspace(conversationId)
  if (workspace.projectId) await projectLiveFileManager.get(workspace.projectId)
  return workspace
}

const prepareRegistry = (registry: any) => {
  if (!registry || preparedRegistries.has(registry)) return registry
  preparedRegistries.add(registry)

  // The registry historically injects YARC's default chat system prompt into
  // every worker. For a Project that would mask the ResourceLoader's
  // PROJECT_ROOT/.pi/SYSTEM.md and APPEND_SYSTEM.md. Make that default conditional
  // on the current runtime creation context while preserving conversation-level
  // systemPrompt as the highest-priority explicit override.
  const options = registry.options
  if (options && typeof options === 'object') {
    let globalDefaultSystemPrompt = options.systemPrompt
    try {
      Object.defineProperty(options, 'systemPrompt', {
        configurable: true,
        enumerable: true,
        get: () => projectPromptContext.getStore() ? undefined : globalDefaultSystemPrompt,
        set: value => { globalDefaultSystemPrompt = value },
      })
    } catch {}
  }

  const originalCreateRuntime = registry.createRuntime?.bind(registry)
  if (typeof originalCreateRuntime === 'function') {
    registry.createRuntime = async (...args: any[]) => {
      const workspace = await workspaceForConversation(args[0]?.conversationId)
      return projectPromptContext.run(workspace.kind === 'project', () =>
        withAgentWorkspaceCwd(workspace.cwd, () => originalCreateRuntime(...args)))
    }
  }
  return registry
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
  const originalGetRuntimeRegistry = service.getRuntimeRegistry?.bind(piService)
  if (typeof originalGetRuntimeRegistry === 'function') {
    service.getRuntimeRegistry = (...args: any[]) => prepareRegistry(originalGetRuntimeRegistry(...args))
  }
  if (service.runtimeRegistry) prepareRegistry(service.runtimeRegistry)

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
    const registry = prepareRegistry(service.runtimeRegistry)
    if (registry?.reloadProject) await registry.reloadProject(projectId, reason)
  },
  async disposeProject(projectId: string, reason = 'project_deleted') {
    const registry = prepareRegistry(service.runtimeRegistry)
    if (registry?.disposeProject) await registry.disposeProject(projectId, reason)
  },
}
