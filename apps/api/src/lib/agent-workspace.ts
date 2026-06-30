import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { config } from './config.js'
import { DEFAULT_CHAT_SYSTEM_PROMPT, DEFAULT_AGENTS_MD_CONTENT } from './prompts.js'

export interface AgentWorkspaceSeed {
  summaryPrompt?: string | null
  systemPrompt?: string | null
  agentMd?: string | null
  skills?: unknown
}

type AgentSkillSetting = {
  name: string
  description?: string
  enabled?: boolean
}

export const agentWorkspacePaths = () => {
  const cwd = resolve(config.dataDir)
  const piDir = join(cwd, '.pi')
  const agentDir = join(piDir, 'agent')
  const skillsDir = join(agentDir, 'skills')

  return {
    cwd,
    piDir,
    agentDir,
    agentsMd: join(cwd, 'AGENTS.md'),
    legacyAgentsMd: join(piDir, 'AGENTS.md'),
    summaryPrompt: join(piDir, 'SUMMARY.md'),
    systemPrompt: join(agentDir, 'SYSTEM.md'),
    agentSettings: join(agentDir, 'settings.json'),
    auth: join(agentDir, 'auth.json'),
    models: join(agentDir, 'models.json'),
    skillsDir,
    sessionsDir: join(agentDir, 'sessions'),
  }
}

export const applyAgentWorkspaceEnv = () => {
  const paths = agentWorkspacePaths()
  // Pi packages and extensions (including pi-subagents) discover user settings,
  // agents, models, auth, npm plugins, and default session paths through these
  // standard environment variables. Keep them pointed at YARC's data-scoped
  // agent workspace instead of the process user's ~/.pi/agent.
  process.env.PI_CODING_AGENT_DIR = paths.agentDir
  process.env.PI_CODING_AGENT_SESSION_DIR = paths.sessionsDir
  return paths
}

const readOptionalText = async (path: string) => {
  try {
    return await readFile(path, 'utf-8')
  } catch {
    return null
  }
}

const writeJsonFile = async (path: string, data: unknown) => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(data, null, 2) + '\n', 'utf-8')
}

const normalizeSkillName = (value: string) => {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 64) || 'skill'
}

const normalizeSkills = (value: unknown): AgentSkillSetting[] => {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const result: AgentSkillSetting[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const rawName = String((item as any).name || '').trim()
    if (!rawName) continue
    const name = normalizeSkillName(rawName)
    if (seen.has(name)) continue
    seen.add(name)
    result.push({
      name,
      description: String((item as any).description || rawName).trim() || rawName,
      enabled: (item as any).enabled !== false,
    })
  }
  return result
}

const skillMarkdown = (skill: AgentSkillSetting) => {
  const frontmatter = [
    '---',
    `name: ${JSON.stringify(skill.name)}`,
    `description: ${JSON.stringify(skill.description || skill.name)}`,
    ...(skill.enabled === false ? ['disable-model-invocation: true'] : []),
    '---',
  ].join('\n')
  return `${frontmatter}\n\n# ${skill.name}\n\n${skill.description || skill.name}\n`
}

const frontmatterValue = (content: string, key: string) => {
  const match = content.match(new RegExp(`^${key}:\\s*(.+)$`, 'mi'))
  if (!match?.[1]) return ''
  const raw = match[1].trim()
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    try {
      const parsed = JSON.parse(raw)
      return typeof parsed === 'string' ? parsed : String(parsed)
    } catch {
      return raw.slice(1, -1)
    }
  }
  return raw
}

const scanSkillFile = async (path: string, fallbackName: string): Promise<AgentSkillSetting | null> => {
  const content = await readOptionalText(path)
  if (!content) return null
  const name = normalizeSkillName(frontmatterValue(content, 'name') || fallbackName)
  const description = frontmatterValue(content, 'description') || name
  return {
    name,
    description,
    enabled: !/disable-model-invocation:\s*true/i.test(content),
  }
}

const scanSkillDir = async (dir: string, includeRootFiles: boolean): Promise<AgentSkillSetting[]> => {
  const skillFile = join(dir, 'SKILL.md')
  const directSkill = await scanSkillFile(skillFile, basename(dir))
  if (directSkill) return [directSkill]

  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }

  const skills: AgentSkillSetting[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
    const path = join(dir, entry.name)
    if (includeRootFiles && entry.isFile() && entry.name.endsWith('.md')) {
      const skill = await scanSkillFile(path, entry.name.replace(/\.md$/i, ''))
      if (skill) skills.push(skill)
      continue
    }
    if (entry.isDirectory()) skills.push(...await scanSkillDir(path, false))
  }
  return skills
}

const scanSkillDirectories = async (skillsDir: string) => {
  try {
    const seen = new Set<string>()
    const result: AgentSkillSetting[] = []
    for (const skill of await scanSkillDir(skillsDir, true)) {
      if (seen.has(skill.name)) continue
      seen.add(skill.name)
      result.push(skill)
    }
    return result
  } catch {
    return []
  }
}

const writeSkillFiles = async (paths: ReturnType<typeof agentWorkspacePaths>, skills: AgentSkillSetting[]) => {
  const nextNames = new Set(skills.map((skill) => skill.name))
  try {
    const entries = await readdir(paths.skillsDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const markerPath = join(paths.skillsDir, entry.name, '.yarc-managed')
      if (await readOptionalText(markerPath) === null) continue
      if (!nextNames.has(entry.name)) {
        await unlink(join(paths.skillsDir, entry.name, 'SKILL.md')).catch(() => undefined)
        await unlink(markerPath).catch(() => undefined)
      }
    }
  } catch {
    // Preserve skill folders and auxiliary files such as references/ and scripts/.
  }

  for (const skill of skills) {
    const skillDir = join(paths.skillsDir, skill.name)
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, 'SKILL.md'), skillMarkdown(skill), 'utf-8')
    await writeFile(join(skillDir, '.yarc-managed'), '1\n', 'utf-8')
  }
}

const ensureTextFile = async (path: string, fallback?: string) => {
  const current = await readOptionalText(path)
  if (current !== null || fallback === undefined) return
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, fallback, 'utf-8')
}

const ensureJsonFile = async (path: string, fallback: unknown) => {
  if (await readOptionalText(path) !== null) return
  await writeJsonFile(path, fallback)
}

let _ensuredPaths: ReturnType<typeof agentWorkspacePaths> | null = null
let _ensuredWithSeeds = false

export const ensureAgentWorkspace = async (seed: AgentWorkspaceSeed = {}) => {
  const paths = applyAgentWorkspaceEnv()
  const hasSeeds = !!(seed.agentMd || seed.summaryPrompt || seed.systemPrompt || seed.skills)

  // Skip if already ensured without seeds and no new seeds provided.
  // With seeds, always re-run to sync filesystem.
  if (_ensuredPaths && _ensuredWithSeeds && !hasSeeds) return _ensuredPaths
  if (_ensuredPaths && !hasSeeds) return _ensuredPaths

  await mkdir(paths.cwd, { recursive: true })
  await mkdir(paths.piDir, { recursive: true })
  await mkdir(paths.agentDir, { recursive: true })
  await mkdir(paths.skillsDir, { recursive: true })
  const legacyAgentMd = await readOptionalText(paths.legacyAgentsMd)
  await ensureTextFile(paths.agentsMd, seed.agentMd ?? legacyAgentMd ?? DEFAULT_AGENTS_MD_CONTENT)
  await ensureTextFile(paths.summaryPrompt, seed.summaryPrompt ?? undefined)
  await ensureTextFile(paths.systemPrompt, seed.systemPrompt || DEFAULT_CHAT_SYSTEM_PROMPT)
  await ensureJsonFile(paths.agentSettings, {})
  const seedSkills = normalizeSkills(seed.skills)
  if (seedSkills.length && !(await scanSkillDirectories(paths.skillsDir)).length) {
    await writeSkillFiles(paths, seedSkills)
  }

  _ensuredPaths = paths
  if (hasSeeds) _ensuredWithSeeds = true
  return paths
}

export const readAgentSystemPrompt = async () => {
  const paths = await ensureAgentWorkspace()
  return (await readOptionalText(paths.systemPrompt)) || ''
}

export const writeAgentSystemPrompt = async (value: string | null | undefined) => {
  const paths = await ensureAgentWorkspace()
  await writeFile(paths.systemPrompt, value || '', 'utf-8')
}

export const readAgentSummaryPrompt = async () => {
  const paths = await ensureAgentWorkspace()
  return (await readOptionalText(paths.summaryPrompt)) || ''
}

export const writeAgentSummaryPrompt = async (value: string | null | undefined) => {
  const paths = await ensureAgentWorkspace()
  await writeFile(paths.summaryPrompt, value || '', 'utf-8')
}

export const readAgentMd = async () => {
  const paths = await ensureAgentWorkspace()
  return (await readOptionalText(paths.agentsMd)) || ''
}

export const writeAgentMd = async (value: string | null | undefined) => {
  const paths = await ensureAgentWorkspace()
  await writeFile(paths.agentsMd, value || '', 'utf-8')
}

export const readAgentSkills = async () => {
  const paths = await ensureAgentWorkspace()
  return scanSkillDirectories(paths.skillsDir)
}

export const writeAgentSkills = async (value: unknown) => {
  const paths = await ensureAgentWorkspace()
  const skills = normalizeSkills(value)
  await writeSkillFiles(paths, skills)
}

export const readAgentSettings = async () => {
  const paths = await ensureAgentWorkspace()
  const raw = await readOptionalText(paths.agentSettings)
  if (!raw?.trim()) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

export const writeAgentSettings = async (value: unknown) => {
  const paths = await ensureAgentWorkspace()
  const data = value && typeof value === 'object' ? { ...value } : {}
  // Always remove defaultThinkingLevel - reasoning effort is per-conversation
  delete (data as any).defaultThinkingLevel
  console.log('[writeAgentSettings] Writing to:', paths.agentSettings)
  console.log('[writeAgentSettings] Data:', JSON.stringify(data).slice(0, 200))
  await writeJsonFile(paths.agentSettings, data)
  console.log('[writeAgentSettings] Write succeeded')
}
