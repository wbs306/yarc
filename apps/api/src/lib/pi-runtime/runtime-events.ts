export class AsyncEventQueue<T> implements AsyncIterable<T> {
  private values: T[] = []
  private waiters: Array<(result: IteratorResult<T>) => void> = []
  private ended = false
  private failure: Error | null = null

  push(value: T): void {
    if (this.ended) return
    const waiter = this.waiters.shift()
    if (waiter) waiter({ value, done: false })
    else this.values.push(value)
  }

  end(): void {
    if (this.ended) return
    this.ended = true
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined as T, done: true })
  }

  fail(error: Error): void {
    if (this.ended) return
    this.failure = error
    this.end()
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        if (this.values.length > 0) return { value: this.values.shift()!, done: false }
        if (this.failure) throw this.failure
        if (this.ended) return { value: undefined as T, done: true }
        return new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve))
      },
      return: async () => {
        this.end()
        return { value: undefined as T, done: true }
      },
    }
  }
}
