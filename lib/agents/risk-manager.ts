import type { AgentResult, RiskOutput } from '../types'

// In-memory session risk state — pinned to globalThis so it survives across
// Next.js hot-reloads locally AND persists on warm Vercel serverless instances.
// Cold starts reset to zero (unavoidable on serverless), but warm reuse retains state.
const g = globalThis as typeof globalThis & {
  _riskSessionState?: { dailyPnl: number; tradeCount: number; peakPnl: number }
  _riskLastResetDate?: string
}
if (!g._riskSessionState) g._riskSessionState = { dailyPnl: 0, tradeCount: 0, peakPnl: 0 }
if (!g._riskLastResetDate) g._riskLastResetDate = new Date().toDateString()

const sessionState = g._riskSessionState

export function checkDailyReset(): void {
  const today = new Date().toDateString()
  if (today !== g._riskLastResetDate) {
    g._riskLastResetDate = today
    g._riskSessionState!.dailyPnl  = 0
    g._riskSessionState!.tradeCount = 0
    g._riskSessionState!.peakPnl   = 0
  }
}

const RISK_PARAMS = {
  maxDailyLossPct:   5,    // % of portfolio — daily drawdown limit
  maxDailyLossFloor: 50,   // $ minimum daily loss cap (protects tiny accounts)
  maxDailyLossCap:  150,   // $ maximum daily loss cap (hard ceiling)
  // Session drawdown gate: stop if today's P&L falls more than maxGivebackMult × maxDailyLoss
  // from the session peak. This replaces the old "15% of session P&L peak" gate which
  // misfired on every single loss because avg_loss ($18) >> avg_win ($3.60) — any loss from
  // even a 1-win session triggered 15%, blocking 36% of otherwise-valid qualifying trades.
  // Dollar-based giveback = more appropriate for asymmetric binary strategies.
  maxGivebackMult:   1.5,  // stop if daily P&L drops > 1.5× maxDailyLoss from session peak
  maxTradesPerDay:  48,    // caps at one per 15-min window
  minEdgePct:        5,    // % minimum edge — lowered 6→5 to allow trend-boosted bets (pModel = market+7pp → ~6% edge)
  minMinutesLeft:    3,    // skip if < 3 min left (too late to size)
  maxMinutesLeft:    9,    // live fills: 9-12min window is 69.5% wr (signal not settled); 3-9min is 95.7% wr
  minDistancePct:   0.02,  // skip near-strike noise (|dist| < 0.02% → ~50/50)
  minEntryPrice:    72,    // ¢ — minimum entry price gate; empirical prices at d∈[1.0,1.2] average 80.8¢
  maxEntryPrice:    92,    // ¢ — above 92¢ the fee eats >12% of gross margin (6→8¢ profit per contract); risk/reward degrades
  maxContractSize:  500,   // ceiling position size (contracts)
  maxTradePct:      15,    // % of portfolio per trade — validated in 787-trade backtest at 0.25× Kelly
}
// Computed giveback limit: how far (in $) today's P&L can fall from its peak before we stop.
// Applied per-session (resets midnight ET), same as the daily loss limit.
// At $291 portfolio: maxDailyLoss ≈ -$50 → giveback = 1.5 × $50 = $75 (about 3 avg losses).
function maxGivebackDollars(maxDailyLoss: number): number {
  return Math.abs(maxDailyLoss) * RISK_PARAMS.maxGivebackMult
}

// Baseline 15-min Garman-Klass vol for BTC (~0.20%/candle).
// Position scales inversely with vol: high-vol cycles get smaller size, low-vol get larger.
const REFERENCE_VOL_15M = 0.002

/** Compute dynamic risk limits from current portfolio value. */
function dynamicLimits(portfolioValue: number) {
  const maxDailyLoss = -Math.max(
    RISK_PARAMS.maxDailyLossFloor,
    Math.min(RISK_PARAMS.maxDailyLossCap, portfolioValue * RISK_PARAMS.maxDailyLossPct / 100),
  )
  const maxTradeCapital = portfolioValue * RISK_PARAMS.maxTradePct / 100  // $ max at risk per trade
  return { maxDailyLoss, maxTradeCapital }
}

// ── Deterministic Kelly risk manager ──────────────────────────────────────────
export function runRiskManager(
  edgePct: number,
  pModel: number,
  recommendation: 'YES' | 'NO' | 'NO_TRADE',
  limitPrice: number,
  sentimentScore?: number,
  gkVol15m?: number | null,
  confidence?: 'high' | 'medium' | 'low',
  portfolioValue: number = 500,   // actual Kalshi account value in dollars
  minutesUntilExpiry?: number,    // minutes remaining in the 15-min window
  distanceFromStrikePct?: number, // how far BTC is from strike (%)
  volOfVol?: number | null,       // vol-of-vol: high = unstable regime → reduce position size
): AgentResult<RiskOutput> {
  const start = Date.now()
  checkDailyReset()

  const { maxDailyLoss, maxTradeCapital } = dynamicLimits(portfolioValue)
  const givebackLimit = maxGivebackDollars(maxDailyLoss)

  // Session giveback: how many $ we've dropped from today's peak P&L.
  // Uses dollars, not %, because avg_loss ($18) >> avg_win ($3.60) —
  // a % gate would fire on almost every first loss of the day.
  const givebackDollars = sessionState.peakPnl > 0
    ? sessionState.peakPnl - sessionState.dailyPnl
    : 0

  let approved = true
  let rejectionReason: string | undefined

  // ── Time-of-day gate (UTC) ────────────────────────────────────────────────
  // Empirical analysis of 2,690 live fills: hours 11 and 18 UTC are catastrophically
  // bad even within the confirmed d∈[1.0,1.2] edge zone (-57pp and -40pp margin).
  // 11:00 UTC = pre-market US / Asian session close. 18:00 UTC = US afternoon news flow.
  const BLOCKED_UTC_HOURS = new Set([11, 18])
  const utcHour = new Date().getUTCHours()

  if (recommendation === 'NO_TRADE') {
    approved = false
    rejectionReason = `Quant model: no trade signal — d-score outside edge zone or insufficient model confidence`
  } else if (BLOCKED_UTC_HOURS.has(utcHour)) {
    approved = false
    rejectionReason = `Blocked UTC hour ${utcHour}:00 — empirically bad session (live data: -40 to -57pp margin at d∈[1.0,1.2])`
  } else if (minutesUntilExpiry !== undefined && minutesUntilExpiry < RISK_PARAMS.minMinutesLeft) {
    approved = false
    rejectionReason = `Too late in window (${minutesUntilExpiry.toFixed(1)}min left < ${RISK_PARAMS.minMinutesLeft}min minimum)`
  } else if (minutesUntilExpiry !== undefined && minutesUntilExpiry > RISK_PARAMS.maxMinutesLeft) {
    approved = false
    rejectionReason = `Too early in window (${minutesUntilExpiry.toFixed(1)}min left > ${RISK_PARAMS.maxMinutesLeft}min — signal not settled)`
  } else if (distanceFromStrikePct !== undefined && Math.abs(distanceFromStrikePct) < RISK_PARAMS.minDistancePct) {
    approved = false
    rejectionReason = `Price too close to strike (${distanceFromStrikePct.toFixed(4)}% — near-strike trades are ~50/50 noise)`
  } else if (sessionState.dailyPnl <= maxDailyLoss) {
    approved = false
    rejectionReason = `Daily loss limit reached ($${Math.abs(maxDailyLoss).toFixed(0)} = ${RISK_PARAMS.maxDailyLossPct}% of $${portfolioValue.toFixed(0)} portfolio)`
  } else if (givebackDollars >= givebackLimit) {
    approved = false
    rejectionReason = `Session giveback limit: gave back $${givebackDollars.toFixed(2)} from peak $${sessionState.peakPnl.toFixed(2)} (limit: $${givebackLimit.toFixed(0)} = ${RISK_PARAMS.maxGivebackMult}× daily loss cap)`
  } else if (sessionState.tradeCount >= RISK_PARAMS.maxTradesPerDay) {
    approved = false
    rejectionReason = `Daily trade count cap reached (${RISK_PARAMS.maxTradesPerDay})`
  } else if (limitPrice < RISK_PARAMS.minEntryPrice) {
    approved = false
    rejectionReason = `BUY ${recommendation} entry price ${limitPrice}¢ below min ${RISK_PARAMS.minEntryPrice}¢ — model has no edge at near-50/50 prices`
  } else if (limitPrice > RISK_PARAMS.maxEntryPrice) {
    approved = false
    rejectionReason = `BUY ${recommendation} entry price ${limitPrice}¢ above max ${RISK_PARAMS.maxEntryPrice}¢ — fee eats >12% of gross margin at this price`
  } else if (edgePct < RISK_PARAMS.minEdgePct) {
    approved = false
    rejectionReason = `After-fee EV ${edgePct.toFixed(2)}% < minimum ${RISK_PARAMS.minEdgePct}% — insufficient edge to overcome variance`
  }

  // ── Portfolio-proportional Half-Kelly sizing ──────────────────────────────
  // Kalshi maker fee formula: ceil(0.0175 × C × P × (1-P)) per order
  // Agent places resting limit orders → maker rate (0.0175), not taker (0.07).
  // Fee is charged at entry on every trade (win or loss), not just on profits.
  // Per-contract fee approximation (pre-ceiling, accurate for sizing math):
  //   feePerContract = 0.0175 × P × (1-P)  where P = limitPrice/100
  // IMPORTANT: pModel is always P(YES). For NO trades, the win probability is 1 - pModel.
  const MAKER_FEE_RATE = 0.0175
  const p_dollars      = limitPrice / 100
  const feePerContract = MAKER_FEE_RATE * p_dollars * (1 - p_dollars)  // $ per contract
  const netWinPerC     = (1 - p_dollars) - feePerContract   // net profit if win
  const totalCostPerC  = p_dollars + feePerContract          // total outlay per contract
  const b              = limitPrice > 0 ? netWinPerC / totalCostPerC : 1
  const pWin           = recommendation === 'NO' ? (1 - pModel) : pModel
  const kellyFraction  = Math.max(0, (b * pWin - (1 - pWin)) / b)

  // Volatility scalar: high-vol → smaller size. Clamped [0.30, 1.50].
  const volScalar = gkVol15m && gkVol15m > 0
    ? Math.max(0.30, Math.min(1.50, REFERENCE_VOL_15M / gkVol15m))
    : 1.0

  // Confidence scalar: high → 100% · medium → 80% · low → 50%
  // ROMA medium confidence is still a real signal — don't halve the position
  const confScalar = confidence === 'high' ? 1.00
                   : confidence === 'low'  ? 0.50
                   : 0.80

  // VoV scalar removed: empirical backtest (787 trades) shows elevated VoV correlates
  // with BETTER margins (+8.9pp at VoV 0.95-1.5 vs +7.3pp normal). The reduction was wrong.

  // Capital budget: quarter-Kelly fraction of portfolio, capped at maxTradeCapital.
  // 0.25× validated in 787-trade backtest (MaxDD 13.3%, WR 92.2%).
  // Full half-Kelly (0.5×) was never backtested — do not raise until OOS validation.
  const halfKellyCapital = kellyFraction * 0.25 * portfolioValue * volScalar * confScalar
  const tradeBudget      = Math.min(halfKellyCapital, maxTradeCapital)
  const budgetContracts  = totalCostPerC > 0 ? Math.round(tradeBudget / totalCostPerC) : 0
  const positionSize     = Math.min(budgetContracts, RISK_PARAMS.maxContractSize)

  // Kelly says no edge at this price — reject rather than force a position
  if (approved && positionSize <= 0) {
    approved = false
    rejectionReason = `Kelly fraction zero at ${limitPrice}¢ — negative expected value at this price`
  }

  // Net expected profit after maker fee — proportional floor (0.5% of portfolio, min $0.25)
  const minProfit      = Math.max(0.25, portfolioValue * 0.005)
  const expectedProfit = netWinPerC * positionSize
  if (approved && expectedProfit < minProfit) {
    approved = false
    rejectionReason = `Net profit after fees $${expectedProfit.toFixed(2)} < minimum $${minProfit.toFixed(2)} (0.5% of $${portfolioValue.toFixed(0)})`
  }

  const maxLoss          = approved ? totalCostPerC * positionSize : 0
  const pctOfPortfolio   = portfolioValue > 0 ? (maxLoss / portfolioValue) * 100 : 0

  return {
    agentName: 'RiskManagerAgent',
    status: approved ? 'done' : 'skipped',
    output: {
      approved,
      rejectionReason,
      positionSize: approved ? positionSize : 0,
      maxLoss,
      dailyPnl: sessionState.dailyPnl,
      givebackDollars,
      tradeCount: sessionState.tradeCount,
    },
    reasoning: approved
      ? `BUY ${recommendation} approved @ ${limitPrice}¢ (P(WIN)=${(pWin * 100).toFixed(1)}%). Portfolio: $${portfolioValue.toFixed(0)}. Size: ${positionSize} contracts (Kelly=${(kellyFraction * 100).toFixed(1)}% × 0.25 × vol=${volScalar.toFixed(2)} × conf=${confScalar.toFixed(2)} → $${tradeBudget.toFixed(0)} budget). Max loss: $${maxLoss.toFixed(2)} (${pctOfPortfolio.toFixed(1)}% of portfolio). Daily P&L: $${sessionState.dailyPnl.toFixed(2)} / limit $${Math.abs(maxDailyLoss).toFixed(0)}.`
      : `BUY ${recommendation} REJECTED — ${rejectionReason}`,
    durationMs: Date.now() - start,
    timestamp: new Date().toISOString(),
  }
}


export function recordTradeResult(pnl: number): void {
  sessionState.dailyPnl += pnl
  sessionState.tradeCount += 1
  if (sessionState.dailyPnl > sessionState.peakPnl) {
    sessionState.peakPnl = sessionState.dailyPnl
  }
}

export function getSessionState() {
  return { ...sessionState }
}
