import { kv } from '@vercel/kv'
import type { AgentStateSnapshot } from './agent-shared'
import type { AgentTrade } from './types'

const STATE_KEY  = 'hourly:state'
const TRADES_KEY = 'hourly:trades'
const STATE_TTL  = 60 * 60 * 24
const TRADES_TTL = 60 * 60 * 24 * 7

async function kvGet<T>(key: string): Promise<T | null> {
  try { return await kv.get<T>(key) } catch { return null }
}

async function kvSet(key: string, value: unknown, ex: number): Promise<void> {
  try { await kv.set(key, value, { ex }) } catch { /* KV not configured */ }
}

export const hourlyAgentStore = {
  saveState(state: AgentStateSnapshot):   Promise<void>               { return kvSet(STATE_KEY,  state,  STATE_TTL)  },
  loadState():                            Promise<AgentStateSnapshot | null> { return kvGet<AgentStateSnapshot>(STATE_KEY)  },
  saveTrades(trades: AgentTrade[]):       Promise<void>               { return kvSet(TRADES_KEY, trades, TRADES_TTL) },
  loadTrades():                           Promise<AgentTrade[]>       { return kvGet<AgentTrade[]>(TRADES_KEY).then(t => t ?? []) },
}
