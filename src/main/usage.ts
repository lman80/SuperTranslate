import { app } from 'electron'
import { join } from 'path'
import { promises as fs } from 'fs'

export interface Usage {
  month: string // 'YYYY-MM'
  sttUsd: number
  translateUsd: number
  ttsUsd: number
}

function usageFile(): string {
  return join(app.getPath('userData'), 'usage.json')
}

function currentMonth(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

let cache: Usage | null = null
let saveTimer: ReturnType<typeof setTimeout> | null = null

export async function getUsage(): Promise<Usage> {
  if (!cache) {
    try {
      cache = JSON.parse(await fs.readFile(usageFile(), 'utf-8')) as Usage
    } catch {
      cache = { month: currentMonth(), sttUsd: 0, translateUsd: 0, ttsUsd: 0 }
    }
  }
  // New month → reset the running total.
  if (cache.month !== currentMonth()) {
    cache = { month: currentMonth(), sttUsd: 0, translateUsd: 0, ttsUsd: 0 }
    void persist()
  }
  return cache
}

function persist(): void {
  if (saveTimer) return
  saveTimer = setTimeout(async () => {
    saveTimer = null
    try {
      await fs.writeFile(usageFile(), JSON.stringify(cache), 'utf-8')
    } catch {
      /* ignore */
    }
  }, 1000)
}

export async function addStt(usd: number): Promise<void> {
  const u = await getUsage()
  u.sttUsd += usd
  persist()
}

export async function addTranslate(usd: number): Promise<void> {
  const u = await getUsage()
  u.translateUsd += usd
  persist()
}

export async function addTts(usd: number): Promise<void> {
  const u = await getUsage()
  u.ttsUsd += usd
  persist()
}

export function totalUsd(u: Usage): number {
  return u.sttUsd + u.translateUsd + (u.ttsUsd ?? 0)
}
