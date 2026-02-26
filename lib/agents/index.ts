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
  provider2?: AIProvider,  // second provider for ProbabilityModel; eliminates the inter-stage pause
): Promise<PipelineState> {
  const cycleId = ++cycleCounter
  const cycleStartedAt = new Date().toISOString()
  const mode = romaMode ?? 'keen'

  // Per-stage mode: sentiment runs one tier lighter (faster, fewer tokens),
  // probability runs at the full selected quality tier.
  const sentMode = SENT_MODE_MAP[mode] ?? mode
  const probMode = mode

  // ── Stage 1: Market Discovery ──────────────────────────────────────────
  const mdResult = await runMarketDiscovery(markets)

  // ── Stage 2: Price Feed ────────────────────────────────────────────────
  const pfResult = runPriceFeed(quote, mdResult.output.strikePrice)

  // ── Stage 3: Sentiment Agent (lighter mode) ────────────────────────────
  const sentResult = await runSentiment(
    quote,
    mdResult.output.strikePrice,
    pfResult.output.distanceFromStrikePct,
    mdResult.output.minutesUntilExpiry,
    mdResult.output.activeMarket,
    orderbook,
    provider,
    sentMode,
  )

  // Pause only when both stages share the same provider (shared per-minute token budget).
  // Reduced from 8s→4s when stages use different modes (lighter sentiment = fewer tokens used).
  // Split-provider skips entirely — different providers have independent rate limits.
  const probProvider = provider2 ?? provider
  if (probProvider === provider) {
    const pauseMs = sentMode === probMode ? 8_000 : 4_000
    await new Promise(r => setTimeout(r, pauseMs))
  }

  // ── Stage 4: Probability Model (full quality mode) ────────────────────
  const probResult = await runProbabilityModel(
    sentResult.output.score,
    sentResult.output.signals,
    pfResult.output.distanceFromStrikePct,
    mdResult.output.minutesUntilExpiry,
    mdResult.output.activeMarket,
    probProvider,
    probMode,
  )

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
      )

  // ── Stage 6: Execution ─────────────────────────────────────────────────
  const execResult = runExecution(
    probResult.output.recommendation,
    riskResult.output.positionSize,
    mdResult.output.activeMarket,
    riskResult.output.approved,
  )

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
