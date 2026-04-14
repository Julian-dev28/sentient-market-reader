/**
 * Agent Pipeline Orchestrator
 * ───────────────────────────
 * Runs all pipeline agents in dependency order.
 * Every LLM step uses the provider set in AI_PROVIDER env var.
 *
 * Pipeline DAG:
 *   MarketDiscovery ──┐
 *   PriceFeed ─────────┼──► SentimentAgent ──► ProbabilityModelAgent ──► RiskManager ──► Execution
 *
 * AI mode (aiRisk=true): stages 3-6 replaced by a single Grok trading agent call.
 */

import type {
  PipelineState,
  KalshiMarket,
  KalshiOrderbook,
  BTCQuote,
  OHLCVCandle,
  DerivativesSignal,
  AgentResult,
  MarketDiscoveryOutput,
  PriceFeedOutput,
  SentimentOutput,
  ProbabilityOutput,
  RiskOutput,
  ExecutionOutput,
} from '../types'
import type { AIProvider } from '../llm-client'
import { getLastAnalysis, setLastAnalysis } from '../pipeline-lock'
import { runMarketDiscovery } from './market-discovery'
import { runPriceFeed } from './price-feed'
import { runSentiment } from './sentiment'
import { runProbabilityModel } from './probability-model'
import { runRiskManager } from './risk-manager'
import { runExecution } from './execution'
import { runGrokTradingAgent } from './grok-trading-agent'

let cycleCounter = 0

// ── Per-stage mode defaults ──────────────────────────────────────────────────
export async function runAgentPipeline(
  markets: KalshiMarket[],
  quote: BTCQuote,
  orderbook: KalshiOrderbook | null,
  provider: AIProvider = 'grok',
  romaMode?: string,
  aiRisk: boolean = false,
  provider2?: AIProvider,      // second provider for ProbabilityModel; eliminates the inter-stage pause
  providers?: AIProvider[],    // multi-provider parallel solve for Sentiment stage (ensemble)
  candles?: OHLCVCandle[],     // last 12 completed 15-min candles, newest first
  liveCandles?: OHLCVCandle[], // last 16 × 1-min candles — intra-window live price action
  derivatives?: DerivativesSignal | null,  // perp futures funding rate + basis
  orModelOverride?: string,    // override OpenRouter model ID for sentiment + probability stages
  signal?: AbortSignal,        // abort signal — cancels in-flight ROMA fetches when client disconnects
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  emit?: (key: string, result: AgentResult<any>) => void,  // SSE streaming callback
  portfolioValueCents: number = 0,  // live Kalshi balance (cash + positions) in cents
  apiKeys?: Record<string, string>, // per-provider API keys from user settings
  candles1h?: OHLCVCandle[],  // last 12 × 1h candles — intraday trend context
  candles4h?: OHLCVCandle[],  // last 7 × 4h candles — macro trend context
): Promise<PipelineState> {
  const cycleId = ++cycleCounter
  const cycleStartedAt = new Date().toISOString()
  const portfolioValue = portfolioValueCents / 100  // convert cents → dollars

  // ── Previous cycle context ─────────────────────────────────────────────
  const last = getLastAnalysis()
  const prevContext = last
    ? `pModel=${(last.pModel * 100).toFixed(1)}% | market=${(last.pMarket * 100).toFixed(1)}% | edge=${(last.edge * 100).toFixed(1)}¢ | rec=${last.recommendation} | sentiment=${last.sentimentLabel}(${last.sentimentScore.toFixed(2)}) | BTC=$${last.btcPrice.toLocaleString()} vs strike=$${last.strikePrice.toLocaleString()} | completed ${Math.round((Date.now() - new Date(last.completedAt).getTime()) / 60000)}min ago`
    : undefined

  // ── Stage 1: Market Discovery ──────────────────────────────────────────
  const mdResult = await runMarketDiscovery(markets)
  emit?.('marketDiscovery', mdResult)

  // ── Enrich quote: compute real 1h momentum from candles if source returned 0 ──
  const enrichedQuote = { ...quote }
  if (enrichedQuote.percent_change_1h === 0 && candles && candles.length >= 4) {
    // candles are newest-first; index 3 = close ~60 min ago (4 × 15-min bars)
    const price1hAgo = candles[3][4]
    if (price1hAgo > 0) {
      enrichedQuote.percent_change_1h = ((quote.price - price1hAgo) / price1hAgo) * 100
    }
  }

  // ── Stage 2: Price Feed ────────────────────────────────────────────────
  const pfResult = runPriceFeed(enrichedQuote, mdResult.output.strikePrice)
  emit?.('priceFeed', pfResult)

  // ── AI mode: single Grok agent replaces stages 3-6 ────────────────────────
  // Grok receives the full market picture and makes ALL decisions with full
  // capital authority: direction, probability, sizing, optional hedge.
  if (aiRisk) {
    const grok = await runGrokTradingAgent(
      enrichedQuote,
      mdResult.output.strikePrice,
      pfResult.output.distanceFromStrikePct,
      mdResult.output.minutesUntilExpiry,
      mdResult.output.activeMarket,
      orderbook,
      portfolioValue,
      candles,
      liveCandles,
      derivatives ?? undefined,
      orModelOverride,
      signal,
      prevContext,
      candles1h,
      candles4h,
    )
    emit?.('sentiment',   grok.sentiment)
    emit?.('probability', grok.probability)
    emit?.('risk',        grok.risk)
    emit?.('execution',   grok.execution)

    setLastAnalysis({
      pModel:         grok.probability.output.pModel,
      pMarket:        grok.probability.output.pMarket,
      edge:           grok.probability.output.edge,
      recommendation: grok.probability.output.recommendation,
      sentimentScore: grok.sentiment.output.score,
      sentimentLabel: grok.sentiment.output.label,
      btcPrice:       enrichedQuote.price,
      strikePrice:    mdResult.output.strikePrice,
      completedAt:    new Date().toISOString(),
    })

    return {
      cycleId,
      cycleStartedAt,
      cycleCompletedAt: new Date().toISOString(),
      status: 'completed',
      agents: {
        marketDiscovery: mdResult as AgentResult<MarketDiscoveryOutput>,
        priceFeed:       pfResult as AgentResult<PriceFeedOutput>,
        sentiment:       grok.sentiment   as AgentResult<SentimentOutput>,
        probability:     grok.probability as AgentResult<ProbabilityOutput>,
        risk:            grok.risk        as AgentResult<RiskOutput>,
        execution:       grok.execution   as AgentResult<ExecutionOutput>,
      },
    }
  }

  // ── Stage 3: Sentiment — price + orderbook ──────────────────────────────
  const sentResult = await runSentiment(
    enrichedQuote,
    mdResult.output.strikePrice,
    pfResult.output.distanceFromStrikePct,
    mdResult.output.minutesUntilExpiry,
    mdResult.output.activeMarket,
    orderbook,   // real Kalshi orderbook depth — wired into OB imbalance scoring
    provider,
    romaMode,
    providers,
    prevContext,
    candles,
    liveCandles,
    derivatives ?? undefined,
    provider2,
    orModelOverride,
    signal,
    apiKeys,
    aiRisk,      // true = Grok-powered sentiment
    candles1h,
    candles4h,
  )
  emit?.('sentiment', sentResult)

  // ── Stage 4: Probability ───────────────────────────────────────────────────
  const probResult = await runProbabilityModel(
    sentResult.output.score,
    sentResult.output.signals,
    pfResult.output.distanceFromStrikePct,
    mdResult.output.minutesUntilExpiry,
    mdResult.output.activeMarket,
    provider,
    undefined, undefined, undefined,
    prevContext,
    candles,
    liveCandles,
    derivatives ?? undefined,
    orModelOverride,
    signal,
    apiKeys,
    aiRisk,      // true = Grok-powered probability
    candles1h,
    candles4h,
  )
  emit?.('probability', probResult)

  // ── Stage 5: Risk Manager ──────────────────────────────────────────────
  const side = probResult.output.recommendation === 'YES' ? 'yes' : 'no'
  const limitPrice =
    mdResult.output.activeMarket
      ? side === 'yes'
        ? mdResult.output.activeMarket.yes_ask
        : mdResult.output.activeMarket.no_ask
      : 50
  const riskResult = runRiskManager(
    probResult.output.edgePct,
    probResult.output.pModel,
    probResult.output.recommendation,
    limitPrice,
    sentResult.output.score,
    probResult.output.gkVol15m,
    probResult.output.confidence,
    portfolioValue,
    mdResult.output.minutesUntilExpiry,
    pfResult.output.distanceFromStrikePct,
    probResult.output.volOfVol,
  )
  emit?.('risk', riskResult)

  // ── Stage 6: Execution ─────────────────────────────────────────────────
  const execResult = await runExecution(
    probResult.output.recommendation,
    riskResult.output.positionSize,
    mdResult.output.activeMarket,
    riskResult.output.approved,
    portfolioValue > 0 ? portfolioValue : undefined,
    mdResult.output.minutesUntilExpiry,
    provider,
  )
  emit?.('execution', execResult)

  // Store result for next cycle's context
  setLastAnalysis({
    pModel:         probResult.output.pModel,
    pMarket:        probResult.output.pMarket,
    edge:           probResult.output.edge,
    recommendation: probResult.output.recommendation,
    sentimentScore: sentResult.output.score,
    sentimentLabel: sentResult.output.label,
    btcPrice:       quote.price,
    strikePrice:    mdResult.output.strikePrice,
    completedAt:    new Date().toISOString(),
  })

  return {
    cycleId,
    cycleStartedAt,
    cycleCompletedAt: new Date().toISOString(),
    status: 'completed',
    agents: {
      marketDiscovery: mdResult as AgentResult<MarketDiscoveryOutput>,
      priceFeed:       pfResult as AgentResult<PriceFeedOutput>,
      sentiment:       sentResult as AgentResult<SentimentOutput>,
      probability:     probResult as AgentResult<ProbabilityOutput>,
      risk:            riskResult as AgentResult<RiskOutput>,
      execution:       execResult as AgentResult<ExecutionOutput>,
    },
  }
}
