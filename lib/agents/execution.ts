import type { AgentResult, ExecutionOutput, KalshiMarket } from '../types'
import type { AIProvider } from '../llm-client'

/**
 * ExecutionAgent
 * ───────────────
 * Deterministic execution: picks aggressive (ask) vs passive (mid) based on
 * time pressure and spread. No LLM call — keeps pipeline latency low.
 *
 * Strategy rules:
 *   - <5 min left OR spread ≤2¢ → aggressive (limit at ask, maximise fill)
 *   - ≥5 min left AND spread >2¢ → passive (limit at mid, save cost, risk non-fill)
 */
export async function runExecution(
  recommendation: 'YES' | 'NO' | 'NO_TRADE',
  positionSize: number,
  market: KalshiMarket | null,
  riskApproved: boolean,
  portfolioValue?: number,
  minutesUntilExpiry?: number,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _provider?: AIProvider,  // kept for signature compatibility
): Promise<AgentResult<ExecutionOutput>> {
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

  const side     = recommendation === 'YES' ? 'yes' : 'no'
  const askPrice = side === 'yes' ? market.yes_ask : market.no_ask
  const bidPrice = side === 'yes' ? market.yes_bid : market.no_bid
  const midPrice = Math.round((askPrice + bidPrice) / 2)
  const minsLeft = minutesUntilExpiry ?? 7.5
  const spread   = askPrice - bidPrice

  // Aggressive if <5 min left (must fill) or spread is tight (no saving possible)
  const strategy: 'aggressive' | 'passive' =
    (minsLeft < 5 || spread <= 2) ? 'aggressive' : 'passive'

  const limitPrice      = strategy === 'passive' && midPrice > 0 && midPrice < askPrice ? midPrice : askPrice
  const estimatedCost   = (limitPrice / 100) * positionSize
  const estimatedPayout = positionSize
  const estimatedProfit = estimatedPayout - estimatedCost
  const portfolio       = portfolioValue ?? 0
  const pctOfPortfolio  = portfolio > 0 ? (estimatedCost / portfolio * 100).toFixed(1) : null

  const rationale =
    `Buy ${positionSize}× ${side.toUpperCase()} @ ${limitPrice}¢ (${strategy}) on ${market.ticker}. ` +
    `Cost: $${estimatedCost.toFixed(2)}${pctOfPortfolio ? ` (${pctOfPortfolio}% of $${portfolio.toFixed(0)} portfolio)` : ''}. ` +
    `Max profit: $${estimatedProfit.toFixed(2)}. ` +
    (strategy === 'passive'
      ? `Passive: ${minsLeft.toFixed(1)}min left, spread ${spread}¢ — saving $${((askPrice - limitPrice) / 100 * positionSize).toFixed(2)} vs ask.`
      : `Aggressive: ${minsLeft.toFixed(1)}min left${spread <= 2 ? `, tight spread (${spread}¢)` : ''} — maximising fill probability.`)

  const output: ExecutionOutput = {
    action: recommendation === 'YES' ? 'BUY_YES' : 'BUY_NO',
    side,
    limitPrice,
    contracts: positionSize,
    estimatedCost,
    estimatedPayout,
    marketTicker: market.ticker,
    rationale,
  }

  return {
    agentName: 'ExecutionAgent',
    status: 'done',
    output,
    reasoning: rationale,
    durationMs: Date.now() - start,
    timestamp: new Date().toISOString(),
  }
}
