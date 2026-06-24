import type { Provider } from './settings'

interface ProviderConfig {
  url: string
  model: string
}

// All providers are OpenAI-compatible chat-completions endpoints.
export const PROVIDERS: Record<Provider, ProviderConfig> = {
  deepseek: {
    url: 'https://api.deepseek.com/chat/completions',
    model: 'deepseek-chat'
  },
  qwen: {
    url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions',
    model: 'qwen-plus'
  },
  openrouter: {
    url: 'https://openrouter.ai/api/v1/chat/completions',
    model: 'deepseek/deepseek-chat'
  }
}

export const LANG_NAMES: Record<string, string> = {
  en: 'English',
  ko: 'Korean',
  zh: 'Chinese (Simplified)',
  ja: 'Japanese',
  es: 'Spanish',
  auto: 'English'
}

export interface TranslateOptions {
  provider: Provider
  apiKey: string
  text: string
  sourceLang: string
  targetLang: string
}

export interface TranslateResult {
  text: string
  inputTokens: number
  outputTokens: number
}

function buildRequest(opts: TranslateOptions): {
  url: string
  headers: Record<string, string>
  system: string
  body: Record<string, unknown>
} {
  const cfg = PROVIDERS[opts.provider]
  const target = LANG_NAMES[opts.targetLang] ?? opts.targetLang
  const source = LANG_NAMES[opts.sourceLang] ?? 'the source language'

  const system =
    `You are a professional simultaneous interpreter translating a live conversation from ${source} into ${target}. ` +
    `Produce a natural, fluent translation in a polite spoken business register. ` +
    `Preserve the speaker's meaning and tone, keep proper names and company/product names intact, ` +
    `and use appropriate honorifics where the target language requires them. ` +
    `Output ONLY the translation — no quotes, no notes, no transliteration, no explanations.`

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${opts.apiKey}`
  }
  if (opts.provider === 'openrouter') {
    headers['HTTP-Referer'] = 'https://supertranslate.app'
    headers['X-Title'] = 'SuperTranslate'
  }

  const body: Record<string, unknown> = {
    model: cfg.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: opts.text }
    ],
    temperature: 0.2
  }
  return { url: cfg.url, headers, system, body }
}

export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 3)
}

// Shared OpenAI-compatible SSE chat reader. Streams accumulated text via onDelta,
// surfaces in-band {error} payloads (instead of swallowing them), and honors an
// AbortSignal. Used by both translateStream and the meeting assistant.
export async function streamChat(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  signal: AbortSignal | undefined,
  onDelta: (accumulated: string) => void
): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...body, stream: true, stream_options: { include_usage: true } }),
    signal
  })
  if (!res.ok || !res.body) {
    const errBody = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status}: ${errBody.slice(0, 200)}`)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let text = ''
  let inputTokens = 0
  let outputTokens = 0

  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const data = trimmed.slice(5).trim()
      if (data === '[DONE]' || data === '') continue
      let json: {
        choices?: { delta?: { content?: string } }[]
        usage?: { prompt_tokens?: number; completion_tokens?: number }
        error?: { message?: string }
      }
      try {
        json = JSON.parse(data)
      } catch {
        continue // partial/non-JSON keepalive line
      }
      if (json.error) throw new Error(json.error.message ?? 'stream error')
      const delta = json.choices?.[0]?.delta?.content
      if (delta) {
        text += delta
        onDelta(text.trim())
      }
      if (json.usage) {
        inputTokens = json.usage.prompt_tokens ?? inputTokens
        outputTokens = json.usage.completion_tokens ?? outputTokens
      }
    }
  }

  return { text: text.trim(), inputTokens, outputTokens }
}

// Streaming translation: calls onDelta with the growing translation so the UI can
// show words as they arrive (much lower perceived latency). Returns the final text + token usage.
export async function translateStream(
  opts: TranslateOptions,
  onDelta: (accumulated: string) => void
): Promise<TranslateResult> {
  const { url, headers, system, body } = buildRequest(opts)
  const r = await streamChat(url, headers, body, undefined, onDelta)
  return {
    text: r.text,
    inputTokens: r.inputTokens || estimateTokens(opts.text + system),
    outputTokens: r.outputTokens || estimateTokens(r.text)
  }
}
