/**
 * Markov Chain Agent — momentum-based price direction prediction.
 *
 * State space: 1-min BTC % price change bins (9 states).
 * The transition matrix captures how momentum persists or reverses.
 * P(YES) = P(cumulative drift over T min > threshold to end above strike)
 * computed via Chapman-Kolmogorov propagation + Gaussian approximation.
 *
 * This is genuinely predictive: "given current momentum, will BTC end above
 * or below the strike?" — purely from price, no Kalshi bias.
 */

import type { AgentResult, MarkovOutput, KalshiMarket, OHLCVCandle } from '../types'
import {
  buildTransitionMatrix,
  predictFromMomentum,
  priceChangeToState,
  STATE_LABELS,
  NUM_STATES,
} from '../markov/chain'
import { seedFromCandles, appendMomentumState, getMomentumHistory, getMomentumHistoryLength } from '../markov/history'
import type { MarketKey } from '../markov/history'

const MIN_HISTORY = 20   // minimum transitions before trusting the matrix

// ── Session tracking (informational — not used for hard gates) ───────────────
const g = globalThis as typeof globalThis & {
  _markovSessionState?: { dailyPnl: number; tradeCount: number; peakPnl: number }
  _markovLastResetDate?: string
}
if (!g._markovSessionState)  g._markovSessionState  = { dailyPnl: 0, tradeCount: 0, peakPnl: 0 }
if (!g._markovLastResetDate) g._markovLastResetDate  = new Date().toDateString()

const sessionState = g._markovSessionState

function checkDailyReset(): void {
  const today = new Date().toDateString()
  if (today !== g._markovLastResetDate) {
    g._markovLastResetDate             = today
    g._markovSessionState!.dailyPnl   = 0
    g._markovSessionState!.tradeCount = 0
    g._markovSessionState!.peakPnl    = 0
  }
}

export function recordTradeResult(pnl: number): void {
  sessionState.dailyPnl   += pnl
  sessionState.tradeCount += 1
  if (sessionState.dailyPnl > sessionState.peakPnl) sessionState.peakPnl = sessionState.dailyPnl
}

export function getSessionState() {
  return { ...sessionState }
}

const MAKER_FEE_RATE   = 0.0175
const MAX_TRADE_PCT    = 0.15
const REFERENCE_VOL    = 0.002
const BASE_BANKROLL    = 200    // starting bankroll the 25-contract cap was calibrated at
const BASE_ORDER_CAP   = 25     // contracts at BASE_BANKROLL
const MIN_GAP        = 0.11   // |pYes − 0.5| must be ≥ this — matches backtest gate
const PERSIST_TAU    = 0.80   // momentum self-persistence threshold (mirrors chain.ts)

export function runMarkovAgent(
  distanceFromStrikePct: number,
  strikePrice: number,
  market: KalshiMarket | null,
  liveCandles?: OHLCVCandle[],   // 1-min candles — primary history + current state
  candles15m?: OHLCVCandle[],    // 15-min fallback
  portfolioValue: number = 500,
  minutesUntilExpiry?: number,
  gkVol15m?: number | null,
  confidence?: 'high' | 'medium' | 'low',
  isHourly: boolean = false,
): AgentResult<MarkovOutput> {
  const start = Date.now()
  checkDailyReset()

  const mKey: MarketKey = isHourly ? '1h' : '15m'

  // ── Seed momentum history from candles ──────────────────────────────────
  // Use 1-min candles with 5-min bounds (aligned with Python backtest approach)
  if (liveCandles && liveCandles.length >= 2)     seedFromCandles(liveCandles, mKey)
  else if (candles15m && candles15m.length >= 2)  seedFromCandles(candles15m, mKey)

  // ── Current momentum state from the most recent candle pair ───────
  let currentState = 4  // default: flat
  if (liveCandles && liveCandles.length >= 2) {
    const currClose = liveCandles[0][4]
    const prevClose = liveCandles[1][4]
    if (prevClose > 0) {
      const pct = ((currClose - prevClose) / prevClose) * 100
      currentState = priceChangeToState(pct)
    }
  }
  appendMomentumState(currentState, mKey)

  const history       = getMomentumHistory(mKey)
  const historyLength = getMomentumHistoryLength(mKey)
  const hasHistory    = historyLength >= MIN_HISTORY

  const P = buildTransitionMatrix(history.length >= 2 ? history : [currentState, currentState])

  // ── Momentum forecast: P(YES) via Chapman-Kolmogorov + Gaussian ─────────
  const T        = minutesUntilExpiry ?? 7.5   // default mid-window
  const forecast = predictFromMomentum(P, currentState, T, distanceFromStrikePct)

  // Require enough history before trusting the forecast
  const pYes = hasHistory ? forecast.pYes : 0.5
  const pNo  = hasHistory ? forecast.pNo  : 0.5

  const stateLabel = STATE_LABELS[currentState]  ?? `state ${currentState}`
  const jStarLabel = STATE_LABELS[forecast.jStar] ?? `state ${forecast.jStar}`

  const enterYes = hasHistory && forecast.enterYes
  const enterNo  = hasHistory && forecast.enterNo

  // ── Gate: momentum must be locked-in (persist) and directionally decisive (gap) ──
  // Under 1 minute left, time decay dominates — skip the persist gate entirely.
  const effectivePersistTau = T <= 1 ? 0 : PERSIST_TAU
  const gap     = Math.abs(pYes - 0.5)
  const gateOk  = hasHistory && forecast.persist >= effectivePersistTau && gap >= MIN_GAP

  const recommendation: 'YES' | 'NO' | 'NO_TRADE' =
    !gateOk     ? 'NO_TRADE' :
    pYes > 0.5  ? 'YES'      :
                  'NO'

  const approved        = gateOk
  const rejectionReason = !hasHistory
    ? `Building momentum history (${historyLength}/${MIN_HISTORY} observations)`
    : !gateOk
    ? forecast.persist < PERSIST_TAU && gap < MIN_GAP
      ? `Not confident enough (${(50 + gap * 100).toFixed(1)}% sure, need 61%+) and BTC momentum is too choppy (need 80%+ consistency)`
      : forecast.persist < PERSIST_TAU
      ? `BTC momentum is too choppy to call — only ${(forecast.persist * 100).toFixed(0)}% consistent (need 80%+)`
      : `Not confident enough — model is ${(50 + gap * 100).toFixed(1)}% sure, need 61%+ to trade`
    : undefined

  // Position sizing is now handled by RiskManager — Markov provides signal only

  // ── Reasoning ────────────────────────────────────────────────────────────
  const reasoning = [
    `Momentum state: ${currentState} (${stateLabel}) | history: ${historyLength} obs`,
    `Expected drift: ${forecast.expectedDriftPct >= 0 ? '+' : ''}${forecast.expectedDriftPct.toFixed(3)}% | Required for YES: ${forecast.requiredDriftPct >= 0 ? '+' : ''}${forecast.requiredDriftPct.toFixed(3)}%`,
    `σ=${forecast.sigma.toFixed(3)}% | z=${forecast.zScore.toFixed(2)} | P(YES)=${(pYes * 100).toFixed(1)}%`,
    `Persist=${(forecast.persist * 100).toFixed(1)}% | j*=${forecast.jStar} (${jStarLabel})`,
    approved
      ? `→ ${recommendation} (signal approved — sizing by RiskManager)`
      : `→ ${rejectionReason ?? 'no signal'}`,
  ].join('\n')

  const output: MarkovOutput = {
    currentState,
    stateLabel,
    historyLength,
    pHatYes:          pYes,
    pHatNo:           pNo,
    expectedDriftPct: forecast.expectedDriftPct,
    requiredDriftPct: forecast.requiredDriftPct,
    sigma:            forecast.sigma,
    zScore:           forecast.zScore,
    jStar:            forecast.jStar,
    jStarLabel,
    persist:          forecast.persist,
    enterYes,
    enterNo,
    tau:              0.80,
    transitionMatrix: P,
    numStates:        NUM_STATES,
    recommendation,
    approved,
    rejectionReason,
    positionSize:     0,  // sizing now handled by RiskManager
    maxLoss:          0,  // sizing now handled by RiskManager
    dailyPnl:        sessionState.dailyPnl,
    givebackDollars: 0,
    tradeCount:      sessionState.tradeCount,
  }

  return {
    agentName:  'MarkovChainAgent',
    status:     'done',
    output,
    reasoning,
    durationMs: Date.now() - start,
    timestamp:  new Date().toISOString(),
  }
}
