// Real-time speech-to-speech translation via Gemini Live Translate.
// Sends 16kHz PCM audio in, receives translated 24kHz PCM audio + source/target
// transcripts. Runs in the main process so the API key stays out of the renderer.
import { GoogleGenAI, Modality } from '@google/genai'

export type GeminiStatus = 'connecting' | 'open' | 'closed' | 'error'

export interface GeminiCallbacks {
  onOriginal: (textDelta: string) => void // source-language transcript piece
  onTranslated: (textDelta: string) => void // translated transcript piece
  onAudio: (base64Pcm24k: string) => void // translated audio chunk (24kHz PCM)
  onTurnComplete: () => void
  onStatus: (status: GeminiStatus, detail?: string) => void
  onError: (message: string) => void
}

export interface GeminiConfig {
  apiKey: string
  targetLanguageCode: string // BCP-47, e.g. 'en', 'ko', 'zh'
}

const MODEL = 'gemini-3.5-live-translate-preview'

export class GeminiLiveSession {
  // SDK Session type; kept loose to avoid coupling to the SDK's exact generics.
  private session: Awaited<ReturnType<GoogleGenAI['live']['connect']>> | null = null
  private stopped = false

  constructor(
    private readonly cfg: GeminiConfig,
    private readonly cb: GeminiCallbacks
  ) {}

  async start(): Promise<void> {
    this.stopped = false
    this.cb.onStatus('connecting')
    try {
      const ai = new GoogleGenAI({ apiKey: this.cfg.apiKey.trim() })
      this.session = await ai.live.connect({
        model: MODEL,
        config: {
          responseModalities: [Modality.AUDIO],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          translationConfig: {
            targetLanguageCode: this.cfg.targetLanguageCode,
            echoTargetLanguage: false
          }
        },
        callbacks: {
          onopen: () => this.cb.onStatus('open'),
          onmessage: (msg: any) => this.handle(msg),
          onerror: (e: any) => {
            const detail = e?.message ?? (() => { try { return JSON.stringify(e) } catch { return String(e) } })()
            // Don't surface an empty error toast — let onclose give a useful message.
            this.cb.onStatus('error', `err=${String(detail).slice(0, 300)}`)
            if (detail && detail !== '{}') this.cb.onError(`Gemini Live error: ${String(detail).slice(0, 200)}`)
          },
          onclose: (e: any) => {
            const reason = String(e?.reason ?? e?.message ?? '')
            const code = e?.code
            this.session = null
            this.cb.onStatus('closed', `code=${code ?? '?'} reason=${reason.slice(0, 300)}`)
            if (this.stopped) return
            if (code === 1007 || /api[ _]?key not valid|invalid.*key|permission|unauthor/i.test(reason)) {
              this.cb.onError(
                'Turbo: your Gemini API key was rejected. Create a fresh key at aistudio.google.com/apikey and paste it in Settings (no spaces).'
              )
            } else if (code === 1011 || /quota|rate|resource_exhausted|limit/i.test(reason)) {
              this.cb.onError(
                'Turbo hit a Gemini rate/quota limit. Wait a minute and try again, or enable billing on your Google AI Studio key.'
              )
            } else if (code !== 1000) {
              this.cb.onError(
                'Turbo lost the connection to Gemini (network hiccup or rate limit). Wait a few seconds and press Start again. If it keeps happening, your free Gemini quota may be limited.'
              )
            }
          }
        }
      })
      if (this.stopped) this.stop()
    } catch (e) {
      this.cb.onError(`Could not start Turbo (Gemini): ${(e as Error).message}`)
      this.cb.onStatus('error')
    }
  }

  private handle(msg: any): void {
    const sc = msg?.serverContent
    if (!sc) return
    if (sc.inputTranscription?.text) this.cb.onOriginal(sc.inputTranscription.text)
    if (sc.outputTranscription?.text) this.cb.onTranslated(sc.outputTranscription.text)
    for (const part of sc.modelTurn?.parts ?? []) {
      if (part?.inlineData?.data) this.cb.onAudio(part.inlineData.data)
    }
    if (sc.turnComplete) this.cb.onTurnComplete()
  }

  sendAudio(buffer: ArrayBuffer | Uint8Array): void {
    if (!this.session) return
    const b64 = Buffer.from(buffer as ArrayBuffer).toString('base64')
    try {
      this.session.sendRealtimeInput({ audio: { data: b64, mimeType: 'audio/pcm;rate=16000' } })
    } catch {
      /* ignore transient send errors */
    }
  }

  stop(): void {
    this.stopped = true
    try {
      this.session?.close()
    } catch {
      /* ignore */
    }
    this.session = null
  }
}
