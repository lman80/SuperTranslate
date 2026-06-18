import {
  app,
  BrowserWindow,
  screen,
  session,
  desktopCapturer,
  ipcMain,
  shell,
  systemPreferences
} from 'electron'
import { join } from 'path'
import { appendFileSync, writeFileSync } from 'fs'
import { loadSettings, saveSettings, type Settings, type Provider, type Dock } from './settings'
import { SonioxSession } from './soniox'
import { GeminiLiveSession } from './geminiLive'
import { MacSystemTap, listRunningApps } from './systemAudioMac'
import { translateStream } from './translate'
import { elevenLabsTts } from './tts'
import { getUsage, addStt, addTranslate, addTts, totalUsd } from './usage'

type Source = 'mic' | 'system'

// Cost estimates used for the in-app spend cap (kept slightly conservative so we
// never undercount). STT = Soniox real-time ($0.12/hr per stream). Translation
// rates are per 1M tokens (input/output) and use the API's reported token counts.
const SONIOX_USD_PER_MIN = 0.12 / 60
const ELEVENLABS_USD_PER_MCHAR = 100 // ≈ $0.10 per 1k characters (conservative)
const GEMINI_TURBO_USD_PER_MIN = 0.023 // Gemini 3.5 Live Translate, all-in
const ACCRUAL_SECONDS = 5
// How long Soniox waits after a pause before finalizing a sentence.
// Lower = snappier but splits sentences more; higher = fewer splits but more lag.
const ENDPOINT_DELAY_MS: Record<Settings['responseSpeed'], number> = {
  fast: 600,
  balanced: 1000,
  accurate: 1600
}
const TRANSLATE_RATES: Record<Provider, { in: number; out: number }> = {
  deepseek: { in: 0.3, out: 1.2 },
  qwen: { in: 0.4, out: 1.2 },
  openrouter: { in: 0.5, out: 1.5 }
}

let win: BrowserWindow | null = null
const sessions: Record<Source, SonioxSession | GeminiLiveSession | null> = { mic: null, system: null }
let systemIsGemini = false
let geminiFinalizeTimer: ReturnType<typeof setTimeout> | null = null
let macTap: MacSystemTap | null = null
let lastLevelSent = 0
let running = false
let activeSettings: Settings | null = null
let accrualTimer: ReturnType<typeof setInterval> | null = null
let warned80 = false

function send(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

// Lightweight debug log to userData/debug.log for diagnosing the capture→STT path.
function logPath(): string {
  return join(app.getPath('userData'), 'debug.log')
}
function dbg(msg: string): void {
  try {
    appendFileSync(logPath(), `${new Date().toISOString()} ${msg}\n`)
  } catch {
    /* ignore */
  }
}
const chunkCounts: Record<Source, number> = { mic: 0, system: 0 }

// ---- Overlay window sizing/positioning ----
// The window is a compact caption overlay that MORPHS between modes; the main process
// owns all sizing so the window is never bigger than the current mode needs.
type WinMode = 'firstrun' | 'setup' | 'idle' | 'idle-menu' | 'live-collapsed' | 'live-expanded'
const MODE_SIZE: Record<WinMode, { w: number; h: number }> = {
  firstrun: { w: 460, h: 320 },
  setup: { w: 460, h: 600 },
  idle: { w: 400, h: 56 },
  'idle-menu': { w: 400, h: 248 }, // idle pill + an open popover (language / app / engine)
  'live-collapsed': { w: 600, h: 150 },
  'live-expanded': { w: 600, h: 400 }
}
const BAR_MODES = new Set<WinMode>([
  'idle',
  'idle-menu',
  'live-collapsed',
  'live-expanded'
])
let currentMode: WinMode = 'idle'
let currentDock: Dock = 'top-center'
let freeBounds: Settings['overlayBounds']
let bootDisplayId: number | undefined // last-used display, applied before the window exists
let suppressMovedUntil = 0
let movedTimer: ReturnType<typeof setTimeout> | null = null

function activeWorkArea(): Electron.Rectangle {
  try {
    if (win && !win.isDestroyed()) {
      const b = win.getBounds()
      return screen.getDisplayNearestPoint({ x: b.x + b.width / 2, y: b.y + b.height / 2 }).workArea
    }
    // Before the window exists (boot), restore onto the last-used display if it's still attached.
    if (bootDisplayId != null) {
      const d = screen.getAllDisplays().find((x) => x.id === bootDisplayId)
      if (d) return d.workArea
    }
  } catch {
    /* fall through */
  }
  return screen.getPrimaryDisplay().workArea
}

function sizeFor(mode: WinMode): { w: number; h: number } {
  const wa = activeWorkArea()
  const base = MODE_SIZE[mode]
  // Live height is clamped to the display so a short external screen can't push it off.
  const h = BAR_MODES.has(mode) ? Math.min(base.h, wa.height - 24) : base.h
  return { w: base.w, h }
}

function boundsFor(mode: WinMode, dock: Dock): Electron.Rectangle {
  const { w, h } = sizeFor(mode)
  const wa = activeWorkArea()
  // Free drag: keep the user's top-left anchor, clamped on-screen; grows down/right.
  if (dock === 'free') {
    const saved = freeBounds
    const x = saved ? Math.min(Math.max(saved.x, wa.x), wa.x + wa.width - w) : wa.x + (wa.width - w) / 2
    const y = saved ? Math.min(Math.max(saved.y, wa.y), wa.y + wa.height - h) : wa.y + 8
    return { x: Math.round(x), y: Math.round(y), width: w, height: h }
  }
  const TOP = wa.y + 8
  const LEFT = wa.x + 12
  const RIGHT = wa.x + wa.width - w - 12
  const CENTER = wa.x + (wa.width - w) / 2
  const BOTTOM = wa.y + wa.height - h - 16
  const pos: Record<Exclude<Dock, 'free'>, { x: number; y: number }> = {
    'top-center': { x: CENTER, y: TOP },
    'top-left': { x: LEFT, y: TOP },
    'top-right': { x: RIGHT, y: TOP },
    'bottom-center': { x: CENTER, y: BOTTOM }
  }
  const p = pos[dock]
  return { x: Math.round(p.x), y: Math.round(p.y), width: w, height: h }
}

// Resize/reposition the window for a mode. Animate only within the bar family
// (idle <-> live <-> expanded); snap for setup/firstrun to avoid transparent-window flicker.
function applyMode(mode: WinMode): void {
  if (!win || win.isDestroyed()) return
  const animate = BAR_MODES.has(mode) && BAR_MODES.has(currentMode)
  currentMode = mode
  const b = boundsFor(mode, currentDock)
  suppressMovedUntil = Date.now() + 450
  win.setBounds(b, animate)
  // NOTE: in 'free' dock we deliberately do NOT overwrite freeBounds here. boundsFor()
  // re-derives from the user's stored anchor and clamps for the current size each time,
  // so resizing near a screen edge can't ratchet the saved position. Only a real user
  // drag (the 'moved' handler) updates freeBounds.
}

function applyDock(dock: Dock): void {
  if (!win || win.isDestroyed()) return
  currentDock = dock
  void saveSettings({ dock })
  const b = boundsFor(currentMode, dock)
  suppressMovedUntil = Date.now() + 450
  win.setBounds(b, true)
  send('window:dock', { dock })
}

function createWindow(boot: { mode: WinMode; dock: Dock }): void {
  currentMode = boot.mode
  currentDock = boot.dock
  const initial = boundsFor(boot.mode, boot.dock)
  win = new BrowserWindow({
    ...initial,
    minWidth: 300,
    minHeight: 52,
    resizable: false,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  // 'floating' keeps us above normal app windows but BELOW macOS system dialogs/
  // permission prompts (so they're not hidden underneath us). 'screen-saver' covered them.
  win.setAlwaysOnTop(true, 'floating')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.once('ready-to-show', () => win?.show())

  // Persist a user drag as a 'free' position (CSS app-region drag doesn't report
  // coords to JS, so we listen here). Ignore the moves we trigger programmatically.
  win.on('moved', () => {
    if (Date.now() < suppressMovedUntil || !win || win.isDestroyed()) return
    if (movedTimer) clearTimeout(movedTimer)
    movedTimer = setTimeout(() => {
      if (!win || win.isDestroyed()) return
      const b = win.getBounds()
      // A macOS bounds animation can emit trailing 'moved' events past the suppress
      // window. If we've landed exactly where the current dock wants us, this was a
      // programmatic move, NOT a user drag — don't flip the dock to 'free'.
      if (currentDock !== 'free') {
        const want = boundsFor(currentMode, currentDock)
        if (Math.abs(b.x - want.x) < 6 && Math.abs(b.y - want.y) < 6) return
      }
      const disp = screen.getDisplayNearestPoint({ x: b.x + b.width / 2, y: b.y + b.height / 2 })
      currentDock = 'free'
      freeBounds = b
      void saveSettings({ dock: 'free', overlayBounds: b, displayId: disp.id })
      send('window:dock', { dock: 'free' })
    }, 250)
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function stopSession(source: Source): void {
  sessions[source]?.stop()
  sessions[source] = null
  if (source === 'system') {
    systemIsGemini = false
    if (geminiFinalizeTimer) {
      clearTimeout(geminiFinalizeTimer)
      geminiFinalizeTimer = null
    }
  }
}

// Gemini sends transcript text that can be incremental, cumulative, OR a repeat.
// Merge robustly so we never duplicate (which looked like "looping").
function mergeTranscript(buf: string, delta: string): string {
  if (!delta) return buf
  if (!buf) return delta
  if (delta.startsWith(buf)) return delta // cumulative
  if (buf.endsWith(delta)) return buf // duplicate piece
  return buf + delta // incremental
}

// Collapse consecutive duplicate phrases (split on CJK/Latin punctuation), which is
// how Gemini's streaming transcript "loops."
function collapseRepeats(s: string): string {
  const parts = s.split(/(?<=[,，。.!?！？、])/)
  const out: string[] = []
  for (const p of parts) {
    if (out.length && out[out.length - 1].trim() === p.trim() && p.trim()) continue
    out.push(p)
  }
  return out.join('')
}

// Show only the recent tail so a long/looping line never becomes a wall of text.
function capTail(s: string, n: number): string {
  return s.length > n ? '…' + s.slice(-n) : s
}

// Real-time speech-to-speech for the other person via Gemini Live Translate.
function startGeminiSystemSession(s: Settings): void {
  const targetLang = s.myLanguage === 'auto' ? 'en' : s.myLanguage
  dbg(`gemini start target=${targetLang}`)
  let orig = ''
  let trans = ''
  let turnSeq = 0

  const finalizeTurn = (): void => {
    if (geminiFinalizeTimer) {
      clearTimeout(geminiFinalizeTimer)
      geminiFinalizeTimer = null
    }
    const o = collapseRepeats(orig).trim()
    const tr = collapseRepeats(trans).trim()
    orig = ''
    trans = ''
    send('caption:partial', { source: 'system', text: '' })
    if (o || tr) {
      const id = `turbo-${Date.now()}-${turnSeq++}`
      send('caption:final', { id, source: 'system', original: o, sourceLang: s.theirLanguage, targetLang })
      send('caption:translation', { id, translation: tr, final: true, source: 'system', targetLang })
    }
  }
  // End the line after a short pause even if Gemini doesn't send turnComplete.
  const scheduleFinalize = (): void => {
    if (geminiFinalizeTimer) clearTimeout(geminiFinalizeTimer)
    geminiFinalizeTimer = setTimeout(finalizeTurn, 1200)
  }
  // Live line prefers the ENGLISH translation (what the user wants to read), falling
  // back to the original until the translation catches up. Capped so it can't grow.
  const sendLive = (): void => {
    const live = collapseRepeats((trans || orig).trim())
    send('caption:partial', { source: 'system', text: capTail(live, 160) })
  }
  // Hard cap: commit and reset before the buffer can balloon into a loop.
  const maybeForceFinalize = (): void => {
    if (trans.length > 200 || orig.length > 280) finalizeTurn()
  }

  const gem = new GeminiLiveSession(
    { apiKey: s.geminiApiKey, targetLanguageCode: targetLang },
    {
      onStatus: (status, detail) => {
        dbg(`gemini status=${status} ${detail ?? ''}`)
        send('status', { source: 'system', status })
      },
      onError: (message) => {
        dbg(`gemini ERROR ${message}`)
        send('error', { source: 'system', message })
      },
      onOriginal: (t) => {
        orig = mergeTranscript(orig, t)
        sendLive()
        scheduleFinalize()
        maybeForceFinalize()
      },
      onTranslated: (t) => {
        trans = mergeTranscript(trans, t)
        sendLive()
        scheduleFinalize()
        maybeForceFinalize()
      },
      onAudio: (b64) => send('turbo:audio', { data: b64 }),
      onTurnComplete: () => {
        dbg('gemini turnComplete')
        finalizeTurn()
      }
    }
  )
  sessions.system = gem
  systemIsGemini = true
  void gem.start()
}

function startSession(source: Source, s: Settings): void {
  stopSession(source)
  dbg(`startSession source=${source} turbo=${s.turboMode} hasGemini=${!!s.geminiApiKey}`)

  // Turbo: the other person's channel goes through Gemini real-time speech-to-speech.
  if (source === 'system' && s.turboMode && s.geminiApiKey) {
    startGeminiSystemSession(s)
    return
  }

  const languageHints =
    source === 'mic'
      ? [s.myLanguage]
      : s.theirLanguage === 'auto'
        ? ['ko', 'zh', 'en']
        : [s.theirLanguage]

  const sourceFixedLang = source === 'mic' ? s.myLanguage : s.theirLanguage
  const targetLang = source === 'mic' ? s.theirLanguage : s.myLanguage

  const sess = new SonioxSession(
    {
      apiKey: s.sonioxApiKey,
      languageHints: languageHints.filter(Boolean),
      endpointDelayMs: ENDPOINT_DELAY_MS[s.responseSpeed] ?? 1000
    },
    {
      onStatus: (status) => {
        dbg(`soniox ${source} status=${status}`)
        send('status', { source, status })
      },
      onError: (message) => {
        dbg(`soniox ${source} ERROR ${message}`)
        send('error', { source, message })
      },
      onPartial: (text) => {
        dbg(`soniox ${source} partial="${text.slice(0, 40)}"`)
        send('caption:partial', { source, text })
      },
      onFinal: async (text, detectedLang) => {
        dbg(`soniox ${source} FINAL="${text.slice(0, 60)}" lang=${detectedLang}`)
        const id = `${source}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
        const sourceLang = sourceFixedLang === 'auto' ? detectedLang || 'auto' : sourceFixedLang
        const finalTarget = targetLang === 'auto' ? 'en' : targetLang

        send('caption:final', { id, source, original: text, sourceLang, targetLang: finalTarget })

        if (!s.translateApiKey) {
          send('caption:translation', {
            id,
            translation: '',
            note: 'Add a translation API key in Settings to see translations.'
          })
          return
        }
        try {
          const result = await translateStream(
            {
              provider: s.translateProvider,
              apiKey: s.translateApiKey,
              text,
              sourceLang,
              targetLang: finalTarget
            },
            (accumulated) =>
              send('caption:translation', { id, translation: accumulated, final: false })
          )
          send('caption:translation', {
            id,
            translation: result.text,
            final: true,
            source,
            targetLang: finalTarget
          })

          const rate = TRANSLATE_RATES[s.translateProvider]
          const cost = (result.inputTokens / 1e6) * rate.in + (result.outputTokens / 1e6) * rate.out
          await addTranslate(cost)
          await emitUsage()
          await checkBudget()

          // Premium voice: generate ElevenLabs audio for the other person's line.
          if (
            s.speakAloud &&
            source === 'system' &&
            s.ttsEngine === 'elevenlabs' &&
            s.elevenLabsApiKey &&
            result.text
          ) {
            try {
              const audio = await elevenLabsTts({
                apiKey: s.elevenLabsApiKey,
                voiceId: s.elevenLabsVoiceId,
                text: result.text,
                speed: s.ttsRate
              })
              send('tts:play', { id, audioBase64: audio.audioBase64, mime: audio.mime })
              await addTts((audio.chars / 1e6) * ELEVENLABS_USD_PER_MCHAR)
              await emitUsage()
              await checkBudget()
            } catch (e) {
              send('error', { source, message: `Voice failed — ${(e as Error).message}` })
            }
          }
        } catch (e) {
          send('caption:translation', {
            id,
            translation: '',
            error: `Translation failed — ${(e as Error).message}`
          })
        }
      }
    }
  )
  sess.start()
  sessions[source] = sess
}

async function emitUsage(): Promise<void> {
  const u = await getUsage()
  const budget = activeSettings?.monthlyBudgetUSD ?? (await loadSettings()).monthlyBudgetUSD
  send('usage', { spent: totalUsd(u), budget, month: u.month })
}

async function checkBudget(): Promise<void> {
  if (!activeSettings) return
  const budget = activeSettings.monthlyBudgetUSD
  if (budget <= 0) return // 0 = no cap
  const spent = totalUsd(await getUsage())
  if (spent >= budget) {
    await stopAll()
    send('budget', { reached: true, spent, budget })
  } else if (!warned80 && spent >= budget * 0.8) {
    warned80 = true
    send('budget', { reached: false, warning: true, spent, budget })
  }
}

function startAccrual(): void {
  stopAccrual()
  accrualTimer = setInterval(async () => {
    const dtMin = ACCRUAL_SECONDS / 60
    let usd = 0
    if (sessions.mic) usd += SONIOX_USD_PER_MIN * dtMin
    if (sessions.system) {
      usd += (systemIsGemini ? GEMINI_TURBO_USD_PER_MIN : SONIOX_USD_PER_MIN) * dtMin
    }
    if (usd > 0) await addStt(usd)
    await emitUsage()
    await checkBudget()
  }, ACCRUAL_SECONDS * 1000)
}

function stopAccrual(): void {
  if (accrualTimer) {
    clearInterval(accrualTimer)
    accrualTimer = null
  }
}

async function stopAll(): Promise<void> {
  macTap?.stop()
  macTap = null
  stopSession('mic')
  stopSession('system')
  stopAccrual()
  running = false
  await emitUsage()
  activeSettings = null
}

// ---- IPC ----

ipcMain.handle('settings:get', () => loadSettings())
ipcMain.handle('settings:save', (_e, patch: Partial<Settings>) => saveSettings(patch))

ipcMain.handle('usage:get', async () => {
  const u = await getUsage()
  const s = await loadSettings()
  return { spent: totalUsd(u), budget: s.monthlyBudgetUSD, month: u.month }
})

ipcMain.handle('capture:start', async () => {
  const s = await loadSettings()
  // Mode-aware key check (mirrors the renderer's engineReady): Turbo needs only Gemini.
  if (s.turboMode) {
    if (!s.geminiApiKey) throw new Error('Add your Gemini API key in Settings first.')
  } else if (!s.sonioxApiKey) {
    throw new Error('Add your Soniox API key in Settings first.')
  }
  if (s.monthlyBudgetUSD > 0 && totalUsd(await getUsage()) >= s.monthlyBudgetUSD) {
    throw new Error('Monthly budget reached. Raise it in Settings to keep going.')
  }
  try {
    writeFileSync(logPath(), '') // fresh log each session
  } catch {
    /* ignore */
  }
  chunkCounts.mic = 0
  chunkCounts.system = 0
  dbg(
    `capture:start turbo=${s.turboMode} captureSystem=${s.captureSystemAudio} their=${s.theirLanguage} my=${s.myLanguage} provider=${s.translateProvider} hasSoniox=${!!s.sonioxApiKey} hasTranslate=${!!s.translateApiKey} hasGemini=${!!s.geminiApiKey}`
  )
  activeSettings = s
  running = true
  warned80 = false
  startAccrual()
  await emitUsage()

  // macOS: capture system audio natively (CoreAudio tap). Capturing ONLY the chosen
  // app means our own output is never in the stream → no feedback loop. The renderer
  // does NOT capture system audio on macOS.
  if (process.platform === 'darwin' && s.captureSystemAudio) {
    macTap = new MacSystemTap(s.captureAppPid || undefined, s.captureAppName, {
      onData: (pcm) => {
        if (!running) return
        if (!sessions.system) startSession('system', s)
        sessions.system?.sendAudio(pcm)
      },
      onLevel: (rms) => emitSystemLevel(rms),
      onError: (message) => {
        dbg(`tap ERROR ${message}`)
        send('error', { source: 'system', message })
      },
      onMode: (mode) => {
        dbg(`tap mode=${mode}`)
        send('system:mode', { mode })
      },
      onLog: (m) => dbg(`tap: ${m}`)
    })
    macTap.start().catch((e) =>
      send('error', { source: 'system', message: `Couldn't start system audio: ${e.message}` })
    )
    return { captureSystemInRenderer: false }
  }
  // Windows/Linux: the renderer captures system audio via getDisplayMedia.
  return { captureSystemInRenderer: s.captureSystemAudio }
})

// Throttle the captured-audio level to the renderer for the "Them" dot.
function emitSystemLevel(rms: number): void {
  const now = Date.now()
  if (now - lastLevelSent < 250) return
  lastLevelSent = now
  send('system:level', { rms })
}

ipcMain.handle('apps:list', () => listRunningApps())

ipcMain.on('open-screen-settings', () => {
  shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')
})

ipcMain.on('open-mic-settings', () => {
  shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone')
})

ipcMain.handle('permissions:get', () => {
  if (process.platform !== 'darwin') return { screen: 'granted', microphone: 'granted' }
  return {
    screen: systemPreferences.getMediaAccessStatus('screen'),
    microphone: systemPreferences.getMediaAccessStatus('microphone')
  }
})

ipcMain.handle('permissions:askMic', async () => {
  if (process.platform !== 'darwin') return true
  try {
    return await systemPreferences.askForMediaAccess('microphone')
  } catch {
    return false
  }
})

ipcMain.handle('capture:stop', async () => {
  await stopAll()
  return true
})

// Sessions start lazily on first audio so we never pay for an idle stream
// (e.g. when system-audio permission was denied and no audio ever arrives).
ipcMain.on('audio:chunk', (_e, source: Source, buffer: ArrayBuffer) => {
  if (!running || !activeSettings) return
  if (!sessions[source]) {
    dbg(`first ${source} chunk → creating session (turbo=${activeSettings.turboMode})`)
    startSession(source, activeSettings)
  }
  chunkCounts[source]++
  if (chunkCounts[source] === 1 || chunkCounts[source] % 100 === 0) {
    dbg(`audio:chunk ${source} #${chunkCounts[source]} bytes=${buffer.byteLength}`)
  }
  sessions[source]?.sendAudio(buffer)
})

ipcMain.on('window:control', (_e, action: 'minimize' | 'close' | 'pin' | 'unpin') => {
  if (action === 'close') {
    app.quit() // fully quit so a reopen is a real restart (needed to apply macOS permissions)
    return
  }
  if (!win) return
  if (action === 'minimize') win.minimize()
  else if (action === 'pin') win.setAlwaysOnTop(true, 'floating')
  else if (action === 'unpin') win.setAlwaysOnTop(false)
})

// Overlay morph: the renderer reports its current mode; main resizes the window to fit.
ipcMain.on('window:setMode', (_e, mode: WinMode) => {
  if (MODE_SIZE[mode]) applyMode(mode)
})
ipcMain.on('window:setDock', (_e, dock: Dock) => applyDock(dock))
ipcMain.on('window:setPin', (_e, on: boolean) => {
  if (win && !win.isDestroyed()) win.setAlwaysOnTop(on, 'floating')
})

ipcMain.on('app:relaunch', () => {
  app.relaunch()
  app.exit(0)
})

ipcMain.on('open-external', (_e, url: string) => {
  if (/^https?:\/\//i.test(url)) shell.openExternal(url)
})

// ---- App lifecycle ----

app.whenReady().then(async () => {
  // NOTE: do NOT call app.dock.show() — setVisibleOnAllWorkspaces transforms the
  // process so the window floats over all spaces/full-screen apps (and hides the
  // Dock icon). Forcing the Dock icon back disables that float. In-app ✕/Restart
  // handle quitting instead.
  session.defaultSession.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({ types: ['screen'] })
        if (!sources.length) {
          callback({}) // permission not granted yet → deny cleanly
          return
        }
        callback({ video: sources[0], audio: 'loopback' })
      } catch {
        callback({})
      }
    },
    { useSystemPicker: false }
  )

  const s = await loadSettings()
  freeBounds = s.overlayBounds
  bootDisplayId = s.displayId
  const dock: Dock = s.dock ?? 'top-center'
  const bootMode: WinMode = s.onboarded ? 'idle' : 'firstrun'
  createWindow({ mode: bootMode, dock })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow({ mode: bootMode, dock })
  })
})

app.on('window-all-closed', () => {
  void stopAll()
  app.quit()
})
