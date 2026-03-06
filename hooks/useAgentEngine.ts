'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import type { PipelineState, PartialPipelineAgents, AgentTrade, AgentStats, KalshiMarket } from '@/lib/types'

// Target entry: 12 min before window close (well inside 3–12 min window)
const TARGET_MINUTES_BEFORE_CLOSE = 10
const MIN_MINUTES_LEFT = 3
const MAX_MINUTES_LEFT = 12
const POST_WINDOW_BUFFER_MS = 30_000  // wait 30s after window close before next scheduling

/** Compute the next 15-min Kalshi window close time (UTC-aligned 15-min grid). */
function getWindowClose(): number {
  const boundary = 15 * 60 * 1000
  return Math.ceil(Date.now() / boundary) * boundary
}

/**
 * Returns how long to wait (ms) before running the pipeline.
 *
 * Strategy:
 *  - Already in the 3–12 min range → run immediately (0 ms)
 *  - More than 12 min left → wait until TARGET_MINUTES_BEFORE_CLOSE mark
 *  - Less than 3 min left → skip this window, wait until TARGET mark of next window
 */
function getDelayMs(): { delayMs: number; closeMs: number; minutesLeft: number } {
  const closeMs = getWindowClose()
  const minutesLeft = (closeMs - Date.now()) / 60_000

  let delayMs: number
  if (minutesLeft >= MIN_MINUTES_LEFT && minutesLeft <= MAX_MINUTES_LEFT) {
    delayMs = 0
  } else if (minutesLeft > MAX_MINUTES_LEFT) {
    delayMs = (minutesLeft - TARGET_MINUTES_BEFORE_CLOSE) * 60_000
  } else {
    // < 3 min — skip, enter next window at TARGET mark
    const nextCloseMs = closeMs + 15 * 60_000
    delayMs = nextCloseMs - Date.now() - TARGET_MINUTES_BEFORE_CLOSE * 60_000
  }

  return { delayMs: Math.max(0, delayMs), closeMs, minutesLeft }
}

function computeAgentStats(trades: AgentTrade[]): AgentStats {
  // Only count confirmed live orders — exclude failed attempts (no liveOrderId)
  const confirmed = trades.filter(t => t.liveOrderId)
  const settled   = confirmed.filter(t => t.status !== 'open')
  const wins      = settled.filter(t => t.status === 'won')

  const windowKeys = [...new Set(confirmed.map(t => t.windowKey))]
  const windowPnls = windowKeys.map(wk =>
    confirmed.filter(t => t.windowKey === wk).reduce((s, t) => s + (t.pnl ?? 0), 0)
  )

  return {
    windowsTraded: windowKeys.length,
    totalSlices: confirmed.length,
    totalDeployed: confirmed.reduce((s, t) => s + t.cost, 0),
    totalPnl: settled.reduce((s, t) => s + (t.pnl ?? 0), 0),
    wins: wins.length,
    losses: settled.length - wins.length,
    winRate: settled.length > 0 ? wins.length / settled.length : 0,
    bestWindow: windowPnls.length ? Math.max(...windowPnls) : 0,
    worstWindow: windowPnls.length ? Math.min(...windowPnls) : 0,
  }
}

function settleAgentTrade(trade: AgentTrade, settlementPrice: number, result?: 'yes' | 'no'): AgentTrade {
  const win = result != null
    ? trade.side === result
    : (trade.side === 'yes' ? settlementPrice > trade.strikePrice : settlementPrice <= trade.strikePrice)
  const pnl = win ? trade.contracts - trade.cost : -trade.cost
  return { ...trade, status: win ? 'won' : 'lost', settlementPrice, pnl }
}

/** Fetch actual Kalshi market result for a settled market. Falls back to null if not yet settled. */
async function fetchMarketResult(ticker: string): Promise<{ result: 'yes' | 'no' } | null> {
  try {
    const res = await fetch(`/api/market-quote/${encodeURIComponent(ticker)}`, { cache: 'no-store' })
    if (!res.ok) return null
    const { market }: { market: KalshiMarket } = await res.json()
    if (market?.result === 'yes' || market?.result === 'no') return { result: market.result as 'yes' | 'no' }
  } catch {}
  return null
}

export function useAgentEngine(orModel?: string) {
  const [active, setActive]                     = useState(false)
  const [allowance, setAllowance]               = useState(100)
  const [initialAllowance, setInitialAllowance] = useState(100)
  const [trades, setTrades]                     = useState<AgentTrade[]>([])
  const [tradesLoaded, setTradesLoaded]         = useState(false)
  const [pipeline, setPipeline]                 = useState<PipelineState | null>(null)
  const [streamingAgents, setStreamingAgents]   = useState<PartialPipelineAgents>({})
  const [isRunning, setIsRunning]               = useState(false)
  const [nextCycleIn, setNextCycleIn]           = useState(0)
  const [error, setError]                       = useState<string | null>(null)
  const [orderError, setOrderError]             = useState<string | null>(null)
  const [currentD, setCurrentD]                 = useState(0)
  const [lastPollAt, setLastPollAt]             = useState<number | null>(null)

  // Current window tracking — one bet per 15-min window
  const [windowKey, setWindowKey]               = useState<string | null>(null)
  const [windowBetPlaced, setWindowBetPlaced]   = useState(false)

  const windowKeyRef      = useRef<string | null>(null)
  const windowBetRef      = useRef(false)
  const allowanceRef      = useRef(100)
  const tradesRef         = useRef<AgentTrade[]>([])
  const autoTimeoutRef    = useRef<ReturnType<typeof setTimeout> | null>(null)
  const countdownRef      = useRef<ReturnType<typeof setInterval> | null>(null)
  const dPollerRef        = useRef<ReturnType<typeof setInterval> | null>(null)
  const nextRunAtRef      = useRef<number>(0)
  const runCycleRef       = useRef<(() => Promise<void>) | null>(null)
  const abortRef          = useRef<AbortController | null>(null)
  const activeRef         = useRef(false)
  const isRunningRef      = useRef(false)
  const processResultRef  = useRef<((data: PipelineState) => Promise<void>) | null>(null)
  const orderFailedRef    = useRef(false)
  const gkVolRef          = useRef(0.002)   // default 0.2%/candle; updated from pipeline
  const strikeRef         = useRef<number>(0)

  useEffect(() => { allowanceRef.current = allowance }, [allowance])
  useEffect(() => { activeRef.current = active }, [active])
  useEffect(() => { tradesRef.current = trades }, [trades])

  // ── Restore persisted state on mount ─────────────────────────────────────
  useEffect(() => {
    try {
      const saved = localStorage.getItem('sentient-agent-trades')
      const all: AgentTrade[] = saved ? JSON.parse(saved) : []
      // Auto-purge failed trades (no liveOrderId) on mount — keep only confirmed orders
      const parsed = all.filter(t => t.liveOrderId)
      if (parsed.length > 0) {
        setTrades(parsed)
        // Only lock window if there's a confirmed live order (not a failed attempt)
        const confirmedOpen = parsed.filter(
          t => t.status === 'open' && t.liveOrderId && new Date(t.expiresAt).getTime() > Date.now()
        )
        if (confirmedOpen.length > 0) {
          const lastKey = confirmedOpen[confirmedOpen.length - 1].windowKey
          windowKeyRef.current = lastKey
          windowBetRef.current = true
          setWindowKey(lastKey)
          setWindowBetPlaced(true)
        }
      }
    } catch {}
    setTradesLoaded(true)

    try {
      const n = Number(localStorage.getItem('sentient-agent-allowance'))
      if (!isNaN(n) && n > 0) { setAllowance(n); allowanceRef.current = n }
    } catch {}

    try {
      const n = Number(localStorage.getItem('sentient-agent-initial-allowance'))
      if (!isNaN(n) && n > 0) setInitialAllowance(n)
    } catch {}

    try {
      const saved = localStorage.getItem('sentient-pipeline')
      if (saved) {
        const parsed = JSON.parse(saved) as PipelineState
        const closeTime = parsed.agents?.marketDiscovery?.output?.activeMarket?.close_time
        if (closeTime && new Date(closeTime).getTime() > Date.now()) setPipeline(parsed)
      }
    } catch {}

    try {
      if (localStorage.getItem('sentient-agent-active') === 'true') setActive(true)
    } catch {}
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Persist ───────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!tradesLoaded) return
    try { localStorage.setItem('sentient-agent-trades', JSON.stringify(trades)) } catch {}
  }, [trades, tradesLoaded])

  useEffect(() => {
    if (!tradesLoaded) return
    try { localStorage.setItem('sentient-agent-allowance', String(allowance)) } catch {}
  }, [allowance, tradesLoaded])

  useEffect(() => {
    if (!tradesLoaded) return
    try { localStorage.setItem('sentient-agent-initial-allowance', String(initialAllowance)) } catch {}
  }, [initialAllowance, tradesLoaded])

  useEffect(() => {
    if (!tradesLoaded) return
    try { localStorage.setItem('sentient-agent-active', String(active)) } catch {}
  }, [active, tradesLoaded])

  // ── Methods ───────────────────────────────────────────────────────────────
  const giveAllowance = useCallback((amount: number) => {
    setAllowance(prev => { const n = Math.max(0, prev + amount); allowanceRef.current = n; return n })
  }, [])

  const setAllowanceAmount = useCallback((amount: number) => {
    const n = Math.max(0, amount)
    setAllowance(n)
    allowanceRef.current = n
  }, [])

  const clearHistory = useCallback(() => {
    setTrades([])
    tradesRef.current = []
    windowKeyRef.current = null
    windowBetRef.current = false
    setWindowKey(null)
    setWindowBetPlaced(false)
    try { localStorage.removeItem('sentient-agent-trades') } catch {}
  }, [])

  // ── Process pipeline result ────────────────────────────────────────────────
  const processResult = useCallback(async (data: PipelineState) => {
    setPipeline(data)

    const exec = data.agents.execution.output
    const md   = data.agents.marketDiscovery.output
    const pf   = data.agents.priceFeed.output
    const prob = data.agents.probability.output

    const evTicker = (md.activeMarket as { event_ticker?: string } | undefined)?.event_ticker
      ?? md.activeMarket?.ticker.split('-').slice(0, 2).join('-')
      ?? null

    // Update vol and strike for d-poller
    if (md.strikePrice > 0) strikeRef.current = md.strikePrice
    if (prob.gkVol15m && prob.gkVol15m > 0) gkVolRef.current = prob.gkVol15m

    // New window → allow a fresh bet and reset direction tracking
    if (evTicker && evTicker !== windowKeyRef.current) {
      windowKeyRef.current = evTicker
      windowBetRef.current = false
      setWindowKey(evTicker)
      setWindowBetPlaced(false)
    }

    // Place bet — trust risk manager, no redundant edge check
    const risk = data.agents.risk.output
    if (
      exec.action !== 'PASS' &&
      exec.side != null &&
      exec.limitPrice != null &&
      risk.approved &&
      md.activeMarket &&
      evTicker &&
      allowanceRef.current >= 1 &&
      !windowBetRef.current
    ) {
      const betBudget  = allowanceRef.current
      const costPerContract = exec.limitPrice / 100
      // Use risk manager's Kelly-sized contracts, capped by user's bet budget
      const budgetContracts = Math.floor(betBudget / costPerContract)
      const contracts  = Math.max(1, Math.min(risk.positionSize, budgetContracts))
      const cost       = contracts * costPerContract

      let liveOrderId: string | undefined
      let orderError: string | undefined
      try {
        const orderRes = await fetch('/api/place-order', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ticker: exec.marketTicker,
              side: exec.side,
              count: contracts,
              // Aggressive price: +2¢ above ask to ensure fill_or_kill fills immediately
              yesPrice: exec.side === 'yes'
                ? Math.min(99, exec.limitPrice + 2)
                : Math.min(99, (100 - exec.limitPrice) + 2),
              clientOrderId: `agent-${data.cycleId}-${Date.now()}`,
            }),
          })
          const od = await orderRes.json()
          if (orderRes.ok) {
            liveOrderId = od.order?.order_id
          } else {
            orderError = od.error ?? `Order failed (${orderRes.status})`
          }
        } catch (e) {
          orderError = String(e)
        }

      const trade: AgentTrade = {
        id: `${data.cycleId}-${Date.now()}`,
        cycleId: data.cycleId,
        windowKey: evTicker,
        sliceNum: 1,
        side: exec.side,
        limitPrice: exec.limitPrice,
        contracts,
        cost,
        marketTicker: exec.marketTicker,
        strikePrice: md.strikePrice,
        expiresAt: md.activeMarket.close_time,
        enteredAt: new Date().toISOString(),
        status: 'open',
        pModel: prob.pModel,
        pMarket: prob.pMarket,
        edge: prob.edge,
        liveOrderId,
        orderError,
      }

      setTrades(prev => [...prev, trade])
      if (liveOrderId) {
        windowBetRef.current = true
        setWindowBetPlaced(true)
        setOrderError(null)
        notify(
          `Sentient: Bet placed — ${exec.side?.toUpperCase()}`,
          `${contracts}× @ ${exec.limitPrice}¢ on ${evTicker} | edge ${(prob.edge * 100).toFixed(1)}%`
        )
      } else if (orderError) {
        orderFailedRef.current = true
        setOrderError(orderError)
        notify('Sentient: Order failed', orderError)
      }
    }

    // Settle expired trades — only confirmed live orders (liveOrderId present)
    const now = Date.now()
    const expiredTrades = tradesRef.current.filter(
      t => t.status === 'open' && t.liveOrderId && now >= new Date(t.expiresAt).getTime()
    )
    if (expiredTrades.length > 0) {
      const settled = await Promise.all(expiredTrades.map(async t => {
        const marketResult = await fetchMarketResult(t.marketTicker)
        return settleAgentTrade(t, pf.currentPrice, marketResult?.result)
      }))
      setTrades(prev => prev.map(t => settled.find(s => s.id === t.id) ?? t))
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => { processResultRef.current = processResult }, [processResult])

  // ── React to pipeline updates from other tabs ─────────────────────────────
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key !== 'sentient-pipeline' || !e.newValue) return
      if (!activeRef.current || isRunningRef.current) return
      try { processResultRef.current?.(JSON.parse(e.newValue)) } catch {}
    }
    window.addEventListener('storage', handler)
    return () => window.removeEventListener('storage', handler)
  }, [])

  // ── Browser notifications ─────────────────────────────────────────────────
  const notify = useCallback((title: string, body: string) => {
    if (typeof window === 'undefined' || !('Notification' in window)) return
    if (Notification.permission === 'granted') {
      new Notification(title, { body, icon: '/favicon.ico', tag: 'sentient-agent' })
    }
  }, [])

// ── D-poller: poll BTC price every 30s, fire when |d| > threshold ───────────
  const CONFIDENCE_THRESHOLD = 1.0  // |d|>1 → ~84% theoretical WR; achievable at 3-5 min left

  const stopDPoller = useCallback(() => {
    if (dPollerRef.current) { clearInterval(dPollerRef.current); dPollerRef.current = null }
  }, [])

  const startDPoller = useCallback((closeMs: number) => {
    stopDPoller()

    const check = async () => {
      if (!activeRef.current || isRunningRef.current || windowBetRef.current) return
      const minutesLeft = (closeMs - Date.now()) / 60_000

      if (minutesLeft < MIN_MINUTES_LEFT) {
        stopDPoller()
        return  // window closed — runCycle's finally handles next scheduling
      }

      // Bootstrap: if we don't have strike yet, run the pipeline once to get it
      if (strikeRef.current <= 0) {
        stopDPoller()
        runCycleRef.current?.()
        return
      }

      try {
        const res = await fetch('/api/btc-price')
        if (!res.ok) return
        const { price } = await res.json()
        if (!price || price <= 0) return

        const vol         = gkVolRef.current
        const candlesLeft = minutesLeft / 15
        const d           = Math.log(price / strikeRef.current) / (vol * Math.sqrt(candlesLeft))
        setCurrentD(d)
        setLastPollAt(Date.now())

        if (Math.abs(d) >= CONFIDENCE_THRESHOLD) {
          stopDPoller()
          notify('Sentient: Signal locked', `d=${Math.abs(d).toFixed(2)} — BTC ${d > 0 ? 'above' : 'below'} strike, running analysis`)
          runCycleRef.current?.()
        }
      } catch {}
    }

    check()  // immediate on start
    dPollerRef.current = setInterval(check, 30_000)
  }, [stopDPoller])

  // ── Schedule: wait for valid window, then start d-poller ─────────────────
  const scheduleNextRun = useCallback(() => {
    if (!activeRef.current) return
    if (autoTimeoutRef.current) { clearTimeout(autoTimeoutRef.current); autoTimeoutRef.current = null }
    stopDPoller()

    const { delayMs, closeMs, minutesLeft } = getDelayMs()

    if (delayMs === 0) {
      // Already in valid window — start poller immediately
      startDPoller(closeMs)
      nextRunAtRef.current = closeMs - MIN_MINUTES_LEFT * 60_000
      setNextCycleIn(Math.round((minutesLeft - MIN_MINUTES_LEFT) * 60))
    } else {
      // Wait until valid window opens, then start poller
      nextRunAtRef.current = Date.now() + delayMs
      setNextCycleIn(Math.round(delayMs / 1000))
      autoTimeoutRef.current = setTimeout(() => {
        if (!activeRef.current) return
        const { closeMs: cm } = getDelayMs()
        startDPoller(cm)
      }, delayMs)
    }
  }, [startDPoller, stopDPoller])

  // ── Core cycle ────────────────────────────────────────────────────────────
  const runCycle = useCallback(async () => {
    if (isRunningRef.current) return
    isRunningRef.current = true
    setIsRunning(true)
    setError(null)
    setStreamingAgents({})
    const controller = new AbortController()
    abortRef.current = controller

    // Capture close time before the run so we wait for this window to end
    const { closeMs } = getDelayMs()

    try {
      const params = new URLSearchParams()
      if (orModel) params.set('orModel', orModel)

      const reqHeaders: Record<string, string> = { Accept: 'text/event-stream' }
      try {
        const storedKeys = localStorage.getItem('sentient-provider-keys')
        if (storedKeys) {
          const parsed = JSON.parse(storedKeys) as Record<string, string>
          const nonEmpty = Object.fromEntries(Object.entries(parsed).filter(([, v]) => v?.trim()))
          if (Object.keys(nonEmpty).length > 0) reqHeaders['x-provider-keys'] = btoa(JSON.stringify(nonEmpty))
        }
      } catch {}

      const res = await fetch(`/api/pipeline?${params}`, {
        cache: 'no-store', signal: controller.signal, headers: reqHeaders,
      })

      if (!res.ok) {
        if (res.status === 503) throw new Error('No active KXBTC15M market — trading hours are ~11:30 AM–midnight ET weekdays')
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `Pipeline error ${res.status}`)
      }

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
            const lines = chunk.split('\n')
            const evType = lines.find(l => l.startsWith('event: '))?.slice(7)?.trim()
            const raw = lines.find(l => l.startsWith('data: '))?.slice(6)
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
              throw Object.assign(new Error('Stopped'), { name: 'AbortError' })
            }
          }
        }
      } finally {
        reader.cancel().catch(() => {})
      }

      if (!data) throw new Error('Pipeline stream ended without result')
      try { localStorage.setItem('sentient-pipeline', JSON.stringify(data)) } catch {}
      await processResult(data)

    } catch (err) {
      const isAbort = err instanceof Error && (err.name === 'AbortError' || err.message?.toLowerCase().includes('abort'))
      if (!isAbort) setError(String(err))
    } finally {
      isRunningRef.current = false
      setIsRunning(false)
      stopDPoller()

      if (activeRef.current) {
        const { minutesLeft } = getDelayMs()
        const failed = orderFailedRef.current
        orderFailedRef.current = false

        if (failed && minutesLeft >= MIN_MINUTES_LEFT) {
          // Order failed but window still open — retry d-poller in 60s
          // so user can fix balance/issue and get another attempt this window
          const retryMs = 60_000
          nextRunAtRef.current = Date.now() + retryMs
          setNextCycleIn(Math.round(retryMs / 1000))
          autoTimeoutRef.current = setTimeout(() => {
            if (activeRef.current) {
              const { closeMs: cm } = getDelayMs()
              startDPoller(cm)
            }
          }, retryMs)
        } else {
          // Normal: wait until window closes + buffer, then schedule next window
          const waitMs = Math.max(POST_WINDOW_BUFFER_MS, closeMs - Date.now() + POST_WINDOW_BUFFER_MS)
          nextRunAtRef.current = Date.now() + waitMs
          setNextCycleIn(Math.round(waitMs / 1000))
          autoTimeoutRef.current = setTimeout(() => {
            if (activeRef.current) scheduleNextRun()
          }, waitMs)
        }
      }
    }
  }, [orModel, processResult, scheduleNextRun])

  useEffect(() => { runCycleRef.current = runCycle }, [runCycle])

  // ── Start / Stop ──────────────────────────────────────────────────────────
  const stopAgent = useCallback(() => {
    setActive(false)
    activeRef.current = false
    if (autoTimeoutRef.current) { clearTimeout(autoTimeoutRef.current); autoTimeoutRef.current = null }
    if (dPollerRef.current) { clearInterval(dPollerRef.current); dPollerRef.current = null }
    const c = abortRef.current
    if (c) setTimeout(() => { try { c.abort() } catch {} }, 0)
  }, [])

  const startAgent = useCallback((startingAllowance: number) => {
    setInitialAllowance(startingAllowance)
    setActive(true)
  }, [])

  // When active flips on, kick off the window-aware scheduling loop
  useEffect(() => {
    if (active) {
      activeRef.current = true
      scheduleNextRun()
    }
    return () => {
      if (autoTimeoutRef.current) { clearTimeout(autoTimeoutRef.current); autoTimeoutRef.current = null }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  // ── Countdown timer (1s tick) ─────────────────────────────────────────────
  useEffect(() => {
    countdownRef.current = setInterval(() => {
      const remaining = Math.max(0, Math.round((nextRunAtRef.current - Date.now()) / 1000))
      setNextCycleIn(remaining)
    }, 1000)
    return () => { if (countdownRef.current) clearInterval(countdownRef.current) }
  }, [])

  return {
    active, allowance, initialAllowance,
    trades, pipeline, streamingAgents,
    isRunning, nextCycleIn, error, orderError,
    stats: computeAgentStats(trades),
    windowKey, windowBetPlaced,
    currentD, confidenceThreshold: CONFIDENCE_THRESHOLD, lastPollAt,
    giveAllowance, setAllowanceAmount, startAgent, stopAgent, runCycle, clearHistory,
  }
}
