'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import type { KalshiMarket, KalshiOrderbook, PricePoint } from '@/lib/types'

const TICK_MS = 2_000       // 2-second BTC price + market bid/ask refresh
const OB_TICK_MS = 4_000    // 4-second orderbook depth refresh

interface MarketTick {
  liveMarket: KalshiMarket | null       // fresh bid/ask/volume
  liveOrderbook: KalshiOrderbook | null // fresh depth levels
  liveBTCPrice: number | null           // fresh BTC price
  livePriceHistory: PricePoint[]        // built from live ticks
  refresh: () => void                   // trigger an immediate tick
}

/**
 * Polls /api/btc-price every 2 seconds.
 * Polls /api/markets with exponential backoff — stays at 2s during live windows,
 * backs off to ~60s during off-hours (persistent 503s) to reduce console noise.
 *
 * @param ticker  Active market ticker — used to filter the market list.
 *                Pass null until known; polling still fetches BTC + auto-picks market.
 */
export function useMarketTick(ticker: string | null): MarketTick {
  const [liveMarket,       setLiveMarket]       = useState<KalshiMarket | null>(null)
  const [liveOrderbook,    setLiveOrderbook]    = useState<KalshiOrderbook | null>(null)
  const [liveBTCPrice,     setLiveBTCPrice]     = useState<number | null>(null)
  const [livePriceHistory, setLivePriceHistory] = useState<PricePoint[]>([])

  // Track ticker changes — reset live market + orderbook + price history so stale data doesn't linger
  const prevTickerRef = useRef(ticker)
  useEffect(() => {
    if (ticker !== prevTickerRef.current) {
      prevTickerRef.current = ticker
      setLiveMarket(null)
      setLiveOrderbook(null)
      setLivePriceHistory([])
    }
  }, [ticker])

  const tickRef = useRef<(() => void) | null>(null)
  const refresh = useCallback(() => { tickRef.current?.() }, [])

  useEffect(() => {
    let mounted = true

    // Exponential backoff for market polls: 0 ticks to skip → 1 → 3 → 7 → 15 → 30 (max ~60s)
    let marketBackoff = 0   // ticks to skip between market fetches
    let marketSkip   = 0   // ticks skipped so far in current window

    async function tick() {
      // ── BTC price (always, every tick) ───────────────────────────────────
      try {
        const res = await fetch('/api/btc-price', { cache: 'no-store' })
        if (res.ok) {
          const data = await res.json()
          if (mounted && data.price > 0) {
            setLiveBTCPrice(data.price)
            setLivePriceHistory(prev => {
              const now = Date.now()
              if (prev.length === 0) {
                return [
                  { timestamp: now - TICK_MS, price: data.price },
                  { timestamp: now,           price: data.price },
                ]
              }
              const last = prev[prev.length - 1]
              if (Math.abs(last.price - data.price) < 0.01) return prev
              return [...prev, { timestamp: now, price: data.price }].slice(-180)
            })
          }
        }
      } catch { /* network blip — keep previous value */ }

      // ── Market bid/ask (with backoff during off-hours) ───────────────────
      // When no active window exists the API returns 503 — back off exponentially
      // so the console doesn't spam. Resets to 2s instantly when a live market appears.
      if (marketSkip < marketBackoff) {
        marketSkip++
        return
      }
      marketSkip = 0

      try {
        const res = await fetch('/api/markets', { cache: 'no-store' })
        const data = await res.json().catch(() => ({ markets: [] }))
        const markets: KalshiMarket[] = res.ok ? (data.markets ?? []) : []

        if (!res.ok) {
          // Back off: 0→1→3→7→15→30 (max 30 ticks × 2s = 60s between attempts)
          marketBackoff = Math.min(marketBackoff * 2 + 1, 30)
        } else {
          marketBackoff = 0  // live market found — resume 2s polling
        }

        const isLive = (m: KalshiMarket) => (m.yes_ask ?? 0) > 1 && (m.yes_ask ?? 100) < 99
        const byTicker = ticker ? markets.find(m => m.ticker === ticker) : undefined
        // If the known ticker's market is settled, fall back to auto-discovery
        const market = (byTicker && isLive(byTicker))
          ? byTicker
          : markets.find(m => isLive(m))
        if (mounted) setLiveMarket(market ?? null)
      } catch {
        marketBackoff = Math.min(marketBackoff * 2 + 1, 30)
      }
    }

    tickRef.current = tick
    tick()  // fire immediately
    const id = setInterval(tick, TICK_MS)

    // ── Orderbook depth — independent 4s poll ────────────────────────────────
    async function obTick() {
      const t = prevTickerRef.current
      if (!t) return
      try {
        const res = await fetch(`/api/orderbook/${encodeURIComponent(t)}`, { cache: 'no-store' })
        if (res.ok && mounted) {
          const data = await res.json()
          if (data.orderbook) setLiveOrderbook(data.orderbook)
        }
      } catch { /* network blip */ }
    }
    obTick()  // fire immediately
    const obId = setInterval(obTick, OB_TICK_MS)

    return () => { mounted = false; clearInterval(id); clearInterval(obId); tickRef.current = null }
  }, [ticker])

  return { liveMarket, liveOrderbook, liveBTCPrice, livePriceHistory, refresh }
}
