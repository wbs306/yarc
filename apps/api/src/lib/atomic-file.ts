import { mkdir, open, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

/**
 * Replace a file without exposing an empty or partially-written target.
 * The temporary file lives beside the target so rename remains atomic on the
 * same filesystem. The temporary file is hidden from the workspace watcher.
 */
export const atomicWriteFile = async (targetPath: string, content: string | Uint8Array): Promise<void> => {
  const directory = dirname(targetPath)
  const temporaryPath = join(directory, `.${basename(targetPath)}.yarc-${randomUUID()}.tmp`)

  await mkdir(directory, { recursive: true })
  try {
    await writeFile(temporaryPath, content, typeof content === 'string' ? 'utf-8' : undefined)
    const handle = await open(temporaryPath, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporaryPath, targetPath)
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined)
    throw error
  }
}

export const atomicWriteTextFile = (targetPath: string, content: string): Promise<void> =>
  atomicWriteFile(targetPath, content)
