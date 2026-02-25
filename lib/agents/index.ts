/**
 * ROMA Pipeline Orchestrator
 * ───────────────────────────
 * Runs all 6 Sentient GRID agents in dependency order.
 * Each agent receives the output of upstream agents as input.
 *
 * Pipeline DAG:
 *   MarketDiscovery ──┐
 *   PriceFeed ─────────┼──► Sentiment ──► ProbabilityModel ──► RiskManager ──► Execution
 *   (Orderbook) ───────┘
 */

import type { PipelineState, KalshiMarket, KalshiOrderbook, BTCQuote, AgentResult, MarketDiscoveryOutput, PriceFeedOutput, SentimentOutput, ProbabilityOutput, RiskOutput, ExecutionOutput } from '../types'
import { runMarketDiscovery } from './market-discovery'
import { runPriceFeed } from './price-feed'
import { runRomaTradeAnalysis } from '../roma'
import { runRiskManager } from './risk-manager'
import { runExecution } from './execution'

let cycleCounter = 0

export async function runAgentPipeline(
  markets: KalshiMarket[],
  quote: BTCQuote,
  orderbook: KalshiOrderbook | null
): Promise<PipelineState> {
  const cycleId = ++cycleCounter
  const cycleStartedAt = new Date().toISOString()

  // ── Stage 1: Market Discovery ──────────────────────────────────────────
  const mdResult = await runMarketDiscovery(markets)

  // ── Stage 2: Price Feed ────────────────────────────────────────────────
  const pfResult = runPriceFeed(quote, mdResult.output.strikePrice)

  // ── Stages 3 + 4: ROMA Multi-Agent Analysis ───────────────────────────
  // Atomizer → Planner → parallel Executors → Aggregator → structured extract
  const { sentimentResult: sentResult, probabilityResult: probResult } =
    await runRomaTradeAnalysis(
      quote,
      mdResult.output.strikePrice,
      pfResult.output.distanceFromStrikePct,
      mdResult.output.minutesUntilExpiry,
      mdResult.output.activeMarket,
      orderbook
    )

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
    limitPrice
  )

  // ── Stage 6: Execution ─────────────────────────────────────────────────
  const execResult = runExecution(
    probResult.output.recommendation,
    riskResult.output.positionSize,
    mdResult.output.activeMarket,
    riskResult.output.approved
  )

  return {
    cycleId,
    cycleStartedAt,
    cycleCompletedAt: new Date().toISOString(),
    status: 'completed',
    agents: {
      marketDiscovery: mdResult as AgentResult<MarketDiscoveryOutput>,
      priceFeed: pfResult as AgentResult<PriceFeedOutput>,
      sentiment: sentResult as AgentResult<SentimentOutput>,
      probability: probResult as AgentResult<ProbabilityOutput>,
      risk: riskResult as AgentResult<RiskOutput>,
      execution: execResult as AgentResult<ExecutionOutput>,
    },
  }
}
