import type { AgentResult, ProbabilityOutput, KalshiMarket, OHLCVCandle, DerivativesSignal } from '../types'
import { llmToolCall, type AIProvider } from '../llm-client'
import { callPythonRoma, formatRomaTrace } from '../roma/python-client'
import { computeQuantSignals, formatQuantBrief, normalCDF, logOpinionPool } from '../indicators'

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
  providers?: AIProvider[],
  extractionProvider?: AIProvider,  // provider for JSON extraction step (defaults to provider)
  prevContext?: string,
  candles?: OHLCVCandle[],
  liveCandles?: OHLCVCandle[],
  derivatives?: DerivativesSignal,
  orModelOverride?: string,         // override OpenRouter model ID for this call
  signal?: AbortSignal,             // abort signal from the HTTP request
  apiKeys?: Record<string, string>, // per-provider API keys from user settings
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
    (() => {
      const distUSD = Math.abs(distanceFromStrikePct / 100) * spotApprox
      const reqVel  = minutesUntilExpiry > 0 ? distUSD / minutesUntilExpiry : 0
      const curVel  = quant.velocity?.velocityPerMin ?? null
      const toward  = curVel !== null
        ? (distanceFromStrikePct < 0 && curVel > 0) || (distanceFromStrikePct > 0 && curVel < 0)
        : null
      const ratio   = curVel !== null && reqVel > 0 ? Math.abs(curVel) / reqVel : null
      return `REACHABILITY: BTC must move $${distUSD.toFixed(0)} in ${minutesUntilExpiry.toFixed(1)}min — need ±$${reqVel.toFixed(2)}/min` +
        (curVel !== null
          ? ` | current ${curVel >= 0 ? '+' : ''}$${curVel.toFixed(2)}/min (${(ratio! * 100).toFixed(0)}% of needed, moving ${toward ? 'TOWARD' : 'AWAY FROM'} strike)` +
            (!toward || ratio! < 0.4 ? ' — ⛔ STRIKE UNREACHABLE' : ratio! < 0.75 ? ' — ⚠ BELOW PACE' : ' — ✓ ON PACE')
          : ' | velocity unknown')
    })(),
    `Market-implied P(YES): ${(pMarket * 100).toFixed(1)}% — Kalshi crowd (secondary reference only)`,
    `Bid-ask spread: ${(spread * 100).toFixed(1)}¢`,
    `
${quantBrief}`,
    derivativesBlock,
    ...(candles?.length ? [`
${formatCandles(candles)}`] : []),
    ...(prevContext ? [`
Previous cycle analysis:
${prevContext}`] : []),
  ].filter(Boolean).join('\n')

  const goal =
    `Estimate P(BTC closes ABOVE strike at window expiry). Output one number: P(YES) ∈ [0.05, 0.95]. ` +
    `The QUANTITATIVE SIGNALS block has pre-computed calibrated values — DO NOT recompute, synthesize them. ` +
    `\n\nDECISION PROTOCOL (apply in strict order):` +

    `\n\nSTEP 1 — ANCHOR on physics priors:` +
    ` Use Cornish-Fisher P(YES) as your starting estimate (best: uses σ + skew + kurtosis).` +
    ` Fallback chain if unavailable: Fat-tail (Student-t) → Log-normal (GK σ) → Brownian motion.` +
    ` Do not deviate >15pp without clear evidence from steps below.` +

    `\n\nSTEP 2 — REACHABILITY GATE (HARD OVERRIDE — highest priority):` +
    ` CRITICAL ASYMMETRY: The question is NOT "will BTC go up?" — it is "will BTC be ABOVE strike at expiry?"` +
    ` BTC ABOVE strike: YES wins by default unless BTC FALLS to strike. For NO to win, BTC must DROP $${(Math.abs(distanceFromStrikePct / 100) * spotApprox).toFixed(0)} in ${minutesUntilExpiry.toFixed(1)}min.` +
    ` BTC BELOW strike: YES wins only if BTC RISES to strike. For YES to win, BTC must CLIMB $${(Math.abs(distanceFromStrikePct / 100) * spotApprox).toFixed(0)} in ${minutesUntilExpiry.toFixed(1)}min.` +
    ` Check REACHABILITY block. If "⛔ STRIKE UNREACHABLE" or velocity < 55% of required:` +
    `   BTC BELOW strike → P(YES) = 0.05–0.18 (can't reach). BTC ABOVE strike → P(YES) = 0.82–0.95 (can't fall far enough).` +
    ` BEARISH SIGNALS DON'T OVERRIDE THIS: if BTC is $300 above strike, even a -0.8 bearish sentiment` +
    ` score is irrelevant unless velocity analysis shows BTC can actually fall $300 in the time remaining.` +
    ` This gate overrides ALL other signals — physics cannot be wished away.` +

    `\n\nSTEP 3 — JUMP / STRUCTURAL BREAK:` +
    ` If "⚡ CUSUM JUMP ALERT" appears OR BiPower JR > 0.3:` +
    `   Diffusion models (Brownian/LN) are unreliable. Shift 25pp in jump direction.` +
    `   Discount physics priors 40% — trust velocity + recent candle momentum instead.` +
    `   ⚡ CANDLE FLIP ALERT = highest-conviction reversal signal, override prior trend immediately.` +

    `\n\nSTEP 4 — REGIME (±5pp):` +
    ` Trending (H>0.6 or autocorr>0.15): push 5pp in current momentum direction.` +
    ` Mean-reverting (H<0.4 or autocorr<-0.15): fade extremes, pull 3pp toward 50%.` +

    `\n\nSTEP 5 — MOMENTUM CONFLUENCE (±15pp total budget):` +
    ` Score each indicator: RSI>55=YES, RSI<45=NO; MACD hist>0=YES; Bollinger %B>0.55=YES; Stoch>55=YES.` +
    ` 4 YES → +12pp | 3 YES → +6pp | 2 YES → 0pp | 1 YES → -6pp | 0 YES → -12pp.` +

    `\n\nSTEP 6 — ORDERBOOK MICROSTRUCTURE (±5pp):` +
    ` Pressure-weighted imbalance >+20% → +4pp. <-20% → -4pp.` +

    `\n\nOUTPUT: Start at Cornish-Fisher anchor. Apply gates (override) then adjustments (modify).` +
    ` Clamp to [0.05, 0.95]. Recommendation is automatic: P≥0.50 → YES, P<0.50 → NO.` +
    ` Time remaining: ${minutesUntilExpiry.toFixed(1)}min. BTC is ${distanceFromStrikePct >= 0 ? 'ABOVE' : 'BELOW'} strike by ${Math.abs(distanceFromStrikePct).toFixed(3)}%.`

  // Depth controlled by ROMA_MAX_DEPTH env var (default 1). ROMA treats 0 as unlimited — never send 0.
  const maxDepth = 1
  const pythonResult = await callPythonRoma(goal, context, maxDepth, 4, romaMode, provider, providers, orModelOverride, signal, apiKeys)
  const romaAnswer = pythonResult.answer
  const agentLabel = `ProbabilityModelAgent (roma-dspy · ${pythonResult.provider})`
  const romaTrace  = formatRomaTrace(pythonResult)

  // Use fast tier for extraction — always on the primary provider (grok), never on the
  // split provider2, since smaller HF models can't reliably produce tool-call JSON.
  const extracted = await llmToolCall<{
    pModel: number
    confidence: ProbabilityOutput['confidence']
  }>({
    provider: extractionProvider ?? provider,
    tier: 'fast',
    maxTokens: romaMode === 'blitz' ? 256 : 512,
    toolName: 'extract_probability',
    toolDescription: 'Extract probability estimate from ROMA analysis',
    schema: {
      properties: {
        pModel:     { type: 'number', description: 'Estimated P(YES) 0.0–1.0 that BTC ends above strike at window close' },
        confidence: { type: 'string', enum: ['high', 'medium', 'low'], description: 'Confidence in the probability estimate based on signal alignment' },
      },
      required: ['pModel', 'confidence'],
    },
    prompt: `Extract the probability estimate from this ROMA analysis. Return ONLY pModel (P(BTC > strike)) and confidence.

${romaAnswer}`,
  })

  const pLLM = Math.max(0, Math.min(1, extracted.pModel))

  // ── Quantitative prior combination via Logarithmic Opinion Pool ──────────────
  // Three independent quant estimates of P(YES):
  //   pBrownian — mean absolute return, no-drift Brownian motion
  //   pLN       — log-normal binary (Black-Scholes digital) with normal CDF
  //   pFatTail  — log-normal binary with Student-t(ν=4) CDF [preferred: heavier BTC tails]
  //
  // LOP is used instead of linear average: p_lop ∝ p1^w1 × p2^w2
  // This preserves forecast sharpness — linear averages regress probabilities toward 0.5.
  // ── Hard time-distance gate ───────────────────────────────────────────────
  // When BTC must cover a large distance but velocity is insufficient, clamp the LLM's
  // P(YES) estimate before blending — prevents narrative overriding physics.
  // Applies in both directions:
  //   BTC below strike: caps P(YES) down — can't reach strike = NO wins
  //   BTC above strike: floors P(YES) up — can't fall to strike = YES wins
  let pLLMGated = pLLM
  if (minutesUntilExpiry > 0 && spotApprox > 0) {
    const distUSD    = Math.abs(distanceFromStrikePct / 100) * spotApprox
    const reqVel     = distUSD / minutesUntilExpiry   // $/min needed to cross strike
    // Gate window scales with distance: larger gap → check further out
    const gateWindow = Math.max(8, Math.min(13, distUSD / 20))  // ~8–13 min
    if (minutesUntilExpiry <= gateWindow && quant.velocity) {
      const curVel       = quant.velocity.velocityPerMin
      const movingToward = (distanceFromStrikePct < 0 && curVel > 0) || (distanceFromStrikePct > 0 && curVel < 0)
      const velRatio     = reqVel > 0 ? Math.abs(curVel) / reqVel : 0
      // Trigger gate: not heading toward strike, OR pace is < 55% of what's needed
      if (!movingToward || velRatio < 0.55) {
        pLLMGated = distanceFromStrikePct < 0
          ? Math.min(pLLM, 0.20)  // BTC below strike, can't recover → cap P(YES)
          : Math.max(pLLM, 0.80)  // BTC above strike, can't fall far enough → floor P(YES)
      }
    } else if (minutesUntilExpiry <= gateWindow && !quant.velocity) {
      // No velocity data — use physics model directly (no LLM override needed)
      // but still clamp extreme LLM estimates when distance is large
      if (distUSD > 200 && minutesUntilExpiry < 5) {
        pLLMGated = distanceFromStrikePct < 0
          ? Math.min(pLLM, 0.25)
          : Math.max(pLLM, 0.75)
      }
    }
  }

  let pModel = pLLMGated
  let quantBlendNote = ''
  const pBrownian = quant.brownianPrior?.pQuant ?? null
  const pLN       = quant.lnBinary?.pYes ?? null
  const pFatTail  = quant.fatTailBinary?.pYesFat ?? null
  const pSkewAdj  = quant.skewAdjBinary?.pYesSkewAdj ?? null
  const pOB       = quant.obImpliedProb ?? null

  // Physics priors — priority: Cornish-Fisher (skew+kurt+σ) > fat-tail (dynamic ν+σ) > LN (σ only) > Brownian
  const pPhysicsCombined =
    pSkewAdj  !== null && pFatTail  !== null ? logOpinionPool(pSkewAdj, pFatTail,   0.50, 0.50) :
    pSkewAdj  !== null && pBrownian !== null ? logOpinionPool(pSkewAdj, pBrownian,  0.55, 0.45) :
    pBrownian !== null && pFatTail  !== null ? logOpinionPool(pBrownian, pFatTail,  0.45, 0.55) :
    pBrownian !== null && pLN       !== null ? logOpinionPool(pBrownian, pLN,       0.50, 0.50) :
    (pSkewAdj ?? pFatTail ?? pBrownian ?? pLN)

  // Blend in orderbook crowd signal at low weight (15%) — orthogonal auxiliary input
  const pQuantCombined = pPhysicsCombined !== null && pOB !== null
    ? logOpinionPool(pPhysicsCombined, pOB, 0.85, 0.15)
    : pPhysicsCombined

  if (pQuantCombined !== null) {
    // ── Time-based quant weight (physics dominates near expiry) ──────────────
    // Cap raised to 0.85: near expiry the math is more reliable than LLM narrative
    let alpha = Math.max(0.15, Math.min(0.85, 1 - minutesUntilExpiry / 15))

    // ── Hurst: long-memory regime modulates quant vs LLM trust ───────────────
    const hurst = quant.hurstExponent
    let hurstNote = ''
    if (hurst !== null) {
      if      (hurst > 0.6) { alpha = Math.max(0.10, alpha - 0.08); hurstNote = ` H=${hurst.toFixed(3)}(persist↓α)` }
      else if (hurst < 0.4) { alpha = Math.min(0.80, alpha + 0.08); hurstNote = ` H=${hurst.toFixed(3)}(mrv↑α)`    }
      else                  {                                         hurstNote = ` H=${hurst.toFixed(3)}(rw)`       }
    }

    // ── Vol-of-Vol: unstable vol → less reliable quant models ────────────────
    let vovNote = ''
    const vov = quant.volOfVol
    if (vov !== null && vov > 1.0) {
      alpha = Math.max(0.08, alpha - 0.08)
      vovNote = ` VoV=${vov.toFixed(2)}(unstable↓α)`
    }

    // ── CUSUM: structural break invalidates diffusion models ──────────────────
    let cusumNote = ''
    if (quant.cusum?.jumpDetected) {
      alpha = Math.max(0.08, alpha - 0.12)
      cusumNote = ` JUMP(${quant.cusum.direction}↓α)`
    }

    // ── Final blend: LLM^(1-α) × Quant^α via Log Opinion Pool ───────────────
    const pBlended = logOpinionPool(pLLMGated, pQuantCombined, 1 - alpha, alpha)
    pModel = Math.max(0, Math.min(1, pBlended))

    const gateNote = pLLMGated !== pLLM ? ` LLM_gated=${(pLLMGated * 100).toFixed(1)}%` : ''
    quantBlendNote =
      ` | P_CF=${pSkewAdj !== null ? (pSkewAdj * 100).toFixed(1) + '%' : 'n/a'}` +
      ` P_fatTail=${pFatTail !== null ? (pFatTail * 100).toFixed(1) + '%' + (pFatTail
        ? ` ν=${quant.fatTailBinary?.nu.toFixed(1)}` : '') : 'n/a'}` +
      ` P_brownian=${pBrownian !== null ? (pBrownian * 100).toFixed(1) + '%' : 'n/a'}` +
      (pOB !== null ? ` P_OB=${(pOB * 100).toFixed(1)}%` : '') +
      ` P_quant=${(pQuantCombined * 100).toFixed(1)}%(LOP)` +
      ` α=${alpha.toFixed(2)}${hurstNote}${vovNote}${cusumNote}${gateNote}` +
      ` → P_blend=${(pBlended * 100).toFixed(1)}%`
  }

  // Recommendation is purely directional: P(model) ≥ 50% = YES (BTC ends above strike), else NO.
  // Edge vs market is secondary — it informs confidence and sizing, not direction.
  const recommendation: ProbabilityOutput['recommendation'] = pModel >= 0.5 ? 'YES' : 'NO'

  // Edge = how favorable is the RECOMMENDED trade?
  //   rec=YES: pModel > pMarket → positive = YES underpriced → buy YES is +EV
  //   rec=NO:  pMarket > pModel → positive = NO underpriced (market overprices YES) → buy NO is +EV
  const edge    = recommendation === 'YES' ? pModel - pMarket : pMarket - pModel
  const edgePct = edge * 100

  return {
    agentName: agentLabel,
    status: 'done',
    output: {
      pModel, pMarket, edge, edgePct,
      recommendation,
      confidence:     extracted.confidence,
      provider:       pythonResult.provider,
      gkVol15m:       quant.gkVol15m,
    },
    reasoning: romaTrace + `

P(LLM)=${(pLLM * 100).toFixed(1)}%${quantBlendNote} → P(final)=${(pModel * 100).toFixed(1)}% vs P(market)=${(pMarket * 100).toFixed(1)}% — edge: ${edgePct >= 0 ? '+' : ''}${edgePct.toFixed(1)}%. Rec: ${recommendation} (${extracted.confidence}) [direction from P≥50%]`,
    durationMs: Date.now() - start,
    timestamp: new Date().toISOString(),
  }
}
