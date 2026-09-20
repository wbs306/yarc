import { realpath } from 'node:fs/promises'
import { basename, dirname, relative, resolve, sep } from 'node:path'

const isInside = (root: string, target: string) => target === root || target.startsWith(`${root}${sep}`)
const isSensitive = (path: string) => path.split(/[\\/]/).some(segment =>
  segment.startsWith('.')
  || /^(?:auth|models|credentials)(?:\.|$)/i.test(segment)
  || /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)/i.test(segment)
  || /\.(?:pem|key|p12|pfx|crt|cer)$/i.test(segment),
)

// This is a read-only exception for resources actually loaded by Pi, not an
// expansion of the public @file namespace. Never populate skillFiles from tool
// arguments. Standalone markdown skills authorize only that file, not siblings.
export async function resolveLoadedSkillReadPath(absolutePath: string, skillFiles: readonly string[]): Promise<string | null> {
  const target = resolve(absolutePath)
  for (const file of skillFiles) {
    const skillFile = resolve(file)
    const root = dirname(skillFile)
    const directorySkill = basename(skillFile) === 'SKILL.md'
    if (directorySkill ? !isInside(root, target) : target !== skillFile) continue
    if (isSensitive(relative(root, target))) throw new Error('Sensitive files are not available through skill reads')

    const realRoot = await realpath(root)
    const realSkill = await realpath(skillFile)
    const realTarget = await realpath(target)
    // Allow installed skill-directory symlinks, but not links escaping that
    // skill into credentials, another workspace, or unrelated runtime data.
    if (!isInside(realRoot, realSkill) || !isInside(realRoot, realTarget)
      || isSensitive(relative(realRoot, realSkill)) || isSensitive(relative(realRoot, realTarget))) {
      throw new Error('Skill reads must stay inside the loaded skill directory')
    }
    return realTarget
  }
  return null
}
