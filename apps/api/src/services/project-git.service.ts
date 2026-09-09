import { spawn } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import type { ProjectGitBranch, ProjectGitCommit, ProjectGitStatus } from '@yarc/shared'
import { AppError } from '../lib/errors.js'
import { sseHub } from '../lib/sse.js'
import { normalizeProjectRelativePath, resolveProjectRoot } from '../lib/project-path.js'
import { projectHistoryService } from './project-history.service.js'
import { projectLiveFileManager } from './project-live-file.service.js'
import { projectPiContextService } from './project-pi-context.service.js'

interface RunResult { stdout: string; stderr: string }

const assertBranchName = (name: string) => {
  const clean = name.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(clean) || clean.includes('..') || clean.endsWith('/') || clean.includes('@{')) {
    throw new AppError('VALIDATION_ERROR', 'Invalid branch name', 400)
  }
  return clean
}

export const parseProjectGitPorcelainStatus = (stdout: string): ProjectGitStatus['files'] => {
  const records = stdout.split('\0')
  const files: ProjectGitStatus['files'] = []
  for (let i = 0; i < records.length; i++) {
    const record = records[i]
    if (!record) continue
    const indexStatus = record[0] || ' '
    const worktreeStatus = record[1] || ' '
    const path = record.slice(3)
    const renameOrCopy = indexStatus === 'R' || indexStatus === 'C' || worktreeStatus === 'R' || worktreeStatus === 'C'
    const originalPath = renameOrCopy ? records[++i] || undefined : undefined
    files.push({ indexStatus, worktreeStatus, path, ...(originalPath ? { originalPath } : {}) })
  }
  return files
}

export class ProjectGitService {
  private async run(projectId: string, args: string[], options: { allowFailure?: boolean } = {}): Promise<RunResult & { code: number }> {
    const { root } = await resolveProjectRoot(projectId)
    await this.assertGitRoot(projectId, root)
    return new Promise((resolve, reject) => {
      const child = spawn('git', args, { cwd: root, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', chunk => { stdout += chunk.toString() })
      child.stderr.on('data', chunk => { stderr += chunk.toString() })
      child.once('error', error => reject(new AppError('PROJECT_GIT_ERROR', error.message, 500)))
      child.once('close', code => {
        const result = { stdout, stderr, code: code ?? -1 }
        if (result.code === 0 || options.allowFailure) resolve(result)
        else reject(new AppError('PROJECT_GIT_ERROR', stderr.trim() || `git ${args[0]} failed`, 409))
      })
    })
  }

  private async assertGitRoot(projectId: string, root?: string) {
    const resolved = root || (await resolveProjectRoot(projectId)).root
    const result = await new Promise<RunResult & { code: number }>((resolve, reject) => {
      const child = spawn('git', ['rev-parse', '--show-toplevel'], { cwd: resolved, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = '', stderr = ''
      child.stdout.on('data', chunk => { stdout += chunk.toString() })
      child.stderr.on('data', chunk => { stderr += chunk.toString() })
      child.once('error', reject)
      child.once('close', code => resolve({ stdout, stderr, code: code ?? -1 }))
    })
    if (result.code !== 0) throw new AppError('PROJECT_NOT_GIT_REPOSITORY', 'Project root is not a Git repository', 409)
    const top = await realpath(result.stdout.trim()).catch(() => result.stdout.trim())
    const actual = await realpath(resolved)
    if (top !== actual) throw new AppError('PROJECT_NOT_GIT_REPOSITORY', 'Project root must be the Git root', 409)
  }

  async status(projectId: string): Promise<ProjectGitStatus> {
    const [branchResult, headResult, porcelain] = await Promise.all([
      this.run(projectId, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFailure: true }),
      this.run(projectId, ['rev-parse', '--verify', 'HEAD'], { allowFailure: true }),
      this.run(projectId, ['status', '--porcelain=v1', '-z']),
    ])
    const files = parseProjectGitPorcelainStatus(porcelain.stdout)
    return {
      branch: branchResult.code === 0 ? branchResult.stdout.trim() : null,
      detached: branchResult.code !== 0 && headResult.code === 0,
      head: headResult.code === 0 ? headResult.stdout.trim() : null,
      dirty: files.length > 0,
      files,
    }
  }

  async diff(projectId: string, input: { staged?: boolean; path?: string } = {}) {
    const args = ['diff']
    if (input.staged) args.push('--cached')
    if (input.path) args.push('--', normalizeProjectRelativePath(input.path))
    return (await this.run(projectId, args)).stdout
  }

  async log(projectId: string, limit = 100): Promise<ProjectGitCommit[]> {
    const result = await this.run(projectId, ['log', `-${Math.min(Math.max(limit, 1), 500)}`, '--date=iso-strict', '--pretty=format:%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%s%x1e'], { allowFailure: true })
    if (result.code !== 0) return []
    return result.stdout.split('\x1e').filter(Boolean).map(row => {
      const [hash, shortHash, author, authorEmail, authoredAt, subject] = row.trim().split('\x1f')
      return { hash, shortHash, author, authorEmail, authoredAt, subject }
    })
  }

  async stage(projectId: string, paths: string[]) {
    const safe = paths.map(normalizeProjectRelativePath).filter(Boolean)
    if (!safe.length) throw new AppError('VALIDATION_ERROR', 'At least one path is required', 400)
    for (const path of safe) await projectLiveFileManager.flushProject(projectId, path)
    await projectHistoryService.flushPending(projectId)
    await this.run(projectId, ['add', '--', ...safe])
    return this.status(projectId)
  }

  async unstage(projectId: string, paths: string[]) {
    const safe = paths.map(normalizeProjectRelativePath).filter(Boolean)
    if (!safe.length) throw new AppError('VALIDATION_ERROR', 'At least one path is required', 400)
    const status = await this.status(projectId)
    if (status.head) await this.run(projectId, ['restore', '--staged', '--', ...safe])
    else await this.run(projectId, ['rm', '--cached', '-r', '--ignore-unmatch', '--', ...safe])
    return this.status(projectId)
  }

  async commit(projectId: string, message: string) {
    const clean = message.trim()
    if (!clean) throw new AppError('VALIDATION_ERROR', 'Commit message is required', 400)
    await projectLiveFileManager.flushProject(projectId)
    await projectHistoryService.flushPending(projectId)
    await this.run(projectId, ['commit', '-m', clean])
    return { status: await this.status(projectId), commits: await this.log(projectId, 1) }
  }

  async branches(projectId: string): Promise<ProjectGitBranch[]> {
    const current = (await this.status(projectId)).branch
    const result = await this.run(projectId, ['for-each-ref', '--format=%(refname:short)%09%(objectname)', 'refs/heads/'])
    return result.stdout.split(/\r?\n/).filter(Boolean).map(line => {
      const [name, head] = line.split('\t')
      return { name, current: name === current, head: head || null }
    })
  }

  async createBranch(projectId: string, name: string) {
    const clean = assertBranchName(name)
    await this.run(projectId, ['branch', clean])
    return this.branches(projectId)
  }

  async switchBranch(projectId: string, name: string) {
    const clean = assertBranchName(name)
    await projectLiveFileManager.flushProject(projectId)
    await projectHistoryService.flushPending(projectId)
    await projectHistoryService.checkpoint(projectId, {
      kind: 'manual',
      metadata: { operation: 'git-branch-switch', target: clean },
      forceBoundary: true,
    })
    await this.run(projectId, ['switch', clean])
    await projectLiveFileManager.resetProjectSessions(projectId, 'git-branch-switch')
    await projectPiContextService.reloadProject(projectId, `git-branch-switch:${clean}`)
    sseHub.emit({ type: 'project-files-changed', projectId, action: 'git-branch-switch', at: new Date().toISOString() })
    return this.status(projectId)
  }

  async remotes(projectId: string) {
    const result = await this.run(projectId, ['remote', '-v'])
    const map = new Map<string, { name: string; fetch?: string; push?: string }>()
    for (const line of result.stdout.split(/\r?\n/).filter(Boolean)) {
      const match = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/)
      if (!match) continue
      const item = map.get(match[1]) || { name: match[1] }
      item[match[3] as 'fetch' | 'push'] = match[2]
      map.set(match[1], item)
    }
    return [...map.values()]
  }
}

export const projectGitService = new ProjectGitService()
