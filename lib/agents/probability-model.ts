import type { AgentResult, ProbabilityOutput, KalshiMarket, OHLCVCandle, DerivativesSignal } from '../types'
import { llmToolCall, type AIProvider } from '../llm-client'
import { callPythonRoma, formatRomaTrace } from '../roma/python-client'
import { computeQuantSignals, formatQuantBrief, normalCDF } from '../indicators'

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
  liveCandles?: OHLCVCandle[],
  derivatives?: DerivativesSignal,
  orModelOverride?: string,        // override OpenRouter model ID for this call
  signal?: AbortSignal,            // abort signal from the HTTP request
): Promise<AgentResult<ProbabilityOutput>> {
  const start = Date.now()

  const pMarket  = market ? market.yes_ask / 100 : 0.5
  const spread   = market ? (market.yes_ask - market.yes_bid) / 100 : 0.05
  const distSign = distanceFromStrikePct >= 0 ? '+' : ''

  // Reconstruct spot from market price + distance (prob model doesn't receive spot directly)
  const strikePrice = market?.floor_strike ?? 0
  const spotApprox  = strikePrice > 0 ? strikePrice * (1 + distanceFromStrikePct / 100) : 0

  // Pre-compute full quant signal suite — no LLM math burden
  const quant      = computeQuantSignals(candles, liveCandles, null, spotApprox, strikePrice, distanceFromStrikePct, minutesUntilExpiry)
  const quantBrief = formatQuantBrief(quant, spotApprox, distanceFromStrikePct, minutesUntilExpiry)

  // Format derivatives signal
  const derivativesBlock = derivatives ? [
    `Bybit perp funding rate: ${(derivatives.fundingRate * 100).toFixed(4)}%/8h — ${derivatives.fundingRate > 0.0001 ? 'positive (crowded longs → bearish pressure)' : derivatives.fundingRate < -0.0001 ? 'negative (crowded shorts → bullish pressure)' : 'neutral'}`,
    `Basis: ${derivatives.basis >= 0 ? '+' : ''}${derivatives.basis.toFixed(4)}% — ${derivatives.basis > 0.02 ? 'contango (bullish)' : derivatives.basis < -0.02 ? 'backwardation (bearish)' : 'flat'}`,
  ].join('\n') : null

  const context = [
    sentimentScore !== null
      ? `SentimentAgent score: ${sentimentScore.toFixed(4)} (−1=strongly bearish → +1=strongly bullish)`
      : `SentimentAgent score: (running in parallel — use quant signals and market data only)`,
    sentimentSignals?.length
      ? `Key sentiment signals: ${sentimentSignals.join(' | ')}`
      : null,
    `BTC vs strike: ${distSign}${distanceFromStrikePct.toFixed(4)}% — ${distanceFromStrikePct >= 0 ? 'ABOVE' : 'BELOW'} strike`,
    `Minutes until expiry: ${minutesUntilExpiry.toFixed(2)}`,
    `Market-implied P(YES): ${(pMarket * 100).toFixed(1)}¢ — crowd probability BTC ends above strike`,
    `Bid-ask spread: ${(spread * 100).toFixed(1)}¢  |  Min edge to trade: ${((spread + 0.02) * 100).toFixed(1)}¢`,
    `\n${quantBrief}`,
    derivativesBlock,
    ...(candles?.length ? [`\n${formatCandles(candles)}`] : []),
    ...(prevContext ? [`\nPrevious cycle analysis:\n${prevContext}`] : []),
  ].filter(Boolean).join('\n')

  const goal =
    `You are a quantitative trader. Estimate P(BTC > strike) at window close for a Kalshi KXBTC15M binary option. ` +
    `QUANTITATIVE FRAMEWORK — work through this in order: ` +
    `(1) PRICING MODELS: Both Brownian motion and log-normal binary P(YES) are your calibrated priors. ` +
    `They encode volatility + distance + time — do not deviate >15pp without decisive signal evidence. ` +
    `(2) REGIME: Lag-1 autocorrelation tells you whether to extrapolate momentum or expect mean-reversion. ` +
    `In a mean-reverting regime, oversold RSI + lower band %B = bounce expected; trending regime = continuation. ` +
    `(3) LIVE VELOCITY: Price velocity ($/min) and time-to-strike estimate from 1-min candles. ` +
    `If velocity analysis says strike is unreachable in remaining time, weight this heavily. ` +
    `(4) MOMENTUM CONFLUENCE: RSI + MACD histogram + Stochastic %K — require 3-of-4 alignment ` +
    `(RSI, MACD, Stochastic, Bollinger) to override the quantitative prior by >10pp. ` +
    `⚡ CANDLE FLIP ALERT = structural reversal, override all prior trend signals immediately. ` +
    `(5) MICROSTRUCTURE: Pressure-weighted orderbook imbalance signals crowd positioning at the ask. ` +
    `(6) MARKET-IMPLIED: P(market)=${(pMarket * 100).toFixed(1)}% is the Kalshi crowd's estimate. ` +
    `Final recommendation: YES if P(model) > P(market) + min_edge, NO if P(model) < P(market) − min_edge, else NO_TRADE.`

  // Depth controlled by ROMA_MAX_DEPTH env var (default 1). ROMA treats 0 as unlimited — never send 0.
  const maxDepth = Math.max(1, parseInt(process.env.ROMA_MAX_DEPTH ?? '1'))
  const pythonResult = await callPythonRoma(goal, context, maxDepth, 2, romaMode, provider, undefined, orModelOverride, signal)
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

  // Blend LLM estimate with quantitative priors.
  // Weight of quant anchor increases as time runs out (physics dominates near expiry).
  //   α = 0.15 at 15 min remaining → 0.70 at 0 min remaining
  // When both Brownian and log-normal priors are available, average them first.
  let pModel = pLLM
  let quantBlendNote = ''
  const pBrownian = quant.brownianPrior?.pQuant ?? null
  const pLN       = quant.lnBinary?.pYes ?? null
  const pQuantAvg = pBrownian !== null && pLN !== null
    ? (pBrownian + pLN) / 2
    : (pBrownian ?? pLN)
  if (pQuantAvg !== null) {
    const alpha    = Math.max(0.15, Math.min(0.70, 1 - minutesUntilExpiry / 15))
    const pBlended = alpha * pQuantAvg + (1 - alpha) * pLLM
    pModel = Math.max(0, Math.min(1, pBlended))
    quantBlendNote = ` | P_brownian=${pBrownian !== null ? (pBrownian * 100).toFixed(1) + '%' : 'n/a'}` +
      ` P_lnBinary=${pLN !== null ? (pLN * 100).toFixed(1) + '%' : 'n/a'}` +
      ` P_avg=${(pQuantAvg * 100).toFixed(1)}% (α=${alpha.toFixed(2)}) → blended=${(pBlended * 100).toFixed(1)}%`
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
