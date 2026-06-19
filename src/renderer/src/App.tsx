import { useCallback, useEffect, useRef, useState } from 'react'
import { startCapture, setMicMuted, setSystemMuted, type CaptureResult } from './audio'

type Source = 'mic' | 'system'
type Provider = 'deepseek' | 'qwen' | 'openrouter'
type Dock = 'top-center' | 'bottom-center' | 'top-left' | 'top-right' | 'free'
type Popover = 'lang' | 'app' | 'engine' | 'dock' | null

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
  ttsRate: number
  responseSpeed: 'fast' | 'balanced' | 'accurate'
  turboMode: boolean
  realtimeProvider: 'gemini' | 'openai'
  geminiApiKey: string
  openaiApiKey: string
  onboarded: boolean
  fontScalePref: number
  dock: Dock
}

interface Entry {
  id: string
  source: Source
  original: string
  translation: string
  note?: string
  error?: string
  partialText?: string
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
  useEffect(() => {
    settingsRef.current = settings
    if (settings) voiceVolumeRef.current = settings.voiceVolume ?? 1
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
    if (setupOpen || onboarding) window.api.setPin(false)
    else window.api.setPin(pinned)
  }, [setupOpen, onboarding, pinned])

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

  // ---- capture-loop guards (mute mic/system while a dub plays) ----
  const guardOn = useCallback(() => {
    setMicMuted(true)
    setSystemMuted(true)
    if (ttsGuardTimer.current) clearTimeout(ttsGuardTimer.current)
    ttsGuardTimer.current = setTimeout(() => {
      setMicMuted(false)
      setSystemMuted(false)
    }, 20000)
  }, [])
  const guardOff = useCallback(() => {
    if (ttsGuardTimer.current) clearTimeout(ttsGuardTimer.current)
    ttsGuardTimer.current = setTimeout(() => {
      setMicMuted(false)
      setSystemMuted(false)
    }, 400)
  }, [])
  const turboGuard = useCallback((msUntilDone: number) => {
    setMicMuted(true)
    if (turboGuardTimer.current) clearTimeout(turboGuardTimer.current)
    turboGuardTimer.current = setTimeout(() => setMicMuted(false), msUntilDone + 400)
  }, [])

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
          { id: p.id, source: p.source, original: p.original, translation: '' }
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
          action: { label: 'Fix', fn: () => window.api.openScreenSettings() },
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
      offSysMode()
      offStatus()
      offDock()
    }
  }, [flash, speak, guardOn, guardOff, playTurboPcm, turboGuard, addBanner])

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
  }, [addBanner, removeBanner, ensureTurboCtx])

  const doStop = useCallback(async () => {
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
    if (!s.captureAppPid) {
      setPopover('app')
      flash('Pick the app to listen to.')
      return
    }
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

  if (!settings) return <div className="boot">Loading…</div>

  const fontScale = settings.fontScalePref || settings.fontScale || 1
  const ready = engineReady(settings)
  const masterDot = !ready ? 'amber' : running ? 'green' : Object.keys(banners).length ? 'amber' : ''
  const dir = `${LANG_SHORT[settings.theirLanguage] ?? '··'}→${LANG_SHORT[settings.myLanguage] ?? '··'}`

  const bannerList = Object.entries(banners)
  const latestBanner = bannerList[bannerList.length - 1]

  // Build the caption cue list (finalized entries + the current live partial).
  const cues: Entry[] = [...entries]
  const partialText = partial.system || partial.mic
  if (partialText) {
    cues.push({
      id: '__partial',
      source: partial.system ? 'system' : 'mic',
      original: '',
      translation: '',
      partialText
    })
  }

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
              systemLevel={systemLevel}
              turboConnecting={turboConnecting}
              historyOpen={historyOpen}
              onStop={doStop}
              onToggleMic={() => applyLive({ captureMic: !settings.captureMic })}
              onToggleOriginal={() => applyLive({ showOriginal: !settings.showOriginal })}
              onVolume={setVoiceVolume}
              onFont={cycleFont}
              onPopover={(p) => setPopover((cur) => (cur === p ? null : p))}
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
              banner={latestBanner}
              onClearBanner={(k) => removeBanner(k)}
              onStart={start}
              busy={busy}
              onPopover={(p) => setPopover((cur) => (cur === p ? null : p))}
              onSetup={() => setSetupOpen(true)}
              onMinimize={() => setMinimized(true)}
              onQuit={() => window.api.windowControl('close')}
            />
          )}

          {running && (
            <CaptionStack
              cues={cues}
              expanded={historyOpen}
              showOriginal={settings.showOriginal}
              feedRef={feedRef}
              onScroll={onFeedScroll}
              appName={settings.captureAppName}
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
              {popover === 'engine' && (
                <EnginePopover settings={settings} applyLive={applyLive} onPick={closePopover} />
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

/* ============================ Idle row ============================ */
function IdleRow({
  settings,
  ready,
  dir,
  banner,
  onClearBanner,
  onStart,
  busy,
  onPopover,
  onSetup,
  onMinimize,
  onQuit
}: {
  settings: Settings
  ready: boolean
  dir: string
  banner?: [string, Banner]
  onClearBanner: (key: string) => void
  onStart: () => void
  busy: boolean
  onPopover: (p: Popover) => void
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
      <span className="row-text" title={settings.captureAppName || undefined}>
        {settings.captureAppName ? settings.captureAppName : ready ? 'Ready' : 'Add your key'}
      </span>
      <button className="badge lang" onClick={() => onPopover('lang')} title="Languages">
        {dir} ▾
      </button>
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
  systemLevel,
  turboConnecting,
  historyOpen,
  onStop,
  onToggleMic,
  onToggleOriginal,
  onVolume,
  onFont,
  onPopover,
  onToggleHistory,
  onSetup,
  onMinimize,
  onQuit
}: {
  settings: Settings
  dir: string
  systemLevel: number
  turboConnecting: boolean
  historyOpen: boolean
  onStop: () => void
  onToggleMic: () => void
  onToggleOriginal: () => void
  onVolume: (v: number) => void
  onFont: () => void
  onPopover: (p: Popover) => void
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
        <button className="iconbtn" title="Source app" onClick={() => onPopover('app')}>
          🖥
        </button>
        <button className="iconbtn" title="Position" onClick={() => onPopover('dock')}>
          ⤢
        </button>
      </div>
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
function CaptionStack({
  cues,
  expanded,
  showOriginal,
  feedRef,
  onScroll,
  appName
}: {
  cues: Entry[]
  expanded: boolean
  showOriginal: boolean
  feedRef: React.RefObject<HTMLDivElement | null>
  onScroll: () => void
  appName: string
}) {
  if (cues.length === 0) {
    return (
      <div className="capstack empty">
        <span className="cap-empty">
          Listening to {appName || 'the selected app'}… play audio to see the translation.
        </span>
      </div>
    )
  }
  const shown = expanded ? cues : cues.slice(-2)
  const lastIdx = shown.length - 1
  return (
    <div
      className={`capstack ${expanded ? 'expanded' : ''}`}
      ref={feedRef}
      onScroll={expanded ? onScroll : undefined}
    >
      {shown.map((c, i) => (
        <CaptionCue
          key={c.id}
          cue={c}
          live={i === lastIdx}
          showOriginal={showOriginal}
          showWho={expanded}
        />
      ))}
    </div>
  )
}

function CaptionCue({
  cue,
  live,
  showOriginal,
  showWho
}: {
  cue: Entry
  live: boolean
  showOriginal: boolean
  showWho: boolean
}) {
  return (
    <div className={`cue ${cue.source} ${live ? 'live' : 'past'}`}>
      <div className="cue-main">
        {showWho && <span className="cue-who">{speakerName(cue.source)}</span>}
        <div className="cue-body">
          {cue.translation ? (
            <div className="cue-trans">{cue.translation}</div>
          ) : cue.error ? (
            <div className="cue-err">{cue.error}</div>
          ) : cue.note ? (
            <div className="cue-note">{cue.note}</div>
          ) : cue.partialText ? (
            <div className="cue-trans interim">{cue.partialText}</div>
          ) : (
            <div className="typing">
              <i />
              <i />
              <i />
            </div>
          )}
          {showOriginal && cue.original && <div className="cue-orig">{cue.original}</div>}
        </div>
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

function EnginePopover({
  settings,
  applyLive,
  onPick
}: {
  settings: Settings
  applyLive: (p: Partial<Settings>) => void
  onPick: () => void
}) {
  return (
    <>
      <div className="pop-head">Engine</div>
      <div className="pop-stack">
        <button
          className={`pop-card ${settings.turboMode ? 'sel' : ''}`}
          onClick={() => {
            applyLive({ turboMode: true })
            onPick()
          }}
        >
          <b>⚡ Turbo {settings.realtimeProvider === 'openai' ? '(OpenAI)' : '(Gemini)'}</b>
          <span>
            Instant interpreter voice ·{' '}
            {settings.realtimeProvider === 'openai' ? '~$2/hr' : '~$1.40/hr'}
          </span>
        </button>
        <button
          className={`pop-card ${!settings.turboMode ? 'sel' : ''}`}
          onClick={() => {
            applyLive({ turboMode: false })
            onPick()
          }}
        >
          <b>Standard</b>
          <span>Soniox + translator · ~$0.12/hr</span>
        </button>
      </div>
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

/* ============================ First run ============================ */
function FirstRun({ onOpenSetup, onSkip }: { onOpenSetup: () => void; onSkip: () => void }) {
  return (
    <div className="firstrun">
      <div className="fr-emoji">🗣️</div>
      <h1>SuperTranslate</h1>
      <p className="fr-sub">Live translation that floats over your call.</p>
      <ol className="fr-steps">
        <li>Add your API key</li>
        <li>Pick the call app</li>
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
          <p className="hint">
            Above 100% boosts the Turbo voice — turn your Mac’s system volume down and push
            this up so you hear mostly the translation.
          </p>
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
