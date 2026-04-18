// ─── Kalshi Market Types ───────────────────────────────────────────────────

export interface KalshiMarket {
  ticker: string
  event_ticker: string
  series_ticker?: string
  title: string
  yes_bid: number      // cents (1–99)
  yes_ask: number
  no_bid: number
  no_ask: number
  last_price: number
  volume: number
  open_interest: number
  close_time: string   // ISO timestamp
  expiration_time: string
  status: 'open' | 'active' | 'closed' | 'settled' | 'paused' | 'finalized' | 'initialized'
  result?: string
  settlement_value?: number
  // Real Kalshi fields
  floor_strike?: number     // the BTC "price to beat" — first-class field
  yes_sub_title?: string    // "Price to beat: $65,619.62"
  no_sub_title?: string
  rules_primary?: string
  market_type?: string
  // New API dollar fields (Kalshi v2 uses these instead of cent integers)
  yes_ask_dollars?: number
  yes_bid_dollars?: number
  no_ask_dollars?: number
  no_bid_dollars?: number
}

/**
 * Raw Kalshi v2 API market object as returned by the REST API.
 * Fields are unknown because the API may add/remove fields across versions.
 * The normalize functions coerce these into the strongly-typed KalshiMarket shape.
 */
export type RawKalshiMarket    = Record<string, unknown>
export type RawKalshiPosition  = Record<string, unknown>
export type RawKalshiOrder     = Record<string, unknown>
export type RawKalshiFill      = Record<string, unknown>

/**
 * Normalize a raw Kalshi API market object.
 * The v2 API now returns `yes_ask_dollars` (float USD) instead of `yes_ask` (int cents).
 * This converts dollar fields → cent fields so all downstream code stays consistent.
 * Parameter is `unknown` because this sits at the API response boundary — callers pass
 * JSON.parse() output (unknown[]) directly via .map(normalizeKalshiMarket).
 */
export function normalizeKalshiMarket(raw: unknown): KalshiMarket {
  const m = raw as RawKalshiMarket
  const toC = (dollars: number | undefined, cents: number | undefined): number => {
    if (cents && cents > 0) return cents
    if (dollars !== undefined && dollars >= 0) return Math.round(dollars * 100)
    return 0
  }
  const fp = (v: unknown) => parseFloat(String(v ?? 0)) || 0
  return {
    ...(m as Partial<KalshiMarket>),
    ticker:        String(m.ticker ?? ''),
    event_ticker:  String(m.event_ticker ?? ''),
    title:         String(m.title ?? ''),
    close_time:    String(m.close_time ?? ''),
    expiration_time: String(m.expiration_time ?? ''),
    status:        (m.status as KalshiMarket['status']) ?? 'closed',
    yes_ask:       toC(m.yes_ask_dollars as number | undefined,      m.yes_ask as number | undefined),
    yes_bid:       toC(m.yes_bid_dollars as number | undefined,      m.yes_bid as number | undefined),
    no_ask:        toC(m.no_ask_dollars  as number | undefined,      m.no_ask  as number | undefined),
    no_bid:        toC(m.no_bid_dollars  as number | undefined,      m.no_bid  as number | undefined),
    last_price:    toC(m.last_price_dollars as number | undefined,   m.last_price as number | undefined),
    volume:        fp(m.volume_fp       ?? m.volume),
    open_interest: fp(m.open_interest_fp ?? m.open_interest),
  }
}

export interface KalshiOrderbookLevel {
  price: number
  delta: number
}

export interface KalshiOrderbook {
  yes: KalshiOrderbookLevel[]
  no: KalshiOrderbookLevel[]
}

// ─── Market Data Types ────────────────────────────────────────────────────

// [timestamp, low, high, open, close, volume] — Coinbase Exchange format, newest first
export type OHLCVCandle = [number, number, number, number, number, number]

/** Perpetual futures derivatives signal — funding rate + basis from a public exchange */
export interface DerivativesSignal {
  fundingRate: number   // current 8h funding rate; positive = longs pay shorts (bearish pressure)
  basis: number         // (markPrice - indexPrice) / indexPrice × 100; positive = contango (bullish)
  markPrice: number
  indexPrice: number
  source: string        // e.g. 'bybit'
}

export interface BTCQuote {
  price: number
  percent_change_1h: number
  percent_change_24h: number
  volume_24h: number
  market_cap: number
  last_updated: string
}

// ─── ROMA Agent Types ──────────────────────────────────────────────────────

export type AgentStatus = 'idle' | 'running' | 'done' | 'error' | 'skipped'

export interface AgentResult<TOutput = Record<string, unknown>> {
  agentName: string
  status: AgentStatus
  output: TOutput
  reasoning: string
  durationMs?: number
  timestamp: string
}

export interface MarketDiscoveryOutput {
  activeMarket: KalshiMarket | null
  strikePrice: number       // BTC price at market open (price to beat)
  minutesUntilExpiry: number
  secondsUntilExpiry: number
}

export interface PriceFeedOutput {
  currentPrice: number
  priceChange1h: number     // absolute
  priceChangePct1h: number  // percent
  aboveStrike: boolean
  distanceFromStrike: number
  distanceFromStrikePct: number
}

export interface PricePoint {
  timestamp: number
  price: number
}

export interface SentimentOutput {
  score: number          // -1.0 to 1.0
  label: 'strongly_bullish' | 'bullish' | 'neutral' | 'bearish' | 'strongly_bearish'
  momentum: number       // 1h price momentum signal
  orderbookSkew: number  // bid-ask lean from Kalshi
  signals: string[]
  provider: string       // e.g. "grok/grok-3-fast"
}

export interface ProbabilityOutput {
  pModel: number         // 0.0–1.0 model's P(YES)
  pMarket: number        // 0.0–1.0 market-implied P(YES) from yes_ask
  edge: number           // after-fee EV per contract in dollars (positive = favourable)
  edgePct: number        // edge × 100 as % (used for minEdgePct gate in risk manager)
  recommendation: 'YES' | 'NO' | 'NO_TRADE'
  confidence: 'high' | 'medium' | 'low'
  provider: string       // e.g. "grok/grok-4-0709"
  gkVol15m?: number | null  // Garman-Klass realized vol (per-candle) — forwarded to risk manager
  volOfVol?: number | null  // vol-of-vol: high = unstable regime → reduce position size
  dScore?: number | null    // precise d-score from pipeline candles (used to sync currentD display)
  predictedPrice?: number   // hourly mode: Grok's forecasted BTC price at hour close
}

export interface RiskOutput {
  approved: boolean
  rejectionReason?: string
  positionSize: number   // contracts
  maxLoss: number        // $ max loss on this trade
  dailyPnl: number       // simulated session P&L
  givebackDollars: number  // $ given back from today's peak P&L (replaces drawdownPct %)
  tradeCount: number
}

export interface ExecutionOutput {
  action: 'BUY_YES' | 'BUY_NO' | 'PASS'
  side: 'yes' | 'no' | null
  limitPrice: number | null   // cents
  contracts: number
  estimatedCost: number       // $
  estimatedPayout: number     // $ if win
  marketTicker: string
  rationale: string
}

export interface MarkovOutput {
  // Current momentum state (1-min % price change bin, 0–8)
  currentState:     number
  stateLabel:       string       // e.g. "0.5→1%"
  historyLength:    number       // 1-min transitions accumulated

  // Momentum forecast — P(YES) derived from Chapman-Kolmogorov propagation
  pHatYes:          number       // P(BTC > strike at expiry) from momentum model
  pHatNo:           number       // 1 - pHatYes
  expectedDriftPct: number       // expected cumulative % price change over T minutes
  requiredDriftPct: number       // drift needed for YES (≈ −distanceFromStrikePct)
  sigma:            number       // std dev of cumulative drift distribution
  zScore:           number       // (expectedDrift − requiredDrift) / sigma

  // Transition matrix stats
  jStar:            number       // most likely next momentum state (argmax P[s])
  jStarLabel:       string
  persist:          number       // P[currentState][currentState] — momentum self-persistence
  enterYes:         boolean      // strong YES: pYes >= 0.65 AND persist >= 0.80
  enterNo:          boolean      // strong NO:  pYes <= 0.35 AND persist >= 0.80
  tau:              number       // persist threshold used
  transitionMatrix: number[][]   // full 9×9 matrix for UI heatmap
  numStates:        number       // always 9

  // Legacy fields (kept for type compat — set to 0 in new model)
  pMarketYes?:      number
  pMarketNo?:       number
  gapYes?:          number
  gapNo?:           number
  eps?:             number

  // Risk decision (Markov is the engine)
  recommendation:   'YES' | 'NO' | 'NO_TRADE'
  approved:         boolean
  rejectionReason?: string
  positionSize:     number
  maxLoss:          number
  dailyPnl:         number
  givebackDollars:  number
  tradeCount:       number
}

// ─── Pipeline State ────────────────────────────────────────────────────────

/** Union of all specific agent result types — used for the SSE emit callback. */
export type AnyAgentResult =
  | AgentResult<MarketDiscoveryOutput>
  | AgentResult<PriceFeedOutput>
  | AgentResult<SentimentOutput>
  | AgentResult<ProbabilityOutput>
  | AgentResult<MarkovOutput>
  | AgentResult<RiskOutput>
  | AgentResult<ExecutionOutput>

/** Partial agents map — populated incrementally during SSE streaming */
export type PartialPipelineAgents = Partial<PipelineState['agents']>

export interface PipelineState {
  cycleId: number
  cycleStartedAt: string
  cycleCompletedAt?: string
  status: 'running' | 'completed' | 'error'
  agents: {
    marketDiscovery: AgentResult<MarketDiscoveryOutput>
    priceFeed: AgentResult<PriceFeedOutput>
    sentiment: AgentResult<SentimentOutput>
    probability: AgentResult<ProbabilityOutput>
    markov: AgentResult<MarkovOutput>
    risk?: AgentResult<RiskOutput>
    execution: AgentResult<ExecutionOutput>
  }
}

// ─── Kalshi Portfolio Types ─────────────────────────────────────────────────

export interface KalshiBalance {
  balance: number         // cents
  portfolio_value: number // cents
}

export interface KalshiPosition {
  ticker: string
  position: number        // positive = YES, negative = NO (contracts)
  realized_pnl: number    // cents
  market_exposure: number // cents
  fees_paid: number       // cents
  resting_orders_count: number
}

export interface KalshiOrder {
  order_id: string
  ticker: string
  side: 'yes' | 'no'
  action: 'buy' | 'sell'
  count: number
  fill_count: number
  remaining_count: number
  initial_count: number
  yes_price: number       // cents
  no_price: number        // cents
  status: 'resting' | 'canceled' | 'executed' | 'pending'
  created_time: string
  client_order_id?: string
}

export interface KalshiFill {
  fill_id: string
  order_id: string
  ticker: string
  side: 'yes' | 'no'
  action: 'buy' | 'sell'
  count: number
  yes_price: number       // cents
  no_price: number        // cents
  is_taker: boolean
  created_time: string
  fee_cost: string        // dollar string e.g. "0.01"
}

/** Normalize raw Kalshi API position — new API uses _fp / _dollars suffixes.
 *  Parameter is RawKalshiPosition (Record<string, unknown>) because this sits at the
 *  API response boundary — callers pass JSON.parse() output directly.
 */
export function normalizeKalshiPosition(p: RawKalshiPosition): KalshiPosition {
  const fp  = (v: unknown) => parseFloat(String(v ?? 0)) || 0
  const toC = (dollars: unknown, cents: unknown) =>
    (cents !== undefined && cents !== null && fp(cents) !== 0) ? fp(cents) : Math.round(fp(dollars) * 100)
  return {
    ticker:              String(p.ticker ?? p.market_ticker ?? ''),
    position:            fp(p.position_fp ?? p.position),
    realized_pnl:        toC(p.realized_pnl_dollars, p.realized_pnl),
    market_exposure:     toC(p.market_exposure_dollars, p.market_exposure),
    fees_paid:           toC(p.fees_paid_dollars, p.fees_paid),
    resting_orders_count: fp(p.resting_orders_count),
  }
}

/** Normalize raw Kalshi API order.
 *  Parameter is RawKalshiOrder (Record<string, unknown>) because this sits at the
 *  API response boundary — callers pass JSON.parse() output directly.
 */
export function normalizeKalshiOrder(o: RawKalshiOrder): KalshiOrder {
  const fp  = (v: unknown) => parseFloat(String(v ?? 0)) || 0
  const toC = (dollars: unknown, cents: unknown) =>
    (cents !== undefined && cents !== null && fp(cents) !== 0) ? fp(cents) : Math.round(fp(dollars) * 100)
  return {
    order_id:        String(o.order_id ?? ''),
    ticker:          String(o.ticker ?? o.market_ticker ?? ''),
    side:            o.side as 'yes' | 'no',
    action:          o.action as 'buy' | 'sell',
    count:           fp(o.count_fp ?? o.count),
    fill_count:      fp(o.fill_count_fp ?? o.fill_count),
    remaining_count: fp(o.remaining_count_fp ?? o.remaining_count),
    initial_count:   fp(o.initial_count_fp ?? o.initial_count ?? o.count_fp ?? o.count),
    yes_price:       toC(o.yes_price_dollars, o.yes_price),
    no_price:        toC(o.no_price_dollars,  o.no_price),
    status:          o.status as KalshiOrder['status'],
    created_time:    String(o.created_time ?? ''),
    client_order_id: o.client_order_id as string | undefined,
  }
}

/** Normalize raw Kalshi API fill.
 *  Parameter is RawKalshiFill (Record<string, unknown>) because this sits at the
 *  API response boundary — callers pass JSON.parse() output directly.
 */
export function normalizeKalshiFill(f: RawKalshiFill): KalshiFill {
  const fp  = (v: unknown) => parseFloat(String(v ?? 0)) || 0
  const toC = (dollars: unknown, cents: unknown) =>
    (cents !== undefined && cents !== null && fp(cents) !== 0) ? fp(cents) : Math.round(fp(dollars) * 100)
  return {
    fill_id:      String(f.fill_id ?? f.trade_id ?? ''),
    order_id:     String(f.order_id ?? ''),
    ticker:       String(f.ticker ?? f.market_ticker ?? ''),
    side:         f.side as 'yes' | 'no',
    action:       f.action as 'buy' | 'sell',
    count:        fp(f.count_fp ?? f.count),
    yes_price:    toC(f.yes_price_dollars, f.yes_price),
    no_price:     toC(f.no_price_dollars,  f.no_price),
    is_taker:     (f.is_taker as boolean | undefined) ?? false,
    created_time: String(f.created_time ?? ''),
    fee_cost:     String(f.fee_cost ?? '0'),
  }
}

// ─── Trade Log ─────────────────────────────────────────────────────────────

export type TradeOutcome = 'WIN' | 'LOSS' | 'PENDING'

/** Full signal snapshot captured at trade entry — used for calibration and attribution */
export interface TradeSignals {
  // Sentiment agent
  sentimentScore: number       // -1 to +1
  sentimentMomentum: number    // -1 to +1
  orderbookSkew: number        // -1 to +1
  sentimentLabel: string       // e.g. 'strongly_bullish'
  // Probability agent
  pLLM: number                 // model P(YES) at entry (quant or Grok mode)
  confidence: string           // 'high' | 'medium' | 'low'
  gkVol: number | null         // Garman-Klass realized vol
  // Market context
  distancePct: number          // BTC distance from strike (signed %)
  minutesLeft: number          // minutes until expiry
  aboveStrike: boolean         // BTC above strike at entry
  // Market structure
  priceMomentum1h: number      // 1h price change %
}

export interface TradeRecord {
  id: string
  cycleId: number
  marketTicker: string
  side: 'yes' | 'no'
  limitPrice: number        // cents
  contracts: number
  estimatedCost: number
  enteredAt: string
  expiresAt: string
  strikePrice: number
  btcPriceAtEntry: number
  outcome: TradeOutcome
  settlementPrice?: number
  pnl?: number
  pModel: number
  pMarket: number
  edge: number
  signals?: TradeSignals    // full signal vector for calibration/attribution
  // Live trading fields
  liveOrderId?: string
  liveMode?: boolean
  // Backtest flag — true for synthetic records from historical backtest
  isBacktest?: boolean
}

// ─── Agent Engine ────────────────────────────────────────────────────────────

export interface AgentTrade {
  id: string
  cycleId: number
  windowKey: string       // event_ticker identifying the 15-min window
  sliceNum: number        // 1-based slice index within this window
  side: 'yes' | 'no'
  limitPrice: number      // cents
  contracts: number
  cost: number            // dollars deployed for this slice
  marketTicker: string
  strikePrice: number
  btcPriceAtEntry?: number
  expiresAt: string
  enteredAt: string
  status: 'open' | 'won' | 'lost'
  pnl?: number            // profit/loss in dollars (net of cost)
  settlementPrice?: number
  pModel: number
  pMarket: number
  edge: number
  signals?: TradeSignals  // full signal vector for calibration/attribution
  liveOrderId?: string
  liveMode?: boolean
  orderError?: string     // set if live order placement failed
}

export interface AgentStats {
  windowsTraded: number
  totalSlices: number
  totalDeployed: number
  totalPnl: number
  wins: number
  losses: number
  winRate: number
  bestWindow: number
  worstWindow: number
}

