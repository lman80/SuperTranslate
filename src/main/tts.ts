// ElevenLabs text-to-speech (premium, natural voice). Called from the main
// process so the API key stays out of the renderer. Returns base64 MP3 audio.

const DEFAULT_VOICE_ID = '21m00Tcm4TlvDq8ikWAM' // Rachel — works with the multilingual model

export interface ElevenLabsOptions {
  apiKey: string
  voiceId: string
  text: string
}

export interface TtsResult {
  audioBase64: string
  mime: string
  chars: number
}

export async function elevenLabsTts(opts: ElevenLabsOptions): Promise<TtsResult> {
  const voice = opts.voiceId?.trim() || DEFAULT_VOICE_ID
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_128`

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
      voice_settings: { stability: 0.4, similarity_boost: 0.8, speed: 1.0 }
    })
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`ElevenLabs ${res.status}: ${body.slice(0, 160)}`)
  }

  const audio = Buffer.from(await res.arrayBuffer())
  return { audioBase64: audio.toString('base64'), mime: 'audio/mpeg', chars: opts.text.length }
}
