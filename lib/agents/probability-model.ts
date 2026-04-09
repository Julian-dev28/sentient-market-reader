import type { AgentResult, ProbabilityOutput, KalshiMarket, OHLCVCandle, DerivativesSignal } from '../types'
import type { AIProvider } from '../llm-client'
import { computeQuantSignals, formatQuantBrief } from '../indicators'

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

  const pMarket = market ? market.yes_ask / 100 : 0.5
  const noAsk   = market ? market.no_ask  / 100 : 0.5  // cost of NO — used for NO edge

  // Reconstruct spot from market price + distance (prob model doesn't receive spot directly)
  const strikePrice = market?.floor_strike ?? 0
  const spotApprox  = strikePrice > 0 ? strikePrice * (1 + distanceFromStrikePct / 100) : 0

  // Pre-compute quant signal suite
  const quant      = computeQuantSignals(candles, liveCandles, null, spotApprox, strikePrice, distanceFromStrikePct, minutesUntilExpiry)
  const quantBrief = formatQuantBrief(quant, spotApprox, distanceFromStrikePct, minutesUntilExpiry)

  // ── Pure quant model — no LLM call ───────────────────────────────────────────
  // Strategy: Brownian motion physics anchor + direction lock + hard reachability gate.
  // Empirical validation (2,690 live fills + 787-trade backtest):
  //   - RSI/MACD/Hurst momentum adjustments are NOISE (MACD opposed = +9.5pp vs aligned = +6.2pp)
  //   - Edge exists ONLY in d ∈ [1.0, 1.2]: +5.5pp live margin (Z=2.33, p<0.01)
  //   - d < 1.0: Kalshi correct-prices, no alpha. d > 1.2: Kalshi overprices fat-tail reversal.
  //   - Removing momentum adjustments cut MaxDD 22.9% → 13.3% with +0.8pp WR gain.
  const agentLabel = 'ProbabilityModelAgent (quant)'

  void quantBrief  // computed but available in reasoning string below

  // ── Logarithmic Opinion Pool of physics priors ────────────────────────────
  const pBrownian = quant.brownianPrior?.pQuant ?? null
  const pLN       = quant.lnBinary?.pYes ?? null
  const pFatTail  = quant.fatTailBinary?.pYesFat ?? null
  const pSkewAdj  = quant.skewAdjBinary?.pYesSkewAdj ?? null
  const pOB       = quant.obImpliedProb ?? null

  // ── D-score gate (empirically calibrated from 2,690 live trades) ───────────
  // Live data + backtest analysis (2,690 real fills):
  //   |d| < 1.0  → Kalshi correctly prices; no alpha (-4pp to -15pp margin)
  //   |d| 1.0-1.2 → ONLY real edge zone: +5.5pp margin, 87.4% wr on real fills
  //   |d| 1.2-1.5 → Kalshi overprices fat-tail reversal risk: -1.1pp margin (lose after fees)
  //   |d| > 1.5  → Worse: -3.9pp margin
  // Entry window: 3-9 min left only. 9-12min = 69.5% wr (reversal risk); 3-9min = 95.7% wr.
  // d formula: log(spot/strike) / (σ_15m × √(T_candles))
  const D_MIN_THRESHOLD = 1.0
  const D_MAX_THRESHOLD = 1.2
  const dScore = (spotApprox > 0 && strikePrice > 0 && quant.gkVol15m && quant.gkVol15m > 0 && minutesUntilExpiry > 0)
    ? Math.log(spotApprox / strikePrice) / (quant.gkVol15m * Math.sqrt(minutesUntilExpiry / 15))
    : null
  const dAbs = dScore !== null ? Math.abs(dScore) : null

  if (dAbs !== null && (dAbs < D_MIN_THRESHOLD || dAbs > D_MAX_THRESHOLD)) {
    const reason = dAbs < D_MIN_THRESHOLD
      ? `|d|=${dAbs.toFixed(3)} < ${D_MIN_THRESHOLD} — Kalshi correctly prices near-strike; no alpha`
      : `|d|=${dAbs.toFixed(3)} > ${D_MAX_THRESHOLD} — BTC only ${(Math.abs(distanceFromStrikePct)).toFixed(3)}% from strike with ${minutesUntilExpiry.toFixed(1)}min left; Brownian model overstates edge, Kalshi prices fat-tail reversal risk`
    return {
      agentName: agentLabel,
      status: 'done',
      output: {
        pModel: pMarket,   // outside edge zone: best estimate IS the market price (Kalshi correct-prices this)
        pMarket,
        edge: 0,
        edgePct: 0,
        recommendation: 'NO_TRADE' as const,
        confidence: 'low' as const,
        provider: 'quant',
        gkVol15m: quant.gkVol15m,
        volOfVol: quant.volOfVol,
        dScore,
      },
      reasoning: `NO_TRADE: d=${dScore!.toFixed(3)} — ${reason}. ` +
        `Edge zone confirmed by 2,690-trade empirical analysis: |d|∈[1.0,1.2] only (3-9min window).`,
      durationMs: Date.now() - start,
      timestamp: new Date().toISOString(),
    }
  }

  // ── Pure Brownian reachability model ─────────────────────────────────────
  // The answer to "will BTC be above strike at expiry?" is one formula:
  //   d = (BTC - strike) / (σ × √T)   →   P(YES) = Φ(d)
  // σ and T are already baked into pBrownian via computeBrownianPrior.
  // If BTC is far from strike relative to remaining vol × time, P → 0 or 1.
  // Five price oscillations don't change d enough to matter — commit to the analysis.
  // We keep pSkewAdj (Cornish-Fisher) as the sole fallback since it shares the same
  // reachability logic with skew/kurtosis corrections.
  const pQuantCombined = pBrownian ?? pSkewAdj ?? pFatTail ?? pLN

  let pModel = pQuantCombined ?? 0.5

  // ── Hard reachability gate (physics cannot be wished away) ────────────────
  let gateNote = ''
  if (minutesUntilExpiry > 0 && spotApprox > 0) {
    const distUSD    = Math.abs(distanceFromStrikePct / 100) * spotApprox
    const reqVel     = distUSD / minutesUntilExpiry
    const gateWindow = Math.max(8, Math.min(13, distUSD / 20))
    if (minutesUntilExpiry <= gateWindow && quant.velocity) {
      const curVel       = quant.velocity.velocityPerMin
      const movingToward = (distanceFromStrikePct < 0 && curVel > 0) || (distanceFromStrikePct > 0 && curVel < 0)
      const velRatio     = reqVel > 0 ? Math.abs(curVel) / reqVel : 0
      if (!movingToward || velRatio < 0.55) {
        const gated = distanceFromStrikePct < 0
          ? Math.min(pModel, 0.20)
          : Math.max(pModel, 0.80)
        gateNote = ` GATE(vel=${curVel.toFixed(2)}/min,ratio=${(velRatio * 100).toFixed(0)}%->${(gated * 100).toFixed(1)}%)`
        pModel = gated
      }
    } else if (minutesUntilExpiry <= gateWindow && !quant.velocity) {
      if (distUSD > 200 && minutesUntilExpiry < 5) {
        const gated = distanceFromStrikePct < 0
          ? Math.min(pModel, 0.25)
          : Math.max(pModel, 0.75)
        gateNote = ` GATE(no-vel,dist=$${distUSD.toFixed(0)}->${(gated * 100).toFixed(1)}%)`
        pModel = gated
      }
    }
  }

  pModel = Math.max(0.05, Math.min(0.95, pModel))

  // ── DIRECTION LOCK: always bet the side BTC currently sits on ─────────────
  // Brownian motion: wherever BTC is now is the best predictor of where it closes.
  // Never bet against the current position — that just adds reversal noise.
  // The quant model sets confidence (magnitude), current position sets direction.
  const aboveStrike = distanceFromStrikePct >= 0
  if (aboveStrike && pModel < 0.5) pModel = 1 - pModel   // flip to YES
  if (!aboveStrike && pModel > 0.5) pModel = 1 - pModel  // flip to NO
  pModel = Math.max(0.05, Math.min(0.95, pModel))

  // ── NO MOMENTUM/REGIME ADJUSTMENTS ──────────────────────────────────────────
  // Empirical analysis of 787 backtest trades shows RSI/MACD/Hurst/VoV adjustments
  // add NOISE, not signal. Specifically: MACD opposed to our bet = +9.5pp margin
  // vs MACD aligned = +6.2pp. The adjustments were directionally incorrect.
  // The d-gate + direction lock + Brownian anchor is the complete model.
  // Signals retained for reasoning display only — not used in sizing.
  const hurst = quant.hurstExponent
  const vov   = quant.volOfVol

  const hurstNote  = hurst !== null ? ` H=${hurst.toFixed(3)}` : ''
  const vovNote    = vov !== null && vov > 1.0 ? ` VoV=${vov.toFixed(2)}` : ''
  const cusumNote  = quant.cusum?.jumpDetected ? ` JUMP(${quant.cusum.direction})` : ''

  const quantBlendNote = pQuantCombined !== null
    ? ` | P_brow=${pBrownian !== null ? (pBrownian * 100).toFixed(1) + '%' : 'n/a'}` +
      ` P_CF=${pSkewAdj !== null ? (pSkewAdj * 100).toFixed(1) + '%' : 'n/a'}` +
      ` d=${dScore !== null ? dScore.toFixed(3) : distanceFromStrikePct >= 0 ? '+' : ''}${dScore === null ? distanceFromStrikePct.toFixed(3) + '%' : ''}` +
      ` σ=${quant.gkVol15m !== null ? (quant.gkVol15m * 100).toFixed(3) + '%/15m' : 'n/a'}` +
      ` T=${minutesUntilExpiry.toFixed(1)}min` +
      hurstNote + vovNote + cusumNote + gateNote +
      ` DIR_LOCK(${aboveStrike ? 'YES' : 'NO'})`
    : ''

  // Direction is locked to current BTC position — recommendation always matches
  const recommendation: ProbabilityOutput['recommendation'] = aboveStrike ? 'YES' : 'NO'
  // Edge = after-fee EV per dollar risked.
  // Maker fee formula: 0.0175 × P × (1-P) per contract (pre-ceiling approx).
  const entryPrice = recommendation === 'YES' ? pMarket : noAsk   // price we'd pay (0-1)
  const feePerC    = 0.0175 * entryPrice * (1 - entryPrice)
  const pWin       = recommendation === 'YES' ? pModel : (1 - pModel)
  const netWin     = (1 - entryPrice) - feePerC
  const netLoss    = -entryPrice - feePerC
  const edge       = pWin * netWin + (1 - pWin) * netLoss   // EV per contract
  const edgePct    = edge * 100
  const edgeAbs = Math.abs(pModel - 0.5)
  const confidence: ProbabilityOutput['confidence'] = edgeAbs >= 0.15 ? 'high' : edgeAbs >= 0.07 ? 'medium' : 'low'

  return {
    agentName: agentLabel,
    status: 'done',
    output: {
      pModel, pMarket, edge, edgePct,
      recommendation,
      confidence,
      provider: 'quant',
      gkVol15m: quant.gkVol15m,
      volOfVol: quant.volOfVol,
      dScore,
    },
    reasoning: 'Quant-only probability model' + quantBlendNote + '\n\nP(final)=' + (pModel * 100).toFixed(1) + '% vs P(market)=' + (pMarket * 100).toFixed(1) + '% — edge: ' + (edgePct >= 0 ? '+' : '') + edgePct.toFixed(1) + '%. Rec: ' + recommendation + ' (' + confidence + ')',
    durationMs: Date.now() - start,
    timestamp: new Date().toISOString(),
  }
}
