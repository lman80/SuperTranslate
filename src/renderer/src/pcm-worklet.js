// AudioWorklet: downmix to mono and convert Float32 -> Int16 (PCM s16le).
// The AudioContext is created at 16 kHz, so Chromium has already resampled the
// input; this processor only needs to mix down and quantize.
class PCM16kWriter extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0]
    if (!input || input.length === 0) return true
    const channels = input.length
    const frames = input[0].length
    if (frames === 0) return true

    const pcm = new Int16Array(frames)
    for (let i = 0; i < frames; i++) {
      let sum = 0
      for (let ch = 0; ch < channels; ch++) sum += input[ch][i]
      let s = sum / channels
      s = Math.max(-1, Math.min(1, s))
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff
    }
    this.port.postMessage(pcm.buffer, [pcm.buffer])
    return true
  }
}

registerProcessor('pcm-16k-writer', PCM16kWriter)
