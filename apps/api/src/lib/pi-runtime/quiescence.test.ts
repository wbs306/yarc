import assert from 'node:assert/strict'
import test from 'node:test'
import { waitForRuntimeQuiescence, type QuiescenceSnapshot } from './quiescence.js'

const idle = (): QuiescenceSnapshot => ({
  idle: true, streaming: false, compacting: false, pendingMessages: 0,
  activeTools: 0, pendingCommits: 0, pendingRequests: 0, epoch: 0,
})

test('deferred continuation may run longer than the bookkeeping timeout', async () => {
  const state = idle()
  state.idle = false
  state.streaming = true
  state.activeTools = 3
  await waitForRuntimeQuiescence(() => state, async () => {
    await new Promise(resolve => setTimeout(resolve, 80))
    Object.assign(state, idle(), { epoch: 6 })
  }, 25)
})

test('multiple deferred continuations reset the bookkeeping deadline', async () => {
  const state = idle()
  state.idle = false
  let runs = 0
  await waitForRuntimeQuiescence(() => state, async () => {
    runs++
    await new Promise(resolve => setTimeout(resolve, 40))
    Object.assign(state, idle(), { epoch: runs })
    if (runs === 1) setTimeout(() => { state.idle = false }, 0)
  }, 20)
  assert.equal(runs, 2)
})

test('unsettled tools and host callbacks time out with state diagnostics', async () => {
  const state = { ...idle(), activeTools: 1, pendingRequests: 2 }
  await assert.rejects(waitForRuntimeQuiescence(() => state, async () => {}, 20),
    /stable idle state: .*"activeTools":1.*"pendingRequests":2/)
})

test('idle SDK is not enough while other tool results are outstanding', async () => {
  const state = { ...idle(), activeTools: 2 }
  const timer = setTimeout(() => { state.activeTools = 0; state.epoch++ }, 30)
  try {
    await waitForRuntimeQuiescence(() => state, async () => {}, 100)
    assert.equal(state.activeTools, 0)
  } finally { clearTimeout(timer) }
})
