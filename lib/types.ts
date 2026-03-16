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
 * Normalize a raw Kalshi API market object.
 * The v2 API now returns `yes_ask_dollars` (float USD) instead of `yes_ask` (int cents).
 * This converts dollar fields → cent fields so all downstream code stays consistent.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function normalizeKalshiMarket(m: any): KalshiMarket {
  const toC = (dollars: number | undefined, cents: number | undefined): number => {
    if (cents && cents > 0) return cents
    if (dollars !== undefined && dollars >= 0) return Math.round(dollars * 100)
    return 0
  }
  const fp = (v: unknown) => parseFloat(String(v ?? 0)) || 0
  return {
    ...m,
    yes_ask:       toC(m.yes_ask_dollars,      m.yes_ask),
    yes_bid:       toC(m.yes_bid_dollars,      m.yes_bid),
    no_ask:        toC(m.no_ask_dollars,       m.no_ask),
    no_bid:        toC(m.no_bid_dollars,       m.no_bid),
    last_price:    toC(m.last_price_dollars,   m.last_price),
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

// ─── CoinMarketCap Types ───────────────────────────────────────────────────

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
  edge: number           // pModel - pMarket
  edgePct: number        // edge as %
  recommendation: 'YES' | 'NO' | 'NO_TRADE'
  confidence: 'high' | 'medium' | 'low'
  provider: string       // e.g. "grok/grok-4-0709"
  gkVol15m?: number | null  // Garman-Klass realized vol (per-candle) — forwarded to risk manager
}

export interface RiskOutput {
  approved: boolean
  rejectionReason?: string
  positionSize: number   // contracts
  maxLoss: number        // $ max loss on this trade
  dailyPnl: number       // simulated session P&L
  drawdownPct: number
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

// ─── Pipeline State ────────────────────────────────────────────────────────

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
    risk: AgentResult<RiskOutput>
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

/** Normalize raw Kalshi API position — new API uses _fp / _dollars suffixes */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function normalizeKalshiPosition(p: any): KalshiPosition {
  const fp  = (v: unknown) => parseFloat(String(v ?? 0)) || 0
  const toC = (dollars: unknown, cents: unknown) =>
    (cents !== undefined && cents !== null && fp(cents) !== 0) ? fp(cents) : Math.round(fp(dollars) * 100)
  return {
    ticker:              p.ticker ?? p.market_ticker ?? '',
    position:            fp(p.position_fp ?? p.position),
    realized_pnl:        toC(p.realized_pnl_dollars, p.realized_pnl),
    market_exposure:     toC(p.market_exposure_dollars, p.market_exposure),
    fees_paid:           toC(p.fees_paid_dollars, p.fees_paid),
    resting_orders_count: fp(p.resting_orders_count),
  }
}

/** Normalize raw Kalshi API order */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function normalizeKalshiOrder(o: any): KalshiOrder {
  const fp  = (v: unknown) => parseFloat(String(v ?? 0)) || 0
  const toC = (dollars: unknown, cents: unknown) =>
    (cents !== undefined && cents !== null && fp(cents) !== 0) ? fp(cents) : Math.round(fp(dollars) * 100)
  return {
    order_id:        o.order_id ?? '',
    ticker:          o.ticker ?? o.market_ticker ?? '',
    side:            o.side,
    action:          o.action,
    count:           fp(o.count_fp ?? o.count),
    fill_count:      fp(o.fill_count_fp ?? o.fill_count),
    remaining_count: fp(o.remaining_count_fp ?? o.remaining_count),
    initial_count:   fp(o.initial_count_fp ?? o.initial_count ?? o.count_fp ?? o.count),
    yes_price:       toC(o.yes_price_dollars, o.yes_price),
    no_price:        toC(o.no_price_dollars,  o.no_price),
    status:          o.status,
    created_time:    o.created_time ?? '',
    client_order_id: o.client_order_id,
  }
}

/** Normalize raw Kalshi API fill */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function normalizeKalshiFill(f: any): KalshiFill {
  const fp  = (v: unknown) => parseFloat(String(v ?? 0)) || 0
  const toC = (dollars: unknown, cents: unknown) =>
    (cents !== undefined && cents !== null && fp(cents) !== 0) ? fp(cents) : Math.round(fp(dollars) * 100)
  return {
    fill_id:      f.fill_id ?? f.trade_id ?? '',
    order_id:     f.order_id ?? '',
    ticker:       f.ticker ?? f.market_ticker ?? '',
    side:         f.side,
    action:       f.action,
    count:        fp(f.count_fp ?? f.count),
    yes_price:    toC(f.yes_price_dollars, f.yes_price),
    no_price:     toC(f.no_price_dollars,  f.no_price),
    is_taker:     f.is_taker ?? false,
    created_time: f.created_time ?? '',
    fee_cost:     f.fee_cost ?? '0',
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
  pLLM: number                 // raw LLM P(YES) before quant blend
  confidence: string           // 'high' | 'medium' | 'low'
  gkVol: number | null         // Garman-Klass realized vol
  // Market context
  distancePct: number          // BTC distance from strike (signed %)
  minutesLeft: number          // minutes until expiry
  aboveStrike: boolean         // BTC above strike at entry
  // Market structure
  priceMomentum1h: number      // 1h price change %
  // TimesFM (if available)
  timesfmPYes?: number         // TimesFM-derived P(YES)
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

// ─── Calibration ────────────────────────────────────────────────────────────

/** Calibration bucket: "when model says X%, how often does YES actually win?" */
export interface CalibrationBucket {
  bucket: string            // e.g. "50–60%"
  pMid: number              // midpoint, e.g. 0.55
  predicted: number         // avg pModel in bucket
  actual: number            // actual win rate
  count: number             // trade count
}

export interface SignalImportance {
  feature: string           // signal name
  coefficient: number       // logistic regression coefficient
  direction: 'bullish' | 'bearish' | 'mixed'
  accuracy: number          // % of times this signal correctly predicted direction
  count: number             // sample size
}

export interface CalibrationResult {
  brierScore: number        // 0–0.25; lower is better; random=0.25
  logLoss: number           // lower is better
  rocAuc: number            // 0.5–1.0; 0.5=random
  totalTrades: number
  settledTrades: number
  overallWinRate: number
  avgPModel: number         // average predicted P(YES) on YES trades
  buckets: CalibrationBucket[]
  signals: SignalImportance[]
  plattA: number | null     // Platt scaling coefficient a (null if not fitted)
  plattB: number | null     // Platt scaling coefficient b
  computedAt: string        // ISO timestamp
}

/** Daily optimization parameters output by Gemini meta-optimizer */
export interface DailyOptParams {
  alphaCap: number          // max quant weight (0.70–0.92)
  gateVelocityThreshold: number  // reachability gate (0.40–0.75)
  edgeMinPct: number        // minimum edge to trade (1.5–6.0)
  sentimentWeight: number   // LLM sentiment blend weight (0.05–0.30)
  fatTailNu: number | null  // Student-t degrees of freedom (null = auto)
  rationale: string         // Gemini's explanation
  riskLevel: 'conservative' | 'normal' | 'aggressive'
  computedAt: string
  tradesSampled: number
  brierScore: number
}

// ─── Performance ───────────────────────────────────────────────────────────

export interface PerformanceStats {
  totalTrades: number
  wins: number
  losses: number
  pending: number
  winRate: number
  totalPnl: number
  avgEdge: number
  avgReturn: number
  bestTrade: number
  worstTrade: number
}
