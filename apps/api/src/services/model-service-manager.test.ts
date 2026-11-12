import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { ModelServiceManager } from '../lib/model-service-manager.js'

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

const waitFor = async (predicate: () => Promise<boolean>, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await wait(25)
  }
  assert.fail(`Condition was not met within ${timeoutMs}ms`)
}

const listen = async (server: Server) => {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return address.port
}

const close = async (server: Server) => {
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
  })
}

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`

const nodeCommand = (script: string) => {
  const encoded = Buffer.from(script).toString('base64')
  return `${shellQuote(process.execPath)} -e ` + shellQuote(`eval(Buffer.from('${encoded}', 'base64').toString())`)
}

const healthy = async (url: string) => {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(250) })
    await response.body?.cancel()
    return response.ok
  } catch {
    return false
  }
}

const stopPidFile = async (path: string) => {
  try {
    const pid = Number(await readFile(path, 'utf-8'))
    if (Number.isInteger(pid) && pid > 0) process.kill(pid, 'SIGTERM')
  } catch {
    // The managed stop command already removed the temporary process.
  }
}

describe('ModelServiceManager', () => {
  it('starts a missing service and stops its own process after the idle TTL', async t => {
    const portProbe = createServer()
    const port = await listen(portProbe)
    await close(portProbe)

    const healthUrl = `http://127.0.0.1:${port}/health`
    const manager = new ModelServiceManager({
      name: 'test-managed',
      apiUrl: healthUrl,
      healthUrl,
      startCommand: nodeCommand(`
        const http = require('node:http')
        http.createServer((request, response) => {
          if (request.url === '/health') {
            response.writeHead(200)
            response.end('ok')
            return
          }
          response.writeHead(404)
          response.end()
        }).listen(${port}, '127.0.0.1')
      `),
      startupTimeoutMs: 4_000,
      idleTtlMs: 50,
    })
    let queued = 1
    manager.setQueueDepthProvider(() => queued)
    t.after(() => manager.dispose())

    const lease = await manager.acquire()
    assert.equal(await healthy(healthUrl), true)
    lease.release()

    await wait(150)
    assert.equal(await healthy(healthUrl), true)
    queued = 0
    manager.notifyQueueChanged()
    await waitFor(async () => !(await healthy(healthUrl)))
    await manager.dispose()
  })

  it('queues leases beyond the configured model capacity', async t => {
    const external = createServer((request, response) => {
      if (request.url === '/health') {
        response.writeHead(200)
        response.end('ok')
        return
      }
      response.writeHead(404)
      response.end()
    })
    const port = await listen(external)
    const healthUrl = `http://127.0.0.1:${port}/health`
    const manager = new ModelServiceManager({
      name: 'test-capacity',
      apiUrl: healthUrl,
      healthUrl,
      startupTimeoutMs: 1_000,
      idleTtlMs: 25,
      maxConcurrent: 1,
    })
    t.after(async () => {
      await manager.dispose()
      await close(external)
    })

    const first = await manager.acquire()
    let secondStarted = false
    const secondPromise = (async () => {
      const lease = await manager.acquire()
      secondStarted = true
      return lease
    })()

    await wait(50)
    assert.equal(secondStarted, false)

    first.release()
    const second = await secondPromise
    assert.equal(secondStarted, true)
    second.release()
  })

  it('adopts and idles an already healthy service with an explicit stop command', async t => {
    const root = await mkdtemp(join(tmpdir(), 'yarc-model-service-adopt-'))
    const stoppedFile = join(root, 'stopped')
    const external = createServer((request, response) => {
      if (request.url === '/health') {
        response.writeHead(200)
        response.end('ok')
        return
      }
      response.writeHead(404)
      response.end()
    })
    const port = await listen(external)
    const healthUrl = `http://127.0.0.1:${port}/health`
    const manager = new ModelServiceManager({
      name: 'test-adopt',
      apiUrl: healthUrl,
      healthUrl,
      startCommand: nodeCommand('process.exit(99)'),
      stopCommand: nodeCommand(`require('node:fs').writeFileSync(${JSON.stringify(stoppedFile)}, 'stopped')`),
      startupTimeoutMs: 1_000,
      idleTtlMs: 25,
    })
    t.after(async () => {
      await manager.dispose()
      await close(external)
      await rm(root, { recursive: true, force: true })
    })

    await waitFor(async () => {
      try {
        await readFile(stoppedFile, 'utf8')
        return true
      } catch {
        return false
      }
    })
  })

  it('uses explicit supervisor commands for start and stop', async t => {
    const root = await mkdtemp(join(tmpdir(), 'yarc-model-service-'))
    const pidFile = join(root, 'service.pid')
    const portProbe = createServer()
    const port = await listen(portProbe)
    await close(portProbe)

    const healthUrl = `http://127.0.0.1:${port}/health`
    const serverScript = `
      const http = require('node:http')
      http.createServer((request, response) => {
        if (request.url === '/health') {
          response.writeHead(200)
          response.end('ok')
          return
        }
        response.writeHead(404)
        response.end()
      }).listen(${port}, '127.0.0.1')
    `
    const startScript = `
      const { spawn } = require('node:child_process')
      const fs = require('node:fs')
      const child = spawn(process.execPath, ['-e', ${JSON.stringify(serverScript)}], { detached: true, stdio: 'ignore' })
      child.unref()
      fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid))
    `
    const stopScript = `
      const fs = require('node:fs')
      const path = ${JSON.stringify(pidFile)}
      if (fs.existsSync(path)) {
        const pid = Number(fs.readFileSync(path, 'utf8'))
        try { process.kill(pid, 'SIGTERM') } catch {}
        fs.unlinkSync(path)
      }
    `
    const manager = new ModelServiceManager({
      name: 'test-supervisor',
      apiUrl: healthUrl,
      healthUrl,
      startCommand: nodeCommand(startScript),
      stopCommand: nodeCommand(stopScript),
      startupTimeoutMs: 4_000,
      idleTtlMs: 50,
    })
    t.after(async () => {
      await manager.dispose()
      await stopPidFile(pidFile)
      await rm(root, { recursive: true, force: true })
    })

    const lease = await manager.acquire()
    assert.equal(await healthy(healthUrl), true)
    lease.release()
    await waitFor(async () => !(await healthy(healthUrl)))
  })

  it('does not stop a healthy service it did not start', async t => {
    const external = createServer((request, response) => {
      if (request.url === '/health') {
        response.writeHead(200)
        response.end('ok')
        return
      }
      response.writeHead(404)
      response.end()
    })
    const port = await listen(external)
    const healthUrl = `http://127.0.0.1:${port}/health`
    const manager = new ModelServiceManager({
      name: 'test-external',
      apiUrl: healthUrl,
      healthUrl,
      startCommand: nodeCommand('process.exit(99)'),
      startupTimeoutMs: 1_000,
      idleTtlMs: 25,
    })
    t.after(async () => {
      await manager.dispose()
      await close(external)
    })

    const lease = await manager.acquire()
    lease.release()
    await manager.dispose()
    await wait(75)
    assert.equal(await healthy(healthUrl), true)
  })
})
