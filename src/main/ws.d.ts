// Minimal ambient types for the `ws` package (we avoid installing @types/ws so that
// `npm install` can't trigger a native-module rebuild). skipLibCheck keeps this loose.
declare module 'ws' {
  import type { IncomingMessage } from 'http'
  class WebSocket {
    constructor(address: string, options?: { headers?: Record<string, string> })
    static readonly OPEN: number
    readonly readyState: number
    on(event: 'open', cb: () => void): this
    on(event: 'message', cb: (data: unknown) => void): this
    on(event: 'error', cb: (err: Error) => void): this
    on(event: 'close', cb: (code: number, reason: Buffer) => void): this
    on(event: 'unexpected-response', cb: (req: unknown, res: IncomingMessage) => void): this
    send(data: string): void
    close(code?: number, reason?: string): void
  }
  export = WebSocket
}
