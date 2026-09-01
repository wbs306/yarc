import { randomUUID } from 'node:crypto'

interface RenderableComponent {
  render(width: number): string[]
  handleInput?(data: string): void
  invalidate?(): void
  dispose?(): void
  focused?: boolean
  setText?(text: string): void
  insertTextAtCursor?(text: string): void
}

interface SurfaceSnapshot {
  surfaceId: string
  revision: number
  cols: number
  rows: number
  ansi: string
  plainText: string
  hidden: boolean
}

type TuiConstructor = new (terminal: any, showHardwareCursor?: boolean, logDirectory?: string) => any

const stripAnsi = (value: string) => value
  .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
  .replace(/\u001bP[\s\S]*?\u001b\\/g, '')
  .replace(/\u001b_[\s\S]*?(?:\u0007|\u001b\\)/g, '')
  .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')

const sanitizeAnsi = (value: string) => value
  // Full snapshots contain only text and SGR. Remove clipboard, hyperlinks,
  // images, title changes, and every non-SGR terminal control sequence.
  .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
  .replace(/\u001bP[\s\S]*?\u001b\\/g, '')
  .replace(/\u001b_[\s\S]*?(?:\u0007|\u001b\\)/g, '')
  .replace(/\u001b\[([0-?]*[ -/]*)([@-~])/g, (match, _params: string, command: string) => command === 'm' ? match : '')

const characterWidth = (value: string) => {
  const code = value.codePointAt(0) || 0
  if (code === 0) return 0
  if (code >= 0x300 && code <= 0x36f) return 0
  return code >= 0x1100 && (
    code <= 0x115f || code === 0x2329 || code === 0x232a
    || (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f)
    || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xfe10 && code <= 0xfe19)
    || (code >= 0xfe30 && code <= 0xfe6f)
    || (code >= 0xff00 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6)
    || (code >= 0x1f300 && code <= 0x1faff)
  ) ? 2 : 1
}

/**
 * A bounded terminal emulator for Pi TUI differential output.
 *
 * Pi's real TUI owns rendering, overlays, focus, and input dispatch. This
 * terminal only mirrors its safe text/SGR screen state for the browser.
 */
class WebTerminal {
  private inputHandler?: (data: string) => void
  private resizeHandler?: () => void
  private screen: string[][] = [[]]
  private cursorRow = 0
  private cursorCol = 0
  private style = ''
  private stopped = false
  private snapshotQueued = false

  constructor(
    private _columns: number,
    private _rows: number,
    private readonly onScreen: (ansi: string) => void,
    private readonly onTitle?: (title: string) => void,
  ) {}

  get columns() { return this._columns }
  get rows() { return this._rows }
  get kittyProtocolActive() { return false }

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.stopped = false
    this.inputHandler = onInput
    this.resizeHandler = onResize
  }

  stop(): void {
    this.stopped = true
    this.inputHandler = undefined
    this.resizeHandler = undefined
  }

  async drainInput(): Promise<void> {}

  emitInput(data: string): void {
    if (!this.stopped) this.inputHandler?.(data)
  }

  resize(columns: number, rows: number): void {
    this._columns = Math.max(20, Math.min(300, Math.floor(columns)))
    this._rows = Math.max(4, Math.min(120, Math.floor(rows)))
    this.resizeHandler?.()
    this.queueSnapshot()
  }

  write(data: string): void {
    if (this.stopped || !data) return
    const before = this.serializeScreen()
    this.apply(data)
    if (this.serializeScreen() !== before) this.queueSnapshot()
  }

  moveBy(lines: number): void {
    this.cursorRow = Math.max(0, this.cursorRow + Math.trunc(lines))
    this.ensureRow(this.cursorRow)
  }

  hideCursor(): void {}
  showCursor(): void {}

  clearLine(): void {
    this.screen[this.cursorRow] = []
    this.cursorCol = 0
    this.queueSnapshot()
  }

  clearFromCursor(): void {
    const row = this.ensureRow(this.cursorRow)
    row.splice(this.cursorCol)
    this.queueSnapshot()
  }

  clearScreen(): void {
    this.screen = [[]]
    this.cursorRow = 0
    this.cursorCol = 0
    this.queueSnapshot()
  }

  setTitle(title: string): void { this.onTitle?.(title) }
  setProgress(): void {}

  private ensureRow(index: number): string[] {
    while (this.screen.length <= index) this.screen.push([])
    return this.screen[index]
  }

  private apply(data: string): void {
    for (let index = 0; index < data.length;) {
      const char = data[index]
      if (char === '\u001b') {
        const next = data[index + 1]
        if (next === '[') {
          const match = data.slice(index).match(/^\u001b\[([0-?]*[ -/]*)([@-~])/)
          if (match) {
            this.applyCsi(match[1], match[2])
            index += match[0].length
            continue
          }
        }
        if (next === ']' || next === 'P' || next === '_') {
          const bel = data.indexOf('\u0007', index + 2)
          const st = data.indexOf('\u001b\\', index + 2)
          const end = bel >= 0 && (st < 0 || bel < st) ? bel + 1 : st >= 0 ? st + 2 : data.length
          index = end
          continue
        }
        index += Math.min(2, data.length - index)
        continue
      }
      if (char === '\r') {
        this.cursorCol = 0
        index += 1
        continue
      }
      if (char === '\n') {
        this.cursorRow += 1
        this.cursorCol = 0
        this.ensureRow(this.cursorRow)
        index += 1
        continue
      }
      if (char < ' ' || char === '\u007f') {
        index += 1
        continue
      }

      const codePoint = data.codePointAt(index)!
      const value = String.fromCodePoint(codePoint)
      const width = characterWidth(value)
      const row = this.ensureRow(this.cursorRow)
      while (row.length < this.cursorCol) row.push(' ')
      const rendered = this.style ? `${this.style}${value}\u001b[0m` : value
      row[this.cursorCol] = rendered
      if (width === 2) row[this.cursorCol + 1] = ''
      this.cursorCol += Math.max(0, width)
      index += value.length
    }
  }

  private applyCsi(rawParams: string, command: string): void {
    const normalized = rawParams.replace(/[?>!]/g, '')
    const params = normalized.split(';').filter(Boolean).map(value => Number(value) || 0)
    const first = params[0] || 0
    if (command === 'm') {
      if (!params.length || params.includes(0)) this.style = ''
      const nonReset = params.filter(value => value !== 0)
      if (nonReset.length) this.style += `\u001b[${nonReset.join(';')}m`
      return
    }
    if (command === 'A') this.cursorRow = Math.max(0, this.cursorRow - (first || 1))
    else if (command === 'B') this.cursorRow += first || 1
    else if (command === 'C') this.cursorCol += first || 1
    else if (command === 'D') this.cursorCol = Math.max(0, this.cursorCol - (first || 1))
    else if (command === 'G') this.cursorCol = Math.max(0, (first || 1) - 1)
    else if (command === 'H' || command === 'f') {
      this.cursorRow = Math.max(0, (params[0] || 1) - 1)
      this.cursorCol = Math.max(0, (params[1] || 1) - 1)
    } else if (command === 'J' && (first === 2 || first === 3)) {
      this.screen = [[]]
      this.cursorRow = 0
      this.cursorCol = 0
    } else if (command === 'K') {
      const row = this.ensureRow(this.cursorRow)
      if (first === 1) row.splice(0, this.cursorCol + 1, ...Array(this.cursorCol + 1).fill(' '))
      else if (first === 2) this.screen[this.cursorRow] = []
      else row.splice(this.cursorCol)
    }
    this.ensureRow(this.cursorRow)
  }

  private serializeScreen(): string {
    const visible = this.screen.slice(0, this._rows)
    while (visible.length > 1 && visible[visible.length - 1].every(cell => !cell)) visible.pop()
    return visible.map(row => row.join('').replace(/\s+$/g, '')).join('\r\n')
  }

  private queueSnapshot(): void {
    if (this.stopped || this.snapshotQueued) return
    this.snapshotQueued = true
    queueMicrotask(() => {
      this.snapshotQueued = false
      this.onScreen(sanitizeAnsi(this.serializeScreen()))
    })
  }
}

export class WebTuiSurface {
  readonly surfaceId = randomUUID()
  readonly terminal: WebTerminal
  readonly tui: any
  private component: RenderableComponent | null = null
  private revision = 0
  private overlayHidden = false
  private stopped = false

  constructor(
    cols: number,
    rows: number,
    TUI: TuiConstructor,
    private readonly onSnapshot: (snapshot: SurfaceSnapshot) => void,
    onTitle?: (title: string) => void,
    logDirectory?: string,
  ) {
    this.cols = Math.max(20, Math.min(300, Math.floor(cols)))
    this.rows = Math.max(4, Math.min(120, Math.floor(rows)))
    this.terminal = new WebTerminal(this.cols, this.rows, ansi => this.publish(ansi), onTitle)
    this.tui = new TUI(this.terminal, false, logDirectory)
  }

  cols: number
  rows: number

  mount(component: RenderableComponent): void {
    if (this.component && this.component !== component) {
      this.tui.removeChild(this.component)
      this.component.dispose?.()
    }
    this.component = component
    this.tui.addChild(component)
    this.tui.setFocus(component)
    this.tui.requestRender(true)
  }

  invalidate(): void {
    this.tui.invalidate()
    this.tui.requestRender(true)
  }

  start(): void {
    this.stopped = false
    this.tui.start()
  }

  stop(): void {
    this.stopped = true
    this.tui.stop()
  }

  dispose(): void {
    if (this.stopped) return
    this.stopped = true
    this.component?.dispose?.()
    this.component = null
    this.tui.stop()
    this.terminal.stop()
  }

  handleInput(data: string): void { this.terminal.emitInput(data) }

  setText(text: string): void {
    this.component?.setText?.(text)
    this.tui.requestRender(true)
  }

  insertText(text: string): void {
    this.component?.insertTextAtCursor?.(text)
    this.tui.requestRender(true)
  }

  resize(cols: number, rows: number): void {
    this.cols = Math.max(20, Math.min(300, Math.floor(cols)))
    this.rows = Math.max(4, Math.min(120, Math.floor(rows)))
    this.terminal.resize(this.cols, this.rows)
    this.tui.invalidate()
    this.tui.requestRender(true)
  }

  showOverlay(component: RenderableComponent, options?: unknown): any {
    this.overlayHidden = false
    this.component = component
    const handle = this.tui.showOverlay(component, options)
    return {
      hide: () => {
        this.overlayHidden = true
        handle.hide()
        this.tui.requestRender(true)
      },
      setHidden: (hidden: boolean) => {
        this.overlayHidden = hidden
        handle.setHidden(hidden)
        this.tui.requestRender(true)
      },
      isHidden: () => handle.isHidden(),
      focus: () => handle.focus(),
      unfocus: (value?: unknown) => handle.unfocus(value),
      isFocused: () => handle.isFocused(),
    }
  }

  requestRender(force = false): void { this.tui.requestRender(force) }

  private publish(ansi: string): void {
    if (this.stopped) return
    this.revision += 1
    this.onSnapshot({
      surfaceId: this.surfaceId,
      revision: this.revision,
      cols: this.cols,
      rows: this.rows,
      ansi,
      plainText: stripAnsi(ansi),
      hidden: this.overlayHidden,
    })
  }
}

export const stripTerminalAnsi = stripAnsi
