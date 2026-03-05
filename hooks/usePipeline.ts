'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import type { PipelineState, PartialPipelineAgents, TradeRecord, TradeSignals, PerformanceStats } from '@/lib/types'

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
  autoTrade: boolean = false,
  aiRisk: boolean = false,
  provider2?: string,    // split-provider for ProbabilityModel
  providers?: string[],  // multi-provider parallel for Sentiment
  orModel?: string,      // override OpenRouter model ID for sentiment + probability
  btcPrice?: number,     // live BTC price — used for strike-flip detection
  strikePrice?: number,  // current market strike price
) {
  // All persisted state inits to empty/null to match SSR — restored in useEffect below.
  // This prevents hydration mismatches where server renders 0/null and client renders
  // real localStorage values.
  const [pipeline, setPipeline]           = useState<PipelineState | null>(null)
  const [history, setHistory]             = useState<PipelineState[]>([])
  const [streamingAgents, setStreamingAgents] = useState<PartialPipelineAgents>({})
  const [trades, setTrades]               = useState<TradeRecord[]>([])
  const [tradesLoaded, setTradesLoaded]   = useState(false)  // guards persist until restore done
  const [isRunning, setIsRunning]         = useState(false)
  const [serverLocked, setServerLocked]   = useState(false)
  // Always start at default to match SSR — corrected from localStorage in useEffect below
  const [nextCycleIn, setNextCycleIn] = useState(CYCLE_INTERVAL_MS / 1000)
  const [error, setError]           = useState<string | null>(null)
  const [strikeFlipped, setStrikeFlipped] = useState(false)  // true briefly when BTC crosses strike
  const lastCycleRef                = useRef<number>(0)
  const countdownRef                = useRef<ReturnType<typeof setInterval> | null>(null)
  const autoIntervalRef             = useRef<ReturnType<typeof setInterval> | null>(null)
  const runCycleRef                 = useRef<(() => Promise<void>) | null>(null)
  const abortRef                    = useRef<AbortController | null>(null)
  const prevBtcSideRef              = useRef<'above' | 'below' | null>(null)
  const lastFlipMsRef               = useRef<number>(0)

  // Restore persisted state after mount — must be useEffect (not useState init)
  // so SSR and client both start with the same values and hydration passes.
  useEffect(() => {
    try {
      const savedTrades = localStorage.getItem('sentient-trades')
      if (savedTrades) setTrades(JSON.parse(savedTrades) as TradeRecord[])
    } catch {}
    setTradesLoaded(true)   // signal that persist effect may now write
    try {
      const savedPipeline = localStorage.getItem('sentient-pipeline')
      if (savedPipeline) setPipeline(JSON.parse(savedPipeline) as PipelineState)
    } catch {}
    try {
      const lastCycle = localStorage.getItem('sentient-last-cycle')
      if (lastCycle) {
        const elapsed = Math.floor((Date.now() - Number(lastCycle)) / 1000)
        const remaining = Math.max(0, CYCLE_INTERVAL_MS / 1000 - elapsed)
        if (remaining < CYCLE_INTERVAL_MS / 1000) setNextCycleIn(remaining)
      }
    } catch {}
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Persist trades — guarded by tradesLoaded so we never overwrite localStorage
  // with [] before the restore effect has had a chance to read it.
  useEffect(() => {
    if (!tradesLoaded) return
    try { localStorage.setItem('sentient-trades', JSON.stringify(trades)) } catch {}
  }, [trades, tradesLoaded])

  useEffect(() => {
    if (pipeline) {
      try { localStorage.setItem('sentient-pipeline', JSON.stringify(pipeline)) } catch {}
    }
  }, [pipeline])

  const stopCycle = useCallback(() => {
    // Defer out of React's synchronous event handler.
    // abort() synchronously triggers undici stream callbacks that throw
    // "BodyStreamBuffer was aborted" — deferring prevents it propagating
    // up through React's dispatch chain as an unhandled error.
    const controller = abortRef.current
    if (controller) setTimeout(() => { try { controller.abort() } catch { /* ignore */ } }, 0)
  }, [])

  const runCycle = useCallback(async () => {
    setIsRunning(true)
    setError(null)
    setStreamingAgents({})
    const controller = new AbortController()
    abortRef.current = controller
    try {
      const params = new URLSearchParams()
      if (aiRisk) params.set('aiRisk', 'true')
      if (provider2) params.set('provider2', provider2)
      if (providers && providers.length > 1) params.set('providers', providers.join(','))
      if (orModel) params.set('orModel', orModel)

      // Read user-provided API keys from localStorage and send as a header
      const reqHeaders: Record<string, string> = { Accept: 'text/event-stream' }
      try {
        const storedKeys = localStorage.getItem('sentient-provider-keys')
        if (storedKeys) {
          const parsed = JSON.parse(storedKeys) as Record<string, string>
          const nonEmpty = Object.fromEntries(Object.entries(parsed).filter(([, v]) => v?.trim()))
          if (Object.keys(nonEmpty).length > 0) {
            reqHeaders['x-provider-keys'] = btoa(JSON.stringify(nonEmpty))
          }
        }
      } catch { /* ignore localStorage errors */ }

      const res = await fetch(`/api/pipeline?${params}`, {
        cache: 'no-store',
        signal: controller.signal,
        headers: reqHeaders,
      })
      if (!res.ok) {
        if (res.status === 503) throw new Error('No active KXBTC15M market — trading hours are ~11:30 AM–midnight ET weekdays')
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `Pipeline error ${res.status}`)
      }

      // ── Stream SSE events ─────────────────────────────────────────────
      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      let data: PipelineState | null = null
      try {
        outer: while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          const parts = buf.split('\n\n')
          buf = parts.pop() ?? ''
          for (const chunk of parts) {
            if (!chunk.trim()) continue
            const lines  = chunk.split('\n')
            const evType = lines.find(l => l.startsWith('event: '))?.slice(7)?.trim()
            const raw    = lines.find(l => l.startsWith('data: '))?.slice(6)
            if (!evType || raw == null) continue
            const payload = JSON.parse(raw)
            if (evType === 'agent') {
              setStreamingAgents(prev => ({ ...prev, [payload.key]: payload.result }))
            } else if (evType === 'done') {
              data = payload as PipelineState
              break outer
            } else if (evType === 'error') {
              throw new Error(payload.message)
            } else if (evType === 'aborted') {
              throw Object.assign(new Error('Pipeline stopped'), { name: 'AbortError' })
            }
          }
        }
      } finally {
        reader.cancel().catch(() => {})  // suppress rejection if stream already aborted
      }

      if (!data) throw new Error('Pipeline stream ended without result')
      setPipeline(data)
      setHistory(prev => [data, ...prev])

      const exec = data.agents.execution.output
      const md   = data.agents.marketDiscovery.output
      const pf   = data.agents.priceFeed.output
      const prob = data.agents.probability.output
      const sent = data.agents.sentiment.output

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

        // ── Full signal snapshot for calibration/attribution ──────────────────
        const signals: TradeSignals = {
          sentimentScore:    sent.score ?? 0,
          sentimentMomentum: sent.momentum ?? 0,
          orderbookSkew:     sent.orderbookSkew ?? 0,
          sentimentLabel:    sent.label ?? 'neutral',
          pLLM:              prob.pModel,  // pModel IS the blended LLM+quant value
          confidence:        prob.confidence ?? 'low',
          gkVol:             prob.gkVol15m ?? null,
          distancePct:       pf.distanceFromStrikePct,
          minutesLeft:       md.minutesUntilExpiry,
          aboveStrike:       pf.aboveStrike,
          priceMomentum1h:   pf.priceChangePct1h,
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
          signals,
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
      // Next.js 16 Turbopack throws "BodyStreamBuffer was aborted" instead of
      // a named AbortError, so check the message too.
      const isAbort = err instanceof Error && (
        err.name === 'AbortError' ||
        err.message?.toLowerCase().includes('abort')
      )
      if (isAbort) {
        setError('Pipeline stopped')
      } else {
        setError(String(err))
      }
    } finally {
      setIsRunning(false)
      setServerLocked(false)
      lastCycleRef.current = Date.now()
      try { localStorage.setItem('sentient-last-cycle', String(Date.now())) } catch {}
      setNextCycleIn(CYCLE_INTERVAL_MS / 1000)
    }
  }, [liveMode, autoTrade, aiRisk, provider2, providers, orModel])

  // Check server lock state on mount so the button reflects server reality
  useEffect(() => {
    fetch('/api/pipeline/status').then(r => r.json()).then(d => {
      if (d.running) setServerLocked(true)
    }).catch(() => {})
  }, [])

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

  // ── Strike-flip detection ────────────────────────────────────────────────────
  // When BTC crosses the strike price, notify the user so they can decide whether
  // to re-run the pipeline. 60s cooldown prevents thrashing near the strike level.
  useEffect(() => {
    if (!btcPrice || !strikePrice || strikePrice <= 0) return
    const side: 'above' | 'below' = btcPrice >= strikePrice ? 'above' : 'below'
    const prev = prevBtcSideRef.current
    prevBtcSideRef.current = side
    if (prev === null || prev === side) return  // first read or no flip

    const now = Date.now()
    if (now - lastFlipMsRef.current < 60_000) return  // 60s cooldown
    lastFlipMsRef.current = now

    setStrikeFlipped(true)
  }, [btcPrice, strikePrice])  // eslint-disable-line react-hooks/exhaustive-deps

  // Countdown timer
  useEffect(() => {
    countdownRef.current = setInterval(() => setNextCycleIn(prev => Math.max(0, prev - 1)), 1000)
    return () => { if (countdownRef.current) clearInterval(countdownRef.current) }
  }, [])

  const stats = computeStats(trades)

  const dismissStrikeFlip = useCallback(() => setStrikeFlipped(false), [])

  return { pipeline, history, streamingAgents, trades, isRunning, serverLocked, nextCycleIn, error, stats, strikeFlipped, dismissStrikeFlip, runCycle, stopCycle }
}
