/**
 * Hourly server-side trading agent for KXBTCD markets.
 *
 * Mirrors server-agent.ts for KXBTC15M, adapted for 1-hour windows:
 *   - Window: 60 min, closes at top of each ET hour
 *   - Entry window: 10–45 min before close (risk manager gates)
 *   - Market: KXBTCD — picks the highest-liquidity strike in the edge zone
 *   - Data: Coinbase only — 1m, 15m, 1h, 4h candles; no Bybit derivatives
 *   - Kelly 18% sizing, same price/distance/timing risk gates
 *
 * Lifecycle:
 *   start() → scheduleNextRun() → [wait until 50 min before close] →
 *   startHourlyPoller() → [scan every 30s for Markov signal] →
 *   runCycle() → processResult() → placeOrder() → next window → repeat
 */

import { EventEmitter } from 'events'
import { runAgentPipeline } from './agents'
import { buildKalshiHeaders } from './kalshi-auth'
import { getBalance, placeOrder, limitSellOrder } from './kalshi-trade'
import { tryLockPipeline, releasePipelineLock } from './pipeline-lock'
import { appendTrade, updateTrade, readTradeLog } from './trade-log'
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import type {
  PipelineState, AgentTrade, AgentStats,
  KalshiMarket, KalshiOrderbook, BTCQuote, OHLCVCandle,
} from './types'
import { normalizeKalshiMarket } from './types'
import type { AIProvider } from './llm-client'
import { recordTradeResult } from './agents/markov'
import type { AgentStateSnapshot, AgentPhase } from './agent-shared'
import { hourlyAgentStore } from './agent-store-hourly'
import { KALSHI_HOST, getCurrentKXBTCDEventTicker, parseKXBTCDCloseMs } from './kalshi'

// ── Constants ────────────────────────────────────────────────────────────────
const TARGET_MINUTES_BEFORE_CLOSE = 50   // begin monitoring 50 min before close (10 min into the hour)
const MIN_MINUTES_LEFT            = 10   // risk manager hourly gate: min
const MAX_ENTRY_PRICE_YES         = 65   // ¢ — hourly: tighter cap forces 55-65¢ zone, break-even WR=65% vs 72% at 72¢
const MAX_ENTRY_PRICE_NO          = 65   // ¢ — NO 65¢+ is consensus-following, bad payout
const POST_WINDOW_BUFFER_MS       = 15_000
const SCAN_INTERVAL_MS            = 30_000  // Markov pipeline re-scan every 30s
const LOG_PREFIX                  = '[HourlyAgent]'

const MAKER_FEE_RATE = 0.0175
const kalshiFee = (contracts: number, priceCents: number): number => {
  const p = priceCents / 100
  return Math.ceil(MAKER_FEE_RATE * contracts * p * (1 - p) * 100) / 100
}

// ── Config persistence (separate file from 15-min agent) ─────────────────────
const DATA_DIR       = process.env.VERCEL ? '/tmp' : join(process.cwd(), 'data')
const HOURLY_CFG     = join(DATA_DIR, 'agent-config-hourly.json')
const HOURLY_LOG     = join(DATA_DIR, 'trade-log-hourly.json')

interface HourlyConfig {
  active:    boolean
  allowance: number
  kellyMode: boolean
  bankroll:  number
  kellyPct:  number
}

function ensureDir() { if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true }) }

function saveHourlyCfg(cfg: HourlyConfig): void {
  ensureDir()
  writeFileSync(HOURLY_CFG, JSON.stringify(cfg, null, 2))
}

function loadHourlyCfg(): HourlyConfig | null {
  try { return existsSync(HOURLY_CFG) ? JSON.parse(readFileSync(HOURLY_CFG, 'utf-8')) : null }
  catch { return null }
}

function readHourlyLog(): AgentTrade[] {
  try { return existsSync(HOURLY_LOG) ? JSON.parse(readFileSync(HOURLY_LOG, 'utf-8')) : [] }
  catch { return [] }
}

function appendHourlyTrade(trade: AgentTrade): void {
  ensureDir()
  const existing = readHourlyLog()
  const deduped  = existing.filter(t => t.id !== trade.id)
  writeFileSync(HOURLY_LOG, JSON.stringify([...deduped, trade], null, 2))
  appendTrade(trade)  // also write to the shared log so the UI trade log includes hourly trades
}

function updateHourlyTrade(id: string, patch: Partial<AgentTrade>): void {
  ensureDir()
  const trades = readHourlyLog()
  const idx    = trades.findIndex(t => t.id === id)
  if (idx !== -1) { trades[idx] = { ...trades[idx], ...patch }; writeFileSync(HOURLY_LOG, JSON.stringify(trades, null, 2)) }
  updateTrade(id, patch)  // mirror to shared log
}

// ── Window timing ─────────────────────────────────────────────────────────────

/** UTC ms when the current KXBTCD window closes (top of next ET hour) */
function getHourlyWindowClose(): number {
  const ticker = getCurrentKXBTCDEventTicker(0)
  const ms     = parseKXBTCDCloseMs(ticker)
  // If parsed close is in the past, use the next hour
  return ms > Date.now() ? ms : parseKXBTCDCloseMs(getCurrentKXBTCDEventTicker(1))
}

function getHourlyDelayMs(): { delayMs: number; closeMs: number; minutesLeft: number } {
  const closeMs     = getHourlyWindowClose()
  const minutesLeft = (closeMs - Date.now()) / 60_000
  let   delayMs: number

  if (minutesLeft >= MIN_MINUTES_LEFT && minutesLeft <= TARGET_MINUTES_BEFORE_CLOSE) {
    delayMs = 0
  } else if (minutesLeft > TARGET_MINUTES_BEFORE_CLOSE) {
    delayMs = (minutesLeft - TARGET_MINUTES_BEFORE_CLOSE) * 60_000
  } else {
    // Window past MIN_MINUTES_LEFT — wait for next hour
    const nextClose = closeMs + 60 * 60_000
    delayMs = nextClose - Date.now() - TARGET_MINUTES_BEFORE_CLOSE * 60_000
  }

  return { delayMs: Math.max(0, delayMs), closeMs, minutesLeft }
}

// ── Best-strike selection ─────────────────────────────────────────────────────

/**
 * From all KXBTCD markets for the current hour, pick the best strike to trade.
 *
 * Selection criteria (in priority order):
 *   1. Strike must produce an ask ≤ MAX_ENTRY_PRICE_YES/NO on the favoured side
 *   2. Distance from current BTC price ≥ 0.05% (no near-ATM noise)
 *   3. Among qualifying strikes, pick highest (volume + open_interest)
 */
function selectBestStrike(markets: KalshiMarket[], btcPrice: number): KalshiMarket | null {
  const MIN_DIST_PCT   = 0.05
  const candidates = markets.filter(m => {
    if (m.yes_ask <= 0 || m.yes_ask >= 100) return false
    const strike = m.floor_strike ?? 0
    if (strike <= 0) return false
    const distPct = Math.abs((btcPrice - strike) / strike) * 100
    if (distPct < MIN_DIST_PCT) return false
    // Determine favoured side: BTC above strike → YES (expect close above); below → NO
    const side     = btcPrice > strike ? 'yes' : 'no'
    const askPrice = side === 'yes' ? m.yes_ask : m.no_ask
    const maxP = side === 'yes' ? MAX_ENTRY_PRICE_YES : MAX_ENTRY_PRICE_NO
    return askPrice > 0 && askPrice <= maxP
  })

  if (!candidates.length) return null

  return candidates.sort(
    (a, b) => ((b.volume ?? 0) + (b.open_interest ?? 0)) - ((a.volume ?? 0) + (a.open_interest ?? 0))
  )[0]
}

// ── Stats ─────────────────────────────────────────────────────────────────────

function computeStats(trades: AgentTrade[]): AgentStats {
  const confirmed  = trades.filter(t => t.liveOrderId)
  const settled    = confirmed.filter(t => t.status !== 'open')
  const wins       = settled.filter(t => t.status === 'won')
  const windowKeys = [...new Set(confirmed.map(t => t.windowKey))]
  const windowPnls = windowKeys.map(wk =>
    confirmed.filter(t => t.windowKey === wk).reduce((s, t) => s + (t.pnl ?? 0), 0)
  )
  return {
    windowsTraded: windowKeys.length,
    totalSlices:   confirmed.length,
    totalDeployed: confirmed.reduce((s, t) => s + t.cost, 0),
    totalPnl:      settled.reduce((s, t) => s + (t.pnl ?? 0), 0),
    wins:          wins.length,
    losses:        settled.length - wins.length,
    winRate:       settled.length > 0 ? wins.length / settled.length : 0,
    bestWindow:    windowPnls.length ? Math.max(...windowPnls) : 0,
    worstWindow:   windowPnls.length ? Math.min(...windowPnls) : 0,
  }
}

// ── Agent class ───────────────────────────────────────────────────────────────

class HourlyServerAgent extends EventEmitter {
  private active           = false
  private allowance        = 100
  private initialAllowance = 100
  private isRunning        = false
  private windowKey:           string | null = null
  private currentMarketTicker: string        = ''
  private windowBetPlaced  = false
  private currentD         = 0
  private lastPollAt:      number | null = null
  private nextCycleIn      = 0
  private error:           string | null = null
  private orderError:      string | null = null
  private trades:          AgentTrade[]  = readHourlyLog()
  private pipeline:        PipelineState | null = null

  private autoTimeout:        NodeJS.Timeout | null = null
  private pollerInterval:     NodeJS.Timeout | null = null
  private countdownInterval:  NodeJS.Timeout | null = null
  private settlementInterval: NodeJS.Timeout | null = null
  private nextRunAt    = 0
  private strikePrice  = 0
  private gkVol        = 0.002
  private orderFailed  = false
  private pipelineError = false
  private kellyMode    = false
  private kellyPct     = 0.18
  private bankroll     = 0
  private agentPhase:  AgentPhase = 'idle'
  private windowCloseAt = 0
  private lastKvSave   = 0
  private lastCycleAt  = 0

  // ── Config ─────────────────────────────────────────────────────────────────

  private saveConfig() {
    saveHourlyCfg({ active: this.active, allowance: this.allowance, kellyMode: this.kellyMode, bankroll: this.bankroll, kellyPct: this.kellyPct })
  }

  private restoreConfig() {
    hourlyAgentStore.loadState().then(kvState => {
      if (kvState?.active) {
        hourlyAgentStore.loadTrades().then(t => { if (t.length) this.trades = t }).catch(() => {})
        this.start(kvState.allowance, kvState.kellyMode, kvState.bankroll)
        return
      }
      const cfg = loadHourlyCfg()
      if (cfg?.active) this.start(cfg.allowance, cfg.kellyMode, cfg.bankroll, cfg.kellyPct)
    }).catch(() => {
      const cfg = loadHourlyCfg()
      if (cfg?.active) this.start(cfg.allowance, cfg.kellyMode, cfg.bankroll, cfg.kellyPct)
    })
  }

  private flushToKV(force = false) {
    const now = Date.now()
    if (!force && now - this.lastKvSave < 10_000) return
    this.lastKvSave = now
    hourlyAgentStore.saveState(this.getState()).catch(() => {})
    hourlyAgentStore.saveTrades(this.trades).catch(() => {})
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  start(allowance: number, kellyMode = false, bankroll?: number, kellyPct = 0.18) {
    if (this.active) {
      this.allowance = allowance
      this.kellyMode = kellyMode
      this.kellyPct  = kellyPct
      if (kellyMode && bankroll && bankroll > 0) {
        this.bankroll  = bankroll
        this.allowance = Math.max(1, bankroll * kellyPct)
      }
      this.pushState()
      return
    }
    this.kellyMode        = kellyMode
    this.kellyPct         = kellyPct
    this.bankroll         = kellyMode && bankroll && bankroll > 0 ? bankroll : 0
    this.allowance        = kellyMode ? Math.max(1, this.bankroll * kellyPct) : allowance
    this.initialAllowance = this.allowance
    this.active           = true
    this.error            = null
    this.orderError       = null
    this.agentPhase       = 'waiting'
    this.startCountdown()
    this.startSettlementLoop()
    this.scheduleNextRun()
    this.saveConfig()
    this.pushState(true)
    console.log(`${LOG_PREFIX} Started — ${kellyMode ? `Kelly ${kellyPct * 100}% bankroll=$${this.bankroll} allowance=$${this.allowance.toFixed(2)}` : `fixed allowance=$${allowance}`}`)
  }

  stop() {
    this.active      = false
    this.isRunning   = false
    this.agentPhase  = 'idle'
    this.clearTimers()
    this.saveConfig()
    this.pushState(true)
    console.log(`${LOG_PREFIX} Stopped`)
  }

  setAllowance(amount: number, kellyMode?: boolean, bankroll?: number) {
    if (kellyMode !== undefined) this.kellyMode = kellyMode
    if (this.kellyMode && bankroll && bankroll > 0) {
      this.bankroll  = bankroll
      this.allowance = Math.max(1, bankroll * this.kellyPct)
    } else if (!this.kellyMode) {
      this.allowance = Math.max(0, amount)
    }
    this.saveConfig()
    this.pushState()
  }

  clearHistory() {
    this.trades         = []
    this.windowKey      = null
    this.windowBetPlaced = false
    ensureDir()
    writeFileSync(HOURLY_LOG, '[]')
    this.pushState()
  }

  async triggerCycle() {
    if (this.isRunning) return
    if (this.autoTimeout) { clearTimeout(this.autoTimeout); this.autoTimeout = null }
    this.stopPoller()
    await this.runCycle()
  }

  getState(): AgentStateSnapshot {
    return {
      active:           this.active,
      allowance:        this.allowance,
      initialAllowance: this.initialAllowance,
      bankroll:         this.bankroll,
      kellyMode:        this.kellyMode,
      aiMode:           false,
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

  // ── Private helpers ─────────────────────────────────────────────────────────

  private pushState(forceKv = false) {
    this.emit('state', this.getState())
    this.flushToKV(forceKv)
  }

  private startCountdown() {
    if (this.countdownInterval) clearInterval(this.countdownInterval)
    this.countdownInterval = setInterval(() => {
      const remaining = Math.max(0, Math.round((this.nextRunAt - Date.now()) / 1000))
      if (remaining !== this.nextCycleIn) { this.nextCycleIn = remaining; this.pushState() }
    }, 1000)
  }

  private clearTimers() {
    if (this.autoTimeout)        { clearTimeout(this.autoTimeout);          this.autoTimeout        = null }
    if (this.countdownInterval)  { clearInterval(this.countdownInterval);   this.countdownInterval  = null }
    if (this.settlementInterval) { clearInterval(this.settlementInterval);  this.settlementInterval = null }
    this.stopPoller()
  }

  private stopPoller() {
    if (this.pollerInterval) { clearInterval(this.pollerInterval); this.pollerInterval = null }
  }

  private schedule(fn: () => void, ms: number) {
    if (this.autoTimeout) { clearTimeout(this.autoTimeout); this.autoTimeout = null }
    this.autoTimeout = setTimeout(() => { this.autoTimeout = null; if (this.active) fn() }, ms)
  }

  private scheduleNextRun() {
    if (!this.active) return
    if (this.autoTimeout) { clearTimeout(this.autoTimeout); this.autoTimeout = null }
    this.stopPoller()
    this.windowBetPlaced = false
    this.strikePrice     = 0
    this.lastCycleAt     = 0

    const { delayMs, closeMs: cm } = getHourlyDelayMs()
    if (delayMs <= 0) {
      this.startPoller(cm)
    } else {
      const waitSec = Math.round(delayMs / 1000)
      this.nextRunAt   = Date.now() + delayMs
      this.nextCycleIn = waitSec
      this.agentPhase  = 'waiting'
      console.log(`${LOG_PREFIX} Next window in ${Math.round(delayMs / 60_000)}min`)
      this.schedule(() => {
        const { closeMs } = getHourlyDelayMs()
        this.startPoller(closeMs)
      }, delayMs)
    }
    this.pushState()
  }

  private startPoller(closeMs: number) {
    this.stopPoller()
    this.windowCloseAt = closeMs
    this.agentPhase    = this.strikePrice > 0 ? 'monitoring' : 'bootstrap'
    this.pushState()

    let pollInFlight = false
    const check = async () => {
      if (!this.active || this.isRunning || this.windowBetPlaced || pollInFlight) return
      pollInFlight = true

      const minutesLeft = (closeMs - Date.now()) / 60_000
      if (minutesLeft < MIN_MINUTES_LEFT) {
        this.stopPoller()
        if (!this.windowBetPlaced) {
          const waitMs     = Math.max(POST_WINDOW_BUFFER_MS, closeMs - Date.now() + POST_WINDOW_BUFFER_MS)
          this.agentPhase  = 'waiting'
          this.nextRunAt   = Date.now() + waitMs
          this.nextCycleIn = Math.round(waitMs / 1000)
          this.pushState()
          this.schedule(() => this.scheduleNextRun(), waitMs)
        }
        pollInFlight = false
        return
      }

      // Update BTC distance display every 2s (quick Coinbase ticker fetch)
      try {
        const res = await fetch('https://api.exchange.coinbase.com/products/BTC-USD/ticker', {
          cache: 'no-store', signal: AbortSignal.timeout(3_000),
        })
        if (res.ok) {
          const cb    = await res.json()
          const price = parseFloat(cb?.price)
          if (price > 0 && this.strikePrice > 0) {
            this.currentD   = ((price - this.strikePrice) / this.strikePrice) * 100
            this.lastPollAt = Date.now()
            this.pushState()
          }
        }
      } catch { /* ignore */ }

      // Run full Markov pipeline every SCAN_INTERVAL_MS
      const now = Date.now()
      if (now - this.lastCycleAt >= SCAN_INTERVAL_MS) {
        this.lastCycleAt = now
        this.stopPoller()
        pollInFlight = false
        console.log(`${LOG_PREFIX} ${minutesLeft.toFixed(1)}min left — scanning Markov signal`)
        await this.runCycle()
        return
      }

      pollInFlight = false
    }

    check()
    this.pollerInterval = setInterval(check, 2_000)
  }

  // ── Core cycle ──────────────────────────────────────────────────────────────

  private async runCycle() {
    if (this.isRunning) return
    this.isRunning   = true
    this.error       = null
    const wasBootstrap = this.strikePrice <= 0
    this.agentPhase  = wasBootstrap ? 'bootstrap' : 'pipeline'
    this.emit('pipeline_start', {})
    this.pushState()

    const { closeMs } = getHourlyDelayMs()

    try {
      // ── Fetch KXBTCD markets ──────────────────────────────────────────────
      let markets: KalshiMarket[] = []

      const eventTicker = getCurrentKXBTCDEventTicker(0)
      const eventPath   = `/trade-api/v2/markets?event_ticker=${encodeURIComponent(eventTicker)}&limit=200`
      const eventRes    = await fetch(`${KALSHI_HOST}${eventPath}`, {
        headers: { ...buildKalshiHeaders('GET', eventPath), Accept: 'application/json' },
        cache: 'no-store',
      }).catch(() => null)

      if (eventRes?.ok) {
        const d = await eventRes.json()
        markets = (d.markets ?? []).map(normalizeKalshiMarket).filter((m: KalshiMarket) =>
          m.status === 'active' && m.yes_ask > 0 && m.yes_ask < 100
        )
      }

      // Fallback: next ET hour (sometimes the current hour hasn't opened yet)
      if (!markets.length) {
        const fb   = getCurrentKXBTCDEventTicker(1)
        const fbP  = `/trade-api/v2/markets?event_ticker=${encodeURIComponent(fb)}&limit=200`
        const fbR  = await fetch(`${KALSHI_HOST}${fbP}`, {
          headers: { ...buildKalshiHeaders('GET', fbP), Accept: 'application/json' }, cache: 'no-store',
        }).catch(() => null)
        if (fbR?.ok) {
          const d = await fbR.json()
          markets = (d.markets ?? []).map(normalizeKalshiMarket).filter((m: KalshiMarket) =>
            m.status === 'active' && m.yes_ask > 0 && m.yes_ask < 100
          )
        }
      }

      if (!markets.length) throw new Error('No active KXBTCD markets — check Kalshi trading hours')

      // ── BTC spot price (Coinbase Exchange) ────────────────────────────────
      let quote: BTCQuote | null = null
      const cbRes = await fetch('https://api.exchange.coinbase.com/products/BTC-USD/ticker', {
        cache: 'no-store', signal: AbortSignal.timeout(5_000),
      }).catch(() => null)
      if (cbRes?.ok) {
        const cb    = await cbRes.json()
        const price = parseFloat(cb?.price)
        if (price > 0) quote = {
          price,
          percent_change_1h: 0, percent_change_24h: 0,
          volume_24h: parseFloat(cb?.volume ?? '0'),
          market_cap: price * 19_700_000,
          last_updated: new Date().toISOString(),
        }
      }
      if (!quote) throw new Error('BTC price unavailable — Coinbase unreachable')

      // ── Select best KXBTCD strike ─────────────────────────────────────────
      const bestStrike = selectBestStrike(markets, quote.price)
      if (!bestStrike) throw new Error(`No qualifying KXBTCD strike — all asks outside 55–72¢ or too close to BTC ($${quote.price.toFixed(0)})`)

      console.log(`${LOG_PREFIX} Selected strike $${bestStrike.floor_strike?.toLocaleString()} — ${bestStrike.ticker} (yes_ask=${bestStrike.yes_ask}¢ no_ask=${bestStrike.no_ask}¢)`)

      // ── Parallel Coinbase candle fetch (no Bybit) ─────────────────────────
      const [balResult, c15m, c1m, c1h, c4h, obRes] = await Promise.all([
        getBalance().catch(() => null),
        fetch('https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=900&limit=13',   { cache: 'no-store' }).catch(() => null),
        fetch('https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60&limit=16',    { cache: 'no-store' }).catch(() => null),
        fetch('https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=3600&limit=25',  { cache: 'no-store' }).catch(() => null),
        fetch('https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=14400&limit=10', { cache: 'no-store' }).catch(() => null),
        fetch(`${KALSHI_HOST}/trade-api/v2/markets/${encodeURIComponent(bestStrike.ticker)}/orderbook`, {
          headers: { ...buildKalshiHeaders('GET', `/trade-api/v2/markets/${encodeURIComponent(bestStrike.ticker)}/orderbook`), Accept: 'application/json' },
          cache: 'no-store',
        }).catch(() => null),
      ])

      const actualBalanceCents = (balResult?.ok && balResult.data)
        ? ((balResult.data.balance ?? 0) + (balResult.data.portfolio_value ?? 0)) : 0
      const portfolioValueCents = (this.kellyMode && this.bankroll > 0)
        ? Math.max(actualBalanceCents, Math.round(this.bankroll * 100))
        : actualBalanceCents

      const parseCandles = async (res: Response | null): Promise<OHLCVCandle[]> => {
        if (!res?.ok) return []
        try { const r = await res.json(); return Array.isArray(r) ? r : [] } catch { return [] }
      }

      const [candles15m, candles1m, candles1h, candles4h] = await Promise.all([
        parseCandles(c15m).then(r => r.slice(1, 13)),
        parseCandles(c1m),
        parseCandles(c1h).then(r => r.slice(1, 13)),
        parseCandles(c4h).then(r => r.slice(1, 8)),
      ])

      // Enrich 1h momentum from candles
      if (quote.percent_change_1h === 0 && candles1h.length >= 1) {
        const price1hAgo = candles1h[0][4]
        if (price1hAgo > 0) quote = { ...quote, percent_change_1h: ((quote.price - price1hAgo) / price1hAgo) * 100 }
      }

      let orderbook: KalshiOrderbook | null = null
      if (obRes?.ok) { const d = await obRes.json(); orderbook = d.orderbook ?? null }

      // ── Run pipeline ──────────────────────────────────────────────────────
      const provider = (process.env.AI_PROVIDER ?? 'grok') as AIProvider
      const romaMode = process.env.ROMA_MODE ?? 'keen'

      if (!tryLockPipeline()) throw new Error('Pipeline already running')

      let result: PipelineState
      try {
        result = await runAgentPipeline(
          markets,
          quote,
          orderbook,
          provider,
          romaMode,
          false,            // aiRisk=false — quant mode always
          undefined,
          undefined,
          candles15m,
          candles1m,
          null,             // no derivatives — Coinbase only
          undefined,
          undefined,
          (key, agentResult) => this.emit('agent', { key, result: agentResult }),
          portfolioValueCents,
          undefined,
          candles1h,
          candles4h,
          bestStrike,       // kxbtcdMarket — triggers hourly mode in pipeline
          { maxEntryPrice: MAX_ENTRY_PRICE_YES },  // tighter cap for hourly: both YES+NO ≤65¢
        )
      } finally {
        releasePipelineLock()
      }

      this.pipeline = result
      await this.processResult(result, wasBootstrap, quote.price, closeMs)

    } catch (err) {
      console.error(`${LOG_PREFIX} runCycle error:`, err)
      this.error         = String(err)
      this.pipelineError = true
    } finally {
      this.isRunning = false

      if (this.active) {
        const { minutesLeft, closeMs: freshClose } = getHourlyDelayMs()
        const failed    = this.orderFailed
        const pipeErr   = this.pipelineError
        this.orderFailed   = false
        this.pipelineError = false

        if (pipeErr) {
          const retryMs    = 10_000
          this.nextRunAt   = Date.now() + retryMs
          this.nextCycleIn = Math.round(retryMs / 1000)
          this.agentPhase  = 'error'
          console.log(`${LOG_PREFIX} Pipeline error — retrying in 10s`)
          this.schedule(() => this.scheduleNextRun(), retryMs)
        } else if (failed && minutesLeft >= MIN_MINUTES_LEFT) {
          this.nextRunAt   = Date.now() + 60_000
          this.nextCycleIn = 60
          this.schedule(() => { const { closeMs: cm } = getHourlyDelayMs(); this.startPoller(cm) }, 60_000)
        } else if (!this.windowBetPlaced && minutesLeft >= MIN_MINUTES_LEFT) {
          this.agentPhase = 'monitoring'
          this.startPoller(freshClose)
        } else {
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

  // ── Process result & place order ────────────────────────────────────────────

  private async processResult(data: PipelineState, isBootstrap: boolean, btcPrice: number, closeMs: number) {
    const exec = data.agents.execution.output
    const md   = data.agents.marketDiscovery.output
    const pf   = data.agents.priceFeed.output
    const prob = data.agents.probability.output
    const risk = data.agents.markov.output
    const sent = data.agents.sentiment.output

    const evTicker = (md.activeMarket as { event_ticker?: string } | undefined)?.event_ticker
      ?? md.activeMarket?.ticker.split('-').slice(0, 2).join('-')
      ?? null

    if (md.strikePrice > 0)               this.strikePrice          = md.strikePrice
    if (prob.gkVol15m && prob.gkVol15m > 0) this.gkVol              = prob.gkVol15m
    if (md.activeMarket?.ticker)           this.currentMarketTicker  = md.activeMarket.ticker
    this.currentD = pf.aboveStrike ? pf.distanceFromStrikePct : -pf.distanceFromStrikePct

    if (evTicker && evTicker !== this.windowKey) {
      this.windowKey       = evTicker
      this.windowBetPlaced = false
    }

    if (isBootstrap) {
      const distPct = pf.aboveStrike ? pf.distanceFromStrikePct : -pf.distanceFromStrikePct
      console.log(`${LOG_PREFIX} Bootstrap: strike=$${md.strikePrice} BTC=${distPct >= 0 ? '+' : ''}${distPct.toFixed(2)}% from strike`)
      return
    }

    const minsUntilClose = (closeMs - Date.now()) / 60_000
    if (
      exec.action !== 'PASS' &&
      exec.side   != null    &&
      exec.limitPrice != null &&
      risk.approved          &&
      md.activeMarket        &&
      evTicker               &&
      this.allowance >= 1    &&
      !this.windowBetPlaced  &&
      minsUntilClose >= MIN_MINUTES_LEFT
    ) {
      // Re-fetch fresh quote to guard against stale pipeline price
      let liveLimitPrice = exec.limitPrice
      try {
        const quotePath = `/trade-api/v2/markets/${encodeURIComponent(exec.marketTicker)}`
        const quoteRes  = await fetch(`${KALSHI_HOST}${quotePath}`, {
          headers: { ...buildKalshiHeaders('GET', quotePath), Accept: 'application/json' },
          cache: 'no-store',
        })
        if (quoteRes.ok) {
          const qd          = await quoteRes.json()
          const liveMarket  = normalizeKalshiMarket(qd.market ?? qd)
          const freshPrice  = exec.side === 'yes' ? liveMarket.yes_ask : liveMarket.no_ask
          if (freshPrice > 0) {
            const maxFreshPrice = exec.side === 'yes' ? MAX_ENTRY_PRICE_YES : MAX_ENTRY_PRICE_NO
            if (freshPrice > maxFreshPrice) {
              console.log(`${LOG_PREFIX} Fresh quote ${exec.side}_ask=${freshPrice}¢ > ${maxFreshPrice}¢ cap — SKIP`)
              return
            }
            console.log(`${LOG_PREFIX} Fresh quote: ${exec.side}_ask=${freshPrice}¢ (was ${exec.limitPrice}¢)`)
            liveLimitPrice = freshPrice
          }
        }
      } catch (qe) {
        console.warn(`${LOG_PREFIX} Fresh quote failed, using pipeline price:`, qe)
      }

      const costPerContract = liveLimitPrice / 100
      const contracts       = Math.max(1, Math.floor(this.allowance / costPerContract))
      const cost            = contracts * costPerContract

      let liveOrderId: string | undefined
      let orderErrorMsg:   string | undefined
      let iocUnfilled      = false

      try {
        const ioPrice  = (p: number) => Math.min(99, p + 3)
        let res = await placeOrder({
          ticker:   exec.marketTicker,
          side:     exec.side,
          count:    contracts,
          yesPrice: exec.side === 'yes' ? ioPrice(liveLimitPrice) : undefined,
          noPrice:  exec.side === 'no'  ? ioPrice(liveLimitPrice) : undefined,
          clientOrderId: `hourly-${data.cycleId}-${Date.now()}`,
          ioc: true,
        })

        const wasFilled = (r: typeof res) =>
          r.ok && r.order && ((r.order.fill_count ?? 0) > 0 || r.order.status === 'executed')

        if (!wasFilled(res) && res.ok) {
          console.log(`${LOG_PREFIX} IOC unfilled — retrying with +5¢`)
          const retry = (p: number) => Math.min(99, p + 5)
          res = await placeOrder({
            ticker:   exec.marketTicker,
            side:     exec.side,
            count:    contracts,
            yesPrice: exec.side === 'yes' ? retry(liveLimitPrice) : undefined,
            noPrice:  exec.side === 'no'  ? retry(liveLimitPrice) : undefined,
            clientOrderId: `hourly-${data.cycleId}-retry-${Date.now()}`,
            ioc: true,
          })
        }

        if (wasFilled(res)) {
          liveOrderId = res.order!.order_id
          const filled = res.order!.fill_count ?? contracts
          console.log(`${LOG_PREFIX} IOC filled ${filled} contracts`)
          limitSellOrder({ ticker: exec.marketTicker, side: exec.side, count: filled })
            .then(sr => { if (!sr.ok) console.warn(`${LOG_PREFIX} limit-sell failed: ${sr.error}`) })
            .catch(e => console.warn(`${LOG_PREFIX} limit-sell error:`, e))
        } else if (!res.ok) {
          orderErrorMsg = res.error ?? 'Order failed'
        } else {
          iocUnfilled   = true
          orderErrorMsg = 'IOC unfilled — no liquidity'
          console.warn(`${LOG_PREFIX} ${orderErrorMsg}`)
        }
      } catch (e) {
        orderErrorMsg = String(e)
      }

      const trade: AgentTrade = {
        id:              `h-${data.cycleId}-${Date.now()}`,
        cycleId:         data.cycleId,
        windowKey:       evTicker,
        sliceNum:        1,
        side:            exec.side,
        limitPrice:      liveLimitPrice,
        contracts,
        cost,
        marketTicker:    exec.marketTicker,
        strikePrice:     md.strikePrice,
        btcPriceAtEntry: btcPrice,
        expiresAt:       md.activeMarket.close_time,
        enteredAt:       new Date().toISOString(),
        status:          'open',
        pModel:          prob.pModel,
        pMarket:         prob.pMarket,
        edge:            prob.edge,
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
        orderError: orderErrorMsg,
      }

      this.trades = [...this.trades, trade]
      appendHourlyTrade(trade)

      if (liveOrderId) {
        this.windowBetPlaced = true
        this.orderError      = null
        this.agentPhase      = 'bet_placed'
        if (this.kellyMode) this.bankroll = Math.max(1, this.bankroll - cost)
        console.log(`${LOG_PREFIX} ✓ Bet placed — ${exec.side.toUpperCase()} ${contracts}× @ ${liveLimitPrice}¢ on ${evTicker}`)
      } else if (iocUnfilled) {
        this.orderError  = orderErrorMsg ?? 'Skipped — no fill'
        this.agentPhase  = 'pass_skipped'
      } else if (orderErrorMsg) {
        this.orderFailed = true
        this.orderError  = orderErrorMsg
        this.agentPhase  = 'order_failed'
        console.error(`${LOG_PREFIX} ✗ Order failed: ${orderErrorMsg}`)
      }
    }

    // ── Settle expired trades ──────────────────────────────────────────────
    const now     = Date.now()
    const expired = this.trades.filter(
      t => t.status === 'open' && t.liveOrderId && now >= new Date(t.expiresAt).getTime()
    )
    if (!expired.length) return

    const settled = await Promise.all(expired.map(async t => {
      try {
        const path = `/trade-api/v2/markets/${encodeURIComponent(t.marketTicker)}`
        const res  = await fetch(`${KALSHI_HOST}${path}`, {
          headers: { ...buildKalshiHeaders('GET', path), Accept: 'application/json' }, cache: 'no-store',
        })
        if (res.ok) {
          const { market } = await res.json()
          if (market?.result === 'yes' || market?.result === 'no') {
            const win = t.side === market.result
            const fee = kalshiFee(t.contracts, t.limitPrice ?? Math.round(t.cost / t.contracts * 100))
            return { ...t, status: (win ? 'won' : 'lost') as 'won' | 'lost', pnl: win ? t.contracts - t.cost - fee : -t.cost - fee }
          }
        }
      } catch { /* retry next cycle */ }
      return t
    }))

    const justSettled = settled.filter(s => s.status !== 'open')
    if (!justSettled.length) return

    this.trades = this.trades.map(t => settled.find(s => s.id === t.id) ?? t)
    for (const t of justSettled) {
      updateHourlyTrade(t.id, { status: t.status, pnl: t.pnl })
      if (t.pnl != null) recordTradeResult(t.pnl)
    }

    if (this.kellyMode && justSettled.length > 0) {
      for (const t of justSettled) {
        if (t.status === 'won') {
          const fee = kalshiFee(t.contracts, t.limitPrice ?? Math.round(t.cost / t.contracts * 100))
          this.bankroll += t.contracts - fee
        }
      }
      this.bankroll  = Math.max(1, this.bankroll)
      this.allowance = Math.max(1, Math.round(this.bankroll * this.kellyPct * 100) / 100)
      this.saveConfig()
      console.log(`${LOG_PREFIX} Kelly update — bankroll=$${this.bankroll.toFixed(2)} → allowance=$${this.allowance.toFixed(2)}`)
    }

    this.pushState()
    console.log(`${LOG_PREFIX} Settled ${justSettled.length} trade(s)`)
  }

  // ── Settlement background loop (runs every 60s regardless of trading state) ──

  private startSettlementLoop() {
    if (this.settlementInterval) clearInterval(this.settlementInterval)
    this.settlementInterval = setInterval(() => {
      if (!this.active) return
      const now     = Date.now()
      const expired = this.trades.filter(
        t => t.status === 'open' && t.liveOrderId && now >= new Date(t.expiresAt).getTime()
      )
      if (!expired.length) return
      // Reuse processResult settlement path via a lightweight dummy call
      this.checkSettlements(expired).catch(e => console.error(`${LOG_PREFIX} settlement loop error:`, e))
    }, 60_000)
  }

  private async checkSettlements(expired: AgentTrade[]) {
    const settled = await Promise.all(expired.map(async t => {
      try {
        const path = `/trade-api/v2/markets/${encodeURIComponent(t.marketTicker)}`
        const res  = await fetch(`${KALSHI_HOST}${path}`, {
          headers: { ...buildKalshiHeaders('GET', path), Accept: 'application/json' }, cache: 'no-store',
        })
        if (res.ok) {
          const { market } = await res.json()
          if (market?.result === 'yes' || market?.result === 'no') {
            const win = t.side === market.result
            const fee = kalshiFee(t.contracts, t.limitPrice ?? Math.round(t.cost / t.contracts * 100))
            return { ...t, status: (win ? 'won' : 'lost') as 'won' | 'lost', pnl: win ? t.contracts - t.cost - fee : -t.cost - fee }
          }
        }
      } catch { /* retry next cycle */ }
      return t
    }))

    const justSettled = settled.filter(s => s.status !== 'open')
    if (!justSettled.length) return

    this.trades = this.trades.map(t => settled.find(s => s.id === t.id) ?? t)
    for (const t of justSettled) {
      updateHourlyTrade(t.id, { status: t.status, pnl: t.pnl })
      if (t.pnl != null) recordTradeResult(t.pnl)
    }

    if (this.kellyMode && justSettled.length > 0) {
      for (const t of justSettled) {
        if (t.status === 'won') {
          const fee = kalshiFee(t.contracts, t.limitPrice ?? Math.round(t.cost / t.contracts * 100))
          this.bankroll += t.contracts - fee
        }
      }
      this.bankroll  = Math.max(1, this.bankroll)
      this.allowance = Math.max(1, Math.round(this.bankroll * this.kellyPct * 100) / 100)
      this.saveConfig()
    }

    this.pushState()
    console.log(`${LOG_PREFIX} Settled ${justSettled.length} trade(s) via settlement loop`)
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────
const g = globalThis as typeof globalThis & { _hourlyServerAgent?: HourlyServerAgent }
if (!g._hourlyServerAgent) {
  g._hourlyServerAgent = new HourlyServerAgent()
  setImmediate(() => { g._hourlyServerAgent!['restoreConfig']() })
}
export const hourlyServerAgent = g._hourlyServerAgent
