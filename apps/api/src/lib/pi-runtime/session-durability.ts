import { closeSync, existsSync, fsyncSync, openSync, readSync, statSync } from 'node:fs'

export type SessionDurabilityMode = 'normal' | 'strict'

export class SessionDurabilityCoordinator {
  constructor(private readonly mode: SessionDurabilityMode = 'strict') {}

  verifyEntry(sessionFile: string | undefined, entryId: string | null | undefined): boolean {
    if (!sessionFile || !entryId || !existsSync(sessionFile)) return false

    let fd: number | undefined
    try {
      const maxBytes = 256 * 1024
      const size = statSync(sessionFile).size
      const length = Math.min(size, maxBytes)
      fd = openSync(sessionFile, 'r')
      const buffer = Buffer.alloc(length)
      readSync(fd, buffer, 0, length, Math.max(0, size - length))
      return buffer.toString('utf8').includes(`\"id\":\"${entryId}\"`)
    } catch {
      return false
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
  }

  commit(sessionFile: string | undefined): void {
    if (this.mode !== 'strict' || !sessionFile || !existsSync(sessionFile)) return

    let fd: number | undefined
    try {
      fd = openSync(sessionFile, 'r')
      fsyncSync(fd)
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
  }
}
