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
  maxDailyLoss:    -150,   // $ max daily drawdown
  maxDrawdownPct:   15,    // % from peak
  maxTradesPerDay:  48,    // caps at one per 15-min window
  minEdgePct:        3,    // % minimum edge to trade
  baseContractSize: 500,   // minimum # of contracts per paper trade
  maxContractSize:  500,   // ceiling
}

// ── Deterministic Kelly risk manager ──────────────────────────────────────────
export function runRiskManager(
  edgePct: number,
  pModel: number,
  recommendation: 'YES' | 'NO' | 'NO_TRADE',
  limitPrice: number,
): AgentResult<RiskOutput> {
  const start = Date.now()
  checkDailyReset()

  const drawdownPct =
    sessionState.peakPnl > 0
      ? ((sessionState.peakPnl - sessionState.dailyPnl) / sessionState.peakPnl) * 100
      : 0

  let approved = true
  let rejectionReason: string | undefined

  if (recommendation === 'NO_TRADE') {
    approved = false
    rejectionReason = `Edge ${edgePct.toFixed(1)}% below minimum threshold (${RISK_PARAMS.minEdgePct}%)`
  } else if (sessionState.dailyPnl <= RISK_PARAMS.maxDailyLoss) {
    approved = false
    rejectionReason = `Daily loss limit reached ($${Math.abs(RISK_PARAMS.maxDailyLoss)})`
  } else if (drawdownPct >= RISK_PARAMS.maxDrawdownPct) {
    approved = false
    rejectionReason = `Max drawdown breached (${drawdownPct.toFixed(1)}% > ${RISK_PARAMS.maxDrawdownPct}%)`
  } else if (sessionState.tradeCount >= RISK_PARAMS.maxTradesPerDay) {
    approved = false
    rejectionReason = `Daily trade count cap reached (${RISK_PARAMS.maxTradesPerDay})`
  }

  const b = limitPrice > 0 ? (100 - limitPrice) / limitPrice : 1
  const kellyFraction = Math.max(0, (b * pModel - (1 - pModel)) / b)
  const rawContracts  = Math.round(kellyFraction * RISK_PARAMS.maxContractSize * 0.5)
  const positionSize  = Math.max(RISK_PARAMS.baseContractSize, Math.min(rawContracts, RISK_PARAMS.maxContractSize))
  const maxLoss       = approved ? (limitPrice / 100) * positionSize : 0

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
      ? `Trade approved. Size: ${positionSize} contracts (half-Kelly). Max loss: $${maxLoss.toFixed(2)}. Session P&L: $${sessionState.dailyPnl.toFixed(2)}.`
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
): Promise<AgentResult<RiskOutput>> {
  const start = Date.now()
  checkDailyReset()

  const drawdownPct =
    sessionState.peakPnl > 0
      ? ((sessionState.peakPnl - sessionState.dailyPnl) / sessionState.peakPnl) * 100
      : 0

  // Hard circuit breakers — always enforced regardless of AI opinion
  if (sessionState.dailyPnl <= RISK_PARAMS.maxDailyLoss) {
    return buildRejected('Daily loss limit reached', drawdownPct, start)
  }
  if (drawdownPct >= RISK_PARAMS.maxDrawdownPct) {
    return buildRejected(`Max drawdown breached (${drawdownPct.toFixed(1)}%)`, drawdownPct, start)
  }
  if (sessionState.tradeCount >= RISK_PARAMS.maxTradesPerDay) {
    return buildRejected('Daily trade count cap reached', drawdownPct, start)
  }

  const goal =
    `You are a quantitative risk manager for a Kalshi BTC 15-min prediction market trading system. ` +
    `Assess whether this trade should be approved and recommend a position size (in contracts, 1–500). ` +
    `Consider: edge quality, time pressure, session health, and overall risk. ` +
    `Be conservative — only approve trades with genuine statistical edge.`

  const context = [
    `Recommendation: BUY ${recommendation} @ ${limitPrice}¢`,
    `Model edge: ${edgePct >= 0 ? '+' : ''}${edgePct.toFixed(2)}% (minimum required: ${RISK_PARAMS.minEdgePct}%)`,
    `Model P(YES): ${(pModel * 100).toFixed(1)}%`,
    `Minutes until window close: ${minutesUntilExpiry.toFixed(1)}`,
    `Session P&L: $${sessionState.dailyPnl.toFixed(2)} (daily limit: $${RISK_PARAMS.maxDailyLoss})`,
    `Trades today: ${sessionState.tradeCount} / ${RISK_PARAMS.maxTradesPerDay}`,
    `Current drawdown: ${drawdownPct.toFixed(1)}% (max: ${RISK_PARAMS.maxDrawdownPct}%)`,
    `Sentiment signals: ${sentimentSignals.join(' | ')}`,
    `Contract range: ${RISK_PARAMS.baseContractSize}–${RISK_PARAMS.maxContractSize}`,
  ].join('\n')

  try {
    // Atomic solve (depth=0) — risk assessment is simple enough for single shot
    const romaResult = await callPythonRoma(goal, context, 0, 2, romaMode)
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
    const positionSize = Math.max(RISK_PARAMS.baseContractSize, Math.min(Math.round(extracted.positionSize), RISK_PARAMS.maxContractSize))
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
    return runRiskManager(edgePct, pModel, recommendation, limitPrice)
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
