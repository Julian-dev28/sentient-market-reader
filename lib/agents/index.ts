/**
 * ROMA Pipeline Orchestrator
 * ───────────────────────────
 * Runs all 6 ROMA pipeline agents in dependency order.
 * Every LLM step uses the provider set in AI_PROVIDER env var.
 *
 * Pipeline DAG:
 *   MarketDiscovery ──┐
 *   PriceFeed ─────────┼──► SentimentAgent (roma-dspy) ──► ProbabilityModelAgent (roma-dspy) ──► RiskManager ──► Execution
 *   (Orderbook) ───────┘
 */

import type {
  PipelineState,
  KalshiMarket,
  KalshiOrderbook,
  BTCQuote,
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
import { runRiskManager, runRomaRiskManager } from './risk-manager'
import { runExecution } from './execution'

let cycleCounter = 0

// ── Per-stage mode defaults ──────────────────────────────────────────────────
// Sentiment uses a lighter mode than probability by default:
//   blitz → blitz/blitz  |  sharp → sharp/sharp  |  keen → sharp/keen  |  smart → keen/smart
// This lets the simpler sentiment signal pass through faster without sacrificing
// the quality of the probability estimate (the critical decision-making step).
const SENT_MODE_MAP: Record<string, string> = { blitz: 'blitz', sharp: 'sharp', keen: 'sharp', smart: 'keen' }

export async function runAgentPipeline(
  markets: KalshiMarket[],
  quote: BTCQuote,
  orderbook: KalshiOrderbook | null,
  provider: AIProvider = 'grok',
  romaMode?: string,
  aiRisk: boolean = false,
  provider2?: AIProvider,      // second provider for ProbabilityModel; eliminates the inter-stage pause
  providers?: AIProvider[],    // multi-provider parallel solve for Sentiment stage (ensemble)
  sentModeOverride?: string,   // explicit mode for Sentiment stage (overrides SENT_MODE_MAP)
  probModeOverride?: string,   // explicit mode for Probability stage (overrides romaMode)
): Promise<PipelineState> {
  const cycleId = ++cycleCounter
  const cycleStartedAt = new Date().toISOString()
  const mode = romaMode ?? 'keen'

  // Per-stage mode: defaults to one tier lighter for sentiment via SENT_MODE_MAP.
  // Explicit overrides (sentModeOverride / probModeOverride) take precedence when set.
  const sentMode = sentModeOverride ?? (SENT_MODE_MAP[mode] ?? mode)
  const probMode = probModeOverride ?? mode

  // ── Previous cycle context ─────────────────────────────────────────────
  const last = getLastAnalysis()
  const prevContext = last
    ? `pModel=${(last.pModel * 100).toFixed(1)}% | market=${(last.pMarket * 100).toFixed(1)}% | edge=${(last.edge * 100).toFixed(1)}¢ | rec=${last.recommendation} | sentiment=${last.sentimentLabel}(${last.sentimentScore.toFixed(2)}) | BTC=$${last.btcPrice.toLocaleString()} vs strike=$${last.strikePrice.toLocaleString()} | completed ${Math.round((Date.now() - new Date(last.completedAt).getTime()) / 60000)}min ago`
    : undefined

  // ── Stage 1: Market Discovery ──────────────────────────────────────────
  const mdResult = await runMarketDiscovery(markets)

  // ── Stage 2: Price Feed ────────────────────────────────────────────────
  const pfResult = runPriceFeed(quote, mdResult.output.strikePrice)

  const probProvider = provider2 ?? provider
  const sentProviders = providers && providers.length > 1 ? providers : undefined

  // ── Stages 3 + 4: Sentiment + Probability in parallel ─────────────────
  // When provider2 is set (e.g. openrouter), each solve hits a different API
  // pool — wall time drops from ~60s to ~30s (both solves run simultaneously).
  // Probability runs without sentiment context when parallel; it reasons
  // directly from BTC position, time decay, and market odds instead.
  const [sentResult, probResult] = await Promise.all([
    runSentiment(
      quote,
      mdResult.output.strikePrice,
      pfResult.output.distanceFromStrikePct,
      mdResult.output.minutesUntilExpiry,
      mdResult.output.activeMarket,
      orderbook,
      provider,
      sentMode,
      sentProviders,
      prevContext,
    ),
    runProbabilityModel(
      null,   // parallel mode — no sentiment context available yet
      null,
      pfResult.output.distanceFromStrikePct,
      mdResult.output.minutesUntilExpiry,
      mdResult.output.activeMarket,
      probProvider,
      probMode,
      provider,   // extraction always on primary (grok) for reliable tool-call JSON
      prevContext,
    ),
  ])

  // ── Stage 5: Risk Manager ──────────────────────────────────────────────
  const side = probResult.output.recommendation === 'YES' ? 'yes' : 'no'
  const limitPrice =
    mdResult.output.activeMarket
      ? side === 'yes'
        ? mdResult.output.activeMarket.yes_ask
        : mdResult.output.activeMarket.no_ask
      : 50
  const riskResult = aiRisk
    ? await runRomaRiskManager(
        probResult.output.edgePct,
        probResult.output.pModel,
        probResult.output.recommendation,
        limitPrice,
        mdResult.output.minutesUntilExpiry,
        sentResult.output.signals,
        provider,
        romaMode,
      )
    : runRiskManager(
        probResult.output.edgePct,
        probResult.output.pModel,
        probResult.output.recommendation,
        limitPrice,
        sentResult.output.score,
      )

  // ── Stage 6: Execution ─────────────────────────────────────────────────
  const execResult = runExecution(
    probResult.output.recommendation,
    riskResult.output.positionSize,
    mdResult.output.activeMarket,
    riskResult.output.approved,
  )

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
