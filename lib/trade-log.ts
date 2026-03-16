/**
 * Persistent trade log — appends to data/trade-log.json on disk.
 * Survives server restarts. Used for algo calibration and backtesting.
 */
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import type { AgentTrade } from './types'

const LOG_PATH = join(process.cwd(), 'data', 'trade-log.json')

function ensureDir() {
  const dir = join(process.cwd(), 'data')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
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
