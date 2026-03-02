import type { AgentResult, SentimentOutput, BTCQuote, KalshiMarket, KalshiOrderbook, OHLCVCandle, DerivativesSignal } from '../types'
import { llmToolCall, type AIProvider } from '../llm-client'
import { callPythonRoma, formatRomaTrace } from '../roma/python-client'

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

  const goal =
    `Assess short-term BTC directional sentiment for this 15-min Kalshi KXBTC15M prediction window. ` +
    `Evaluate ALL of the following signals: ` +
    `(1) 15-min candle trend — structure, higher highs/lows, WaveTrend-style momentum; ` +
    `CRITICAL: ⚡ CANDLE FLIP ALERT = trend reversal, override prior bias; ` +
    `(2) 1-min live candles — these show what BTC is doing RIGHT NOW inside the current window; ` +
    `if 1-min candles show momentum toward or away from strike, weight this heavily vs older 15-min data; ` +
    `(3) Perp futures signals: funding rate shows positioning pressure (positive = crowded longs = bearish near-term); ` +
    `basis (contango/backwardation) shows smart money directional lean; ` +
    `(4) BTC vs strike + Kalshi orderbook skew; ` +
    `(5) time pressure: ${minutesUntilExpiry.toFixed(1)} min left — with < 5 min, live 1-min momentum is decisive. ` +
    `Produce a directional sentiment score from -1 (strongly bearish) to +1 (strongly bullish).`

  const context = [
    `BTC price: $${quote.price.toLocaleString('en-US', { maximumFractionDigits: 2 })}`,
    `1h change: ${quote.percent_change_1h >= 0 ? '+' : ''}${quote.percent_change_1h.toFixed(4)}%`,
    `24h change: ${quote.percent_change_24h >= 0 ? '+' : ''}${quote.percent_change_24h.toFixed(4)}%`,
    `Strike price: $${strikePrice.toLocaleString('en-US', { maximumFractionDigits: 2 })}`,
    `BTC vs strike: ${distSign}${distanceFromStrikePct.toFixed(4)}% — BTC is ${distanceFromStrikePct >= 0 ? 'ABOVE' : 'BELOW'} strike`,
    `Minutes to window close: ${minutesUntilExpiry.toFixed(2)}`,
    market
      ? `Kalshi YES ask: ${market.yes_ask}¢ | YES bid: ${market.yes_bid}¢ | NO ask: ${market.no_ask}¢ | Spread: ${market.yes_ask - market.yes_bid}¢`
      : 'No active Kalshi market',
    `Orderbook YES depth: ${obYes}`,
    `Orderbook NO depth:  ${obNo}`,
    derivativesBlock,
    ...(liveCandles?.length && liveCandleBlock ? [`\n${liveCandleBlock}`] : []),
    ...(candles?.length ? [`\n${formatCandles(candles)}`] : []),
    ...(prevContext ? [`\nPrevious cycle analysis:\n${prevContext}`] : []),
  ].filter(Boolean).join('\n')

  // Depth controlled by ROMA_MAX_DEPTH env var (default 1). ROMA treats 0 as unlimited — never send 0.
  const maxDepth = Math.max(1, parseInt(process.env.ROMA_MAX_DEPTH ?? '1'))
  const romaResult = await callPythonRoma(goal, context, maxDepth, 2, romaMode, provider, providers)
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
    prompt: `Extract structured sentiment data from this ROMA analysis:\n\n${romaResult.answer}`,
  })

  return {
    agentName: `SentimentAgent (roma-dspy · ${romaResult.provider})`,
    status: 'done',
    output: {
      score:         Math.max(-1, Math.min(1, extracted.score)),
      label:         extracted.label,
      momentum:      extracted.momentum,
      orderbookSkew: extracted.orderbookSkew,
      signals:       extracted.signals,
      provider:      romaResult.provider,
    },
    reasoning: romaTrace + `\n\nScore: ${extracted.score.toFixed(3)} (${extracted.label}) — ${extracted.signals.join(' | ')}`,
    durationMs: Date.now() - start,
    timestamp: new Date().toISOString(),
  }
}
