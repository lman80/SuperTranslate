// Real-time speech-to-speech translation via OpenAI's dedicated translation model
// (gpt-realtime-translate, on the /v1/realtime/translations WebSocket endpoint).
// Source language is auto-detected; we set the OUTPUT language. Input must be 24kHz
// mono PCM16, so we upsample our 16kHz capture before sending. Output is 24kHz PCM16,
// matching the renderer's turbo player. Runs in the main process so the key stays out
// of the renderer. Mirrors the GeminiLiveSession interface so it drops into the same
// orchestration in index.ts.
import WebSocket from 'ws'

export type OpenAIStatus = 'connecting' | 'open' | 'closed' | 'error'

export interface OpenAICallbacks {
  onOriginal: (textDelta: string) => void // source-language transcript piece
  onTranslated: (textDelta: string) => void // translated transcript piece
  onAudio: (base64Pcm24k: string) => void // translated audio chunk (24kHz PCM16)
  onTurnComplete: () => void
  onStatus: (status: OpenAIStatus, detail?: string) => void
  onError: (message: string) => void
  onLog?: (message: string) => void
}

export interface OpenAIConfig {
  apiKey: string
  targetLanguageCode: string // e.g. 'en', 'ko', 'zh'
}

const MODEL = 'gpt-realtime-translate'
const URL = `wss://api.openai.com/v1/realtime/translations?model=${MODEL}`
const IN_RATE = 16000 // our capture rate
const OUT_RATE = 24000 // what the API expects for PCM input
const MAX_RECONNECTS = 5

export class OpenAIRealtimeSession {
  private ws: WebSocket | null = null
  private stopped = false
  private authFailed = false
  private attempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private prevSample = 0
  private hasPrev = false

  constructor(
    private readonly cfg: OpenAIConfig,
    private readonly cb: OpenAICallbacks
  ) {}

  async start(): Promise<void> {
    this.stopped = false
    this.authFailed = false
    this.attempts = 0
    this.connect()
  }

  private connect(): void {
    if (this.stopped) return
    this.cb.onStatus('connecting')
    let ws: WebSocket
    try {
      ws = new WebSocket(URL, {
        headers: { Authorization: `Bearer ${this.cfg.apiKey.trim()}` }
      })
    } catch (e) {
      this.cb.onError(`Could not start Turbo (OpenAI): ${(e as Error).message}`)
      this.cb.onStatus('error')
      return
    }
    this.ws = ws

    ws.on('open', () => {
      try {
        this.attempts = 0
        this.cb.onStatus('open')
        // Configure as a simultaneous interpreter into the target language.
        this.sendJson({
          type: 'session.update',
          session: {
            audio: {
              input: {
                format: { type: 'audio/pcm', rate: OUT_RATE },
                transcription: { model: 'gpt-realtime-whisper' },
                noise_reduction: { type: 'near_field' }
              },
              output: { language: this.cfg.targetLanguageCode }
            }
          }
        })
      } catch (e) {
        this.cb.onError(`Turbo (OpenAI) config failed: ${(e as Error).message}`)
      }
    })

    ws.on('message', (data) => {
      try {
        this.handle(data)
      } catch (e) {
        this.cb.onLog?.(`handle error: ${(e as Error).message}`)
      }
    })

    // A bad key fails the HTTP upgrade (401) before 'open'.
    ws.on('unexpected-response', (_req, res) => {
      const code = res?.statusCode
      if (code === 401 || code === 403) {
        this.authFailed = true
        this.cb.onError(
          'Turbo: your OpenAI API key was rejected. Check it at platform.openai.com/api-keys and paste it in Settings (no spaces).'
        )
      } else if (code === 429) {
        this.cb.onError(
          'Turbo hit an OpenAI rate/quota limit. Wait a minute, or check billing at platform.openai.com.'
        )
      } else {
        this.cb.onError(`Turbo (OpenAI) couldn’t connect (HTTP ${code ?? '?'}).`)
      }
      this.cb.onStatus('error')
    })

    ws.on('error', (err) => {
      this.cb.onStatus('error', String(err?.message ?? err).slice(0, 200))
    })

    ws.on('close', (code, reason) => {
      const r = reason?.toString?.() ?? ''
      this.ws = null
      this.cb.onStatus('closed', `code=${code} ${r.slice(0, 200)}`)
      if (this.stopped || this.authFailed) return
      if (code === 1000) return
      // Network drop or the ~60-min session cap: auto-reconnect for a live call.
      if (this.attempts < MAX_RECONNECTS) {
        this.attempts++
        this.cb.onStatus('connecting', `reconnect ${this.attempts}`)
        this.reconnectTimer = setTimeout(() => this.connect(), 1500)
      } else {
        this.cb.onError(
          'Turbo (OpenAI) lost the connection after several retries. Press Start again.'
        )
      }
    })
  }

  private sendJson(obj: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(obj))
      } catch {
        /* ignore transient send errors */
      }
    }
  }

  private handle(raw: unknown): void {
    let evt: { type?: string; delta?: string; transcript?: string; error?: { message?: string } }
    try {
      evt = JSON.parse(typeof raw === 'string' ? raw : String(raw))
    } catch {
      return
    }
    const t = evt?.type ?? ''
    if (!t) return
    if (t === 'error') {
      this.cb.onError(`OpenAI Realtime: ${String(evt.error?.message ?? 'unknown error').slice(0, 200)}`)
      return
    }
    // Match by suffix so we tolerate session.* vs response.* prefix differences.
    if (t.endsWith('session.created') || t.endsWith('session.updated')) return
    if (t.endsWith('output_audio.delta')) {
      if (evt.delta) this.cb.onAudio(evt.delta)
      return
    }
    if (t.endsWith('output_transcript.delta') || t.endsWith('output_audio_transcript.delta')) {
      if (evt.delta) this.cb.onTranslated(evt.delta)
      return
    }
    if (t.endsWith('input_transcript.delta') || t.endsWith('input_audio_transcription.delta')) {
      if (evt.delta) this.cb.onOriginal(evt.delta)
      return
    }
    if (t.endsWith('response.done') || t.endsWith('output_audio.done')) {
      this.cb.onTurnComplete()
      return
    }
    this.cb.onLog?.(`evt ${t}`)
  }

  // Upsample 16kHz mono PCM16 -> 24kHz (ratio 1.5) with linear interpolation.
  private upsample(input: Int16Array): Int16Array {
    const ratio = OUT_RATE / IN_RATE
    const outLen = Math.round(input.length * ratio)
    const out = new Int16Array(outLen)
    for (let j = 0; j < outLen; j++) {
      const pos = j / ratio
      const i0 = Math.floor(pos)
      const frac = pos - i0
      const s0 = i0 < 0 ? (this.hasPrev ? this.prevSample : input[0]) : input[Math.min(i0, input.length - 1)]
      const s1 = i0 + 1 < input.length ? input[i0 + 1] : input[input.length - 1]
      out[j] = Math.max(-32768, Math.min(32767, Math.round(s0 + (s1 - s0) * frac)))
    }
    if (input.length) {
      this.prevSample = input[input.length - 1]
      this.hasPrev = true
    }
    return out
  }

  sendAudio(buffer: ArrayBuffer | Uint8Array): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    try {
      const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
      const inSamples = Math.floor(u8.byteLength / 2)
      if (inSamples === 0) return
      const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
      const inI16 = new Int16Array(inSamples)
      for (let i = 0; i < inSamples; i++) inI16[i] = dv.getInt16(i * 2, true)
      const out = this.upsample(inI16)
      const bytes = Buffer.allocUnsafe(out.length * 2)
      for (let i = 0; i < out.length; i++) bytes.writeInt16LE(out[i], i * 2)
      this.sendJson({ type: 'input_audio_buffer.append', audio: bytes.toString('base64') })
    } catch (e) {
      this.cb.onLog?.(`sendAudio error: ${(e as Error).message}`)
    }
  }

  stop(): void {
    this.stopped = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    try {
      this.ws?.close()
    } catch {
      /* ignore */
    }
    this.ws = null
  }
}
