/**
 * Agent Pipeline Orchestrator
 * ───────────────────────────
 * Runs all pipeline agents in dependency order.
 * Every LLM step uses the provider set in AI_PROVIDER env var.
 *
 * Pipeline DAG:
 *   MarketDiscovery ──┐
 *   PriceFeed ─────────┼──► SentimentAgent ──► ProbabilityModelAgent ──► MarkovChain ──► Execution
 *
 * Markov chain IS the risk engine — entry filter + Kelly sizing + safety gates.
 * AI mode (aiRisk=true): sentiment + probability from Grok; Markov still decides sizing.
 */

import type {
  PipelineState,
  KalshiMarket,
  KalshiOrderbook,
  BTCQuote,
  OHLCVCandle,
  DerivativesSignal,
  AgentResult,
  AnyAgentResult,
  MarketDiscoveryOutput,
  PriceFeedOutput,
  SentimentOutput,
  ProbabilityOutput,
  MarkovOutput,
  ExecutionOutput,
} from '../types'
import type { AIProvider } from '../llm-client'
import { getLastAnalysis, setLastAnalysis } from '../pipeline-lock'
import { runMarketDiscovery } from './market-discovery'
import { runPriceFeed } from './price-feed'
import { runSentiment } from './sentiment'
import { runProbabilityModel } from './probability-model'
import { runMarkovAgent } from './markov'
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
  emit?: (key: string, result: AnyAgentResult) => void,  // SSE streaming callback
  portfolioValueCents: number = 0,  // live Kalshi balance (cash + positions) in cents
  apiKeys?: Record<string, string>, // per-provider API keys from user settings
  candles1h?: OHLCVCandle[],  // last 12 × 1h candles — intraday trend context
  candles4h?: OHLCVCandle[],  // last 7 × 4h candles — macro trend context
  kxbtcdMarket?: KalshiMarket | null,  // highest-liquidity KXBTCD hourly strike (passed in hourly mode)
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
  // kxbtcdMarket is only non-null when marketMode='hourly' (gated in pipeline/route.ts).
  // useKxbtcd is passed to Grok when aiRisk=true so it knows to use hourly-mode prompts.
  // When aiRisk=false (quant mode), the ROMA quant pipeline runs on the KXBTCD market data.
  const useKxbtcd = !!kxbtcdMarket
  const mdResult = await runMarketDiscovery(markets, kxbtcdMarket ?? null)
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
  // Quant mode (aiRisk=false) always runs the ROMA pipeline — even for KXBTCD hourly markets.
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
      useKxbtcd,  // isHourly — changes prompt + relaxes 15m-calibrated gates
    )
    emit?.('sentiment',   grok.sentiment)
    emit?.('probability', grok.probability)

    const markovResultAI = runMarkovAgent(
      pfResult.output.distanceFromStrikePct,
      mdResult.output.strikePrice,
      mdResult.output.activeMarket,
      liveCandles,
      candles,
      portfolioValue,
      mdResult.output.minutesUntilExpiry,
      grok.probability.output.gkVol15m,
      grok.probability.output.confidence,
      useKxbtcd,
    )
    emit?.('markov', markovResultAI)

    const execResultAI = await runExecution(
      markovResultAI.output.recommendation,
      markovResultAI.output.positionSize,
      mdResult.output.activeMarket,
      markovResultAI.output.approved,
      portfolioValue > 0 ? portfolioValue : undefined,
      mdResult.output.minutesUntilExpiry,
      provider,
    )
    emit?.('execution', execResultAI)

    setLastAnalysis({
      pModel:         grok.probability.output.pModel,
      pMarket:        grok.probability.output.pMarket,
      edge:           grok.probability.output.edge,
      recommendation: markovResultAI.output.recommendation,
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
        marketDiscovery: mdResult          as AgentResult<MarketDiscoveryOutput>,
        priceFeed:       pfResult          as AgentResult<PriceFeedOutput>,
        sentiment:       grok.sentiment    as AgentResult<SentimentOutput>,
        probability:     grok.probability  as AgentResult<ProbabilityOutput>,
        markov:          markovResultAI    as AgentResult<MarkovOutput>,
        execution:       execResultAI      as AgentResult<ExecutionOutput>,
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
    useKxbtcd,   // isHourly — skips 15m-calibrated d-gate
  )
  emit?.('probability', probResult)

  // ── Stage 4.5: Markov Chain (IS the risk engine) ──────────────────────
  const markovResult = runMarkovAgent(
    pfResult.output.distanceFromStrikePct,
    mdResult.output.strikePrice,
    mdResult.output.activeMarket,
    liveCandles,
    candles,
    portfolioValue,
    mdResult.output.minutesUntilExpiry,
    probResult.output.gkVol15m,
    probResult.output.confidence,
    useKxbtcd,
  )
  emit?.('markov', markovResult)

  // ── Stage 5: Execution ─────────────────────────────────────────────────
  const execResult = await runExecution(
    markovResult.output.recommendation,
    markovResult.output.positionSize,
    mdResult.output.activeMarket,
    markovResult.output.approved,
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
      marketDiscovery: mdResult     as AgentResult<MarketDiscoveryOutput>,
      priceFeed:       pfResult     as AgentResult<PriceFeedOutput>,
      sentiment:       sentResult   as AgentResult<SentimentOutput>,
      probability:     probResult   as AgentResult<ProbabilityOutput>,
      markov:          markovResult as AgentResult<MarkovOutput>,
      execution:       execResult   as AgentResult<ExecutionOutput>,
    },
  }
}
