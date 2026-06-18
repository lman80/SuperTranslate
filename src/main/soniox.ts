// Manages a single real-time Soniox transcription WebSocket session.
// Verified against soniox.com/docs (model stt-rt-v5, pcm_s16le @ 16kHz mono).

const SONIOX_URL = 'wss://stt-rt.soniox.com/transcribe-websocket'

export type SessionStatus = 'connecting' | 'open' | 'closed' | 'error'

export interface SonioxCallbacks {
  onPartial: (liveText: string) => void
  onFinal: (text: string, language: string) => void
  onStatus: (status: SessionStatus) => void
  onError: (message: string) => void
}

export interface SonioxConfig {
  apiKey: string
  languageHints: string[]
}

export class SonioxSession {
  private ws: WebSocket | null = null
  private finalText = ''
  private keepalive: ReturnType<typeof setInterval> | null = null
  private stopped = false

  constructor(
    private readonly cfg: SonioxConfig,
    private readonly cb: SonioxCallbacks
  ) {}

  start(): void {
    this.stopped = false
    this.cb.onStatus('connecting')
    let ws: WebSocket
    try {
      ws = new WebSocket(SONIOX_URL)
    } catch (e) {
      this.cb.onError(`Could not open Soniox connection: ${(e as Error).message}`)
      this.cb.onStatus('error')
      return
    }
    ws.binaryType = 'arraybuffer'
    this.ws = ws

    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          api_key: this.cfg.apiKey,
          model: 'stt-rt-v5',
          audio_format: 'pcm_s16le',
          sample_rate: 16000,
          num_channels: 1,
          language_hints: this.cfg.languageHints,
          enable_language_identification: true,
          enable_endpoint_detection: true
        })
      )
      this.cb.onStatus('open')
      this.keepalive = setInterval(() => {
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'keepalive' }))
      }, 10000)
    }

    ws.onmessage = (evt: MessageEvent) => this.handleMessage(evt.data)

    ws.onerror = () => {
      if (!this.stopped) this.cb.onError('Soniox connection error (check your API key / network).')
    }

    ws.onclose = () => {
      if (this.keepalive) clearInterval(this.keepalive)
      this.cb.onStatus('closed')
    }
  }

  private handleMessage(data: unknown): void {
    let msg: any
    try {
      const str =
        typeof data === 'string' ? data : Buffer.from(data as ArrayBuffer).toString('utf-8')
      msg = JSON.parse(str)
    } catch {
      return
    }

    if (msg.error_code) {
      this.cb.onError(`Soniox ${msg.error_type ?? 'error'}: ${msg.error_message ?? ''}`)
      return
    }
    if (!Array.isArray(msg.tokens)) return

    let partialTail = ''
    let language = ''
    for (const t of msg.tokens) {
      if (t.language) language = t.language
      if (t.text === '<end>') {
        const text = this.finalText.trim()
        this.finalText = ''
        if (text) this.cb.onFinal(text, language)
        continue
      }
      if (t.is_final) this.finalText += t.text
      else partialTail += t.text
    }

    const live = (this.finalText + partialTail).trim()
    if (live) this.cb.onPartial(live)
  }

  sendAudio(buffer: ArrayBuffer | Uint8Array): void {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(buffer as ArrayBuffer)
    }
  }

  stop(): void {
    this.stopped = true
    if (this.keepalive) clearInterval(this.keepalive)
    const ws = this.ws
    if (ws && ws.readyState === 1) {
      try {
        ws.send(new ArrayBuffer(0)) // signal end-of-stream
      } catch {
        /* ignore */
      }
      ws.close()
    }
    this.ws = null
    this.finalText = ''
  }
}
