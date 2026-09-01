/**
 * In-memory buffer for active stream events.
 *
 * - Events are written here during streaming (fast, no DB round-trips).
 * - Text/thinking deltas are accumulated and flushed as combined events.
 * - tool_call and citation events are stored immediately.
 * - done is emitted only by complete()/fail() after final persistence.
 * - Periodic flush to DB reduces write frequency.
 * - Frontend can replay from REST or attach live subscribers for reconnection.
 */

export interface StreamUserMessage {
  id: string
  conversationId: string
  branchId: string
  role: 'user'
  content: string
  toolCalls: null
  metadata: Record<string, unknown>
  createdAt: string
}

export interface StreamEntry {
  events: Array<unknown & { eventSequence?: number }> // All sequenced events for replay
  content: string             // Accumulated text content
  thinking: string            // Accumulated thinking content
  toolCalls: Array<{ id: string; name: string; input: unknown; result?: string }>
  citations: Array<{ pageNumber: number; text: string }>
  segments: Array<{ type: 'text' | 'thinking' | 'error'; text: string } | { type: 'tool'; toolCallId: string }>
  status: 'streaming' | 'completed' | 'failed'
  conversationId: string
  originalConversationId: string
  branchId?: string
  userMessage?: StreamUserMessage
  source: 'user' | 'extension' | 'command' | 'continuation'
  initialLeafId?: string | null
  sessionFile?: string
  eventSequence: number
  createdAt: number           // Stream creation timestamp
  updatedAt: number           // Last producer activity / heartbeat timestamp
}

export interface StreamJournalContext {
  source?: StreamEntry['source']
  initialLeafId?: string | null
  sessionFile?: string
}

export type FlushFn = (
  conversationId: string,
  messageId: string,
  events: unknown[],
  finalData: {
    content: string
    thinking?: string
    citations?: Array<{ pageNumber: number; text: string }>
    segments?: Array<{ type: 'text' | 'thinking' | 'error'; text: string } | { type: 'tool'; toolCallId: string }>
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

  /** Start a new stream and durably create its in-flight journal. */
  async start(
    messageId: string,
    conversationId: string,
    branchId?: string,
    userMessage?: StreamUserMessage,
    journal: StreamJournalContext = {},
  ): Promise<void> {
    this.streams.set(messageId, {
      events: [],
      content: '',
      thinking: '',
      toolCalls: [],
      citations: [],
      segments: [],
      status: 'streaming',
      conversationId,
      originalConversationId: conversationId,
      branchId,
      userMessage,
      source: journal.source || 'user',
      initialLeafId: journal.initialLeafId,
      sessionFile: journal.sessionFile,
      eventSequence: 0,
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

    // A brand-new Pi Session may defer materializing its JSONL file until the
    // first assistant message. Await this barrier before model/Worker setup.
    try {
      await this.persistSnapshot(messageId, 'streaming')
    } catch (err) {
      clearInterval(timer)
      this.flushTimers.delete(messageId)
      this.streams.delete(messageId)
      this.textBuffers.delete(messageId)
      this.thinkBuffers.delete(messageId)
      this.persistedSnapshots.delete(messageId)
      this.persistChains.delete(messageId)
      throw err
    }
  }

  /** Append and sequence an event. Returns the exact replayable event. */
  append(messageId: string, event: unknown): (unknown & { eventSequence?: number }) | undefined {
    const entry = this.streams.get(messageId)
    if (!entry) return undefined

    entry.updatedAt = Date.now()
    const evt = event as any

    // A producer-level done only means its generator reached a terminal yield.
    // complete()/fail() owns the terminal signal after persistence.
    if (evt.type === 'done') return undefined

    const sequenced = this.sequenceEvent(entry, event)
    entry.events.push(sequenced)

    if ((evt.type === 'pi_user_entry' || evt.type === 'pi_assistant_entry') && typeof evt.sessionFile === 'string') {
      entry.sessionFile = evt.sessionFile
    }

    if (evt.type === 'text') {
      entry.content += evt.content
      const lastSegment = entry.segments[entry.segments.length - 1]
      if (lastSegment?.type === 'text') lastSegment.text += evt.content
      else entry.segments.push({ type: 'text', text: evt.content })
    } else if (evt.type === 'thinking') {
      entry.thinking += evt.content
      const lastSegment = entry.segments[entry.segments.length - 1]
      if (lastSegment?.type === 'thinking') {
        lastSegment.text += evt.content
      } else {
        let phaseThinking: { text: string } | undefined
        for (let index = entry.segments.length - 1; index >= 0; index--) {
          const segment = entry.segments[index]
          if (segment.type === 'tool') break
          if (segment.type === 'thinking') {
            phaseThinking = segment
            break
          }
        }
        if (phaseThinking) phaseThinking.text += `\n\n${evt.content}`
        else entry.segments.push({ type: 'thinking', text: evt.content })
      }
    } else if (evt.type === 'tool_call') {
      let input: unknown = evt.input
      try { input = JSON.parse(evt.input) } catch {}
      const existing = entry.toolCalls.find((tool) => tool.id === evt.toolCallId)
      if (existing) { existing.name = evt.toolName; existing.input = input }
      else entry.toolCalls.push({ id: evt.toolCallId, name: evt.toolName, input })
      if (!entry.segments.some(segment => segment.type === 'tool' && segment.toolCallId === evt.toolCallId)) {
        entry.segments.push({ type: 'tool', toolCallId: evt.toolCallId })
      }
    } else if (evt.type === 'tool_result') {
      const toolCall = entry.toolCalls.find(tool => tool.id === evt.toolCallId)
      if (toolCall) toolCall.result = evt.result
    } else if (evt.type === 'citation') {
      entry.citations.push({ pageNumber: evt.pageNumber, text: evt.text })
    }

    this.notify(messageId, sequenced)
    // Commit mappings are recovery barriers and must not wait for the periodic
    // snapshot timer; recovery uses them to avoid duplicating canonical turns.
    if (evt.type === 'pi_user_entry' || evt.type === 'pi_assistant_entry') {
      void this.persistSnapshot(messageId, 'streaming').catch(() => {})
    }
    return sequenced
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

    this.notify(messageId, this.sequenceEvent(entry, { type: 'done' }))

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
      const errorEvent = this.sequenceEvent(entry, { type: 'error', message: error })
      entry.events.push(errorEvent)
      this.notify(messageId, errorEvent)
    }
    await this.persistSnapshot(messageId, 'failed')

    this.notify(messageId, this.sequenceEvent(entry, { type: 'done' }))

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

  /** Get a stable sequenced replay snapshot after the supplied cursor. */
  getEvents(messageId: string, afterSequence = 0): Array<unknown & { eventSequence?: number }> {
    const entry = this.streams.get(messageId)
    if (!entry) return []
    return entry.events.filter(event => Number(event.eventSequence || 0) > afterSequence)
  }

  /** Check if a stream is active. */
  has(messageId: string): boolean {
    return this.streams.has(messageId)
  }

  /** Update the canonical owner after an extension-driven branch/session switch. */
  updateContext(messageId: string, conversationId: string, branchId: string): void {
    const entry = this.streams.get(messageId)
    if (!entry) return
    entry.conversationId = conversationId
    entry.branchId = branchId
    if (entry.userMessage) {
      entry.userMessage.conversationId = conversationId
      entry.userMessage.branchId = branchId
    }
    entry.updatedAt = Date.now()
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

  private sequenceEvent(entry: StreamEntry, event: unknown): unknown & { eventSequence: number } {
    entry.eventSequence += 1
    return {
      ...((event && typeof event === 'object') ? event as Record<string, unknown> : { value: event }),
      eventSequence: entry.eventSequence,
    }
  }

  private notify(messageId: string, event: unknown): void {
    const subscribers = this.subscribers.get(messageId)
    if (!subscribers?.size) return
    for (const subscriber of [...subscribers]) {
      try { subscriber(event) } catch { subscribers.delete(subscriber) }
    }
  }

  private flushTextOnlySync(messageId: string): void {
    const entry = this.streams.get(messageId)
    const textBuf = this.textBuffers.get(messageId)
    if (!entry || !textBuf?.length) return

    const text = textBuf.join('')
    entry.events.push(this.sequenceEvent(entry, { type: 'text', content: text }))
    const lastSegment = entry.segments[entry.segments.length - 1]
    if (lastSegment?.type === 'text') lastSegment.text += text
    else entry.segments.push({ type: 'text', text })
    textBuf.length = 0
  }

  private flushThinkingBufferSync(messageId: string): void {
    const entry = this.streams.get(messageId)
    const thinkBuf = this.thinkBuffers.get(messageId)
    if (!entry || !thinkBuf?.length) return

    const thinking = thinkBuf.join('')
    entry.events.push(this.sequenceEvent(entry, { type: 'thinking', content: thinking }))
    const lastSegment = entry.segments[entry.segments.length - 1]
    if (lastSegment?.type === 'thinking') {
      lastSegment.text += thinking
    } else {
      // Providers may emit several reasoning blocks between two tool calls.
      // Store one thinking segment for that whole phase so replay and final
      // snapshots match the frontend's single-card presentation.
      let phaseThinking: { text: string } | undefined
      for (let index = entry.segments.length - 1; index >= 0; index--) {
        const segment = entry.segments[index]
        if (segment.type === 'tool') break
        if (segment.type === 'thinking') {
          phaseThinking = segment
          break
        }
      }
      if (phaseThinking) phaseThinking.text += `\n\n${thinking}`
      else entry.segments.push({ type: 'thinking', text: thinking })
    }
    thinkBuf.length = 0
  }

  /** Sync flush of text/thinking buffers into events array. */
  private flushTextBufferSync(messageId: string): void {
    // Channel transitions flush the previous channel immediately, so at most
    // one buffer is normally non-empty here. Keep this deterministic fallback
    // for completion and periodic snapshots.
    this.flushTextOnlySync(messageId)
    this.flushThinkingBufferSync(messageId)
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
      const signature = JSON.stringify({ finalData, eventSequence: entry.eventSequence })
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
