import { prisma } from '@yarc/db'
import { config } from '../lib/config.js'
import { isProjectPiRuntimeResourcePath, normalizeDataRelativePath } from '../lib/data-sync-policy.js'
import { getDataChangeWatcher } from './data-change-watcher.js'
import { projectHistoryService } from './project-history.service.js'
import { projectLiveFileManager } from './project-live-file.service.js'
import { projectFileService } from './project-file.service.js'
import { piService } from './pi.service.js'

export class ProjectWorkspaceWatcherService {
  private unsubscribe?: () => void
  private directoryCache = new Map<string, string>()

  async start() {
    if (this.unsubscribe) return
    await this.refreshProjects()
    const watcher = getDataChangeWatcher(config.dataDir)
    this.unsubscribe = watcher.subscribe((change: any) => { void this.onChange(change).catch(error => console.warn('[ProjectWatcher]', error?.message || error)) })
  }

  stop() {
    this.unsubscribe?.()
    this.unsubscribe = undefined
  }

  async refreshProjects() {
    const projects = await prisma.project.findMany({ select: { id: true, directoryName: true } })
    this.directoryCache = new Map(projects.map(project => [project.directoryName, project.id]))
  }

  private async onChange(change: any) {
    const path = normalizeDataRelativePath(String(change?.path || ''))
    if (!path.startsWith('projects/')) return
    const parts = path.split('/')
    const directoryName = parts[1]
    if (!directoryName) return
    let projectId = this.directoryCache.get(directoryName)
    if (!projectId) {
      const project = await prisma.project.findUnique({ where: { directoryName }, select: { id: true } })
      if (!project) return
      projectId = project.id
      this.directoryCache.set(directoryName, projectId)
    }
    const relativePath = parts.slice(2).join('/')
    if (!relativePath || relativePath === '.git' || relativePath.startsWith('.git/')) return

    await projectLiveFileManager.handleDiskChange(projectId, relativePath).catch(() => undefined)
    await projectHistoryService.trackChange(projectId, relativePath, 'external').catch(() => undefined)
    projectFileService.notifyExternalChange(projectId, relativePath, String(change?.type || change?.action || 'external'))

    if (isProjectPiRuntimeResourcePath(relativePath)) {
      const registry = (piService as any).runtimeRegistry
      if (registry?.reloadProject) await registry.reloadProject(projectId, `project-file:${relativePath}`)
    }
  }
}

export const projectWorkspaceWatcherService = new ProjectWorkspaceWatcherService()
