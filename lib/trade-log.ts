/**
 * Persistent trade log + agent config — written to data/ on disk.
 * Survives server restarts and Next.js HMR. Used for algo calibration and backtesting.
 */
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import type { AgentTrade } from './types'

// On Vercel, process.cwd() is read-only — use /tmp which is always writable.
// Locally, use data/ so files survive across dev restarts.
const DATA_DIR    = process.env.VERCEL ? '/tmp' : join(process.cwd(), 'data')
const LOG_PATH    = join(DATA_DIR, 'trade-log.json')
const CONFIG_PATH = join(DATA_DIR, 'agent-config.json')

export interface PersistedAgentConfig {
  active:      boolean
  allowance:   number
  kellyMode:   boolean
  aiMode:      boolean
  bankroll:    number
  kellyPct:    number
  orModel?:    string
}

export function saveAgentConfig(cfg: PersistedAgentConfig): void {
  ensureDir()
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2))
}

export function loadAgentConfig(): PersistedAgentConfig | null {
  try {
    if (!existsSync(CONFIG_PATH)) return null
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) as PersistedAgentConfig
  } catch { return null }
}

function ensureDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
}

export function readTradeLog(): AgentTrade[] {
  try {
    if (!existsSync(LOG_PATH)) return []
    return JSON.parse(readFileSync(LOG_PATH, 'utf-8')) as AgentTrade[]
  } catch { return [] }
}

export function appendTrade(trade: AgentTrade): void {
  ensureDir()
  const existing = readTradeLog()
  // Avoid duplicates by id
  const deduped = existing.filter(t => t.id !== trade.id)
  writeFileSync(LOG_PATH, JSON.stringify([...deduped, trade], null, 2))
}

export function updateTrade(id: string, patch: Partial<AgentTrade>): void {
  ensureDir()
  const trades = readTradeLog()
  const idx = trades.findIndex(t => t.id === id)
  if (idx === -1) return
  trades[idx] = { ...trades[idx], ...patch }
  writeFileSync(LOG_PATH, JSON.stringify(trades, null, 2))
}

export function clearTradeLog(): void {
  ensureDir()
  writeFileSync(LOG_PATH, '[]')
}
