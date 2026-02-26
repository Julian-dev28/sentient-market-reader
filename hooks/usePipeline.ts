'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import type { PipelineState, TradeRecord, PerformanceStats } from '@/lib/types'

const CYCLE_INTERVAL_MS = 5 * 60 * 1000  // 5-minute cycles
const BOT_TRADE_DOLLARS = 100             // fixed $ size per bot trade

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
    ? trade.contracts - trade.estimatedCost
    : -trade.estimatedCost

  return { ...trade, outcome: win ? 'WIN' : 'LOSS', settlementPrice, pnl }
}

/**
 * usePipeline — drives the agent pipeline.
 *
 * SAFETY: live orders are ONLY placed when `autoTrade=true` (bot is running).
 * Manual "Run Cycle" calls never place real orders regardless of liveMode.
 */
export function usePipeline(
  liveMode: boolean,
  romaMode: string = 'smart',
  autoTrade: boolean = false,
  aiRisk: boolean = false,
  provider2?: string,   // split-provider for ProbabilityModel
  providers?: string[], // multi-provider parallel for Sentiment
) {
  const [pipeline, setPipeline]     = useState<PipelineState | null>(null)
  const [trades, setTrades]         = useState<TradeRecord[]>([])
  const [isRunning, setIsRunning]   = useState(false)
  const [nextCycleIn, setNextCycleIn] = useState(CYCLE_INTERVAL_MS / 1000)
  const [error, setError]           = useState<string | null>(null)
  const lastCycleRef                = useRef<number>(0)
  const countdownRef                = useRef<ReturnType<typeof setInterval> | null>(null)
  const autoIntervalRef             = useRef<ReturnType<typeof setInterval> | null>(null)
  const runCycleRef                 = useRef<(() => Promise<void>) | null>(null)

  const runCycle = useCallback(async () => {
    setIsRunning(true)
    setError(null)
    try {
      const params = new URLSearchParams({ mode: romaMode })
      if (aiRisk) params.set('aiRisk', 'true')
      if (provider2) params.set('provider2', provider2)
      if (providers && providers.length > 1) params.set('providers', providers.join(','))
      const res = await fetch(`/api/pipeline?${params}`, { cache: 'no-store' })
      if (!res.ok) {
        if (res.status === 503) throw new Error('No active KXBTC15M market — trading hours are ~11:30 AM–midnight ET weekdays')
        throw new Error(`Pipeline error ${res.status}`)
      }
      const data: PipelineState = await res.json()
      setPipeline(data)

      const exec = data.agents.execution.output
      const md   = data.agents.marketDiscovery.output
      const pf   = data.agents.priceFeed.output
      const prob = data.agents.probability.output

      if (exec.action !== 'PASS' && exec.side && exec.limitPrice && md.activeMarket) {
        // Agent: fixed $100 trade. Manual analysis: use agent's contract count.
        const contracts    = autoTrade
          ? Math.max(1, Math.floor(BOT_TRADE_DOLLARS / (exec.limitPrice / 100)))
          : exec.contracts
        const estimatedCost = contracts * exec.limitPrice / 100

        let liveOrderId: string | undefined

        // ── Real order: ONLY when Agent is active ──────────────────────────────
        if (autoTrade && liveMode) {
          try {
            const orderRes = await fetch('/api/place-order', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                ticker: exec.marketTicker,
                side: exec.side,
                count: contracts,
                yesPrice: exec.side === 'yes' ? exec.limitPrice : (100 - exec.limitPrice),
                clientOrderId: `bot-${data.cycleId}-${Date.now()}`,
              }),
            })
            if (orderRes.ok) {
              const orderData = await orderRes.json()
              liveOrderId = orderData.order?.order_id
            }
          } catch { /* live order failed — still record as paper */ }
        }

        const trade: TradeRecord = {
          id: `${data.cycleId}-${Date.now()}`,
          cycleId: data.cycleId,
          marketTicker: exec.marketTicker,
          side: exec.side,
          limitPrice: exec.limitPrice,
          contracts,
          estimatedCost,
          enteredAt: new Date().toISOString(),
          expiresAt: md.activeMarket.close_time,
          strikePrice: md.strikePrice,
          btcPriceAtEntry: pf.currentPrice,
          outcome: 'PENDING',
          pModel: prob.pModel,
          pMarket: prob.pMarket,
          edge: prob.edge,
          liveOrderId,
          liveMode: autoTrade && liveMode,
        }
        setTrades(prev => [...prev, trade])
      }

      // Settle expired pending trades
      setTrades(prev => prev.map(t => {
        if (t.outcome === 'PENDING' && Date.now() >= new Date(t.expiresAt).getTime()) {
          return simulateOutcome(t, pf.currentPrice)
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
  }, [liveMode, romaMode, autoTrade, aiRisk, provider2, providers])

  // Keep ref current so auto-interval always calls latest version
  useEffect(() => { runCycleRef.current = runCycle }, [runCycle])

  // Auto-cycle when bot is active — fires immediately, then every 5 min
  useEffect(() => {
    if (autoTrade) {
      setTimeout(() => runCycleRef.current?.(), 50)
      autoIntervalRef.current = setInterval(() => runCycleRef.current?.(), CYCLE_INTERVAL_MS)
    }
    return () => {
      if (autoIntervalRef.current) { clearInterval(autoIntervalRef.current); autoIntervalRef.current = null }
    }
  }, [autoTrade])

  // Countdown timer
  useEffect(() => {
    countdownRef.current = setInterval(() => setNextCycleIn(prev => Math.max(0, prev - 1)), 1000)
    return () => { if (countdownRef.current) clearInterval(countdownRef.current) }
  }, [])

  const stats = computeStats(trades)

  return { pipeline, trades, isRunning, nextCycleIn, error, stats, runCycle }
}
