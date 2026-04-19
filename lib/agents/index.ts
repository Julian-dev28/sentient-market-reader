/**
 * Agent Pipeline Orchestrator
 * ───────────────────────────
 * Runs all pipeline agents in dependency order.
 * Every LLM step uses the provider set in AI_PROVIDER env var.
 *
 * Pipeline DAG:
 *   MarketDiscovery ──┐
 *   PriceFeed ─────────┼──► Markov (gate) ──► Sentiment ──► Probability ──► Execution
 *
 * Markov runs first as a regime gate — if momentum isn't locked-in and decisive,
 * the pipeline short-circuits (no LLM calls, no trade). When it passes, Sentiment +
 * Probability run, and Execution only fires if both models agree on direction.
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
import { computeGarmanKlassVol } from '../indicators'
import { runMarketDiscovery } from './market-discovery'
import { runPriceFeed } from './price-feed'
import { runSentiment } from './sentiment'
import { runProbabilityModel } from './probability-model'
import { runMarkovAgent } from './markov'
import { runExecution } from './execution'
import { runGrokTradingAgent } from './grok-trading-agent'
import { runRiskManager } from './risk-manager'

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

  // ── Stage 2.5: Markov ─────────────────────────────────────────────────
  // Quant mode: hard gate — if momentum isn't locked-in and decisive, skip all LLM calls.
  // AI mode:    advisory only — Grok receives Markov as one signal and makes the final call.
  const gkVolEarly = candles && candles.length >= 2 ? computeGarmanKlassVol(candles) : null
  const markovGate = runMarkovAgent(
    pfResult.output.distanceFromStrikePct,
    mdResult.output.strikePrice,
    mdResult.output.activeMarket,
    liveCandles,
    candles,
    portfolioValue,
    mdResult.output.minutesUntilExpiry,
    gkVolEarly,
    undefined,
    useKxbtcd,
  )
  emit?.('markov', markovGate)

  // Quant-only hard gate
  if (!aiRisk && !markovGate.output.approved) {
    const passExec = await runExecution(
      'NO_TRADE',
      0,
      mdResult.output.activeMarket,
      false,
      portfolioValue > 0 ? portfolioValue : undefined,
      mdResult.output.minutesUntilExpiry,
      provider,
    )
    emit?.('execution', passExec)
    return {
      cycleId,
      cycleStartedAt,
      cycleCompletedAt: new Date().toISOString(),
      status: 'completed',
      agents: {
        marketDiscovery: mdResult   as AgentResult<MarketDiscoveryOutput>,
        priceFeed:       pfResult   as AgentResult<PriceFeedOutput>,
        sentiment:       { agentName: 'SentimentAgent', status: 'done', output: { score: 0, label: 'neutral', momentum: 0, orderbookSkew: 0, signals: ['Markov gate blocked'], provider: 'skipped' }, reasoning: 'Markov gate blocked', durationMs: 0, timestamp: new Date().toISOString() } as AgentResult<SentimentOutput>,
        probability:     { agentName: 'ProbabilityModelAgent', status: 'done', output: { pModel: 0.5, pMarket: 0.5, edge: 0, edgePct: 0, recommendation: 'NO_TRADE', confidence: 'low', provider: 'skipped', gkVol15m: gkVolEarly, volOfVol: null, dScore: null }, reasoning: 'Markov gate blocked', durationMs: 0, timestamp: new Date().toISOString() } as unknown as AgentResult<ProbabilityOutput>,
        markov:          markovGate as AgentResult<MarkovOutput>,
        execution:       passExec   as AgentResult<ExecutionOutput>,
      },
    }
  }

  // ── AI mode: Grok has full decision authority — Markov is one input signal ──
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
      useKxbtcd,
      markovGate.output,  // Markov as advisory context
    )
    emit?.('sentiment',   grok.sentiment)
    emit?.('probability', grok.probability)

    // Grok has final say — no direction alignment requirement
    const finalRec  = grok.probability.output.recommendation
    const finalSize = grok.execution.output.contracts ?? 0

    const execResultAI = await runExecution(
      finalRec,
      finalSize,
      mdResult.output.activeMarket,
      finalRec !== 'NO_TRADE',
      portfolioValue > 0 ? portfolioValue : undefined,
      mdResult.output.minutesUntilExpiry,
      provider,
    )
    emit?.('execution', execResultAI)

    setLastAnalysis({
      pModel:         grok.probability.output.pModel,
      pMarket:        grok.probability.output.pMarket,
      edge:           grok.probability.output.edge,
      recommendation: finalRec,
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
        markov:          markovGate        as AgentResult<MarkovOutput>,
        execution:       execResultAI      as AgentResult<ExecutionOutput>,
      },
    }
  }

  // ── Stage 3: Sentiment ─────────────────────────────────────────────────
  const sentResult = await runSentiment(
    enrichedQuote,
    mdResult.output.strikePrice,
    pfResult.output.distanceFromStrikePct,
    mdResult.output.minutesUntilExpiry,
    mdResult.output.activeMarket,
    orderbook,
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
    aiRisk,
    candles1h,
    candles4h,
  )
  emit?.('sentiment', sentResult)

  // ── Stage 4: Probability ───────────────────────────────────────────────
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
    aiRisk,
    candles1h,
    candles4h,
    useKxbtcd,
  )
  emit?.('probability', probResult)

  // ── Stage 5: Risk Manager — gates price cap, timing, edge, and sizes position ──
  const probRec = probResult.output.recommendation
  const mrkRec  = markovGate.output.recommendation
  const aligned = probRec !== 'NO_TRADE' && mrkRec !== 'NO_TRADE' && probRec === mrkRec

  let finalRec: 'YES' | 'NO' | 'NO_TRADE' = aligned ? mrkRec : 'NO_TRADE'
  let finalSize = 0

  const market = mdResult.output.activeMarket
  const candidatePrice = finalRec === 'YES'
    ? (market?.yes_ask ?? 50)
    : finalRec === 'NO'
      ? (market?.no_ask ?? 50)
      : 50

  const riskResult = runRiskManager(
    probResult.output.edgePct,
    probResult.output.pModel,
    finalRec,
    candidatePrice,
    sentResult.output.score,
    gkVolEarly,
    probResult.output.confidence,
    portfolioValue > 0 ? portfolioValue : 500,
    mdResult.output.minutesUntilExpiry,
    pfResult.output.distanceFromStrikePct,
    probResult.output.volOfVol,
    useKxbtcd,
    markovGate.output,
  )
  emit?.('risk', riskResult)

  if (riskResult.output.approved) {
    finalSize = riskResult.output.positionSize
  } else {
    finalRec = 'NO_TRADE'
  }

  // ── Stage 6: Execution ────────────────────────────────────────────────────
  const execResult = await runExecution(
    finalRec,
    finalSize,
    mdResult.output.activeMarket,
    finalRec !== 'NO_TRADE',
    portfolioValue > 0 ? portfolioValue : undefined,
    mdResult.output.minutesUntilExpiry,
    provider,
  )
  emit?.('execution', execResult)

  setLastAnalysis({
    pModel:         probResult.output.pModel,
    pMarket:        probResult.output.pMarket,
    edge:           probResult.output.edge,
    recommendation: finalRec,
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
      markov:          markovGate   as AgentResult<MarkovOutput>,
      risk:            riskResult,
      execution:       execResult   as AgentResult<ExecutionOutput>,
    },
  }
}
