/**
 * Server-side autonomous trading agent.
 *
 * Runs entirely in Node.js — immune to browser tab throttling/suspension.
 * Browser clients subscribe for real-time updates via /api/agent/stream (SSE).
 *
 * Lifecycle:
 *   start(allowance) → scheduleNextRun() → [wait for valid window] →
 *   startDPoller() → [poll BTC every 30s] → d ≥ threshold →
 *   runCycle() → processResult() → placeOrder() → wait for next window → repeat
 */

import { EventEmitter } from 'events'
import { runAgentPipeline } from './agents'
import { buildKalshiHeaders } from './kalshi-auth'
import { getBalance, placeOrder, limitSellOrder } from './kalshi-trade'
import { tryLockPipeline, releasePipelineLock } from './pipeline-lock'
import type {
  PipelineState, AgentTrade, AgentStats,
  KalshiMarket, KalshiOrderbook, BTCQuote, OHLCVCandle, DerivativesSignal,
} from './types'
import { normalizeKalshiMarket } from './types'
import type { AIProvider } from './llm-client'
import { CONFIDENCE_THRESHOLD, KELLY_FRACTION } from './agent-shared'
import type { AgentStateSnapshot, AgentPhase } from './agent-shared'

export { CONFIDENCE_THRESHOLD }
export type { AgentStateSnapshot }

// ── Constants ────────────────────────────────────────────────────────────────
const TARGET_MINUTES_BEFORE_CLOSE = 10
const MIN_MINUTES_LEFT  = 3
const MAX_MINUTES_LEFT  = 12
const POST_WINDOW_BUFFER_MS = 30_000

// ── Window timing helpers ────────────────────────────────────────────────────
function getWindowClose(): number {
  const boundary = 15 * 60 * 1000
  return Math.ceil(Date.now() / boundary) * boundary
}

function getDelayMs(): { delayMs: number; closeMs: number; minutesLeft: number } {
  const closeMs    = getWindowClose()
  const minutesLeft = (closeMs - Date.now()) / 60_000
  let delayMs: number

  if (minutesLeft >= MIN_MINUTES_LEFT && minutesLeft <= MAX_MINUTES_LEFT) {
    delayMs = 0
  } else if (minutesLeft > MAX_MINUTES_LEFT) {
    delayMs = (minutesLeft - TARGET_MINUTES_BEFORE_CLOSE) * 60_000
  } else {
    const nextCloseMs = closeMs + 15 * 60_000
    delayMs = nextCloseMs - Date.now() - TARGET_MINUTES_BEFORE_CLOSE * 60_000
  }

  return { delayMs: Math.max(0, delayMs), closeMs, minutesLeft }
}

function getCurrentEventTicker(): string {
  const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC']
  const now    = new Date()
  const parts  = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', hour12: false,
    }).formatToParts(now)
      .filter(p => p.type !== 'literal')
      .map(p => [p.type, parseInt(p.value)])
  ) as Record<string, number>

  const { year, month, day, hour, minute } = parts
  let blockMin  = Math.ceil((minute + 1) / 15) * 15
  let blockHour = hour % 24
  if (blockMin >= 60) { blockMin = 0; blockHour += 1 }

  const yy  = String(year).slice(-2)
  const mon = MONTHS[month - 1]
  const dd  = String(day).padStart(2, '0')
  const hh  = String(blockHour).padStart(2, '0')
  const mm  = String(blockMin).padStart(2, '0')
  return `KXBTC15M-${yy}${mon}${dd}${hh}${mm}`
}

function computeStats(trades: AgentTrade[]): AgentStats {
  const confirmed   = trades.filter(t => t.liveOrderId)
  const settled     = confirmed.filter(t => t.status !== 'open')
  const wins        = settled.filter(t => t.status === 'won')
  const windowKeys  = [...new Set(confirmed.map(t => t.windowKey))]
  const windowPnls  = windowKeys.map(wk =>
    confirmed.filter(t => t.windowKey === wk).reduce((s, t) => s + (t.pnl ?? 0), 0)
  )
  return {
    windowsTraded:  windowKeys.length,
    totalSlices:    confirmed.length,
    totalDeployed:  confirmed.reduce((s, t) => s + t.cost, 0),
    totalPnl:       settled.reduce((s, t) => s + (t.pnl ?? 0), 0),
    wins:           wins.length,
    losses:         settled.length - wins.length,
    winRate:        settled.length > 0 ? wins.length / settled.length : 0,
    bestWindow:     windowPnls.length ? Math.max(...windowPnls) : 0,
    worstWindow:    windowPnls.length ? Math.min(...windowPnls) : 0,
  }
}

// ── Server Agent ─────────────────────────────────────────────────────────────
class ServerAgent extends EventEmitter {
  private active           = false
  private allowance        = 100
  private initialAllowance = 100
  private isRunning        = false
  private windowKey:   string | null = null
  private windowBetPlaced = false
  private currentD     = 0
  private lastPollAt:  number | null = null
  private nextCycleIn  = 0
  private error:       string | null = null
  private orderError:  string | null = null
  private trades:      AgentTrade[]  = []
  private pipeline:    PipelineState | null = null

  private autoTimeout:       NodeJS.Timeout | null = null
  private pollerInterval:    NodeJS.Timeout | null = null
  private countdownInterval: NodeJS.Timeout | null = null
  private settlementInterval: NodeJS.Timeout | null = null
  private nextRunAt    = 0
  private strikePrice  = 0
  private gkVol        = 0.002
  private orderFailed    = false
  private pipelineError  = false
  private kellyMode      = false
  private kellyPct       = 0.25   // fraction e.g. 0.25 = 25%
  private bankroll       = 0
  private orModel:     string | undefined
  private agentPhase: AgentPhase = 'idle'
  private windowCloseAt = 0

  // ── Public API ─────────────────────────────────────────────────────────────

  start(allowance: number, orModel?: string, kellyMode = false, bankroll?: number, kellyPct = 0.25) {
    if (this.active) {
      this.allowance  = allowance
      this.orModel    = orModel
      this.kellyMode  = kellyMode
      this.kellyPct   = kellyPct
      if (kellyMode && bankroll && bankroll > 0) {
        this.bankroll  = bankroll
        this.allowance = Math.max(1, bankroll * kellyPct)
      }
      this.pushState()
      return
    }
    this.kellyMode        = kellyMode
    this.kellyPct         = kellyPct
    this.bankroll         = kellyMode && bankroll && bankroll > 0 ? bankroll : allowance / kellyPct
    this.allowance        = kellyMode ? Math.max(1, this.bankroll * kellyPct) : allowance
    this.initialAllowance = this.allowance
    this.orModel          = orModel
    this.active           = true
    this.error            = null
    this.orderError       = null
    this.agentPhase       = 'waiting'
    this.startCountdown()
    this.startSettlementLoop()
    this.scheduleNextRun()
    this.pushState()
    console.log(`[ServerAgent] Started — ${kellyMode ? `Kelly ${kellyPct*100}% bankroll=$${this.bankroll} allowance=$${this.allowance.toFixed(2)}` : `fixed allowance=$${allowance}`}`)
  }

  stop() {
    this.active     = false
    this.isRunning  = false
    this.agentPhase = 'idle'
    this.clearTimers()
    this.pushState()
    console.log('[ServerAgent] Stopped')
  }

  setAllowance(amount: number, kellyMode?: boolean, bankroll?: number) {
    if (kellyMode !== undefined) this.kellyMode = kellyMode
    if (this.kellyMode && bankroll && bankroll > 0) {
      this.bankroll  = bankroll
      this.allowance = Math.max(1, bankroll * KELLY_FRACTION)
    } else if (!this.kellyMode) {
      this.allowance = Math.max(0, amount)
    }
    this.pushState()
  }

  clearHistory() {
    this.trades          = []
    this.windowKey       = null
    this.windowBetPlaced = false
    this.pushState()
  }

  async triggerCycle() {
    if (this.isRunning) return
    if (this.autoTimeout) { clearTimeout(this.autoTimeout); this.autoTimeout = null }
    this.stopDPoller()
    await this.runCycle()
  }

  getState(): AgentStateSnapshot {
    return {
      active:           this.active,
      allowance:        this.allowance,
      initialAllowance: this.initialAllowance,
      bankroll:         this.bankroll,
      kellyMode:        this.kellyMode,
      isRunning:        this.isRunning,
      windowKey:        this.windowKey,
      windowBetPlaced:  this.windowBetPlaced,
      currentD:         this.currentD,
      lastPollAt:       this.lastPollAt,
      nextCycleIn:      this.nextCycleIn,
      error:            this.error,
      orderError:       this.orderError,
      trades:           this.trades,
      stats:            computeStats(this.trades),
      pipeline:         this.pipeline,
      strikePrice:      this.strikePrice,
      gkVol:            this.gkVol,
      agentPhase:       this.agentPhase,
      windowCloseAt:    this.windowCloseAt,
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private pushState() {
    this.emit('state', this.getState())
  }

  private startCountdown() {
    if (this.countdownInterval) clearInterval(this.countdownInterval)
    this.countdownInterval = setInterval(() => {
      const remaining = Math.max(0, Math.round((this.nextRunAt - Date.now()) / 1000))
      if (remaining !== this.nextCycleIn) {
        this.nextCycleIn = remaining
        this.pushState()
      }
    }, 1000)
  }

  private clearTimers() {
    if (this.autoTimeout)        { clearTimeout(this.autoTimeout);          this.autoTimeout        = null }
    if (this.countdownInterval)  { clearInterval(this.countdownInterval);   this.countdownInterval  = null }
    if (this.settlementInterval) { clearInterval(this.settlementInterval);  this.settlementInterval = null }
    this.stopDPoller()
  }

  private stopDPoller() {
    if (this.pollerInterval) { clearInterval(this.pollerInterval); this.pollerInterval = null }
  }

  private startSettlementLoop() {
    if (this.settlementInterval) clearInterval(this.settlementInterval)
    this.settlementInterval = setInterval(() => {
      if (this.active) this.checkSettlements().catch(e => console.error('[ServerAgent] settlement loop error:', e))
    }, 30_000)
  }

  private async checkSettlements() {
    const now = Date.now()
    const expired = this.trades.filter(
      t => t.status === 'open' && t.liveOrderId && now >= new Date(t.expiresAt).getTime()
    )
    if (!expired.length) return

    const settled = await Promise.all(expired.map(async t => {
      try {
        const path = `/trade-api/v2/markets/${encodeURIComponent(t.marketTicker)}`
        const res  = await fetch(`https://api.elections.kalshi.com${path}`, {
          headers: { ...buildKalshiHeaders('GET', path), Accept: 'application/json' },
          cache: 'no-store',
        })
        if (res.ok) {
          const { market } = await res.json()
          if (market?.result === 'yes' || market?.result === 'no') {
            const win = t.side === market.result
            return { ...t, status: (win ? 'won' : 'lost') as 'won' | 'lost', pnl: win ? t.contracts - t.cost : -t.cost }
          }
        }
      } catch {}
      return t
    }))

    const justSettled = settled.filter(s => s.status !== 'open')
    if (!justSettled.length) return

    this.trades = this.trades.map(t => settled.find(s => s.id === t.id) ?? t)

    if (this.kellyMode) {
      for (const t of justSettled) {
        if (t.status === 'won') this.bankroll += t.contracts
      }
      this.bankroll  = Math.max(1, this.bankroll)
      this.allowance = Math.max(1, Math.round(this.bankroll * this.kellyPct * 100) / 100)
      console.log(`[ServerAgent] Kelly update — bankroll=$${this.bankroll.toFixed(2)} → allowance=$${this.allowance.toFixed(2)}`)
    }

    this.pushState()
    console.log(`[ServerAgent] Settled ${justSettled.length} trade(s) via background loop`)
  }

  private startDPoller(closeMs: number) {
    this.stopDPoller()
    // Starting fresh for a new window — clear bet flag and stale d-score display
    this.windowBetPlaced = false
    this.lastPollAt      = null
    this.currentD        = 0
    this.windowCloseAt   = closeMs
    this.agentPhase      = this.strikePrice > 0 ? 'monitoring' : 'bootstrap'
    this.pushState()

    const check = async () => {
      if (!this.active || this.isRunning || this.windowBetPlaced) return

      const minutesLeft = (closeMs - Date.now()) / 60_000
      if (minutesLeft < MIN_MINUTES_LEFT) {
        this.stopDPoller()
        // Window expiring without a bet — schedule next window
        if (!this.windowBetPlaced && !this.autoTimeout) {
          const waitMs = Math.max(POST_WINDOW_BUFFER_MS, closeMs - Date.now() + POST_WINDOW_BUFFER_MS)
          this.nextRunAt   = Date.now() + waitMs
          this.nextCycleIn = Math.round(waitMs / 1000)
          this.autoTimeout = setTimeout(() => { if (this.active) this.scheduleNextRun() }, waitMs)
          this.pushState()
          console.log(`[ServerAgent] Window expiring without bet — next window in ${Math.round(waitMs/1000)}s`)
        }
        return
      }

      // Bootstrap: no strike yet → run pipeline once to get market data
      if (this.strikePrice <= 0) {
        this.stopDPoller()
        await this.runCycle()
        return
      }

      try {
        const res = await fetch('https://api.coinbase.com/v2/prices/BTC-USD/spot', { cache: 'no-store' })
        if (!res.ok) return
        const { data } = await res.json()
        const price = parseFloat(data?.amount)
        if (!price || price <= 0) return

        const candlesLeft = minutesLeft / 15
        const d = Math.log(price / this.strikePrice) / (this.gkVol * Math.sqrt(candlesLeft))
        this.currentD   = d
        this.lastPollAt = Date.now()
        this.pushState()

        if (Math.abs(d) >= CONFIDENCE_THRESHOLD) {
          this.stopDPoller()
          console.log(`[ServerAgent] ⚡ d=${d.toFixed(3)} — firing pipeline`)
          await this.runCycle()
        }
      } catch (e) {
        console.error('[ServerAgent] d-poller error:', e)
      }
    }

    check()
    this.pollerInterval = setInterval(check, 2_000)
  }

  private scheduleNextRun() {
    if (!this.active) return
    if (this.autoTimeout) { clearTimeout(this.autoTimeout); this.autoTimeout = null }
    this.stopDPoller()
    // Moving to a new window — clear all previous window state
    this.windowBetPlaced = false
    this.strikePrice     = 0   // force bootstrap pipeline on next window
    this.lastPollAt      = null
    this.currentD        = 0

    const { delayMs, closeMs, minutesLeft } = getDelayMs()
    this.windowCloseAt = closeMs

    if (delayMs === 0) {
      this.startDPoller(closeMs)
      this.nextRunAt   = closeMs - MIN_MINUTES_LEFT * 60_000
      this.nextCycleIn = Math.round((minutesLeft - MIN_MINUTES_LEFT) * 60)
    } else {
      this.agentPhase  = 'waiting'
      this.nextRunAt   = Date.now() + delayMs
      this.nextCycleIn = Math.round(delayMs / 1000)
      this.autoTimeout = setTimeout(() => {
        if (!this.active) return
        const { closeMs: cm } = getDelayMs()
        this.startDPoller(cm)
      }, delayMs)
    }

    this.pushState()
  }

  // ── Core cycle ─────────────────────────────────────────────────────────────

  private async runCycle() {
    if (this.isRunning) return
    this.isRunning  = true
    this.error      = null
    const wasBootstrap = this.strikePrice <= 0   // track before pipeline sets strikePrice
    this.agentPhase = wasBootstrap ? 'bootstrap' : 'pipeline'
    this.emit('pipeline_start', {})
    this.pushState()

    const { closeMs } = getDelayMs()

    try {
      // ── Fetch markets ──────────────────────────────────────────────────────
      let markets: KalshiMarket[] = []
      const isTradeable = (m: KalshiMarket) =>
        m.status === 'active' && m.yes_ask > 0 && m.yes_ask < 100 &&
        (m.close_time ? new Date(m.close_time).getTime() > Date.now() : true)

      const eventTicker = getCurrentEventTicker()
      const eventPath   = `/trade-api/v2/markets?event_ticker=${eventTicker}&limit=5`
      const eventRes    = await fetch(
        `https://api.elections.kalshi.com${eventPath}`,
        { headers: { ...buildKalshiHeaders('GET', eventPath), Accept: 'application/json' }, cache: 'no-store' }
      ).catch(() => null)

      if (eventRes?.ok) {
        const d = await eventRes.json()
        markets = (d.markets ?? []).map(normalizeKalshiMarket).filter(isTradeable)
      }

      if (!markets.length) {
        const fbPath = '/trade-api/v2/markets?series_ticker=KXBTC15M&limit=100'
        const fbRes  = await fetch(
          `https://api.elections.kalshi.com${fbPath}`,
          { headers: { ...buildKalshiHeaders('GET', fbPath), Accept: 'application/json' }, cache: 'no-store' }
        ).catch(() => null)
        if (fbRes?.ok) {
          const d = await fbRes.json()
          markets = (d.markets ?? []).map(normalizeKalshiMarket).filter(isTradeable)
        }
      }

      if (!markets.length) throw new Error('No active KXBTC15M markets — trading hours ~11:30 AM–midnight ET')

      // ── Fetch BTC price ────────────────────────────────────────────────────
      let quote: BTCQuote | null = null
      const cbRes = await fetch('https://api.coinbase.com/v2/prices/BTC-USD/spot', { cache: 'no-store' }).catch(() => null)
      if (cbRes?.ok) {
        const cb    = await cbRes.json()
        const price = parseFloat(cb?.data?.amount)
        if (price > 0) quote = { price, percent_change_1h: 0, percent_change_24h: 0, volume_24h: 0, market_cap: price * 19_700_000, last_updated: new Date().toISOString() }
      }
      if (!quote) {
        const cgRes = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd', { cache: 'no-store' }).catch(() => null)
        if (cgRes?.ok) {
          const cg    = await cgRes.json()
          const price = cg?.bitcoin?.usd
          if (price > 0) quote = { price, percent_change_1h: 0, percent_change_24h: 0, volume_24h: 0, market_cap: price * 19_700_000, last_updated: new Date().toISOString() }
        }
      }
      if (!quote) throw new Error('BTC price unavailable — all sources failed')

      // ── Parallel data fetch ────────────────────────────────────────────────
      const [balResult, candleRes, liveCandleRes, bybitRes, obRes] = await Promise.all([
        getBalance().catch(() => null),
        fetch('https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=900&limit=13', { cache: 'no-store' }).catch(() => null),
        fetch('https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60&limit=16', { cache: 'no-store' }).catch(() => null),
        fetch('https://api.bybit.com/v5/market/tickers?category=linear&symbol=BTCUSDT', { cache: 'no-store' }).catch(() => null),
        fetch(`https://api.elections.kalshi.com/trade-api/v2/markets/${markets[0].ticker}/orderbook`, {
          headers: { ...buildKalshiHeaders('GET', `/trade-api/v2/markets/${markets[0].ticker}/orderbook`), Accept: 'application/json' },
          cache: 'no-store',
        }).catch(() => null),
      ])

      const portfolioValueCents = (balResult?.ok && balResult.data)
        ? ((balResult.data.balance ?? 0) + (balResult.data.portfolio_value ?? 0))
        : 0

      let candles: OHLCVCandle[] = []
      if (candleRes?.ok) { const r = await candleRes.json(); candles = Array.isArray(r) ? r.slice(1, 13) : [] }

      let liveCandles: OHLCVCandle[] = []
      if (liveCandleRes?.ok) { const r = await liveCandleRes.json(); liveCandles = Array.isArray(r) ? r : [] }

      let derivatives: DerivativesSignal | null = null
      if (bybitRes?.ok) {
        const d = await bybitRes.json()
        const t = d?.result?.list?.[0]
        if (t) {
          const markPrice  = parseFloat(t.markPrice)
          const indexPrice = parseFloat(t.indexPrice)
          const fundingRate = parseFloat(t.fundingRate)
          if (markPrice > 0 && indexPrice > 0 && !isNaN(fundingRate)) {
            derivatives = { fundingRate, basis: ((markPrice - indexPrice) / indexPrice) * 100, markPrice, indexPrice, source: 'bybit' }
          }
        }
      }

      let orderbook: KalshiOrderbook | null = null
      if (obRes?.ok) { const d = await obRes.json(); orderbook = d.orderbook ?? null }

      // ── Run pipeline ───────────────────────────────────────────────────────
      const provider  = (process.env.AI_PROVIDER ?? 'grok') as AIProvider
      const romaMode  = process.env.ROMA_MODE ?? 'keen'

      if (!tryLockPipeline()) throw new Error('Pipeline already running')

      let result: PipelineState
      try {
        result = await runAgentPipeline(
          markets, quote, orderbook, provider, romaMode, false,
          undefined, undefined,
          candles, liveCandles, derivatives, this.orModel, undefined,
          (key, agentResult) => this.emit('agent', { key, result: agentResult }),
          portfolioValueCents,
        )
      } finally {
        releasePipelineLock()
      }

      this.pipeline = result
      await this.processResult(result)

    } catch (err) {
      console.error('[ServerAgent] runCycle error:', err)
      this.error        = String(err)
      this.pipelineError = true
    } finally {
      this.isRunning = false

      if (this.active) {
        // Always get fresh timing — closeMs from the try block may be stale if pipeline took long
        const { minutesLeft, closeMs: freshClose } = getDelayMs()
        const failed       = this.orderFailed
        const pipeErr      = this.pipelineError
        this.orderFailed   = false
        this.pipelineError = false

        if (pipeErr) {
          // Pipeline failed completely (markets closed, network error, etc.) — back off 5 min
          const retryMs    = 5 * 60_000
          this.nextRunAt   = Date.now() + retryMs
          this.nextCycleIn = Math.round(retryMs / 1000)
          console.log('[ServerAgent] Pipeline error — retrying in 5 min')
          this.autoTimeout = setTimeout(() => { if (this.active) this.scheduleNextRun() }, retryMs)
        } else if (failed && minutesLeft >= MIN_MINUTES_LEFT) {
          // Order placement failed — retry d-poller in 60s within same window
          this.nextRunAt   = Date.now() + 60_000
          this.nextCycleIn = 60
          this.autoTimeout = setTimeout(() => {
            if (this.active) { const { closeMs: cm } = getDelayMs(); this.startDPoller(cm) }
          }, 60_000)
        } else if (!this.windowBetPlaced && minutesLeft >= MIN_MINUTES_LEFT) {
          if (wasBootstrap) {
            // Bootstrap run just fetched market data — restart d-poller to watch for signal
            this.agentPhase = 'monitoring'
            this.startDPoller(freshClose)
          } else {
            // Threshold-triggered PASS — skip the rest of this window entirely.
            // Re-running in the same conditions would just PASS again.
            const waitMs     = Math.max(POST_WINDOW_BUFFER_MS, freshClose - Date.now() + POST_WINDOW_BUFFER_MS)
            this.agentPhase  = 'pass_skipped'
            this.nextRunAt   = Date.now() + waitMs
            this.nextCycleIn = Math.round(waitMs / 1000)
            console.log(`[ServerAgent] PASS — skipping window, next cycle in ${Math.round(waitMs/1000)}s`)
            this.autoTimeout = setTimeout(() => { if (this.active) this.scheduleNextRun() }, waitMs)
          }
        } else {
          // Bet placed or window expired — wait for window to close then schedule next
          const waitMs     = Math.max(POST_WINDOW_BUFFER_MS, freshClose - Date.now() + POST_WINDOW_BUFFER_MS)
          this.agentPhase  = this.windowBetPlaced ? 'bet_placed' : 'waiting'
          this.nextRunAt   = Date.now() + waitMs
          this.nextCycleIn = Math.round(waitMs / 1000)
          this.autoTimeout = setTimeout(() => { if (this.active) this.scheduleNextRun() }, waitMs)
        }
      }

      this.pushState()
    }
  }

  // ── Process pipeline result & place order ──────────────────────────────────

  private async processResult(data: PipelineState) {
    const exec  = data.agents.execution.output
    const md    = data.agents.marketDiscovery.output
    const pf    = data.agents.priceFeed.output
    const prob  = data.agents.probability.output
    const risk  = data.agents.risk.output

    const evTicker = (md.activeMarket as { event_ticker?: string } | undefined)?.event_ticker
      ?? md.activeMarket?.ticker.split('-').slice(0, 2).join('-')
      ?? null

    if (md.strikePrice > 0)                        this.strikePrice = md.strikePrice
    if (prob.gkVol15m && prob.gkVol15m > 0)        this.gkVol       = prob.gkVol15m

    if (evTicker && evTicker !== this.windowKey) {
      this.windowKey       = evTicker
      this.windowBetPlaced = false
    }

    // Place bet
    if (
      exec.action !== 'PASS' &&
      exec.side   != null    &&
      exec.limitPrice != null &&
      risk.approved          &&
      md.activeMarket        &&
      evTicker               &&
      this.allowance >= 1    &&
      !this.windowBetPlaced
    ) {
      const costPerContract  = exec.limitPrice / 100
      const budgetContracts  = Math.floor(this.allowance / costPerContract)
      const contracts        = Math.max(1, Math.min(risk.positionSize, budgetContracts))
      const cost             = contracts * costPerContract

      let liveOrderId: string | undefined
      let orderErrorMsg: string | undefined

      try {
        const res = await placeOrder({
          ticker:  exec.marketTicker,
          side:    exec.side,
          count:   contracts,
          yesPrice: exec.side === 'yes'
            ? Math.min(99, exec.limitPrice + 2)
            : Math.min(99, (100 - exec.limitPrice) + 2),
          clientOrderId: `agent-${data.cycleId}-${Date.now()}`,
        })
        if (res.ok) {
          liveOrderId = res.order?.order_id
          // Immediately place a GTC limit-sell at 99¢ to take profit if price spikes
          limitSellOrder({ ticker: exec.marketTicker, side: exec.side, count: contracts })
            .then(sr => {
              if (!sr.ok) console.warn(`[ServerAgent] limit-sell failed: ${sr.error}`)
              else console.log(`[ServerAgent] ✓ Limit-sell placed @ 99¢ on ${exec.marketTicker}`)
            })
            .catch(e => console.warn('[ServerAgent] limit-sell error:', e))
        } else { orderErrorMsg = res.error ?? 'Order failed' }
      } catch (e) {
        orderErrorMsg = String(e)
      }

      const trade: AgentTrade = {
        id:           `${data.cycleId}-${Date.now()}`,
        cycleId:      data.cycleId,
        windowKey:    evTicker,
        sliceNum:     1,
        side:         exec.side,
        limitPrice:   exec.limitPrice,
        contracts,
        cost,
        marketTicker: exec.marketTicker,
        strikePrice:  md.strikePrice,
        expiresAt:    md.activeMarket.close_time,
        enteredAt:    new Date().toISOString(),
        status:       'open',
        pModel:       prob.pModel,
        pMarket:      prob.pMarket,
        edge:         prob.edge,
        liveOrderId,
        orderError:   orderErrorMsg,
      }

      this.trades = [...this.trades, trade]

      if (liveOrderId) {
        this.windowBetPlaced = true
        this.orderError      = null
        this.agentPhase      = 'bet_placed'
        if (this.kellyMode) {
          this.bankroll = Math.max(1, this.bankroll - cost) // reserve the bet
        }
        console.log(`[ServerAgent] ✓ Bet placed — ${exec.side.toUpperCase()} ${contracts}× @ ${exec.limitPrice}¢ on ${evTicker}`)
      } else if (orderErrorMsg) {
        this.orderFailed = true
        this.orderError  = orderErrorMsg
        this.agentPhase  = 'order_failed'
        console.error(`[ServerAgent] ✗ Order failed: ${orderErrorMsg}`)
      }
    }

    // Settle expired trades
    const now          = Date.now()
    const expiredTrades = this.trades.filter(
      t => t.status === 'open' && t.liveOrderId && now >= new Date(t.expiresAt).getTime()
    )
    if (expiredTrades.length > 0) {
      const settled = await Promise.all(expiredTrades.map(async t => {
        try {
          const path = `/trade-api/v2/markets/${encodeURIComponent(t.marketTicker)}`
          const res  = await fetch(`https://api.elections.kalshi.com${path}`, {
            headers: { ...buildKalshiHeaders('GET', path), Accept: 'application/json' },
            cache: 'no-store',
          })
          if (res.ok) {
            const { market } = await res.json()
            if (market?.result === 'yes' || market?.result === 'no') {
              const win = t.side === market.result
              return { ...t, status: (win ? 'won' : 'lost') as 'won' | 'lost', settlementPrice: pf.currentPrice, pnl: win ? t.contracts - t.cost : -t.cost }
            }
          }
        } catch {}
        return t
      }))
      const justSettled = settled.filter(s => s.status !== 'open')
      this.trades = this.trades.map(t => settled.find(s => s.id === t.id) ?? t)

      // Kelly: update bankroll from settlement and recalculate allowance
      if (this.kellyMode && justSettled.length > 0) {
        for (const t of justSettled) {
          if (t.status === 'won') {
            // Return cost + profit: contracts payout
            this.bankroll += t.contracts  // full payout (cost already deducted at bet time)
          }
          // On loss, cost was already deducted at bet time — nothing extra to do
        }
        this.bankroll  = Math.max(1, this.bankroll)
        this.allowance = Math.max(1, Math.round(this.bankroll * this.kellyPct * 100) / 100)
        console.log(`[ServerAgent] Kelly update — bankroll=$${this.bankroll.toFixed(2)} → allowance=$${this.allowance.toFixed(2)}`)
      }
    }
  }
}

// Module-level singleton — persists for the lifetime of the Node.js process
export const serverAgent = new ServerAgent()
