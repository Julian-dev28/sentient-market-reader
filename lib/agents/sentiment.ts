import type { AgentResult, SentimentOutput, KalshiMarket, KalshiOrderbook } from '../types'
import { getClaudeClient } from '../claude-client'

export async function runSentiment(
  priceChangePct1h: number,
  market: KalshiMarket | null,
  orderbook: KalshiOrderbook | null
): Promise<AgentResult<SentimentOutput>> {
  const start = Date.now()

  const obYesSummary = orderbook?.yes?.slice(0, 6).map(l => `${l.price}¢×${Math.abs(l.delta)}`).join(', ') ?? 'n/a'
  const obNoSummary  = orderbook?.no?.slice(0, 6).map(l => `${l.price}¢×${Math.abs(l.delta)}`).join(', ') ?? 'n/a'

  const prompt = `You are SentimentAgent — part of a Sentient GRID ROMA multi-agent pipeline trading Kalshi KXBTC15M 15-minute BTC prediction markets.

Live market snapshot:
- BTC 1-hour price change: ${priceChangePct1h >= 0 ? '+' : ''}${priceChangePct1h.toFixed(4)}%
${market
  ? `- Kalshi YES ask/bid: ${market.yes_ask}¢ / ${market.yes_bid}¢  |  NO ask/bid: ${market.no_ask}¢ / ${market.no_bid}¢
- Strike price: $${market.floor_strike?.toLocaleString() ?? 'unknown'}
- Ticker: ${market.ticker}`
  : '- No active Kalshi market found'}
- Orderbook YES levels: ${obYesSummary}
- Orderbook NO levels:  ${obNoSummary}

Analyze directional sentiment for THIS 15-minute window. Reason step-by-step through:
1. What the 1-hour BTC momentum tells you about short-term direction
2. What the Kalshi YES/NO pricing spread reveals about crowd expectations
3. What orderbook depth imbalance between YES and NO sides implies

Output a composite sentiment score (-1.0 = strongly bearish, 0 = neutral, +1.0 = strongly bullish).`

  try {
    const claude = getClaudeClient()
    const response = await claude.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      tools: [
        {
          name: 'output_sentiment',
          description: 'Output the structured sentiment analysis',
          input_schema: {
            type: 'object' as const,
            properties: {
              score:         { type: 'number', description: 'Composite sentiment score from -1.0 to +1.0' },
              label:         { type: 'string', enum: ['strongly_bullish', 'bullish', 'neutral', 'bearish', 'strongly_bearish'] },
              momentum:      { type: 'number', description: 'Momentum component extracted from 1h price change, -1 to 1' },
              orderbookSkew: { type: 'number', description: 'Orderbook skew extracted from YES/NO pricing, -1 to 1' },
              signals:       { type: 'array', items: { type: 'string' }, description: 'Key signals that drove the score' },
              reasoning:     { type: 'string', description: 'Step-by-step reasoning for the score' },
            },
            required: ['score', 'label', 'momentum', 'orderbookSkew', 'signals', 'reasoning'],
          },
        },
      ],
      tool_choice: { type: 'tool', name: 'output_sentiment' },
      messages: [{ role: 'user', content: prompt }],
    })

    const toolBlock = response.content.find(b => b.type === 'tool_use')
    if (!toolBlock || toolBlock.type !== 'tool_use') throw new Error('No tool_use block in Claude response')

    const r = toolBlock.input as {
      score: number
      label: SentimentOutput['label']
      momentum: number
      orderbookSkew: number
      signals: string[]
      reasoning: string
    }

    const output: SentimentOutput = {
      score:         Math.max(-1, Math.min(1, r.score)),
      label:         r.label,
      momentum:      r.momentum,
      orderbookSkew: r.orderbookSkew,
      signals:       r.signals,
    }

    return {
      agentName: 'SentimentAgent',
      status: 'done',
      output,
      reasoning: r.reasoning,
      durationMs: Date.now() - start,
      timestamp: new Date().toISOString(),
    }
  } catch (err) {
    // Fallback: rule-based if Claude is unavailable
    const momentum      = Math.max(-1, Math.min(1, priceChangePct1h / 2))
    const orderbookSkew = market ? ((market.yes_ask - 50) / 50) * 0.8 : 0
    let depthSkew = 0
    if (orderbook?.yes?.length && orderbook?.no?.length) {
      const yesDepth = orderbook.yes.reduce((s, l) => s + Math.abs(l.delta), 0)
      const noDepth  = orderbook.no.reduce((s, l) => s + Math.abs(l.delta), 0)
      const total    = yesDepth + noDepth
      if (total > 0) depthSkew = (yesDepth - noDepth) / total
    }
    const score = Math.max(-1, Math.min(1, momentum * 0.5 + orderbookSkew * 0.3 + depthSkew * 0.2))
    const label: SentimentOutput['label'] =
      score > 0.4 ? 'strongly_bullish' : score > 0.1 ? 'bullish' :
      score < -0.4 ? 'strongly_bearish' : score < -0.1 ? 'bearish' : 'neutral'

    const errMsg = err instanceof Error ? err.message : String(err)
    return {
      agentName: 'SentimentAgent',
      status: 'done',
      output: { score, label, momentum, orderbookSkew, signals: [`[fallback — Claude unavailable: ${errMsg}]`] },
      reasoning: `[rule-based fallback] score=${score.toFixed(3)} (${label})`,
      durationMs: Date.now() - start,
      timestamp: new Date().toISOString(),
    }
  }
}
