// macOS system-audio capture for the chosen app.
//  • Primary: CoreAudio process tap (audiotee) with mute → captures the app AND
//    silences its own output, so the user hears ONLY the translation. Works for
//    native apps (Zoom/Teams/Music/etc.).
//  • Fallback: ScreenCaptureKit (screencapturekit-audio-capture) → captures by app
//    bundle (so browser tabs work) but can't mute the source (slight overlap).
import { app } from 'electron'
import { join } from 'path'
import { AudioCapture } from 'screencapturekit-audio-capture'

export interface RunningApp {
  pid: number
  name: string
}

let lister: AudioCapture | null = null
export function listRunningApps(): Promise<RunningApp[]> {
  return new Promise((resolve) => {
    try {
      if (!lister) lister = new AudioCapture()
      const apps = lister.getAudioApps() as { processId: number; applicationName: string }[]
      resolve(
        apps
          .map((a) => ({ pid: a.processId, name: a.applicationName }))
          .filter((a) => a.pid > 0 && a.name)
      )
    } catch {
      resolve([])
    }
  })
}

let AudioTeeCtor: (new (o: unknown) => AudioTeeInstance) | null = null
interface AudioTeeInstance {
  on(event: string, cb: (...args: unknown[]) => void): void
  start(): Promise<void>
  stop(): Promise<void>
}
async function loadAudioTee(): Promise<new (o: unknown) => AudioTeeInstance> {
  if (!AudioTeeCtor) {
    AudioTeeCtor = (
      (await import('audiotee')) as unknown as { AudioTee: new (o: unknown) => AudioTeeInstance }
    ).AudioTee
  }
  return AudioTeeCtor
}
function audioteeBinaryPath(): string | undefined {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'audiotee', 'bin', 'audiotee')
  }
  return undefined
}

function rms16(pcm: Buffer): number {
  const n = Math.floor(pcm.length / 2)
  if (!n) return 0
  let sum = 0
  for (let i = 0; i < n; i++) {
    const v = pcm.readInt16LE(i * 2) / 32768
    sum += v * v
  }
  return Math.sqrt(sum / n)
}

export interface TapCallbacks {
  onData: (pcm: Buffer) => void
  onLevel: (rms: number) => void
  onError: (message: string) => void
  onMode?: (mode: 'muted' | 'overlap') => void
  onLog?: (message: string) => void
}

export class MacSystemTap {
  private tee: AudioTeeInstance | null = null
  private cap: AudioCapture | null = null
  private stopped = false
  private gotData = false

  constructor(
    private readonly includePid: number | undefined,
    private readonly appName: string,
    private readonly cb: TapCallbacks
  ) {}

  async start(): Promise<void> {
    this.stopped = false
    if (!this.includePid || this.includePid <= 0) {
      this.cb.onError(
        'Open Settings → "Capture audio from" and pick the app the other person’s voice plays from, then Restart.'
      )
      return
    }
    // Browsers play audio in a helper process; the CoreAudio mute-tap grabs the
    // wrong one (silent capture + mangled channels). Use ScreenCaptureKit for them.
    const isBrowser = /chrome|chromium|safari|firefox|edge|arc|brave|opera|vivaldi|webkit/i.test(
      this.appName || ''
    )
    this.cb.onLog?.(`start: pid=${this.includePid} app="${this.appName}" browser=${isBrowser}`)
    if (isBrowser) {
      this.startScreenCaptureKit()
      return
    }
    this.cb.onLog?.(`trying CoreAudio mute-tap for pid ${this.includePid}`)
    // Try the muting CoreAudio tap first.
    try {
      const AudioTee = await loadAudioTee()
      const tee = new AudioTee({
        includeProcesses: [this.includePid],
        mute: true,
        sampleRate: 16000,
        chunkDurationMs: 100,
        binaryPath: audioteeBinaryPath()
      })
      this.tee = tee
      tee.on('data', (chunk: unknown) => {
        if (this.stopped) return
        const d = (chunk as { data: Buffer }).data
        if (!d) return
        if (!this.gotData) {
          this.gotData = true
          this.cb.onMode?.('muted')
        }
        this.cb.onData(d)
        this.cb.onLevel(rms16(d))
      })
      tee.on('error', (e: unknown) => {
        // The chosen PID has no audio object (e.g. a browser → audio is in a helper).
        // Fall back to ScreenCaptureKit, which captures the whole app bundle.
        if (this.stopped || this.cap || this.gotData) return
        this.cb.onLog?.(
          `mute-tap error → falling back to ScreenCaptureKit: ${(e as Error)?.message ?? ''}`
        )
        try {
          void this.tee?.stop()
        } catch {
          /* ignore */
        }
        this.tee = null
        this.startScreenCaptureKit()
      })
      await tee.start()
    } catch {
      this.startScreenCaptureKit()
    }
  }

  private startScreenCaptureKit(): void {
    if (this.stopped) return
    this.cb.onLog?.(`ScreenCaptureKit startCapture pid ${this.includePid}`)
    try {
      const cap = new AudioCapture()
      this.cap = cap
      cap.on('audio', (s: unknown) => {
        if (this.stopped) return
        const sample = s as { data?: Buffer; rms?: number }
        if (sample.data) this.cb.onData(sample.data)
        this.cb.onLevel(sample.rms ?? 0)
      })
      cap.on('error', (e: unknown) => this.cb.onError((e as Error)?.message ?? 'capture error'))
      const ok = cap.startCapture(this.includePid as number, {
        format: 'int16',
        sampleRate: 16000,
        channels: 1
      })
      if (!ok) throw new Error('capture did not start')
      this.cb.onLog?.('ScreenCaptureKit capture started (overlap mode)')
      this.cb.onMode?.('overlap')
    } catch (e) {
      const perm = AudioCapture.verifyPermissions()
      this.cb.onError(
        perm.granted
          ? `Couldn’t capture that app: ${(e as Error).message}. Make sure it’s playing audio, or pick another app.`
          : 'Screen Recording permission is needed to capture this app. Enable SuperTranslate in System Settings → Privacy & Security → Screen Recording, then Restart.'
      )
    }
  }

  stop(): void {
    this.stopped = true
    try {
      void this.tee?.stop()
    } catch {
      /* ignore */
    }
    try {
      this.cap?.stopCapture()
      this.cap?.dispose()
    } catch {
      /* ignore */
    }
    this.tee = null
    this.cap = null
  }
}
