import type { AgentResult, RiskOutput } from '../types'
import type { AIProvider } from '../llm-client'
import { llmToolCall } from '../llm-client'
import { callPythonRoma, formatRomaTrace } from '../roma/python-client'

// In-memory session risk state — resets automatically at midnight ET
const sessionState = {
  dailyPnl: 0,
  tradeCount: 0,
  peakPnl: 0,
}
let lastResetDate = new Date().toDateString()

function checkDailyReset(): void {
  const today = new Date().toDateString()
  if (today !== lastResetDate) {
    lastResetDate = today
    sessionState.dailyPnl  = 0
    sessionState.tradeCount = 0
    sessionState.peakPnl   = 0
  }
}

const RISK_PARAMS = {
  maxDailyLossPct:   5,    // % of portfolio — daily drawdown limit
  maxDailyLossFloor: 50,   // $ minimum daily loss cap (protects tiny accounts)
  maxDailyLossCap:  150,   // $ maximum daily loss cap (hard ceiling)
  maxDrawdownPct:   15,    // % from peak
  maxTradesPerDay:  48,    // caps at one per 15-min window
  minEdgePct:        3,    // % minimum edge to trade
  minMinutesLeft:    3,    // skip if < 3 min left (too late to size)
  maxMinutesLeft:   12,    // skip if > 12 min left (signal not yet settled)
  minDistancePct:   0.02,  // skip near-strike noise (|dist| < 0.02% → ~50/50)
  minEntryPrice:    63,    // ¢ — reject if market price < 63¢ (model has no edge at near-50/50 prices)
  minExpectedProfit: 2.00, // $ — reject if max possible win < $2 (fee-killer)
  maxContractSize:  500,   // ceiling position size (contracts)
  maxTradePct:      10,    // % of portfolio — max capital at risk per trade
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
): AgentResult<RiskOutput> {
  const start = Date.now()
  checkDailyReset()

  const { maxDailyLoss, maxTradeCapital } = dynamicLimits(portfolioValue)

  const drawdownPct =
    sessionState.peakPnl > 0
      ? ((sessionState.peakPnl - sessionState.dailyPnl) / sessionState.peakPnl) * 100
      : 0

  let approved = true
  let rejectionReason: string | undefined

  if (recommendation === 'NO_TRADE') {
    approved = false
    rejectionReason = `Edge ${edgePct.toFixed(1)}% below minimum threshold (${RISK_PARAMS.minEdgePct}%)`
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
  } else if (drawdownPct >= RISK_PARAMS.maxDrawdownPct) {
    approved = false
    rejectionReason = `Max drawdown breached (${drawdownPct.toFixed(1)}% > ${RISK_PARAMS.maxDrawdownPct}%)`
  } else if (sessionState.tradeCount >= RISK_PARAMS.maxTradesPerDay) {
    approved = false
    rejectionReason = `Daily trade count cap reached (${RISK_PARAMS.maxTradesPerDay})`
  } else if (limitPrice < RISK_PARAMS.minEntryPrice) {
    approved = false
    rejectionReason = `Entry price ${limitPrice}¢ below min ${RISK_PARAMS.minEntryPrice}¢ — model has no edge at near-50/50 prices`
  }

  // ── Portfolio-proportional Half-Kelly sizing ──────────────────────────────
  // Standard Kelly: f* = (b·p − q) / b  where b = net odds, q = 1 − p
  const b = limitPrice > 0 ? (100 - limitPrice) / limitPrice : 1
  const kellyFraction = Math.max(0, (b * pModel - (1 - pModel)) / b)

  // Volatility scalar: high-vol → smaller size. Clamped [0.30, 1.50].
  const volScalar = gkVol15m && gkVol15m > 0
    ? Math.max(0.30, Math.min(1.50, REFERENCE_VOL_15M / gkVol15m))
    : 1.0

  // Confidence scalar: high → 100% · medium → 65% · low → 35%
  const confScalar = confidence === 'high' ? 1.00
                   : confidence === 'low'  ? 0.35
                   : 0.65

  // Capital budget: half-Kelly fraction of portfolio, capped at maxTradeCapital
  const halfKellyCapital = kellyFraction * 0.5 * portfolioValue * volScalar * confScalar
  const tradeBudget      = Math.min(halfKellyCapital, maxTradeCapital)
  const costPerContract  = limitPrice / 100   // $ per contract
  const budgetContracts  = costPerContract > 0 ? Math.round(tradeBudget / costPerContract) : 0
  const positionSize     = Math.min(budgetContracts, RISK_PARAMS.maxContractSize)

  // Kelly says no edge at this price — reject rather than force a position
  if (approved && positionSize <= 0) {
    approved = false
    rejectionReason = `Kelly fraction zero at ${limitPrice}¢ — negative expected value at this price`
  }

  // Expected profit too small to cover fees
  const expectedProfit = costPerContract > 0 ? (1 - costPerContract) * positionSize : 0
  if (approved && expectedProfit < RISK_PARAMS.minExpectedProfit) {
    approved = false
    rejectionReason = `Expected profit $${expectedProfit.toFixed(2)} < minimum $${RISK_PARAMS.minExpectedProfit} — fee killer`
  }

  const maxLoss          = approved ? costPerContract * positionSize : 0
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
      drawdownPct,
      tradeCount: sessionState.tradeCount,
    },
    reasoning: approved
      ? `Trade approved. Portfolio: $${portfolioValue.toFixed(0)}. Size: ${positionSize} contracts (Kelly=${(kellyFraction * 100).toFixed(1)}% × 0.5 × vol=${volScalar.toFixed(2)} × conf=${confScalar.toFixed(2)} → $${tradeBudget.toFixed(0)} budget). Max loss: $${maxLoss.toFixed(2)} (${pctOfPortfolio.toFixed(1)}% of portfolio). Daily P&L: $${sessionState.dailyPnl.toFixed(2)} / limit $${Math.abs(maxDailyLoss).toFixed(0)}.`
      : `Trade REJECTED — ${rejectionReason}`,
    durationMs: Date.now() - start,
    timestamp: new Date().toISOString(),
  }
}

// ── ROMA AI risk manager ───────────────────────────────────────────────────────
// Uses the ROMA DSPy solve loop to assess risk holistically.
// Falls back to deterministic Kelly if ROMA fails.
export async function runRomaRiskManager(
  edgePct: number,
  pModel: number,
  recommendation: 'YES' | 'NO' | 'NO_TRADE',
  limitPrice: number,
  minutesUntilExpiry: number,
  sentimentSignals: string[],
  provider: AIProvider,
  romaMode?: string,
  portfolioValue: number = 500,   // actual Kalshi account value in dollars
): Promise<AgentResult<RiskOutput>> {
  const start = Date.now()
  checkDailyReset()

  const { maxDailyLoss, maxTradeCapital } = dynamicLimits(portfolioValue)

  const drawdownPct =
    sessionState.peakPnl > 0
      ? ((sessionState.peakPnl - sessionState.dailyPnl) / sessionState.peakPnl) * 100
      : 0

  // Hard circuit breakers — always enforced regardless of AI opinion
  if (sessionState.dailyPnl <= maxDailyLoss) {
    return buildRejected(`Daily loss limit reached ($${Math.abs(maxDailyLoss).toFixed(0)} = ${RISK_PARAMS.maxDailyLossPct}% of portfolio)`, drawdownPct, start)
  }
  if (drawdownPct >= RISK_PARAMS.maxDrawdownPct) {
    return buildRejected(`Max drawdown breached (${drawdownPct.toFixed(1)}%)`, drawdownPct, start)
  }
  if (sessionState.tradeCount >= RISK_PARAMS.maxTradesPerDay) {
    return buildRejected('Daily trade count cap reached', drawdownPct, start)
  }
  if (limitPrice < RISK_PARAMS.minEntryPrice) {
    return buildRejected(`Entry price ${limitPrice}¢ below min ${RISK_PARAMS.minEntryPrice}¢ — model has no edge at near-50/50 prices`, drawdownPct, start)
  }

  const costPerContract  = limitPrice / 100
  const maxBudget        = Math.min(maxTradeCapital, portfolioValue * 0.10)

  const goal =
    `You are a quantitative risk manager for a Kalshi BTC 15-min prediction market trading system. ` +
    `Assess whether this trade should be approved and recommend a position size (in contracts, ${RISK_PARAMS.baseContractSize}–${RISK_PARAMS.maxContractSize}). ` +
    `Consider: edge quality, time pressure, session health, portfolio exposure, and overall risk. ` +
    `Be conservative — only approve trades with genuine statistical edge. ` +
    `Never risk more than ${RISK_PARAMS.maxTradePct}% of the portfolio on a single trade.`

  const context = [
    `Recommendation: BUY ${recommendation} @ ${limitPrice}¢`,
    `Model edge: ${edgePct >= 0 ? '+' : ''}${edgePct.toFixed(2)}% (minimum required: ${RISK_PARAMS.minEdgePct}%)`,
    `Model P(YES): ${(pModel * 100).toFixed(1)}%`,
    `Minutes until window close: ${minutesUntilExpiry.toFixed(1)}`,
    `Portfolio value: $${portfolioValue.toFixed(2)} (live Kalshi balance)`,
    `Max trade budget: $${maxBudget.toFixed(2)} (${RISK_PARAMS.maxTradePct}% of portfolio = ${Math.floor(maxBudget / costPerContract)} contracts @ ${limitPrice}¢)`,
    `Session P&L: $${sessionState.dailyPnl.toFixed(2)} (daily limit: $${Math.abs(maxDailyLoss).toFixed(0)})`,
    `Trades today: ${sessionState.tradeCount} / ${RISK_PARAMS.maxTradesPerDay}`,
    `Current drawdown: ${drawdownPct.toFixed(1)}% (max: ${RISK_PARAMS.maxDrawdownPct}%)`,
    `Sentiment signals: ${sentimentSignals.join(' | ')}`,
    `Contract range: ${RISK_PARAMS.baseContractSize}–${RISK_PARAMS.maxContractSize}`,
  ].join('\n')

  try {
    const maxDepth = Math.max(1, parseInt(process.env.ROMA_MAX_DEPTH ?? '1'))
    const romaResult = await callPythonRoma(goal, context, maxDepth, 2, romaMode)
    const romaTrace  = formatRomaTrace(romaResult)

    const extracted = await llmToolCall<{
      approved: boolean
      positionSize: number
      reasoning: string
    }>({
      provider,
      tier: 'fast',
      maxTokens: 256,
      toolName: 'risk_decision',
      toolDescription: 'Extract risk manager approval decision and position size',
      schema: {
        properties: {
          approved:     { type: 'boolean', description: 'true = approve the trade, false = reject' },
          positionSize: { type: 'number',  description: `Number of contracts to trade, ${RISK_PARAMS.baseContractSize}–${RISK_PARAMS.maxContractSize}` },
          reasoning:    { type: 'string',  description: 'One sentence explanation of the decision' },
        },
        required: ['approved', 'positionSize', 'reasoning'],
      },
      prompt: `Extract the risk decision from this ROMA analysis:\n\n${romaResult.answer}`,
    })

    const approved     = extracted.approved
    const positionSize = Math.min(Math.round(extracted.positionSize), RISK_PARAMS.maxContractSize)
    const maxLoss      = approved ? (limitPrice / 100) * positionSize : 0

    return {
      agentName: 'RiskManagerAgent (ROMA AI)',
      status: approved ? 'done' : 'skipped',
      output: {
        approved,
        rejectionReason: approved ? undefined : extracted.reasoning,
        positionSize: approved ? positionSize : 0,
        maxLoss,
        dailyPnl:    sessionState.dailyPnl,
        drawdownPct,
        tradeCount:  sessionState.tradeCount,
      },
      reasoning: romaTrace + `\n\nDecision: ${approved ? 'APPROVED' : 'REJECTED'} — ${extracted.reasoning}`,
      durationMs: Date.now() - start,
      timestamp: new Date().toISOString(),
    }
  } catch {
    // Fallback to deterministic Kelly on any ROMA failure
    return runRiskManager(edgePct, pModel, recommendation, limitPrice, undefined, undefined, undefined, portfolioValue)
  }
}

function buildRejected(reason: string, drawdownPct: number, start: number): AgentResult<RiskOutput> {
  return {
    agentName: 'RiskManagerAgent',
    status: 'skipped',
    output: {
      approved: false,
      rejectionReason: reason,
      positionSize: 0,
      maxLoss: 0,
      dailyPnl:   sessionState.dailyPnl,
      drawdownPct,
      tradeCount: sessionState.tradeCount,
    },
    reasoning: `Trade REJECTED — ${reason}`,
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
