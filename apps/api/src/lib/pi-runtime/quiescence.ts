export interface QuiescenceSnapshot {
  idle: boolean
  streaming: boolean
  compacting: boolean
  pendingMessages: number
  activeTools: number
  pendingCommits: number
  pendingRequests: number
  epoch: number
}

export const isQuiescent = (state: QuiescenceSnapshot) => state.idle && !state.streaming
  && !state.compacting && state.pendingMessages === 0 && state.activeTools === 0
  && state.pendingCommits === 0 && state.pendingRequests === 0

// A deferred extension continuation is real work, not a stuck idle transition.
// Apply the timeout only to bookkeeping after the SDK run has settled.
export const waitForRuntimeQuiescence = async (
  snapshot: () => QuiescenceSnapshot,
  waitForAgentIdle: () => Promise<void>,
  timeoutMs = 30_000,
) => {
  let stable = 0
  let previousEpoch = snapshot().epoch
  let deadline = Date.now() + timeoutMs
  for (;;) {
    await new Promise<void>(resolve => setTimeout(resolve, 5))
    const state = snapshot()
    if (!state.idle || state.streaming) {
      await waitForAgentIdle()
      deadline = Date.now() + timeoutMs
      stable = 0
      previousEpoch = snapshot().epoch
      continue
    }
    if (isQuiescent(state) && previousEpoch === state.epoch) stable += 1
    else stable = 0
    if (stable >= 2) return
    if (Date.now() >= deadline) {
      throw new Error(`Runtime did not reach a stable idle state: ${JSON.stringify(state)}`)
    }
    previousEpoch = state.epoch
  }
}
