import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { startCapture, setMicMuted, setSystemMuted, type CaptureResult } from './audio'

type Source = 'mic' | 'system'
type Provider = 'deepseek' | 'qwen' | 'openrouter'
type Dock = 'top-center' | 'bottom-center' | 'top-left' | 'top-right' | 'free'
type Popover = 'lang' | 'app' | 'dock' | null

interface Settings {
  sonioxApiKey: string
  translateProvider: Provider
  translateApiKey: string
  myLanguage: string
  theirLanguage: string
  fontScale: number
  showOriginal: boolean
  captureSystemAudio: boolean
  captureMic: boolean
  captureAppPid: number
  captureAppName: string
  duckOthers: boolean
  monthlyBudgetUSD: number
  speakAloud: boolean
  ttsEngine: 'system' | 'elevenlabs'
  elevenLabsApiKey: string
  elevenLabsVoiceId: string
  voiceVolume: number
  backgroundVolume: number
  ttsRate: number
  responseSpeed: 'fast' | 'balanced' | 'accurate'
  turboMode: boolean
  realtimeProvider: 'gemini' | 'openai'
  geminiApiKey: string
  openaiApiKey: string
  onboarded: boolean
  fontScalePref: number
  assistantAnswerLang: string
  assistAutoSpeak: boolean
  dock: Dock
}

interface Entry {
  id: string
  source: Source
  original: string
  translation: string
  note?: string
  error?: string
}
interface UsageState {
  spent: number
  budget: number
  month: string
}
interface Banner {
  kind: 'error' | 'warn' | 'good'
  text: string
  action?: { label: string; fn: () => void }
  dismissable?: boolean
  ttl?: number // auto-dismiss after N ms (for transient warnings)
}

const LANG_LABEL: Record<string, string> = {
  en: 'English',
  ko: 'Korean',
  zh: 'Chinese',
  auto: 'Auto'
}
const LANG_SHORT: Record<string, string> = { en: 'EN', ko: 'KO', zh: 'ZH', auto: 'AUTO' }
const PROVIDER_LABEL: Record<Provider, string> = {
  deepseek: 'DeepSeek',
  qwen: 'Qwen',
  openrouter: 'OpenRouter'
}
const SONIOX_KEYS_URL = 'https://console.soniox.com'
const GEMINI_KEYS_URL = 'https://aistudio.google.com/apikey'
const OPENAI_KEYS_URL = 'https://platform.openai.com/api-keys'
const KEY_URL: Record<Provider, string> = {
  deepseek: 'https://platform.deepseek.com/api_keys',
  qwen: 'https://bailian.console.alibabacloud.com/?tab=model#/api-key',
  openrouter: 'https://openrouter.ai/keys'
}
const FONT_STEPS = [0.9, 1.1, 1.35, 1.6]
const speakerName = (s: Source): string => (s === 'mic' ? 'You' : 'Them')
// On Windows we capture whole-system audio (no per-app pick/mute/duck), so several
// macOS-only affordances are hidden.
const IS_MAC = window.api.platform === 'darwin'

const LANG_NAME: Record<string, string> = {
  en: 'English',
  ko: 'Korean',
  zh: 'Chinese',
  auto: 'Chinese'
}
const ASK_WORD: Record<string, string> = { zh: '问助手', ko: '도우미', en: 'Ask' }
interface Preset {
  id: string
  intent: string
  label: Record<string, string>
}
const PRESETS: Preset[] = [
  {
    id: 'what',
    intent: 'What is the OTHER speaker talking about right now? Explain simply.',
    label: { zh: '他在说什么?', ko: '무슨 얘기예요?', en: 'What is he saying?' }
  },
  {
    id: 'mean',
    intent: 'What does the last thing the OTHER speaker said mean?',
    label: { zh: '这是什么意思?', ko: '무슨 뜻이에요?', en: 'What does that mean?' }
  },
  {
    id: 'want',
    intent: 'What does the OTHER speaker want me to do or decide?',
    label: { zh: '他想让我做什么?', ko: '저보고 뭘 하라는 거죠?', en: 'What does he want?' }
  },
  {
    id: 'summary',
    intent: 'Summarize the whole conversation so far in a few sentences.',
    label: { zh: '总结一下到现在', ko: '지금까지 요약해줘', en: 'Summarize so far' }
  },
  {
    id: 'question',
    intent: 'Is the OTHER speaker asking me a question? If so, what is it and how might I answer?',
    label: { zh: '他是在问我问题吗?', ko: '저한테 질문한 거예요?', en: 'Is he asking me?' }
  },
  {
    id: 'example',
    intent: 'Give a concrete example to clarify what the OTHER speaker means.',
    label: { zh: '能举个例子吗?', ko: '예를 들어줄래요?', en: 'Give an example' }
  }
]
const trL = (m: Record<string, string>, lang: string): string => m[lang] ?? m.en

// Assistant UI chrome, localized to the answer language (ko falls back to en).
const ASSIST_UI: Record<string, Record<string, string>> = {
  zh: {
    youAsked: '你问',
    empty: '点一个问题，或在下面输入。我会根据刚才的对话用中文解释。',
    thin: '还没有可解释的对话内容，等对方先说几句。',
    speak: '朗读',
    copy: '复制',
    regen: '重新生成',
    autoSpeak: '自动朗读',
    send: '发送',
    placeholder: '输入你的问题…',
    setup: '设置',
    poweredBy: '回答由',
    micBlind: '要解释对方在说什么，需要先打开麦克风记录他的声音。',
    waitSpeak: '等对方说几句话后再问。',
    turnOnMic: '打开麦克风'
  },
  en: {
    youAsked: 'You asked',
    empty: 'Pick a question or type below. I’ll explain the conversation.',
    thin: 'Nothing to explain yet — wait for a few sentences.',
    speak: 'Speak',
    copy: 'Copy',
    regen: 'Regenerate',
    autoSpeak: 'Auto-speak',
    send: 'Send',
    placeholder: 'Type your question…',
    setup: 'Setup',
    poweredBy: 'Answers by',
    micBlind: 'To explain what the other person says, turn on the mic to capture their voice.',
    waitSpeak: 'Wait for them to say a few sentences, then ask.',
    turnOnMic: 'Turn on mic'
  }
}
const ASSIST_ERR: Record<string, Record<string, string>> = {
  zh: {
    nokey: '请在设置中为助手添加一个翻译密钥。',
    auth: '密钥无效，请在设置中检查。',
    rate: '请求过于频繁或额度不足，请稍后再试。',
    balance: '账户余额不足。',
    timeout: '请求超时，请重试。',
    network: '服务暂时不可用，请重试。',
    empty: 'AI 未能生成回答，请换种问法重试。',
    budget: '已达到本月预算上限。'
  },
  en: {
    nokey: 'Add a translator API key in Setup to use Ask.',
    auth: 'API key was rejected — check it in Setup.',
    rate: 'Rate limit or quota hit — try again shortly.',
    balance: 'Account balance is too low.',
    timeout: 'The request timed out — try again.',
    network: 'Service temporarily unavailable — try again.',
    empty: 'No answer was generated — try rephrasing.',
    budget: 'Monthly budget reached.'
  }
}

// Build the transcript sent to the assistant. Role tags are language-neutral: OTHER = the
// colleague being explained (mic / myLanguage); YOU = the helped person (system / theirLanguage).
function buildAssistantTranscript(
  entries: Entry[],
  partial: { mic: string; system: string },
  s: Settings,
  maxChars = 12000
): { transcript: string; userLineCount: number } {
  const ln = (c: string): string => LANG_NAME[c] ?? c
  const roleOther = `OTHER (${ln(s.myLanguage)})`
  const roleYou = `YOU (${ln(s.theirLanguage)})`
  const lines: string[] = []
  let userLineCount = 0
  let n = 0
  for (const e of entries) {
    const text = (e.original || e.translation || '').trim()
    if (!text) continue
    n++
    const isOther = e.source === 'mic'
    if (isOther) userLineCount++
    let block = `[${n}] ${isOther ? roleOther : roleYou}: ${text}`
    const gloss = (e.translation || '').trim()
    if (gloss && gloss !== text) block += `\n    (translation: ${gloss})`
    lines.push(block)
  }
  if (partial.mic?.trim()) {
    lines.push(`[${++n}] ${roleOther}: ${partial.mic.trim()} [in progress]`)
    userLineCount++
  }
  if (partial.system?.trim()) {
    lines.push(`[${++n}] ${roleYou}: ${partial.system.trim()} [in progress]`)
  }
  let joined = lines.join('\n')
  let truncated = false
  while ([...joined].length > maxChars && lines.length > 1) {
    lines.shift()
    truncated = true
    joined = lines.join('\n')
  }
  if (truncated) joined = '…(earlier conversation omitted)…\n' + joined
  return { transcript: joined, userLineCount }
}

// Settings whose change requires re-initializing capture (NOT an app restart).
const CAPTURE_KEYS = new Set<keyof Settings>([
  'myLanguage',
  'theirLanguage',
  'captureMic',
  'turboMode',
  'geminiApiKey',
  'captureAppPid',
  'translateProvider',
  'translateApiKey',
  'sonioxApiKey',
  'realtimeProvider',
  'openaiApiKey',
  'ttsEngine',
  'elevenLabsApiKey',
  'elevenLabsVoiceId',
  'responseSpeed',
  'speakAloud'
])

function engineReady(s: Settings): boolean {
  if (s.turboMode) return s.realtimeProvider === 'openai' ? !!s.openaiApiKey : !!s.geminiApiKey
  return !!s.sonioxApiKey && !!s.translateApiKey
}

export default function App() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [perms, setPerms] = useState<{ screen: string; microphone: string }>({
    screen: 'granted',
    microphone: 'granted'
  })
  const [running, setRunning] = useState(false)
  const [busy, setBusy] = useState(false)
  const [pinned, setPinned] = useState(true)
  const [entries, setEntries] = useState<Entry[]>([])
  const [partial, setPartial] = useState<{ mic: string; system: string }>({ mic: '', system: '' })
  const [usage, setUsage] = useState<UsageState | null>(null)
  const [systemLevel, setSystemLevel] = useState(0)
  const [turboConnecting, setTurboConnecting] = useState(false)
  const [banners, setBanners] = useState<Record<string, Banner>>({})
  const [toast, setToast] = useState('')
  const [setupOpen, setSetupOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [popover, setPopover] = useState<Popover>(null)
  const [minimized, setMinimized] = useState(false)
  const [assistantOpen, setAssistantOpen] = useState(false)
  const [assistant, setAssistant] = useState<{
    asking: boolean
    question: string
    answer: string
    error: string
    provider: string
  }>({ asking: false, question: '', answer: '', error: '', provider: '' })
  const assistantReqRef = useRef('')

  const settingsRef = useRef<Settings | null>(null)
  const runningRef = useRef(false)
  const voiceVolumeRef = useRef(1)
  const voicesRef = useRef<SpeechSynthesisVoice[]>([])
  const captureRef = useRef<CaptureResult | null>(null)
  const feedRef = useRef<HTMLDivElement | null>(null)
  const atBottomRef = useRef(true)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null)
  const turboCtxRef = useRef<AudioContext | null>(null)
  const turboGainRef = useRef<GainNode | null>(null)
  const turboNextTimeRef = useRef(0)
  const bgCtxRef = useRef<AudioContext | null>(null)
  const bgGainRef = useRef<GainNode | null>(null)
  const bgNextTimeRef = useRef(0)
  const backgroundVolumeRef = useRef(0.3)
  const bgDuckedRef = useRef(false)
  const ttsGuardTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const turboGuardTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const levelClearTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const setupOpenRef = useRef(false)
  const setupDirtyRef = useRef(false) // a capture-affecting setting changed while Setup was open
  const reinitingRef = useRef(false)
  const reinitPendingRef = useRef(false)
  const doStopRef = useRef<(() => Promise<void>) | null>(null)

  useEffect(() => {
    runningRef.current = running
  }, [running])
  useEffect(() => {
    setupOpenRef.current = setupOpen
  }, [setupOpen])
  const minimizedRef = useRef(false)
  useEffect(() => {
    minimizedRef.current = minimized
  }, [minimized])
  useEffect(() => {
    settingsRef.current = settings
    if (settings) {
      voiceVolumeRef.current = settings.voiceVolume ?? 1
      backgroundVolumeRef.current = settings.backgroundVolume ?? 0.3
    }
  }, [settings])

  const flash = useCallback((msg: string) => {
    setToast(msg)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(''), 2400)
  }, [])

  const removeBanner = useCallback((key: string) => {
    setBanners((prev) => {
      if (!(key in prev)) return prev
      const n = { ...prev }
      delete n[key]
      return n
    })
  }, [])
  const addBanner = useCallback(
    (key: string, b: Banner) => {
      setBanners((prev) => ({ ...prev, [key]: b }))
      if (b.ttl) setTimeout(() => removeBanner(key), b.ttl)
    },
    [removeBanner]
  )

  const refreshPerms = useCallback(() => {
    window.api.getPermissions().then(setPerms).catch(() => undefined)
  }, [])

  // ---- load settings + usage + perms; decide onboarding ----
  useEffect(() => {
    window.api.getSettings().then((s) => {
      const st = s as Settings
      if (!st.onboarded && (st.geminiApiKey || st.sonioxApiKey)) {
        window.api.saveSettings({ onboarded: true })
        st.onboarded = true
      }
      setSettings(st)
      // Force one setMode now that settings are known (the [mode] effect won't re-fire
      // if the derived mode happens to equal its initial value).
      window.api.setMode(st.onboarded ? 'idle' : 'firstrun')
    })
    window.api.getUsage().then((u) => setUsage(u as UsageState))
    refreshPerms()
  }, [refreshPerms])

  // ---- the window MODE drives the overlay's size (main process resizes to fit) ----
  const onboarding = !!settings && !settings.onboarded
  const mode = onboarding
    ? 'firstrun'
    : setupOpen
      ? 'setup'
      : assistantOpen
        ? 'assistant'
        : minimized
          ? 'mini'
          : running
            ? historyOpen
              ? 'live-expanded'
              : 'live-collapsed'
            : popover
              ? 'idle-menu'
              : 'idle'
  useEffect(() => {
    if (settingsRef.current) window.api.setMode(mode)
  }, [mode])

  // Drop always-on-top while setup/onboarding open so macOS prompts aren't hidden.
  useEffect(() => {
    if (setupOpen || onboarding || assistantOpen) window.api.setPin(false)
    else window.api.setPin(pinned)
  }, [setupOpen, onboarding, assistantOpen, pinned])

  // ---- TTS voices ----
  useEffect(() => {
    const load = (): void => {
      voicesRef.current = window.speechSynthesis?.getVoices() ?? []
    }
    load()
    if (window.speechSynthesis) window.speechSynthesis.onvoiceschanged = load
    return () => {
      if (window.speechSynthesis) window.speechSynthesis.onvoiceschanged = null
    }
  }, [])

  // Background monitor gain (the quietly-replayed captured app), ducked further while
  // the translation is speaking so the translation clearly stands out.
  const applyBgGain = useCallback(() => {
    if (bgGainRef.current) {
      bgGainRef.current.gain.value = backgroundVolumeRef.current * (bgDuckedRef.current ? 0.3 : 1)
    }
  }, [])

  // ---- capture-loop guards (mute mic/system + duck background while a dub plays) ----
  const guardOn = useCallback(() => {
    setMicMuted(true)
    setSystemMuted(true)
    bgDuckedRef.current = true
    applyBgGain()
    if (ttsGuardTimer.current) clearTimeout(ttsGuardTimer.current)
    ttsGuardTimer.current = setTimeout(() => {
      setMicMuted(false)
      setSystemMuted(false)
      bgDuckedRef.current = false
      applyBgGain()
    }, 20000)
  }, [applyBgGain])
  const guardOff = useCallback(() => {
    if (ttsGuardTimer.current) clearTimeout(ttsGuardTimer.current)
    ttsGuardTimer.current = setTimeout(() => {
      setMicMuted(false)
      setSystemMuted(false)
      bgDuckedRef.current = false
      applyBgGain()
    }, 400)
  }, [applyBgGain])
  const turboGuard = useCallback(
    (msUntilDone: number) => {
      setMicMuted(true)
      // On Windows the renderer captures whole-system audio, so our own Turbo voice would
      // be re-heard — mute system capture during playback too. (On mac the native tap
      // captures only the other app, so we keep system input live for continuous Turbo.)
      if (!IS_MAC) setSystemMuted(true)
      bgDuckedRef.current = true
      applyBgGain()
      if (turboGuardTimer.current) clearTimeout(turboGuardTimer.current)
      turboGuardTimer.current = setTimeout(() => {
        setMicMuted(false)
        if (!IS_MAC) setSystemMuted(false)
        bgDuckedRef.current = false
        applyBgGain()
      }, msUntilDone + 400)
    },
    [applyBgGain]
  )

  const speak = useCallback(
    (text: string, lang: string) => {
      if (!text || !window.speechSynthesis) return
      const code = lang === 'zh' ? 'zh-CN' : lang === 'ko' ? 'ko-KR' : lang === 'en' ? 'en-US' : lang
      const base = code.split('-')[0]
      const u = new SpeechSynthesisUtterance(text)
      u.lang = code
      u.rate = settingsRef.current?.ttsRate ?? 1.2
      u.volume = Math.min(1, voiceVolumeRef.current)
      const v =
        voicesRef.current.find((x) => x.lang === code) ??
        voicesRef.current.find((x) => x.lang.startsWith(base))
      if (v) u.voice = v
      u.onstart = guardOn
      u.onend = guardOff
      u.onerror = guardOff
      try {
        window.speechSynthesis.cancel()
      } catch {
        /* ignore */
      }
      guardOn()
      window.speechSynthesis.speak(u)
    },
    [guardOn, guardOff]
  )

  // Background monitor: replay the captured (muted) app quietly so the user still
  // hears the call under the translation. 16kHz mono PCM forwarded from main.
  const ensureBgCtx = useCallback((): AudioContext => {
    if (!bgCtxRef.current) {
      const ctx = new AudioContext({ sampleRate: 16000 })
      const gain = ctx.createGain()
      gain.gain.value = backgroundVolumeRef.current
      gain.connect(ctx.destination)
      bgCtxRef.current = ctx
      bgGainRef.current = gain
      bgNextTimeRef.current = ctx.currentTime
    }
    return bgCtxRef.current
  }, [])
  const playBgPcm = useCallback(
    (bytes: Uint8Array) => {
      try {
        // Don't replay our own background into the mic; and never recreate the context
        // after Stop (only doStart creates it) — both would cause echo / a ghost context.
        if (settingsRef.current?.captureMic) return
        const ctx = bgCtxRef.current
        if (!ctx || !bgGainRef.current) return
        const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
        const count = Math.floor(u8.byteLength / 2)
        if (!count) return
        if (ctx.state === 'suspended') void ctx.resume()
        applyBgGain()
        const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
        const f32 = new Float32Array(count)
        for (let i = 0; i < count; i++) f32[i] = dv.getInt16(i * 2, true) / 32768
        const buf = ctx.createBuffer(1, count, 16000)
        buf.copyToChannel(f32, 0)
        const node = ctx.createBufferSource()
        node.buffer = buf
        node.connect(bgGainRef.current!)
        let startAt = Math.max(ctx.currentTime, bgNextTimeRef.current)
        if (startAt - ctx.currentTime > 0.6) startAt = ctx.currentTime // resync if latency grows
        node.start(startAt)
        bgNextTimeRef.current = startAt + buf.duration
      } catch {
        /* ignore */
      }
    },
    [applyBgGain]
  )

  // Turbo audio graph: gain (0–2×, can boost past 100%) → limiter → speakers.
  // The limiter keeps a boosted voice loud without harsh clipping.
  const ensureTurboCtx = useCallback((): AudioContext => {
    if (!turboCtxRef.current) {
      const ctx = new AudioContext({ sampleRate: 24000 })
      const gain = ctx.createGain()
      const limiter = ctx.createDynamicsCompressor()
      limiter.threshold.value = -2
      limiter.knee.value = 0
      limiter.ratio.value = 20
      limiter.attack.value = 0.003
      limiter.release.value = 0.12
      gain.connect(limiter)
      limiter.connect(ctx.destination)
      turboCtxRef.current = ctx
      turboGainRef.current = gain
      turboNextTimeRef.current = ctx.currentTime
    }
    return turboCtxRef.current
  }, [])

  const playTurboPcm = useCallback(
    (base64: string) => {
      try {
        const bin = atob(base64)
        const bytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
        const int16 = new Int16Array(bytes.buffer, 0, Math.floor(bytes.length / 2))
        const ctx = ensureTurboCtx()
        if (ctx.state === 'suspended') void ctx.resume()
        turboGainRef.current!.gain.value = voiceVolumeRef.current
      const f32 = new Float32Array(int16.length)
      for (let i = 0; i < int16.length; i++) f32[i] = int16[i] / 32768
      const buf = ctx.createBuffer(1, f32.length, 24000)
      buf.copyToChannel(f32, 0)
      const node = ctx.createBufferSource()
      node.buffer = buf
      node.connect(turboGainRef.current!)
      const startAt = Math.max(ctx.currentTime, turboNextTimeRef.current)
      node.start(startAt)
      turboNextTimeRef.current = startAt + buf.duration
      } catch {
        /* ignore */
      }
    },
    [ensureTurboCtx]
  )

  // ---- subscribe to all main events (once) ----
  useEffect(() => {
    const offPartial = window.api.onPartial(({ source, text }) =>
      setPartial((p) => ({ ...p, [source]: text }))
    )
    const offFinal = window.api.onFinal((p) => {
      setEntries((prev) =>
        [
          ...prev,
          { id: p.id, source: p.source, original: p.original, translation: p.translation ?? '' }
        ].slice(-300)
      )
      setPartial((prev) => ({ ...prev, [p.source]: '' }))
    })
    const offTranslation = window.api.onTranslation(
      ({ id, translation, note, error, final, source, targetLang }) => {
        setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, translation, note, error } : e)))
        if (
          final &&
          translation &&
          source === 'system' &&
          settingsRef.current?.speakAloud &&
          settingsRef.current?.ttsEngine !== 'elevenlabs' &&
          !settingsRef.current?.turboMode
        ) {
          speak(translation, targetLang || settingsRef.current?.myLanguage || 'en')
        }
      }
    )
    const offTurbo = window.api.onTurboAudio(({ data }) => {
      if (!runningRef.current) return // ignore buffered audio arriving during teardown
      playTurboPcm(data)
      const ctx = turboCtxRef.current
      const msLeft = ctx ? Math.max(0, (turboNextTimeRef.current - ctx.currentTime) * 1000) : 600
      turboGuard(msLeft)
    })
    const offTts = window.api.onTtsPlay(({ audioBase64, mime }) => {
      try {
        ttsAudioRef.current?.pause()
        const a = new Audio(`data:${mime};base64,${audioBase64}`)
        a.volume = Math.min(1, voiceVolumeRef.current)
        a.onended = guardOff
        a.onerror = guardOff
        ttsAudioRef.current = a
        guardOn()
        void a.play().catch(() => guardOff())
      } catch {
        guardOff()
      }
    })
    const offError = window.api.onError(({ message }) => {
      const m = message.toLowerCase()
      if (m.includes('soniox')) {
        addBanner('err-stt', {
          kind: 'error',
          text: 'Speech recognition error — check your Soniox key.',
          action: { label: 'Setup', fn: () => setSetupOpen(true) },
          dismissable: true
        })
      } else if (m.includes('gemini') || m.includes('turbo')) {
        addBanner('err-turbo', {
          kind: 'error',
          text: message,
          action: { label: 'Setup', fn: () => setSetupOpen(true) },
          dismissable: true
        })
      } else if (
        m.includes('screen recording') ||
        m.includes('audio recording') ||
        m.includes('permission')
      ) {
        addBanner('err-perm', {
          kind: 'warn',
          text: message,
          action: IS_MAC ? { label: 'Fix', fn: () => window.api.openScreenSettings() } : undefined,
          dismissable: true
        })
      } else if (m.includes('voice') || m.includes('elevenlabs')) {
        addBanner('err-voice', { kind: 'warn', text: message, dismissable: true, ttl: 9000 })
      } else {
        addBanner('err-misc', { kind: 'error', text: message, dismissable: true })
      }
    })
    const offUsage = window.api.onUsage((u) => setUsage(u))
    const offBudget = window.api.onBudget((b) => {
      if (b.reached) {
        // Full teardown (closes AudioContext, clears guards, unmutes) — same as Stop.
        void doStopRef.current?.()
        addBanner('budget', {
          kind: 'warn',
          text: `Budget of $${b.budget.toFixed(2)} reached — paused.`,
          action: { label: 'Setup', fn: () => setSetupOpen(true) },
          dismissable: true
        })
      } else if (b.warning) {
        flash(`~$${b.spent.toFixed(2)} of $${b.budget.toFixed(2)} used`)
      }
    })
    const offSysLevel = window.api.onSystemLevel(({ rms }) => {
      setSystemLevel(rms)
      if (levelClearTimer.current) clearTimeout(levelClearTimer.current)
      levelClearTimer.current = setTimeout(() => setSystemLevel(0), 500)
    })
    const offSysAudio = window.api.onSystemAudio((pcm) => {
      if (runningRef.current) playBgPcm(pcm)
    })
    const offSysMode = window.api.onSystemMode(({ mode: m }) => {
      if (m === 'muted') flash('Source muted — you’ll hear only the translation ✓')
      else flash('Capturing this app — lower its volume to reduce overlap')
    })
    const offStatus = window.api.onStatus(({ source, status }) => {
      if (source !== 'system' || !settingsRef.current?.turboMode) return
      setTurboConnecting(status === 'connecting')
    })
    const offDock = window.api.onDock(({ dock }) => {
      setSettings((prev) => (prev ? { ...prev, dock: dock as Dock } : prev))
    })
    return () => {
      offPartial()
      offFinal()
      offTranslation()
      offTurbo()
      offTts()
      offError()
      offUsage()
      offBudget()
      offSysLevel()
      offSysAudio()
      offSysMode()
      offStatus()
      offDock()
    }
  }, [flash, speak, guardOn, guardOff, playTurboPcm, turboGuard, addBanner, playBgPcm])

  // ---- meeting assistant stream (filtered by the active request id) ----
  useEffect(() => {
    const offDelta = window.api.onAssistantDelta(({ reqId, text }) => {
      if (reqId === assistantReqRef.current) setAssistant((a) => ({ ...a, answer: text }))
    })
    const offDone = window.api.onAssistantDone(({ reqId, text, provider }) => {
      if (reqId !== assistantReqRef.current) return
      setAssistant((a) => ({ ...a, asking: false, answer: text, provider }))
      const s = settingsRef.current
      if (s?.assistAutoSpeak && text) {
        const want = s.assistantAnswerLang || s.theirLanguage
        speak(text, want === 'auto' ? 'zh' : want)
      }
    })
    const offErr = window.api.onAssistantError(({ reqId, code, message }) => {
      if (reqId === assistantReqRef.current)
        setAssistant((a) => ({ ...a, asking: false, error: code || message || 'error' }))
    })
    return () => {
      offDelta()
      offDone()
      offErr()
    }
  }, [speak])

  // Cmd/Ctrl+K opens the assistant while a Standard meeting is running.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        if (
          runningRef.current &&
          !settingsRef.current?.turboMode &&
          !setupOpen &&
          !minimizedRef.current
        ) {
          e.preventDefault()
          assistantReqRef.current = ''
          setAssistant({ asking: false, question: '', answer: '', error: '', provider: '' })
          setAssistantOpen(true)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setupOpen])

  // Auto-scroll the expanded transcript only when pinned to bottom.
  useEffect(() => {
    const el = feedRef.current
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight
  }, [entries, partial, historyOpen])
  const onFeedScroll = useCallback(() => {
    const el = feedRef.current
    if (el) atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 50
  }, [])

  // ---- capture lifecycle ----
  const doStart = useCallback(async () => {
    const s = settingsRef.current
    if (!s) return
    setBusy(true)
    try {
      const info = (await window.api.startCapture()) as { captureSystemInRenderer?: boolean }
      if (s.turboMode) {
        void ensureTurboCtx().resume()
      }
      // Prepare the background monitor (quiet replay of the captured app).
      bgDuckedRef.current = false
      void ensureBgCtx().resume()
      applyBgGain()
      captureRef.current = await startCapture({
        captureSystemAudio: !!info?.captureSystemInRenderer,
        captureMic: s.captureMic,
        onWarning: (msg) =>
          addBanner('warn-cap', { kind: 'warn', text: msg, dismissable: true, ttl: 9000 }),
        onSystemLevel: (rms) => setSystemLevel(rms)
      })
      // A fresh start clears stale issue banners from a previous attempt.
      ;['err-start', 'err-stt', 'err-turbo', 'err-perm', 'err-voice', 'warn-cap', 'budget'].forEach(
        removeBanner
      )
      setRunning(true)
    } catch (e) {
      addBanner('err-start', { kind: 'error', text: (e as Error).message, dismissable: true })
      await window.api.stopCapture().catch(() => undefined)
    } finally {
      setBusy(false)
    }
  }, [addBanner, removeBanner, ensureTurboCtx, ensureBgCtx, applyBgGain])

  const doStop = useCallback(async () => {
    runningRef.current = false // synchronous: stop audio handlers from acting during teardown
    captureRef.current?.stop()
    captureRef.current = null
    try {
      window.speechSynthesis?.cancel()
      ttsAudioRef.current?.pause()
      ttsAudioRef.current = null
      if (ttsGuardTimer.current) clearTimeout(ttsGuardTimer.current)
      if (turboGuardTimer.current) clearTimeout(turboGuardTimer.current)
      setMicMuted(false)
      setSystemMuted(false)
      turboCtxRef.current?.close().catch(() => undefined)
      turboCtxRef.current = null
      turboGainRef.current = null
      bgCtxRef.current?.close().catch(() => undefined)
      bgCtxRef.current = null
      bgGainRef.current = null
      bgDuckedRef.current = false
    } catch {
      /* ignore */
    }
    await window.api.stopCapture().catch(() => undefined)
    setRunning(false)
    setHistoryOpen(false)
    setTurboConnecting(false)
    setPartial({ mic: '', system: '' })
    setSystemLevel(0)
  }, [])

  // Expose doStop to the (stable) event-subscription effect for budget auto-stop.
  useEffect(() => {
    doStopRef.current = doStop
  }, [doStop])

  // Re-init capture, serialized so rapid changes can't interleave stop/start IPC.
  const reinitCapture = useCallback(async () => {
    if (reinitingRef.current) {
      reinitPendingRef.current = true
      return
    }
    reinitingRef.current = true
    try {
      do {
        reinitPendingRef.current = false
        await doStop()
        await doStart()
      } while (reinitPendingRef.current)
    } finally {
      reinitingRef.current = false
    }
  }, [doStop, doStart])

  const start = useCallback(async () => {
    const s = settingsRef.current
    if (!s) return
    if (!engineReady(s)) {
      setSetupOpen(true)
      flash('Add your key in Setup to start.')
      return
    }
    if (IS_MAC && !s.captureAppPid) {
      setPopover('app')
      flash('Pick the app to listen to.')
      return
    }
    setEntries([]) // a fresh Start is a new meeting (resets the assistant transcript)
    await doStart()
  }, [doStart, flash])

  // Live-apply: save settings. If a capture-affecting key changed while running, re-init —
  // but DEFER that while Setup is open (else every keystroke in a key field would tear down
  // and restart capture). The deferred re-init runs once when Setup closes.
  const applyLive = useCallback(
    async (patch: Partial<Settings>) => {
      const saved = (await window.api.saveSettings(patch)) as Settings
      settingsRef.current = saved
      setSettings(saved)
      const affectsCapture = Object.keys(patch).some((k) => CAPTURE_KEYS.has(k as keyof Settings))
      if (affectsCapture && runningRef.current) {
        if (setupOpenRef.current) {
          setupDirtyRef.current = true
        } else {
          await reinitCapture()
          flash('Applied ✓')
        }
      }
    },
    [reinitCapture, flash]
  )

  const closeSetup = useCallback(() => {
    setSetupOpen(false)
    if (setupDirtyRef.current) {
      setupDirtyRef.current = false
      if (runningRef.current) {
        void reinitCapture()
        flash('Applied ✓')
      }
    }
  }, [reinitCapture, flash])

  const setVoiceVolume = useCallback((v: number) => {
    voiceVolumeRef.current = v
    if (turboGainRef.current) turboGainRef.current.gain.value = v
    setSettings((prev) => (prev ? { ...prev, voiceVolume: v } : prev))
    void window.api.saveSettings({ voiceVolume: v })
  }, [])

  const setBackgroundVolume = useCallback(
    (v: number) => {
      backgroundVolumeRef.current = v
      applyBgGain()
      setSettings((prev) => (prev ? { ...prev, backgroundVolume: v } : prev))
      void window.api.saveSettings({ backgroundVolume: v })
    },
    [applyBgGain]
  )

  const setFontScale = useCallback((v: number) => {
    const clamped = Math.max(0.85, Math.min(1.9, v))
    setSettings((prev) => (prev ? { ...prev, fontScalePref: clamped } : prev))
    void window.api.saveSettings({ fontScalePref: clamped })
  }, [])
  const cycleFont = useCallback(() => {
    const cur = settingsRef.current?.fontScalePref ?? 1
    const idx = FONT_STEPS.findIndex((s) => Math.abs(s - cur) < 0.08)
    setFontScale(FONT_STEPS[(idx + 1) % FONT_STEPS.length])
  }, [setFontScale])

  const togglePin = useCallback(() => setPinned((p) => !p), [])

  const setDock = useCallback((d: Dock) => {
    window.api.setDock(d)
    setSettings((prev) => (prev ? { ...prev, dock: d } : prev))
  }, [])

  // One-tap engine switch (Turbo <-> Standard). If the target engine has no key yet,
  // jump to Setup instead of failing on (re)start.
  const toggleEngine = useCallback(() => {
    const s = settingsRef.current
    if (!s) return
    const target = !s.turboMode
    if (!engineReady({ ...s, turboMode: target })) {
      setSetupOpen(true)
      flash(target ? 'Add your Turbo key in Setup.' : 'Add your Standard keys in Setup.')
      return
    }
    void applyLive({ turboMode: target })
  }, [applyLive, flash])

  // `display` is echoed to the user (e.g. localized preset label); `question` is the model intent.
  const askAssistant = (question: string, display?: string): void => {
    const s = settingsRef.current
    if (!s) return
    // eslint-disable-next-line no-control-regex
    const q = question
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 2000)
    if (!q) return
    const { transcript } = buildAssistantTranscript(entries, partial, s)
    if (!transcript.trim()) return // nothing to explain yet
    const want = s.assistantAnswerLang || s.theirLanguage
    const answerLang = want === 'auto' ? 'zh' : want
    const reqId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    assistantReqRef.current = reqId
    setAssistant({ asking: true, question: display ?? q, answer: '', error: '', provider: '' })
    window.api.askAssistant({ reqId, transcript, question: q, answerLang, otherLang: s.myLanguage })
  }
  const openAssistant = (): void => {
    assistantReqRef.current = ''
    setAssistant({ asking: false, question: '', answer: '', error: '', provider: '' })
    setAssistantOpen(true)
  }
  const closeAssistant = (): void => {
    if (assistantReqRef.current) window.api.cancelAssistant(assistantReqRef.current)
    assistantReqRef.current = '' // drop any late delta/done (prevents stray auto-speak)
    setAssistant({ asking: false, question: '', answer: '', error: '', provider: '' })
    setAssistantOpen(false)
  }

  if (!settings) return <div className="boot">Loading…</div>

  const fontScale = settings.fontScalePref || settings.fontScale || 1
  const ready = engineReady(settings)
  const masterDot = !ready ? 'amber' : running ? 'green' : Object.keys(banners).length ? 'amber' : ''
  const dir = `${LANG_SHORT[settings.theirLanguage] ?? '··'}→${LANG_SHORT[settings.myLanguage] ?? '··'}`

  const bannerList = Object.entries(banners)
  const latestBanner = bannerList[bannerList.length - 1]

  const closePopover = (): void => setPopover(null)

  return (
    <div className="app" style={{ ['--font-scale' as string]: String(fontScale) }}>
      {onboarding ? (
        <FirstRun
          onOpenSetup={() => {
            void applyLive({ onboarded: true })
            setSetupOpen(true)
          }}
          onSkip={() => void applyLive({ onboarded: true })}
        />
      ) : setupOpen ? (
        <SetupSheet
          settings={settings}
          perms={perms}
          usage={usage}
          pinned={pinned}
          applyLive={applyLive}
          refreshPerms={refreshPerms}
          togglePin={togglePin}
          onClose={closeSetup}
        />
      ) : assistantOpen ? (
        <AssistantSheet
          settings={settings}
          state={assistant}
          hasTranscript={entries.length > 0 || !!(partial.system || partial.mic)}
          micState={
            !(entries.every((e) => e.source !== 'mic') && !partial.mic)
              ? 'ok'
              : settings.captureMic
                ? 'silent'
                : 'off'
          }
          onAsk={askAssistant}
          onSetAnswerLang={(l) => applyLive({ assistantAnswerLang: l })}
          onToggleAutoSpeak={() => applyLive({ assistAutoSpeak: !settings.assistAutoSpeak })}
          onSpeak={(t, l) => speak(t, l)}
          onCopy={(t) => {
            void navigator.clipboard?.writeText(t).catch(() => undefined)
            flash('Copied ✓')
          }}
          onTurnOnMic={() => applyLive({ captureMic: true })}
          onOpenSetup={() => {
            setAssistantOpen(false)
            setSetupOpen(true)
          }}
          onClose={closeAssistant}
        />
      ) : minimized ? (
        <MiniHandle
          live={running}
          dot={masterDot}
          onRestore={() => setMinimized(false)}
        />
      ) : (
        <div className={`bar ${running ? 'live' : 'idle'}`}>
          {running ? (
            <LiveControlRow
              settings={settings}
              dir={dir}
              usage={usage}
              systemLevel={systemLevel}
              turboConnecting={turboConnecting}
              historyOpen={historyOpen}
              onStop={doStop}
              onToggleMic={() => applyLive({ captureMic: !settings.captureMic })}
              onToggleOriginal={() => applyLive({ showOriginal: !settings.showOriginal })}
              onVolume={setVoiceVolume}
              onFont={cycleFont}
              onPopover={(p) => setPopover((cur) => (cur === p ? null : p))}
              onToggleEngine={toggleEngine}
              onAsk={openAssistant}
              onToggleHistory={() => setHistoryOpen((v) => !v)}
              onSetup={() => setSetupOpen(true)}
              onMinimize={() => setMinimized(true)}
              onQuit={() => window.api.windowControl('close')}
            />
          ) : (
            <IdleRow
              settings={settings}
              ready={ready}
              dir={dir}
              usage={usage}
              banner={latestBanner}
              onClearBanner={(k) => removeBanner(k)}
              onStart={start}
              busy={busy}
              onPopover={(p) => setPopover((cur) => (cur === p ? null : p))}
              onToggleEngine={toggleEngine}
              onSetup={() => setSetupOpen(true)}
              onMinimize={() => setMinimized(true)}
              onQuit={() => window.api.windowControl('close')}
            />
          )}

          {running && (
            <CaptionStack
              entries={entries}
              partial={partial}
              turbo={settings.turboMode}
              expanded={historyOpen}
              showOriginal={settings.showOriginal}
              feedRef={feedRef}
              onScroll={onFeedScroll}
              appName={IS_MAC ? settings.captureAppName : 'all system audio'}
            />
          )}

          {/* Persistent issue banners (only where there's room: live modes) */}
          {running && bannerList.length > 0 && (
            <div className="notices">
              {bannerList.slice(-2).map(([key, b]) => (
                <div key={key} className={`notice ${b.kind}`}>
                  <span className="n-text">{b.text}</span>
                  {b.action && (
                    <button className="n-btn" onClick={b.action.fn}>
                      {b.action.label}
                    </button>
                  )}
                  {b.dismissable && (
                    <button className="n-x" onClick={() => removeBanner(key)}>
                      ✕
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          {popover && (
            <PopoverShell onClose={closePopover}>
              {popover === 'lang' && <LanguagePopover settings={settings} applyLive={applyLive} />}
              {popover === 'app' && (
                <AppPickerPopover settings={settings} applyLive={applyLive} onPick={closePopover} />
              )}
              {popover === 'dock' && (
                <DockPopover settings={settings} setDock={setDock} onPick={closePopover} />
              )}
            </PopoverShell>
          )}
        </div>
      )}

      {toast && mode !== 'idle' && mode !== 'mini' && <div className="toast">{toast}</div>}
    </div>
  )
}

/* ============================ Level meter ============================ */
function LevelMeter({ level }: { level: number }) {
  const N = 6
  const lit = Math.round(Math.min(1, level * 7) * N)
  return (
    <div className="meter">
      {Array.from({ length: N }, (_, i) => (
        <div key={i} className={`tick ${i < lit ? 'lit' : ''}`} />
      ))}
    </div>
  )
}

/* ============================ Engine + cost chips ============================ */
function EngineChip({ turbo, onToggle }: { turbo: boolean; onToggle: () => void }) {
  return (
    <button
      className={`chip engine ${turbo ? 'turbo' : ''}`}
      onClick={onToggle}
      title={
        turbo
          ? 'Turbo (instant interpreter voice). Tap to switch to Standard.'
          : 'Standard (transcript + translation). Tap to switch to Turbo.'
      }
    >
      {turbo ? '⚡ Turbo' : '✎ Standard'}
    </button>
  )
}
function CostChip({ usage, onOpen }: { usage: UsageState | null; onOpen: () => void }) {
  const spent = usage?.spent ?? 0
  const budget = usage?.budget ?? 0
  return (
    <button
      className="chip cost"
      onClick={onOpen}
      title={`≈ $${spent.toFixed(2)} spent this month${budget > 0 ? ` of $${budget.toFixed(0)} cap` : ''}`}
    >
      ${spent.toFixed(2)}
    </button>
  )
}

/* ============================ Idle row ============================ */
function IdleRow({
  settings,
  ready,
  dir,
  usage,
  banner,
  onClearBanner,
  onStart,
  busy,
  onPopover,
  onToggleEngine,
  onSetup,
  onMinimize,
  onQuit
}: {
  settings: Settings
  ready: boolean
  dir: string
  usage: UsageState | null
  banner?: [string, Banner]
  onClearBanner: (key: string) => void
  onStart: () => void
  busy: boolean
  onPopover: (p: Popover) => void
  onToggleEngine: () => void
  onSetup: () => void
  onMinimize: () => void
  onQuit: () => void
}) {
  // A blocking banner (e.g. budget paused) takes over the slim pill.
  if (banner) {
    const [key, b] = banner
    return (
      <div className="row idle-row banner-row">
        <span className={`dot ${b.kind === 'error' ? 'red' : 'amber'}`} />
        <span className="row-text">{b.text}</span>
        {b.action && (
          <button className="mini primary" onClick={b.action.fn}>
            {b.action.label}
          </button>
        )}
        <button className="mini" onClick={() => onClearBanner(key)}>
          ✕
        </button>
      </div>
    )
  }
  return (
    <div className="row idle-row">
      <span className={`dot ${ready ? '' : 'amber'}`} />
      <EngineChip turbo={settings.turboMode} onToggle={onToggleEngine} />
      <span className="row-text" title={(IS_MAC && settings.captureAppName) || undefined}>
        {IS_MAC && settings.captureAppName
          ? settings.captureAppName
          : ready
            ? 'Ready'
            : 'Add your key'}
      </span>
      <button className="badge lang" onClick={() => onPopover('lang')} title="Languages">
        {dir} ▾
      </button>
      <CostChip usage={usage} onOpen={onSetup} />
      {ready ? (
        <button className="mini primary start" onClick={onStart} disabled={busy}>
          {busy ? '…' : '▶ Start'}
        </button>
      ) : (
        <button className="mini warnbtn" onClick={onSetup}>
          ⚙ Finish setup
        </button>
      )}
      <WindowControls onSetup={onSetup} onMinimize={onMinimize} onQuit={onQuit} />
    </div>
  )
}

// Consistent right-side window cluster: Setup · Minimize · Quit.
function WindowControls({
  onSetup,
  onMinimize,
  onQuit
}: {
  onSetup: () => void
  onMinimize: () => void
  onQuit: () => void
}) {
  return (
    <div className="wctl">
      <button className="iconbtn" title="Setup" onClick={onSetup}>
        ⚙
      </button>
      <button className="iconbtn" title="Hide (keep running)" onClick={onMinimize}>
        –
      </button>
      <button className="iconbtn quit" title="Quit SuperTranslate" onClick={onQuit}>
        ✕
      </button>
    </div>
  )
}

/* ============================ Mini handle ============================ */
// Collapsed state: a tiny always-on-top dot. Pulses green while still translating.
function MiniHandle({ live, dot, onRestore }: { live: boolean; dot: string; onRestore: () => void }) {
  return (
    <button
      className="mini-handle"
      title={live ? 'Translating — click to show' : 'Show SuperTranslate'}
      onClick={onRestore}
    >
      <span className={`dot ${dot}`} />
    </button>
  )
}

/* ============================ Live control row ============================ */
function LiveControlRow({
  settings,
  dir,
  usage,
  systemLevel,
  turboConnecting,
  historyOpen,
  onStop,
  onToggleMic,
  onToggleOriginal,
  onVolume,
  onFont,
  onPopover,
  onToggleEngine,
  onAsk,
  onToggleHistory,
  onSetup,
  onMinimize,
  onQuit
}: {
  settings: Settings
  dir: string
  usage: UsageState | null
  systemLevel: number
  turboConnecting: boolean
  historyOpen: boolean
  onStop: () => void
  onToggleMic: () => void
  onToggleOriginal: () => void
  onVolume: (v: number) => void
  onFont: () => void
  onPopover: (p: Popover) => void
  onToggleEngine: () => void
  onAsk: () => void
  onToggleHistory: () => void
  onSetup: () => void
  onMinimize: () => void
  onQuit: () => void
}) {
  return (
    <div className="row live-row">
      <button className="mini stop" onClick={onStop} title="Stop">
        ◼
      </button>
      <span className={`rec ${turboConnecting ? 'connecting' : ''}`} />
      <LevelMeter level={systemLevel} />
      <span className="live-dir">{turboConnecting ? 'Connecting…' : dir}</span>
      <EngineChip turbo={settings.turboMode} onToggle={onToggleEngine} />
      <CostChip usage={usage} onOpen={onSetup} />
      <div className="cluster">
        <button
          className={`iconbtn ${settings.captureMic ? 'on' : ''}`}
          title={settings.captureMic ? 'Mic on (translating you)' : 'Mic off (incoming only)'}
          onClick={onToggleMic}
        >
          {settings.captureMic ? '🎙' : '🚫'}
        </button>
        <button
          className={`iconbtn ${settings.showOriginal ? 'on' : ''}`}
          title="Show original"
          onClick={onToggleOriginal}
        >
          {settings.showOriginal ? '👁' : '⊘'}
        </button>
        <div className="vol" title={`Voice volume ${Math.round(settings.voiceVolume * 100)}%`}>
          <span>🔊</span>
          <input
            type="range"
            min={0}
            max={2}
            step={0.05}
            value={settings.voiceVolume}
            onChange={(e) => onVolume(Number(e.target.value))}
          />
        </div>
        <button className="iconbtn" title="Text size" onClick={onFont}>
          A
        </button>
        {IS_MAC && (
          <button className="iconbtn" title="Source app" onClick={() => onPopover('app')}>
            🖥
          </button>
        )}
        <button className="iconbtn" title="Position" onClick={() => onPopover('dock')}>
          ⤢
        </button>
      </div>
      {!settings.turboMode && (
        <button
          className="mini ask"
          onClick={onAsk}
          title="Ask the assistant about the conversation"
        >
          💬 {ASK_WORD[settings.theirLanguage] ?? 'Ask'}
        </button>
      )}
      <button
        className={`iconbtn ${historyOpen ? 'on' : ''}`}
        title={historyOpen ? 'Collapse' : 'History'}
        onClick={onToggleHistory}
      >
        {historyOpen ? '⌃' : '⌄'}
      </button>
      <WindowControls onSetup={onSetup} onMinimize={onMinimize} onQuit={onQuit} />
    </div>
  )
}

/* ============================ Caption stack ============================ */
const Typing = (): React.ReactElement => (
  <div className="typing">
    <i />
    <i />
    <i />
  </div>
)
const hasText = (e?: Entry): boolean => !!e && !!(e.translation || e.error || e.note)

function CaptionStack({
  entries,
  partial,
  turbo,
  expanded,
  showOriginal,
  feedRef,
  onScroll,
  appName
}: {
  entries: Entry[]
  partial: { mic: string; system: string }
  turbo: boolean
  expanded: boolean
  showOriginal: boolean
  feedRef: React.RefObject<HTMLDivElement | null>
  onScroll: () => void
  appName: string
}) {
  const partialText = partial.system || partial.mic
  const partialSource: Source = partial.system ? 'system' : 'mic'
  // Once any content has appeared, never flash back to the "Listening…" empty state
  // (the finalize sequence briefly empties entries/partial between IPC events).
  const everShownRef = useRef(false)
  if (entries.length > 0 || partialText) everShownRef.current = true

  // Auto-size the collapsed window to fit the caption so the translation is never cut
  // off. Measure the natural content height and ask main to resize (threshold-guarded).
  const measureRef = useRef<HTMLDivElement | null>(null)
  const lastReportedH = useRef(0)
  const rafRef = useRef(0)
  useLayoutEffect(() => {
    if (expanded) return
    const el = measureRef.current
    if (!el) return
    const desired = 34 + el.offsetHeight + 18 + 2 // control row + content + padding + border
    if (Math.abs(desired - lastReportedH.current) < 8) return // ignore sub-line churn
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(() => {
      lastReportedH.current = desired
      window.api.setCollapsedHeight(desired)
    })
  })
  useEffect(() => () => { if (rafRef.current) cancelAnimationFrame(rafRef.current) }, [])

  // ---- Expanded: the full scrollable transcript ----
  if (expanded) {
    return (
      <div className="capstack expanded" ref={feedRef} onScroll={onScroll}>
        {entries.length === 0 && !partialText && (
          <span className="cap-empty">Listening to {appName || 'the selected app'}…</span>
        )}
        {entries.map((e, i) => (
          <div key={e.id} className={`cue ${e.source} ${i === entries.length - 1 && !partialText ? 'live' : 'past'}`}>
            <div className="cue-main">
              <span className="cue-who">{speakerName(e.source)}</span>
              <div className="cue-body">
                {e.translation ? (
                  <div className="cue-trans">{e.translation}</div>
                ) : e.error ? (
                  <div className="cue-err">{e.error}</div>
                ) : e.note ? (
                  <div className="cue-note">{e.note}</div>
                ) : (
                  <Typing />
                )}
                {showOriginal && e.original && <div className="cue-orig">{e.original}</div>}
              </div>
            </div>
          </div>
        ))}
        {partialText && (
          <div className={`cue ${partialSource} live`}>
            <div className="cue-main">
              <span className="cue-who">{speakerName(partialSource)}</span>
              <div className="cue-body">
                <div className="cue-trans interim">{partialText}</div>
              </div>
            </div>
          </div>
        )}
      </div>
    )
  }

  // ---- Collapsed: reading-optimized. The TRANSLATION is the stable, bright hero;
  // incoming speech is only a faint hint above it (it must never demote the line
  // you're reading). ----
  if (!everShownRef.current) {
    return (
      <div className="capstack empty">
        <span className="cap-empty">
          Listening to {appName || 'the selected app'}… play audio to see the translation.
        </span>
      </div>
    )
  }

  let hero: Entry | undefined
  let incoming = ''

  if (turbo) {
    // Turbo's partial IS the live translation, so it's the hero. Between turns (partial
    // cleared, entry arriving) hold the last translated line so it never blanks/flickers.
    if (partialText) {
      hero = { id: '__live', source: partialSource, original: '', translation: partialText }
    } else {
      for (let i = entries.length - 1; i >= 0; i--) {
        if (hasText(entries[i])) {
          hero = entries[i]
          break
        }
      }
      if (!hero) hero = entries[entries.length - 1]
    }
  } else {
    // Standard: hero = the most recent line that actually has a translation (held, so a
    // just-finalized line that's still translating doesn't blank out what you're reading).
    for (let i = entries.length - 1; i >= 0; i--) {
      if (hasText(entries[i])) {
        hero = entries[i]
        break
      }
    }
    const newest = entries[entries.length - 1]
    if (!hero) hero = newest // nothing translated yet → show the newest (typing)
    // Incoming = what's being spoken now (live partial), or the next utterance that
    // finalized but isn't translated yet — shown faint, above the hero.
    if (partialText) incoming = partialText
    else if (newest && newest !== hero && !hasText(newest)) incoming = newest.original
    // Very first utterance: no entries yet, only a live partial → show a "hearing you"
    // hero (typing) so the reading area isn't just a tiny faint line.
    if (!hero && partialText) {
      hero = { id: '__pending', source: partialSource, original: '', translation: '' }
    }
  }

  return (
    <div className="capstack reading">
      <div className="reading-inner" ref={measureRef}>
        {incoming && <div className="cue-incoming">{incoming}</div>}
        {hero && (
          <div className={`cue hero ${hero.source}`}>
            <div className="cue-body">
              {hero.translation ? (
                <div className="cue-trans">{hero.translation}</div>
              ) : hero.error ? (
                <div className="cue-err">{hero.error}</div>
              ) : hero.note ? (
                <div className="cue-note">{hero.note}</div>
              ) : (
                <Typing />
              )}
              {showOriginal && hero.original && <div className="cue-orig">{hero.original}</div>}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/* ============================ Popovers ============================ */
function PopoverShell({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="pop-backdrop" onMouseDown={onClose}>
      <div className="popover" onMouseDown={(e) => e.stopPropagation()}>
        <button className="pop-close" onClick={onClose} title="Close">
          ✕
        </button>
        {children}
      </div>
    </div>
  )
}

function LanguagePopover({
  settings,
  applyLive
}: {
  settings: Settings
  applyLive: (p: Partial<Settings>) => void
}) {
  return (
    <>
      <div className="pop-head">Languages</div>
      <div className="pop-langs">
        <div className="pop-field">
          <label>They speak</label>
          <select
            value={settings.theirLanguage}
            onChange={(e) => applyLive({ theirLanguage: e.target.value })}
          >
            <option value="auto">Auto-detect</option>
            <option value="ko">Korean</option>
            <option value="zh">Chinese</option>
            <option value="en">English</option>
          </select>
        </div>
        <button
          className="swap"
          title="Swap"
          onClick={() =>
            applyLive({
              theirLanguage: settings.myLanguage,
              myLanguage: settings.theirLanguage === 'auto' ? 'en' : settings.theirLanguage
            })
          }
        >
          ⇄
        </button>
        <div className="pop-field">
          <label>I speak</label>
          <select
            value={settings.myLanguage}
            onChange={(e) => applyLive({ myLanguage: e.target.value })}
          >
            <option value="en">English</option>
            <option value="ko">Korean</option>
            <option value="zh">Chinese</option>
          </select>
        </div>
      </div>
    </>
  )
}

function AppPickerPopover({
  settings,
  applyLive,
  onPick
}: {
  settings: Settings
  applyLive: (p: Partial<Settings>) => void
  onPick: () => void
}) {
  const [apps, setApps] = useState<{ pid: number; name: string }[]>([])
  const [loading, setLoading] = useState(true)
  const load = useCallback(() => {
    setLoading(true)
    window.api
      .listApps()
      .then((a) => setApps(a))
      .catch(() => setApps([]))
      .finally(() => setLoading(false))
  }, [])
  useEffect(() => load(), [load])
  return (
    <>
      <div className="pop-head">
        Listen to which app?
        <button className="pop-refresh" onClick={load} title="Refresh">
          ↻
        </button>
      </div>
      <div className="pop-list">
        {loading && <div className="pop-empty">Loading…</div>}
        {!loading && apps.length === 0 && <div className="pop-empty">No audio apps found.</div>}
        {apps.map((a) => (
          <button
            key={a.pid}
            className={`pop-item ${settings.captureAppPid === a.pid ? 'sel' : ''}`}
            onClick={() => {
              applyLive({ captureAppPid: a.pid, captureAppName: a.name })
              onPick()
            }}
          >
            {a.name}
            {settings.captureAppPid === a.pid && <span className="sel-tick">✓</span>}
          </button>
        ))}
      </div>
      <div className="pop-foot">Native apps get muted so you hear only the translation.</div>
    </>
  )
}

const DOCKS: { id: Dock; label: string; glyph: string }[] = [
  { id: 'top-center', label: 'Top', glyph: '▔' },
  { id: 'top-left', label: 'Top left', glyph: '◤' },
  { id: 'top-right', label: 'Top right', glyph: '◥' },
  { id: 'bottom-center', label: 'Bottom', glyph: '▁' }
]
function DockPopover({
  settings,
  setDock,
  onPick
}: {
  settings: Settings
  setDock: (d: Dock) => void
  onPick: () => void
}) {
  return (
    <>
      <div className="pop-head">Position</div>
      <div className="pop-docks">
        {DOCKS.map((d) => (
          <button
            key={d.id}
            className={`dock-btn ${settings.dock === d.id ? 'sel' : ''}`}
            onClick={() => {
              setDock(d.id)
              onPick()
            }}
          >
            <span className="dock-glyph">{d.glyph}</span>
            {d.label}
          </button>
        ))}
      </div>
      <div className="pop-foot">Or just drag the bar anywhere.</div>
    </>
  )
}

/* ============================ Meeting assistant sheet ============================ */
function AssistantSheet({
  settings,
  state,
  hasTranscript,
  micState,
  onAsk,
  onSetAnswerLang,
  onToggleAutoSpeak,
  onSpeak,
  onCopy,
  onTurnOnMic,
  onOpenSetup,
  onClose
}: {
  settings: Settings
  state: { asking: boolean; question: string; answer: string; error: string; provider: string }
  hasTranscript: boolean
  micState: 'ok' | 'silent' | 'off'
  onAsk: (q: string, display?: string) => void
  onSetAnswerLang: (l: string) => void
  onToggleAutoSpeak: () => void
  onSpeak: (t: string, l: string) => void
  onCopy: (t: string) => void
  onTurnOnMic: () => void
  onOpenSetup: () => void
  onClose: () => void
}) {
  const [input, setInput] = useState('')
  const composingRef = useRef(false)
  const answerRef = useRef<HTMLDivElement | null>(null)
  const want = settings.assistantAnswerLang || settings.theirLanguage
  const lang = want === 'auto' ? 'zh' : want
  const ui = ASSIST_UI[lang] ?? ASSIST_UI.en
  const errText = state.error ? (ASSIST_ERR[lang]?.[state.error] ?? ASSIST_ERR.en[state.error] ?? ASSIST_ERR.en.network) : ''
  // Show the data-egress provider up front (derived from settings), not only after an answer.
  const providerLabel =
    state.provider ||
    (settings.translateApiKey
      ? PROVIDER_LABEL[settings.translateProvider]
      : settings.openaiApiKey
        ? 'OpenAI'
        : '')

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  useEffect(() => {
    const el = answerRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [state.answer])

  const submitInput = (): void => {
    if (input.trim() && !state.asking && hasTranscript) {
      onAsk(input)
      setInput('')
    }
  }

  return (
    <div className="assist">
      <div className="assist-head">
        <h2>💬 {ASK_WORD[lang] ?? 'Ask'}</h2>
        <div className="seg sm assist-lang">
          <button
            className={want !== settings.myLanguage ? 'on' : ''}
            onClick={() => onSetAnswerLang(settings.theirLanguage)}
          >
            {LANG_NAME[settings.theirLanguage] ?? '中文'}
          </button>
          <button
            className={want === settings.myLanguage ? 'on' : ''}
            onClick={() => onSetAnswerLang(settings.myLanguage)}
          >
            {LANG_NAME[settings.myLanguage] ?? 'EN'}
          </button>
        </div>
        <button className="iconbtn" onClick={onClose} title="Close">
          ✕
        </button>
      </div>
      <div className="assist-body">
        <div className="assist-presets">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              className="preset"
              disabled={state.asking || !hasTranscript}
              onClick={() => onAsk(p.intent, trL(p.label, lang))}
            >
              {trL(p.label, lang)}
            </button>
          ))}
        </div>
        {micState === 'off' && (
          <div className="notice warn assist-notice">
            <span className="n-text">{ui.micBlind}</span>
            <button className="n-btn" onClick={onTurnOnMic}>
              {ui.turnOnMic}
            </button>
          </div>
        )}
        {micState === 'silent' && hasTranscript && (
          <div className="assist-q">{ui.waitSpeak}</div>
        )}
        {state.question && (
          <div className="assist-q">
            {ui.youAsked}: {state.question}
          </div>
        )}
        <div className="assist-answer" ref={answerRef}>
          {state.error ? (
            <div className="assist-err">
              {errText}
              {(state.error === 'nokey' || state.error === 'auth') && (
                <button className="link" onClick={onOpenSetup}>
                  → {ui.setup}
                </button>
              )}
            </div>
          ) : state.answer ? (
            state.answer
          ) : state.asking ? (
            <Typing />
          ) : (
            <span className="assist-hint">{hasTranscript ? ui.empty : ui.thin}</span>
          )}
        </div>
        {state.answer && !state.asking && (
          <div className="assist-actions">
            <button className="mini" onClick={() => onSpeak(state.answer, lang)}>
              🔊 {ui.speak}
            </button>
            <button className="mini" onClick={() => onCopy(state.answer)}>
              ⧉ {ui.copy}
            </button>
            {state.question && (
              <button className="mini" onClick={() => onAsk(state.question)}>
                ↻ {ui.regen}
              </button>
            )}
            <label className="assist-autospeak">
              <input type="checkbox" checked={settings.assistAutoSpeak} onChange={onToggleAutoSpeak} />
              {ui.autoSpeak}
            </label>
          </div>
        )}
      </div>
      <div className="assist-input">
        <textarea
          value={input}
          placeholder={ui.placeholder}
          rows={1}
          onChange={(e) => setInput(e.target.value)}
          onCompositionStart={() => (composingRef.current = true)}
          onCompositionEnd={() => (composingRef.current = false)}
          onKeyDown={(e) => {
            if (
              e.key === 'Enter' &&
              !e.shiftKey &&
              !composingRef.current &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault()
              submitInput()
            }
          }}
        />
        <button
          className="mini primary"
          onClick={submitInput}
          disabled={state.asking || !input.trim() || !hasTranscript}
        >
          {ui.send}
        </button>
      </div>
      {providerLabel && (
        <div className="assist-foot">
          {ui.poweredBy} {providerLabel}
        </div>
      )}
    </div>
  )
}

/* ============================ First run ============================ */
function FirstRun({ onOpenSetup, onSkip }: { onOpenSetup: () => void; onSkip: () => void }) {
  return (
    <div className="firstrun">
      <div className="fr-emoji">🗣️</div>
      <h1>SuperTranslate</h1>
      <p className="fr-sub">Live translation that floats over your call.</p>
      <ol className="fr-steps">
        <li>Add your API key</li>
        <li>{IS_MAC ? 'Pick the call app' : 'Play your call audio'}</li>
        <li>Press Start</li>
      </ol>
      <div className="fr-actions">
        <button className="ghost" onClick={onSkip}>
          Skip for now
        </button>
        <button className="primary" onClick={onOpenSetup}>
          Open Setup
        </button>
      </div>
    </div>
  )
}

/* ============================ Setup sheet (one flat page) ============================ */
function SetupSheet({
  settings,
  perms,
  usage,
  pinned,
  applyLive,
  refreshPerms,
  togglePin,
  onClose
}: {
  settings: Settings
  perms: { screen: string; microphone: string }
  usage: UsageState | null
  pinned: boolean
  applyLive: (p: Partial<Settings>) => void
  refreshPerms: () => void
  togglePin: () => void
  onClose: () => void
}) {
  useEffect(() => {
    refreshPerms()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [refreshPerms, onClose])

  return (
    <div className="setup">
      <div className="setup-head">
        <h2>Setup</h2>
        <button className="iconbtn" onClick={onClose} title="Done">
          ✕
        </button>
      </div>
      <div className="setup-body">
        <Section title="Engine">
          <div className="seg">
            <button
              className={settings.turboMode ? 'on turbo' : ''}
              onClick={() => applyLive({ turboMode: true })}
            >
              ⚡ Turbo
            </button>
            <button
              className={!settings.turboMode ? 'on' : ''}
              onClick={() => applyLive({ turboMode: false })}
            >
              Standard
            </button>
          </div>
          {settings.turboMode && (
            <div className="seg sm" style={{ marginTop: 8 }}>
              <button
                className={settings.realtimeProvider === 'gemini' ? 'on turbo' : ''}
                onClick={() => applyLive({ realtimeProvider: 'gemini' })}
              >
                Gemini · ~$1.40/hr
              </button>
              <button
                className={settings.realtimeProvider === 'openai' ? 'on turbo' : ''}
                onClick={() => applyLive({ realtimeProvider: 'openai' })}
              >
                OpenAI · ~$2/hr
              </button>
            </div>
          )}
          <p className="hint">
            {settings.turboMode
              ? settings.realtimeProvider === 'openai'
                ? 'OpenAI gpt-realtime-translate — flat ~$2/hr, one key, predictable cost.'
                : 'Gemini Live — ~$1.40/hr, one key.'
              : 'Two keys (Soniox + a translator). Cheaper per hour.'}
          </p>
        </Section>

        <Section title="API keys">
          {settings.turboMode ? (
            settings.realtimeProvider === 'openai' ? (
              <Field label="OpenAI key">
                <input
                  type="password"
                  placeholder="Paste your OpenAI key (sk-…)"
                  value={settings.openaiApiKey}
                  onChange={(e) => applyLive({ openaiApiKey: e.target.value.trim() })}
                />
                <button className="link" onClick={() => window.api.openExternal(OPENAI_KEYS_URL)}>
                  Get an OpenAI key →
                </button>
              </Field>
            ) : (
              <Field label="Gemini key">
                <input
                  type="password"
                  placeholder="Paste your Gemini key"
                  value={settings.geminiApiKey}
                  onChange={(e) => applyLive({ geminiApiKey: e.target.value.trim() })}
                />
                <button className="link" onClick={() => window.api.openExternal(GEMINI_KEYS_URL)}>
                  Get a Gemini key →
                </button>
              </Field>
            )
          ) : (
            <>
              <Field label="Soniox key (speech)">
                <input
                  type="password"
                  placeholder="Paste your Soniox key"
                  value={settings.sonioxApiKey}
                  onChange={(e) => applyLive({ sonioxApiKey: e.target.value.trim() })}
                />
                <button className="link" onClick={() => window.api.openExternal(SONIOX_KEYS_URL)}>
                  Get a Soniox key →
                </button>
              </Field>
              <Field label="Translator">
                <div className="seg sm">
                  {(['deepseek', 'qwen', 'openrouter'] as Provider[]).map((p) => (
                    <button
                      key={p}
                      className={settings.translateProvider === p ? 'on' : ''}
                      onClick={() => applyLive({ translateProvider: p })}
                    >
                      {PROVIDER_LABEL[p]}
                    </button>
                  ))}
                </div>
                <input
                  type="password"
                  placeholder={`${PROVIDER_LABEL[settings.translateProvider]} key`}
                  value={settings.translateApiKey}
                  onChange={(e) => applyLive({ translateApiKey: e.target.value.trim() })}
                  style={{ marginTop: 8 }}
                />
                <button
                  className="link"
                  onClick={() => window.api.openExternal(KEY_URL[settings.translateProvider])}
                >
                  Get a {PROVIDER_LABEL[settings.translateProvider]} key →
                </button>
              </Field>
            </>
          )}
        </Section>

        <Section title="Languages">
          <div className="row2">
            <Field label="They speak">
              <select
                value={settings.theirLanguage}
                onChange={(e) => applyLive({ theirLanguage: e.target.value })}
              >
                <option value="auto">Auto-detect</option>
                <option value="ko">Korean</option>
                <option value="zh">Chinese</option>
                <option value="en">English</option>
              </select>
            </Field>
            <Field label="I speak">
              <select
                value={settings.myLanguage}
                onChange={(e) => applyLive({ myLanguage: e.target.value })}
              >
                <option value="en">English</option>
                <option value="ko">Korean</option>
                <option value="zh">Chinese</option>
              </select>
            </Field>
          </div>
        </Section>

        <Section title="Voice">
          <Toggle
            checked={settings.speakAloud}
            onChange={(v) => applyLive({ speakAloud: v })}
            label="Speak the translation aloud (Turbo always speaks)"
          />
          <div className="seg sm" style={{ marginTop: 8 }}>
            <button
              className={settings.ttsEngine === 'system' ? 'on' : ''}
              onClick={() => applyLive({ ttsEngine: 'system' })}
            >
              Built-in (free)
            </button>
            <button
              className={settings.ttsEngine === 'elevenlabs' ? 'on' : ''}
              onClick={() => applyLive({ ttsEngine: 'elevenlabs' })}
            >
              ElevenLabs (HD)
            </button>
          </div>
          {settings.ttsEngine === 'elevenlabs' && (
            <>
              <input
                type="password"
                placeholder="ElevenLabs key"
                value={settings.elevenLabsApiKey}
                onChange={(e) => applyLive({ elevenLabsApiKey: e.target.value.trim() })}
                style={{ marginTop: 8 }}
              />
              <input
                type="text"
                placeholder="Voice ID (optional)"
                value={settings.elevenLabsVoiceId}
                onChange={(e) => applyLive({ elevenLabsVoiceId: e.target.value.trim() })}
                style={{ marginTop: 8 }}
              />
            </>
          )}
          <label className="slabel">Talking speed {settings.ttsRate.toFixed(2)}×</label>
          <input
            type="range"
            min={0.8}
            max={1.6}
            step={0.05}
            value={settings.ttsRate}
            onChange={(e) => applyLive({ ttsRate: Number(e.target.value) })}
          />
          <label className="slabel">Voice volume {Math.round(settings.voiceVolume * 100)}%</label>
          <input
            type="range"
            min={0}
            max={2}
            step={0.05}
            value={settings.voiceVolume}
            onChange={(e) => applyLive({ voiceVolume: Number(e.target.value) })}
          />
          {IS_MAC ? (
            <>
              <label className="slabel">
                Background (the call, under the translation){' '}
                {Math.round(settings.backgroundVolume * 100)}%
              </label>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={settings.backgroundVolume}
                onChange={(e) => applyLive({ backgroundVolume: Number(e.target.value) })}
              />
              <p className="hint">
                For native apps (Zoom/Teams) we mute the app and replay it at this volume under the
                translation — turn it down and push Voice up to hear mostly the translation. It ducks
                automatically while the translation speaks. (Browsers: lower the browser’s own
                volume.)
              </p>
            </>
          ) : (
            <p className="hint">
              On Windows, SuperTranslate captures all system audio. Keep only the call app playing
              and lower other apps; use headphones to avoid the translation echoing back.
            </p>
          )}
        </Section>

        <Section title="Audio & display">
          <Toggle
            checked={settings.captureMic}
            onChange={(v) => applyLive({ captureMic: v })}
            label="Translate my microphone too (off avoids the Bluetooth call-quality drop)"
          />
          <Toggle
            checked={settings.showOriginal}
            onChange={(v) => applyLive({ showOriginal: v })}
            label="Show the original text under each translation"
          />
          <Toggle checked={pinned} onChange={togglePin} label="Keep window on top" />
        </Section>

        {IS_MAC && (
          <Section title="Permissions">
            <PermissionRow
              icon="🖥️"
              title="Screen & System Audio"
              sub="Lets SuperTranslate hear the other app."
              status={perms.screen}
              onGrant={() => window.api.openScreenSettings()}
              onRefresh={refreshPerms}
              needsRelaunch
            />
            {settings.captureMic && (
              <PermissionRow
                icon="🎙️"
                title="Microphone"
                sub="Needed because ‘translate me’ is on."
                status={perms.microphone}
                onGrant={async () => {
                  await window.api.askMicPermission()
                  refreshPerms()
                }}
                onRefresh={refreshPerms}
              />
            )}
          </Section>
        )}

        <Section title="Budget">
          <div className="brow">
            <span>$</span>
            <input
              type="number"
              min={0}
              step={1}
              value={settings.monthlyBudgetUSD}
              onChange={(e) => applyLive({ monthlyBudgetUSD: Math.max(0, Number(e.target.value)) })}
              style={{ width: 90 }}
            />
            <span className="dim">/ month cap</span>
            {usage && <span className="dim spent">· ${usage.spent.toFixed(2)} used</span>}
          </div>
          <p className="hint">Stops automatically at this limit. 0 = no cap.</p>
        </Section>

        <div className="setup-footer">
          <button className="link" onClick={() => applyLive({ onboarded: false })}>
            Replay welcome
          </button>
          <button className="link danger" onClick={() => window.api.windowControl('close')}>
            Quit app
          </button>
        </div>
      </div>
      <div className="setup-done">
        <button className="primary full" onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="sec">
      <div className="sec-title">{title}</div>
      {children}
    </section>
  )
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="field">
      <label className="slabel">{label}</label>
      {children}
    </div>
  )
}
function Toggle({
  checked,
  onChange,
  label
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
}) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  )
}

function PermissionRow({
  icon,
  title,
  sub,
  status,
  onGrant,
  onRefresh,
  needsRelaunch
}: {
  icon: string
  title: string
  sub: string
  status: string
  onGrant: () => void
  onRefresh: () => void
  needsRelaunch?: boolean
}) {
  const granted = status === 'granted'
  return (
    <div className="permrow">
      <div className="p-ico">{icon}</div>
      <div className="p-body">
        <div className="p-title">{title}</div>
        <div className="p-sub">{sub}</div>
      </div>
      {granted ? (
        needsRelaunch ? (
          <button className="mini" onClick={() => window.api.relaunchApp()}>
            Relaunch
          </button>
        ) : (
          <span className="pstate ok">Granted ✓</span>
        )
      ) : (
        <button
          className="mini"
          onClick={() => {
            onGrant()
            setTimeout(onRefresh, 1500)
          }}
        >
          Grant
        </button>
      )}
    </div>
  )
}
