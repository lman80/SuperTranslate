// macOS system-audio capture via Apple's CoreAudio process-tap (audiotee).
// Capturing ONLY the chosen app (includeProcesses) means our own output is never
// in the stream — so there's no feedback loop. Falls back to a whole-system tap.
import { execFile } from 'child_process'
import { app } from 'electron'
import { join } from 'path'

export interface RunningApp {
  pid: number
  name: string
}

// List foreground apps (Zoom, Teams, Chrome, …) with their PIDs for the picker.
export function listRunningApps(): Promise<RunningApp[]> {
  const script = `set out to ""
tell application "System Events"
  repeat with p in (every process whose background only is false)
    set out to out & (unix id of p) & "|" & (name of p) & linefeed
  end repeat
end tell
return out`
  return new Promise((resolve) => {
    execFile('osascript', ['-e', script], { timeout: 5000 }, (_err, stdout) => {
      const apps = (stdout || '')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          const i = l.indexOf('|')
          return { pid: Number(l.slice(0, i)), name: l.slice(i + 1) }
        })
        .filter((a) => a.pid > 0 && a.name)
        .sort((a, b) => a.name.localeCompare(b.name))
      resolve(apps)
    })
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
    const mod = (await import('audiotee')) as unknown as {
      AudioTee: new (o: unknown) => AudioTeeInstance
    }
    AudioTeeCtor = mod.AudioTee
  }
  return AudioTeeCtor
}

function binaryPath(): string | undefined {
  // In a packaged app the binary is unpacked next to the asar; in dev, let
  // audiotee resolve it from node_modules itself.
  if (app.isPackaged) {
    return join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'audiotee', 'bin', 'audiotee')
  }
  return undefined
}

export interface TapCallbacks {
  onData: (pcm: Buffer) => void
  onError: (message: string) => void
  onLog?: (message: string) => void
}

export class MacSystemTap {
  private tee: AudioTeeInstance | null = null
  private stopped = false

  constructor(
    private readonly includePid: number | undefined,
    private readonly cb: TapCallbacks
  ) {}

  async start(): Promise<void> {
    this.stopped = false
    const AudioTee = await loadAudioTee()
    const options: Record<string, unknown> = {
      sampleRate: 16000,
      chunkDurationMs: 100,
      binaryPath: binaryPath()
    }
    if (this.includePid && this.includePid > 0) options.includeProcesses = [this.includePid]
    const tee = new AudioTee(options)
    this.tee = tee
    tee.on('data', (chunk: unknown) => {
      if (this.stopped) return
      const data = (chunk as { data: Buffer }).data
      if (data) this.cb.onData(data)
    })
    tee.on('error', (e: unknown) =>
      this.cb.onError((e as Error)?.message ?? 'system audio capture error')
    )
    tee.on('log', (_lvl: unknown, m: unknown) =>
      this.cb.onLog?.((m as { message?: string })?.message ?? '')
    )
    await tee.start()
  }

  stop(): void {
    this.stopped = true
    try {
      void this.tee?.stop()
    } catch {
      /* ignore */
    }
    this.tee = null
  }
}
