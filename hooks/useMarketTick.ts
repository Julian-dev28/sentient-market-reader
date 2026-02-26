'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import type { KalshiMarket, PricePoint } from '@/lib/types'

const TICK_MS = 2_000  // 2-second refresh

interface MarketTick {
  liveMarket: KalshiMarket | null   // fresh bid/ask/volume
  liveBTCPrice: number | null       // fresh BTC price
  livePriceHistory: PricePoint[]    // grows every 5 s
  refresh: () => void               // trigger an immediate tick
}

/**
 * Polls /api/markets and /api/btc-price every 5 seconds to keep
 * bid/ask prices and BTC price up-to-date between full pipeline cycles.
 *
 * @param ticker  Active market ticker — used to filter the market list.
 *                Pass null until it is known; polling still fetches BTC.
 * @param seedHistory  Initial price history from the pipeline; new points
 *                     are appended on each tick.
 */
export function useMarketTick(
  ticker: string | null,
  seedHistory: PricePoint[] = [],
): MarketTick {
  const [liveMarket,       setLiveMarket]       = useState<KalshiMarket | null>(null)
  const [liveBTCPrice,     setLiveBTCPrice]     = useState<number | null>(null)
  const [livePriceHistory, setLivePriceHistory] = useState<PricePoint[]>(seedHistory)

  // When the pipeline produces a new, longer history, adopt it as the base
  const seedLenRef = useRef(seedHistory.length)
  useEffect(() => {
    if (seedHistory.length > seedLenRef.current) {
      seedLenRef.current = seedHistory.length
      setLivePriceHistory(seedHistory)
    }
  }, [seedHistory])

  // Track ticker changes — reset live market so stale data doesn't linger
  const prevTickerRef = useRef(ticker)
  useEffect(() => {
    if (ticker !== prevTickerRef.current) {
      prevTickerRef.current = ticker
      setLiveMarket(null)
    }
  }, [ticker])

  const tickRef = useRef<(() => void) | null>(null)

  const refresh = useCallback(() => { tickRef.current?.() }, [])

  useEffect(() => {
    let mounted = true

    async function tick() {
      // ── BTC price ──────────────────────────────────────────────────────
      try {
        const res = await fetch('/api/btc-price', { cache: 'no-store' })
        if (res.ok) {
          const data = await res.json()
          if (mounted && data.price > 0) {
            setLiveBTCPrice(data.price)
            setLivePriceHistory(prev => {
              const now = Date.now()
              // Seed with 2 points on very first fetch so chart renders immediately
              if (prev.length === 0) {
                return [
                  { timestamp: now - TICK_MS, price: data.price },
                  { timestamp: now,           price: data.price },
                ]
              }
              const last = prev[prev.length - 1]
              // Skip if price hasn't changed since last tick
              if (Math.abs(last.price - data.price) < 0.01) return prev
              return [...prev, { timestamp: now, price: data.price }].slice(-180)
            })
          }
        }
      } catch { /* network blip — keep previous value */ }

      // ── Market bid/ask ─────────────────────────────────────────────────
      // When ticker is known, filter to it. Otherwise auto-pick the first
      // actively-trading market so data populates before the pipeline runs.
      try {
        const res = await fetch('/api/markets', { cache: 'no-store' })
        if (res.ok) {
          const data = await res.json()
          const markets = data.markets as KalshiMarket[] | undefined
          const market = ticker
            ? markets?.find(m => m.ticker === ticker)
            : markets?.find(m => (m.yes_ask ?? 0) > 0)
          if (mounted && market) setLiveMarket(market)
        }
      } catch { /* keep previous value */ }
    }

    tickRef.current = tick
    tick()  // fire immediately
    const id = setInterval(tick, TICK_MS)
    return () => { mounted = false; clearInterval(id); tickRef.current = null }
  }, [ticker])

  return { liveMarket, liveBTCPrice, livePriceHistory, refresh }
}
