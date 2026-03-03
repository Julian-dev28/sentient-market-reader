import type { AgentResult, ExecutionOutput, KalshiMarket } from '../types'
import type { AIProvider } from '../llm-client'
import { llmToolCall } from '../llm-client'

/**
 * ExecutionAgent
 * ───────────────
 * Uses a lightweight Claude call to pick an execution strategy
 * (aggressive vs passive limit) and generate a portfolio-aware rationale.
 *
 * Falls back to deterministic aggressive pricing if the AI call fails.
 */
export async function runExecution(
  recommendation: 'YES' | 'NO' | 'NO_TRADE',
  positionSize: number,
  market: KalshiMarket | null,
  riskApproved: boolean,
  portfolioValue?: number,     // Kalshi account value in $
  minutesUntilExpiry?: number,
  provider?: AIProvider,
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

  const side = recommendation === 'YES' ? 'yes' : 'no'
  const askPrice = side === 'yes' ? market.yes_ask : market.no_ask
  const bidPrice = side === 'yes' ? market.yes_bid : market.no_bid
  const midPrice = Math.round((askPrice + bidPrice) / 2)
  const minsLeft = minutesUntilExpiry ?? 7.5
  const portfolio = portfolioValue ?? 0

  // ── AI execution strategy ────────────────────────────────────────────────
  // Determines aggressive (ask) vs passive (mid) pricing based on time pressure,
  // portfolio exposure, and expected fill probability.
  let strategy: 'aggressive' | 'passive' = 'aggressive'
  let aiRationale = ''

  if (provider) {
    try {
      const costPerContract = askPrice / 100
      const tradeCost       = costPerContract * positionSize
      const pctOfPortfolio  = portfolio > 0 ? (tradeCost / portfolio) * 100 : 0

      const result = await llmToolCall<{
        strategy: 'aggressive' | 'passive'
        rationale: string
      }>({
        provider,
        tier: 'fast',
        maxTokens: 200,
        toolName: 'execution_strategy',
        toolDescription: 'Determine order execution strategy and generate rationale',
        schema: {
          properties: {
            strategy: {
              type: 'string',
              enum: ['aggressive', 'passive'],
              description: '"aggressive" = limit at ask (maximises fill probability); "passive" = limit at mid (saves cost, risks non-fill)',
            },
            rationale: {
              type: 'string',
              description: '1-2 sentence plain-English execution rationale incorporating portfolio context',
            },
          },
          required: ['strategy', 'rationale'],
        },
        prompt: [
          `Execution decision for Kalshi KXBTC15M binary market:`,
          `Side: BUY ${side.toUpperCase()} on ${market.ticker}`,
          `Contracts: ${positionSize} | Ask: ${askPrice}¢ | Bid: ${bidPrice}¢ | Mid: ${midPrice}¢`,
          `Trade cost at ask: $${tradeCost.toFixed(2)}${portfolio > 0 ? ` (${pctOfPortfolio.toFixed(1)}% of $${portfolio.toFixed(0)} portfolio)` : ''}`,
          `Minutes until window closes: ${minsLeft.toFixed(1)}`,
          ``,
          `Choose "aggressive" (ask price) if fill probability matters more than cost — e.g. <5 min left.`,
          `Choose "passive" (mid price) only if >8 min remain AND the spread saving is material.`,
          `Provide a concise rationale incorporating portfolio exposure and timing.`,
        ].join('\n'),
      })

      strategy    = result.strategy
      aiRationale = result.rationale
    } catch {
      // fallback to deterministic below
    }
  }

  // Use ask for aggressive, mid for passive (but mid must be valid)
  const limitPrice    = strategy === 'passive' && midPrice > 0 && midPrice < askPrice ? midPrice : askPrice
  const estimatedCost    = (limitPrice / 100) * positionSize
  const estimatedPayout  = positionSize  // $1 per contract if win
  const estimatedProfit  = estimatedPayout - estimatedCost
  const pctOfPortfolio   = portfolio > 0 ? (estimatedCost / portfolio * 100).toFixed(1) : null

  const deterministicRationale =
    `Buy ${positionSize}× ${side.toUpperCase()} @ ${limitPrice}¢ (${strategy}) on ${market.ticker}. ` +
    `Cost: $${estimatedCost.toFixed(2)}${pctOfPortfolio ? ` (${pctOfPortfolio}% of $${portfolio.toFixed(0)} portfolio)` : ''}. ` +
    `Max profit: $${estimatedProfit.toFixed(2)}.`

  const rationale = aiRationale || deterministicRationale

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
    agentName: 'ExecutionAgent (AI)',
    status: 'done',
    output,
    reasoning: aiRationale
      ? `Strategy: ${strategy} @ ${limitPrice}¢. ${deterministicRationale}\n\nAI: ${aiRationale}`
      : deterministicRationale,
    durationMs: Date.now() - start,
    timestamp: new Date().toISOString(),
  }
}
