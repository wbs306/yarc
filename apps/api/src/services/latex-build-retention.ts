import { lstat, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const MARKER = '.yarc-settled-build.json'
const BUILD_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i

export interface SettledLatexBuild {
  id: string
  projectId: string | null
  finishedAt: number
  success: boolean
}

const DAY_MS = 24 * 60 * 60 * 1000

// Each result expires independently. Builds in the same project or another
// workspace never reduce one another's retention period.
export function isExpiredLatexBuild(build: SettledLatexBuild, now: number) {
  return now - build.finishedAt > (build.success ? 20 : 5) * DAY_MS
}

const directDirectory = async (path: string) => {
  const info = await lstat(path)
  return info.isDirectory() && !info.isSymbolicLink() && await realpath(path) === path
}

async function readMarker(root: string, id: string): Promise<SettledLatexBuild | null> {
  if (!BUILD_ID.test(id)) return null
  const directory = join(root, id)
  try {
    if (!(await directDirectory(directory))) return null
    const path = join(directory, MARKER)
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 16_384) return null
    const value = JSON.parse(await readFile(path, 'utf8')) as Partial<SettledLatexBuild> | null
    if (!value || value.id !== id || (value.projectId !== null && typeof value.projectId !== 'string')
      || typeof value.finishedAt !== 'number'
      || !Number.isFinite(value.finishedAt) || value.finishedAt <= 0 || value.finishedAt > Date.now()
      || typeof value.success !== 'boolean') return null
    return value as SettledLatexBuild
  } catch { return null }
}

// A marker is only created after settling. Never infer ownership or readiness
// from a UUID-shaped directory, mtime, or the presence of a PDF alone.
export async function markSettledLatexBuild(outputRoot: string, build: SettledLatexBuild) {
  const root = resolve(outputRoot)
  if (!BUILD_ID.test(build.id) || !(await directDirectory(root)) || !(await directDirectory(join(root, build.id)))) {
    throw new Error('Unsafe LaTeX build directory')
  }
  await writeFile(join(root, build.id, MARKER), JSON.stringify(build), { flag: 'wx', mode: 0o600 })
}

export async function cleanupLatexBuilds(outputRoot: string, hooks: {
  claim: (id: string) => boolean
  finish: (id: string, removed: boolean) => void
  onError: (error: unknown) => void
}, now = Date.now()) {
  const root = resolve(outputRoot)
  try { if (!(await directDirectory(root))) return }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return
  }
  for (const dir of await readdir(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue
    const build = await readMarker(root, dir.name)
    if (!build || !isExpiredLatexBuild(build, now) || !(await directDirectory(root)) || !hooks.claim(build.id)) continue
    let removed = false
    try {
      await rm(join(root, build.id), { recursive: true, force: true })
      removed = true
    } catch (error) { hooks.onError(error) }
    finally { hooks.finish(build.id, removed) }
  }
}
