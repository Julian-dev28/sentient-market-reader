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
import { getBalance, placeOrder } from './kalshi-trade'
import { tryLockPipeline, releasePipelineLock } from './pipeline-lock'
import type {
  PipelineState, AgentTrade, AgentStats,
  KalshiMarket, KalshiOrderbook, BTCQuote, OHLCVCandle, DerivativesSignal,
} from './types'
import type { AIProvider } from './llm-client'

// ── Constants (mirrors useAgentEngine) ──────────────────────────────────────
const TARGET_MINUTES_BEFORE_CLOSE = 10
const MIN_MINUTES_LEFT  = 3
const MAX_MINUTES_LEFT  = 12
const POST_WINDOW_BUFFER_MS = 30_000
export const CONFIDENCE_THRESHOLD = 1.0

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

// ── Public state snapshot (sent to browser) ──────────────────────────────────
export interface AgentStateSnapshot {
  active:           boolean
  allowance:        number
  initialAllowance: number
  isRunning:        boolean
  windowKey:        string | null
  windowBetPlaced:  boolean
  currentD:         number
  lastPollAt:       number | null
  nextCycleIn:      number
  error:            string | null
  orderError:       string | null
  trades:           AgentTrade[]
  stats:            AgentStats
  pipeline:         PipelineState | null
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

  private autoTimeout:      NodeJS.Timeout | null = null
  private pollerInterval:   NodeJS.Timeout | null = null
  private countdownInterval: NodeJS.Timeout | null = null
  private nextRunAt    = 0
  private strikePrice  = 0
  private gkVol        = 0.002
  private orderFailed  = false
  private orModel:     string | undefined

  // ── Public API ─────────────────────────────────────────────────────────────

  start(allowance: number, orModel?: string) {
    if (this.active) {
      // Already running — update allowance and model if changed
      this.allowance = allowance
      this.orModel   = orModel
      this.pushState()
      return
    }
    this.allowance        = allowance
    this.initialAllowance = allowance
    this.orModel          = orModel
    this.active           = true
    this.error            = null
    this.orderError       = null
    this.startCountdown()
    this.scheduleNextRun()
    this.pushState()
    console.log(`[ServerAgent] Started — allowance=$${allowance}`)
  }

  stop() {
    this.active    = false
    this.isRunning = false
    this.clearTimers()
    this.pushState()
    console.log('[ServerAgent] Stopped')
  }

  setAllowance(amount: number) {
    this.allowance = Math.max(0, amount)
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
    if (this.autoTimeout)       { clearTimeout(this.autoTimeout);         this.autoTimeout       = null }
    if (this.countdownInterval) { clearInterval(this.countdownInterval);  this.countdownInterval = null }
    this.stopDPoller()
  }

  private stopDPoller() {
    if (this.pollerInterval) { clearInterval(this.pollerInterval); this.pollerInterval = null }
  }

  private startDPoller(closeMs: number) {
    this.stopDPoller()

    const check = async () => {
      if (!this.active || this.isRunning || this.windowBetPlaced) return

      const minutesLeft = (closeMs - Date.now()) / 60_000
      if (minutesLeft < MIN_MINUTES_LEFT) {
        this.stopDPoller()
        return
      }

      // Bootstrap: no strike yet → run pipeline to get it
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
        this.currentD  = d
        this.lastPollAt = Date.now()
        this.pushState()

        console.log(`[ServerAgent] poll — BTC=$${price.toFixed(2)}, K=$${this.strikePrice}, d=${d.toFixed(3)}, T=${minutesLeft.toFixed(1)}min`)

        if (Math.abs(d) >= CONFIDENCE_THRESHOLD) {
          this.stopDPoller()
          console.log(`[ServerAgent] ⚡ Signal locked d=${Math.abs(d).toFixed(2)} — firing pipeline`)
          await this.runCycle()
        }
      } catch (e) {
        console.error('[ServerAgent] d-poller error:', e)
      }
    }

    check()
    this.pollerInterval = setInterval(check, 30_000)
  }

  private scheduleNextRun() {
    if (!this.active) return
    if (this.autoTimeout) { clearTimeout(this.autoTimeout); this.autoTimeout = null }
    this.stopDPoller()

    const { delayMs, closeMs, minutesLeft } = getDelayMs()

    if (delayMs === 0) {
      this.startDPoller(closeMs)
      this.nextRunAt   = closeMs - MIN_MINUTES_LEFT * 60_000
      this.nextCycleIn = Math.round((minutesLeft - MIN_MINUTES_LEFT) * 60)
    } else {
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
    this.isRunning = true
    this.error     = null
    this.emit('pipeline_start', {})
    this.pushState()

    const { closeMs } = getDelayMs()

    try {
      // ── Fetch markets ──────────────────────────────────────────────────────
      let markets: KalshiMarket[] = []
      const isTradeable = (m: KalshiMarket) =>
        m.status === 'active' && m.yes_ask > 0 &&
        (m.close_time ? new Date(m.close_time).getTime() > Date.now() : true)

      const eventTicker = getCurrentEventTicker()
      const eventPath   = `/trade-api/v2/markets?event_ticker=${eventTicker}&limit=5`
      const eventRes    = await fetch(
        `https://api.elections.kalshi.com${eventPath}`,
        { headers: { ...buildKalshiHeaders('GET', eventPath), Accept: 'application/json' }, cache: 'no-store' }
      ).catch(() => null)

      if (eventRes?.ok) {
        const d = await eventRes.json()
        markets = (d.markets ?? []).filter(isTradeable)
      }

      if (!markets.length) {
        const fbPath = '/trade-api/v2/markets?series_ticker=KXBTC15M&limit=100'
        const fbRes  = await fetch(
          `https://api.elections.kalshi.com${fbPath}`,
          { headers: { ...buildKalshiHeaders('GET', fbPath), Accept: 'application/json' }, cache: 'no-store' }
        ).catch(() => null)
        if (fbRes?.ok) {
          const d = await fbRes.json()
          markets = (d.markets ?? []).filter(isTradeable)
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
      this.error = String(err)
    } finally {
      this.isRunning = false

      if (this.active) {
        const { minutesLeft } = getDelayMs()
        const failed      = this.orderFailed
        this.orderFailed  = false

        if (failed && minutesLeft >= MIN_MINUTES_LEFT) {
          // Order failed — retry d-poller in 60s
          this.nextRunAt   = Date.now() + 60_000
          this.nextCycleIn = 60
          this.autoTimeout = setTimeout(() => {
            if (this.active) { const { closeMs: cm } = getDelayMs(); this.startDPoller(cm) }
          }, 60_000)
        } else if (!this.windowBetPlaced && minutesLeft >= MIN_MINUTES_LEFT) {
          // PASS — restart d-poller to keep watching this window
          this.startDPoller(closeMs)
        } else {
          // Bet placed or window expired — wait, then schedule next window
          const waitMs     = Math.max(POST_WINDOW_BUFFER_MS, closeMs - Date.now() + POST_WINDOW_BUFFER_MS)
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
        if (res.ok) { liveOrderId = res.order?.order_id }
        else        { orderErrorMsg = res.error ?? 'Order failed' }
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
        console.log(`[ServerAgent] ✓ Bet placed — ${exec.side.toUpperCase()} ${contracts}× @ ${exec.limitPrice}¢ on ${evTicker}`)
      } else if (orderErrorMsg) {
        this.orderFailed = true
        this.orderError  = orderErrorMsg
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
      this.trades = this.trades.map(t => settled.find(s => s.id === t.id) ?? t)
    }
  }
}

// Module-level singleton — persists for the lifetime of the Node.js process
export const serverAgent = new ServerAgent()
