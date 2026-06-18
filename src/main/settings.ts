import { app } from 'electron'
import { join } from 'path'
import { promises as fs } from 'fs'

export type Provider = 'deepseek' | 'qwen' | 'openrouter'

export interface Settings {
  sonioxApiKey: string
  translateProvider: Provider
  translateApiKey: string
  myLanguage: string // language YOU speak, e.g. 'en'
  theirLanguage: string // language your colleague speaks: 'ko' | 'zh' | 'auto'
  fontScale: number
  showOriginal: boolean
  captureSystemAudio: boolean
  monthlyBudgetUSD: number // hard cap; capture auto-stops when this month's estimated spend hits it
  speakAloud: boolean // speak the other person's translation aloud
  ttsEngine: 'system' | 'elevenlabs' // 'system' = free local voice; 'elevenlabs' = premium
  elevenLabsApiKey: string
  elevenLabsVoiceId: string
}

const defaults: Settings = {
  sonioxApiKey: '',
  translateProvider: 'deepseek',
  translateApiKey: '',
  myLanguage: 'en',
  theirLanguage: 'ko',
  fontScale: 1,
  showOriginal: true,
  captureSystemAudio: true,
  monthlyBudgetUSD: 15,
  speakAloud: false,
  ttsEngine: 'system',
  elevenLabsApiKey: '',
  elevenLabsVoiceId: ''
}

function settingsFile(): string {
  return join(app.getPath('userData'), 'settings.json')
}

export async function loadSettings(): Promise<Settings> {
  try {
    const raw = await fs.readFile(settingsFile(), 'utf-8')
    return { ...defaults, ...JSON.parse(raw) }
  } catch {
    return { ...defaults }
  }
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await loadSettings()
  const next = { ...current, ...patch }
  await fs.writeFile(settingsFile(), JSON.stringify(next, null, 2), 'utf-8')
  return next
}
