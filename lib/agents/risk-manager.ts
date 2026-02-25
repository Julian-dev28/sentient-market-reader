import type { AgentResult, RiskOutput } from '../types'

// In-memory session risk state
const sessionState = {
  dailyPnl: 0,
  tradeCount: 0,
  peakPnl: 0,
}

const RISK_PARAMS = {
  maxDailyLoss: -150,      // $ max daily drawdown
  maxDrawdownPct: 15,      // % from peak
  maxTradesPerDay: 48,     // caps at one per 15-min window
  minEdgePct: 3,           // % minimum edge to trade
  baseContractSize: 5,     // base # of contracts
  maxContractSize: 20,     // ceiling
}

/**
 * RiskManagerAgent
 * ─────────────────
 * Enforces:
 *   - Daily loss limit
 *   - Max drawdown from peak
 *   - Trade count cap
 *   - Minimum edge threshold
 *   - Kelly-inspired position sizing (simplified)
 */
export function runRiskManager(
  edgePct: number,
  pModel: number,
  recommendation: 'YES' | 'NO' | 'NO_TRADE',
  limitPrice: number       // cents (Kalshi price of the side to buy)
): AgentResult<RiskOutput> {
  const start = Date.now()

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

  // Kelly-inspired sizing: f* = (bp - q) / b, simplified
  // b = (100 - price) / price (odds), p = pModel, q = 1 - pModel
  const b = limitPrice > 0 ? (100 - limitPrice) / limitPrice : 1
  const kellyFraction = Math.max(0, (b * pModel - (1 - pModel)) / b)
  const rawContracts = Math.round(kellyFraction * RISK_PARAMS.maxContractSize * 0.5)  // half-Kelly
  const positionSize = Math.max(1, Math.min(rawContracts, RISK_PARAMS.maxContractSize))

  const maxLoss = approved ? (limitPrice / 100) * positionSize : 0

  const output: RiskOutput = {
    approved,
    rejectionReason,
    positionSize: approved ? positionSize : 0,
    maxLoss,
    dailyPnl: sessionState.dailyPnl,
    drawdownPct,
    tradeCount: sessionState.tradeCount,
  }

  const reasoning = approved
    ? `Trade approved. Size: ${positionSize} contracts (half-Kelly). Max loss: $${maxLoss.toFixed(2)}. Session P&L: $${sessionState.dailyPnl.toFixed(2)}.`
    : `Trade REJECTED — ${rejectionReason}`

  return {
    agentName: 'RiskManagerAgent',
    status: approved ? 'done' : 'skipped',
    output,
    reasoning,
    durationMs: Date.now() - start,
    timestamp: new Date().toISOString(),
  }
}

/** Update session state after trade settlement */
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
