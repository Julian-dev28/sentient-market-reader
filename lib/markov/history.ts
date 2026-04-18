/**
 * Rolling momentum state history for the Markov chain.
 *
 * Separate stores per market type — 15-min and 1-hour markets have different
 * momentum dynamics and must not share history.
 *
 * '15m'  KXBTC15M: 1-min candles, 480-obs window (8 hours)
 * '1h'   KXBTCD:   1-min candles, 480-obs window (8 hours)
 *        (same timeframe source; separate matrix because entry windows differ)
 *
 * Persists across Next.js hot-reloads and Vercel warm restarts via globalThis.
 * Deduplication via per-store lastCandleTs watermark.
 */

import { priceChangeToState, NUM_STATES } from './chain'
import type { OHLCVCandle } from '../types'

export type MarketKey = '15m' | '1h'

const WINDOW = 480   // 8 hours of 1-min observations

interface Store {
  history:      number[]
  lastCandleTs: number
}

type StoreMap = { '15m': Store; '1h': Store }

declare const globalThis: { _markovStores?: StoreMap }
if (!globalThis._markovStores) {
  globalThis._markovStores = {
    '15m': { history: [], lastCandleTs: 0 },
    '1h':  { history: [], lastCandleTs: 0 },
  }
}

function getStore(key: MarketKey): Store {
  return globalThis._markovStores![key]
}

export function appendMomentumState(state: number, key: MarketKey): void {
  if (state < 0 || state >= NUM_STATES) return
  const s = getStore(key)
  s.history.push(state)
  if (s.history.length > WINDOW) s.history.splice(0, s.history.length - WINDOW)
}

export function getMomentumHistory(key: MarketKey): number[] {
  return [...getStore(key).history]
}

export function getMomentumHistoryLength(key: MarketKey): number {
  return getStore(key).history.length
}

/**
 * Seed history from a candle array (newest-first Coinbase format).
 * Computes the % change between each consecutive candle pair and appends
 * the resulting momentum state. Idempotent — skips candles already seen.
 */
export function seedFromCandles(candles: OHLCVCandle[], key: MarketKey): void {
  if (candles.length < 2) return
  const s       = getStore(key)
  const ordered = [...candles].reverse()   // oldest-first

  for (let i = 1; i < ordered.length; i++) {
    const ts = ordered[i][0]
    if (ts <= s.lastCandleTs) continue

    const prev = ordered[i - 1][4]   // [ts, low, high, open, close, vol]
    const curr = ordered[i][4]
    if (prev > 0) {
      const pct   = ((curr - prev) / prev) * 100
      appendMomentumState(priceChangeToState(pct), key)
    }
  }

  const maxTs = ordered[ordered.length - 1][0]
  if (maxTs > s.lastCandleTs) s.lastCandleTs = maxTs
}
