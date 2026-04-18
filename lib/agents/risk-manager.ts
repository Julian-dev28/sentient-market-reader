import type { AgentResult, RiskOutput, MarkovOutput } from '../types'

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
  minEdgePct:        0,    // disabled
  minMinutesLeft:    6,    // skip if < 6 min left — 6-9min = 98.3% WR vs 3-6min = 91.7% WR on live fills
  maxMinutesLeft:    9,    // live fills: 9-12min window is 69.5% wr (signal not settled)
  minDistancePct:   0.02,  // skip near-strike noise (|dist| < 0.02% → ~50/50)
  minEntryPrice:     0,    // no floor — 62¢ and 71¢ zones both profitable
  maxEntryPrice:    72,    // ¢ — market efficiency cap: 71¢ zone (d>2.0) = 91.5% WR; 73¢+ zone = 66% WR (losing)
  maxTradePct:      15,    // % of portfolio per trade
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
  portfolioValue: number = 500,
  minutesUntilExpiry?: number,
  distanceFromStrikePct?: number,
  volOfVol?: number | null,
  isHourly: boolean = false,
  markov?: MarkovOutput | null,
): AgentResult<RiskOutput> {
  const start = Date.now()
  checkDailyReset()

  const { maxDailyLoss, maxTradeCapital } = dynamicLimits(portfolioValue)
  const givebackLimit = maxGivebackDollars(maxDailyLoss)

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

  // Time gate params differ by market type and entry price.
  // 65–73¢ golden zone (d≥2.0): 93%+ WR across 3–12 min — timing doesn't matter, widen window.
  // All other prices: keep tight 6–9 min (signal noise outside that band).
  // Hourly (KXBTCD): enter when 10–45 min remain; no empirical validation yet — conservative.
  const isGoldenZone = !isHourly && limitPrice >= 65 && limitPrice <= 73
  const minMin = isHourly ? 10 : (isGoldenZone ? 3 : RISK_PARAMS.minMinutesLeft)
  const maxMin = isHourly ? 45 : (isGoldenZone ? 12 : RISK_PARAMS.maxMinutesLeft)
  const maxTrades = isHourly ? 24 : RISK_PARAMS.maxTradesPerDay

  if (recommendation === 'NO_TRADE') {
    approved = false
    rejectionReason = `Quant model: no trade signal — d-score outside edge zone or insufficient model confidence`
  } else if (BLOCKED_UTC_HOURS.has(utcHour)) {
    approved = false
    rejectionReason = `Blocked UTC hour ${utcHour}:00 — empirically bad session (live data: -40 to -57pp margin at d∈[1.0,1.2])`
  } else if (minutesUntilExpiry !== undefined && minutesUntilExpiry < minMin) {
    approved = false
    rejectionReason = `Too late in window (${minutesUntilExpiry.toFixed(1)}min left < ${minMin}min minimum${isGoldenZone ? ' [golden zone]' : ''})`
  } else if (minutesUntilExpiry !== undefined && minutesUntilExpiry > maxMin) {
    approved = false
    rejectionReason = `Too early in window (${minutesUntilExpiry.toFixed(1)}min left > ${maxMin}min${isGoldenZone ? ' [golden zone 3–12min]' : isHourly ? ' — wait for price to settle' : ' — signal not settled'})`
  } else if (distanceFromStrikePct !== undefined && Math.abs(distanceFromStrikePct) < RISK_PARAMS.minDistancePct) {
    approved = false
    rejectionReason = `Price too close to strike (${distanceFromStrikePct.toFixed(4)}% — near-strike trades are ~50/50 noise)`
  } else if (sessionState.dailyPnl <= maxDailyLoss) {
    approved = false
    rejectionReason = `Daily loss limit reached ($${Math.abs(maxDailyLoss).toFixed(0)} = ${RISK_PARAMS.maxDailyLossPct}% of $${portfolioValue.toFixed(0)} portfolio)`
  } else if (givebackDollars >= givebackLimit) {
    approved = false
    rejectionReason = `Session giveback limit: gave back $${givebackDollars.toFixed(2)} from peak $${sessionState.peakPnl.toFixed(2)} (limit: $${givebackLimit.toFixed(0)} = ${RISK_PARAMS.maxGivebackMult}× daily loss cap)`
  } else if (sessionState.tradeCount >= maxTrades) {
    approved = false
    rejectionReason = `Daily trade count cap reached (${maxTrades})`
  } else if (limitPrice < RISK_PARAMS.minEntryPrice) {
    approved = false
    rejectionReason = `BUY ${recommendation} entry price ${limitPrice}¢ below min ${RISK_PARAMS.minEntryPrice}¢ — model has no edge at near-50/50 prices`
  } else if (limitPrice > RISK_PARAMS.maxEntryPrice) {
    approved = false
    rejectionReason = `BUY ${recommendation} entry price ${limitPrice}¢ above max ${RISK_PARAMS.maxEntryPrice}¢ — fee eats >12% of gross margin at this price`
  } else if (edgePct < RISK_PARAMS.minEdgePct) {
    approved = false
    rejectionReason = `After-fee EV ${edgePct.toFixed(2)}% < minimum ${RISK_PARAMS.minEdgePct}% — insufficient edge to overcome variance`
  } else if (
    markov && markov.historyLength >= 20 &&
    ((recommendation === 'YES' && markov.enterNo  && !markov.enterYes) ||
     (recommendation === 'NO'  && markov.enterYes && !markov.enterNo))
  ) {
    // Markov has enough history and its high-confidence signal directly opposes the recommendation.
    // enterNo/enterYes require gap >= 0.05 AND persist >= 0.87 — this is a strong disagreement.
    const markovDir = recommendation === 'YES' ? 'NO' : 'YES'
    approved = false
    rejectionReason = `Markov chain opposes: model says ${recommendation} but transition matrix favours ${markovDir} (P(YES)=${(markov.pHatYes * 100).toFixed(1)}%, persist=${(markov.persist * 100).toFixed(1)}%)`
  }

  // ── Tiered Kelly sizing (aligned with Python backtest) ────────────────────
  // Uses price-bucket Kelly fractions based on backtest win rates:
  // 65-73¢: 35% Kelly (93.8% WR golden zone)
  // 73-79¢: 12% Kelly (71% WR zone)
  // 79-85¢: 8% Kelly (76% WR zone)
  // 85¢+: 5% Kelly (marginal edge)
  const MAKER_FEE_RATE = 0.0175
  const p_dollars      = limitPrice / 100
  const feePerContract = MAKER_FEE_RATE * p_dollars * (1 - p_dollars)
  const netWinPerC     = (1 - p_dollars) - feePerContract
  const totalCostPerC  = p_dollars + feePerContract

  // Determine Kelly fraction based on entry price bucket
  let kellyFraction: number
  if (limitPrice <= 73) {
    kellyFraction = 0.35  // 35% Kelly for 65-73¢ (93.8% WR)
  } else if (limitPrice <= 79) {
    kellyFraction = 0.12  // 12% Kelly for 73-79¢ (71% WR)
  } else if (limitPrice <= 85) {
    kellyFraction = 0.08  // 8% Kelly for 79-85¢ (76% WR)
  } else {
    kellyFraction = 0.05  // 5% Kelly for >85¢ (marginal)
  }

  // Calculate full Kelly
  const pWin = (recommendation === 'NO' ? (1 - pModel) : pModel)
  const b_odds = totalCostPerC > 0 ? netWinPerC / totalCostPerC : 1.0
  const fullKelly = Math.max(0, (b_odds * pWin - (1 - pWin)) / b_odds)

  // Apply tiered Kelly fraction
  const riskPct = Math.min(RISK_PARAMS.maxTradePct, kellyFraction * fullKelly)
  const riskDollars = portfolioValue * riskPct
  const budgetContracts = totalCostPerC > 0 ? Math.round(riskDollars / totalCostPerC) : 0
  const positionSize = Math.max(1, budgetContracts)



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
      ? `BUY ${recommendation} approved @ ${limitPrice}¢ (P(WIN)=${(pWin * 100).toFixed(1)}%). Portfolio: $${portfolioValue.toFixed(0)}. Size: ${positionSize} contracts (${(kellyFraction * 100).toFixed(0)}% Kelly → risk=${(riskPct * 100).toFixed(1)}% → $${riskDollars.toFixed(0)}). Max loss: $${maxLoss.toFixed(2)} (${pctOfPortfolio.toFixed(1)}% of portfolio). Daily P&L: $${sessionState.dailyPnl.toFixed(2)} / limit $${Math.abs(maxDailyLoss).toFixed(0)}.`
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
