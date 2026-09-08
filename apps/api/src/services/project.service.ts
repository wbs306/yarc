import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { lstat, mkdir, rm, writeFile } from 'node:fs/promises'
import { prisma } from '@yarc/db'
import { config } from '../lib/config.js'
import { AppError } from '../lib/errors.js'
import { resolveProjectRoot, resolveProjectRootByDirectoryName, validateProjectDirectoryName } from '../lib/project-path.js'

const DEFAULT_GITIGNORE = `# LaTeX transient files
*.aux
*.log
*.out
*.toc
*.synctex.gz
*.fls
*.fdb_latexmk
*.bbl
*.blg

# OS/editor noise
.DS_Store
Thumbs.db
`

const run = (command: string, args: string[], cwd: string) => new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
  const child = spawn(command, args, { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk.toString() })
  child.stderr.on('data', chunk => { stderr += chunk.toString() })
  child.once('error', reject)
  child.once('close', code => {
    if (code === 0) resolve({ stdout, stderr })
    else reject(new Error(stderr.trim() || `${command} exited with ${code}`))
  })
})

const slugify = (name: string) => name
  .trim()
  .toLowerCase()
  .normalize('NFKD')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 64)
  .replace(/-+$/g, '')

const automaticDirectoryName = (name: string) => slugify(name) || `project-${randomUUID().slice(0, 8)}`

export class ProjectService {
  async list(options: { archived?: boolean } = {}) {
    return prisma.project.findMany({
      where: options.archived === true ? { archivedAt: { not: null } } : { archivedAt: null },
      orderBy: { updatedAt: 'desc' },
    })
  }

  async get(id: string) {
    const project = await prisma.project.findUnique({ where: { id } })
    if (!project) throw new AppError('PROJECT_NOT_FOUND', 'Project not found', 404)
    return project
  }

  async create(input: { name: string; directoryName?: string; description?: string; settings?: Record<string, unknown> }) {
    const name = input.name?.trim()
    if (!name) throw new AppError('VALIDATION_ERROR', 'Project name is required', 400)
    const directoryName = validateProjectDirectoryName(input.directoryName?.trim() || automaticDirectoryName(name))
    const root = resolveProjectRootByDirectoryName(directoryName)
    await mkdir(config.projectsDir, { recursive: true })
    try {
      await lstat(root)
      throw new AppError('PROJECT_DIRECTORY_EXISTS', 'Project directory already exists', 409)
    } catch (error: any) {
      if (error instanceof AppError) throw error
      if (error?.code !== 'ENOENT') throw error
    }

    await mkdir(root, { recursive: false })
    try {
      await run('git', ['init'], root)
      await writeFile(`${root}/.gitignore`, DEFAULT_GITIGNORE, { flag: 'wx' })
      return await prisma.project.create({
        data: {
          name,
          directoryName,
          description: input.description?.trim() || null,
          settings: (input.settings || {}) as any,
        },
      })
    } catch (error) {
      await rm(root, { recursive: true, force: true }).catch(() => undefined)
      if ((error as any)?.code === 'P2002') throw new AppError('PROJECT_DIRECTORY_EXISTS', 'Project directory is already registered', 409)
      throw error
    }
  }

  async update(id: string, input: { name?: string; description?: string | null; settings?: Record<string, unknown> }) {
    await this.get(id)
    const data: any = { updatedAt: new Date() }
    if (input.name !== undefined) {
      const name = input.name.trim()
      if (!name) throw new AppError('VALIDATION_ERROR', 'Project name is required', 400)
      data.name = name
    }
    if (input.description !== undefined) data.description = input.description?.trim() || null
    if (input.settings !== undefined) data.settings = input.settings
    return prisma.project.update({ where: { id }, data })
  }

  async archive(id: string) {
    await this.get(id)
    return prisma.project.update({ where: { id }, data: { archivedAt: new Date(), updatedAt: new Date() } })
  }

  async unarchive(id: string) {
    await this.get(id)
    return prisma.project.update({ where: { id }, data: { archivedAt: null, updatedAt: new Date() } })
  }

  async delete(id: string) {
    const { root } = await resolveProjectRoot(id)
    const conversations = await prisma.conversation.findMany({ where: { projectId: id }, select: { id: true, metadata: true } })
    const { piService } = await import('./pi.service.js')
    const { projectHistoryService } = await import('./project-history.service.js')
    const { projectLiveFileManager } = await import('./project-live-file.service.js')
    const { projectPiContextService } = await import('./project-pi-context.service.js')

    // Preserve every writable Project buffer before deleting the workspace.
    // A live conflict intentionally blocks permanent deletion rather than
    // silently discarding one side of the edit.
    await projectLiveFileManager.flushProject(id)
    await projectHistoryService.flushPending(id)
    await projectPiContextService.disposeProject(id, 'project_deleted').catch(() => undefined)
    await projectLiveFileManager.disposeProject(id).catch(() => undefined)
    for (const conversation of conversations) {
      await piService.disposeConversationRuntime(conversation.id, 'project_deleted').catch(() => undefined)
      await piService.deleteSessionFiles(conversation.metadata as Record<string, unknown>).catch(() => undefined)
    }

    const verified = await resolveProjectRoot(id)
    if (verified.root !== root) throw new AppError('PROJECT_INVALID_DIRECTORY', 'Project root changed during deletion', 409)
    await prisma.project.delete({ where: { id } })
    await rm(root, { recursive: true, force: true })
    await projectHistoryService.runRetentionGc(id, { projectDeleted: true }).catch(() => undefined)
    return { deleted: true }
  }
}

export const projectService = new ProjectService()
