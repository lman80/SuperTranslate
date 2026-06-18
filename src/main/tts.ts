// ElevenLabs text-to-speech (premium, natural voice). Called from the main
// process so the API key stays out of the renderer. Returns base64 MP3 audio.

const DEFAULT_VOICE_ID = '21m00Tcm4TlvDq8ikWAM' // Rachel — works with the multilingual model

export interface ElevenLabsOptions {
  apiKey: string
  voiceId: string
  text: string
  speed?: number // 0.7–1.2 for Flash; clamped
}

export interface TtsResult {
  audioBase64: string
  mime: string
  chars: number
}

export async function elevenLabsTts(opts: ElevenLabsOptions): Promise<TtsResult> {
  const voice = opts.voiceId?.trim() || DEFAULT_VOICE_ID
  const speed = Math.max(0.7, Math.min(1.2, opts.speed ?? 1.0))
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_128&optimize_streaming_latency=3`

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': opts.apiKey,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg'
    },
    body: JSON.stringify({
      text: opts.text,
      // Flash v2.5 = fastest multilingual model (~75ms TTFB), supports KO/ZH/EN.
      model_id: 'eleven_flash_v2_5',
      voice_settings: { stability: 0.4, similarity_boost: 0.8, speed }
    })
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    const lc = body.toLowerCase()
    let friendly: string
    if (res.status === 401 || res.status === 403) {
      friendly = 'ElevenLabs key is invalid or lacks permission. Check the key in Settings.'
    } else if (
      res.status === 402 ||
      lc.includes('quota') ||
      lc.includes('credit') ||
      lc.includes('insufficient')
    ) {
      friendly = 'ElevenLabs is out of credits — top up your account, then it will speak.'
    } else if (res.status === 429) {
      friendly = 'ElevenLabs rate limit hit — try again in a moment.'
    } else {
      friendly = `ElevenLabs error ${res.status}: ${body.slice(0, 120)}`
    }
    throw new Error(friendly)
  }

  const audio = Buffer.from(await res.arrayBuffer())
  return { audioBase64: audio.toString('base64'), mime: 'audio/mpeg', chars: opts.text.length }
}
