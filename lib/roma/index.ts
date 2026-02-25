/**
 * ROMA Trading Analysis
 * ─────────────────────
 * Runs the full ROMA pipeline on a Kalshi KXBTC15M market snapshot.
 *
 * Flow:
 *   1. Build rich market context string
 *   2. solve("Analyze this market and recommend a trade") — ROMA recursive loop
 *   3. Structured extraction: parse ROMA's qualitative output into typed numbers
 *   4. Return AgentResult<SentimentOutput> + AgentResult<ProbabilityOutput>
 */

import { solve } from './solve'
import { llmToolCall, PROVIDER_MODELS, type AIProvider } from '../llm-client'
import type {
  AgentResult,
  SentimentOutput,
  ProbabilityOutput,
  KalshiMarket,
  KalshiOrderbook,
  BTCQuote,
} from '../types'

// ── Build context string ───────────────────────────────────────────────────

function buildContext(
  quote: BTCQuote,
  strikePrice: number,
  distanceFromStrikePct: number,
  minutesUntilExpiry: number,
  market: KalshiMarket | null,
  orderbook: KalshiOrderbook | null
): string {
  const distSign = distanceFromStrikePct >= 0 ? '+' : ''
  const changeSign = quote.percent_change_1h >= 0 ? '+' : ''

  const obYes = orderbook?.yes?.slice(0, 6).map(l => `${l.price}¢×${Math.abs(l.delta)}`).join(', ') ?? 'n/a'
  const obNo  = orderbook?.no?.slice(0, 6).map(l => `${l.price}¢×${Math.abs(l.delta)}`).join(', ') ?? 'n/a'

  return [
    `Asset: BTC/USD`,
    `Current price: $${quote.price.toLocaleString('en-US', { maximumFractionDigits: 2 })}`,
    `1h change: ${changeSign}${quote.percent_change_1h.toFixed(4)}%`,
    `24h change: ${quote.percent_change_24h >= 0 ? '+' : ''}${quote.percent_change_24h.toFixed(4)}%`,
    ``,
    `Kalshi market: ${market?.ticker ?? 'none'}`,
    `Strike price (price to beat): $${strikePrice.toLocaleString('en-US', { maximumFractionDigits: 2 })}`,
    `BTC vs strike: ${distSign}$${Math.abs(quote.price - strikePrice).toLocaleString('en-US', { maximumFractionDigits: 2 })} (${distSign}${distanceFromStrikePct.toFixed(4)}%)`,
    `Position: BTC is currently ${distanceFromStrikePct >= 0 ? 'ABOVE' : 'BELOW'} strike`,
    `Minutes until window closes: ${minutesUntilExpiry.toFixed(2)}`,
    ``,
    market
      ? [
          `Kalshi YES ask/bid: ${market.yes_ask}¢ / ${market.yes_bid}¢`,
          `Kalshi NO ask/bid:  ${market.no_ask}¢ / ${market.no_bid}¢`,
          `Market-implied P(YES): ${market.yes_ask}¢ (crowd says ${market.yes_ask}% chance BTC ends above strike)`,
          `Bid-ask spread: ${market.yes_ask - market.yes_bid}¢`,
        ].join('\n')
      : 'No active Kalshi market',
    ``,
    `Orderbook YES depth: ${obYes}`,
    `Orderbook NO depth:  ${obNo}`,
  ].join('\n')
}

// ── Structured extraction ──────────────────────────────────────────────────

interface ExtractedAnalysis {
  sentimentScore: number
  sentimentLabel: SentimentOutput['label']
  momentum: number
  orderbookSkew: number
  signals: string[]
  pModel: number
  recommendation: ProbabilityOutput['recommendation']
  confidence: ProbabilityOutput['confidence']
}

async function extractStructured(
  romaAnswer: string,
  pMarket: number,
  provider: AIProvider,
): Promise<ExtractedAnalysis> {
  try {
    return await llmToolCall<ExtractedAnalysis>({
      provider,
      tier: 'smart',
      maxTokens: 1024,
      toolName: 'extract_trading_analysis',
      toolDescription: 'Extract structured trading signals from ROMA qualitative analysis',
      schema: {
        properties: {
          sentimentScore:  { type: 'number', description: 'Overall directional sentiment score from -1.0 (strongly bearish) to +1.0 (strongly bullish)' },
          sentimentLabel:  { type: 'string', enum: ['strongly_bullish', 'bullish', 'neutral', 'bearish', 'strongly_bearish'] },
          momentum:        { type: 'number', description: 'Price momentum component, -1 to 1' },
          orderbookSkew:   { type: 'number', description: 'Orderbook/crowd sentiment skew, -1 to 1' },
          signals:         { type: 'array', items: { type: 'string' }, description: 'Key signals that drove the analysis (3-5 bullet points)' },
          pModel:          { type: 'number', description: 'Estimated probability (0.0 to 1.0) that BTC ends above strike at expiry' },
          recommendation:  { type: 'string', enum: ['YES', 'NO', 'NO_TRADE'], description: `YES = buy YES. NO = buy NO. NO_TRADE = insufficient edge vs market-implied ${(pMarket * 100).toFixed(1)}%` },
          confidence:      { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['sentimentScore', 'sentimentLabel', 'momentum', 'orderbookSkew', 'signals', 'pModel', 'recommendation', 'confidence'],
      },
      prompt: `Extract structured trading signals from this ROMA multi-agent analysis:\n\n${romaAnswer}\n\nMarket-implied P(YES): ${(pMarket * 100).toFixed(1)}%`,
    })
  } catch {
    return {
      sentimentScore: 0, sentimentLabel: 'neutral', momentum: 0, orderbookSkew: 0,
      signals: ['[extraction failed — neutral defaults applied]'],
      pModel: pMarket, recommendation: 'NO_TRADE', confidence: 'low',
    }
  }
}

// ── Main export ────────────────────────────────────────────────────────────

export interface RomaTradeAnalysis {
  sentimentResult:   AgentResult<SentimentOutput>
  probabilityResult: AgentResult<ProbabilityOutput>
  romaSubtasks:      Array<{ id: string; goal: string; result: string }>
}

export async function runRomaTradeAnalysis(
  quote: BTCQuote,
  strikePrice: number,
  distanceFromStrikePct: number,
  minutesUntilExpiry: number,
  market: KalshiMarket | null,
  orderbook: KalshiOrderbook | null,
  provider: AIProvider = 'anthropic',
): Promise<RomaTradeAnalysis> {
  const start = Date.now()

  const context = buildContext(quote, strikePrice, distanceFromStrikePct, minutesUntilExpiry, market, orderbook)

  const goal =
    `Analyze this Kalshi KXBTC15M 15-minute BTC prediction market. ` +
    `Determine: (1) the directional sentiment for BTC over this window, ` +
    `(2) the probability that BTC ends above the strike price at expiry, ` +
    `and (3) whether there is a profitable edge to trade YES, NO, or stand aside.`

  // ── Run ROMA recursive solve loop ───────────────────────────────────────
  const romaResult = await solve(goal, context, provider)

  // ── Extract structured numbers from ROMA's qualitative answer ───────────
  const pMarket = market ? market.yes_ask / 100 : 0.5
  const extracted = await extractStructured(romaResult.answer, pMarket, provider)

  const romaDurationMs = Date.now() - start
  const spread  = market ? (market.yes_ask - market.yes_bid) / 100 : 0.05
  const edge    = extracted.pModel - pMarket
  const edgePct = edge * 100
  const edgeStr = `${edge >= 0 ? '+' : ''}${edgePct.toFixed(1)}%`

  // Build ROMA trace for display (subtask tree)
  const subtaskTrace = romaResult.subtasks.map(t => ({
    id: t.id,
    goal: t.goal,
    result: t.result ?? '',
  }))

  const romaTrace =
    romaResult.wasAtomic
      ? `[ROMA: solved atomically]\n\n${romaResult.answer}`
      : `[ROMA: decomposed into ${romaResult.subtasks.length} subtasks]\n\n` +
        romaResult.subtasks.map(t => `• ${t.id}: ${t.goal}\n  → ${t.result}`).join('\n\n') +
        `\n\n[ROMA Aggregated Answer]\n${romaResult.answer}`

  // ── Return typed agent results ──────────────────────────────────────────
  const { label: providerLabel } = PROVIDER_MODELS[provider]

  const sentimentResult: AgentResult<SentimentOutput> = {
    agentName: `SentimentAgent (ROMA · ${providerLabel})`,
    status: 'done',
    output: {
      score:         Math.max(-1, Math.min(1, extracted.sentimentScore)),
      label:         extracted.sentimentLabel,
      momentum:      extracted.momentum,
      orderbookSkew: extracted.orderbookSkew,
      signals:       extracted.signals,
    },
    reasoning: romaTrace,
    durationMs: romaDurationMs,
    timestamp: new Date().toISOString(),
  }

  const probabilityResult: AgentResult<ProbabilityOutput> = {
    agentName: `ProbabilityModelAgent (ROMA · ${providerLabel})`,
    status: 'done',
    output: {
      pModel:         Math.max(0, Math.min(1, extracted.pModel)),
      pMarket,
      edge,
      edgePct,
      recommendation: extracted.recommendation,
      confidence:     extracted.confidence,
    },
    reasoning: `P(model)=${(extracted.pModel * 100).toFixed(1)}% vs P(market)=${(pMarket * 100).toFixed(1)}% — edge: ${edgeStr}. Spread: ${(spread * 100).toFixed(1)}%. Recommendation: ${extracted.recommendation} (${extracted.confidence} confidence).\n\nROMA reasoning: ${romaResult.answer}`,
    durationMs: romaDurationMs,
    timestamp: new Date().toISOString(),
  }

  return { sentimentResult, probabilityResult, romaSubtasks: subtaskTrace }
}
