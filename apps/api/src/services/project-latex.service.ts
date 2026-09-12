import { lstat } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import type { ProjectLatexBuild, ProjectLatexTarget } from '@yarc/shared'
import { config } from '../lib/config.js'
import { AppError } from '../lib/errors.js'
import { normalizeProjectRelativePath, resolveProjectPath, resolveProjectRoot } from '../lib/project-path.js'
import { projectHistoryService } from './project-history.service.js'
import { projectGitService } from './project-git.service.js'
import { projectLiveFileManager } from './project-live-file.service.js'
import { latexService } from './latex.service.js'
import { validateProjectLatexSettings } from '../lib/project-latex-settings.js'

type BuildMetadata = Pick<ProjectLatexBuild, 'projectId' | 'targetId' | 'targetName' | 'entry' | 'sourceRoot' | 'checkpointId'>

// Only Project orchestration lives here. Queue, snapshots, Docker, diagnostics,
// cancellation and SyncTeX all belong to the shared LatexService singleton.
export class ProjectLatexService {
  private builds = new Map<string, BuildMetadata>()

  validateTargetSettings(input: { defaultTarget?: unknown; targets?: unknown }) {
    return validateProjectLatexSettings(input)
  }

  async targets(projectId: string) {
    const { project } = await resolveProjectRoot(projectId)
    const latex = ((project.settings || {}) as any).latex || {}
    if (!Array.isArray(latex.targets)) return { defaultTarget: null, targets: [] as ProjectLatexTarget[] }
    return this.validateTargetSettings({ defaultTarget: latex.defaultTarget, targets: latex.targets })
  }

  private async target(projectId: string, targetId: string) {
    const { targets } = await this.targets(projectId)
    const target = targets.find(item => item.id === targetId)
    if (!target) throw new AppError('PROJECT_LATEX_TARGET_NOT_FOUND', 'LaTeX target not found', 404)
    return target
  }

  private async startTrackedBuild(input: {
    projectId: string
    targetId: string
    targetName: string
    entry: string
    sourceRoot: string
    sourceRootFullPath: string
    entryName: string
    engine: ProjectLatexTarget['engine']
    flushPrefix?: string
    checkpointMetadata: Record<string, unknown>
  }): Promise<ProjectLatexBuild> {
    await projectLiveFileManager.flushProject(input.projectId, input.flushPrefix)
    await projectHistoryService.flushPending(input.projectId)
    const git = await projectGitService.status(input.projectId).catch(() => null)
    const checkpoint = await projectHistoryService.checkpoint(input.projectId, {
      kind: 'build',
      metadata: { ...input.checkpointMetadata, git: git ? { branch: git.branch, head: git.head } : null },
      forceBoundary: true,
    })

    try {
      const build = await latexService.startWorkspaceBuild({
        projectId: input.projectId,
        path: input.entry,
        sourceRoot: input.sourceRootFullPath,
        entryName: input.entryName,
        engine: input.engine,
        onSettled: async result => {
          if (checkpoint) await projectHistoryService.updateCheckpointMetadata(input.projectId, checkpoint.id, {
            buildId: result.id,
            success: result.status === 'completed',
            status: result.status,
            ...(result.error ? { error: result.error } : {}),
          })
        },
      })
      this.builds.set(build.id, {
        projectId: input.projectId,
        targetId: input.targetId,
        targetName: input.targetName,
        entry: input.entry,
        sourceRoot: input.sourceRoot,
        ...(checkpoint ? { checkpointId: checkpoint.id } : {}),
      })
      return this.getBuild(input.projectId, build.id)
    } catch (error) {
      if (checkpoint) await projectHistoryService.updateCheckpointMetadata(input.projectId, checkpoint.id, { success: false, status: 'failed' }).catch(() => undefined)
      throw error
    }
  }

  async startBuild(projectId: string, targetId: string): Promise<ProjectLatexBuild> {
    if (!config.latexEnabled) throw new AppError('LATEX_DISABLED', 'LaTeX builds are disabled', 503)
    const target = await this.target(projectId, targetId)
    const sourceRoot = normalizeProjectRelativePath(target.sourceRoot || '.')
    const entry = normalizeProjectRelativePath(target.entry)
    const source = await resolveProjectPath(projectId, sourceRoot)
    const entryResolved = await resolveProjectPath(projectId, entry)
    const relEntry = relative(source.fullPath, entryResolved.fullPath)
    if (!relEntry || relEntry.startsWith('..' + sep) || relEntry === '..' || resolve(source.fullPath, relEntry) !== entryResolved.fullPath) {
      throw new AppError('INVALID_LATEX_ENTRY', 'LaTeX entry must be inside sourceRoot', 400)
    }
    const entryInfo = await lstat(entryResolved.fullPath)
    if (!entryInfo.isFile() || entryInfo.isSymbolicLink()) throw new AppError('INVALID_LATEX_ENTRY', 'LaTeX entry must be a regular file', 400)

    return this.startTrackedBuild({
      projectId,
      targetId,
      targetName: target.name,
      entry,
      sourceRoot: sourceRoot || '.',
      sourceRootFullPath: source.fullPath,
      entryName: relEntry,
      engine: target.engine,
      flushPrefix: sourceRoot,
      checkpointMetadata: { target: targetId, engine: target.engine },
    })
  }

  async startFileBuild(projectId: string, path: string, engine: ProjectLatexTarget['engine'] = 'xelatex'): Promise<ProjectLatexBuild> {
    if (!config.latexEnabled) throw new AppError('LATEX_DISABLED', 'LaTeX builds are disabled', 503)
    if (!['pdflatex', 'xelatex', 'lualatex'].includes(engine)) throw new AppError('LATEX_INVALID_ENGINE', 'Unsupported LaTeX engine', 400)
    const entry = normalizeProjectRelativePath(path)
    if (!entry || !/\.tex$/i.test(entry)) throw new AppError('INVALID_LATEX_ENTRY', 'Only .tex files can be compiled', 400)
    const { root } = await resolveProjectRoot(projectId)
    const entryResolved = await resolveProjectPath(projectId, entry)
    const entryInfo = await lstat(entryResolved.fullPath)
    if (!entryInfo.isFile() || entryInfo.isSymbolicLink()) throw new AppError('INVALID_LATEX_ENTRY', 'LaTeX entry must be a regular file', 400)

    return this.startTrackedBuild({
      projectId,
      targetId: `file:${entry}`,
      targetName: entry,
      entry,
      sourceRoot: '.',
      sourceRootFullPath: root,
      entryName: entry,
      engine,
      checkpointMetadata: { target: entry, engine },
    })
  }

  getBuild(projectId: string, buildId: string): ProjectLatexBuild {
    const metadata = this.builds.get(buildId)
    if (!metadata || metadata.projectId !== projectId) throw new AppError('NOT_FOUND', 'LaTeX build not found', 404)
    return { ...latexService.getBuild(buildId, projectId), ...metadata }
  }

  getLog(projectId: string, buildId: string) {
    return latexService.getBuildLog(buildId, projectId)
  }

  async cancelBuild(projectId: string, buildId: string) {
    await latexService.cancelBuild(buildId, projectId)
    return this.getBuild(projectId, buildId)
  }

  async disposeProject(projectId: string) {
    await latexService.cancelProjectBuilds(projectId)
    for (const [buildId, metadata] of this.builds) {
      if (metadata.projectId === projectId) this.builds.delete(buildId)
    }
  }

  getArtifact(projectId: string, buildId: string, kind: 'pdf' | 'synctex') {
    return latexService.getArtifact(buildId, kind, projectId)
  }

  async querySyncTex(projectId: string, buildId: string, query: Parameters<typeof latexService.querySyncTex>[1]) {
    const build = this.getBuild(projectId, buildId)
    const prefix = build.sourceRoot === '.' ? '' : build.sourceRoot + '/'
    let file: string | undefined
    if (query.direction === 'forward') {
      const projectPath = normalizeProjectRelativePath(query.file || build.entry)
      if (prefix && !projectPath.startsWith(prefix)) throw new AppError('LATEX_INVALID_SOURCE', 'SyncTeX source is outside target sourceRoot', 400)
      file = projectPath.slice(prefix.length)
    }
    const result = await latexService.querySyncTex(buildId, { ...query, file }, projectId)
    // SyncTeX works in snapshot-relative paths; the editor works in Project paths.
    if (result.file) return { ...result, file: prefix + normalizeProjectRelativePath(result.file) }
    return result
  }

  scoped(projectId: string) {
    return {
      getBuild: (id: string) => this.getBuild(projectId, id),
      getBuildLog: (id: string) => this.getLog(projectId, id),
      cancelBuild: (id: string) => this.cancelBuild(projectId, id),
      getArtifact: (id: string, kind: 'pdf' | 'synctex') => this.getArtifact(projectId, id, kind),
      querySyncTex: (id: string, query: Parameters<typeof latexService.querySyncTex>[1]) => this.querySyncTex(projectId, id, query),
    }
  }
}

export const projectLatexService = new ProjectLatexService()
