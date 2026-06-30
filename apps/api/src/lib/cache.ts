// Simple in-memory TTL cache (no Redis needed)

interface CacheEntry<T> {
  data: T
  expires: number
}

class MemoryCache {
  private store = new Map<string, CacheEntry<unknown>>()
  private cleanupInterval: ReturnType<typeof setInterval>

  constructor() {
    // Cleanup expired entries every 5 minutes
    this.cleanupInterval = setInterval(() => this.cleanup(), 300_000)
  }

  get<T>(key: string): T | null {
    const entry = this.store.get(key)
    if (!entry || entry.expires < Date.now()) {
      if (entry) this.store.delete(key)
      return null
    }
    return entry.data as T
  }

  set(key: string, data: unknown, ttlMs: number): void {
    this.store.set(key, { data, expires: Date.now() + ttlMs })
  }

  delete(key: string): void {
    this.store.delete(key)
  }

  clear(): void {
    this.store.clear()
  }

  // Invalidate all keys matching a prefix
  invalidatePrefix(prefix: string): void {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key)
      }
    }
  }

  private cleanup(): void {
    const now = Date.now()
    for (const [key, entry] of this.store) {
      if (entry.expires < now) {
        this.store.delete(key)
      }
    }
  }

  destroy(): void {
    clearInterval(this.cleanupInterval)
    this.store.clear()
  }
}

export const cache = new MemoryCache()
