import { resolve, sep } from 'node:path'
import { resolveProjectRoot } from '../lib/project-path.js'
import { LiveFileService, liveFileService } from './live-file.service.js'
import { projectHistoryService } from './project-history.service.js'

export class ProjectLiveFileManager {
  private instances = new Map<string, { root: string; service: LiveFileService }>()
  private agentRoutingInstalled = false

  async get(projectId: string) {
    const { root } = await resolveProjectRoot(projectId)
    const existing = this.instances.get(projectId)
    if (existing?.root === root) return existing.service
    if (existing) await existing.service.disposeAll().catch(() => undefined)
    const service = new LiveFileService({
      rootDir: root,
      workspaceKind: 'project',
      projectId,
      beforeWrite: async (path) => { await projectHistoryService.ensureBaseline(projectId, path) },
      afterWrite: async (path, source) => { await projectHistoryService.trackChange(projectId, path, source === 'agent' || source === 'disk' ? 'external' : 'autosave') },
    })
    this.instances.set(projectId, { root, service })
    return service
  }

  private serviceForAbsolutePath(absolutePath: string) {
    const target = resolve(absolutePath)
    for (const instance of this.instances.values()) {
      if (target === instance.root || target.startsWith(`${instance.root}${sep}`)) return instance.service
    }
    return null
  }

  installGlobalAgentRouting() {
    if (this.agentRoutingInstalled) return
    this.agentRoutingInstalled = true

    // PiService's workspace tools share one global LiveFileService reference.
    // Once a Project runtime is materialized, route absolute paths under that
    // Project to its isolated LiveFileService so agent edits participate in the
    // same Yjs conflict handling and Writing History as browser edits.
    const readAgentFile = liveFileService.readAgentFile.bind(liveFileService)
    const accessAgentFile = liveFileService.accessAgentFile.bind(liveFileService)
    const writeAgentFile = liveFileService.writeAgentFile.bind(liveFileService)

    liveFileService.readAgentFile = async (absolutePath: string) => {
      const service = this.serviceForAbsolutePath(absolutePath)
      return service ? service.readAgentFile(absolutePath) : readAgentFile(absolutePath)
    }
    liveFileService.accessAgentFile = async (absolutePath: string) => {
      const service = this.serviceForAbsolutePath(absolutePath)
      if (service) return service.accessAgentFile(absolutePath)
      return accessAgentFile(absolutePath)
    }
    liveFileService.writeAgentFile = async (absolutePath: string, content: string, baseContent?: string) => {
      const service = this.serviceForAbsolutePath(absolutePath)
      if (service) return service.writeAgentFile(absolutePath, content, baseContent)
      return writeAgentFile(absolutePath, content, baseContent)
    }
  }

  async flushProject(projectId: string, prefix = '') {
    const service = await this.get(projectId)
    return service.flushAll(prefix)
  }

  async hasSessions(projectId: string, prefix = '') {
    const service = await this.get(projectId)
    const normalized = prefix.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    const sessions: Map<string, unknown> | undefined = (service as any).sessions
    if (!sessions) return false
    return [...sessions.keys()].some(path => !normalized || path === normalized || path.startsWith(`${normalized}/`))
  }

  async refreshProject(projectId: string) {
    const service = await this.get(projectId)
    const sessions: Map<string, unknown> | undefined = (service as any).sessions
    if (!sessions) return
    for (const path of [...sessions.keys()]) await service.handleDiskChange(path)
  }

  async refreshPaths(projectId: string, paths: string[]) {
    const service = await this.get(projectId)
    for (const path of [...new Set(paths)]) {
      if (service.hasSession(path)) await service.handleDiskChange(path)
    }
  }

  async handleDiskChange(projectId: string, path: string) {
    const service = await this.get(projectId)
    const result = await service.handleDiskChange(path)
    // A global DATA_DIR watcher will also see writes that this Project's own
    // LiveFile watcher already published. `self` means the disk hash is exactly
    // our last flush and must not be mislabeled as an external revision.
    if (result !== 'self') await projectHistoryService.trackChange(projectId, path, 'external')
    return result
  }

  async disposeProject(projectId: string) {
    const instance = this.instances.get(projectId)
    if (!instance) return
    this.instances.delete(projectId)
    await instance.service.disposeAll()
  }

  async disposeAll() {
    const instances = [...this.instances.values()]
    this.instances.clear()
    await Promise.allSettled(instances.map(instance => instance.service.disposeAll()))
  }
}

export const projectLiveFileManager = new ProjectLiveFileManager()
projectLiveFileManager.installGlobalAgentRouting()
