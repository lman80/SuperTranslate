import { app } from 'electron'
import { join } from 'path'
import { promises as fs } from 'fs'

export type Provider = 'deepseek' | 'qwen' | 'openrouter'
export type Dock = 'top-center' | 'bottom-center' | 'top-left' | 'top-right' | 'free'

export interface Settings {
  sonioxApiKey: string
  translateProvider: Provider
  translateApiKey: string
  myLanguage: string // language YOU speak, e.g. 'en'
  theirLanguage: string // language your colleague speaks: 'ko' | 'zh' | 'auto'
  fontScale: number
  showOriginal: boolean
  captureSystemAudio: boolean
  captureMic: boolean // translate your own microphone (off = incoming-only, avoids bleed)
  captureAppPid: number // macOS: capture only this app's audio (0 = whole system). No PID = loop-prone.
  captureAppName: string // display label for the chosen app
  duckOthers: boolean // dim macOS system volume while the translation voice plays
  monthlyBudgetUSD: number // hard cap; capture auto-stops when this month's estimated spend hits it
  speakAloud: boolean // speak the other person's translation aloud
  ttsEngine: 'system' | 'elevenlabs' // 'system' = free local voice; 'elevenlabs' = premium
  elevenLabsApiKey: string
  elevenLabsVoiceId: string
  voiceVolume: number // translation voice playback volume (0–1.5, 1 = normal)
  ttsRate: number // playback speed of the spoken translation (1 = normal)
  responseSpeed: 'fast' | 'balanced' | 'accurate' // how long to wait after a pause before finalizing
  turboMode: boolean // real-time speech-to-speech for the other person (Gemini Live Translate)
  geminiApiKey: string
  onboarded: boolean // has the user completed (or skipped) first-run setup
  fontScalePref: number // active font scale chosen via A-/A+ (overrides fontScale when set)
  dock: Dock // overlay docking position on screen
  overlayBounds?: { x: number; y: number; width: number; height: number } // remembered free-drag position
  displayId?: number // display the overlay was last on (for multi-monitor restore)
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
  captureMic: true,
  captureAppPid: 0,
  captureAppName: '',
  duckOthers: true,
  monthlyBudgetUSD: 15,
  speakAloud: false,
  ttsEngine: 'system',
  elevenLabsApiKey: '',
  elevenLabsVoiceId: '',
  voiceVolume: 1,
  ttsRate: 1.25,
  responseSpeed: 'fast',
  turboMode: false,
  geminiApiKey: '',
  onboarded: false,
  fontScalePref: 1,
  dock: 'top-center'
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
