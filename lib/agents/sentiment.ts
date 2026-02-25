import type { AgentResult, SentimentOutput, BTCQuote, KalshiMarket, KalshiOrderbook } from '../types'
import { llmToolCall, type AIProvider } from '../llm-client'

export async function runSentiment(
  quote: BTCQuote,
  strikePrice: number,
  distanceFromStrikePct: number,
  minutesUntilExpiry: number,
  market: KalshiMarket | null,
  orderbook: KalshiOrderbook | null,
  provider: AIProvider,
): Promise<AgentResult<SentimentOutput>> {
  const start = Date.now()

  const distSign = distanceFromStrikePct >= 0 ? '+' : ''
  const obYes = orderbook?.yes?.slice(0, 5).map(l => `${l.price}¢×${Math.abs(l.delta)}`).join(', ') ?? 'n/a'
  const obNo  = orderbook?.no?.slice(0, 5).map(l => `${l.price}¢×${Math.abs(l.delta)}`).join(', ') ?? 'n/a'

  const prompt = `You are SentimentAgent in the Sentient GRID ROMA multi-agent trading pipeline.

Market snapshot:
- BTC price: $${quote.price.toLocaleString('en-US', { maximumFractionDigits: 2 })}
- 1h change: ${quote.percent_change_1h >= 0 ? '+' : ''}${quote.percent_change_1h.toFixed(4)}%
- 24h change: ${quote.percent_change_24h >= 0 ? '+' : ''}${quote.percent_change_24h.toFixed(4)}%
- Strike price: $${strikePrice.toLocaleString('en-US', { maximumFractionDigits: 2 })}
- BTC vs strike: ${distSign}${distanceFromStrikePct.toFixed(4)}% — BTC is ${distanceFromStrikePct >= 0 ? 'ABOVE' : 'BELOW'} strike
- Minutes to window close: ${minutesUntilExpiry.toFixed(2)}
${market
  ? `- Kalshi YES ask: ${market.yes_ask}¢ | YES bid: ${market.yes_bid}¢ | NO ask: ${market.no_ask}¢ | Spread: ${market.yes_ask - market.yes_bid}¢`
  : '- No active Kalshi market'}
- Orderbook YES depth: ${obYes}
- Orderbook NO depth:  ${obNo}

Assess short-term BTC directional sentiment for this 15-min prediction window.`

  try {
    const result = await llmToolCall<{
      score: number
      label: SentimentOutput['label']
      momentum: number
      orderbookSkew: number
      signals: string[]
    }>({
      provider,
      tier: 'fast',
      maxTokens: 512,
      toolName: 'output_sentiment',
      toolDescription: 'Output structured BTC sentiment for a 15-min Kalshi market window',
      schema: {
        properties: {
          score:         { type: 'number',  description: 'Overall sentiment score: -1.0 = strongly bearish, +1.0 = strongly bullish' },
          label:         { type: 'string',  enum: ['strongly_bullish', 'bullish', 'neutral', 'bearish', 'strongly_bearish'] },
          momentum:      { type: 'number',  description: 'Short-term price momentum component: -1 to +1' },
          orderbookSkew: { type: 'number',  description: 'Kalshi orderbook/crowd sentiment skew: -1 to +1' },
          signals:       { type: 'array',   items: { type: 'string' }, description: '3-5 concise signals driving the sentiment' },
        },
        required: ['score', 'label', 'momentum', 'orderbookSkew', 'signals'],
      },
      prompt,
    })

    return {
      agentName: 'SentimentAgent',
      status: 'done',
      output: {
        score:         Math.max(-1, Math.min(1, result.score)),
        label:         result.label,
        momentum:      result.momentum,
        orderbookSkew: result.orderbookSkew,
        signals:       result.signals,
      },
      reasoning: `Score: ${result.score.toFixed(3)} (${result.label}) — ${result.signals.join(' | ')}`,
      durationMs: Date.now() - start,
      timestamp: new Date().toISOString(),
    }
  } catch (err) {
    // Rule-based fallback
    const raw = (quote.percent_change_1h / 2) + (distanceFromStrikePct > 0 ? 0.1 : -0.1)
    const score = Math.max(-1, Math.min(1, raw))
    const label: SentimentOutput['label'] =
      score > 0.4 ? 'strongly_bullish' : score > 0.1 ? 'bullish' :
      score < -0.4 ? 'strongly_bearish' : score < -0.1 ? 'bearish' : 'neutral'
    return {
      agentName: 'SentimentAgent',
      status: 'done',
      output: { score, label, momentum: score, orderbookSkew: 0, signals: [`[fallback: ${String(err)}]`] },
      reasoning: `[rule-based fallback] score=${score.toFixed(3)}`,
      durationMs: Date.now() - start,
      timestamp: new Date().toISOString(),
    }
  }
}
