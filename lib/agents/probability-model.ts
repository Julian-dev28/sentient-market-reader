import type { AgentResult, ProbabilityOutput, KalshiMarket } from '../types'
import { getClaudeClient } from '../claude-client'

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x))
}

export async function runProbabilityModel(
  sentimentScore: number,
  distanceFromStrikePct: number,
  minutesUntilExpiry: number,
  market: KalshiMarket | null
): Promise<AgentResult<ProbabilityOutput>> {
  const start = Date.now()

  const pMarket = market ? market.yes_ask / 100 : 0.5
  const spread  = market ? (market.yes_ask - market.yes_bid) / 100 : 0.05

  const prompt = `You are ProbabilityModelAgent — part of a Sentient GRID ROMA multi-agent pipeline trading Kalshi KXBTC15M 15-minute BTC prediction markets.

Upstream agent outputs fed to you:
- SentimentAgent score: ${sentimentScore.toFixed(4)}  (range -1 = strongly bearish → +1 = strongly bullish)
- BTC distance from Kalshi strike: ${distanceFromStrikePct >= 0 ? '+' : ''}${distanceFromStrikePct.toFixed(4)}%  (positive = BTC is ABOVE strike right now)
- Minutes until market expiry: ${minutesUntilExpiry.toFixed(2)} min
- Kalshi market-implied P(YES): ${(pMarket * 100).toFixed(1)}¢  (the crowd's probability)
- Bid-ask spread: ${(spread * 100).toFixed(1)}¢

Your job: Estimate the true probability that BTC will be ABOVE the strike price when this 15-minute window closes.

Reason through:
1. What the sentiment score implies about short-term direction
2. How the current price position (above/below strike) factors in — closer to expiry it matters more
3. Time decay: with ${minutesUntilExpiry.toFixed(1)} minutes left, how much can price move?
4. Whether there is a meaningful edge vs the Kalshi market-implied probability of ${(pMarket * 100).toFixed(1)}%
5. Whether to trade YES (BTC ends above strike), NO (BTC ends below), or stand aside

An edge must exceed the spread (${(spread * 100).toFixed(1)}¢) + 2¢ minimum to justify a trade.`

  try {
    const claude = getClaudeClient()
    const response = await claude.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      tools: [
        {
          name: 'output_probability',
          description: 'Output the structured probability estimate and trade recommendation',
          input_schema: {
            type: 'object' as const,
            properties: {
              pModel:         { type: 'number', description: 'Your estimated P(YES) from 0.0 to 1.0' },
              recommendation: { type: 'string', enum: ['YES', 'NO', 'NO_TRADE'], description: 'Trade recommendation' },
              confidence:     { type: 'string', enum: ['high', 'medium', 'low'], description: 'Confidence in the recommendation' },
              reasoning:      { type: 'string', description: 'Step-by-step probability reasoning' },
            },
            required: ['pModel', 'recommendation', 'confidence', 'reasoning'],
          },
        },
      ],
      tool_choice: { type: 'tool', name: 'output_probability' },
      messages: [{ role: 'user', content: prompt }],
    })

    const toolBlock = response.content.find(b => b.type === 'tool_use')
    if (!toolBlock || toolBlock.type !== 'tool_use') throw new Error('No tool_use block in Claude response')

    const r = toolBlock.input as {
      pModel: number
      recommendation: ProbabilityOutput['recommendation']
      confidence: ProbabilityOutput['confidence']
      reasoning: string
    }

    const pModel  = Math.max(0, Math.min(1, r.pModel))
    const edge    = pModel - pMarket
    const edgePct = edge * 100

    const output: ProbabilityOutput = {
      pModel,
      pMarket,
      edge,
      edgePct,
      recommendation: r.recommendation,
      confidence:     r.confidence,
    }

    const edgeStr = `${edge >= 0 ? '+' : ''}${edgePct.toFixed(1)}%`
    return {
      agentName: 'ProbabilityModelAgent',
      status: 'done',
      output,
      reasoning: `${r.reasoning}\n\nP(model)=${(pModel * 100).toFixed(1)}% vs P(market)=${(pMarket * 100).toFixed(1)}% — edge: ${edgeStr}. Recommendation: ${r.recommendation} (${r.confidence} confidence).`,
      durationMs: Date.now() - start,
      timestamp: new Date().toISOString(),
    }
  } catch (err) {
    // Fallback: rule-based sigmoid if Claude unavailable
    const timeWeight = Math.max(0, 1 - minutesUntilExpiry / 15)
    const logit  = sentimentScore * 3.0 + (distanceFromStrikePct / 0.5) * timeWeight * 2.0
    const pModel  = sigmoid(logit)
    const edge    = pModel - pMarket
    const edgePct = edge * 100

    let recommendation: ProbabilityOutput['recommendation'] = 'NO_TRADE'
    if (edge > spread + 0.02)       recommendation = 'YES'
    else if (edge < -(spread + 0.02)) recommendation = 'NO'

    const confidence: ProbabilityOutput['confidence'] =
      Math.abs(edge) > 0.1 ? 'high' : Math.abs(edge) > 0.04 ? 'medium' : 'low'

    const errMsg = err instanceof Error ? err.message : String(err)
    return {
      agentName: 'ProbabilityModelAgent',
      status: 'done',
      output: { pModel, pMarket, edge, edgePct, recommendation, confidence },
      reasoning: `[rule-based fallback — Claude unavailable: ${errMsg}] P(model)=${(pModel * 100).toFixed(1)}% vs P(market)=${(pMarket * 100).toFixed(1)}% — edge: ${edgePct >= 0 ? '+' : ''}${edgePct.toFixed(1)}%.`,
      durationMs: Date.now() - start,
      timestamp: new Date().toISOString(),
    }
  }
}
