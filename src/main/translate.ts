import type { Provider } from './settings'

interface ProviderConfig {
  url: string
  model: string
}

// All providers are OpenAI-compatible chat-completions endpoints.
const PROVIDERS: Record<Provider, ProviderConfig> = {
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

const LANG_NAMES: Record<string, string> = {
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

function estimateTokens(s: string): number {
  return Math.ceil(s.length / 3)
}

// Streaming translation: calls onDelta with the growing translation so the UI can
// show words as they arrive (much lower perceived latency). Returns the final text + token usage.
export async function translateStream(
  opts: TranslateOptions,
  onDelta: (accumulated: string) => void
): Promise<TranslateResult> {
  const { url, headers, system, body } = buildRequest(opts)
  body.stream = true
  body.stream_options = { include_usage: true }

  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
  if (!res.ok || !res.body) {
    const errBody = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status}: ${errBody.slice(0, 160)}`)
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
      try {
        const json = JSON.parse(data) as {
          choices?: { delta?: { content?: string } }[]
          usage?: { prompt_tokens?: number; completion_tokens?: number }
        }
        const delta = json.choices?.[0]?.delta?.content
        if (delta) {
          text += delta
          onDelta(text.trim())
        }
        if (json.usage) {
          inputTokens = json.usage.prompt_tokens ?? inputTokens
          outputTokens = json.usage.completion_tokens ?? outputTokens
        }
      } catch {
        /* ignore partial/non-JSON keepalive lines */
      }
    }
  }

  return {
    text: text.trim(),
    inputTokens: inputTokens || estimateTokens(opts.text + system),
    outputTokens: outputTokens || estimateTokens(text)
  }
}
