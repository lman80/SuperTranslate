// macOS system-audio capture via ScreenCaptureKit (screencapturekit-audio-capture).
// Captures a CHOSEN APP's audio (the whole app bundle, so browser tabs work too) —
// our own output is never in the stream, so there's no feedback loop.
// Outputs 16kHz mono int16 PCM, ready for Soniox/Gemini.
import { AudioCapture } from 'screencapturekit-audio-capture'

export interface RunningApp {
  pid: number
  name: string
}

let lister: AudioCapture | null = null

// Apps that are likely producing audio (Zoom, Teams, browsers, …), with PIDs.
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

export interface TapCallbacks {
  onData: (pcm: Buffer) => void
  onLevel: (rms: number) => void
  onError: (message: string) => void
  onLog?: (message: string) => void
}

export class MacSystemTap {
  private cap: AudioCapture | null = null

  constructor(
    private readonly includePid: number | undefined,
    private readonly cb: TapCallbacks
  ) {}

  async start(): Promise<void> {
    const perm = AudioCapture.verifyPermissions()
    if (!this.includePid || this.includePid <= 0) {
      this.cb.onError(
        'Open Settings → "Capture audio from" and pick the app the other person’s voice plays from (Zoom, Teams, your browser), then Restart.'
      )
      return
    }
    const cap = new AudioCapture()
    this.cap = cap
    cap.on('audio', (s: unknown) => {
      const sample = s as { data: Buffer; rms?: number }
      if (sample.data) this.cb.onData(sample.data)
      this.cb.onLevel(sample.rms ?? 0)
    })
    cap.on('error', (e: unknown) => this.cb.onError((e as Error)?.message ?? 'capture error'))
    try {
      const ok = cap.startCapture(this.includePid, {
        format: 'int16',
        sampleRate: 16000,
        channels: 1
      })
      if (!ok) throw new Error('capture did not start')
    } catch (e) {
      if (!perm.granted) {
        this.cb.onError(
          'Screen Recording permission is needed to capture an app’s audio. Enable SuperTranslate in System Settings → Privacy & Security → Screen Recording, then use Restart.'
        )
      } else {
        this.cb.onError(
          `Couldn’t capture that app: ${(e as Error).message}. Make sure it’s playing audio, or pick a different app.`
        )
      }
    }
  }

  stop(): void {
    try {
      this.cap?.stopCapture()
      this.cap?.dispose()
    } catch {
      /* ignore */
    }
    this.cap = null
  }
}
