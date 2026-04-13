/**
 * Vercel KV-backed agent store.
 *
 * Persists agent state + trade log across Vercel cold starts and across
 * different warm instances (which can't share in-memory state).
 *
 * All functions degrade gracefully — if KV isn't configured (local dev
 * without env vars pulled) every call is a silent no-op / returns null.
 */

import { kv } from '@vercel/kv'
import type { AgentStateSnapshot } from './agent-shared'
import type { AgentTrade } from './types'

const STATE_KEY  = 'agent:state'
const TRADES_KEY = 'agent:trades'

const STATE_TTL  = 60 * 60 * 24        // 24 h — agent state
const TRADES_TTL = 60 * 60 * 24 * 7   // 7 days — trade log

async function kvGet<T>(key: string): Promise<T | null> {
  try { return await kv.get<T>(key) } catch { return null }
}

async function kvSet(key: string, value: unknown, ex: number): Promise<void> {
  try { await kv.set(key, value, { ex }) } catch { /* KV not configured — ignore */ }
}

export const agentStore = {
  saveState(state: AgentStateSnapshot): Promise<void> {
    return kvSet(STATE_KEY, state, STATE_TTL)
  },

  loadState(): Promise<AgentStateSnapshot | null> {
    return kvGet<AgentStateSnapshot>(STATE_KEY)
  },

  saveTrades(trades: AgentTrade[]): Promise<void> {
    return kvSet(TRADES_KEY, trades, TRADES_TTL)
  },

  loadTrades(): Promise<AgentTrade[]> {
    return kvGet<AgentTrade[]>(TRADES_KEY).then(t => t ?? [])
  },
}
