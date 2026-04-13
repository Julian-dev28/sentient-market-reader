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
  BTCQuote, KalshiMarket, KalshiOrderbook, OHLCVCandle, DerivativesSignal,
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
function compactCandles(candles: OHLCVCandle[], count: number, label: string): string {
  if (!candles.length) return ''
  const ordered = [...candles].slice(0, count).reverse() // oldest first
  const lines = ordered.map((c, i) => {
    const [, , , open, close, vol] = c
    const dir = close >= open ? '▲' : '▼'
    const chg = ((close - open) / open * 100).toFixed(2)
    const minsAgo = (count - i) * (label === '1m' ? 1 : 15)
    return `  [−${String(minsAgo).padStart(3)}m] O:${open.toFixed(0)} C:${close.toFixed(0)} Vol:${vol.toFixed(1)} ${dir}${chg}%`
  })
  return `${label} candles (oldest→newest):\n${lines.join('\n')}`
}

// ── Grok tool response schema ─────────────────────────────────────────────────
interface GrokTradeDecision {
  sentiment_score:  number                              // -1.0 to +1.0
  pModel:           number                              // P(YES) 0.05–0.95
  confidence:       'high' | 'medium' | 'low'
  action:           'BUY_YES' | 'BUY_NO' | 'PASS'
  contracts:        number                              // 0 if PASS
  limitPrice:       number                              // ¢ to submit order at
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
  candles?:             OHLCVCandle[],
  liveCandles?:         OHLCVCandle[],
  derivatives?:         DerivativesSignal,
  orModelOverride?:     string,
  signal?:              AbortSignal,
  prevContext?:         string,
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
  const quant       = computeQuantSignals(candles, liveCandles, orderbook, spotApprox, strikePrice, distanceFromStrikePct, minutesUntilExpiry)
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

  // ── Build prompt ──────────────────────────────────────────────────────────
  const derivBlock = derivatives ? [
    `Bybit perp funding: ${(derivatives.fundingRate * 100).toFixed(4)}%/8h (${derivatives.fundingRate > 0.0001 ? 'longs paying → short-term bearish' : derivatives.fundingRate < -0.0001 ? 'shorts paying → short-term bullish' : 'near-zero'})`,
    `Basis (perp-spot): ${derivatives.basis >= 0 ? '+' : ''}${derivatives.basis.toFixed(4)}% (${derivatives.basis > 0.02 ? 'contango/bullish' : derivatives.basis < -0.02 ? 'backwardation/bearish' : 'flat'})`,
  ].join('\n') : null

  const prompt = [
    `You are an autonomous quantitative BTC prediction market trading agent with full capital authority.`,
    ``,
    `=== MARKET ===`,
    `Kalshi binary: YES wins if BTC closes ${aboveStrike ? 'ABOVE' : 'BELOW'} $${strikePrice.toLocaleString()} | window closes in ${minutesUntilExpiry.toFixed(2)} min`,
    `BTC spot: $${quote.price.toLocaleString()} — ${aboveStrike ? '+' : ''}${distanceFromStrikePct.toFixed(4)}% from strike ($${distUSD.toFixed(0)} ${aboveStrike ? 'above' : 'below'})`,
    `Required velocity to reach strike: $${reqVel.toFixed(2)}/min`,
    `1h change: ${quote.percent_change_1h >= 0 ? '+' : ''}${quote.percent_change_1h.toFixed(3)}% | 24h: ${quote.percent_change_24h >= 0 ? '+' : ''}${quote.percent_change_24h.toFixed(3)}%`,
    ``,
    `=== KALSHI PRICES ===`,
    `YES: ask=${yesAsk}¢  bid=${yesBid}¢  (buy YES → win ${100 - yesAsk}¢/contract if BTC stays ${aboveStrike ? 'above' : 'below'} strike)`,
    `NO:  ask=${noAsk}¢   bid=${noBid}¢   (buy NO  → win ${100 - noAsk}¢/contract if BTC crosses to ${aboveStrike ? 'below' : 'above'} strike)`,
    `Fee: 1.75% × P × (1-P) per contract (maker)`,
    ``,
    `=== QUANT SIGNALS ===`,
    quantBrief,
    pBrownian !== null ? `Brownian P(YES): ${(pBrownian * 100).toFixed(1)}%` : null,
    dScore !== null ? `D-score: ${dScore.toFixed(3)} — DIRECTIONAL CONSTRAINT: if |d|∈[1.0,1.2], your action MUST match d's direction (d>0 → BUY_YES or PASS; d<0 → BUY_NO or PASS). Acting against the d-score in this zone has a 100% loss rate in backtests.` : null,
    derivBlock,
    candles?.length ? `\n${compactCandles(candles, 8, '15m')}` : null,
    liveCandles?.length ? `\n${compactCandles(liveCandles, 12, '1m')}` : null,
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
    `=== HARD RULES (non-negotiable) ===`,
    `- NEVER buy contracts priced below 72¢ — if a side trades at <28¢, the market is near-certain it loses. You have no information edge against the crowd at this price. PASS instead.`,
    `- NEVER trade against the d-score direction when |d|∈[1.0,1.2]: d>0 means BTC is above strike, only BUY_YES or PASS is valid; d<0 means BTC is below strike, only BUY_NO or PASS is valid.`,
    `- With <3 min left and BTC ${Math.abs(distanceFromStrikePct).toFixed(3)}% from strike, BTC needs $${reqVel.toFixed(0)}/min to cross. If that velocity is implausible given recent candles, PASS rather than fight the market.`,
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
      toolDescription: 'Make a complete trade decision for this BTC 15-min Kalshi binary window',
      schema: {
        properties: {
          sentiment_score: { type: 'number', description: 'Directional sentiment: +1.0=strongly bullish (YES favored), -1.0=strongly bearish (NO favored).' },
          pModel:          { type: 'number', description: 'Your estimated P(YES) — probability BTC finishes above strike. Range: 0.05–0.95.' },
          confidence:      { type: 'string', enum: ['high', 'medium', 'low'], description: 'Your confidence in this edge. high = clear signal, low = marginal.' },
          action:          { type: 'string', enum: ['BUY_YES', 'BUY_NO', 'PASS'], description: 'Primary trade action.' },
          contracts:       { type: 'number', description: 'Number of contracts for primary position. 0 if PASS.' },
          limitPrice:      { type: 'number', description: 'Limit price in cents (¢) to submit the primary order at. Use ask for aggressive fill, mid for passive.' },
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
          reasoning:   { type: 'string', description: 'Full trade rationale: probability assessment, edge source, sizing logic, and hedge rationale if any.' },
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
  const pModel     = Math.max(0.05, Math.min(0.95, decision.pModel ?? 0.5))
  const sentScore  = Math.max(-1, Math.min(1, decision.sentiment_score ?? 0))
  let   action     = decision.action ?? 'PASS'
  const limitPrice = Math.max(1, Math.min(99, Math.round(decision.limitPrice ?? (action === 'BUY_NO' ? noAsk : yesAsk))))
  // Hard cap: can't buy more contracts than portfolio can afford
  const maxAffordable = action === 'BUY_NO' ? maxContractsNo : maxContractsYes
  const contracts  = Math.min(Math.max(0, Math.round(decision.contracts ?? 0)), maxAffordable)

  // ── Hard safety gates (applied AFTER Grok's decision, cannot be overridden) ──
  // 1. Entry price floor: never buy below 72¢ — market near-certainty, no LLM alpha.
  //    Empirical: minEntryPrice=72¢ validated on 2,690 live fills (same as deterministic RM).
  const MIN_ENTRY_PRICE = 72
  const MAX_ENTRY_PRICE = 92
  if (action !== 'PASS' && limitPrice < MIN_ENTRY_PRICE) {
    const side = action === 'BUY_NO' ? 'NO' : 'YES'
    console.warn(`[GrokTradingAgent] Safety gate: ${side} @ ${limitPrice}¢ < ${MIN_ENTRY_PRICE}¢ min — market near-certain, blocking`)
    action = 'PASS'
  }
  // 2. Entry price ceiling: fee eats >12% of gross margin above 92¢.
  if (action !== 'PASS' && limitPrice > MAX_ENTRY_PRICE) {
    const side = action === 'BUY_NO' ? 'NO' : 'YES'
    console.warn(`[GrokTradingAgent] Safety gate: ${side} @ ${limitPrice}¢ > ${MAX_ENTRY_PRICE}¢ max — fee overhead too high, blocking`)
    action = 'PASS'
  }
  // 3. D-score direction gate: if |d|∈[1.0,1.2], action MUST match d's direction.
  //    This zone is the ONLY confirmed edge (empirical: +5.5pp margin, Z=2.33).
  //    Trading against d in this zone has negative expectancy in every backtest.
  if (action !== 'PASS' && dScore !== null && Math.abs(dScore) >= 1.0 && Math.abs(dScore) <= 1.2) {
    const dDirection = dScore > 0 ? 'BUY_YES' : 'BUY_NO'
    if (action !== dDirection) {
      console.warn(`[GrokTradingAgent] Safety gate: d=${dScore.toFixed(3)} requires ${dDirection}, Grok said ${action} — blocking contrarian bet`)
      action = 'PASS'
    }
  }

  const approved   = action !== 'PASS' && contracts > 0

  const pMarket    = yesAsk / 100
  const recFull: ProbabilityOutput['recommendation'] = action === 'BUY_YES' ? 'YES' : action === 'BUY_NO' ? 'NO' : 'NO_TRADE'
  const entryP     = limitPrice / 100
  const fee        = 0.0175 * entryP * (1 - entryP)
  const pWin       = recFull === 'NO' ? (1 - pModel) : pModel
  const edge       = pWin * ((1 - entryP) - fee) + (1 - pWin) * (-entryP - fee)

  const sentLabel: SentimentOutput['label'] =
    sentScore >  0.6 ? 'strongly_bullish' :
    sentScore >  0.2 ? 'bullish' :
    sentScore < -0.6 ? 'strongly_bearish' :
    sentScore < -0.2 ? 'bearish' : 'neutral'

  // Hedge annotation (displayed in reasoning; secondary order handled by usePipeline hedge support)
  const hedgeNote = decision.hedge
    ? ` | HEDGE: ${decision.hedge.action} ${decision.hedge.contracts}× @ ${decision.hedge.limitPrice}¢ — ${decision.hedge.rationale}`
    : ''

  const maxLoss  = approved ? entryP * contracts : 0
  const pctPort  = portfolioValue > 0 ? (maxLoss / portfolioValue * 100).toFixed(1) : '0'

  const givebackDollars = session.peakPnl > 0 ? session.peakPnl - session.dailyPnl : 0
  const ts   = new Date().toISOString()
  const ms   = Date.now() - start

  // ── Execution details ─────────────────────────────────────────────────────
  const estimatedCost   = entryP * contracts
  const estimatedPayout = contracts  // $1 per contract if win
  const side            = recFull === 'YES' ? 'yes' : recFull === 'NO' ? 'no' : null
  const execAction      = action === 'BUY_YES' ? 'BUY_YES' : action === 'BUY_NO' ? 'BUY_NO' : 'PASS'
  const execRationale   = approved
    ? `Grok: ${action} ${contracts}× @ ${limitPrice}¢ on ${ticker}. Cost $${estimatedCost.toFixed(2)} (${pctPort}% of $${portfolioValue.toFixed(0)}). Max profit $${(estimatedPayout - estimatedCost).toFixed(2)}.${hedgeNote}`
    : `Grok PASS — ${decision.reasoning.slice(0, 120)}`

  return {
    sentiment: makeSentiment(
      sentScore, sentLabel, (decision.key_signals ?? []).slice(0, 5), 'grok',
      `Grok sentiment=${sentScore.toFixed(3)} (${sentLabel}) — ${(decision.key_signals ?? []).join(' | ')}`,
      ms, ts,
    ),
    probability: makeProbability(
      pModel, market, edge, edge * 100, recFull, decision.confidence,
      `Grok P(YES)=${(pModel * 100).toFixed(1)}% P(WIN)=${(pWin * 100).toFixed(1)}% edge=${(edge * 100).toFixed(2)}%${hedgeNote}\n${decision.reasoning}`,
      ms, ts,
      quant.gkVol15m, quant.volOfVol, dScore,
    ),
    risk: {
      agentName: 'RiskManagerAgent (Grok)',
      status:    approved ? 'done' : 'skipped',
      output: {
        approved,
        rejectionReason: approved ? undefined : `Grok PASS — ${decision.reasoning.slice(0, 200)}`,
        positionSize:    approved ? contracts : 0,
        maxLoss,
        dailyPnl:        session.dailyPnl,
        givebackDollars,
        tradeCount:      session.tradeCount,
      },
      reasoning: approved
        ? `Grok approved: ${action} ${contracts}× @ ${limitPrice}¢ ($${maxLoss.toFixed(2)} risk, ${pctPort}% of portfolio). Confidence: ${decision.confidence}.${hedgeNote}`
        : `Grok rejected: ${decision.reasoning.slice(0, 200)}`,
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
