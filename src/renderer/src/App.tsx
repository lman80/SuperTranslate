import { useCallback, useEffect, useRef, useState } from 'react'
import { startCapture, type CaptureResult } from './audio'

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
  monthlyBudgetUSD: number
  speakAloud: boolean
  ttsEngine: 'system' | 'elevenlabs'
  elevenLabsApiKey: string
  elevenLabsVoiceId: string
}

interface UsageState {
  spent: number
  budget: number
  month: string
}

const PROVIDER_LABEL: Record<Provider, string> = {
  deepseek: 'DeepSeek',
  qwen: 'Qwen',
  openrouter: 'OpenRouter'
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
}

const LANG_LABEL: Record<string, string> = {
  en: 'English',
  ko: 'Korean',
  zh: 'Chinese',
  auto: 'Auto-detect'
}

const SONIOX_KEYS_URL = 'https://console.soniox.com'
const KEY_URL: Record<Provider, string> = {
  deepseek: 'https://platform.deepseek.com/api_keys',
  qwen: 'https://bailian.console.alibabacloud.com/?tab=model#/api-key',
  openrouter: 'https://openrouter.ai/keys'
}

function speakerName(source: Source): string {
  return source === 'mic' ? 'You' : 'Them'
}

export default function App() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [running, setRunning] = useState(false)
  const [busy, setBusy] = useState(false)
  const [pinned, setPinned] = useState(true)
  const [entries, setEntries] = useState<Entry[]>([])
  const [partial, setPartial] = useState<{ mic: string; system: string }>({ mic: '', system: '' })
  const [toast, setToast] = useState<string>('')
  const [usage, setUsage] = useState<UsageState | null>(null)

  const captureRef = useRef<CaptureResult | null>(null)
  const feedRef = useRef<HTMLDivElement | null>(null)
  const atBottomRef = useRef(true)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const settingsRef = useRef<Settings | null>(null)
  const voicesRef = useRef<SpeechSynthesisVoice[]>([])
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null)

  // Keep a ref of settings so event handlers (registered once) read fresh values.
  useEffect(() => {
    settingsRef.current = settings
  }, [settings])

  // Load system TTS voices (Electron returns [] until 'voiceschanged' fires).
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

  const speak = useCallback((text: string, lang: string) => {
    if (!text || !window.speechSynthesis) return
    const code = lang === 'zh' ? 'zh-CN' : lang === 'ko' ? 'ko-KR' : lang === 'en' ? 'en-US' : lang
    const base = code.split('-')[0]
    const utter = new SpeechSynthesisUtterance(text)
    utter.lang = code
    utter.rate = 1.02
    const voice =
      voicesRef.current.find((v) => v.lang === code) ??
      voicesRef.current.find((v) => v.lang.startsWith(base))
    if (voice) utter.voice = voice
    try {
      window.speechSynthesis.cancel()
    } catch {
      /* ignore */
    }
    window.speechSynthesis.speak(utter)
  }, [])

  const flash = useCallback((msg: string) => {
    setToast(msg)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(''), 6000)
  }, [])

  // Load settings + current spend once.
  useEffect(() => {
    window.api.getSettings().then((s) => {
      setSettings(s as Settings)
      if (!(s as Settings).sonioxApiKey) setShowSettings(true)
    })
    window.api.getUsage().then((u) => setUsage(u as UsageState))
  }, [])

  // Subscribe to caption + status events.
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
            targetLang: p.targetLang
          }
        ].slice(-120)
      )
      setPartial((prev) => ({ ...prev, [p.source]: '' }))
    })
    const offTranslation = window.api.onTranslation(
      ({ id, translation, note, error, final, source, targetLang }) => {
        setEntries((prev) =>
          prev.map((e) => (e.id === id ? { ...e, translation, note, error } : e))
        )
        // Free local voice path. (ElevenLabs audio arrives via onTtsPlay from main.)
        if (
          final &&
          translation &&
          source === 'system' &&
          settingsRef.current?.speakAloud &&
          settingsRef.current?.ttsEngine !== 'elevenlabs'
        ) {
          speak(translation, targetLang || settingsRef.current?.myLanguage || 'en')
        }
      }
    )
    const offTts = window.api.onTtsPlay(({ audioBase64, mime }) => {
      try {
        ttsAudioRef.current?.pause()
        const audio = new Audio(`data:${mime};base64,${audioBase64}`)
        ttsAudioRef.current = audio
        void audio.play().catch(() => undefined)
      } catch {
        /* ignore */
      }
    })
    const offError = window.api.onError(({ message }) => flash(message))
    const offUsage = window.api.onUsage((u) => setUsage(u))
    const offBudget = window.api.onBudget((b) => {
      if (b.reached) {
        captureRef.current?.stop()
        captureRef.current = null
        setRunning(false)
        setPartial({ mic: '', system: '' })
        flash(
          `Monthly budget of $${b.budget.toFixed(2)} reached — translation paused. Raise it in Settings to continue.`
        )
      } else if (b.warning) {
        flash(
          `Heads up: about $${b.spent.toFixed(2)} of your $${b.budget.toFixed(2)} monthly budget used.`
        )
      }
    })
    return () => {
      offPartial()
      offFinal()
      offTranslation()
      offError()
      offUsage()
      offBudget()
      offTts()
    }
  }, [flash, speak])

  // Auto-scroll the feed only when the user is already at the bottom, so scrolling
  // up to re-read isn't interrupted every time someone speaks.
  useEffect(() => {
    const el = feedRef.current
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight
  }, [entries, partial])

  const handleFeedScroll = useCallback(() => {
    const el = feedRef.current
    if (!el) return
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
  }, [])

  const start = useCallback(async () => {
    if (!settings) return
    if (!settings.sonioxApiKey) {
      setShowSettings(true)
      flash('Add your Soniox API key to start.')
      return
    }
    setBusy(true)
    try {
      await window.api.startCapture()
      captureRef.current = await startCapture({
        captureSystemAudio: settings.captureSystemAudio,
        onWarning: flash
      })
      setRunning(true)
    } catch (e) {
      flash((e as Error).message)
      await window.api.stopCapture().catch(() => undefined)
    } finally {
      setBusy(false)
    }
  }, [settings, flash])

  const stop = useCallback(async () => {
    captureRef.current?.stop()
    captureRef.current = null
    try {
      window.speechSynthesis?.cancel()
      ttsAudioRef.current?.pause()
      ttsAudioRef.current = null
    } catch {
      /* ignore */
    }
    await window.api.stopCapture().catch(() => undefined)
    setRunning(false)
    setPartial({ mic: '', system: '' })
  }, [])

  const runDemo = useCallback(() => {
    const demo: Entry[] = [
      {
        id: 'demo1',
        source: 'system',
        original: '안녕하세요, 만나서 반갑습니다. 오늘 회의 자료 준비되셨나요?',
        translation: 'Hello, nice to meet you. Did you get the materials for today’s meeting ready?',
        sourceLang: 'ko',
        targetLang: 'en'
      },
      {
        id: 'demo2',
        source: 'mic',
        original: 'Yes, I just sent the slides over. Let me know if the numbers look right.',
        translation: '네, 방금 슬라이드를 보냈습니다. 수치가 맞는지 확인해 주세요.',
        sourceLang: 'en',
        targetLang: 'ko'
      },
      {
        id: 'demo3',
        source: 'system',
        original: '感谢您的配合，我们下周可以正式签合同。',
        translation: 'Thank you for your cooperation — we can formally sign the contract next week.',
        sourceLang: 'zh',
        targetLang: 'en'
      }
    ]
    setEntries(demo)
  }, [])

  const togglePin = useCallback(() => {
    const next = !pinned
    setPinned(next)
    window.api.windowControl(next ? 'pin' : 'unpin')
  }, [pinned])

  const saveSettings = useCallback(async (next: Settings) => {
    const saved = (await window.api.saveSettings(next)) as Settings
    setSettings(saved)
    setShowSettings(false)
  }, [])

  if (!settings) return <div className="boot">Loading…</div>

  const fontScale = settings.fontScale || 1

  return (
    <div className="app" style={{ ['--font-scale' as string]: String(fontScale) }}>
      <header className="titlebar">
        <div className="brand">
          <span className={`dot ${running ? 'live' : ''}`} />
          <span className="title">SuperTranslate</span>
        </div>
        <div className="win-controls">
          <button className="icon-btn" title="Settings" onClick={() => setShowSettings(true)}>
            ⚙
          </button>
          <button
            className={`icon-btn ${pinned ? 'active' : ''}`}
            title={pinned ? 'Unpin (allow other windows on top)' : 'Pin on top'}
            onClick={togglePin}
          >
            ⤢
          </button>
          <button
            className="icon-btn"
            title="Minimize"
            onClick={() => window.api.windowControl('minimize')}
          >
            –
          </button>
          <button
            className="icon-btn close"
            title="Close"
            onClick={() => window.api.windowControl('close')}
          >
            ✕
          </button>
        </div>
      </header>

      <div className="langbar">
        <span className="chip">You · {LANG_LABEL[settings.myLanguage] ?? settings.myLanguage}</span>
        <span className="arrows">⇄</span>
        <span className="chip them">
          Them · {LANG_LABEL[settings.theirLanguage] ?? settings.theirLanguage}
        </span>
      </div>

      <main className="feed" ref={feedRef} onScroll={handleFeedScroll}>
        {entries.length === 0 && !partial.mic && !partial.system ? (
          <div className="empty">
            <div className="empty-emoji">🌐</div>
            <h2>Live translation, both ways</h2>
            <p>
              Press <b>Start</b> and just talk. What you say and what the other person says will
              appear here in both languages.
            </p>
            <button className="ghost-btn" onClick={runDemo}>
              See a demo
            </button>
          </div>
        ) : (
          <>
            {entries.map((e) => (
              <div key={e.id} className={`bubble ${e.source}`}>
                <div className="bubble-head">
                  <span className="who">{speakerName(e.source)}</span>
                  <span className="lang">
                    {(LANG_LABEL[e.sourceLang] ?? e.sourceLang) +
                      ' → ' +
                      (LANG_LABEL[e.targetLang] ?? e.targetLang)}
                  </span>
                </div>
                <div className="translation">
                  {e.translation ? (
                    e.translation
                  ) : e.error ? (
                    <span className="err">{e.error}</span>
                  ) : e.note ? (
                    <span className="muted">{e.note}</span>
                  ) : (
                    <span className="typing">
                      <i /> <i /> <i />
                    </span>
                  )}
                </div>
                {settings.showOriginal && <div className="original">{e.original}</div>}
              </div>
            ))}
            {(['system', 'mic'] as Source[]).map((src) =>
              partial[src] ? (
                <div key={`p-${src}`} className={`bubble ${src} partial`}>
                  <div className="bubble-head">
                    <span className="who">{speakerName(src)}</span>
                    <span className="lang">listening…</span>
                  </div>
                  <div className="original live">{partial[src]}</div>
                </div>
              ) : null
            )}
          </>
        )}
      </main>

      {usage && (
        <div className="usage" title="Estimated spend this month. Capture auto-stops at your budget.">
          <div className="usage-bar">
            <div
              className={`usage-fill ${usage.budget > 0 && usage.spent / usage.budget >= 0.8 ? 'hot' : ''}`}
              style={{
                width: `${usage.budget > 0 ? Math.min(100, (usage.spent / usage.budget) * 100) : 0}%`
              }}
            />
          </div>
          <span className="usage-text">
            ≈ ${usage.spent.toFixed(2)}
            {usage.budget > 0 ? ` / $${usage.budget.toFixed(2)}` : ' (no cap)'} this month
          </span>
        </div>
      )}

      <footer className="controls">
        {running ? (
          <button className="primary stop" onClick={stop}>
            ◼ Stop
          </button>
        ) : (
          <button className="primary" onClick={start} disabled={busy}>
            {busy ? 'Starting…' : '● Start'}
          </button>
        )}
      </footer>

      {toast && <div className="toast">{toast}</div>}

      {showSettings && (
        <SettingsPanel
          initial={settings}
          onCancel={() => setShowSettings(false)}
          onSave={saveSettings}
        />
      )}
    </div>
  )
}

function SettingsPanel({
  initial,
  onCancel,
  onSave
}: {
  initial: Settings
  onCancel: () => void
  onSave: (s: Settings) => void
}) {
  const [s, setS] = useState<Settings>(initial)
  const set = <K extends keyof Settings>(k: K, v: Settings[K]): void =>
    setS((prev) => ({ ...prev, [k]: v }))

  const providerLabel = PROVIDER_LABEL[s.translateProvider]
  const translateKeyUrl = KEY_URL[s.translateProvider]

  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <h2>Settings</h2>

        <section>
          <label className="field-label">
            Soniox API key <span className="req">(speech recognition)</span>
          </label>
          <input
            type="password"
            placeholder="Paste your Soniox key"
            value={s.sonioxApiKey}
            onChange={(e) => set('sonioxApiKey', e.target.value)}
          />
          <button className="link" onClick={() => window.api.openExternal(SONIOX_KEYS_URL)}>
            Get a Soniox key →
          </button>
        </section>

        <section>
          <label className="field-label">Translation engine</label>
          <div className="seg">
            {(['deepseek', 'qwen', 'openrouter'] as Provider[]).map((p) => (
              <button
                key={p}
                className={s.translateProvider === p ? 'on' : ''}
                onClick={() => set('translateProvider', p)}
              >
                {PROVIDER_LABEL[p]}
              </button>
            ))}
          </div>
          <input
            type="password"
            placeholder={`Paste your ${providerLabel} key`}
            value={s.translateApiKey}
            onChange={(e) => set('translateApiKey', e.target.value)}
          />
          <button className="link" onClick={() => window.api.openExternal(translateKeyUrl)}>
            Get a {providerLabel} key →
          </button>
        </section>

        <section className="row">
          <div className="col">
            <label className="field-label">You speak</label>
            <select value={s.myLanguage} onChange={(e) => set('myLanguage', e.target.value)}>
              <option value="en">English</option>
              <option value="ko">Korean</option>
              <option value="zh">Chinese</option>
            </select>
          </div>
          <div className="col">
            <label className="field-label">They speak</label>
            <select value={s.theirLanguage} onChange={(e) => set('theirLanguage', e.target.value)}>
              <option value="ko">Korean</option>
              <option value="zh">Chinese</option>
              <option value="en">English</option>
              <option value="auto">Auto-detect</option>
            </select>
          </div>
        </section>

        <section className="toggles">
          <label className="toggle">
            <input
              type="checkbox"
              checked={s.captureSystemAudio}
              onChange={(e) => set('captureSystemAudio', e.target.checked)}
            />
            <span>Capture the other person’s voice from this computer (calls)</span>
          </label>
          <label className="toggle">
            <input
              type="checkbox"
              checked={s.showOriginal}
              onChange={(e) => set('showOriginal', e.target.checked)}
            />
            <span>Show original text under each translation</span>
          </label>
          <label className="toggle">
            <input
              type="checkbox"
              checked={s.speakAloud}
              onChange={(e) => set('speakAloud', e.target.checked)}
            />
            <span>Speak the other person’s translation aloud (great for calls)</span>
          </label>
        </section>

        {s.speakAloud && (
          <section>
            <label className="field-label">Voice</label>
            <div className="seg">
              <button
                className={s.ttsEngine === 'system' ? 'on' : ''}
                onClick={() => set('ttsEngine', 'system')}
              >
                Built-in (free)
              </button>
              <button
                className={s.ttsEngine === 'elevenlabs' ? 'on' : ''}
                onClick={() => set('ttsEngine', 'elevenlabs')}
              >
                ElevenLabs (HD)
              </button>
            </div>
            {s.ttsEngine === 'elevenlabs' && (
              <>
                <input
                  type="password"
                  placeholder="Paste your ElevenLabs key"
                  value={s.elevenLabsApiKey}
                  onChange={(e) => set('elevenLabsApiKey', e.target.value)}
                />
                <input
                  type="text"
                  placeholder="Voice ID (optional — blank = default voice)"
                  value={s.elevenLabsVoiceId}
                  onChange={(e) => set('elevenLabsVoiceId', e.target.value)}
                />
                <button
                  className="link"
                  onClick={() => window.api.openExternal('https://elevenlabs.io/app/settings/api-keys')}
                >
                  Get an ElevenLabs key →
                </button>
                <p className="hint">
                  HD voices use credits (~$0.10 / 1,000 characters). Your monthly cap still applies.
                </p>
              </>
            )}
          </section>
        )}

        <section>
          <label className="field-label">
            Monthly spending limit <span className="req">(safety cap)</span>
          </label>
          <div className="budget-row">
            <span className="dollar">$</span>
            <input
              type="number"
              min={0}
              step={1}
              value={s.monthlyBudgetUSD}
              onChange={(e) => set('monthlyBudgetUSD', Math.max(0, Number(e.target.value)))}
            />
            <span className="per">/ month</span>
          </div>
          <p className="hint">
            The app stops automatically when this month’s estimated spend hits this. Set 0 for no
            cap. (DeepSeek &amp; OpenRouter are also prepaid — they can’t bill beyond what you load.)
          </p>
        </section>

        <section>
          <label className="field-label">Text size</label>
          <input
            type="range"
            min={0.85}
            max={1.6}
            step={0.05}
            value={s.fontScale}
            onChange={(e) => set('fontScale', Number(e.target.value))}
          />
        </section>

        <div className="modal-actions">
          <button className="ghost-btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="primary" onClick={() => onSave(s)}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
