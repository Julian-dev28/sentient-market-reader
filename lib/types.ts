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
  status: 'open' | 'active' | 'closed' | 'settled' | 'paused'
  result?: string
  settlement_value?: number
  // Real Kalshi fields
  floor_strike?: number     // the BTC "price to beat" — first-class field
  yes_sub_title?: string    // "Price to beat: $65,619.62"
  no_sub_title?: string
  rules_primary?: string
  market_type?: string
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
}

export interface ProbabilityOutput {
  pModel: number         // 0.0–1.0 model's P(YES)
  pMarket: number        // 0.0–1.0 market-implied P(YES) from yes_ask
  edge: number           // pModel - pMarket
  edgePct: number        // edge as %
  recommendation: 'YES' | 'NO' | 'NO_TRADE'
  confidence: 'high' | 'medium' | 'low'
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
  position: number        // positive = YES, negative = NO
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

// ─── Trade Log ─────────────────────────────────────────────────────────────

export type TradeOutcome = 'WIN' | 'LOSS' | 'PENDING'

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
  // Live trading fields
  liveOrderId?: string
  liveMode?: boolean
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
