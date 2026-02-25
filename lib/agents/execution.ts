import type { AgentResult, ExecutionOutput, KalshiMarket } from '../types'

/**
 * ExecutionAgent
 * ───────────────
 * Generates the paper trade order specification.
 * In a live system this would POST to Kalshi's /portfolio/orders endpoint.
 * Here it returns the full order object for logging and display.
 *
 * Pricing logic:
 *   - For YES: limit at yes_ask (aggressive) or yes_bid (passive)
 *   - For NO: limit at no_ask (aggressive) or no_bid (passive)
 *   - We use mid-price (aggressive) to maximize fill probability in demo
 */
export function runExecution(
  recommendation: 'YES' | 'NO' | 'NO_TRADE',
  positionSize: number,
  market: KalshiMarket | null,
  riskApproved: boolean
): AgentResult<ExecutionOutput> {
  const start = Date.now()

  if (!riskApproved || recommendation === 'NO_TRADE' || !market) {
    const output: ExecutionOutput = {
      action: 'PASS',
      side: null,
      limitPrice: null,
      contracts: 0,
      estimatedCost: 0,
      estimatedPayout: 0,
      marketTicker: market?.ticker ?? '',
      rationale: riskApproved
        ? 'Edge insufficient — standing aside this window.'
        : 'Risk manager blocked trade.',
    }
    return {
      agentName: 'ExecutionAgent',
      status: 'skipped',
      output,
      reasoning: output.rationale,
      durationMs: Date.now() - start,
      timestamp: new Date().toISOString(),
    }
  }

  const side = recommendation === 'YES' ? 'yes' : 'no'
  const limitPrice = side === 'yes' ? market.yes_ask : market.no_ask
  const estimatedCost = (limitPrice / 100) * positionSize
  const estimatedPayout = positionSize  // $1 per contract if win
  const estimatedProfit = estimatedPayout - estimatedCost

  const output: ExecutionOutput = {
    action: recommendation === 'YES' ? 'BUY_YES' : 'BUY_NO',
    side,
    limitPrice,
    contracts: positionSize,
    estimatedCost,
    estimatedPayout,
    marketTicker: market.ticker,
    rationale: `Buy ${positionSize}× ${side.toUpperCase()} @ ${limitPrice}¢ on ${market.ticker}. Max profit: $${estimatedProfit.toFixed(2)}. Paper trade only — no real order placed.`,
  }

  return {
    agentName: 'ExecutionAgent',
    status: 'done',
    output,
    reasoning: output.rationale,
    durationMs: Date.now() - start,
    timestamp: new Date().toISOString(),
  }
}
