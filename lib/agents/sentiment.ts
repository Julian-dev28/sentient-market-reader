import type { AgentResult, SentimentOutput, BTCQuote, KalshiMarket, KalshiOrderbook, OHLCVCandle, DerivativesSignal } from '../types'
import { llmToolCall, type AIProvider } from '../llm-client'
import { callPythonRoma, formatRomaTrace } from '../roma/python-client'
import { computeQuantSignals, formatQuantBrief } from '../indicators'

/** Format last N 15-min candles as a compact context block for the LLM.
 *  Input: newest-first [ts, low, high, open, close, volume]
 *  Output: oldest-first table + candle flip/streak alert at the top.
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
      // Count the prior streak that just reversed
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

export async function runSentiment(
  quote: BTCQuote,
  strikePrice: number,
  distanceFromStrikePct: number,
  minutesUntilExpiry: number,
  market: KalshiMarket | null,
  orderbook: KalshiOrderbook | null,
  provider: AIProvider,
  romaMode?: string,
  providers?: AIProvider[],  // multi-provider parallel solve
  prevContext?: string,
  candles?: OHLCVCandle[],       // last 12 completed 15-min candles
  liveCandles?: OHLCVCandle[],   // last 16 × 1-min candles (live window)
  derivatives?: DerivativesSignal, // perp funding rate + basis
  extractionProvider?: AIProvider, // provider for JSON extraction step (defaults to provider)
  orModelOverride?: string,        // override OpenRouter model ID for this call
  signal?: AbortSignal,            // abort signal from the HTTP request
  apiKeys?: Record<string, string>, // per-provider API keys from user settings
): Promise<AgentResult<SentimentOutput>> {
  const start = Date.now()

  const distSign = distanceFromStrikePct >= 0 ? '+' : ''

  // Format 1-min live candles — show the current window at 1-min resolution
  const liveCandleBlock = (() => {
    if (!liveCandles?.length) return null
    const ordered = [...liveCandles].reverse() // oldest first
    const lines = ordered.map((c, i) => {
      const [, , , open, close, vol] = c
      const chg    = close - open
      const chgPct = ((chg / open) * 100).toFixed(3)
      const dir    = chg >= 0 ? '▲' : '▼'
      const minsAgo = liveCandles.length - i
      return `  [−${String(minsAgo).padStart(2)}m]  O:${open.toFixed(0)}  C:${close.toFixed(0)}  Vol:${vol.toFixed(1)}  ${dir}${chgPct}%`
    })
    const latest = liveCandles[0]
    const liveDir = latest[4] >= latest[3] ? 'BULLISH' : 'BEARISH'
    return `Live window (1-min candles, last ${liveCandles.length} bars, oldest → newest) — current direction: ${liveDir}:\n${lines.join('\n')}`
  })()

  // Format derivatives signal
  const derivativesBlock = derivatives ? [
    `Bybit BTC perp funding rate: ${(derivatives.fundingRate * 100).toFixed(4)}% per 8h — ${derivatives.fundingRate > 0.0001 ? 'positive (longs paying → short-term bearish pressure)' : derivatives.fundingRate < -0.0001 ? 'negative (shorts paying → short-term bullish pressure)' : 'near-zero (balanced positioning)'}`,
    `Basis (perp mark vs spot index): ${derivatives.basis >= 0 ? '+' : ''}${derivatives.basis.toFixed(4)}% — ${derivatives.basis > 0.02 ? 'contango (futures premium → bullish)' : derivatives.basis < -0.02 ? 'backwardation (futures discount → bearish)' : 'flat (no meaningful futures bias)'}`,
  ].join('\n') : null

  // Pre-compute quantitative signals — deterministic math done before the LLM call
  const quant     = computeQuantSignals(candles, liveCandles, orderbook, quote.price, strikePrice, distanceFromStrikePct, minutesUntilExpiry)
  const quantBrief = formatQuantBrief(quant, quote.price, distanceFromStrikePct, minutesUntilExpiry)

  const distUSD = Math.abs(distanceFromStrikePct / 100) * quote.price
  const reqVel  = minutesUntilExpiry > 0 ? distUSD / minutesUntilExpiry : 0
  const goal =
    `You are a BTC market direction specialist. One question: does evidence favor BTC closing ABOVE or BELOW $${strikePrice.toFixed(0)} in ${minutesUntilExpiry.toFixed(1)}min? ` +

    `YOUR ROLE IS DISTINCT FROM THE QUANT MODEL — do not re-estimate Brownian/log-normal probabilities (that's handled separately). ` +
    `Your job: assess MOMENTUM QUALITY, ORDER FLOW, and MARKET NARRATIVE. ` +

    `\n\nPRIORITY HIERARCHY (strict order):` +

    `\n[1] ⚡ CANDLE FLIP ALERT — if present, this is the single highest-conviction signal. Immediately override all prior trend bias. ` +
    `A RED→GREEN flip = potential reversal to bullish; GREEN→RED = potential reversal to bearish.` +

    `\n[2] REACHABILITY — ASYMMETRIC LOGIC:` +
    ` BTC is currently ${distanceFromStrikePct >= 0 ? 'ABOVE' : 'BELOW'} strike by $${distUSD.toFixed(0)}.` +
    (distanceFromStrikePct >= 0
      ? ` YES wins UNLESS BTC falls $${distUSD.toFixed(0)} in ${minutesUntilExpiry.toFixed(1)}min (need -$${reqVel.toFixed(2)}/min downward). Bearish momentum only matters if it's fast enough to cover this gap.`
      : ` YES wins ONLY IF BTC rises $${distUSD.toFixed(0)} in ${minutesUntilExpiry.toFixed(1)}min (need +$${reqVel.toFixed(2)}/min upward).`) +
    ` Check STRIKE REACHABILITY block: ⛔ UNREACHABLE = strong conviction, ✓ ON PACE = directional signals matter more.` +

    `\n[3] LIVE VELOCITY + ACCELERATION — what is price doing right now? ` +
    `Accelerating toward strike = rising conviction. Decelerating = deteriorating setup.` +

    `\n[4] VOLUME CONFIRMATION (OBV + MFI) — OBV rising on up move = smart money confirming. ` +
    `MFI >80 = overbought with volume = bearish pressure likely. MFI <20 = oversold with volume = bullish. ` +
    `OBV diverging from price = warning sign (price move not backed by volume).` +

    `\n[5] MOMENTUM QUALITY — Efficiency Ratio >0.6 = strong trend (trust directional signals). ` +
    `ER <0.3 = choppy/random (fade extremes, don't extrapolate). ` +
    `RSI divergence: bullish div = price down, RSI up = hidden buying. Bearish div = hidden selling. ` +
    `MACD acceleration (slope): positive = momentum building, negative = momentum dying. ` +
    `3–4 oscillators (RSI/MACD/Bollinger/Stochastic) aligned = strong confirmation.` +

    `\n[6] RANGE POSITION + MEAN REVERSION — Donchian(12): price at >92% of range = resistance/breakout zone. ` +
    `Price Z-score >2σ = statistically extreme, mean reversion pressure increases. ` +
    `1-min candle patterns: hammer=bullish reversal, shooting star=bearish reversal, doji=indecision.` +

    `\n[7] REGIME — trending (H>0.6, autocorr>0.15): momentum likely continues. ` +
    `Mean-reverting (H<0.4, autocorr<-0.15): overbought/oversold extremes tend to snap back.` +

    `\n[8] DERIVATIVES — funding rate >+0.01%: crowded longs = short-term bearish pressure. ` +
    `Negative funding: short squeeze risk = bullish. Basis contango: mild bullish bias.` +

    `\n\nOUTPUT: conviction score −1.0 to +1.0 (negative=NO wins, positive=YES wins). ` +
    `|score|>0.6 = strong conviction. |score| 0.3–0.6 = moderate. <0.3 = unclear/neutral. ` +
    `Do NOT output a probability — output directional conviction. Be decisive.`

  const context = [
    `BTC price: $${quote.price.toLocaleString('en-US', { maximumFractionDigits: 2 })}`,
    `Strike price: $${strikePrice.toLocaleString('en-US', { maximumFractionDigits: 2 })}`,
    `BTC vs strike: ${distSign}${distanceFromStrikePct.toFixed(4)}% — BTC is ${distanceFromStrikePct >= 0 ? 'ABOVE' : 'BELOW'} strike by $${distUSD.toFixed(0)}`,
    `Minutes to window close: ${minutesUntilExpiry.toFixed(2)} | Required velocity: ±$${reqVel.toFixed(2)}/min to reach strike`,
    `1h change: ${quote.percent_change_1h >= 0 ? '+' : ''}${quote.percent_change_1h.toFixed(4)}%`,
    `24h change: ${quote.percent_change_24h >= 0 ? '+' : ''}${quote.percent_change_24h.toFixed(4)}%`,
    market
      ? `Kalshi market: YES ask=${market.yes_ask}¢ bid=${market.yes_bid}¢ | NO ask=${market.no_ask}¢ | spread=${market.yes_ask - market.yes_bid}¢`
      : 'No active Kalshi market',
    `
${quantBrief}`,
    derivativesBlock,
    ...(liveCandles?.length && liveCandleBlock ? [`
${liveCandleBlock}`] : []),
    ...(candles?.length ? [`
${formatCandles(candles)}`] : []),
    ...(prevContext ? [`
Previous cycle analysis:
${prevContext}`] : []),
  ].filter(Boolean).join('\n')


  // ── Rule-based quant sentiment — no LLM call ─────────────────────────────
  // Derives directional score from pre-computed quant signals.
  // LLM-based sentiment was adding noise vs pure quant; this is deterministic.
  let score = 0
  const signals: string[] = []

  // 1. Distance / reachability bias
  if (distanceFromStrikePct > 0.05)       { score += 0.15; signals.push('BTC above strike') }
  else if (distanceFromStrikePct < -0.05) { score -= 0.15; signals.push('BTC below strike') }

  // 2. RSI
  const rsiVal = quant.rsi
  if (rsiVal !== null) {
    if      (rsiVal > 60) { score += 0.20; signals.push('RSI ' + rsiVal.toFixed(0) + ' bullish') }
    else if (rsiVal < 40) { score -= 0.20; signals.push('RSI ' + rsiVal.toFixed(0) + ' bearish') }
  }

  // 3. MACD histogram + slope
  if (quant.macd) {
    if (quant.macd.histogram > 0) { score += 0.15; signals.push('MACD bullish') }
    else                          { score -= 0.15; signals.push('MACD bearish') }
  }
  if (quant.macdSlope !== null) {
    score += quant.macdSlope > 0 ? 0.05 : -0.05
  }

  // 4. Bollinger %B
  if (quant.bollingerB) {
    const pctB = quant.bollingerB.pctB
    if      (pctB > 0.7) { score += 0.10; signals.push('Bollinger high') }
    else if (pctB < 0.3) { score -= 0.10; signals.push('Bollinger low') }
  }

  // 5. Stochastic
  if (quant.stochastic !== null) {
    if      (quant.stochastic > 70) { score += 0.10; signals.push('Stoch overbought bullish') }
    else if (quant.stochastic < 30) { score -= 0.10; signals.push('Stoch oversold bearish') }
  }

  // 6. Velocity (toward strike = bearish for holder)
  if (quant.velocity) {
    const vel = quant.velocity.velocityPerMin
    const towardStrike = (distanceFromStrikePct > 0 && vel < 0) || (distanceFromStrikePct < 0 && vel > 0)
    if (towardStrike)        { score -= 0.15; signals.push('Price moving toward strike') }
    else if (Math.abs(vel) > 0) { score += 0.10; signals.push('Price moving away from strike') }
  }

  // 7. Micro momentum (1-min candles)
  if (quant.microMomentum) {
    const gf = quant.microMomentum.greenFraction
    if      (gf > 0.65) { score += 0.15; signals.push('1-min momentum bullish') }
    else if (gf < 0.35) { score -= 0.15; signals.push('1-min momentum bearish') }
  }

  // 8. OBV trend
  if (quant.obv) {
    if      (quant.obv.trend === 'rising')  { score += 0.10; signals.push('OBV rising') }
    else if (quant.obv.trend === 'falling') { score -= 0.10; signals.push('OBV falling') }
  }

  // 9. MFI extremes
  if (quant.mfi !== null) {
    if      (quant.mfi > 80) { score -= 0.10; signals.push('MFI overbought') }
    else if (quant.mfi < 20) { score += 0.10; signals.push('MFI oversold bullish') }
  }

  // 10. CUSUM jump (highest-weight — regime shift)
  if (quant.cusum?.jumpDetected) {
    const jumpScore = quant.cusum.direction === 'up' ? 0.30 : -0.30
    score += jumpScore
    signals.push('CUSUM jump ' + quant.cusum.direction)
  }

  // 11. RSI divergence
  if (quant.rsiDivergence && quant.rsiDivergence.type !== 'none') {
    if      (quant.rsiDivergence.type === 'bullish') { score += 0.15; signals.push('RSI bullish divergence') }
    else if (quant.rsiDivergence.type === 'bearish') { score -= 0.15; signals.push('RSI bearish divergence') }
  }

  // 12. Kalshi orderbook imbalance (pressure-weighted YES vs NO depth)
  if (quant.obImbalance) {
    const pw = quant.obImbalance.pressureWeighted
    if      (pw >  0.30) { score += 0.15; signals.push('OB strong YES pressure') }
    else if (pw >  0.12) { score += 0.08; signals.push('OB mild YES pressure') }
    else if (pw < -0.30) { score -= 0.15; signals.push('OB strong NO pressure') }
    else if (pw < -0.12) { score -= 0.08; signals.push('OB mild NO pressure') }
    else                 { signals.push('OB balanced') }
  }

  // 13. Efficiency ratio — dampen signals in choppy market
  if (quant.efficiencyRatio !== null && quant.efficiencyRatio < 0.3) {
    score *= 0.5
    signals.push('Choppy regime — signals dampened')
  }

  score = Math.max(-1, Math.min(1, score))

  const label: SentimentOutput['label'] =
    score >  0.6 ? 'strongly_bullish' :
    score >  0.2 ? 'bullish' :
    score < -0.6 ? 'strongly_bearish' :
    score < -0.2 ? 'bearish' : 'neutral'

  return {
    agentName: 'SentimentAgent (quant)',
    status: 'done',
    output: {
      score,
      label,
      momentum:      quant.velocity?.velocityPerMin ?? 0,
      orderbookSkew: quant.obImbalance?.simple ?? 0,
      signals: signals.slice(0, 5),
      provider: 'quant',
    },
    reasoning: 'Quant sentiment score=' + score.toFixed(3) + ' (' + label + ') — ' + signals.join(' | '),
    durationMs: Date.now() - start,
    timestamp: new Date().toISOString(),
  }
}
