// A small per-document cache shared by navigation and the virtualized page layer.
// Keep decoded, low-resolution images ready while the tiling layer adds detail.
export class PdfPagePreviewCache {
  private entries = new Map<number, Promise<string | null>>()
  private urls = new Map<number, string>()
  private generation = 0
  private targetPage: number | null = null

  constructor(
    private render: (pageIndex: number) => Promise<Blob>,
    private limit = 12,
    private images = {
      create: (blob: Blob) => URL.createObjectURL(blob),
      revoke: (url: string) => URL.revokeObjectURL(url),
      decode: async (url: string) => {
        const image = new Image()
        image.src = url
        await image.decode()
      },
    },
  ) {}

  get(pageIndex: number, isNavigationTarget = false): Promise<string | null> {
    if (isNavigationTarget) this.targetPage = pageIndex
    const cached = this.entries.get(pageIndex)
    if (cached) {
      const url = this.urls.get(pageIndex)
      if (url) {
        this.urls.delete(pageIndex)
        this.urls.set(pageIndex, url)
      }
      return cached
    }
    const generation = this.generation
    const pending = Promise.resolve().then(async () => {
      let url: string | undefined
      try {
        const blob = await this.render(pageIndex)
        if (generation !== this.generation) return null
        url = this.images.create(blob)
        await this.images.decode(url)
        if (generation !== this.generation) {
          this.images.revoke(url)
          return null
        }
        this.urls.set(pageIndex, url)
        while (this.urls.size > this.limit) {
          const oldest = [...this.urls.keys()].find((page) => page !== this.targetPage)!
          this.images.revoke(this.urls.get(oldest)!)
          this.urls.delete(oldest)
          this.entries.delete(oldest)
        }
        return url
      } catch {
        if (url) this.images.revoke(url)
        if (generation === this.generation) this.entries.delete(pageIndex)
        // Preview failures must not prevent navigation or high-resolution tiles.
        return null
      }
    })
    this.entries.set(pageIndex, pending)
    return pending
  }

  clear() {
    this.generation++
    this.targetPage = null
    for (const url of this.urls.values()) this.images.revoke(url)
    this.urls.clear()
    this.entries.clear()
  }
}
