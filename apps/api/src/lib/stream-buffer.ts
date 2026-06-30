/**
 * In-memory buffer for active stream events.
 *
 * - Events are written here during streaming (fast, no DB round-trips).
 * - Text/thinking deltas are accumulated and flushed as combined events.
 * - tool_call, citation, done events are stored immediately.
 * - Periodic flush to DB reduces write frequency.
 * - Frontend can replay from REST or attach live subscribers for reconnection.
 */

export interface StreamEntry {
  events: unknown[]           // All events for replay
  content: string             // Accumulated text content
  thinking: string            // Accumulated thinking content
  toolCalls: Array<{ id: string; name: string; input: unknown; result?: string }>
  citations: Array<{ pageNumber: number; text: string }>
  segments: Array<{ type: 'text' | 'error'; text: string } | { type: 'tool'; toolCallId: string }>
  status: 'streaming' | 'completed' | 'failed'
  conversationId: string
  branchId?: string
  createdAt: number           // Stream creation timestamp
  updatedAt: number           // Last producer activity / heartbeat timestamp
}

export type FlushFn = (
  conversationId: string,
  messageId: string,
  events: unknown[],
  finalData: {
    content: string
    thinking?: string
    citations?: Array<{ pageNumber: number; text: string }>
    segments?: Array<{ type: 'text' | 'error'; text: string } | { type: 'tool'; toolCallId: string }>
    toolCalls?: Array<{ id: string; name: string; input: unknown; result?: string }>
    status: 'streaming' | 'completed' | 'failed'
  }
) => Promise<void>

type StreamSubscriber = (event: unknown) => void

export class StreamBuffer {
  private streams = new Map<string, StreamEntry>()
  private textBuffers = new Map<string, string[]>()
  private thinkBuffers = new Map<string, string[]>()
  private flushTimers = new Map<string, ReturnType<typeof setInterval>>()
  private subscribers = new Map<string, Set<StreamSubscriber>>()
  private persistedSnapshots = new Map<string, string>()
  private persistChains = new Map<string, Promise<void>>()
  private flushFn: FlushFn
  private flushIntervalMs: number
  private timeoutMs: number

  constructor(opts: { flushFn: FlushFn; flushIntervalMs?: number; timeoutMs?: number }) {
    this.flushFn = opts.flushFn
    this.flushIntervalMs = opts.flushIntervalMs ?? 2000
    this.timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000
  }

  /** Start a new stream for a message. */
  start(messageId: string, conversationId: string, branchId?: string): void {
    this.streams.set(messageId, {
      events: [],
      content: '',
      thinking: '',
      toolCalls: [],
      citations: [],
      segments: [],
      status: 'streaming',
      conversationId,
      branchId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    this.textBuffers.set(messageId, [])
    this.thinkBuffers.set(messageId, [])

    // Periodic flush for text/thinking buffers
    const timer = setInterval(() => {
      this.flushTextBuffer(messageId).catch(() => {})
    }, this.flushIntervalMs)
    this.flushTimers.set(messageId, timer)
  }

  /** Append an event to the stream. */
  append(messageId: string, event: unknown): void {
    const entry = this.streams.get(messageId)
    if (!entry) return

    entry.updatedAt = Date.now()
    const evt = event as any

    if (evt.type === 'text') {
      this.textBuffers.get(messageId)?.push(evt.content)
      entry.content += evt.content
      this.notify(messageId, event)
    } else if (evt.type === 'thinking') {
      this.thinkBuffers.get(messageId)?.push(evt.content)
      entry.thinking += evt.content
      this.notify(messageId, event)
    } else {
      // Flush text/thinking buffers before non-text events
      this.flushTextBufferSync(messageId)
      entry.events.push(event)

      if (evt.type === 'tool_call') {
        let input: unknown = evt.input
        try { input = JSON.parse(evt.input) } catch {}
        const existing = entry.toolCalls.find((t) => t.id === evt.toolCallId)
        if (existing) { existing.name = evt.toolName; existing.input = input }
        else entry.toolCalls.push({ id: evt.toolCallId, name: evt.toolName, input })
        if (!entry.segments.some((s) => s.type === 'tool' && s.toolCallId === evt.toolCallId)) {
          entry.segments.push({ type: 'tool', toolCallId: evt.toolCallId })
        }
      } else if (evt.type === 'tool_result') {
        const tc = entry.toolCalls.find((t) => t.id === evt.toolCallId)
        if (tc) tc.result = evt.result
      } else if (evt.type === 'citation') {
        entry.citations.push({ pageNumber: evt.pageNumber, text: evt.text })
      }

      // A done event is stored immediately for replay, but subscribers are
      // notified only after complete() has persisted the final message. This
      // prevents reconnecting clients from fetching a still-stale DB row and
      // replacing visible streamed content with an empty placeholder.
      if (evt.type !== 'done') this.notify(messageId, event)
    }
  }

  /** Complete the stream: flush everything to DB and clean up. */
  async complete(messageId: string): Promise<void> {
    const entry = this.streams.get(messageId)
    if (!entry) return

    // Stop timer
    const timer = this.flushTimers.get(messageId)
    if (timer) { clearInterval(timer); this.flushTimers.delete(messageId) }

    // Flush remaining text/thinking
    this.flushTextBufferSync(messageId)

    entry.status = 'completed'

    await this.persistSnapshot(messageId, 'completed')

    this.notify(messageId, { type: 'done' })

    // Clean up
    this.streams.delete(messageId)
    this.textBuffers.delete(messageId)
    this.thinkBuffers.delete(messageId)
    this.subscribers.delete(messageId)
    this.persistedSnapshots.delete(messageId)
    this.persistChains.delete(messageId)
  }

  /** Mark stream as failed: flush with current content and clean up. */
  async fail(messageId: string, error?: string): Promise<void> {
    const entry = this.streams.get(messageId)
    if (!entry) return

    const timer = this.flushTimers.get(messageId)
    if (timer) { clearInterval(timer); this.flushTimers.delete(messageId) }
    this.flushTextBufferSync(messageId)

    entry.status = 'failed'
    if (error) {
      const text = `❌ ${error}`
      entry.content += entry.content ? `\n\n${text}` : text
      entry.segments.push({ type: 'error', text })
      const errorEvent = { type: 'error', message: error }
      entry.events.push(errorEvent)
      this.notify(messageId, errorEvent)
    }
    const doneEvent = { type: 'done' }
    entry.events.push(doneEvent)
    this.notify(messageId, doneEvent)

    await this.persistSnapshot(messageId, 'failed')

    this.streams.delete(messageId)
    this.textBuffers.delete(messageId)
    this.thinkBuffers.delete(messageId)
    this.subscribers.delete(messageId)
    this.persistedSnapshots.delete(messageId)
    this.persistChains.delete(messageId)
  }

  /** Subscribe to live events for an active stream. */
  subscribe(messageId: string, subscriber: StreamSubscriber): () => void {
    let subscribers = this.subscribers.get(messageId)
    if (!subscribers) {
      subscribers = new Set()
      this.subscribers.set(messageId, subscribers)
    }
    subscribers.add(subscriber)
    return () => {
      subscribers?.delete(subscriber)
      if (subscribers?.size === 0) this.subscribers.delete(messageId)
    }
  }

  /** Get the current state of a stream (for REST API replay). */
  get(messageId: string): StreamEntry | undefined {
    return this.streams.get(messageId)
  }

  /** Get all events for a stream (for replay). */
  getEvents(messageId: string): unknown[] {
    const entry = this.streams.get(messageId)
    if (!entry) return []

    // Materialize buffered text/thinking before returning. This makes replay
    // offsets stable across polling calls; otherwise an unflushed text event can
    // grow in place and a reconnecting client may miss the later suffix.
    this.flushTextBufferSync(messageId)
    return [...entry.events]
  }

  /** Check if a stream is active. */
  has(messageId: string): boolean {
    return this.streams.has(messageId)
  }

  /** Refresh producer liveness without emitting a user-visible event. */
  touch(messageId: string): void {
    const entry = this.streams.get(messageId)
    if (entry) entry.updatedAt = Date.now()
  }

  /** Clean up timed-out streams. */
  async cleanup(): Promise<void> {
    const now = Date.now()
    for (const [messageId, entry] of this.streams) {
      if (now - entry.updatedAt > this.timeoutMs) {
        await this.fail(messageId, 'Stream timed out')
      }
    }
  }

  private notify(messageId: string, event: unknown): void {
    const subscribers = this.subscribers.get(messageId)
    if (!subscribers?.size) return
    for (const subscriber of [...subscribers]) {
      try { subscriber(event) } catch { subscribers.delete(subscriber) }
    }
  }

  /** Sync flush of text/thinking buffers into events array. */
  private flushTextBufferSync(messageId: string): void {
    const entry = this.streams.get(messageId)
    if (!entry) return

    const textBuf = this.textBuffers.get(messageId)
    if (textBuf?.length) {
      const text = textBuf.join('')
      entry.events.push({ type: 'text', content: text })
      const lastSegment = entry.segments[entry.segments.length - 1]
      if (lastSegment?.type === 'text') lastSegment.text += text
      else entry.segments.push({ type: 'text', text })
      textBuf.length = 0
    }

    const thinkBuf = this.thinkBuffers.get(messageId)
    if (thinkBuf?.length) {
      entry.events.push({ type: 'thinking', content: thinkBuf.join('') })
      thinkBuf.length = 0
    }
  }

  private buildFinalData(
    entry: StreamEntry,
    status: 'streaming' | 'completed' | 'failed'
  ) {
    return {
      content: entry.content,
      thinking: entry.thinking || undefined,
      citations: entry.citations.length ? entry.citations : undefined,
      segments: entry.segments.length ? entry.segments : undefined,
      toolCalls: entry.toolCalls.length ? entry.toolCalls : undefined,
      status,
    }
  }

  private async persistSnapshot(messageId: string, status: 'streaming' | 'completed' | 'failed'): Promise<void> {
    const previous = this.persistChains.get(messageId) || Promise.resolve()
    const operation = previous.catch(() => {}).then(async () => {
      const entry = this.streams.get(messageId)
      if (!entry) return
      if (status === 'streaming' && entry.status !== 'streaming') return

      // Fallback for snapshots requested before a text-buffer flush has created
      // segment data. Normal text deltas are represented in flushTextBufferSync.
      const hasTextSegment = entry.segments.some((s) => s.type === 'text')
      if (status !== 'failed' && entry.content && !hasTextSegment) {
        entry.segments.push({ type: 'text', text: entry.content })
      }

      const finalData = this.buildFinalData(entry, status)
      const signature = JSON.stringify(finalData)
      if (status === 'streaming' && this.persistedSnapshots.get(messageId) === signature) return
      await this.flushFn(entry.conversationId, messageId, entry.events, finalData)
      this.persistedSnapshots.set(messageId, signature)
    })

    this.persistChains.set(messageId, operation)
    try {
      await operation
    } finally {
      if (this.persistChains.get(messageId) === operation) this.persistChains.delete(messageId)
    }
  }

  /** Async flush (for periodic timer). */
  private async flushTextBuffer(messageId: string): Promise<void> {
    this.flushTextBufferSync(messageId)
    await this.persistSnapshot(messageId, 'streaming')
  }
}
