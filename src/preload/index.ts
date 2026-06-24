import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

type Source = 'mic' | 'system'
type Unsubscribe = () => void

function subscribe<T>(channel: string, cb: (payload: T) => void): Unsubscribe {
  const handler = (_e: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api = {
  platform: process.platform, // 'darwin' | 'win32' | 'linux' — lets the UI adapt per-OS
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch: unknown) => ipcRenderer.invoke('settings:save', patch),
  getUsage: () => ipcRenderer.invoke('usage:get'),
  listApps: () => ipcRenderer.invoke('apps:list') as Promise<{ pid: number; name: string }[]>,

  startCapture: () => ipcRenderer.invoke('capture:start'),
  stopCapture: () => ipcRenderer.invoke('capture:stop'),
  sendAudio: (source: Source, buffer: ArrayBuffer) =>
    ipcRenderer.send('audio:chunk', source, buffer),

  onPartial: (cb: (p: { source: Source; text: string }) => void) =>
    subscribe('caption:partial', cb),
  onFinal: (
    cb: (p: {
      id: string
      source: Source
      original: string
      sourceLang: string
      targetLang: string
      translation?: string
    }) => void
  ) => subscribe('caption:final', cb),
  onTranslation: (
    cb: (p: {
      id: string
      translation: string
      note?: string
      error?: string
      final?: boolean
      source?: Source
      targetLang?: string
    }) => void
  ) => subscribe('caption:translation', cb),
  onStatus: (cb: (p: { source: Source; status: string }) => void) => subscribe('status', cb),
  onError: (cb: (p: { source: Source; message: string }) => void) => subscribe('error', cb),
  onUsage: (cb: (p: { spent: number; budget: number; month: string }) => void) =>
    subscribe('usage', cb),
  onTtsPlay: (cb: (p: { id: string; audioBase64: string; mime: string }) => void) =>
    subscribe('tts:play', cb),
  onTurboAudio: (cb: (p: { data: string }) => void) => subscribe('turbo:audio', cb),
  onSystemLevel: (cb: (p: { rms: number }) => void) => subscribe('system:level', cb),
  onSystemAudio: (cb: (pcm: Uint8Array) => void) => subscribe('system:audio', cb),
  onSystemMode: (cb: (p: { mode: 'muted' | 'overlap' }) => void) => subscribe('system:mode', cb),
  onBudget: (
    cb: (p: { reached: boolean; warning?: boolean; spent: number; budget: number }) => void
  ) => subscribe('budget', cb),

  askAssistant: (p: {
    reqId: string
    transcript: string
    question: string
    answerLang: string
    otherLang: string
  }) => ipcRenderer.send('assistant:ask', p),
  cancelAssistant: (reqId: string) => ipcRenderer.send('assistant:cancel', { reqId }),
  onAssistantDelta: (cb: (p: { reqId: string; text: string }) => void) =>
    subscribe('assistant:delta', cb),
  onAssistantDone: (cb: (p: { reqId: string; text: string; provider: string }) => void) =>
    subscribe('assistant:done', cb),
  onAssistantError: (cb: (p: { reqId: string; code: string; message: string }) => void) =>
    subscribe('assistant:error', cb),

  windowControl: (action: 'minimize' | 'close' | 'pin' | 'unpin') =>
    ipcRenderer.send('window:control', action),
  setMode: (
    mode:
      | 'firstrun'
      | 'setup'
      | 'idle'
      | 'idle-menu'
      | 'live-collapsed'
      | 'live-expanded'
      | 'mini'
      | 'assistant'
  ) => ipcRenderer.send('window:setMode', mode),
  setDock: (dock: 'top-center' | 'bottom-center' | 'top-left' | 'top-right' | 'free') =>
    ipcRenderer.send('window:setDock', dock),
  setCollapsedHeight: (px: number) => ipcRenderer.send('window:setCollapsedHeight', px),
  setPin: (on: boolean) => ipcRenderer.send('window:setPin', on),
  onDock: (cb: (p: { dock: string }) => void) => subscribe('window:dock', cb),
  openExternal: (url: string) => ipcRenderer.send('open-external', url),
  openScreenSettings: () => ipcRenderer.send('open-screen-settings'),
  openMicSettings: () => ipcRenderer.send('open-mic-settings'),
  getPermissions: () =>
    ipcRenderer.invoke('permissions:get') as Promise<{ screen: string; microphone: string }>,
  askMicPermission: () => ipcRenderer.invoke('permissions:askMic') as Promise<boolean>,
  relaunchApp: () => ipcRenderer.send('app:relaunch')
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
