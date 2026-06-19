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
  endpointDelayMs?: number // max wait after a pause before finalizing (lower = faster, more splits)
}

// Emit a translatable chunk well before the speaker pauses, so long continuous
// speech doesn't pile up into one enormous late block. We flush finalized text on
// sentence punctuation, at a length cap, or after a short time cap.
const MAX_CHUNK_CHARS = 90
const MAX_CHUNK_MS = 4000
// CJK enders need no trailing space; ASCII enders must be followed by space/end so
// "3.14" / "Mr." don't split mid-token.
const SENT_END = /[。！？…][”’"')\]）】»]*|[.!?]+[”’"')\]]*(?=\s|$)/

export class SonioxSession {
  private ws: WebSocket | null = null
  private finalText = ''
  private lastLanguage = '' // persists across messages; a chunk may finalize across several
  private lastFlush = 0
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
          enable_endpoint_detection: true,
          max_endpoint_delay_ms: this.cfg.endpointDelayMs ?? 1000
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
    let endpoint = false
    for (const t of msg.tokens) {
      if (t.language) this.lastLanguage = t.language
      if (t.text === '<end>') {
        endpoint = true
        continue
      }
      if (t.is_final) this.finalText += t.text
      else partialTail += t.text
    }

    // Chunk finalized text promptly (sentences / length / time), and force-flush the
    // remainder when Soniox signals an endpoint (a real pause). Tag with the last
    // detected language (a chunk can span several messages, some without a language).
    this.flush(this.lastLanguage, endpoint)

    const live = (this.finalText + partialTail).trim()
    if (live) this.cb.onPartial(live)
  }

  private flush(language: string, force: boolean): void {
    let flushedAny = false
    const emit = (chunk: string): void => {
      const c = chunk.trim()
      if (c) {
        this.cb.onFinal(c, language)
        flushedAny = true
      }
    }

    // 1) Complete sentences.
    for (;;) {
      const m = SENT_END.exec(this.finalText)
      if (!m) break
      let end = m.index + m[0].length
      while (end < this.finalText.length && /\s/.test(this.finalText[end])) end++
      emit(this.finalText.slice(0, end))
      this.finalText = this.finalText.slice(end)
    }

    // 2) Length cap (no punctuation but getting long).
    while (this.finalText.length > MAX_CHUNK_CHARS) {
      let cut = this.finalText.lastIndexOf(' ', MAX_CHUNK_CHARS)
      if (cut < MAX_CHUNK_CHARS * 0.5) cut = MAX_CHUNK_CHARS // CJK / no good break → hard cut
      emit(this.finalText.slice(0, cut))
      this.finalText = this.finalText.slice(cut)
    }

    // 3a) Endpoint (real pause): flush whatever's left.
    if (force && this.finalText.trim()) {
      emit(this.finalText)
      this.finalText = ''
    } else if (this.finalText.trim()) {
      // 3b) Time cap: don't let a rambling speaker hold the line for too long.
      const now = Date.now()
      if (this.lastFlush === 0) this.lastFlush = now
      if (now - this.lastFlush > MAX_CHUNK_MS) {
        let cut = this.finalText.lastIndexOf(' ')
        if (cut <= 0) cut = this.finalText.length
        emit(this.finalText.slice(0, cut))
        this.finalText = this.finalText.slice(cut)
      }
    }

    if (flushedAny) this.lastFlush = Date.now()
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
    this.lastLanguage = ''
    this.lastFlush = 0
  }
}
