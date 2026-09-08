import { resolveProjectRoot } from '../lib/project-path.js'
import { LiveFileService } from './live-file.service.js'
import { projectHistoryService } from './project-history.service.js'

export class ProjectLiveFileManager {
  private instances = new Map<string, { root: string; service: LiveFileService }>()

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

  async flushProject(projectId: string, prefix = '') {
    const service = await this.get(projectId)
    return service.flushAll(prefix)
  }

  async handleDiskChange(projectId: string, path: string) {
    const service = await this.get(projectId)
    const result = await service.handleDiskChange(path)
    await projectHistoryService.trackChange(projectId, path, 'external')
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
