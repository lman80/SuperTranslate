import workletSource from './pcm-worklet.js?raw'

const IS_MAC = window.api.platform === 'darwin'
const SYS_DENIED = IS_MAC
  ? 'System audio permission was denied. Enable SuperTranslate under System Settings → Privacy & Security → Screen & System Audio Recording, then quit and reopen the app.'
  : 'No system audio is being captured. Make sure the call is playing, your output isn’t muted, and use headphones so the translation doesn’t echo back.'

// Load the worklet from its raw source via a Blob URL. This avoids bundler
// inlining/transform issues and works identically in dev and packaged builds.
let workletBlobUrl: string | null = null
function getWorkletUrl(): string {
  if (!workletBlobUrl) {
    workletBlobUrl = URL.createObjectURL(
      new Blob([workletSource], { type: 'application/javascript' })
    )
  }
  return workletBlobUrl
}

// Per-source muting so a spoken translation isn't fed back in. We mute the MIC
// while any voice plays (so it doesn't transcribe the dub), and mute SYSTEM only
// for the non-Turbo TTS path (Turbo/Gemini needs continuous system input).
let micMuted = false
let systemMuted = false
export function setMicMuted(muted: boolean): void {
  micMuted = muted
}
export function setSystemMuted(muted: boolean): void {
  systemMuted = muted
}

export interface CaptureResult {
  stop: () => void
  systemAudioActive: boolean
}

export interface CaptureOptions {
  captureSystemAudio: boolean
  captureMic: boolean
  onWarning: (message: string) => void
  onSystemLevel?: (rms: number) => void // live loudness of captured system audio (0..1)
}

const BATCH_SAMPLES = 1600 // ~100ms at 16kHz — what Gemini/Soniox prefer

async function pipeStreamToPcm(
  source: 'mic' | 'system',
  stream: MediaStream,
  contexts: AudioContext[]
): Promise<void> {
  const ctx = new AudioContext({ sampleRate: 16000 })
  contexts.push(ctx)
  await ctx.audioWorklet.addModule(getWorkletUrl())
  const srcNode = ctx.createMediaStreamSource(stream)
  const worklet = new AudioWorkletNode(ctx, 'pcm-16k-writer', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    channelCount: 1
  })
  // Batch the worklet's tiny 128-sample frames into ~100ms chunks before sending.
  let batch: Int16Array[] = []
  let batched = 0
  worklet.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
    const muted = source === 'mic' ? micMuted : systemMuted
    if (muted) {
      batch = []
      batched = 0
      return // don't feed our own spoken translation back in
    }
    const frame = new Int16Array(e.data)
    batch.push(frame)
    batched += frame.length
    if (batched >= BATCH_SAMPLES) {
      const merged = new Int16Array(batched)
      let off = 0
      for (const c of batch) {
        merged.set(c, off)
        off += c.length
      }
      batch = []
      batched = 0
      window.api.sendAudio(source, merged.buffer)
    }
  }
  // Keep the graph "pulled" without audible playback (gain 0 -> destination).
  const mute = ctx.createGain()
  mute.gain.value = 0
  srcNode.connect(worklet)
  worklet.connect(mute)
  mute.connect(ctx.destination)
}

export async function startCapture(opts: CaptureOptions): Promise<CaptureResult> {
  const contexts: AudioContext[] = []
  const streams: MediaStream[] = []
  const timers: ReturnType<typeof setInterval>[] = []
  let systemAudioActive = false
  micMuted = false
  systemMuted = false

  // 1. Microphone (you) — only if enabled.
  if (opts.captureMic) {
    const mic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false
    })
    streams.push(mic)
    await pipeStreamToPcm('mic', mic, contexts)
  }

  // 2. System audio (the other person on the call).
  // getDisplayMedia REQUIRES a video track — requesting video:false throws
  // "Invalid capture constraints". We request a tiny 4x4 video and discard it.
  if (opts.captureSystemAudio) {
    try {
      // A real (small) video size is required — a tiny 4x4 makes macOS hand back a
      // SILENT audio track on some Macs (Electron #49607). 320x240 avoids that.
      const display = await navigator.mediaDevices.getDisplayMedia({
        audio: true,
        video: { width: 320, height: 240, frameRate: 5 }
      })
      display.getVideoTracks().forEach((t) => {
        t.stop()
        display.removeTrack(t)
      })
      const track = display.getAudioTracks()[0]
      if (!track || track.readyState !== 'live') {
        opts.onWarning(SYS_DENIED)
      } else {
        streams.push(display)
        await pipeStreamToPcm('system', display, contexts)
        systemAudioActive = true

        // Live level meter on the captured system audio, so we can SEE if it's silent.
        if (opts.onSystemLevel) {
          const meterCtx = new AudioContext()
          contexts.push(meterCtx)
          const meterSrc = meterCtx.createMediaStreamSource(display)
          const analyser = meterCtx.createAnalyser()
          analyser.fftSize = 512
          meterSrc.connect(analyser)
          const buf = new Float32Array(analyser.fftSize)
          timers.push(
            setInterval(() => {
              analyser.getFloatTimeDomainData(buf)
              let sum = 0
              for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i]
              opts.onSystemLevel!(Math.sqrt(sum / buf.length))
            }, 350)
          )
        }
      }
    } catch (e) {
      const err = e as Error
      opts.onWarning(
        err.name === 'NotAllowedError' ? SYS_DENIED : `Could not capture system audio: ${err.message}`
      )
    }
  }

  return {
    systemAudioActive,
    stop: () => {
      timers.forEach((t) => clearInterval(t))
      streams.forEach((s) => s.getTracks().forEach((t) => t.stop()))
      contexts.forEach((c) => c.close().catch(() => undefined))
    }
  }
}
