/**
 * Server-side autonomous trading agent.
 *
 * Runs entirely in Node.js — immune to browser tab throttling/suspension.
 * Browser clients subscribe for real-time updates via /api/agent/stream (SSE).
 *
 * Lifecycle:
 *   start(allowance) → scheduleNextRun() → [wait for 6–9 min window] →
 *   startDPoller() → [poll BTC every 2s for UI, run Markov pipeline every 30s] →
 *   Markov approves → runCycle() → processResult() → placeOrder() → next window → repeat
 *   Markov blocks  → keep scanning until window expires
 */

import { EventEmitter } from 'events'
import { runAgentPipeline } from './agents'
import { buildKalshiHeaders } from './kalshi-auth'
import { getBalance, placeOrder, limitSellOrder } from './kalshi-trade'
import { tryLockPipeline, releasePipelineLock } from './pipeline-lock'
import { appendTrade, updateTrade, readTradeLog, clearTradeLog, saveAgentConfig, loadAgentConfig } from './trade-log'
import type {
  PipelineState, AgentTrade, AgentStats,
  KalshiMarket, KalshiOrderbook, BTCQuote, OHLCVCandle, DerivativesSignal,
} from './types'
import { normalizeKalshiMarket } from './types'
import type { AIProvider } from './llm-client'
import { KELLY_FRACTION } from './agent-shared'
import { recordTradeResult } from './agents/markov'
import type { AgentStateSnapshot, AgentPhase } from './agent-shared'
import { agentStore } from './agent-store'
import { KALSHI_HOST, getCurrentEventTicker } from './kalshi'

// ── Constants ────────────────────────────────────────────────────────────────
const TARGET_MINUTES_BEFORE_CLOSE = 14  // start monitoring 14 min before close (1 min into each 15-min window)
const MIN_MINUTES_LEFT       = 2         // safety floor: don't trade with < 2 min left
const POST_WINDOW_BUFFER_MS  = 5_000
const MIN_FAST_ENTRY_PRICE   = 78   // ¢ — sweet spot is 78-99¢ (94-100% win rate)
const MAX_FAST_ENTRY_PRICE   = 99   // ¢ — no hard upper cap; high prices = high win rate

// Kalshi maker fee: ceil(0.0175 × C × P × (1-P)) — agent places resting limit orders
const MAKER_FEE_RATE = 0.0175
const kalshiFee = (contracts: number, priceCents: number): number => {
  const p = priceCents / 100
  return Math.ceil(MAKER_FEE_RATE * contracts * p * (1 - p) * 100) / 100
}

// ── Normal CDF approximation (Abramowitz & Stegun) ───────────────────────────
function normalCDF(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x))
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))))
  const result = 1 - poly * Math.exp(-x * x)
  return x >= 0 ? result : 1 - result
}

// ── Window timing helpers ────────────────────────────────────────────────────
function getWindowClose(): number {
  const boundary = 15 * 60 * 1000
  return Math.ceil(Date.now() / boundary) * boundary
}

function getDelayMs(): { delayMs: number; closeMs: number; minutesLeft: number } {
  const closeMs    = getWindowClose()
  const minutesLeft = (closeMs - Date.now()) / 60_000
  let delayMs: number

  if (minutesLeft >= MIN_MINUTES_LEFT && minutesLeft <= TARGET_MINUTES_BEFORE_CLOSE) {
    delayMs = 0  // already inside monitoring window
  } else if (minutesLeft > TARGET_MINUTES_BEFORE_CLOSE) {
    delayMs = (minutesLeft - TARGET_MINUTES_BEFORE_CLOSE) * 60_000
  } else {
    const nextCloseMs = closeMs + 15 * 60_000
    delayMs = nextCloseMs - Date.now() - TARGET_MINUTES_BEFORE_CLOSE * 60_000
  }

  return { delayMs: Math.max(0, delayMs), closeMs, minutesLeft }
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
  private windowKey:           string | null = null
  private currentMarketTicker: string        = ''   // full ticker from bootstrap (e.g. KXBTC15M-25MAR221445-T84000)
  private windowBetPlaced = false
  private currentD     = 0
  private lastPollAt:  number | null = null
  private nextCycleIn  = 0
  private error:       string | null = null
  private orderError:  string | null = null
  private trades:      AgentTrade[]  = readTradeLog()  // persists across HMR/restarts
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
  private aiMode         = false   // true = unified Grok agent; false = ROMA multi-step
  private bankroll       = 0
  private orModel:     string | undefined
  private agentPhase: AgentPhase = 'idle'
  private windowCloseAt = 0
  private lastKvSave    = 0   // timestamp of last KV write — throttle to 1/10s
  private lastCycleAt  = 0   // timestamp of last pipeline run — throttle within window

  // ── Config persistence ─────────────────────────────────────────────────────

  private saveConfig() {
    saveAgentConfig({
      active:    this.active,
      allowance: this.allowance,
      kellyMode: this.kellyMode,
      aiMode:    this.aiMode,
      bankroll:  this.bankroll,
      kellyPct:  this.kellyPct,
      orModel:   this.orModel,
    })
  }

  private restoreConfig() {
    // Try KV first (cross-instance persistence), fall back to local file
    agentStore.loadState().then(kvState => {
      if (kvState?.active) {
        console.log(`[ServerAgent] Restoring from KV — active=${kvState.active} allowance=$${kvState.allowance} aiMode=${kvState.aiMode}`)
        // Restore trades from KV too
        agentStore.loadTrades().then(kvTrades => {
          if (kvTrades.length) this.trades = kvTrades
        }).catch(() => {})
        this.start(kvState.allowance, undefined, kvState.kellyMode, kvState.bankroll, undefined, kvState.aiMode ?? false)
        return
      }
      // KV empty — try local file
      const cfg = loadAgentConfig()
      if (!cfg?.active) return
      console.log(`[ServerAgent] Restoring from disk — kellyMode=${cfg.kellyMode} aiMode=${cfg.aiMode} bankroll=$${cfg.bankroll} allowance=$${cfg.allowance}`)
      this.start(cfg.allowance, cfg.orModel, cfg.kellyMode, cfg.bankroll, cfg.kellyPct, cfg.aiMode)
    }).catch(() => {
      const cfg = loadAgentConfig()
      if (cfg?.active) this.start(cfg.allowance, cfg.orModel, cfg.kellyMode, cfg.bankroll, cfg.kellyPct, cfg.aiMode)
    })
  }

  // Save state to KV — throttled to at most once per 10s to avoid rate limits.
  // Force=true bypasses throttle for critical events (start, stop, trade placed).
  private flushToKV(force = false) {
    const now = Date.now()
    if (!force && now - this.lastKvSave < 10_000) return
    this.lastKvSave = now
    agentStore.saveState(this.getState()).catch(() => {})
    agentStore.saveTrades(this.trades).catch(() => {})
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  start(allowance: number, orModel?: string, kellyMode = false, bankroll?: number, kellyPct = 0.25, aiMode = false) {
    if (this.active) {
      this.allowance  = allowance
      this.orModel    = orModel
      this.kellyMode  = kellyMode
      this.aiMode     = aiMode
      this.kellyPct   = kellyPct
      if (kellyMode && bankroll && bankroll > 0) {
        this.bankroll  = bankroll
        this.allowance = Math.max(1, bankroll * kellyPct)
      }
      this.pushState()
      return
    }
    this.kellyMode        = kellyMode
    this.aiMode           = aiMode
    this.kellyPct         = kellyPct
    this.bankroll         = kellyMode && bankroll && bankroll > 0 ? bankroll : 0
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
    this.saveConfig()
    this.pushState(true)  // force KV flush on start
    console.log(`[ServerAgent] Started — ${kellyMode ? `Kelly ${kellyPct*100}% bankroll=$${this.bankroll} allowance=$${this.allowance.toFixed(2)}` : `fixed allowance=$${allowance}`} | mode=${aiMode ? 'Grok AI' : 'ROMA'}`)
  }

  stop() {
    this.active     = false
    this.isRunning  = false
    this.agentPhase = 'idle'
    this.clearTimers()
    this.saveConfig()
    this.pushState(true)  // force KV flush on stop
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
    this.saveConfig()
    this.pushState()
  }

  clearHistory() {
    this.trades          = []
    this.windowKey       = null
    this.windowBetPlaced = false
    clearTradeLog()
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
      aiMode:           this.aiMode,
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

  private pushState(forceKv = false) {
    const state = this.getState()
    this.emit('state', state)
    this.flushToKV(forceKv)
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

  /** Schedule the next autoTimeout, ensuring only one is ever pending and it self-nulls on fire. */
  private schedule(fn: () => void, ms: number) {
    if (this.autoTimeout) { clearTimeout(this.autoTimeout); this.autoTimeout = null }
    this.autoTimeout = setTimeout(() => {
      this.autoTimeout = null   // always null before executing — fixes the stale-reference hang
      if (this.active) fn()
    }, ms)
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
        const res  = await fetch(`${KALSHI_HOST}${path}`, {
          headers: { ...buildKalshiHeaders('GET', path), Accept: 'application/json' },
          cache: 'no-store',
        })
        if (res.ok) {
          const { market } = await res.json()
          if (market?.result === 'yes' || market?.result === 'no') {
            const win = t.side === market.result
            const fee = kalshiFee(t.contracts, t.limitPrice ?? Math.round(t.cost / t.contracts * 100))
            return { ...t, status: (win ? 'won' : 'lost') as 'won' | 'lost', pnl: win ? t.contracts - t.cost - fee : -t.cost - fee }
          }
        }
      } catch (e) {
        console.warn(`[ServerAgent] Settlement fetch failed for ${t.marketTicker} — will retry next cycle:`, e)
      }
      return t
    }))

    const justSettled = settled.filter(s => s.status !== 'open')
    if (!justSettled.length) return

    this.trades = this.trades.map(t => settled.find(s => s.id === t.id) ?? t)

    // Persist settlement updates to disk log + update session risk state
    for (const t of justSettled) {
      updateTrade(t.id, { status: t.status, pnl: t.pnl, settlementPrice: t.settlementPrice })
      if (t.pnl != null) recordTradeResult(t.pnl)
    }

    if (this.kellyMode) {
      for (const t of justSettled) {
        const fee = kalshiFee(t.contracts, t.limitPrice ?? Math.round(t.cost / t.contracts * 100))
        if (t.status === 'won') this.bankroll += t.contracts - fee  // $1/contract payout minus maker fee
        else                    this.bankroll -= fee                 // fee paid on losses too
      }
      this.bankroll  = Math.max(1, this.bankroll)
      this.allowance = Math.max(1, Math.round(this.bankroll * this.kellyPct * 100) / 100)
      this.saveConfig()
      console.log(`[ServerAgent] Kelly update — bankroll=$${this.bankroll.toFixed(2)} → allowance=$${this.allowance.toFixed(2)}`)
    }

    this.pushState()
    console.log(`[ServerAgent] Settled ${justSettled.length} trade(s) via background loop`)
  }

  /**
   * Fast-path entry: places an order in ~5s when d triggers, WITHOUT waiting
   * for the full ROMA pipeline (~90s). Uses d-sign for direction and normalCDF(d)
   * as the probability estimate for Kelly sizing.
   *
   * After this returns, the caller fires runCycle() in the background so the
   * pipeline UI still updates — but the order is already in.
   */
  private async fastEntry(d: number, closeMs: number): Promise<void> {
    if (!this.active || this.windowBetPlaced || !this.windowKey) return
    const minutesLeft = (closeMs - Date.now()) / 60_000
    if (minutesLeft < MIN_MINUTES_LEFT) return

    const side: 'yes' | 'no' = d > 0 ? 'yes' : 'no'

    try {
      // Fetch a fresh quote using the exact market ticker from bootstrap (most precise).
      // Falls back to event_ticker query if we don't have a stored ticker yet.
      let market: KalshiMarket | undefined
      if (this.currentMarketTicker) {
        const path = `/trade-api/v2/markets/${encodeURIComponent(this.currentMarketTicker)}`
        const res  = await fetch(`${KALSHI_HOST}${path}`, {
          headers: { ...buildKalshiHeaders('GET', path), Accept: 'application/json' },
          cache: 'no-store',
          signal: AbortSignal.timeout(5_000),
        })
        if (res.ok) {
          const data = await res.json()
          market = normalizeKalshiMarket(data.market ?? data)
        }
      }
      if (!market && this.windowKey) {
        // Fallback: query by event_ticker and pick the one with liquidity on our side
        const path = '/trade-api/v2/markets'
        const res  = await fetch(`${KALSHI_HOST}${path}?event_ticker=${encodeURIComponent(this.windowKey)}&limit=10`, {
          headers: { ...buildKalshiHeaders('GET', path), Accept: 'application/json' },
          cache: 'no-store',
          signal: AbortSignal.timeout(5_000),
        })
        if (!res.ok) return
        const data    = await res.json()
        const markets = (data.markets as unknown[] ?? []).map(normalizeKalshiMarket)
        market = markets.find(m => (side === 'yes' ? m.yes_ask : m.no_ask) > 0)
      }
      if (!market) return

      const askPrice = side === 'yes' ? market.yes_ask : market.no_ask
      if (askPrice < MIN_FAST_ENTRY_PRICE || askPrice > MAX_FAST_ENTRY_PRICE) {
        console.log(`[ServerAgent] Fast-path: ask=${askPrice}¢ outside [${MIN_FAST_ENTRY_PRICE}, ${MAX_FAST_ENTRY_PRICE}]¢ window — skip`)
        return
      }

      // Kelly sizing using correct maker fee: ceil(0.0175 × C × P × (1-P))
      const pModel       = normalCDF(Math.abs(d))
      const p_d          = askPrice / 100
      const feePerC      = MAKER_FEE_RATE * p_d * (1 - p_d)           // per-contract approx (pre-ceiling)
      const netWinPerC   = (1 - p_d) - feePerC
      const totalCostPerC = p_d + feePerC
      const b            = netWinPerC / totalCostPerC
      const pWin      = side === 'yes' ? pModel : (1 - pModel)
      const kellyFrac = Math.max(0, (b * pWin - (1 - pWin)) / b)
      if (kellyFrac <= 0) {
        console.log(`[ServerAgent] Fast-path: Kelly=0 at ${askPrice}¢ — skip`)
        return
      }
      // After-fee EV gate — must clear minEdgePct (6%) same as main pipeline
      const edgePct = (pWin * netWinPerC + (1 - pWin) * (-p_d - feePerC)) * 100
      if (edgePct < 6) {
        console.log(`[ServerAgent] Fast-path: edge ${edgePct.toFixed(2)}% < 6% — skip`)
        return
      }
      const halfKellyCapital = kellyFrac * 0.25 * this.bankroll  // quarter-Kelly, matches main pipeline
      const contracts        = Math.max(1, Math.min(Math.round(halfKellyCapital / totalCostPerC), 500))
      const cost             = contracts * totalCostPerC
      if (cost < 1) return
      const expectedProfit = netWinPerC * contracts
      if (expectedProfit < 2.00) {
        console.log(`[ServerAgent] Fast-path: net profit $${expectedProfit.toFixed(2)} < $2.00 minimum — skip`)
        return
      }

      console.log(`[ServerAgent] ⚡ Fast-path: ${side.toUpperCase()} ${contracts}× @ ${askPrice}¢ | d=${d.toFixed(3)} pModel=${(pModel*100).toFixed(1)}% Kelly=${(kellyFrac*100).toFixed(1)}%`)

      const ioPrice  = Math.min(99, askPrice + 3)
      const orderRes = await placeOrder({
        ticker:   market.ticker,
        side,
        count:    contracts,
        yesPrice: side === 'yes' ? ioPrice : undefined,
        noPrice:  side === 'no'  ? ioPrice : undefined,
        clientOrderId: `fast-${Date.now()}`,
        ioc: true,
      })

      const wasFilled = orderRes.ok && orderRes.order &&
        ((orderRes.order.fill_count ?? 0) > 0 || orderRes.order.status === 'executed')

      if (!wasFilled) {
        // Retry once at +5¢ sweep
        const retryRes = await placeOrder({
          ticker:   market.ticker,
          side,
          count:    contracts,
          yesPrice: side === 'yes' ? Math.min(99, askPrice + 5) : undefined,
          noPrice:  side === 'no'  ? Math.min(99, askPrice + 5) : undefined,
          clientOrderId: `fast-retry-${Date.now()}`,
          ioc: true,
        })
        const retryFilled = retryRes.ok && retryRes.order &&
          ((retryRes.order.fill_count ?? 0) > 0 || retryRes.order.status === 'executed')
        if (!retryFilled) {
          console.log(`[ServerAgent] Fast-path: both IOC attempts unfilled — falling through to pipeline`)
          return
        }
        Object.assign(orderRes, retryRes)
      }

      // Order filled — record trade and mark window done
      const actualFilled = orderRes.order!.fill_count ?? contracts
      const actualCost   = actualFilled * (askPrice / 100)
      this.windowBetPlaced = true
      this.agentPhase      = 'bet_placed'
      this.orderError      = null

      const evTicker = (market as KalshiMarket & { event_ticker?: string }).event_ticker ?? this.windowKey
      const trade: AgentTrade = {
        id:              `fast-${Date.now()}`,
        cycleId:         -1,
        windowKey:       evTicker,
        sliceNum:        1,
        side,
        limitPrice:      askPrice,
        contracts:       actualFilled,
        cost:            actualCost,
        marketTicker:    market.ticker,
        strikePrice:     this.strikePrice,
        btcPriceAtEntry: undefined,
        expiresAt:       market.close_time,
        enteredAt:       new Date().toISOString(),
        status:          'open',
        pModel,
        pMarket:         askPrice / 100,
        edge:            edgePct,
        signals: {
          sentimentScore:    0,
          sentimentMomentum: 0,
          orderbookSkew:     0,
          sentimentLabel:    'fast_entry',
          pLLM:              pModel,
          confidence:        Math.abs(d) >= 1.1 ? 'high' : 'medium',  // midpoint of [1.0,1.2] edge zone
          gkVol:             this.gkVol,
          distancePct:       (Math.exp(this.gkVol * Math.sqrt(minutesLeft / 15) * Math.abs(d)) - 1) * 100,
          minutesLeft,
          aboveStrike:       d > 0,
          priceMomentum1h:   0,
        },
        liveOrderId:  orderRes.order!.order_id,
        orderError:   undefined,
      }
      this.trades = [...this.trades, trade]
      appendTrade(trade)

      if (this.kellyMode) {
        this.bankroll = Math.max(1, this.bankroll - actualCost)
      }

      console.log(`[ServerAgent] ✓ Fast-path filled — ${side.toUpperCase()} ${actualFilled}× @ ${askPrice}¢ on ${evTicker}`)
      this.pushState(true)  // force KV flush on trade

      // Place limit-sell at 99¢ to lock in profit when contract resolves
      limitSellOrder({ ticker: market.ticker, side, count: actualFilled })
        .then(sr => {
          if (!sr.ok) console.warn(`[ServerAgent] fast-path limit-sell failed: ${sr.error}`)
          else console.log(`[ServerAgent] ✓ Fast-path limit-sell @ 99¢ on ${market.ticker}`)
        })
        .catch(e => console.warn('[ServerAgent] fast-path limit-sell error:', e))

    } catch (e) {
      console.error('[ServerAgent] Fast-path error:', e)
    }
  }

  private startDPoller(closeMs: number) {
    this.stopDPoller()
    this.windowCloseAt = closeMs
    this.agentPhase    = this.strikePrice > 0 ? 'monitoring' : 'bootstrap'
    this.pushState()

    const SCAN_INTERVAL_MS = 5_000  // run full pipeline at most every 10s while in window

    let pollInFlight = false
    const check = async () => {
      if (!this.active || this.isRunning || this.windowBetPlaced || pollInFlight) return
      pollInFlight = true

      const minutesLeft = (closeMs - Date.now()) / 60_000

      // Window closing — stop monitoring, schedule next window
      if (minutesLeft < MIN_MINUTES_LEFT) {
        this.stopDPoller()
        if (!this.windowBetPlaced) {
          const waitMs = Math.max(POST_WINDOW_BUFFER_MS, closeMs - Date.now() + POST_WINDOW_BUFFER_MS)
          this.agentPhase  = 'waiting'
          this.nextRunAt   = Date.now() + waitMs
          this.nextCycleIn = Math.round(waitMs / 1000)
          this.schedule(() => this.scheduleNextRun(), waitMs)
          this.pushState()
          console.log(`[ServerAgent] Window expiring without bet — next window in ${Math.round(waitMs/1000)}s`)
        }
        pollInFlight = false
        return
      }

      // Bootstrap: no strike yet → run pipeline once to fetch market data
      if (this.strikePrice <= 0) {
        this.stopDPoller()
        pollInFlight = false
        await this.runCycle()
        return
      }

      // Live % distance from strike — update UI every 2s
      try {
        const res = await fetch('https://api.exchange.coinbase.com/products/BTC-USD/ticker', {
          cache: 'no-store',
          signal: AbortSignal.timeout(3_000),
        })
        if (res.ok) {
          const cb    = await res.json()
          const price = parseFloat(cb?.price)
          if (price > 0) {
            this.currentD   = ((price - this.strikePrice) / this.strikePrice) * 100
            this.lastPollAt = Date.now()
            this.pushState()
          }
        }
      } catch {}

      // Fire full Markov pipeline every 30s — scans the whole window until signal or expiry
      const now = Date.now()
      if (now - this.lastCycleAt >= SCAN_INTERVAL_MS) {
        this.lastCycleAt = now
        this.stopDPoller()
        pollInFlight = false
        console.log(`[ServerAgent] ${minutesLeft.toFixed(1)}min left — scanning Markov signal`)
        await this.runCycle()
        return
      }

      pollInFlight = false
    }

    check()
    this.pollerInterval = setInterval(check, 2_000)  // 2s — live UI + rapid signal detection
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
    this.lastCycleAt     = 0   // allow pipeline to fire immediately in the new window

    const { delayMs, closeMs } = getDelayMs()
    this.windowCloseAt = closeMs

    if (delayMs === 0) {
      this.nextRunAt   = 0   // no countdown — scanning starts immediately
      this.nextCycleIn = 0
      this.startDPoller(closeMs)
    } else {
      this.agentPhase  = 'waiting'
      this.nextRunAt   = Date.now() + delayMs
      this.nextCycleIn = Math.round(delayMs / 1000)
      this.schedule(() => {
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
        `${KALSHI_HOST}${eventPath}`,
        { headers: { ...buildKalshiHeaders('GET', eventPath), Accept: 'application/json' }, cache: 'no-store' }
      ).catch(() => null)

      if (eventRes?.ok) {
        const d = await eventRes.json()
        markets = (d.markets ?? []).map(normalizeKalshiMarket).filter(isTradeable)
      }

      if (!markets.length) {
        const fbPath = '/trade-api/v2/markets?series_ticker=KXBTC15M&limit=100'
        const fbRes  = await fetch(
          `${KALSHI_HOST}${fbPath}`,
          { headers: { ...buildKalshiHeaders('GET', fbPath), Accept: 'application/json' }, cache: 'no-store' }
        ).catch(() => null)
        if (fbRes?.ok) {
          const d = await fbRes.json()
          markets = (d.markets ?? []).map(normalizeKalshiMarket).filter(isTradeable)
        }
      }

      // Last-resort fallback: fetch the specific ticker we know is active
      if (!markets.length && this.currentMarketTicker) {
        const tkPath = `/trade-api/v2/markets/${encodeURIComponent(this.currentMarketTicker)}`
        const tkRes  = await fetch(
          `${KALSHI_HOST}${tkPath}`,
          { headers: { ...buildKalshiHeaders('GET', tkPath), Accept: 'application/json' }, cache: 'no-store' }
        ).catch(() => null)
        if (tkRes?.ok) {
          const d = await tkRes.json()
          const m = normalizeKalshiMarket(d.market ?? d)
          if (isTradeable(m)) markets = [m]
        }
      }

      if (!markets.length) throw new Error('No active KXBTC15M markets — trading hours ~11:30 AM–midnight ET')

      // ── Fetch BTC price (Coinbase Exchange — same feed Kalshi settles against) ──
      let quote: BTCQuote | null = null
      const cbRes = await fetch('https://api.exchange.coinbase.com/products/BTC-USD/ticker', { cache: 'no-store' }).catch(() => null)
      if (cbRes?.ok) {
        const cb    = await cbRes.json()
        const price = parseFloat(cb?.price)
        if (price > 0) quote = { price, percent_change_1h: 0, percent_change_24h: 0, volume_24h: 0, market_cap: price * 19_700_000, last_updated: new Date().toISOString() }
      }
      if (!quote) throw new Error('BTC price unavailable — Coinbase Exchange unreachable')

      // ── Parallel data fetch ────────────────────────────────────────────────
      const [balResult, candleRes, liveCandleRes, bybitRes, obRes] = await Promise.all([
        getBalance().catch(() => null),
        fetch('https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=900&limit=13', { cache: 'no-store' }).catch(() => null),
        fetch('https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60&limit=16', { cache: 'no-store' }).catch(() => null),
        fetch('https://api.bybit.com/v5/market/tickers?category=linear&symbol=BTCUSDT', { cache: 'no-store' }).catch(() => null),
        fetch(`${KALSHI_HOST}/trade-api/v2/markets/${markets[0].ticker}/orderbook`, {
          headers: { ...buildKalshiHeaders('GET', `/trade-api/v2/markets/${markets[0].ticker}/orderbook`), Accept: 'application/json' },
          cache: 'no-store',
        }).catch(() => null),
      ])

      const actualBalanceCents = (balResult?.ok && balResult.data)
        ? ((balResult.data.balance ?? 0) + (balResult.data.portfolio_value ?? 0))
        : 0
      // In Kelly mode, size against the configured bankroll (total risk budget), not just
      // the current Kalshi balance. Real balance may be small after funding; Kelly should
      // use the full intended deployment amount so positions are meaningfully sized.
      const portfolioValueCents = (this.kellyMode && this.bankroll > 0)
        ? Math.max(actualBalanceCents, Math.round(this.bankroll * 100))
        : actualBalanceCents

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
          markets, quote, orderbook, provider, romaMode, this.aiMode,
          undefined, undefined,
          candles, liveCandles, derivatives, this.orModel, undefined,
          (key, agentResult) => this.emit('agent', { key, result: agentResult }),
          portfolioValueCents,
        )
      } finally {
        releasePipelineLock()
      }

      this.pipeline = result
      await this.processResult(result, wasBootstrap)

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
          // Pipeline failed (markets closed, network error, etc.) — short retry so we don't miss a window
          const retryMs    = 5_000
          this.nextRunAt   = Date.now() + retryMs
          this.nextCycleIn = Math.round(retryMs / 1000)
          this.agentPhase  = 'error'
          console.log('[ServerAgent] Pipeline error — retrying in 5s')
          this.schedule(() => this.scheduleNextRun(), retryMs)
        } else if (failed && minutesLeft >= MIN_MINUTES_LEFT) {
          // Order placement failed — retry poller in 60s within same window
          this.nextRunAt   = Date.now() + 60_000
          this.nextCycleIn = 60
          this.schedule(() => {
            const { closeMs: cm } = getDelayMs()
            this.startDPoller(cm)
          }, 60_000)
        } else if (!this.windowBetPlaced && minutesLeft >= MIN_MINUTES_LEFT) {
          // Bootstrap or NO_TRADE — restart poller to keep scanning for signal within window
          this.agentPhase = 'monitoring'
          this.startDPoller(freshClose)
        } else {
          // Bet placed or window expired — wait for window to close then schedule next
          const waitMs     = Math.max(POST_WINDOW_BUFFER_MS, freshClose - Date.now() + POST_WINDOW_BUFFER_MS)
          this.agentPhase  = this.windowBetPlaced ? 'bet_placed' : 'waiting'
          this.nextRunAt   = Date.now() + waitMs
          this.nextCycleIn = Math.round(waitMs / 1000)
          this.schedule(() => this.scheduleNextRun(), waitMs)
        }
      }

      this.pushState()
    }
  }

  // ── Process pipeline result & place order ──────────────────────────────────

  private async processResult(data: PipelineState, isBootstrap: boolean) {
    const exec  = data.agents.execution.output
    const md    = data.agents.marketDiscovery.output
    const pf    = data.agents.priceFeed.output
    const prob  = data.agents.probability.output
    const risk  = data.agents.markov.output
    const sent  = data.agents.sentiment.output

    const evTicker = (md.activeMarket as { event_ticker?: string } | undefined)?.event_ticker
      ?? md.activeMarket?.ticker.split('-').slice(0, 2).join('-')
      ?? null

    if (md.strikePrice > 0)                        this.strikePrice          = md.strikePrice
    if (prob.gkVol15m && prob.gkVol15m > 0)        this.gkVol                = prob.gkVol15m
    if (md.activeMarket?.ticker)                   this.currentMarketTicker  = md.activeMarket.ticker
    // Sync currentD to % distance from strike — positive = above, negative = below
    this.currentD = pf.aboveStrike ? pf.distanceFromStrikePct : -pf.distanceFromStrikePct

    if (evTicker && evTicker !== this.windowKey) {
      this.windowKey       = evTicker
      this.windowBetPlaced = false
    }

    // Bootstrap: capture market context only — time-based poller triggers the real entry run
    if (isBootstrap) {
      const distPct = pf.aboveStrike ? pf.distanceFromStrikePct : -pf.distanceFromStrikePct
      this.currentD = distPct
      console.log(`[ServerAgent] Bootstrap: strike=$${md.strikePrice} BTC=${distPct >= 0 ? '+' : ''}${distPct.toFixed(2)}% from strike — Markov poller scanning every 10s`)
      return
    }

    // Place bet — also guard against pipeline completing too close to expiry
    const msUntilClose    = this.windowCloseAt > 0 ? this.windowCloseAt - Date.now() : Infinity
    const minsUntilClose  = msUntilClose / 60_000
    if (
      exec.action !== 'PASS' &&
      exec.side   != null    &&
      exec.limitPrice != null &&
      risk.approved          &&
      md.activeMarket        &&
      evTicker               &&
      this.allowance >= 1    &&
      !this.windowBetPlaced  &&
      minsUntilClose >= MIN_MINUTES_LEFT   // don't place if pipeline result is stale / too late
    ) {
      // Fetch a fresh market quote right before placing the order — pipeline data may be stale
      let liveLimitPrice = exec.limitPrice
      try {
        const quotePath = `/trade-api/v2/markets/${encodeURIComponent(exec.marketTicker)}`
        const quoteRes = await fetch(`${KALSHI_HOST}${quotePath}`, {
          headers: { ...buildKalshiHeaders('GET', quotePath), Accept: 'application/json' },
          cache: 'no-store',
        })
        if (quoteRes.ok) {
          const quoteData = await quoteRes.json()
          const liveMarket = normalizeKalshiMarket(quoteData.market ?? quoteData)
          const freshPrice = exec.side === 'yes' ? liveMarket.yes_ask : liveMarket.no_ask
          if (freshPrice > 0) {
            console.log(`[ServerAgent] Fresh quote: ${exec.side}_ask=${freshPrice}¢ (was ${exec.limitPrice}¢)`)
            liveLimitPrice = freshPrice
          }
        }
      } catch (qe) {
        console.warn('[ServerAgent] Fresh quote fetch failed, using pipeline price:', qe)
      }

      // Compute contract count using live price.
      // Always size from this.allowance — it's already Kelly-sized (or fixed by user).
      // Ignoring risk.positionSize here: Markov sizes against Kalshi balance which can
      // diverge from the Kelly bankroll, producing an understated contract count.
      const costPerContract = liveLimitPrice / 100
      const contracts       = Math.max(1, Math.min(Math.floor(this.allowance / costPerContract), 500))
      const cost            = contracts * costPerContract

      let liveOrderId: string | undefined
      let orderErrorMsg: string | undefined
      let iocUnfilled   = false   // IOC with no fill — skip window, don't retry

      {
        try {
          // IOC at liveLimitPrice + 3¢ — sweeps the book at current market price.
          // Kalshi fills at the best available ask (not necessarily at our ceiling).
          // If the order doesn't fill (book empty / price moved > 3¢), retry once at +5¢.
          // No upper price cap — data shows 90-99¢ has 100% win rate.
          const ioPrice = (price: number) => Math.min(99, price + 3)
          let res = await placeOrder({
            ticker:  exec.marketTicker,
            side:    exec.side,
            count:   contracts,
            yesPrice: exec.side === 'yes' ? ioPrice(liveLimitPrice) : undefined,
            noPrice:  exec.side === 'no'  ? ioPrice(liveLimitPrice) : undefined,
            clientOrderId: `agent-${data.cycleId}-${Date.now()}`,
            ioc: true,
          })

          // If IOC cancelled (0 fills) — price moved, retry once with wider sweep
          const wasFilled = (r: typeof res) =>
            r.ok && r.order && ((r.order.fill_count ?? 0) > 0 || r.order.status === 'executed')

          if (!wasFilled(res) && res.ok) {
            console.log(`[ServerAgent] IOC unfilled — retrying with +5¢ ceiling`)
            const retryPrice = (price: number) => Math.min(99, price + 5)
            res = await placeOrder({
              ticker:  exec.marketTicker,
              side:    exec.side,
              count:   contracts,
              yesPrice: exec.side === 'yes' ? retryPrice(liveLimitPrice) : undefined,
              noPrice:  exec.side === 'no'  ? retryPrice(liveLimitPrice) : undefined,
              clientOrderId: `agent-${data.cycleId}-retry-${Date.now()}`,
              ioc: true,
            })
          }

          if (wasFilled(res)) {
            liveOrderId = res.order!.order_id
            const actualFillCount = res.order!.fill_count ?? contracts
            console.log(`[ServerAgent] IOC filled ${actualFillCount} contracts`)
            limitSellOrder({ ticker: exec.marketTicker, side: exec.side, count: actualFillCount })
              .then(sr => {
                if (!sr.ok) console.warn(`[ServerAgent] limit-sell failed: ${sr.error}`)
                else console.log(`[ServerAgent] ✓ Limit-sell placed @ 99¢ on ${exec.marketTicker}`)
              })
              .catch(e => console.warn('[ServerAgent] limit-sell error:', e))
          } else if (!res.ok) {
            orderErrorMsg = res.error ?? 'Order failed'
          } else {
            // Both IOC attempts returned 0 fills — no liquidity, skip this window
            iocUnfilled   = true
            orderErrorMsg = 'IOC unfilled — no liquidity, skipping window'
            console.warn(`[ServerAgent] ${orderErrorMsg}`)
          }
        } catch (e) {
          orderErrorMsg = String(e)
        }
      }

      const trade: AgentTrade = {
        id:               `${data.cycleId}-${Date.now()}`,
        cycleId:          data.cycleId,
        windowKey:        evTicker,
        sliceNum:         1,
        side:             exec.side,
        limitPrice:       liveLimitPrice,
        contracts,
        cost,
        marketTicker:     exec.marketTicker,
        strikePrice:      md.strikePrice,
        btcPriceAtEntry:  pf.currentPrice,
        expiresAt:        md.activeMarket.close_time,
        enteredAt:        new Date().toISOString(),
        status:           'open',
        pModel:           prob.pModel,
        pMarket:          prob.pMarket,
        edge:             prob.edge,
        signals: {
          sentimentScore:    sent.score,
          sentimentMomentum: sent.momentum,
          orderbookSkew:     sent.orderbookSkew,
          sentimentLabel:    sent.label,
          pLLM:              prob.pModel,
          confidence:        prob.confidence,
          gkVol:             prob.gkVol15m ?? null,
          distancePct:       pf.distanceFromStrikePct,
          minutesLeft:       md.minutesUntilExpiry,
          aboveStrike:       pf.aboveStrike,
          priceMomentum1h:   pf.priceChangePct1h,
        },
        liveOrderId,
        orderError:       orderErrorMsg,
      }

      this.trades = [...this.trades, trade]
      appendTrade(trade)

      if (liveOrderId) {
        this.windowBetPlaced = true
        this.orderError      = null
        this.agentPhase      = 'bet_placed'
        if (this.kellyMode) {
          this.bankroll = Math.max(1, this.bankroll - cost) // reserve the bet
        }
        console.log(`[ServerAgent] ✓ Bet placed — ${exec.side.toUpperCase()} ${contracts}× @ ${liveLimitPrice}¢ on ${evTicker}`)
      } else if (iocUnfilled) {
        // No liquidity or price cap — skip this window, don't retry (would just loop)
        this.orderError  = orderErrorMsg ?? 'Skipped — no fill'
        this.agentPhase  = 'pass_skipped'
        console.log(`[ServerAgent] Skipping window — ${this.orderError}`)
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
          const res  = await fetch(`${KALSHI_HOST}${path}`, {
            headers: { ...buildKalshiHeaders('GET', path), Accept: 'application/json' },
            cache: 'no-store',
          })
          if (res.ok) {
            const { market } = await res.json()
            if (market?.result === 'yes' || market?.result === 'no') {
              const win = t.side === market.result
              const fee = kalshiFee(t.contracts, t.limitPrice ?? Math.round(t.cost / t.contracts * 100))
              const pnl = win ? (t.contracts - t.cost) - fee : -t.cost - fee
              return { ...t, status: (win ? 'won' : 'lost') as 'won' | 'lost', settlementPrice: pf.currentPrice, pnl }
            }
          }
        } catch (e) {
          console.warn(`[ServerAgent] Settlement fetch failed for ${t.marketTicker} — will retry next cycle:`, e)
        }
        return t
      }))
      const justSettled = settled.filter(s => s.status !== 'open')
      this.trades = this.trades.map(t => settled.find(s => s.id === t.id) ?? t)

      // Persist settlement updates to disk log + update session risk state
      for (const t of justSettled) {
        updateTrade(t.id, { status: t.status, pnl: t.pnl, settlementPrice: t.settlementPrice })
        if (t.pnl != null) recordTradeResult(t.pnl)
      }

      // Kelly: update bankroll from settlement and recalculate allowance
      if (this.kellyMode && justSettled.length > 0) {
        for (const t of justSettled) {
          if (t.status === 'won') {
            const fee = kalshiFee(t.contracts, t.limitPrice ?? Math.round(t.cost / t.contracts * 100))
            this.bankroll += t.contracts - fee   // receive $1/contract, pay maker fee
          }
          // On loss, cost + fee already deducted at bet time — nothing extra to do
        }
        this.bankroll  = Math.max(1, this.bankroll)
        this.allowance = Math.max(1, Math.round(this.bankroll * this.kellyPct * 100) / 100)
        this.saveConfig()
        console.log(`[ServerAgent] Kelly update — bankroll=$${this.bankroll.toFixed(2)} → allowance=$${this.allowance.toFixed(2)}`)
      }
    }
  }
}

// Singleton pinned to globalThis — survives Next.js HMR and is shared across
// all API routes that run in the same warm Vercel Node.js instance.
// This ensures /api/agent/start, /api/agent/state, /api/agent/stream all
// operate on the same agent object rather than independent fresh copies.
const g = globalThis as typeof globalThis & { _serverAgent?: ServerAgent }
if (!g._serverAgent) {
  g._serverAgent = new ServerAgent()
  // Auto-restore persisted config once on first init
  setImmediate(() => { g._serverAgent!['restoreConfig']() })
}
export const serverAgent = g._serverAgent
