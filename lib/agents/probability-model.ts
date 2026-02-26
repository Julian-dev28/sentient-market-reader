import type { AgentResult, ProbabilityOutput, KalshiMarket } from '../types'
import { llmToolCall, type AIProvider } from '../llm-client'
import { callPythonRoma, formatRomaTrace } from '../roma/python-client'

export async function runProbabilityModel(
  sentimentScore: number,
  sentimentSignals: string[],
  distanceFromStrikePct: number,
  minutesUntilExpiry: number,
  market: KalshiMarket | null,
  provider: AIProvider,
): Promise<AgentResult<ProbabilityOutput>> {
  const start = Date.now()

  const pMarket = market ? market.yes_ask / 100 : 0.5
  const spread  = market ? (market.yes_ask - market.yes_bid) / 100 : 0.05
  const distSign = distanceFromStrikePct >= 0 ? '+' : ''

  const context = [
    `SentimentAgent score: ${sentimentScore.toFixed(4)} (range -1 = strongly bearish → +1 = strongly bullish)`,
    `Key sentiment signals: ${sentimentSignals.join(' | ')}`,
    `BTC vs strike: ${distSign}${distanceFromStrikePct.toFixed(4)}% — currently ${distanceFromStrikePct >= 0 ? 'ABOVE' : 'BELOW'} strike`,
    `Minutes until expiry: ${minutesUntilExpiry.toFixed(2)}`,
    `Market-implied P(YES): ${(pMarket * 100).toFixed(1)}¢ — crowd's probability BTC ends above strike`,
    `Bid-ask spread: ${(spread * 100).toFixed(1)}¢`,
    `Minimum edge to trade: spread + 2¢ = ${((spread + 0.02) * 100).toFixed(1)}¢`,
  ].join('\n')

  const goal =
    `Estimate the true probability that BTC ends ABOVE the Kalshi strike at window close. ` +
    `Factor in: (1) sentiment + momentum signals, (2) current price position vs strike, ` +
    `(3) time decay with ${minutesUntilExpiry.toFixed(1)} min left, (4) whether model edge vs ` +
    `market-implied ${(pMarket * 100).toFixed(1)}% justifies trading YES, NO, or standing aside.`

  // ── Primary path: official Sentient roma-dspy service ────────────────────────
  let romaAnswer: string | null = null
  let agentLabel = 'ProbabilityModelAgent (roma-dspy)'
  let romaTrace  = ''

  try {
    const pythonResult = await callPythonRoma(goal, context, 2)
    romaAnswer = pythonResult.answer
    agentLabel = `ProbabilityModelAgent (roma-dspy · ${pythonResult.provider})`
    romaTrace  = formatRomaTrace(pythonResult)
  } catch (err) {
    // roma-dspy service unavailable — skip LLM reasoning, go straight to rule-based
    const timeWeight = Math.max(0, 1 - minutesUntilExpiry / 15)
    const logit  = sentimentScore * 3.0 + (distanceFromStrikePct / 0.5) * timeWeight * 2.0
    const pModel = 1 / (1 + Math.exp(-logit))
    const edge   = pModel - pMarket
    const edgePct = edge * 100
    const recommendation: ProbabilityOutput['recommendation'] =
      edge > spread + 0.02 ? 'YES' : edge < -(spread + 0.02) ? 'NO' : 'NO_TRADE'
    const confidence: ProbabilityOutput['confidence'] =
      Math.abs(edge) > 0.1 ? 'high' : Math.abs(edge) > 0.04 ? 'medium' : 'low'
    return {
      agentName: 'ProbabilityModelAgent (rule-based · roma-dspy unavailable)',
      status: 'done',
      output: { pModel, pMarket, edge, edgePct, recommendation, confidence },
      reasoning: `[rule-based fallback: roma-dspy unavailable — ${String(err)}]\nP(model)=${(pModel * 100).toFixed(1)}%`,
      durationMs: Date.now() - start,
      timestamp: new Date().toISOString(),
    }
  }

  // ── Structured extraction from ROMA's natural-language answer ────────────────
  try {
    const extracted = await llmToolCall<{
      pModel: number
      recommendation: ProbabilityOutput['recommendation']
      confidence: ProbabilityOutput['confidence']
    }>({
      provider,
      tier: 'smart',
      maxTokens: 512,
      toolName: 'extract_probability',
      toolDescription: 'Extract probability estimate and trade recommendation from ROMA analysis',
      schema: {
        properties: {
          pModel:         { type: 'number', description: 'Estimated P(YES) 0.0–1.0 that BTC ends above strike' },
          recommendation: { type: 'string', enum: ['YES', 'NO', 'NO_TRADE'], description: `YES = buy YES. NO = buy NO. NO_TRADE = edge < ${((spread + 0.02) * 100).toFixed(1)}¢` },
          confidence:     { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['pModel', 'recommendation', 'confidence'],
      },
      prompt: `Extract the probability estimate and trade recommendation from this ROMA analysis:\n\n${romaAnswer}\n\nMarket-implied P(YES): ${(pMarket * 100).toFixed(1)}%`,
    })

    const pModel  = Math.max(0, Math.min(1, extracted.pModel))
    const edge    = pModel - pMarket
    const edgePct = edge * 100

    return {
      agentName: agentLabel,
      status: 'done',
      output: { pModel, pMarket, edge, edgePct, recommendation: extracted.recommendation, confidence: extracted.confidence },
      reasoning: romaTrace + `\n\nP(model)=${(pModel * 100).toFixed(1)}% vs P(market)=${(pMarket * 100).toFixed(1)}% — edge: ${edgePct >= 0 ? '+' : ''}${edgePct.toFixed(1)}%. Rec: ${extracted.recommendation} (${extracted.confidence})`,
      durationMs: Date.now() - start,
      timestamp: new Date().toISOString(),
    }
  } catch (extractErr) {
    // Extraction failed — rule-based sigmoid using ROMA's qualitative output as context
    const timeWeight = Math.max(0, 1 - minutesUntilExpiry / 15)
    const logit  = sentimentScore * 3.0 + (distanceFromStrikePct / 0.5) * timeWeight * 2.0
    const pModel = 1 / (1 + Math.exp(-logit))
    const edge   = pModel - pMarket
    const edgePct = edge * 100
    const recommendation: ProbabilityOutput['recommendation'] =
      edge > spread + 0.02 ? 'YES' : edge < -(spread + 0.02) ? 'NO' : 'NO_TRADE'
    const confidence: ProbabilityOutput['confidence'] =
      Math.abs(edge) > 0.1 ? 'high' : Math.abs(edge) > 0.04 ? 'medium' : 'low'
    return {
      agentName: `${agentLabel} (rule-based extraction)`,
      status: 'done',
      output: { pModel, pMarket, edge, edgePct, recommendation, confidence },
      reasoning: romaTrace + `\n\n[rule-based extraction: ${String(extractErr)}]\nP(model)=${(pModel * 100).toFixed(1)}%`,
      durationMs: Date.now() - start,
      timestamp: new Date().toISOString(),
    }
  }
}
