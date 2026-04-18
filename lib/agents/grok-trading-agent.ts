/**
 * Grok Autonomous Trading Agent
 * ──────────────────────────────
 * Replaces pipeline stages 3-6 (sentiment + probability + risk + execution)
 * when AI mode is selected. Grok receives the full market picture and makes
 * ALL decisions: direction, probability, position size, and optional hedge.
 *
 * Grok has full capital authority — no Kelly cap, no d-gate. It can allocate
 * 0–100% of the portfolio if the edge justifies it. Hard session circuit
 * breakers (daily loss limit, trade count) are still enforced before the call.
 */

import type {
  AgentResult, SentimentOutput, ProbabilityOutput, RiskOutput, ExecutionOutput,
  BTCQuote, KalshiMarket, KalshiOrderbook, OHLCVCandle, DerivativesSignal, MarkovOutput,
} from '../types'
import { llmToolCall } from '../llm-client'
import { computeQuantSignals, formatQuantBrief } from '../indicators'
import { getSessionState, checkDailyReset } from './risk-manager'

// ── Session risk constants (same as deterministic manager) ────────────────────
const MAX_DAILY_TRADES = 48
const MAX_DAILY_LOSS_PCT = 5
const MAX_DAILY_LOSS_FLOOR = 50
const MAX_DAILY_LOSS_CAP = 150

function sessionDailyLossLimit(portfolioValue: number): number {
  return -Math.max(MAX_DAILY_LOSS_FLOOR, Math.min(MAX_DAILY_LOSS_CAP, portfolioValue * MAX_DAILY_LOSS_PCT / 100))
}

// ── Compact candle formatter ──────────────────────────────────────────────────
const INTERVAL_MINS: Record<string, number> = { '1m': 1, '15m': 15, '1h': 60, '4h': 240 }

function compactCandles(candles: OHLCVCandle[], count: number, label: string): string {
  if (!candles.length) return ''
  const minsPerCandle = INTERVAL_MINS[label] ?? 15
  const ordered = [...candles].slice(0, count).reverse() // oldest first
  const lines = ordered.map((c, i) => {
    const [, , , open, close, vol] = c
    const dir = close >= open ? '▲' : '▼'
    const chg = ((close - open) / open * 100).toFixed(2)
    const minsAgo = (count - i) * minsPerCandle
    const timeLabel = minsAgo >= 60
      ? `−${String(Math.round(minsAgo / 60)).padStart(2)}h`
      : `−${String(minsAgo).padStart(3)}m`
    return `  [${timeLabel}] O:${open.toFixed(0)} C:${close.toFixed(0)} Vol:${vol.toFixed(1)} ${dir}${chg}%`
  })
  return `${label} candles (oldest→newest):\n${lines.join('\n')}`
}

/** Compact trend summary: net direction + consecutive same-direction candles */
function trendSummary(candles: OHLCVCandle[], count: number, label: string): string {
  if (!candles || candles.length < 2) return ''
  const ordered = [...candles].slice(0, count).reverse() // oldest first
  const upCount  = ordered.filter(c => c[4] >= c[3]).length
  const netChg   = ordered.length ? ((ordered[ordered.length - 1][4] - ordered[0][3]) / ordered[0][3] * 100) : 0
  const dir      = netChg >= 0.1 ? 'BULLISH' : netChg <= -0.1 ? 'BEARISH' : 'FLAT'
  // Consecutive streak (from newest)
  const rev = [...ordered].reverse()
  let streak = 1
  const first = rev[0][4] >= rev[0][3]
  for (let i = 1; i < rev.length; i++) {
    if ((rev[i][4] >= rev[i][3]) === first) streak++
    else break
  }
  return `${label} trend: ${dir} (${upCount}/${ordered.length} candles up, net ${netChg >= 0 ? '+' : ''}${netChg.toFixed(2)}%, ${streak}-candle ${first ? '▲' : '▼'} streak)`
}

// ── Grok tool response schema ─────────────────────────────────────────────────
interface GrokTradeDecision {
  sentiment_score:  number                              // -1.0 to +1.0
  pModel:           number                              // P(YES) 0.05–0.95
  confidence:       'high' | 'medium' | 'low'
  action:           'BUY_YES' | 'BUY_NO' | 'PASS'
  contracts:        number                              // 0 if PASS
  limitPrice:       number                              // ¢ to submit order at
  predictedPrice?:  number                              // hourly only: Grok's BTC price prediction at close
  hedge: {
    action:    'BUY_YES' | 'BUY_NO'
    contracts: number
    limitPrice: number
    rationale:  string
  } | null
  key_signals: string[]                                 // top 3-5 signals
  reasoning:   string                                   // full rationale
}

// ── Main export ───────────────────────────────────────────────────────────────
export async function runGrokTradingAgent(
  quote:                BTCQuote,
  strikePrice:          number,
  distanceFromStrikePct: number,
  minutesUntilExpiry:   number,
  market:               KalshiMarket | null,
  orderbook:            KalshiOrderbook | null,
  portfolioValue:       number,
  candles?:             OHLCVCandle[],   // 15m candles, newest first
  liveCandles?:         OHLCVCandle[],   // 1m candles, newest first
  derivatives?:         DerivativesSignal,
  orModelOverride?:     string,
  signal?:              AbortSignal,
  prevContext?:         string,
  candles1h?:           OHLCVCandle[],   // 1h candles, newest first — intraday trend
  candles4h?:           OHLCVCandle[],   // 4h candles, newest first — macro trend
  isHourly?:            boolean,          // true = KXBTCD hourly market (price-prediction mode)
  markov?:              MarkovOutput | null,  // advisory Markov signal (AI mode only — not a gate)
): Promise<{
  sentiment:   AgentResult<SentimentOutput>
  probability: AgentResult<ProbabilityOutput>
  risk:        AgentResult<RiskOutput>
  execution:   AgentResult<ExecutionOutput>
}> {
  const start = Date.now()

  // ── Midnight reset + circuit breakers ────────────────────────────────────
  checkDailyReset()
  const session = getSessionState()
  const dailyLossLimit = sessionDailyLossLimit(portfolioValue)
  const ticker = market?.ticker ?? ''

  function blocked(reason: string) {
    const ts = new Date().toISOString()
    const ms = Date.now() - start
    return {
      sentiment:   makeSentiment(0, 'neutral', [], 'grok', reason, ms, ts),
      probability: makeProbability(0.5, market, 0, 0, 'NO_TRADE', 'low', reason, ms, ts),
      risk:        makeRisk(false, reason, 0, 0, session, ms, ts),
      execution:   makeExecution('PASS', 0, null, ticker, reason, ms, ts),
    }
  }

  if (session.dailyPnl <= dailyLossLimit) {
    return blocked(`Daily loss limit reached ($${Math.abs(dailyLossLimit).toFixed(0)})`)
  }
  if (session.tradeCount >= MAX_DAILY_TRADES) {
    return blocked(`Daily trade limit reached (${MAX_DAILY_TRADES})`)
  }
  if (!market) {
    return blocked('No active Kalshi market')
  }

  // ── Compute quant signals — passed to Grok as reference, not constraints ──
  const spotApprox  = strikePrice > 0 ? strikePrice * (1 + distanceFromStrikePct / 100) : quote.price
  const quant       = computeQuantSignals(candles, liveCandles, orderbook, spotApprox, strikePrice, distanceFromStrikePct, minutesUntilExpiry, candles1h, candles4h)
  const quantBrief  = formatQuantBrief(quant, spotApprox, distanceFromStrikePct, minutesUntilExpiry)

  const distUSD   = Math.abs(distanceFromStrikePct / 100) * quote.price
  const aboveStrike = distanceFromStrikePct >= 0
  const reqVel    = minutesUntilExpiry > 0 ? distUSD / minutesUntilExpiry : 0

  const yesAsk = market.yes_ask   // ¢
  const noAsk  = market.no_ask    // ¢
  const yesBid = market.yes_bid
  const noBid  = market.no_bid

  // Max contracts Grok can physically buy (floor by cost)
  const maxContractsYes = yesAsk > 0 ? Math.floor(portfolioValue / (yesAsk / 100)) : 0
  const maxContractsNo  = noAsk  > 0 ? Math.floor(portfolioValue / (noAsk  / 100)) : 0

  // Kelly reference (informational for Grok, not a hard cap)
  const pBrownian = quant.brownianPrior?.pQuant ?? null
  const dScore    = (spotApprox > 0 && strikePrice > 0 && quant.gkVol15m && quant.gkVol15m > 0 && minutesUntilExpiry > 0)
    ? Math.log(spotApprox / strikePrice) / (quant.gkVol15m * Math.sqrt(minutesUntilExpiry / 15))
    : null

  // ── Markov advisory block (AI mode — informational, not a constraint) ─────
  const markovBlock = markov ? [
    `=== MARKOV MOMENTUM SIGNAL (advisory) ===`,
    `State: ${markov.currentState} (${markov.stateLabel}) | History: ${markov.historyLength} observations`,
    `P(YES): ${(markov.pHatYes * 100).toFixed(1)}% | P(NO): ${(markov.pHatNo * 100).toFixed(1)}%`,
    `Persistence: ${(markov.persist * 100).toFixed(1)}% | Expected drift: ${markov.expectedDriftPct >= 0 ? '+' : ''}${markov.expectedDriftPct.toFixed(3)}%`,
    `Momentum verdict: ${markov.recommendation}${markov.rejectionReason ? ` — ${markov.rejectionReason}` : ' — signal locked in'}`,
    `NOTE: This is a 1-min momentum signal — factor it alongside all other signals. You have full decision authority.`,
  ].join('\n') : null

  // ── Build prompt ──────────────────────────────────────────────────────────
  const derivBlock = derivatives ? [
    `Bybit perp funding: ${(derivatives.fundingRate * 100).toFixed(4)}%/8h (${derivatives.fundingRate > 0.0001 ? 'longs paying → short-term bearish' : derivatives.fundingRate < -0.0001 ? 'shorts paying → short-term bullish' : 'near-zero'})`,
    `Basis (perp-spot): ${derivatives.basis >= 0 ? '+' : ''}${derivatives.basis.toFixed(4)}% (${derivatives.basis > 0.02 ? 'contango/bullish' : derivatives.basis < -0.02 ? 'backwardation/bearish' : 'flat'})`,
  ].join('\n') : null

  // ── Trend logging (both modes) ────────────────────────────────────────────
  if (candles4h?.length) console.log(`[grok] ${trendSummary(candles4h, 7, '4h')}`)
  else console.log('[grok] 4h candles: MISSING')
  if (candles1h?.length) console.log(`[grok] ${trendSummary(candles1h, 12, '1h')}`)
  else console.log('[grok] 1h candles: MISSING')

  // ── HOURLY MODE prompt (KXBTCD) ───────────────────────────────────────────
  // Grok must FIRST predict where BTC will be at the end of the hour,
  // THEN bet YES if predicted_price > strike, NO if predicted_price < strike.
  const prompt = isHourly ? [
    `You are an autonomous BTC price prediction trading agent. Your job: predict where BTC will trade at the END OF THE CURRENT HOUR, then place the correct Kalshi binary bet.`,
    ``,
    `=== MARKET (KXBTCD HOURLY) ===`,
    `Kalshi binary: YES wins if BTC closes ABOVE $${strikePrice.toLocaleString()} | NO wins if BTC closes BELOW | window closes in ${minutesUntilExpiry.toFixed(1)} min`,
    `BTC spot: $${quote.price.toLocaleString()} — currently ${aboveStrike ? 'ABOVE' : 'BELOW'} strike by $${distUSD.toFixed(0)} (${Math.abs(distanceFromStrikePct).toFixed(3)}%)`,
    `1h change: ${quote.percent_change_1h >= 0 ? '+' : ''}${quote.percent_change_1h.toFixed(3)}% | 24h: ${quote.percent_change_24h >= 0 ? '+' : ''}${quote.percent_change_24h.toFixed(3)}%`,
    ``,
    `=== KALSHI PRICES ===`,
    `YES: ask=${yesAsk}¢  bid=${yesBid}¢  (buy YES → win ${100 - yesAsk}¢/contract if BTC closes ABOVE $${strikePrice.toLocaleString()})`,
    `NO:  ask=${noAsk}¢   bid=${noBid}¢   (buy NO  → win ${100 - noAsk}¢/contract if BTC closes BELOW $${strikePrice.toLocaleString()})`,
    `Fee: 1.75% × P × (1-P) per contract (maker)`,
    ``,
    `=== YOUR TASK (3 STEPS) ===`,
    `STEP 1 — PREDICT: Where will BTC trade at the close of this hour?`,
    `  - Use 4h macro trend as your primary prior`,
    `  - Use 1h trend as your intraday prior`,
    `  - Consider momentum, volume, derivatives (funding/basis), and recent 15m candles as supporting signals`,
    `  - State a specific price target (e.g. "BTC at $104,500")`,
    `  - Record this as predictedPrice in your response`,
    ``,
    `STEP 2 — DECIDE (from your prediction):`,
    `  - If predictedPrice > $${strikePrice.toLocaleString()} → BUY YES`,
    `  - If predictedPrice < $${strikePrice.toLocaleString()} → BUY NO`,
    `  - PASS only if you genuinely cannot forecast direction (e.g. BTC ±0.01% of strike with 2 min left)`,
    ``,
    `STEP 3 — SIZE using quarter-Kelly:`,
    `  pModel = P(BTC closes above strike) derived from your predicted price and volatility`,
    `  f = max(0, (b×pWin − (1−pWin)) / b), budget = f × 0.25 × $${portfolioValue.toFixed(0)}, contracts = floor(budget / costPerC)`,
    `  High conviction hourly call → size assertively.`,
    ``,
    `=== MULTI-TIMEFRAME TREND (PRIMARY SIGNALS) ===`,
    candles4h?.length ? trendSummary(candles4h, 7, '4h') : '4h candles: unavailable',
    candles1h?.length ? trendSummary(candles1h, 12, '1h') : '1h candles: unavailable',
    candles4h?.length ? `\n${compactCandles(candles4h, 7, '4h')}` : null,
    candles1h?.length ? `\n${compactCandles(candles1h, 12, '1h')}` : null,
    ``,
    `TREND PRIORITY: For hourly windows, 4h > 1h >> 15m > 1m.`,
    `A single 15m candle reversal does NOT override the macro trend.`,
    ``,
    `=== SUPPORTING SIGNALS ===`,
    quantBrief,
    markovBlock,
    derivBlock,
    candles?.length ? `\n${compactCandles(candles, 6, '15m')}` : null,
    liveCandles?.length ? `\n${compactCandles(liveCandles, 8, '1m')}` : null,
    prevContext ? `\n=== PREVIOUS CYCLE ===\n${prevContext}` : null,
    ``,
    `=== YOUR PORTFOLIO ===`,
    `Balance: $${portfolioValue.toFixed(2)} | Daily P&L: $${session.dailyPnl.toFixed(2)} | Trades today: ${session.tradeCount}/${MAX_DAILY_TRADES}`,
    `Max contracts if buying YES @ ${yesAsk}¢: ${maxContractsYes}`,
    `Max contracts if buying NO  @ ${noAsk}¢:  ${maxContractsNo}`,
    ``,
    `=== HARD RULES ===`,
    `- Minimum limit price: 3¢. Maximum: 97¢.`,
    `- Your predicted price DETERMINES YES/NO — do not second-guess it after computing it.`,
    `- PASS is only valid if the market is untradeable (extreme spread, no liquidity) or you truly cannot forecast direction.`,
  ].filter(Boolean).join('\n')

  // ── 15-MINUTE MODE prompt (KXBTC15M) ─────────────────────────────────────
  : [
    `You are an autonomous quantitative BTC prediction market trading agent with full capital authority.`,
    ``,
    `=== MARKET ===`,
    `Kalshi binary: YES wins if BTC closes ABOVE $${strikePrice.toLocaleString()} | NO wins if BTC closes BELOW | window closes in ${minutesUntilExpiry.toFixed(2)} min`,
    `BTC spot: $${quote.price.toLocaleString()} — currently ${aboveStrike ? 'ABOVE' : 'BELOW'} strike by $${distUSD.toFixed(0)} (${Math.abs(distanceFromStrikePct).toFixed(4)}%)`,
    `Required velocity to reach strike: $${reqVel.toFixed(2)}/min`,
    `1h change: ${quote.percent_change_1h >= 0 ? '+' : ''}${quote.percent_change_1h.toFixed(3)}% | 24h: ${quote.percent_change_24h >= 0 ? '+' : ''}${quote.percent_change_24h.toFixed(3)}%`,
    ``,
    `=== KALSHI PRICES ===`,
    `YES: ask=${yesAsk}¢  bid=${yesBid}¢  (buy YES → win ${100 - yesAsk}¢/contract if BTC closes ABOVE $${strikePrice.toLocaleString()})`,
    `NO:  ask=${noAsk}¢   bid=${noBid}¢   (buy NO  → win ${100 - noAsk}¢/contract if BTC closes BELOW $${strikePrice.toLocaleString()})`,
    `Fee: 1.75% × P × (1-P) per contract (maker)`,
    ``,
    `=== QUANT SIGNALS ===`,
    quantBrief,
    markovBlock,
    pBrownian !== null ? `Brownian P(YES): ${(pBrownian * 100).toFixed(1)}%` : null,
    dScore !== null ? `D-score: ${dScore.toFixed(3)} — DIRECTIONAL CONSTRAINT: if |d|∈[1.0,1.2], your action MUST match d's direction (d>0 → BUY_YES or PASS; d<0 → BUY_NO or PASS). Acting against the d-score in this zone has a 100% loss rate in backtests.` : null,
    derivBlock,
    candles?.length ? `\n${compactCandles(candles, 8, '15m')}` : null,
    liveCandles?.length ? `\n${compactCandles(liveCandles, 12, '1m')}` : null,

    // ── Multi-timeframe trend context ────────────────────────────────────
    (candles1h?.length || candles4h?.length) ? `\n=== MULTI-TIMEFRAME TREND ===` : null,
    candles4h?.length ? trendSummary(candles4h, 7, '4h') : null,
    candles1h?.length ? trendSummary(candles1h, 12, '1h') : null,
    candles4h?.length ? `\n${compactCandles(candles4h, 7, '4h')}` : null,
    candles1h?.length ? `\n${compactCandles(candles1h, 12, '1h')}` : null,
    (candles1h?.length || candles4h?.length) ? [
      ``,
      `TREND ALIGNMENT RULE: The 4h trend is your macro prior; the 1h trend is your intraday prior.`,
      `If 4h trend is BULLISH and 1h trend is BULLISH → bias pModel toward YES unless short-term evidence is overwhelming (e.g., BTC already >0.8% below strike with only 3+ min remaining).`,
      `If 4h trend is BEARISH and 1h trend is BEARISH → bias pModel toward NO unless BTC is already well above strike.`,
      `A single 15m candle flipping direction does NOT override the 1h/4h trend — it is noise unless confirmed by multiple signals.`,
      `Avoid flipping your recommendation every cycle solely because BTC crossed the strike. Trend context determines the path-of-least-resistance.`,
    ].join('\n') : null,

    prevContext ? `\n=== PREVIOUS CYCLE ===\n${prevContext}` : null,
    ``,
    `=== YOUR PORTFOLIO ===`,
    `Balance: $${portfolioValue.toFixed(2)} | Daily P&L: $${session.dailyPnl.toFixed(2)} | Trades today: ${session.tradeCount}/${MAX_DAILY_TRADES}`,
    `Max contracts if buying YES @ ${yesAsk}¢: ${maxContractsYes}`,
    `Max contracts if buying NO  @ ${noAsk}¢:  ${maxContractsNo}`,
    ``,
    `=== YOUR AUTHORITY ===`,
    `- Allocate 0–100% of balance. Size aggressively when edge is clear.`,
    `- Sizing guide (your discretion): high confidence → 40–80%; very high conviction → up to 100%`,
    `- You may add a hedge: a smaller opposing position to reduce variance while maintaining positive EV`,
    `- Both YES and NO are always valid. BUY NO at ${noAsk}¢ is identical to buying "BTC falls below strike".`,
    `- PASS only if there is no genuine edge in this window.`,
    ``,
    `=== EVALUATION METHODOLOGY ===`,
    `DEFINITION: pModel = P(YES) = probability BTC closes ABOVE $${strikePrice.toLocaleString()}. Range 0.05–0.95.`,
    `BTC is currently ${aboveStrike ? 'ABOVE' : 'BELOW'} strike — either side can win. Evaluate both:`,
    `  EV(YES) = pModel × (100 - ${yesAsk} - fee) - (1-pModel) × (${yesAsk} + fee)`,
    `  EV(NO)  = (1-pModel) × (100 - ${noAsk} - fee) - pModel × (${noAsk} + fee)`,
    `  where fee ≈ 1.75% × P × (1-P) cents per contract`,
    `Bet whichever side has the higher POSITIVE EV. If both are ≤0, PASS.`,
    `Size using quarter-Kelly: f = max(0, (b×pWin − (1−pWin)) / b), budget = f × 0.25 × ${portfolioValue.toFixed(0)}, contracts = floor(budget / costPerContract).`,
    `At extreme prices (<20¢ or >80¢), Kelly produces small positions — that is CORRECT sizing, not a reason to PASS.`,
    ``,
    `=== HARD RULES (non-negotiable) ===`,
    `- NEVER trade against the d-score direction when |d|∈[1.0,1.2]: d>0 → only BUY_YES or PASS; d<0 → only BUY_NO or PASS. Contrarian bets in this zone have 100% loss rate in backtests.`,
    `- Minimum limit price: 3¢. Maximum: 97¢.`,
    `- PASS only when EV is genuinely negative on both sides — not just because d-score is outside [1.0,1.2] or the price is extreme.`,
    `- If your pModel differs from the market price by even 2pp, compute EV — there may be edge. e.g. pModel=10% vs market YES at 8¢ → EV(YES)=+2¢/contract → BUY_YES (small Kelly position). Do NOT pass with positive EV.`,
  ].filter(Boolean).join('\n')

  // ── Grok tool call ────────────────────────────────────────────────────────
  let decision: GrokTradeDecision
  try {
    decision = await llmToolCall<GrokTradeDecision>({
      provider:      'grok',
      modelOverride: orModelOverride,
      tier:          'fast',
      maxTokens:     2048,
      signal,
      toolName:      'trade_decision',
      toolDescription: isHourly
        ? 'Predict BTC price at end of hour, then make a complete trade decision for this KXBTCD Kalshi hourly binary'
        : 'Make a complete trade decision for this BTC 15-min Kalshi binary window',
      schema: {
        properties: {
          sentiment_score: { type: 'number', description: 'Directional sentiment: +1.0=strongly bullish (YES favored), -1.0=strongly bearish (NO favored).' },
          pModel:          { type: 'number', description: 'Your estimated P(YES) — probability BTC finishes above strike. Range: 0.05–0.95.' },
          confidence:      { type: 'string', enum: ['high', 'medium', 'low'], description: 'Your confidence in this edge. high = clear signal, low = marginal.' },
          action:          { type: 'string', enum: ['BUY_YES', 'BUY_NO', 'PASS'], description: 'Primary trade action.' },
          contracts:       { type: 'number', description: 'Number of contracts for primary position. 0 if PASS.' },
          limitPrice:      { type: 'number', description: 'Limit price in cents (¢) to submit the primary order at. Use ask for aggressive fill, mid for passive.' },
          ...(isHourly ? {
            predictedPrice: { type: 'number', description: 'Your predicted BTC price at the close of the hour. This is the key output of step 1 — it directly determines YES (predicted > strike) or NO (predicted < strike).' },
          } : {}),
          hedge: {
            anyOf: [
              {
                type: 'object',
                description: 'Hedge leg — opposing side to reduce variance.',
                properties: {
                  action:     { type: 'string', enum: ['BUY_YES', 'BUY_NO'] },
                  contracts:  { type: 'number', description: 'Hedge contract count (typically 20-40% of primary).' },
                  limitPrice: { type: 'number', description: 'Hedge limit price in cents.' },
                  rationale:  { type: 'string', description: 'Why this hedge improves EV.' },
                },
                required: ['action', 'contracts', 'limitPrice', 'rationale'],
              },
              { type: 'null' },
            ],
            description: 'Optional hedge leg, or null if no hedge.',
          },
          key_signals: { type: 'array', items: { type: 'string' }, description: 'Top 3-5 signals driving this decision, most important first.' },
          reasoning: isHourly
            ? { type: 'string', description: 'Hourly trade rationale as 6-8 bullet points, each starting with "• ". Cover: (1) predicted BTC price at hour close & why, (2) 4h macro trend, (3) 1h intraday trend, (4) key supporting signals (derivatives, momentum), (5) YES/NO decision from predicted price vs strike, (6) quarter-Kelly sizing math, (7) confidence & main uncertainty. Max 25 words per bullet.' }
            : { type: 'string', description: 'Trade rationale as 8-10 bullet points, one per line, each starting with "• ". Cover: (1) pModel source & value, (2) d-score interpretation, (3) EV(YES) calc & result, (4) EV(NO) calc & result, (5) chosen action & why that side, (6) quarter-Kelly sizing math, (7) top 3 market signals, (8) confidence level & key uncertainty. Each bullet max 25 words. No prose paragraphs.' },
        },
        required: ['sentiment_score', 'pModel', 'confidence', 'action', 'contracts', 'limitPrice', 'key_signals', 'reasoning'],
      },
      prompt,
    })
  } catch (err) {
    console.error('[GrokTradingAgent] Grok call failed:', err instanceof Error ? err.message : err)
    return blocked(`Grok call failed: ${err instanceof Error ? err.message : 'unknown error'}`)
  }

  // ── Validate + clamp Grok's output ────────────────────────────────────────
  const pModel    = Math.max(0.05, Math.min(0.95, decision.pModel ?? 0.5))
  const sentScore = Math.max(-1, Math.min(1, decision.sentiment_score ?? 0))
  let   action    = decision.action ?? 'PASS'
  let   limitPrice = Math.max(3, Math.min(97, Math.round(decision.limitPrice ?? (action === 'BUY_NO' ? noAsk : yesAsk))))

  // ── Server-side quarter-Kelly contract cap ─────────────────────────────────
  // Grok massively over-sizes at extreme prices. Cap server-side regardless.
  const MAKER_FEE_RATE = 0.0175
  function kellyContracts(priceCents: number, pWin: number): number {
    const p    = priceCents / 100
    const fee  = MAKER_FEE_RATE * p * (1 - p)
    const net  = (1 - p) - fee
    const cost = p + fee
    const b    = cost > 0 ? net / cost : 0
    const f    = b > 0 ? Math.max(0, (b * pWin - (1 - pWin)) / b) : 0
    const budget = f * 0.25 * portfolioValue
    return cost > 0 ? Math.floor(budget / cost) : 0
  }
  const pWinYes = pModel
  const pWinNo  = 1 - pModel
  const kellyYes = kellyContracts(yesAsk, pWinYes)
  const kellyNo  = kellyContracts(noAsk,  pWinNo)

  // Expose both-side EVs in the output for UI display
  const evYes = pWinYes * ((1 - yesAsk/100) - MAKER_FEE_RATE * (yesAsk/100) * (1 - yesAsk/100)) - (1 - pWinYes) * (yesAsk/100)
  const evNo  = pWinNo  * ((1 - noAsk/100)  - MAKER_FEE_RATE * (noAsk/100)  * (1 - noAsk/100))  - (1 - pWinNo)  * (noAsk/100)

  // Cap Grok's contracts at quarter-Kelly (max affordable is a hard floor)
  const maxAffordable = action === 'BUY_NO' ? maxContractsNo : maxContractsYes
  const kCap = action === 'BUY_NO' ? kellyNo : kellyYes
  let contracts = Math.min(Math.max(0, Math.round(decision.contracts ?? 0)), maxAffordable, Math.max(kCap, 0), 500)
  if (action !== 'PASS' && (decision.contracts ?? 0) > contracts) {
    console.log(`[GrokTradingAgent] Kelly cap: Grok wanted ${decision.contracts} → ${contracts} contracts (quarter-Kelly budget)`)
  }

  // ── Hard safety gates ─────────────────────────────────────────────────────
  // 0. Hourly mode: predictedPrice must be consistent with action.
  //    If Grok predicts $X > strike but says BUY_NO (or vice versa), the prediction
  //    determines the correct direction — override the action rather than blocking.
  if (isHourly && action !== 'PASS' && decision.predictedPrice && strikePrice > 0) {
    const predAbove = decision.predictedPrice > strikePrice
    const actAbove  = action === 'BUY_YES'
    if (predAbove !== actAbove) {
      const corrected = predAbove ? 'BUY_YES' : 'BUY_NO'
      console.warn(`[GrokTradingAgent] Hourly consistency: predicted $${decision.predictedPrice.toLocaleString()} vs strike $${strikePrice.toLocaleString()} → should be ${corrected}, Grok said ${action} — correcting`)
      action = corrected
      limitPrice = corrected === 'BUY_YES'
        ? Math.max(3, Math.min(97, Math.round(yesAsk)))
        : Math.max(3, Math.min(97, Math.round(noAsk)))
    }
  }
  // 1. Absolute price floor/ceiling (3¢/97¢) — catch data errors only
  if (action !== 'PASS' && (limitPrice < 3 || limitPrice > 97)) {
    console.warn(`[GrokTradingAgent] Safety gate: ${action} @ ${limitPrice}¢ — out of valid range [3,97], blocking`)
    action = 'PASS'
  }
  // 2. D-score direction gate — 15m mode only.
  //    D-score is calibrated on 15-min KXBTC15M windows (empirical: +5.5pp margin at |d|∈[1.0,1.2], Z=2.33).
  //    For hourly KXBTCD, the normalization window is different — gate does not apply.
  if (!isHourly && action !== 'PASS' && dScore !== null && Math.abs(dScore) >= 1.0 && Math.abs(dScore) <= 1.2) {
    const dDirection = dScore > 0 ? 'BUY_YES' : 'BUY_NO'
    if (action !== dDirection) {
      console.warn(`[GrokTradingAgent] Safety gate: d=${dScore.toFixed(3)} requires ${dDirection}, Grok said ${action} — blocking contrarian bet`)
      action = 'PASS'
    }
  }
  // 3. Kelly says no edge → block
  if (action !== 'PASS' && contracts <= 0) {
    console.warn(`[GrokTradingAgent] Kelly gate: quarter-Kelly = 0 contracts at ${limitPrice}¢ — negative EV, blocking`)
    action = 'PASS'
  }

  const approved = action !== 'PASS' && contracts > 0

  const pMarket = yesAsk / 100
  const recFull: ProbabilityOutput['recommendation'] = action === 'BUY_YES' ? 'YES' : action === 'BUY_NO' ? 'NO' : 'NO_TRADE'

  // Edge: compute against the actual trade price when acting, or best available EV when PASS.
  // (Using Grok's limitPrice against the wrong pWin when PASS produces garbage like -83%.)
  let edge: number
  if (action === 'PASS') {
    const feeY = MAKER_FEE_RATE * (yesAsk/100) * (1 - yesAsk/100)
    const feeN = MAKER_FEE_RATE * (noAsk/100)  * (1 - noAsk/100)
    const evY  = pModel       * (1 - yesAsk/100 - feeY) - (1 - pModel) * (yesAsk/100 + feeY)
    const evN  = (1 - pModel) * (1 - noAsk/100  - feeN) - pModel       * (noAsk/100  + feeN)
    edge = Math.max(evY, evN)   // show best side's EV — negative means no edge on either side
  } else {
    const entryP = limitPrice / 100
    const fee    = MAKER_FEE_RATE * entryP * (1 - entryP)
    const pWin   = recFull === 'NO' ? (1 - pModel) : pModel
    edge = pWin * ((1 - entryP) - fee) + (1 - pWin) * (-entryP - fee)
  }

  const sentLabel: SentimentOutput['label'] =
    sentScore >  0.6 ? 'strongly_bullish' :
    sentScore >  0.2 ? 'bullish' :
    sentScore < -0.6 ? 'strongly_bearish' :
    sentScore < -0.2 ? 'bearish' : 'neutral'

  // Hedge annotation (displayed in reasoning; secondary order handled by usePipeline hedge support)
  const hedgeNote = decision.hedge
    ? ` | HEDGE: ${decision.hedge.action} ${decision.hedge.contracts}× @ ${decision.hedge.limitPrice}¢ — ${decision.hedge.rationale}`
    : ''

  const tradeEntryP = limitPrice / 100
  const pWin        = recFull === 'NO' ? (1 - pModel) : pModel
  const maxLoss     = approved ? tradeEntryP * contracts : 0
  const pctPort     = portfolioValue > 0 ? (maxLoss / portfolioValue * 100).toFixed(1) : '0'

  const givebackDollars = session.peakPnl > 0 ? session.peakPnl - session.dailyPnl : 0
  const ts   = new Date().toISOString()
  const ms   = Date.now() - start

  // ── Execution details ─────────────────────────────────────────────────────
  const estimatedCost   = tradeEntryP * contracts
  const estimatedPayout = contracts  // $1 per contract if win
  const side            = recFull === 'YES' ? 'yes' : recFull === 'NO' ? 'no' : null
  const execAction      = action === 'BUY_YES' ? 'BUY_YES' : action === 'BUY_NO' ? 'BUY_NO' : 'PASS'
  const predictedPriceNote = (isHourly && decision.predictedPrice)
    ? ` | Predicted BTC @ close: $${decision.predictedPrice.toLocaleString()} vs strike $${strikePrice.toLocaleString()} → ${(decision.predictedPrice ?? 0) > strikePrice ? 'ABOVE (YES)' : 'BELOW (NO)'}`
    : ''
  const execRationale   = approved
    ? `Grok${isHourly ? ' [HOURLY]' : ''}: ${action} ${contracts}× @ ${limitPrice}¢ on ${ticker}. Cost $${estimatedCost.toFixed(2)} (${pctPort}% of $${portfolioValue.toFixed(0)}). Max profit $${(estimatedPayout - estimatedCost).toFixed(2)}.${predictedPriceNote}${hedgeNote}`
    : `Grok PASS\n${decision.reasoning}`

  return {
    sentiment: makeSentiment(
      sentScore, sentLabel, (decision.key_signals ?? []).slice(0, 5), 'grok',
      `Grok sentiment=${sentScore.toFixed(3)} (${sentLabel}) — ${(decision.key_signals ?? []).join(' | ')}`,
      ms, ts,
    ),
    probability: makeProbability(
      pModel, market, edge, edge * 100, recFull, decision.confidence,
      `Grok P(YES)=${(pModel * 100).toFixed(1)}% P(WIN)=${(pWin * 100).toFixed(1)}% edge=${(edge * 100).toFixed(2)}% | EV(YES@${yesAsk}¢)=${(evYes*100).toFixed(1)}pp Kelly=${kellyYes}c | EV(NO@${noAsk}¢)=${(evNo*100).toFixed(1)}pp Kelly=${kellyNo}c${hedgeNote}\n${decision.reasoning}`,
      ms, ts,
      quant.gkVol15m, quant.volOfVol, dScore,
    ),
    risk: {
      agentName: 'RiskManagerAgent (Grok)',
      status:    approved ? 'done' : 'skipped',
      output: {
        approved,
        rejectionReason: approved ? undefined : `Grok PASS\n${decision.reasoning}`,
        positionSize:    approved ? contracts : 0,
        maxLoss,
        dailyPnl:        session.dailyPnl,
        givebackDollars,
        tradeCount:      session.tradeCount,
      },
      reasoning: approved
        ? `Grok approved: ${action} ${contracts}× @ ${limitPrice}¢ ($${maxLoss.toFixed(2)} risk, ${pctPort}% of portfolio). Confidence: ${decision.confidence}.${hedgeNote}`
        : `Grok rejected:\n${decision.reasoning}`,
      durationMs: ms,
      timestamp:  ts,
    },
    execution: makeExecution(execAction, contracts, side ? { side, limitPrice, ticker, estimatedCost, estimatedPayout } : null, ticker, execRationale, ms, ts),
  }
}

// ── Builder helpers ───────────────────────────────────────────────────────────

function makeSentiment(
  score: number, label: SentimentOutput['label'], signals: string[],
  provider: string, reasoning: string, ms: number, ts: string,
): AgentResult<SentimentOutput> {
  return {
    agentName: 'SentimentAgent (Grok)',
    status:    'done',
    output:    { score, label, momentum: 0, orderbookSkew: 0, signals, provider },
    reasoning,
    durationMs: ms,
    timestamp:  ts,
  }
}

function makeProbability(
  pModel: number, market: KalshiMarket | null, edge: number, edgePct: number,
  recommendation: ProbabilityOutput['recommendation'], confidence: ProbabilityOutput['confidence'],
  reasoning: string, ms: number, ts: string,
  gkVol15m?: number | null, volOfVol?: number | null, dScore?: number | null,
): AgentResult<ProbabilityOutput> {
  return {
    agentName: 'ProbabilityModelAgent (Grok)',
    status:    'done',
    output: {
      pModel,
      pMarket:  market ? market.yes_ask / 100 : 0.5,
      edge, edgePct, recommendation, confidence,
      provider: 'grok',
      gkVol15m, volOfVol, dScore,
    },
    reasoning,
    durationMs: ms,
    timestamp:  ts,
  }
}

function makeRisk(
  approved: boolean, reason: string, positionSize: number, maxLoss: number,
  session: ReturnType<typeof getSessionState>, ms: number, ts: string,
): AgentResult<RiskOutput> {
  const givebackDollars = session.peakPnl > 0 ? session.peakPnl - session.dailyPnl : 0
  return {
    agentName: 'RiskManagerAgent (Grok)',
    status:    approved ? 'done' : 'skipped',
    output: {
      approved,
      rejectionReason: approved ? undefined : reason,
      positionSize,
      maxLoss,
      dailyPnl:        session.dailyPnl,
      givebackDollars,
      tradeCount:      session.tradeCount,
    },
    reasoning: approved ? `Approved: ${positionSize} contracts, $${maxLoss.toFixed(2)} at risk` : `Rejected: ${reason}`,
    durationMs: ms,
    timestamp:  ts,
  }
}

function makeExecution(
  action: 'BUY_YES' | 'BUY_NO' | 'PASS',
  contracts: number,
  trade: { side: 'yes' | 'no'; limitPrice: number; ticker: string; estimatedCost: number; estimatedPayout: number } | null,
  ticker: string,
  rationale: string,
  ms: number,
  ts: string,
): AgentResult<ExecutionOutput> {
  return {
    agentName: 'ExecutionAgent (Grok)',
    status:    action !== 'PASS' ? 'done' : 'skipped',
    output: {
      action,
      side:            trade?.side ?? null,
      limitPrice:      trade?.limitPrice ?? null,
      contracts,
      estimatedCost:   trade?.estimatedCost ?? 0,
      estimatedPayout: trade?.estimatedPayout ?? 0,
      marketTicker:    trade?.ticker ?? ticker,
      rationale,
    },
    reasoning:  rationale,
    durationMs: ms,
    timestamp:  ts,
  }
}
