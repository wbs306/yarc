import { spawn, type ChildProcess } from 'node:child_process'
import { config } from './config.js'

export interface ModelServiceManagerOptions {
  name: string
  apiUrl: string
  startCommand?: string
  stopCommand?: string
  cwd?: string
  healthUrl?: string
  startupTimeoutMs: number
  idleTtlMs: number
  maxConcurrent?: number
  enabled?: boolean
}

export interface ModelServiceLease {
  release: () => void
}

type CommandResult = {
  code: number | null
  signal: NodeJS.Signals | null
  error?: Error
}

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

const waitForExitOrTimeout = async (exited: Promise<void>, timeoutMs: number) => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<void>(resolve => {
    timer = setTimeout(resolve, timeoutMs)
  })
  try {
    await Promise.race([exited, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

const defaultHealthUrl = (apiUrl: string) => {
  try {
    return `${new URL(apiUrl).origin}/health`
  } catch {
    return apiUrl
  }
}

const positiveOr = (value: number, fallback: number) =>
  Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback

const nonNegativeOr = (value: number, fallback: number) =>
  Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback

const concurrencyOrInfinity = (value: number | undefined) =>
  Number.isFinite(value) && (value as number) > 0 ? Math.floor(value as number) : Number.POSITIVE_INFINITY

/**
 * Optionally owns a model service process for the duration of active requests.
 * An already healthy service is treated as externally owned unless an explicit
 * stop command is configured. An explicit stop command is an opt-in signal
 * that this manager may adopt and later stop that supervisor-managed service.
 *
 * When stopCommand is configured, startCommand and stopCommand are treated as
 * supervisor commands (for example docker or systemctl). In that mode the
 * manager owns the logical service, not the short-lived command process.
 *
 * When maxConcurrent is configured, all leases share that limit. This makes
 * the lease both a lifecycle handle and a resource admission gate, so callers
 * such as interactive previews cannot bypass background work limits.
 */
export class ModelServiceManager {
  private readonly startCommand: string
  private readonly stopCommand: string
  private readonly cwd?: string
  private readonly healthUrl: string
  private readonly startupTimeoutMs: number
  private readonly idleTtlMs: number
  private readonly enabled: boolean
  private maxConcurrent: number
  private capacityWaiters: Array<{
    resolve: () => void
    reject: (error: Error) => void
  }> = []
  private child: ChildProcess | null = null
  private childPid: number | null = null
  private childError: Error | null = null
  private controlChild: ChildProcess | null = null
  private startupPromise: Promise<void> | null = null
  private stopPromise: Promise<void> | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private queueDepthProvider: () => number = () => 0
  private pendingAcquires = 0
  private activeLeases = 0
  private ownsService = false
  private disposed = false

  constructor(private readonly options: ModelServiceManagerOptions) {
    this.startCommand = options.startCommand?.trim() || ''
    this.stopCommand = options.stopCommand?.trim() || ''
    this.cwd = options.cwd?.trim() || undefined
    this.healthUrl = options.healthUrl?.trim() || defaultHealthUrl(options.apiUrl)
    this.startupTimeoutMs = positiveOr(options.startupTimeoutMs, 120_000)
    this.idleTtlMs = nonNegativeOr(options.idleTtlMs, 300_000)
    this.maxConcurrent = concurrencyOrInfinity(options.maxConcurrent)
    this.enabled = options.enabled !== false && this.startCommand.length > 0
    void this.adoptHealthyServiceIfConfigured()
  }

  isEnabled(): boolean {
    return this.enabled
  }

  setQueueDepthProvider(provider: () => number): void {
    this.queueDepthProvider = provider
    this.notifyQueueChanged()
  }

  setMaxConcurrent(maxConcurrent: number): void {
    this.maxConcurrent = concurrencyOrInfinity(maxConcurrent)
    this.drainCapacityWaiters()
  }

  getMaxConcurrent(): number {
    return this.maxConcurrent
  }

  notifyQueueChanged(): void {
    this.scheduleIdleStop()
  }

  async acquire(): Promise<ModelServiceLease> {
    if (this.disposed) throw new Error(`${this.options.name} model service manager is disposed`)

    // Count the request before waiting for a capacity slot or startup. This
    // prevents the idle timer from stopping a service while requests are
    // queued behind either lifecycle or resource admission transitions.
    this.pendingAcquires += 1
    this.clearIdleTimer()
    let slotAcquired = false
    try {
      await this.acquireSlot()
      slotAcquired = true
      this.pendingAcquires = Math.max(0, this.pendingAcquires - 1)
      if (this.enabled) await this.ensureAvailable()
    } catch (error) {
      this.pendingAcquires = Math.max(0, this.pendingAcquires - 1)
      if (slotAcquired) this.releaseSlot()
      else this.scheduleIdleStop()
      throw error
    }

    let released = false
    return {
      release: () => {
        if (released) return
        released = true
        this.releaseSlot()
      },
    }
  }

  async withService<T>(operation: () => Promise<T>): Promise<T> {
    const lease = await this.acquire()
    try {
      return await operation()
    } finally {
      lease.release()
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.pendingAcquires = 0
    this.activeLeases = 0
    this.clearIdleTimer()
    const disposeError = new Error(`${this.options.name} model service manager is disposed`)
    for (const waiter of this.capacityWaiters.splice(0)) waiter.reject(disposeError)

    // A supervisor command may still be starting the service. Stop the
    // command process so the health wait can terminate promptly.
    if (this.controlChild) this.signalChild(this.controlChild, 'SIGTERM')
    const startup = this.startupPromise
    await startup?.catch(() => undefined)
    await this.stopOwnedService()
  }

  private async adoptHealthyServiceIfConfigured(): Promise<void> {
    if (this.disposed || !this.enabled || !this.stopCommand || this.ownsService || this.child) return
    if (!(await this.isHealthy())) return
    if (this.disposed || this.ownsService) return
    this.ownsService = true
    console.log(`[ModelService:${this.options.name}] Adopted already-running managed service`)
    this.scheduleIdleStop()
  }

  private async ensureAvailable(): Promise<void> {
    if (this.stopPromise) await this.stopPromise.catch(() => undefined)

    // Always join an in-flight startup before deciding that the service is
    // available. A concurrent external service must not bypass our startup
    // barrier and leave ownership ambiguous.
    const pending = this.startupPromise
    if (pending) {
      await pending
      return
    }

    if (await this.isHealthy()) {
      if (this.stopCommand && !this.ownsService) {
        this.ownsService = true
        console.log(`[ModelService:${this.options.name}] Adopted already-running managed service`)
      }
      return
    }

    const startup = this.startServiceAndWait()
    this.startupPromise = startup
    try {
      await startup
    } finally {
      if (this.startupPromise === startup) this.startupPromise = null
    }
  }

  private async startServiceAndWait(): Promise<void> {
    if (this.stopCommand) {
      let startSucceeded = false
      try {
        await this.runControlCommand(this.startCommand, 'start')
        startSucceeded = true
        await this.waitForHealth()
        this.ownsService = true
        console.log(`[ModelService:${this.options.name}] Started managed service`)
        return
      } catch (error) {
        // Only run the rollback stop after a successful start command. A
        // failed start must not stop an external service that appeared during
        // the startup race.
        if (startSucceeded) {
          await this.runControlCommand(this.stopCommand, 'rollback stop').catch(stopError => {
            console.warn(`[ModelService:${this.options.name}] Rollback stop failed:`, (stopError as Error).message)
          })
        }
        throw error
      }
    }

    const child = this.startChild()
    try {
      await this.waitForHealth(child)
      this.ownsService = true
    } catch (error) {
      await this.stopOwnedService().catch(stopError => {
        console.warn(`[ModelService:${this.options.name}] Startup cleanup failed:`, (stopError as Error).message)
      })
      throw error
    }
  }

  private startChild(): ChildProcess {
    if (!this.enabled) throw new Error(`${this.options.name} model service startup is disabled`)

    const child = spawn(this.startCommand, {
      cwd: this.cwd,
      detached: process.platform !== 'win32',
      shell: true,
      stdio: 'ignore',
    })
    this.child = child
    this.childPid = child.pid ?? null
    this.childError = null

    child.once('error', error => {
      if (this.child === child) this.childError = error
    })
    child.once('exit', () => {
      if (this.child === child) {
        this.child = null
        this.childPid = null
        this.ownsService = false
      }
    })

    if (!child.pid) {
      this.child = null
      this.childPid = null
      throw new Error(`${this.options.name} model service process did not start`)
    }

    console.log(`[ModelService:${this.options.name}] Started managed process`)
    return child
  }

  private async waitForHealth(child?: ChildProcess): Promise<void> {
    const deadline = Date.now() + this.startupTimeoutMs
    while (Date.now() < deadline) {
      if (this.disposed) throw new Error(`${this.options.name} model service startup cancelled`)
      if (child && (this.child !== child || child.exitCode !== null || this.childError)) {
        const reason = this.childError?.message || `process exited with code ${child.exitCode ?? 'unknown'}`
        throw new Error(`${this.options.name} model service failed to start: ${reason}`)
      }
      if (await this.isHealthy()) return
      await delay(Math.min(250, Math.max(1, deadline - Date.now())))
    }

    if (this.disposed) throw new Error(`${this.options.name} model service startup cancelled`)
    if (child && (this.child !== child || child.exitCode !== null || this.childError)) {
      const reason = this.childError?.message || `process exited with code ${child.exitCode ?? 'unknown'}`
      throw new Error(`${this.options.name} model service failed to start: ${reason}`)
    }
    if (await this.isHealthy()) return
    throw new Error(`${this.options.name} model service health check timed out after ${this.startupTimeoutMs}ms`)
  }

  private async isHealthy(): Promise<boolean> {
    try {
      const response = await fetch(this.healthUrl, {
        signal: AbortSignal.timeout(Math.min(1_000, this.startupTimeoutMs)),
      })
      await response.body?.cancel()
      return response.ok
    } catch {
      return false
    }
  }

  private async acquireSlot(): Promise<void> {
    if (this.activeLeases < this.maxConcurrent) {
      this.activeLeases += 1
      return
    }

    await new Promise<void>((resolve, reject) => {
      this.capacityWaiters.push({ resolve, reject })
    })
  }

  private releaseSlot(): void {
    this.activeLeases = Math.max(0, this.activeLeases - 1)
    this.drainCapacityWaiters()
    this.scheduleIdleStop()
  }

  private drainCapacityWaiters(): void {
    while (this.capacityWaiters.length > 0 && this.activeLeases < this.maxConcurrent) {
      const waiter = this.capacityWaiters.shift()
      if (!waiter) return
      this.activeLeases += 1
      waiter.resolve()
    }
  }

  private scheduleIdleStop(): void {
    if (
      this.disposed ||
      this.pendingAcquires > 0 ||
      this.activeLeases > 0 ||
      this.queueDepth() > 0 ||
      (!this.ownsService && !this.child)
    ) return
    this.clearIdleTimer()
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (this.pendingAcquires === 0 && this.activeLeases === 0 && this.queueDepth() === 0) {
        void this.stopOwnedService().catch(error => {
          console.warn(`[ModelService:${this.options.name}] Idle shutdown failed:`, (error as Error).message)
        })
      }
    }, this.idleTtlMs)
    this.idleTimer.unref?.()
  }

  private queueDepth(): number {
    try {
      const depth = Number(this.queueDepthProvider())
      return Number.isFinite(depth) && depth > 0 ? Math.floor(depth) : 0
    } catch {
      return 0
    }
  }

  private clearIdleTimer(): void {
    if (!this.idleTimer) return
    clearTimeout(this.idleTimer)
    this.idleTimer = null
  }

  private stopOwnedService(): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    const operation = this.stopOwnedServiceNow()
    let tracked!: Promise<void>
    tracked = operation.finally(() => {
      if (this.stopPromise === tracked) this.stopPromise = null
    })
    this.stopPromise = tracked
    return tracked
  }

  private async stopOwnedServiceNow(): Promise<void> {
    if (this.stopCommand && this.ownsService) {
      await this.runControlCommand(this.stopCommand, 'stop')
      this.ownsService = false
      console.log(`[ModelService:${this.options.name}] Stopped managed service`)
      return
    }

    const child = this.child
    if (!child) {
      this.ownsService = false
      return
    }

    this.child = null
    this.childPid = null
    this.childError = null

    const exited = new Promise<void>(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve()
        return
      }
      child.once('exit', () => resolve())
    })

    this.signalChild(child, 'SIGTERM')
    await waitForExitOrTimeout(exited, 5_000)

    if (child.exitCode === null && child.signalCode === null) {
      this.signalChild(child, 'SIGKILL')
      await waitForExitOrTimeout(exited, 1_000)
    }

    this.ownsService = false
    console.log(`[ModelService:${this.options.name}] Stopped managed process`)
  }

  private async runControlCommand(command: string, action: string): Promise<void> {
    const child = spawn(command, {
      cwd: this.cwd,
      detached: process.platform !== 'win32',
      shell: true,
      stdio: 'ignore',
    })
    this.controlChild = child

    const exited = new Promise<CommandResult>(resolve => {
      let settled = false
      const finish = (result: CommandResult) => {
        if (settled) return
        settled = true
        resolve(result)
      }
      child.once('error', error => finish({ code: null, signal: null, error }))
      child.once('close', (code, signal) => finish({ code, signal }))
    })

    let timer: ReturnType<typeof setTimeout> | number | undefined
    const timeout = new Promise<null>(resolve => {
      timer = setTimeout(resolve, this.startupTimeoutMs)
    })

    try {
      const result = await Promise.race([exited, timeout])
      if (timer) clearTimeout(timer)
      if (result === null) {
        this.signalChild(child, 'SIGTERM')
        await waitForExitOrTimeout(exited.then(() => undefined), 1_000)
        if (child.exitCode === null && child.signalCode === null) this.signalChild(child, 'SIGKILL')
        throw new Error(`${this.options.name} ${action} command timed out after ${this.startupTimeoutMs}ms`)
      }
      if (result.error) throw new Error(`${this.options.name} ${action} command failed: ${result.error.message}`)
      if (result.code !== 0) {
        const status = result.signal ? `signal ${result.signal}` : `code ${result.code ?? 'unknown'}`
        throw new Error(`${this.options.name} ${action} command exited with ${status}`)
      }
    } finally {
      if (timer) clearTimeout(timer)
      if (this.controlChild === child) this.controlChild = null
    }
  }

  private signalChild(child: ChildProcess, signal: NodeJS.Signals): void {
    if (!child.pid) return
    try {
      if (process.platform === 'win32') child.kill(signal)
      else process.kill(-child.pid, signal)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ESRCH') {
        console.warn(`[ModelService:${this.options.name}] Failed to send ${signal}:`, (error as Error).message)
      }
    }
  }
}

export const mineruServiceManager = new ModelServiceManager({
  name: 'MinerU',
  apiUrl: config.mineruApiUrl,
  startCommand: config.mineruStartCommand,
  stopCommand: config.mineruStopCommand,
  cwd: config.mineruStartCwd,
  healthUrl: config.mineruHealthUrl,
  startupTimeoutMs: config.mineruStartTimeoutMs,
  idleTtlMs: config.mineruIdleTtlMs,
  maxConcurrent: 3,
})

export const llamaCppServiceManager = new ModelServiceManager({
  name: 'llama.cpp',
  apiUrl: config.embeddingApiUrl,
  startCommand: config.llamaCppStartCommand,
  stopCommand: config.llamaCppStopCommand,
  cwd: config.llamaCppStartCwd,
  healthUrl: config.llamaCppHealthUrl,
  startupTimeoutMs: config.llamaCppStartTimeoutMs,
  idleTtlMs: config.llamaCppIdleTtlMs,
  enabled: config.llamaCppOnDemand,
})

export const disposeModelServiceManagers = async (): Promise<void> => {
  await Promise.all([
    mineruServiceManager.dispose(),
    llamaCppServiceManager.dispose(),
  ])
}
