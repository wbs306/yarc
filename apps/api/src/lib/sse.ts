/**
 * Lightweight SSE hub: backend pushes paper/task status changes to connected
 * frontends.  Each connected client receives every event (fan-out); filtering
 * is the client's responsibility.
 */

type Client = {
  id: string
  controller: ReadableStreamDefaultController
  alive: boolean
}

class SSEHub {
  private clients = new Map<string, Client>()

  add(id: string, controller: ReadableStreamDefaultController): () => void {
    const client: Client = { id, controller, alive: true }
    this.clients.set(id, client)
    // Send initial keepalive
    this.sendTo(client, { type: 'connected', clientId: id })
    return () => {
      this.clients.delete(id)
    }
  }

  /** Broadcast a status event to all connected clients. */
  emit(event: { type: string; paperId?: string; [k: string]: unknown }) {
    const payload = JSON.stringify(event)
    for (const client of this.clients.values()) {
      try {
        client.controller.enqueue(`data: ${payload}\n\n`)
      } catch {
        this.clients.delete(client.id)
      }
    }
  }

  private sendTo(client: Client, data: unknown) {
    try {
      client.controller.enqueue(`data: ${JSON.stringify(data)}\n\n`)
    } catch {
      this.clients.delete(client.id)
    }
  }

  get size() {
    return this.clients.size
  }
}

export const sseHub = new SSEHub()
