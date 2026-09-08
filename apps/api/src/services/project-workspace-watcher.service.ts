import { prisma } from '@yarc/db'
import { config } from '../lib/config.js'
import { isProjectPiRuntimeResourcePath, normalizeDataRelativePath } from '../lib/data-sync-policy.js'
import { resolveProjectPath } from '../lib/project-path.js'
import { getDataChangeWatcher } from './data-change-watcher.js'
import { projectHistoryService } from './project-history.service.js'
import { projectLiveFileManager } from './project-live-file.service.js'
import { projectFileService } from './project-file.service.js'
import { installProjectPiContextBridge, projectPiContextService } from './project-pi-context.service.js'

installProjectPiContextBridge()

export class ProjectWorkspaceWatcherService {
  private unsubscribe?: () => void
  private directoryCache = new Map<string, string>()
  private knownTrackedPaths = new Map<string, Set<string>>()

  async start() {
    if (this.unsubscribe) return
    await this.refreshProjects()
    const watcher = getDataChangeWatcher(config.dataDir)
    this.unsubscribe = watcher.subscribe((change: any) => { void this.onChange(change).catch(error => console.warn('[ProjectWatcher]', error?.message || error)) })
  }

  stop() {
    this.unsubscribe?.()
    this.unsubscribe = undefined
    this.knownTrackedPaths.clear()
  }

  private async initializeTrackedPaths(projectId: string) {
    const known = new Set<string>()
    try {
      const paths = await projectHistoryService.listTrackedPaths(projectId)
      for (const path of paths) {
        try {
          await resolveProjectPath(projectId, path)
          if (!(await projectHistoryService.isTracked(projectId, path))) continue
          await projectHistoryService.ensureBaseline(projectId, path)
          known.add(path)
        } catch {
          // Historical missing paths are part of restore state but not the
          // current filesystem observation set.
        }
      }
    } catch (error) {
      console.warn('[ProjectWatcher] failed to initialize writing baselines:', (error as Error).message)
    }
    this.knownTrackedPaths.set(projectId, known)
  }

  async refreshProjects() {
    const projects = await prisma.project.findMany({ select: { id: true, directoryName: true } })
    this.directoryCache = new Map(projects.map(project => [project.directoryName, project.id]))
    for (const project of projects) await this.initializeTrackedPaths(project.id)
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
      await this.initializeTrackedPaths(projectId)
    }
    const relativePath = parts.slice(2).join('/')
    if (!relativePath || relativePath === '.git' || relativePath.startsWith('.git/')) return

    const tracked = await projectHistoryService.isTracked(projectId, relativePath).catch(() => false)
    const known = this.knownTrackedPaths.get(projectId) || new Set<string>()
    this.knownTrackedPaths.set(projectId, known)
    if (tracked && change?.kind !== 'delete' && !known.has(relativePath)) {
      // The watcher observes filesystem changes after they happen. A path not
      // present in the startup/current set is therefore a newly-created writing
      // file from YARC's perspective; record the prior missing state before the
      // external snapshot is queued.
      await projectHistoryService.ensureBaseline(projectId, relativePath, { missing: true }).catch(() => undefined)
      known.add(relativePath)
    }

    await projectLiveFileManager.handleDiskChange(projectId, relativePath).catch(() => undefined)
    if (tracked && change?.kind === 'delete') known.delete(relativePath)
    projectFileService.notifyExternalChange(projectId, relativePath, String(change?.type || change?.action || change?.kind || 'external'))

    if (isProjectPiRuntimeResourcePath(relativePath)) {
      await projectPiContextService.reloadProject(projectId, `project-file:${relativePath}`)
    }
  }
}

export const projectWorkspaceWatcherService = new ProjectWorkspaceWatcherService()
