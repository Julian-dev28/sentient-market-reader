'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import type { PipelineState, PartialPipelineAgents } from '@/lib/types'

const CYCLE_INTERVAL_MS        = 5 * 60 * 1000  // 5-minute cycles (quant fixed clock)
const PRICE_DELTA_TRIGGER_PCT  = 0.20            // AI mode: 0.20% BTC move → re-run
const MIN_COOLDOWN_MS          = 90_000          // AI mode: minimum 90s between runs
const AI_WATCHER_INTERVAL_MS   = 15_000          // AI mode: check for triggers every 15s

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
  const [isRunning, setIsRunning]         = useState(false)
  const [serverLocked, setServerLocked]   = useState(false)
  // Always start at default to match SSR — corrected from localStorage in useEffect below
  const [nextCycleIn, setNextCycleIn] = useState(CYCLE_INTERVAL_MS / 1000)
  const [error, setError]              = useState<string | null>(null)
  // AI delta monitor — current signed % move from last-cycle BTC price
  const [monitorDeltaPct, setMonitorDeltaPct] = useState<number | null>(null)
  const lastCycleRef                = useRef<number>(0)
  const countdownRef                = useRef<ReturnType<typeof setInterval> | null>(null)
  const autoIntervalRef             = useRef<ReturnType<typeof setInterval> | null>(null)
  const runCycleRef                 = useRef<(() => Promise<void>) | null>(null)
  const abortRef                    = useRef<AbortController | null>(null)
  // Refs for live price (updated each render; readable inside intervals without adding to deps)
  const btcPriceRef          = useRef<number | undefined>(btcPrice)
  const strikePriceRef       = useRef<number | undefined>(strikePrice)
  const lastCyclePriceRef    = useRef<number>(0)   // BTC price when last cycle completed
  const lastCycleStrikeRef   = useRef<number>(0)   // strike price when last cycle completed
  const isRunningRef         = useRef<boolean>(false)
  const aiRiskRef            = useRef<boolean>(aiRisk)

  // Restore persisted state after mount — must be useEffect (not useState init)
  // so SSR and client both start with the same values and hydration passes.
  useEffect(() => {
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

  useEffect(() => {
    if (pipeline) {
      try { localStorage.setItem('sentient-pipeline', JSON.stringify(pipeline)) } catch {}
    }
  }, [pipeline])

  // Sync live price refs — readable inside intervals without closure staleness
  useEffect(() => { btcPriceRef.current   = btcPrice },   [btcPrice])
  useEffect(() => { strikePriceRef.current = strikePrice }, [strikePrice])
  useEffect(() => { isRunningRef.current  = isRunning },  [isRunning])
  useEffect(() => { aiRiskRef.current     = aiRisk },     [aiRisk])

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

      // ── Real order: ONLY when Agent is active ──────────────────────────────
      if (autoTrade && liveMode && exec.action !== 'PASS' && exec.side && exec.limitPrice && exec.marketTicker) {
        const contracts = Math.max(1, Math.floor(100 / (exec.limitPrice / 100)))
        // Fetch fresh quote right before submitting — use current ask, not stale pipeline price
        let submitPrice = exec.limitPrice
        try {
          const quoteRes = await fetch(`/api/market-quote/${encodeURIComponent(exec.marketTicker)}`)
          if (quoteRes.ok) {
            const quoteData = await quoteRes.json()
            const freshAsk = exec.side === 'yes'
              ? quoteData?.market?.yes_ask
              : quoteData?.market?.no_ask
            if (typeof freshAsk === 'number' && freshAsk > 0) submitPrice = freshAsk
          }
        } catch { /* fall back to pipeline price */ }
        const yesPrice = exec.side === 'yes' ? submitPrice : (100 - submitPrice)
        const clientOrderId = `bot-${data.cycleId}-${Date.now()}`
        try {
          const orderRes = await fetch('/api/place-order', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ticker: exec.marketTicker,
              side: exec.side,
              count: contracts,
              yesPrice,
              clientOrderId,
            }),
          })
          const orderData = orderRes.ok ? await orderRes.json() : null
          const orderId = orderData?.order?.order_id ?? orderData?.orderId ?? null

          // Poll every 2s for up to 30s — cancel if still resting after timeout
          if (orderId) {
            let filled = false
            for (let i = 0; i < 15; i++) {
              await new Promise(r => setTimeout(r, 2000))
              try {
                const statusRes = await fetch(`/api/orders/${orderId}`)
                if (statusRes.ok) {
                  const s = await statusRes.json()
                  const status = s?.order?.status ?? s?.status
                  if (status === 'filled' || status === 'closed') { filled = true; break }
                  if (status === 'canceled' || status === 'expired') break
                }
              } catch { break }
            }
            // Cancel unfilled resting order after 30s
            if (!filled) {
              fetch(`/api/cancel-order/${orderId}`, { method: 'DELETE' }).catch(() => {})
            }
          }
        } catch { /* live order failed — continue */ }
      }

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
      // Snapshot price so the delta watcher can measure movement since this run
      if (btcPriceRef.current)    lastCyclePriceRef.current  = btcPriceRef.current
      if (strikePriceRef.current) lastCycleStrikeRef.current = strikePriceRef.current
      // AI mode shows 90s cooldown; quant shows full 5-min countdown
      setNextCycleIn(aiRisk ? MIN_COOLDOWN_MS / 1000 : CYCLE_INTERVAL_MS / 1000)
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

  // Quant mode: fixed 5-min clock
  useEffect(() => {
    if (!autoTrade || aiRisk) return
    setTimeout(() => runCycleRef.current?.(), 50)
    autoIntervalRef.current = setInterval(() => runCycleRef.current?.(), CYCLE_INTERVAL_MS)
    return () => {
      if (autoIntervalRef.current) { clearInterval(autoIntervalRef.current); autoIntervalRef.current = null }
    }
  }, [autoTrade, aiRisk])

  // AI mode: event-driven delta monitor — fires immediately, then checks every 15s
  useEffect(() => {
    if (!autoTrade || !aiRisk) return
    setTimeout(() => runCycleRef.current?.(), 50)
    const tid = setInterval(() => {
      if (isRunningRef.current) return
      const now = Date.now()
      const sinceLastCycle = now - lastCycleRef.current
      // Respect cooldown — never hammer Grok faster than 90s
      if (sinceLastCycle < MIN_COOLDOWN_MS) return

      const price  = btcPriceRef.current
      const strike = strikePriceRef.current
      const lastP  = lastCyclePriceRef.current
      const lastS  = lastCycleStrikeRef.current

      // Update live delta display (signed: + = moved up, - = moved down from last run)
      if (price && lastP > 0) setMonitorDeltaPct((price - lastP) / lastP * 100)

      // Stale fallback: force run after 5 min regardless
      if (sinceLastCycle >= CYCLE_INTERVAL_MS) {
        runCycleRef.current?.()
        return
      }

      // Strike cross: BTC flipped which side of strike since last run → re-assess immediately
      if (price && strike && lastP > 0 && lastS > 0) {
        const wasAbove = lastP >= lastS
        const isAbove  = price >= strike
        if (wasAbove !== isAbove) {
          runCycleRef.current?.()
          return
        }
      }

      // Price delta trigger: meaningful directional move
      if (price && lastP > 0) {
        const deltaPct = Math.abs(price - lastP) / lastP * 100
        if (deltaPct >= PRICE_DELTA_TRIGGER_PCT) {
          runCycleRef.current?.()
        }
      }
    }, AI_WATCHER_INTERVAL_MS)
    return () => clearInterval(tid)
  }, [autoTrade, aiRisk])

  // Countdown timer
  useEffect(() => {
    countdownRef.current = setInterval(() => setNextCycleIn(prev => Math.max(0, prev - 1)), 1000)
    return () => { if (countdownRef.current) clearInterval(countdownRef.current) }
  }, [])

  return { pipeline, history, streamingAgents, isRunning, serverLocked, nextCycleIn, error, runCycle, stopCycle, monitorDeltaPct }
}
