import type { AgentResult, ProbabilityOutput, KalshiMarket, OHLCVCandle } from '../types'
import { llmToolCall, type AIProvider } from '../llm-client'
import { callPythonRoma, formatRomaTrace } from '../roma/python-client'

/** Format last N 15-min candles as compact context for the LLM.
 *  Input: newest-first [ts, low, high, open, close, volume]
 *  Output: candle flip/streak alert at the top + oldest-first table.
 */
function formatCandles(candles: OHLCVCandle[]): string {
  if (!candles.length) return ''
  const ordered = [...candles].reverse() // oldest first
  const lines = ordered.map((c, i) => {
    const [, low, high, open, close, vol] = c
    const chg    = close - open
    const chgPct = ((chg / open) * 100).toFixed(2)
    const dir    = chg >= 0 ? '▲' : '▼'
    const minsAgo = (candles.length - i) * 15
    return `  [−${String(minsAgo).padStart(3)}m]  O:${open.toFixed(0)}  H:${high.toFixed(0)}  L:${low.toFixed(0)}  C:${close.toFixed(0)}  Vol:${vol.toFixed(1)}  ${dir}${chgPct}%`
  })

  // Candle flip / streak analysis (candles are newest-first; [3]=open [4]=close)
  const dirs = candles.slice(0, 8).map(c => (c[4] >= c[3] ? 'GREEN' : 'RED'))
  let flipNote = ''
  if (dirs.length >= 2) {
    if (dirs[0] !== dirs[1]) {
      let priorStreak = 1
      for (let i = 2; i < dirs.length; i++) {
        if (dirs[i] === dirs[1]) priorStreak++; else break
      }
      const direction = dirs[0] === 'GREEN'
        ? `RED→GREEN FLIP (potential bullish reversal)`
        : `GREEN→RED FLIP (potential bearish reversal)`
      flipNote = `⚡ CANDLE FLIP ALERT: Most recent candle is a ${direction} after a ${priorStreak}-candle ${dirs[1]} streak. This is a high-priority reversal signal — override prior directional bias. Do not extrapolate the previous trend.`
    } else {
      let streak = 1
      for (let i = 1; i < dirs.length; i++) {
        if (dirs[i] === dirs[0]) streak++; else break
      }
      const cont = dirs[0] === 'GREEN' ? 'bullish continuation' : 'bearish continuation'
      flipNote = `Candle streak: ${streak} consecutive ${dirs[0]} candles — ${cont}.`
    }
  }

  return `${flipNote}\nLast ${candles.length} × 15-min BTC candles (oldest → newest):\n${lines.join('\n')}`
}

// ── Quantitative probability anchor ──────────────────────────────────────────
// Models P(BTC stays above/below strike) using a Brownian motion approximation.
// Prevents the LLM from being catastrophically wrong late in a window when BTC
// is clearly above/below strike — the physics of time + volatility govern.
//
// Formula: P(YES) ≈ Φ(d / (σ_per_min × √t))
//   d = signed distance from strike (fraction)
//   σ_per_min = realized candle volatility scaled to per-minute
//   t = minutes remaining
//   Φ = standard normal CDF

function normalCDF(z: number): number {
  // Abramowitz & Stegun approximation (error < 7.5e-8)
  const sign = z >= 0 ? 1 : -1
  const x = Math.abs(z)
  const t = 1 / (1 + 0.2316419 * x)
  const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))))
  const pdf  = Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI)
  return 0.5 + sign * (0.5 - pdf * poly)
}

function computeQuantPrior(
  candles: OHLCVCandle[] | undefined,
  distancePct: number,
  minutesLeft: number,
): { pQuant: number; sigmaCandle: number } | null {
  if (!candles?.length || minutesLeft <= 0) return null
  // Realized volatility: mean absolute 15-min candle return (|close - open| / open)
  const absReturns = candles.map(c => Math.abs((c[4] - c[3]) / c[3]))
  const sigmaCandle = absReturns.reduce((a, b) => a + b, 0) / absReturns.length
  if (sigmaCandle <= 0) return null
  // Scale to per-minute using square-root-of-time rule
  const sigmaPerMin = sigmaCandle / Math.sqrt(15)
  // Signed distance as fraction (distancePct is already %, so /100)
  const z = (distancePct / 100) / (sigmaPerMin * Math.sqrt(minutesLeft))
  return { pQuant: normalCDF(z), sigmaCandle }
}

export async function runProbabilityModel(
  sentimentScore: number | null,    // null when running in parallel with sentiment agent
  sentimentSignals: string[] | null,
  distanceFromStrikePct: number,
  minutesUntilExpiry: number,
  market: KalshiMarket | null,
  provider: AIProvider,       // ROMA solve provider (may be split provider2)
  romaMode?: string,
  extractionProvider?: AIProvider,  // provider for JSON extraction step (defaults to provider)
  prevContext?: string,
  candles?: OHLCVCandle[],
): Promise<AgentResult<ProbabilityOutput>> {
  const start = Date.now()

  const pMarket = market ? market.yes_ask / 100 : 0.5
  const spread  = market ? (market.yes_ask - market.yes_bid) / 100 : 0.05
  const distSign = distanceFromStrikePct >= 0 ? '+' : ''

  // Compute quantitative prior from realized volatility + distance + time
  const quantResult = computeQuantPrior(candles, distanceFromStrikePct, minutesUntilExpiry)

  const context = [
    sentimentScore !== null
      ? `SentimentAgent score: ${sentimentScore.toFixed(4)} (range -1 = strongly bearish → +1 = strongly bullish)`
      : `SentimentAgent score: (running in parallel — use price position and market data only)`,
    sentimentSignals?.length
      ? `Key sentiment signals: ${sentimentSignals.join(' | ')}`
      : `Key sentiment signals: (unavailable — infer from BTC position and orderbook)`,
    `BTC vs strike: ${distSign}${distanceFromStrikePct.toFixed(4)}% — currently ${distanceFromStrikePct >= 0 ? 'ABOVE' : 'BELOW'} strike`,
    `Minutes until expiry: ${minutesUntilExpiry.toFixed(2)}`,
    `Market-implied P(YES): ${(pMarket * 100).toFixed(1)}¢ — crowd's probability BTC ends above strike`,
    `Bid-ask spread: ${(spread * 100).toFixed(1)}¢`,
    `Minimum edge to trade: spread + 2¢ = ${((spread + 0.02) * 100).toFixed(1)}¢`,
    quantResult
      ? `Quantitative prior P(YES): ${(quantResult.pQuant * 100).toFixed(1)}% — computed from realized vol ${(quantResult.sigmaCandle * 100).toFixed(2)}%/candle, distance ${distSign}${distanceFromStrikePct.toFixed(3)}%, ${minutesUntilExpiry.toFixed(1)} min left. This is a physics-based anchor — your estimate should not diverge by more than 20pp unless you have very strong countervailing signals.`
      : null,
    ...(candles?.length ? [`\n${formatCandles(candles)}`] : []),
    ...(prevContext ? [`\nPrevious cycle analysis:\n${prevContext}`] : []),
  ].filter(Boolean).join('\n')

  const goal =
    `Estimate the true probability that BTC ends ABOVE the Kalshi strike at window close. ` +
    `Factor in: (1) sentiment + momentum signals, (2) current price position vs strike, ` +
    `(3) candle structure from the last 12 completed 15-min bars — ` +
    `CRITICAL: if the candle data contains a ⚡ CANDLE FLIP ALERT, this overrides prior trend bias. ` +
    `A RED→GREEN flip means bullish reversal is underway; GREEN→RED means bearish reversal. ` +
    `Do NOT extrapolate a streak that has already reversed. ` +
    `Also apply WaveTrend-style momentum (overbought/oversold, exhaustion vs continuation); ` +
    `(4) time decay with ${minutesUntilExpiry.toFixed(1)} min left — ` +
    `when BTC is within 0.3% of strike AND a candle flip just occurred, the probability should ` +
    `shift significantly toward the flip direction, not stay anchored to the prior streak; ` +
    `(5) whether model edge vs market-implied ${(pMarket * 100).toFixed(1)}% justifies trading YES, NO, or standing aside.`

  // Depth controlled by ROMA_MAX_DEPTH env var (default 1). ROMA treats 0 as unlimited — never send 0.
  const maxDepth = Math.max(1, parseInt(process.env.ROMA_MAX_DEPTH ?? '1'))
  const pythonResult = await callPythonRoma(goal, context, maxDepth, 2, romaMode, provider)
  const romaAnswer = pythonResult.answer
  const agentLabel = `ProbabilityModelAgent (roma-dspy · ${pythonResult.provider})`
  const romaTrace  = formatRomaTrace(pythonResult)

  // Use fast tier for extraction — always on the primary provider (grok), never on the
  // split provider2, since smaller HF models can't reliably produce tool-call JSON.
  const extracted = await llmToolCall<{
    pModel: number
    recommendation: ProbabilityOutput['recommendation']
    confidence: ProbabilityOutput['confidence']
  }>({
    provider: extractionProvider ?? provider,
    tier: 'fast',
    maxTokens: romaMode === 'blitz' ? 256 : 512,
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

  const pLLM = Math.max(0, Math.min(1, extracted.pModel))

  // Blend LLM estimate with quantitative prior.
  // Weight of quant anchor increases as time runs out (physics dominates near expiry).
  //   α = 0.15 at 15 min remaining → 0.70 at 0 min remaining (never fully suppresses LLM)
  let pModel = pLLM
  let quantBlendNote = ''
  if (quantResult) {
    const alpha   = Math.max(0.15, Math.min(0.70, 1 - minutesUntilExpiry / 15))
    const pBlended = alpha * quantResult.pQuant + (1 - alpha) * pLLM
    pModel = Math.max(0, Math.min(1, pBlended))
    quantBlendNote = ` | P_quant=${(quantResult.pQuant * 100).toFixed(1)}% (α=${alpha.toFixed(2)}) → blended=${(pBlended * 100).toFixed(1)}%`
  }

  const edge    = pModel - pMarket
  const edgePct = edge * 100

  return {
    agentName: agentLabel,
    status: 'done',
    output: { pModel, pMarket, edge, edgePct, recommendation: extracted.recommendation, confidence: extracted.confidence, provider: pythonResult.provider },
    reasoning: romaTrace + `\n\nP(LLM)=${(pLLM * 100).toFixed(1)}%${quantBlendNote} → P(final)=${(pModel * 100).toFixed(1)}% vs P(market)=${(pMarket * 100).toFixed(1)}% — edge: ${edgePct >= 0 ? '+' : ''}${edgePct.toFixed(1)}%. Rec: ${extracted.recommendation} (${extracted.confidence})`,
    durationMs: Date.now() - start,
    timestamp: new Date().toISOString(),
  }
}
