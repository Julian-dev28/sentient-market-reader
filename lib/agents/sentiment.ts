import type { AgentResult, SentimentOutput, BTCQuote, KalshiMarket, KalshiOrderbook, OHLCVCandle, DerivativesSignal } from '../types'
import { llmToolCall, type AIProvider } from '../llm-client'
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
  aiMode?: boolean,                // true = Grok-powered sentiment instead of pure quant
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

  const distUSD = Math.abs(distanceFromStrikePct / 100) * quote.price
  const reqVel  = minutesUntilExpiry > 0 ? distUSD / minutesUntilExpiry : 0

  // Pre-compute quantitative signals
  const quant      = computeQuantSignals(candles, liveCandles, orderbook, quote.price, strikePrice, distanceFromStrikePct, minutesUntilExpiry)
  const quantBrief = formatQuantBrief(quant, quote.price, distanceFromStrikePct, minutesUntilExpiry)

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

  // 6. Velocity — direction relative to whether YES or NO needs to win
  // BTC above strike: velocity toward strike (downward) = bad for YES = bearish signal
  // BTC below strike: velocity toward strike (upward) = good for YES = bullish signal
  // The score is YES-relative, so moving toward strike when above = -score, when below = +score
  if (quant.velocity) {
    const vel = quant.velocity.velocityPerMin
    const movingDown = vel < 0
    const aboveStrike = distanceFromStrikePct > 0
    // Toward strike means: above + moving down, OR below + moving up
    const towardStrike = (aboveStrike && movingDown) || (!aboveStrike && !movingDown)
    if (towardStrike) {
      // Toward strike when above = threatens YES (bad). Toward strike when below = helps YES (good).
      const delta = aboveStrike ? -0.15 : +0.15
      score += delta
      signals.push(aboveStrike ? 'Price falling toward strike (YES at risk)' : 'Price rising toward strike (YES opportunity)')
    } else if (Math.abs(vel) > 0) {
      // Moving away from strike — reinforces current position
      const delta = aboveStrike ? +0.10 : -0.10
      score += delta
      signals.push(aboveStrike ? 'Price moving away from strike (YES safe)' : 'Price falling away from strike (NO safe)')
    }
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

  const quantLabel: SentimentOutput['label'] =
    score >  0.6 ? 'strongly_bullish' :
    score >  0.2 ? 'bullish' :
    score < -0.6 ? 'strongly_bearish' :
    score < -0.2 ? 'bearish' : 'neutral'

  // ── AI mode: Grok assesses sentiment using the full market context ─────────
  // Always uses provider='grok' regardless of AI_PROVIDER env — the UI picker is Grok-only.
  if (aiMode) {
    const aboveStrike = distanceFromStrikePct >= 0
    const grokPrompt = [
      `You are a quantitative BTC prediction market analyst. This is a 15-min Kalshi binary.`,
      `YES wins if BTC finishes ${aboveStrike ? 'ABOVE' : 'BELOW'} $${strikePrice.toLocaleString()}.`,
      `NO wins if BTC ${aboveStrike ? 'drops below' : 'rises above'} the strike before close.`,
      ``,
      context,  // includes price, candles, quant signals, OB data — no duplicate quantBrief
      ``,
      `Estimate directional sentiment. +1.0 = strongly bullish (YES favored), -1.0 = strongly bearish (NO favored).`,
      `Focus on: momentum vs time pressure (${minutesUntilExpiry.toFixed(1)} min left), $${distUSD.toFixed(0)} gap to cross, reversal risk.`,
    ].join('\n')

    try {
      const aiResult = await llmToolCall<{
        score: number
        label: 'strongly_bullish' | 'bullish' | 'neutral' | 'bearish' | 'strongly_bearish'
        signals: string[]
      }>({
        provider: 'grok',          // always Grok — AI mode picker is Grok-only
        modelOverride: orModelOverride,
        tier: 'fast',
        maxTokens: 1024,           // grok-3 needs headroom; 512 can truncate tool output
        toolName: 'sentiment_analysis',
        toolDescription: 'Analyze BTC 15-min Kalshi binary sentiment, return directional score',
        schema: {
          properties: {
            score:   { type: 'number', description: 'Directional score: +1.0 = strongly bullish (YES wins), -1.0 = strongly bearish (NO wins). Range: -1.0 to +1.0.' },
            label:   { type: 'string', enum: ['strongly_bullish', 'bullish', 'neutral', 'bearish', 'strongly_bearish'], description: 'Must be consistent with score.' },
            signals: { type: 'array', items: { type: 'string' }, description: 'Top 3-5 signals driving your assessment, most important first.' },
          },
          required: ['score', 'label', 'signals'],
        },
        prompt: grokPrompt,
      })

      const aiScore = Math.max(-1, Math.min(1, aiResult.score))

      // Derive label from score — don't trust Grok's label if it conflicts with score
      const derivedLabel: SentimentOutput['label'] =
        aiScore >  0.6 ? 'strongly_bullish' :
        aiScore >  0.2 ? 'bullish' :
        aiScore < -0.6 ? 'strongly_bearish' :
        aiScore < -0.2 ? 'bearish' : 'neutral'
      const aiLabel = aiResult.label ?? derivedLabel

      return {
        agentName: 'SentimentAgent (Grok)',
        status: 'done',
        output: {
          score:         aiScore,
          label:         aiLabel,
          momentum:      quant.velocity?.velocityPerMin ?? 0,
          orderbookSkew: quant.obImbalance?.simple ?? 0,
          signals:       aiResult.signals.slice(0, 5),
          provider:      'grok',
        },
        reasoning: `Grok sentiment score=${aiScore.toFixed(3)} (${aiLabel}) — ${aiResult.signals.join(' | ')}`,
        durationMs: Date.now() - start,
        timestamp: new Date().toISOString(),
      }
    } catch (err) {
      console.error('[SentimentAgent] Grok AI mode failed — falling back to quant:', err instanceof Error ? err.message : err)
      // Fall through to quant result below
    }
  }

  return {
    agentName: 'SentimentAgent (quant)',
    status: 'done',
    output: {
      score,
      label:         quantLabel,
      momentum:      quant.velocity?.velocityPerMin ?? 0,
      orderbookSkew: quant.obImbalance?.simple ?? 0,
      signals: signals.slice(0, 5),
      provider: 'quant',
    },
    reasoning: 'Quant sentiment score=' + score.toFixed(3) + ' (' + quantLabel + ') — ' + signals.join(' | '),
    durationMs: Date.now() - start,
    timestamp: new Date().toISOString(),
  }
}
