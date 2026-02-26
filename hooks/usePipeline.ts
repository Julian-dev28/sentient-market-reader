'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import type { PipelineState, TradeRecord, PerformanceStats } from '@/lib/types'

const CYCLE_INTERVAL_MS = 5 * 60 * 1000  // 5-minute cycles — 3 signals per 15-min window

function computeStats(trades: TradeRecord[]): PerformanceStats {
  const settled = trades.filter(t => t.outcome !== 'PENDING')
  const wins = settled.filter(t => t.outcome === 'WIN')
  const losses = settled.filter(t => t.outcome === 'LOSS')
  const totalPnl = settled.reduce((s, t) => s + (t.pnl ?? 0), 0)
  const pnls = settled.map(t => t.pnl ?? 0)

  return {
    totalTrades: settled.length,
    wins: wins.length,
    losses: losses.length,
    pending: trades.filter(t => t.outcome === 'PENDING').length,
    winRate: settled.length > 0 ? wins.length / settled.length : 0,
    totalPnl,
    avgEdge: trades.length > 0 ? trades.reduce((s, t) => s + t.edge, 0) / trades.length : 0,
    avgReturn: settled.length > 0 ? totalPnl / settled.length : 0,
    bestTrade: pnls.length ? Math.max(...pnls) : 0,
    worstTrade: pnls.length ? Math.min(...pnls) : 0,
  }
}

function simulateOutcome(trade: TradeRecord, settlementPrice: number): TradeRecord {
  const priceAboveStrike = settlementPrice > trade.strikePrice
  const win = trade.side === 'yes' ? priceAboveStrike : !priceAboveStrike
  const pnl = win
    ? trade.contracts - trade.estimatedCost      // won: payout minus cost
    : -trade.estimatedCost                         // lost: full cost

  return {
    ...trade,
    outcome: win ? 'WIN' : 'LOSS',
    settlementPrice,
    pnl,
  }
}

export function usePipeline(liveMode: boolean, romaDepth: number = 2) {
  const [pipeline, setPipeline] = useState<PipelineState | null>(null)
  const [trades, setTrades] = useState<TradeRecord[]>([])
  const [isRunning, setIsRunning] = useState(false)
  const [nextCycleIn, setNextCycleIn] = useState(CYCLE_INTERVAL_MS / 1000)
  const [error, setError] = useState<string | null>(null)
  const lastCycleRef = useRef<number>(0)
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const runCycle = useCallback(async () => {
    setIsRunning(true)
    setError(null)
    try {
      const res = await fetch(`/api/pipeline?depth=${romaDepth}`, { cache: 'no-store' })
      if (!res.ok) {
        if (res.status === 503) throw new Error('No active KXBTC15M market — trading hours are ~11:30 AM–midnight ET weekdays')
        throw new Error(`Pipeline error ${res.status}`)
      }
      const data: PipelineState = await res.json()
      setPipeline(data)

      const exec = data.agents.execution.output
      const md = data.agents.marketDiscovery.output
      const pf = data.agents.priceFeed.output
      const prob = data.agents.probability.output

      if (exec.action !== 'PASS' && exec.side && exec.limitPrice && md.activeMarket) {
        let liveOrderId: string | undefined

        // Place real order if in live mode
        if (liveMode) {
          try {
            const orderRes = await fetch('/api/place-order', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                ticker: exec.marketTicker,
                side: exec.side,
                count: exec.contracts,
                yesPrice: exec.side === 'yes' ? exec.limitPrice : (100 - exec.limitPrice),
                clientOrderId: `sentient-${data.cycleId}-${Date.now()}`,
              }),
            })
            if (orderRes.ok) {
              const orderData = await orderRes.json()
              liveOrderId = orderData.order?.order_id
            }
          } catch {
            // Live order failed — still record as paper trade
          }
        }

        const trade: TradeRecord = {
          id: `${data.cycleId}-${Date.now()}`,
          cycleId: data.cycleId,
          marketTicker: exec.marketTicker,
          side: exec.side,
          limitPrice: exec.limitPrice,
          contracts: exec.contracts,
          estimatedCost: exec.estimatedCost,
          enteredAt: new Date().toISOString(),
          expiresAt: md.activeMarket.expiration_time,
          strikePrice: md.strikePrice,
          btcPriceAtEntry: pf.currentPrice,
          outcome: 'PENDING',
          pModel: prob.pModel,
          pMarket: prob.pMarket,
          edge: prob.edge,
          liveOrderId,
          liveMode,
        }
        setTrades(prev => [...prev, trade])
      }

      // Settle any pending trades that have expired
      setTrades(prev => prev.map(t => {
        if (t.outcome === 'PENDING') {
          const expiryMs = new Date(t.expiresAt).getTime()
          if (Date.now() >= expiryMs) {
            return simulateOutcome(t, pf.currentPrice)
          }
        }
        return t
      }))

    } catch (err) {
      setError(String(err))
    } finally {
      setIsRunning(false)
      lastCycleRef.current = Date.now()
      setNextCycleIn(CYCLE_INTERVAL_MS / 1000)
    }
  }, [liveMode, romaDepth])

  // Manual-only — run cycle is triggered by the user clicking the button

  // Countdown timer
  useEffect(() => {
    countdownRef.current = setInterval(() => {
      setNextCycleIn(prev => Math.max(0, prev - 1))
    }, 1000)
    return () => {
      if (countdownRef.current) clearInterval(countdownRef.current)
    }
  }, [])

  const stats = computeStats(trades)

  return { pipeline, trades, isRunning, nextCycleIn, error, stats, runCycle }
}
