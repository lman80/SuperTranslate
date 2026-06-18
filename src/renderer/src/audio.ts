import workletSource from './pcm-worklet.js?raw'

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

// While the app is speaking a translation aloud, we mute capture so the spoken
// audio isn't picked up by the system-audio loopback (or mic) and re-translated
// in a feedback loop.
let captureMuted = false
export function setCaptureMuted(muted: boolean): void {
  captureMuted = muted
}

export interface CaptureResult {
  stop: () => void
  systemAudioActive: boolean
}

export interface CaptureOptions {
  captureSystemAudio: boolean
  onWarning: (message: string) => void
  onSystemLevel?: (rms: number) => void // live loudness of captured system audio (0..1)
}

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
  worklet.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
    if (captureMuted) return // don't feed our own spoken translation back in
    window.api.sendAudio(source, e.data)
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
  captureMuted = false

  // 1. Microphone (you)
  const mic = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: false
  })
  streams.push(mic)
  await pipeStreamToPcm('mic', mic, contexts)

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
        opts.onWarning(
          'System audio needs permission. Open System Settings → Privacy & Security → Screen & System Audio Recording, turn on SuperTranslate, then quit and reopen the app.'
        )
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
        err.name === 'NotAllowedError'
          ? 'System audio permission was denied. Enable SuperTranslate under System Settings → Privacy & Security → Screen & System Audio Recording, then quit and reopen the app.'
          : `Could not capture system audio: ${err.message}`
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
