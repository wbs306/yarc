import { spawn } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import type { ProjectGitBranch, ProjectGitCommit, ProjectGitStatus } from '@yarc/shared'
import { AppError } from '../lib/errors.js'
import { normalizeProjectRelativePath, resolveProjectRoot } from '../lib/project-path.js'
import { projectHistoryService } from './project-history.service.js'

interface RunResult { stdout: string; stderr: string }

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
    const files = porcelain.stdout.split('\0').filter(Boolean).map(record => ({
      indexStatus: record[0] || ' ',
      worktreeStatus: record[1] || ' ',
      path: record.slice(3).replace(/^.* -> /, ''),
    }))
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
    await this.run(projectId, ['commit', '-m', clean])
    return { status: await this.status(projectId), commits: await this.log(projectId, 1) }
  }

  async branches(projectId: string): Promise<ProjectGitBranch[]> {
    const current = (await this.status(projectId)).branch
    const result = await this.run(projectId, ['for-each-ref', '--format=%(refname:short)%x1f%(objectname)', 'refs/heads/'])
    return result.stdout.split(/\r?\n/).filter(Boolean).map(line => {
      const [name, head] = line.split('%x1f').length > 1 ? line.split('%x1f') : line.split('\x1f')
      return { name, current: name === current, head: head || null }
    })
  }

  async createBranch(projectId: string, name: string) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(name) || name.includes('..') || name.endsWith('/') || name.includes('@{')) {
      throw new AppError('VALIDATION_ERROR', 'Invalid branch name', 400)
    }
    await this.run(projectId, ['branch', name])
    return this.branches(projectId)
  }

  async switchBranch(projectId: string, name: string) {
    await projectHistoryService.flushPending(projectId)
    await projectHistoryService.checkpoint(projectId, { kind: 'manual', metadata: { operation: 'git-branch-switch', target: name } })
    await this.run(projectId, ['switch', name])
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
