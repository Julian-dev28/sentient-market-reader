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
  const obYes = orderbook?.yes?.slice(0, 5)
    .filter(l => l.price != null && l.delta != null)
    .map(l => `${l.price}¢×${Math.abs(l.delta)}`).join(', ') || 'n/a'
  const obNo  = orderbook?.no?.slice(0, 5)
    .filter(l => l.price != null && l.delta != null)
    .map(l => `${l.price}¢×${Math.abs(l.delta)}`).join(', ') || 'n/a'

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

    `\n[4] MOMENTUM CONFLUENCE — how many of RSI, MACD, Bollinger %B, Stochastic point in the same direction? ` +
    `3–4 aligned = strong momentum signal. 1–2 = mixed, don't over-weight.` +

    `\n[5] REGIME — trending (H>0.6, autocorr>0.15): momentum likely continues. ` +
    `Mean-reverting (H<0.4, autocorr<-0.15): overbought/oversold extremes tend to snap back.` +

    `\n[6] ORDER FLOW — pressure-weighted orderbook imbalance shows where smart money is positioned. ` +
    `Strong YES skew = crowd leaning YES; strong NO skew = crowd leaning NO.` +

    `\n[7] DERIVATIVES — funding rate >+0.01%: crowded longs = short-term bearish pressure. ` +
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

  // Depth controlled by ROMA_MAX_DEPTH env var (default 1). ROMA treats 0 as unlimited — never send 0.
  const maxDepth = 1
  const romaResult = await callPythonRoma(goal, context, maxDepth, 2, romaMode, provider, providers, orModelOverride, signal, apiKeys)
  const romaTrace  = formatRomaTrace(romaResult)

  // Use fast tier (grok-3-mini) — extraction is simple JSON parsing, no need for the
  // heavy model. Keeps token pressure low after ROMA already used the bulk of the budget.
  const extracted = await llmToolCall<{
    score: number
    label: SentimentOutput['label']
    momentum: number
    orderbookSkew: number
    signals: string[]
  }>({
    provider: extractionProvider ?? provider,
    tier: 'fast',
    maxTokens: romaMode === 'blitz' ? 256 : 512,
    toolName: 'output_sentiment',
    toolDescription: 'Extract structured BTC sentiment data from ROMA analysis output',
    schema: {
      properties: {
        score:         { type: 'number', description: 'Overall sentiment score: -1.0 = strongly bearish, +1.0 = strongly bullish' },
        label:         { type: 'string', enum: ['strongly_bullish', 'bullish', 'neutral', 'bearish', 'strongly_bearish'] },
        momentum:      { type: 'number', description: 'Short-term price momentum component: -1 to +1' },
        orderbookSkew: { type: 'number', description: 'Kalshi orderbook/crowd sentiment skew: -1 to +1' },
        signals:       { type: 'array', items: { type: 'string' }, description: '3-5 concise signals from the ROMA analysis' },
      },
      required: ['score', 'label', 'momentum', 'orderbookSkew', 'signals'],
    },
    prompt: `Extract structured sentiment data from this ROMA analysis:

${romaResult.answer}`,
  })

  // Normalize signals — fallback JSON responses may return a string instead of string[]
  const signals: string[] = Array.isArray(extracted.signals)
    ? extracted.signals
    : typeof extracted.signals === 'string'
      ? (extracted.signals as string).split(/[,|]/).map((s: string) => s.trim()).filter(Boolean)
      : []

  return {
    agentName: `SentimentAgent (roma-dspy · ${romaResult.provider})`,
    status: 'done',
    output: {
      score:         Math.max(-1, Math.min(1, extracted.score)),
      label:         extracted.label,
      momentum:      extracted.momentum,
      orderbookSkew: extracted.orderbookSkew,
      signals,
      provider:      romaResult.provider,
    },
    reasoning: romaTrace + `

Score: ${extracted.score.toFixed(3)} (${extracted.label}) — ${signals.join(' | ')}`,
    durationMs: Date.now() - start,
    timestamp: new Date().toISOString(),
  }
}
