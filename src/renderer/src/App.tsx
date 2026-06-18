import { useCallback, useEffect, useRef, useState } from 'react'
import { startCapture, setMicMuted, setSystemMuted, type CaptureResult } from './audio'

type Source = 'mic' | 'system'
type Provider = 'deepseek' | 'qwen' | 'openrouter'

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
  geminiApiKey: string
  onboarded: boolean
  fontScalePref: number
}

interface Entry {
  id: string
  source: Source
  original: string
  translation: string
  note?: string
  error?: string
  sourceLang: string
  targetLang: string
  showOrig?: boolean
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
}

const LANG_LABEL: Record<string, string> = {
  en: 'English',
  ko: 'Korean',
  zh: 'Chinese',
  auto: 'Auto-detect'
}
const PROVIDER_LABEL: Record<Provider, string> = {
  deepseek: 'DeepSeek',
  qwen: 'Qwen',
  openrouter: 'OpenRouter'
}
const SONIOX_KEYS_URL = 'https://console.soniox.com'
const GEMINI_KEYS_URL = 'https://aistudio.google.com/apikey'
const KEY_URL: Record<Provider, string> = {
  deepseek: 'https://platform.deepseek.com/api_keys',
  qwen: 'https://bailian.console.alibabacloud.com/?tab=model#/api-key',
  openrouter: 'https://openrouter.ai/keys'
}
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
  'ttsEngine',
  'elevenLabsApiKey',
  'elevenLabsVoiceId',
  'responseSpeed',
  'speakAloud'
])

// Does the chosen engine have the keys it needs?
function engineReady(s: Settings): boolean {
  if (s.turboMode) return !!s.geminiApiKey
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
  const [showSettings, setShowSettings] = useState(false)
  const [onbStep, setOnbStep] = useState(0)

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

  useEffect(() => {
    runningRef.current = running
  }, [running])
  useEffect(() => {
    settingsRef.current = settings
    if (settings) voiceVolumeRef.current = settings.voiceVolume ?? 1
  }, [settings])

  const flash = useCallback((msg: string) => {
    setToast(msg)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(''), 2600)
  }, [])

  const addBanner = useCallback((key: string, b: Banner) => {
    setBanners((prev) => ({ ...prev, [key]: b }))
  }, [])
  const removeBanner = useCallback((key: string) => {
    setBanners((prev) => {
      if (!(key in prev)) return prev
      const n = { ...prev }
      delete n[key]
      return n
    })
  }, [])

  const refreshPerms = useCallback(() => {
    window.api.getPermissions().then(setPerms).catch(() => undefined)
  }, [])

  // ---- load settings + usage + perms; decide onboarding ----
  useEffect(() => {
    window.api.getSettings().then((s) => {
      const st = s as Settings
      // Migrate already-configured users straight past onboarding.
      if (!st.onboarded && (st.geminiApiKey || st.sonioxApiKey)) {
        window.api.saveSettings({ onboarded: true })
        st.onboarded = true
      }
      setSettings(st)
    })
    window.api.getUsage().then((u) => setUsage(u as UsageState))
    refreshPerms()
  }, [refreshPerms])

  // Drop always-on-top while settings / onboarding open so macOS prompts aren't hidden.
  const onboarding = !!settings && !settings.onboarded
  useEffect(() => {
    if (showSettings || onboarding) window.api.windowControl('unpin')
    else window.api.windowControl(pinned ? 'pin' : 'unpin')
  }, [showSettings, onboarding, pinned])

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

  const playTurboPcm = useCallback((base64: string) => {
    try {
      const bin = atob(base64)
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      const int16 = new Int16Array(bytes.buffer, 0, Math.floor(bytes.length / 2))
      if (!turboCtxRef.current) {
        turboCtxRef.current = new AudioContext({ sampleRate: 24000 })
        turboNextTimeRef.current = turboCtxRef.current.currentTime
        turboGainRef.current = turboCtxRef.current.createGain()
        turboGainRef.current.connect(turboCtxRef.current.destination)
      }
      const ctx = turboCtxRef.current
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
  }, [])

  // ---- subscribe to all main events (once) ----
  useEffect(() => {
    const offPartial = window.api.onPartial(({ source, text }) =>
      setPartial((p) => ({ ...p, [source]: text }))
    )
    const offFinal = window.api.onFinal((p) => {
      setEntries((prev) =>
        [
          ...prev,
          {
            id: p.id,
            source: p.source,
            original: p.original,
            translation: '',
            sourceLang: p.sourceLang,
            targetLang: p.targetLang,
            showOrig: settingsRef.current?.showOriginal ?? true
          }
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
      // Map known failures to friendly, single-action banners.
      const m = message.toLowerCase()
      if (m.includes('soniox')) {
        addBanner('err-stt', { kind: 'error', text: 'Speech recognition error — check your Soniox key.', action: { label: 'Settings', fn: () => setShowSettings(true) }, dismissable: true })
      } else if (m.includes('gemini') || m.includes('turbo')) {
        addBanner('err-turbo', { kind: 'error', text: message, action: { label: 'Settings', fn: () => setShowSettings(true) }, dismissable: true })
      } else if (m.includes('screen recording') || m.includes('audio recording') || m.includes('permission')) {
        addBanner('err-perm', { kind: 'warn', text: message, action: { label: 'Open settings', fn: () => window.api.openScreenSettings() }, dismissable: true })
      } else if (m.includes('voice') || m.includes('elevenlabs')) {
        addBanner('err-voice', { kind: 'warn', text: message, dismissable: true })
      } else {
        addBanner('err-misc', { kind: 'error', text: message, dismissable: true })
      }
    })
    const offUsage = window.api.onUsage((u) => setUsage(u))
    const offBudget = window.api.onBudget((b) => {
      if (b.reached) {
        captureRef.current?.stop()
        captureRef.current = null
        setRunning(false)
        setPartial({ mic: '', system: '' })
        addBanner('budget', {
          kind: 'warn',
          text: `Monthly budget of $${b.budget.toFixed(2)} reached — translation paused.`,
          action: { label: 'Settings', fn: () => setShowSettings(true) }
        })
      } else if (b.warning) {
        flash(`~$${b.spent.toFixed(2)} of $${b.budget.toFixed(2)} budget used`)
      }
    })
    const offSysLevel = window.api.onSystemLevel(({ rms }) => {
      setSystemLevel(rms)
      if (levelClearTimer.current) clearTimeout(levelClearTimer.current)
      levelClearTimer.current = setTimeout(() => setSystemLevel(0), 500)
    })
    const offSysMode = window.api.onSystemMode(({ mode }) => {
      if (mode === 'muted') flash('Source muted — you’ll hear only the translation ✓')
      else flash('Capturing this app — lower its volume to reduce overlap')
    })
    const offStatus = window.api.onStatus(({ source, status }) => {
      if (source !== 'system' || !settingsRef.current?.turboMode) return
      if (status === 'connecting') setTurboConnecting(true)
      else setTurboConnecting(false)
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
    }
  }, [flash, speak, guardOn, guardOff, playTurboPcm, turboGuard, addBanner])

  // Auto-scroll only when pinned to bottom.
  useEffect(() => {
    const el = feedRef.current
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight
  }, [entries, partial])
  const onFeedScroll = useCallback(() => {
    const el = feedRef.current
    if (el) atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
  }, [])

  // ---- capture lifecycle ----
  const doStart = useCallback(async () => {
    const s = settingsRef.current
    if (!s) return
    setBusy(true)
    try {
      const info = (await window.api.startCapture()) as { captureSystemInRenderer?: boolean }
      if (s.turboMode) {
        if (!turboCtxRef.current) {
          turboCtxRef.current = new AudioContext({ sampleRate: 24000 })
          turboNextTimeRef.current = turboCtxRef.current.currentTime
          turboGainRef.current = turboCtxRef.current.createGain()
          turboGainRef.current.connect(turboCtxRef.current.destination)
        }
        void turboCtxRef.current.resume()
      }
      captureRef.current = await startCapture({
        captureSystemAudio: !!info?.captureSystemInRenderer,
        captureMic: s.captureMic,
        onWarning: (msg) => addBanner('warn-cap', { kind: 'warn', text: msg, dismissable: true }),
        onSystemLevel: (rms) => setSystemLevel(rms)
      })
      setRunning(true)
    } catch (e) {
      addBanner('err-start', { kind: 'error', text: (e as Error).message, dismissable: true })
      await window.api.stopCapture().catch(() => undefined)
    } finally {
      setBusy(false)
    }
  }, [addBanner])

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
    setTurboConnecting(false)
    setPartial({ mic: '', system: '' })
    setSystemLevel(0)
  }, [])

  const start = useCallback(async () => {
    const s = settingsRef.current
    if (!s) return
    if (!engineReady(s)) {
      setShowSettings(true)
      flash('Add your key in Settings to start.')
      return
    }
    await doStart()
  }, [doStart, flash])

  // Live-apply: save settings, and if a capture-affecting key changed while running,
  // re-init capture (NOT the whole app).
  const applyLive = useCallback(
    async (patch: Partial<Settings>) => {
      const saved = (await window.api.saveSettings(patch)) as Settings
      settingsRef.current = saved
      setSettings(saved)
      const affectsCapture = Object.keys(patch).some((k) => CAPTURE_KEYS.has(k as keyof Settings))
      if (affectsCapture && runningRef.current) {
        await doStop()
        await doStart()
        flash('Applied ✓')
      }
    },
    [doStop, doStart, flash]
  )

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

  const togglePin = useCallback(() => {
    setPinned((p) => {
      const next = !p
      window.api.windowControl(next ? 'pin' : 'unpin')
      return next
    })
  }, [])

  const runDemo = useCallback(() => {
    setEntries([
      { id: 'd1', source: 'system', original: '안녕하세요, 만나서 반갑습니다.', translation: 'Hello, nice to meet you.', sourceLang: 'ko', targetLang: 'en', showOrig: true },
      { id: 'd2', source: 'mic', original: 'Likewise — shall we start?', translation: '저도요 — 시작할까요?', sourceLang: 'en', targetLang: 'ko', showOrig: true },
      { id: 'd3', source: 'system', original: '中国人已经习惯了只用手机付钱。', translation: 'People here are used to paying only by phone.', sourceLang: 'zh', targetLang: 'en', showOrig: true }
    ])
  }, [])

  if (!settings) return <div className="boot">Loading…</div>

  const fontScale = settings.fontScalePref || settings.fontScale || 1
  const ready = engineReady(settings)
  const live = running
  const masterDot = !ready ? 'amber' : live ? 'green' : Object.keys(banners).length ? 'amber' : ''
  const dir = `${(LANG_LABEL[settings.theirLanguage] ?? settings.theirLanguage).slice(0, 2).toUpperCase()}→${(LANG_LABEL[settings.myLanguage] ?? settings.myLanguage).slice(0, 2).toUpperCase()}`

  return (
    <div className="app" style={{ ['--font-scale' as string]: String(fontScale) }}>
      <header className="titlebar">
        <div className="brand">
          <span className={`dot ${masterDot}`} />
          <span>SuperTranslate</span>
        </div>
        <div className="win-controls">
          <button className="icon-btn" title="Settings" onClick={() => setShowSettings(true)}>
            ⚙
          </button>
          <button
            className={`icon-btn ${pinned ? 'active' : ''}`}
            title={pinned ? 'Keep on top: on' : 'Keep on top: off'}
            onClick={togglePin}
          >
            📌
          </button>
          <button className="icon-btn" title="Minimize" onClick={() => window.api.windowControl('minimize')}>
            –
          </button>
          <button className="icon-btn close" title="Quit" onClick={() => window.api.windowControl('close')}>
            ✕
          </button>
        </div>
      </header>

      {onboarding ? (
        <Onboarding
          settings={settings}
          perms={perms}
          step={onbStep}
          setStep={setOnbStep}
          applyLive={applyLive}
          refreshPerms={refreshPerms}
          runDemo={runDemo}
          onDone={async () => {
            await applyLive({ onboarded: true })
            setEntries([])
          }}
        />
      ) : (
        <>
          {/* Status strip */}
          <div className="statusstrip">
            <span className={`dot ${masterDot}`} />
            <span>
              {!ready
                ? 'Add your key to start'
                : turboConnecting
                  ? 'Connecting to Turbo…'
                  : live
                    ? 'Listening'
                    : 'Ready'}
            </span>
            {settings.captureAppName && (
              <>
                <span className="sep">·</span>
                <span>{settings.captureAppName}</span>
              </>
            )}
            <span className="sep">·</span>
            <span>{dir}</span>
            {usage && (
              <span className="cost" title="Estimated spend this month">
                ${usage.spent.toFixed(2)}
                {usage.budget > 0 ? ` / $${usage.budget.toFixed(0)}` : ''}
              </span>
            )}
          </div>

          {/* Banners */}
          {Object.keys(banners).length > 0 && (
            <div className="banners">
              {Object.entries(banners).map(([key, b]) => (
                <div key={key} className={`banner ${b.kind}`}>
                  <span className="b-ico">{b.kind === 'error' ? '⚠️' : b.kind === 'good' ? '✓' : '⚠️'}</span>
                  <span className="b-text">{b.text}</span>
                  {b.action && (
                    <button className="b-btn primary" onClick={b.action.fn}>
                      {b.action.label}
                    </button>
                  )}
                  {b.dismissable && (
                    <button className="b-x" onClick={() => removeBanner(key)}>
                      ✕
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Activity meter (when live) */}
          {live && (
            <div className="activity">
              <span className="who">Them</span>
              <LevelMeter level={systemLevel} active={live} />
            </div>
          )}

          {/* Main region */}
          {live || entries.length ? (
            <main className="main feed" ref={feedRef} onScroll={onFeedScroll}>
              {entries.map((e) => (
                <div key={e.id} className={`bubble ${e.source}`}>
                  <div className="bubble-head">
                    <span className="who">{speakerName(e.source)}</span>
                    <button
                      className="eye"
                      title="Show/hide original"
                      onClick={() =>
                        setEntries((prev) =>
                          prev.map((x) => (x.id === e.id ? { ...x, showOrig: !x.showOrig } : x))
                        )
                      }
                    >
                      {e.showOrig ? '👁' : '👁‍🗨'}
                    </button>
                  </div>
                  <div className="translation">
                    {e.translation ? (
                      e.translation
                    ) : e.error ? (
                      <span style={{ color: 'var(--error)', fontSize: 13 }}>{e.error}</span>
                    ) : e.note ? (
                      <span className="dim" style={{ fontSize: 13 }}>
                        {e.note}
                      </span>
                    ) : (
                      <span className="typing">
                        <i /> <i /> <i />
                      </span>
                    )}
                  </div>
                  {e.showOrig && e.original && <div className="original">{e.original}</div>}
                </div>
              ))}
              {(['system', 'mic'] as Source[]).map((src) =>
                partial[src] ? (
                  <div key={`p-${src}`} className={`bubble ${src} partial`}>
                    <div className="bubble-head">
                      <span className="who">{speakerName(src)}</span>
                      <span className="dim" style={{ fontSize: 10 }}>
                        listening…
                      </span>
                    </div>
                    <div className="original live">{partial[src]}</div>
                  </div>
                ) : null
              )}
              {live && entries.length === 0 && !partial.system && !partial.mic && (
                <div className="empty">
                  <div className="empty-emoji">🎧</div>
                  <p>
                    Listening to <b>{settings.captureAppName || 'the selected app'}</b>… play some
                    audio and the translation appears here.
                  </p>
                </div>
              )}
            </main>
          ) : (
            <IdleScreen
              settings={settings}
              ready={ready}
              perms={perms}
              applyLive={applyLive}
              onStart={start}
              busy={busy}
              openSettings={() => setShowSettings(true)}
              runDemo={runDemo}
            />
          )}

          {/* Control dock when live, else Start is in idle screen */}
          {live && (
            <div className="dock">
              <button className="primary stop" onClick={doStop}>
                ◼ Stop
              </button>
              <div className="vol">
                <span title="Voice volume">🔊</span>
                <input
                  type="range"
                  min={0}
                  max={1.5}
                  step={0.05}
                  value={settings.voiceVolume}
                  onChange={(e) => setVoiceVolume(Number(e.target.value))}
                />
                <span className="vol-pct">{Math.round(settings.voiceVolume * 100)}%</span>
              </div>
              <button className="fontbtn" title="Smaller" onClick={() => setFontScale(fontScale - 0.1)}>
                A−
              </button>
              <button className="fontbtn" title="Larger" onClick={() => setFontScale(fontScale + 0.1)}>
                A+
              </button>
            </div>
          )}
        </>
      )}

      {toast && <div className="toast">{toast}</div>}

      {showSettings && (
        <SettingsPanel
          settings={settings}
          perms={perms}
          applyLive={applyLive}
          refreshPerms={refreshPerms}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  )
}

/* ============================ Level meter ============================ */
function LevelMeter({ level, active }: { level: number; active: boolean }) {
  const N = 22
  const lit = Math.round(Math.min(1, level * 7) * N)
  return (
    <div className={`meter ${active && level > 0.004 ? '' : 'idle'}`}>
      {Array.from({ length: N }, (_, i) => (
        <div key={i} className={`tick ${i < lit ? 'lit' : ''}`} />
      ))}
    </div>
  )
}

/* ============================ Idle screen ============================ */
function IdleScreen({
  settings,
  ready,
  perms,
  applyLive,
  onStart,
  busy,
  openSettings,
  runDemo
}: {
  settings: Settings
  ready: boolean
  perms: { screen: string; microphone: string }
  applyLive: (p: Partial<Settings>) => void
  onStart: () => void
  busy: boolean
  openSettings: () => void
  runDemo: () => void
}) {
  const [apps, setApps] = useState<{ pid: number; name: string }[]>([])
  const [pickOpen, setPickOpen] = useState(false)
  useEffect(() => {
    if (pickOpen) window.api.listApps().then(setApps).catch(() => setApps([]))
  }, [pickOpen])
  const screenOk = perms.screen === 'granted'

  return (
    <main className="main">
      <div className="idle">
        <div className="idle-cards">
          <button className="idle-card" onClick={() => setPickOpen((v) => !v)}>
            <div className="ic-label">📞 Source app</div>
            <div className="ic-value">{settings.captureAppName || 'Pick an app'}</div>
            <div className="ic-sub">{settings.captureAppName ? 'tap to change' : 'who you’re calling on'}</div>
          </button>
          <button className="idle-card" onClick={openSettings}>
            <div className="ic-label">🌐 Languages</div>
            <div className="ic-value">
              {(LANG_LABEL[settings.theirLanguage] ?? settings.theirLanguage)} →{' '}
              {LANG_LABEL[settings.myLanguage] ?? settings.myLanguage}
            </div>
            <div className="ic-sub">tap to change</div>
          </button>
        </div>

        {pickOpen && (
          <div>
            <select
              value={settings.captureAppPid}
              onChange={(e) => {
                const pid = Number(e.target.value)
                applyLive({ captureAppPid: pid, captureAppName: apps.find((a) => a.pid === pid)?.name ?? '' })
                setPickOpen(false)
              }}
            >
              <option value={0}>— pick an app —</option>
              {settings.captureAppPid > 0 && !apps.some((a) => a.pid === settings.captureAppPid) && (
                <option value={settings.captureAppPid}>{settings.captureAppName || `PID ${settings.captureAppPid}`}</option>
              )}
              {apps.map((a) => (
                <option key={a.pid} value={a.pid}>
                  {a.name}
                </option>
              ))}
            </select>
            <p className="hint">
              Pick the app the other person’s voice plays from. Native apps (Zoom/Teams) get muted
              so you hear only the translation; browsers keep playing.
            </p>
          </div>
        )}

        <div className="engine-row">
          <div className="er-head">
            <span className="er-label">Engine</span>
            <span className="er-cost">{settings.turboMode ? '≈ $1.40/hr' : '≈ $0.12/hr'}</span>
          </div>
          <div className="seg">
            <button
              className={settings.turboMode ? 'on turbo' : ''}
              onClick={() => applyLive({ turboMode: true })}
            >
              ⚡ Turbo (instant)
            </button>
            <button
              className={!settings.turboMode ? 'on' : ''}
              onClick={() => applyLive({ turboMode: false })}
            >
              Standard
            </button>
          </div>
        </div>

        <div className="chips">
          <span className={`chip ${ready ? 'ok' : 'warn'}`}>{ready ? 'Key ✓' : 'Key needed'}</span>
          <span className={`chip ${screenOk ? 'ok' : 'warn'}`}>
            {screenOk ? 'Audio permission ✓' : 'Permission needed'}
          </span>
          <span className="chip">{settings.captureMic ? 'Mic on' : 'Incoming-only'}</span>
        </div>

        {ready && screenOk && settings.captureAppPid ? (
          <button className="primary full" onClick={onStart} disabled={busy}>
            {busy ? 'Starting…' : '● Start translating'}
          </button>
        ) : (
          <button className="ghost-btn" style={{ width: '100%' }} onClick={openSettings}>
            {!ready ? 'Add your key →' : !screenOk ? 'Grant audio permission →' : 'Pick a source app →'}
          </button>
        )}
        <button className="link" style={{ alignSelf: 'center' }} onClick={runDemo}>
          See a demo
        </button>
      </div>
    </main>
  )
}

/* ============================ Onboarding ============================ */
function Onboarding({
  settings,
  perms,
  step,
  setStep,
  applyLive,
  refreshPerms,
  runDemo,
  onDone
}: {
  settings: Settings
  perms: { screen: string; microphone: string }
  step: number
  setStep: (n: number) => void
  applyLive: (p: Partial<Settings>) => void
  refreshPerms: () => void
  runDemo: () => void
  onDone: () => void
}) {
  const TOTAL = 5
  const next = () => setStep(Math.min(TOTAL, step + 1))
  const back = () => setStep(Math.max(0, step - 1))

  return (
    <main className="main">
      <div className="onb">
        <div className="onb-rail">
          {Array.from({ length: TOTAL + 1 }, (_, i) => (
            <span key={i} className={`d ${i <= step ? 'on' : ''}`} />
          ))}
        </div>

        {step === 0 && (
          <>
            <div className="onb-emoji">🌐</div>
            <h1>Live translation for your calls</h1>
            <p className="sub">See and hear the other person in your language — in real time.</p>
            <div className="onb-actions">
              <button className="link" onClick={onDone}>
                Skip setup
              </button>
              <span className="spacer" />
              <button
                className="ghost-btn"
                onClick={() => {
                  runDemo()
                  next()
                }}
              >
                See a demo
              </button>
              <button className="primary" onClick={next}>
                Get started
              </button>
            </div>
          </>
        )}

        {step === 1 && (
          <>
            <h1>Languages</h1>
            <p className="sub">We’ll detect their language and translate to yours.</p>
            <section>
              <label className="field-label">They speak</label>
              <select value={settings.theirLanguage} onChange={(e) => applyLive({ theirLanguage: e.target.value })}>
                <option value="auto">Auto-detect (Korean · Chinese · English)</option>
                <option value="ko">Korean</option>
                <option value="zh">Chinese</option>
                <option value="en">English</option>
              </select>
            </section>
            <section>
              <label className="field-label">I speak</label>
              <select value={settings.myLanguage} onChange={(e) => applyLive({ myLanguage: e.target.value })}>
                <option value="en">English</option>
                <option value="ko">Korean</option>
                <option value="zh">Chinese</option>
              </select>
            </section>
            <label className="toggle">
              <input type="checkbox" checked={settings.captureMic} onChange={(e) => applyLive({ captureMic: e.target.checked })} />
              <span>Also translate me (for two-way, in-person). Off is best for calls and avoids the Bluetooth call-quality drop.</span>
            </label>
            <div className="onb-actions">
              <button className="link" onClick={back}>Back</button>
              <span className="spacer" />
              <button className="primary" onClick={next}>Next</button>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <h1>Choose how it translates</h1>
            <p className="sub">You can switch anytime.</p>
            <button className={`bigcard ${settings.turboMode ? 'sel' : ''}`} onClick={() => applyLive({ turboMode: true })}>
              <div className="bc-title">
                ⚡ Turbo <span className="bc-rec">Easiest</span>
              </div>
              <div className="bc-desc">One key. Instant interpreter voice. ~$1.40/hour.</div>
            </button>
            <button className={`bigcard ${!settings.turboMode ? 'sel' : ''}`} onClick={() => applyLive({ turboMode: false })}>
              <div className="bc-title">Standard</div>
              <div className="bc-desc">Two keys (Soniox + a translator). Cheaper per hour, more control.</div>
            </button>
            <div className="onb-actions">
              <button className="link" onClick={back}>Back</button>
              <span className="spacer" />
              <button className="primary" onClick={next}>Next</button>
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <h1>Permissions</h1>
            <p className="sub">macOS needs your OK to hear the call. Prompts appear in front now.</p>
            <PermissionRow
              icon="🖥️"
              title="Screen & System Audio Recording"
              sub="Lets SuperTranslate hear the other person’s app."
              status={perms.screen}
              onGrant={() => window.api.openScreenSettings()}
              onRefresh={refreshPerms}
              needsRelaunch
            />
            {settings.captureMic && (
              <PermissionRow
                icon="🎙️"
                title="Microphone"
                sub="Only needed because you turned on ‘translate me’."
                status={perms.microphone}
                onGrant={async () => {
                  await window.api.askMicPermission()
                  refreshPerms()
                }}
                onRefresh={refreshPerms}
              />
            )}
            <div className="onb-actions">
              <button className="link" onClick={back}>Back</button>
              <span className="spacer" />
              <button className="primary" onClick={next}>Next</button>
            </div>
          </>
        )}

        {step === 4 && (
          <>
            <h1>Add your key</h1>
            {settings.turboMode ? (
              <section>
                <label className="field-label">Gemini API key</label>
                <input
                  type="password"
                  placeholder="Paste your Gemini key"
                  value={settings.geminiApiKey}
                  onChange={(e) => applyLive({ geminiApiKey: e.target.value.trim() })}
                />
                <button className="link" onClick={() => window.api.openExternal(GEMINI_KEYS_URL)}>
                  Get a Gemini key →
                </button>
                {settings.geminiApiKey && <div className="keyok">Saved ✓ (validated when you Start)</div>}
                <p className="field-why">Gemini turns the other person’s speech directly into a voice in your language.</p>
              </section>
            ) : (
              <>
                <section>
                  <label className="field-label">Soniox key (speech)</label>
                  <input type="password" placeholder="Paste your Soniox key" value={settings.sonioxApiKey} onChange={(e) => applyLive({ sonioxApiKey: e.target.value.trim() })} />
                  <button className="link" onClick={() => window.api.openExternal(SONIOX_KEYS_URL)}>Get a Soniox key →</button>
                </section>
                <section>
                  <label className="field-label">{PROVIDER_LABEL[settings.translateProvider]} key (translation)</label>
                  <input type="password" placeholder={`Paste your ${PROVIDER_LABEL[settings.translateProvider]} key`} value={settings.translateApiKey} onChange={(e) => applyLive({ translateApiKey: e.target.value.trim() })} />
                  <button className="link" onClick={() => window.api.openExternal(KEY_URL[settings.translateProvider])}>Get a {PROVIDER_LABEL[settings.translateProvider]} key →</button>
                </section>
              </>
            )}
            <div className="onb-actions">
              <button className="link" onClick={back}>Back</button>
              <span className="spacer" />
              <button className="primary" onClick={next}>Next</button>
            </div>
          </>
        )}

        {step === 5 && (
          <>
            <div className="onb-emoji">✅</div>
            <h1>You’re ready</h1>
            <p className="sub">Open the call app you’ll use, then start translating from the main screen.</p>
            <div className="onb-actions">
              <button className="link" onClick={back}>Back</button>
              <span className="spacer" />
              <button className="primary" onClick={onDone}>
                Finish
              </button>
            </div>
          </>
        )}
      </div>
    </main>
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
          <button className="b-btn primary" onClick={() => window.api.relaunchApp()}>
            Relaunch to apply
          </button>
        ) : (
          <span className="pstate ok">Granted ✓</span>
        )
      ) : (
        <>
          <button className="ghost-btn" style={{ padding: '6px 10px' }} onClick={() => { onGrant(); setTimeout(onRefresh, 1500) }}>
            Grant
          </button>
        </>
      )}
    </div>
  )
}

/* ============================ Settings ============================ */
function SettingsPanel({
  settings,
  perms,
  applyLive,
  refreshPerms,
  onClose
}: {
  settings: Settings
  perms: { screen: string; microphone: string }
  applyLive: (p: Partial<Settings>) => void
  refreshPerms: () => void
  onClose: () => void
}) {
  const [tab, setTab] = useState<'setup' | 'audio' | 'voice' | 'advanced'>('setup')
  const [apps, setApps] = useState<{ pid: number; name: string }[]>([])
  const refreshApps = useCallback(() => window.api.listApps().then(setApps).catch(() => setApps([])), [])
  useEffect(() => {
    refreshApps()
    refreshPerms()
  }, [refreshApps, refreshPerms])

  return (
    <div className="settings-backdrop" onMouseDown={onClose}>
      <div className="settings" onMouseDown={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <h2>Settings</h2>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>
        <div className="tabs">
          {(['setup', 'audio', 'voice', 'advanced'] as const).map((t) => (
            <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
              {t[0].toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
        <div className="settings-body">
          {tab === 'setup' && (
            <>
              <section className="row">
                <div style={{ flex: 1 }}>
                  <label className="field-label">They speak</label>
                  <select value={settings.theirLanguage} onChange={(e) => applyLive({ theirLanguage: e.target.value })}>
                    <option value="auto">Auto-detect</option>
                    <option value="ko">Korean</option>
                    <option value="zh">Chinese</option>
                    <option value="en">English</option>
                  </select>
                </div>
                <div style={{ flex: 1 }}>
                  <label className="field-label">I speak</label>
                  <select value={settings.myLanguage} onChange={(e) => applyLive({ myLanguage: e.target.value })}>
                    <option value="en">English</option>
                    <option value="ko">Korean</option>
                    <option value="zh">Chinese</option>
                  </select>
                </div>
              </section>
              <section>
                <label className="field-label">Engine</label>
                <div className="seg">
                  <button className={settings.turboMode ? 'on turbo' : ''} onClick={() => applyLive({ turboMode: true })}>⚡ Turbo</button>
                  <button className={!settings.turboMode ? 'on' : ''} onClick={() => applyLive({ turboMode: false })}>Standard</button>
                </div>
              </section>
              {settings.turboMode ? (
                <section>
                  <label className="field-label">Gemini key</label>
                  <input type="password" placeholder="Paste your Gemini key" value={settings.geminiApiKey} onChange={(e) => applyLive({ geminiApiKey: e.target.value.trim() })} />
                  <button className="link" onClick={() => window.api.openExternal(GEMINI_KEYS_URL)}>Get a Gemini key →</button>
                </section>
              ) : (
                <>
                  <section>
                    <label className="field-label">Soniox key (speech)</label>
                    <input type="password" placeholder="Soniox key" value={settings.sonioxApiKey} onChange={(e) => applyLive({ sonioxApiKey: e.target.value.trim() })} />
                    <button className="link" onClick={() => window.api.openExternal(SONIOX_KEYS_URL)}>Get a Soniox key →</button>
                  </section>
                  <section>
                    <label className="field-label">Translation engine</label>
                    <div className="seg">
                      {(['deepseek', 'qwen', 'openrouter'] as Provider[]).map((p) => (
                        <button key={p} className={settings.translateProvider === p ? 'on' : ''} onClick={() => applyLive({ translateProvider: p })}>
                          {PROVIDER_LABEL[p]}
                        </button>
                      ))}
                    </div>
                    <input type="password" placeholder={`${PROVIDER_LABEL[settings.translateProvider]} key`} value={settings.translateApiKey} onChange={(e) => applyLive({ translateApiKey: e.target.value.trim() })} style={{ marginTop: 8 }} />
                    <button className="link" onClick={() => window.api.openExternal(KEY_URL[settings.translateProvider])}>Get a {PROVIDER_LABEL[settings.translateProvider]} key →</button>
                  </section>
                </>
              )}
              <section>
                <label className="field-label">Monthly spending limit (safety cap)</label>
                <div className="row">
                  <span>$</span>
                  <input type="number" min={0} step={1} value={settings.monthlyBudgetUSD} onChange={(e) => applyLive({ monthlyBudgetUSD: Math.max(0, Number(e.target.value)) })} style={{ width: 100 }} />
                  <span className="dim">/ month</span>
                </div>
                <p className="hint">Stops automatically at this limit. 0 = no cap. DeepSeek/Gemini/OpenRouter are prepaid too.</p>
              </section>
            </>
          )}

          {tab === 'audio' && (
            <>
              <section>
                <label className="field-label">Capture audio from (macOS)</label>
                <div className="row">
                  <select
                    value={settings.captureAppPid}
                    onChange={(e) => {
                      const pid = Number(e.target.value)
                      applyLive({ captureAppPid: pid, captureAppName: apps.find((a) => a.pid === pid)?.name ?? '' })
                    }}
                    style={{ flex: 1 }}
                  >
                    <option value={0}>— pick an app —</option>
                    {settings.captureAppPid > 0 && !apps.some((a) => a.pid === settings.captureAppPid) && (
                      <option value={settings.captureAppPid}>{settings.captureAppName || `PID ${settings.captureAppPid}`}</option>
                    )}
                    {apps.map((a) => (
                      <option key={a.pid} value={a.pid}>{a.name}</option>
                    ))}
                  </select>
                  <button className="ghost-btn" onClick={refreshApps} title="Refresh">↻</button>
                </div>
                <p className="hint">Native apps (Zoom/Teams) are muted so you hear only the translation. Browsers keep playing (lower their own volume).</p>
              </section>
              <section>
                <label className="toggle">
                  <input type="checkbox" checked={settings.captureMic} onChange={(e) => applyLive({ captureMic: e.target.checked })} />
                  <span>Translate my microphone (your voice). Off avoids the Bluetooth call-quality drop.</span>
                </label>
              </section>
              <section>
                <label className="field-label">Response speed</label>
                <div className="seg">
                  {(['fast', 'balanced', 'accurate'] as const).map((r) => (
                    <button key={r} className={settings.responseSpeed === r ? 'on' : ''} onClick={() => applyLive({ responseSpeed: r })}>
                      {r[0].toUpperCase() + r.slice(1)}
                    </button>
                  ))}
                </div>
                <p className="hint">Fast = snappier but may split a slow sentence; Accurate = waits for whole sentences.</p>
              </section>
            </>
          )}

          {tab === 'voice' && (
            <>
              <section>
                <label className="toggle">
                  <input type="checkbox" checked={settings.speakAloud} onChange={(e) => applyLive({ speakAloud: e.target.checked })} />
                  <span>Speak the translation aloud (Turbo always speaks)</span>
                </label>
              </section>
              <section>
                <label className="field-label">Voice</label>
                <div className="seg">
                  <button className={settings.ttsEngine === 'system' ? 'on' : ''} onClick={() => applyLive({ ttsEngine: 'system' })}>Built-in (free)</button>
                  <button className={settings.ttsEngine === 'elevenlabs' ? 'on' : ''} onClick={() => applyLive({ ttsEngine: 'elevenlabs' })}>ElevenLabs (HD)</button>
                </div>
                {settings.ttsEngine === 'elevenlabs' && (
                  <>
                    <input type="password" placeholder="ElevenLabs key" value={settings.elevenLabsApiKey} onChange={(e) => applyLive({ elevenLabsApiKey: e.target.value.trim() })} style={{ marginTop: 8 }} />
                    <input type="text" placeholder="Voice ID (optional)" value={settings.elevenLabsVoiceId} onChange={(e) => applyLive({ elevenLabsVoiceId: e.target.value.trim() })} style={{ marginTop: 8 }} />
                    <button className="link" onClick={() => window.api.openExternal('https://elevenlabs.io/app/settings/api-keys')}>Get an ElevenLabs key →</button>
                    <p className="hint">~$0.10 / 1,000 characters. Caps at 1.2× speed.</p>
                  </>
                )}
              </section>
              <section>
                <label className="field-label">Talking speed {settings.ttsRate.toFixed(2)}×</label>
                <input type="range" min={0.8} max={1.6} step={0.05} value={settings.ttsRate} onChange={(e) => applyLive({ ttsRate: Number(e.target.value) })} />
                <p className="hint">Built-in voice up to 1.6×; ElevenLabs caps at 1.2×.</p>
              </section>
              <section>
                <label className="field-label">Voice volume {Math.round(settings.voiceVolume * 100)}%</label>
                <input type="range" min={0} max={1.5} step={0.05} value={settings.voiceVolume} onChange={(e) => applyLive({ voiceVolume: Number(e.target.value) })} />
              </section>
            </>
          )}

          {tab === 'advanced' && (
            <>
              <section>
                <label className="toggle">
                  <input type="checkbox" checked={settings.showOriginal} onChange={(e) => applyLive({ showOriginal: e.target.checked })} />
                  <span>Show the original text under each translation by default</span>
                </label>
              </section>
              <section>
                <label className="field-label">Permissions</label>
                <PermissionRow icon="🖥️" title="Screen & System Audio Recording" sub="Hear the other app." status={perms.screen} onGrant={() => window.api.openScreenSettings()} onRefresh={refreshPerms} needsRelaunch />
                {settings.captureMic && (
                  <PermissionRow icon="🎙️" title="Microphone" sub="For translating your voice." status={perms.microphone} onGrant={async () => { await window.api.askMicPermission(); refreshPerms() }} onRefresh={refreshPerms} />
                )}
              </section>
              <section>
                <label className="field-label">Redo first-run setup</label>
                <button className="ghost-btn" onClick={() => { applyLive({ onboarded: false }); onClose() }}>Show onboarding again</button>
              </section>
              <section>
                <p className="hint">Changes here apply live — no app restart needed. Only granting a new macOS permission needs the one-tap Relaunch above.</p>
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
