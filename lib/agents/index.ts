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
  provider2?: AIProvider,   // second provider for ProbabilityModel; eliminates the inter-stage pause
  providers?: AIProvider[], // multi-provider parallel solve for Sentiment stage (ensemble)
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

  // ── Stage 3: Sentiment Agent (lighter mode, optionally multi-provider) ──
  // When `providers` contains multiple entries, the Python service runs each
  // provider's ROMA solve in parallel and merges the answers — richer signal diversity.
  const sentProviders = providers && providers.length > 1 ? providers : undefined
  const sentResult = await runSentiment(
    quote,
    mdResult.output.strikePrice,
    pfResult.output.distanceFromStrikePct,
    mdResult.output.minutesUntilExpiry,
    mdResult.output.activeMarket,
    orderbook,
    provider,
    sentMode,
    sentProviders,
  )

  const probProvider = provider2 ?? provider

  // ── Stage 4: Probability Model (full quality mode) ────────────────────
  // probProvider may be provider2 (e.g. huggingface) — used for the ROMA solve only.
  // Extraction always runs on the primary provider to ensure reliable tool-call JSON.
  const probResult = await runProbabilityModel(
    sentResult.output.score,
    sentResult.output.signals,
    pfResult.output.distanceFromStrikePct,
    mdResult.output.minutesUntilExpiry,
    mdResult.output.activeMarket,
    probProvider,
    probMode,
    provider,   // extraction provider — always primary (grok)
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
