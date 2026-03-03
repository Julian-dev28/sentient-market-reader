/**
 * Quantitative Indicators Library
 * ─────────────────────────────────
 * Pre-computed signals for ROMA agent context. Computing these deterministically
 * before LLM calls lets the model reason about derived signals rather than doing
 * implicit statistics on raw OHLCV — significantly improves calibration for
 * math-capable models (Qwen3, Sonnet) on short-duration binary options.
 *
 * Instrument: Kalshi KXBTC15M — a digital option that pays if BTC > strike at T.
 * All volatility units are per-15min candle unless stated otherwise.
 */

import type { KalshiOrderbook, OHLCVCandle } from './types'

// ── Normal CDF (Abramowitz & Stegun, error < 7.5e-8) ─────────────────────────
export function normalCDF(z: number): number {
  const sign = z >= 0 ? 1 : -1
  const x    = Math.abs(z)
  const t    = 1 / (1 + 0.2316419 * x)
  const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))))
  const pdf  = Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI)
  return 0.5 + sign * (0.5 - pdf * poly)
}

// ── Lanczos log-gamma (g=7, accurate to ~15 significant figures) ─────────────
function lgamma(x: number): number {
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028,
             771.32342877765313, -176.61502916214059, 12.507343278686905,
             -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7]
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x)
  x -= 1
  let a = c[0]
  for (let i = 1; i < c.length; i++) a += c[i] / (x + i)
  const t = x + 7.5
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a)
}

// ── Regularized incomplete beta I_x(a,b) — Lentz continued fraction ──────────
// Used for Student-t CDF. Accurate to ~7 significant figures.
function incompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0
  if (x >= 1) return 1
  if (x > (a + 1) / (a + b + 2)) return 1 - incompleteBeta(1 - x, b, a)
  const lbeta = lgamma(a) + lgamma(b) - lgamma(a + b)
  const front = Math.exp(a * Math.log(x) + b * Math.log(1 - x) - lbeta) / a
  const TINY = 1e-30, EPS = 3e-7
  let C = 1
  let D = 1 / Math.max(1 - (a + b) * x / (a + 1), TINY)
  let result = D
  for (let m = 1; m <= 200; m++) {
    let aa = m * (b - m) * x / ((a + 2 * m - 1) * (a + 2 * m))
    D = 1 / Math.max(1 + aa * D, TINY); C = Math.max(1 + aa / C, TINY); result *= C * D
    aa = -(a + m) * (a + b + m) * x / ((a + 2 * m) * (a + 2 * m + 1))
    D = 1 / Math.max(1 + aa * D, TINY); C = Math.max(1 + aa / C, TINY)
    const delta = C * D; result *= delta
    if (Math.abs(delta - 1) < EPS) break
  }
  return front * result
}

// ── Student-t CDF (fat-tail, ν degrees of freedom) ────────────────────────────
// BTC log-returns have empirical ν ≈ 4 — much heavier tails than Gaussian.
// Replacing normalCDF in binary option pricing corrects tail probability by 10–25%.
export function studentTCDF(t: number, nu: number): number {
  const ib = incompleteBeta(nu / (nu + t * t), nu / 2, 0.5)
  return t >= 0 ? 1 - ib / 2 : ib / 2
}

// ── Fat-tail binary option pricing (Student-t digital) ────────────────────────
// Identical to log-normal binary but uses Student-t CDF(d₂, ν) instead of Φ(d₂).
// More accurate for BTC because normal CDF systematically underestimates strike crossings.
export function computeFatTailBinary(
  spot: number,
  strike: number,
  sigmaAnnualized: number,
  minutesLeft: number,
  nu = 4,
): { pYesFat: number; d2: number } | null {
  if (spot <= 0 || strike <= 0 || sigmaAnnualized <= 0 || minutesLeft <= 0) return null
  const T  = minutesLeft / (365 * 24 * 60)
  const d2 = (Math.log(spot / strike) - 0.5 * sigmaAnnualized ** 2 * T) /
             (sigmaAnnualized * Math.sqrt(T))
  return { pYesFat: studentTCDF(d2, nu), d2 }
}

// ── Logarithmic Opinion Pool ──────────────────────────────────────────────────
// Combines two calibrated binary forecasts: p_lop ∝ p1^w1 × p2^w2
// Formally derived from the independent-expert Bayesian combination theorem.
// Avoids the "regression to the mean" of linear pools — preserves forecast sharpness.
// Numerically stable via log-sum-exp trick.
export function logOpinionPool(p1: number, p2: number, w1: number, w2: number): number {
  p1 = Math.max(1e-9, Math.min(1 - 1e-9, p1))
  p2 = Math.max(1e-9, Math.min(1 - 1e-9, p2))
  const lyes = w1 * Math.log(p1)      + w2 * Math.log(p2)
  const lno  = w1 * Math.log(1 - p1)  + w2 * Math.log(1 - p2)
  const maxL = Math.max(lyes, lno)   // log-sum-exp for numerical stability
  return Math.exp(lyes - maxL) / (Math.exp(lyes - maxL) + Math.exp(lno - maxL))
}

// ── Hurst exponent (variance ratio method) ────────────────────────────────────
// H > 0.5: persistent trend (momentum extrapolation is valid)
// H < 0.5: anti-persistent / mean-reverting (expect reversion, fade extremes)
// H ≈ 0.5: random walk (no exploitable memory structure)
// Formula: H = 0.5 + log(Var(2-period) / 2Var(1-period)) / (2 log 2)
export function computeHurst(candles: OHLCVCandle[]): number | null {
  const closes = [...candles].reverse().map(c => c[4])
  if (closes.length < 8) return null
  const lr: number[] = []
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0) lr.push(Math.log(closes[i] / closes[i - 1]))
  }
  if (lr.length < 6) return null
  const var1 = lr.reduce((s, r) => s + r * r, 0) / lr.length
  const p2: number[] = []
  for (let i = 0; i + 1 < lr.length; i += 2) p2.push(lr[i] + lr[i + 1])
  const var2 = p2.reduce((s, r) => s + r * r, 0) / Math.max(p2.length, 1)
  if (var1 <= 0) return null
  return Math.max(0, Math.min(1, 0.5 + Math.log(Math.max(var2 / (2 * var1), 1e-12)) / (2 * Math.log(2))))
}

// ── CUSUM jump detector ───────────────────────────────────────────────────────
// Cumulative Sum control chart — detects sudden structural breaks in return series.
// k = reference shift magnitude (in σ units) to detect; h = decision threshold.
// Scores > h indicate a statistically significant directional price jump.
// When jumpDetected=true, diffusion-based physics models (Brownian/BS) are unreliable.
export function computeCUSUM(
  candles: OHLCVCandle[],
  k = 0.5,
  h = 4.0,
): { posScore: number; negScore: number; jumpDetected: boolean; direction: 'up' | 'down' | 'none' } {
  const closes = [...candles].reverse().map(c => c[4])
  if (closes.length < 4) return { posScore: 0, negScore: 0, jumpDetected: false, direction: 'none' }
  const lr: number[] = []
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0) lr.push(Math.log(closes[i] / closes[i - 1]))
  }
  const sigma = Math.sqrt(lr.reduce((s, r) => s + r * r, 0) / Math.max(lr.length, 1)) || 0.001
  let sPos = 0, sNeg = 0
  for (const r of lr) {
    const z = r / sigma
    sPos = Math.max(0, sPos + z - k)
    sNeg = Math.max(0, sNeg - z - k)
  }
  return {
    posScore:     sPos,
    negScore:     sNeg,
    jumpDetected: sPos > h || sNeg > h,
    direction:    sPos > h ? 'up' : sNeg > h ? 'down' : 'none',
  }
}

// ── Internal EMA helper (oldest-first closes array) ──────────────────────────
function emaFromCloses(closes: number[], period: number): number[] {
  if (closes.length < period) return []
  const k      = 2 / (period + 1)
  const result: number[] = []
  let   val    = closes.slice(0, period).reduce((a, b) => a + b, 0) / period
  result.push(val)
  for (let i = period; i < closes.length; i++) {
    val = closes[i] * k + val * (1 - k)
    result.push(val)
  }
  return result
}

// ── RSI ───────────────────────────────────────────────────────────────────────
// Period auto-capped at candles.length - 1 so it always returns a value
export function computeRSI(candles: OHLCVCandle[], period = 9): number | null {
  const closes = [...candles].reverse().map(c => c[4])
  const p      = Math.min(period, closes.length - 1)
  if (p < 2) return null
  let gains = 0, losses = 0
  for (let i = closes.length - p; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1]
    if (diff > 0) gains += diff; else losses += Math.abs(diff)
  }
  const avgGain = gains / p
  const avgLoss = losses / p
  if (avgLoss === 0) return 100
  return 100 - 100 / (1 + avgGain / avgLoss)
}

// ── MACD (adapted for 12-candle window: fast=5, slow=10, signal=3) ────────────
export function computeMACD(
  candles: OHLCVCandle[],
  fastP = 5, slowP = 10, signalP = 3,
): { macd: number; signal: number; histogram: number } | null {
  const closes  = [...candles].reverse().map(c => c[4])
  const fastEMA = emaFromCloses(closes, fastP)
  const slowEMA = emaFromCloses(closes, slowP)
  if (!fastEMA.length || !slowEMA.length) return null
  const offset   = fastEMA.length - slowEMA.length
  const macdLine = slowEMA.map((s, i) => fastEMA[i + offset] - s)
  const sigLine  = emaFromCloses(macdLine, signalP)
  if (!sigLine.length) return null
  const macdVal = macdLine[macdLine.length - 1]
  const sigVal  = sigLine[sigLine.length - 1]
  return { macd: macdVal, signal: sigVal, histogram: macdVal - sigVal }
}

// ── Bollinger %B ──────────────────────────────────────────────────────────────
// %B = (close - lower) / (upper - lower)  → 0=at lower band, 1=at upper, 0.5=SMA
// bandwidth = (upper - lower) / SMA  → high = volatile, low = squeeze
export function computeBollingerB(candles: OHLCVCandle[], period = 12): {
  pctB: number; bandwidth: number; sma: number; upper: number; lower: number
} | null {
  const closes = [...candles].reverse().map(c => c[4])
  const p      = Math.min(period, closes.length)
  if (p < 4) return null
  const recent = closes.slice(-p)
  const sma    = recent.reduce((a, b) => a + b, 0) / p
  const std    = Math.sqrt(recent.reduce((s, c) => s + (c - sma) ** 2, 0) / p)
  if (std === 0) return null
  const upper = sma + 2 * std
  const lower = sma - 2 * std
  const last  = closes[closes.length - 1]
  return {
    pctB:      Math.max(-0.3, Math.min(1.3, (last - lower) / (upper - lower))),
    bandwidth: (upper - lower) / sma,
    sma, upper, lower,
  }
}

// ── Stochastic %K ────────────────────────────────────────────────────────────
// Position of latest close within N-period high-low range → 0–100
export function computeStochastic(candles: OHLCVCandle[], period = 9): number | null {
  const p = Math.min(period, candles.length)
  if (p < 2) return null
  const recent    = candles.slice(0, p)                // newest-first
  const periodHi  = Math.max(...recent.map(c => c[2]))
  const periodLo  = Math.min(...recent.map(c => c[1]))
  if (periodHi === periodLo) return 50
  return ((candles[0][4] - periodLo) / (periodHi - periodLo)) * 100
}

// ── VWAP (approximated from OHLCV: typical price = (H+L+C)/3) ────────────────
export function computeVWAP(candles: OHLCVCandle[]): number | null {
  if (!candles.length) return null
  let num = 0, den = 0
  for (const [, low, high, , close, vol] of candles) {
    num += ((high + low + close) / 3) * vol
    den += vol
  }
  return den > 0 ? num / den : null
}

// ── Garman-Klass volatility estimator ────────────────────────────────────────
// Uses OHLC — 7.4× more efficient than close-to-close vol for i.i.d. GBM.
// σ²_GK = (1/N) Σ [ 0.5·(ln H/L)² − (2ln2−1)·(ln C/O)² ]
export function computeGarmanKlassVol(candles: OHLCVCandle[]): number | null {
  if (candles.length < 2) return null
  const K     = 2 * Math.log(2) - 1   // ≈ 0.3863
  const terms = candles.map(([, low, high, open, close]) => {
    if (open <= 0 || low <= 0 || high <= 0) return null
    return 0.5 * Math.log(high / low) ** 2 - K * Math.log(close / open) ** 2
  }).filter((v): v is number => v !== null)
  if (!terms.length) return null
  return Math.sqrt(Math.max(0, terms.reduce((a, b) => a + b, 0) / terms.length))
}

// ── Rate of Change (5-candle momentum) ───────────────────────────────────────
export function computeROC(candles: OHLCVCandle[], period = 5): number | null {
  if (candles.length < period + 1) return null
  const current = candles[0][4]
  const past    = candles[period][4]
  return past > 0 ? ((current - past) / past) * 100 : null
}

// ── Lag-1 return autocorrelation (regime detection) ──────────────────────────
// Positive → trending (momentum regime, extrapolate direction)
// Negative → mean-reverting (fade extremes)
// Near zero → random walk (no predictable structure)
export function computeReturnAutoCorr(candles: OHLCVCandle[]): number | null {
  const closes = [...candles].reverse().map(c => c[4])
  if (closes.length < 4) return null
  const returns: number[] = []
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0) returns.push(Math.log(closes[i] / closes[i - 1]))
  }
  const n    = returns.length - 1
  if (n < 2) return null
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length
  let cov = 0, vari = 0
  for (let i = 0; i < n; i++) {
    cov  += (returns[i] - mean) * (returns[i + 1] - mean)
    vari += (returns[i] - mean) ** 2
  }
  return vari > 0 ? cov / vari : null
}

// ── Price velocity on 1-min live candles ─────────────────────────────────────
// Slope of last N closes ($/min), and acceleration (change in slope)
export function computePriceVelocity(liveCandles: OHLCVCandle[], n = 5): {
  velocityPerMin: number   // $ per minute (positive = rising)
  acceleration: number     // change in velocity — positive = accelerating up
  direction: 'rising' | 'falling' | 'flat'
} | null {
  if (!liveCandles || liveCandles.length < n + 1) return null
  const recent = [...liveCandles].reverse().slice(-(n + 1))   // oldest-first
  // Least-squares slope over last n+1 points (minutes are the x-axis)
  const xs = recent.map((_, i) => i)
  const ys = recent.map(c => c[4])
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length
  const my = ys.reduce((a, b) => a + b, 0) / ys.length
  const slope = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0) /
                xs.reduce((s, x) => s + (x - mx) ** 2, 0)
  // Acceleration: compare slope of first half vs second half
  const half   = Math.floor(recent.length / 2)
  const slope1 = recent[half][4] - recent[0][4]           // early slope
  const slope2 = recent[recent.length - 1][4] - recent[half][4]  // late slope
  const accel  = slope2 - slope1
  return {
    velocityPerMin: slope,
    acceleration:   accel,
    direction: Math.abs(slope) < 1 ? 'flat' : slope > 0 ? 'rising' : 'falling',
  }
}

// ── Orderbook imbalance ───────────────────────────────────────────────────────
// Simple: (YES depth − NO depth) / total
// Pressure-weighted: near-mid price levels carry more weight (i×weight)
export function computeOrderbookImbalance(
  orderbook: KalshiOrderbook | null | undefined,
  depth = 6,
): { simple: number; pressureWeighted: number } | null {
  if (!orderbook) return null
  const yes = (orderbook.yes ?? []).slice(0, depth)
  const no  = (orderbook.no  ?? []).slice(0, depth)
  const yesD = yes.reduce((s, l) => s + Math.abs(l.delta ?? 0), 0)
  const noD  = no.reduce((s, l)  => s + Math.abs(l.delta ?? 0), 0)
  if (yesD + noD === 0) return null
  const simple = (yesD - noD) / (yesD + noD)
  // Closer to mid = higher index in Kalshi's sorted levels → higher weight
  const yesPW  = yes.reduce((s, l, i) => s + Math.abs(l.delta ?? 0) * (i + 1), 0)
  const noPW   = no.reduce((s, l, i)  => s + Math.abs(l.delta ?? 0) * (i + 1), 0)
  const totalPW = yesPW + noPW
  return {
    simple,
    pressureWeighted: totalPW > 0 ? (yesPW - noPW) / totalPW : simple,
  }
}

// ── Log-normal binary option pricing (Black-Scholes digital) ─────────────────
// For KXBTC15M: pays $1 if S_T > K. Fair value = Φ(d₂).
// d₂ = (ln(S/K) − 0.5σ²T) / (σ√T)  [drift = 0 for 15-min horizon]
export function computeLogNormalBinary(
  spot: number,
  strike: number,
  sigmaAnnualized: number,
  minutesLeft: number,
): { pYes: number; d2: number } | null {
  if (spot <= 0 || strike <= 0 || sigmaAnnualized <= 0 || minutesLeft <= 0) return null
  const T  = minutesLeft / (365 * 24 * 60)      // minutes → years
  const d2 = (Math.log(spot / strike) - 0.5 * sigmaAnnualized ** 2 * T) /
             (sigmaAnnualized * Math.sqrt(T))
  return { pYes: normalCDF(d2), d2 }
}

// ── Brownian motion prior (mean-absolute-return approximation) ────────────────
// Uses mean |candle return| as σ — fast, robust, already battle-tested.
function computeBrownianPrior(
  candles: OHLCVCandle[],
  distancePct: number,
  minutesLeft: number,
): { pQuant: number; sigmaCandle: number; sigmaPerMin: number } | null {
  if (!candles.length || minutesLeft <= 0) return null
  const absReturns  = candles.map(c => Math.abs((c[4] - c[3]) / c[3]))
  const sigmaCandle = absReturns.reduce((a, b) => a + b, 0) / absReturns.length
  if (sigmaCandle <= 0) return null
  const sigmaPerMin = sigmaCandle / Math.sqrt(15)
  const z           = (distancePct / 100) / (sigmaPerMin * Math.sqrt(minutesLeft))
  return { pQuant: normalCDF(z), sigmaCandle, sigmaPerMin }
}

// ── Composite signals ─────────────────────────────────────────────────────────
export interface QuantSignals {
  // Volatility
  gkVol15m:        number | null   // Garman-Klass per-candle vol
  gkVolAnnualized: number | null   // annualized (for BS pricing)
  expectedRangeUSD: number | null  // expected ±$ move in remaining window (1σ)
  // Momentum
  rsi:        number | null
  macd:       { macd: number; signal: number; histogram: number } | null
  bollingerB: { pctB: number; bandwidth: number; upper: number; lower: number; sma: number } | null
  stochastic: number | null
  roc:        number | null
  vwap:       number | null
  // Regime
  autocorr:   number | null
  // Live intra-window
  velocity:   { velocityPerMin: number; acceleration: number; direction: string } | null
  // Microstructure
  obImbalance: { simple: number; pressureWeighted: number } | null
  // Pricing models
  brownianPrior: { pQuant: number; sigmaCandle: number; sigmaPerMin: number } | null
  lnBinary:      { pYes: number; d2: number } | null
  fatTailBinary: { pYesFat: number; d2: number } | null  // Student-t (ν=4) — preferred for BTC fat tails
  // Long-memory & regime
  hurstExponent: number | null   // H>0.5 trending, H<0.5 mean-reverting, H≈0.5 random walk
  cusum:         { posScore: number; negScore: number; jumpDetected: boolean; direction: 'up' | 'down' | 'none' } | null
}

export function computeQuantSignals(
  candles:     OHLCVCandle[] | undefined,
  liveCandles: OHLCVCandle[] | undefined,
  orderbook:   KalshiOrderbook | null | undefined,
  spot:        number,
  strike:      number,
  distancePct: number,
  minutesLeft: number,
): QuantSignals {
  const gkVol15m        = candles ? computeGarmanKlassVol(candles) : null
  // BTC trades 24/7 — annualize over 365d × 24h × 4 candles/h = 35,040 periods/year
  const gkVolAnnualized = gkVol15m !== null ? gkVol15m * Math.sqrt(35_040) : null
  const brownianPrior   = candles ? computeBrownianPrior(candles, distancePct, minutesLeft) : null
  const lnBinary        = gkVolAnnualized !== null
    ? computeLogNormalBinary(spot, strike, gkVolAnnualized, minutesLeft)
    : null
  // Fat-tail binary uses Student-t(ν=4) instead of normal — more accurate for BTC tails
  const fatTailBinary   = gkVolAnnualized !== null
    ? computeFatTailBinary(spot, strike, gkVolAnnualized, minutesLeft)
    : null
  const expectedRangeUSD = brownianPrior
    ? brownianPrior.sigmaPerMin * Math.sqrt(minutesLeft) * spot
    : null

  return {
    gkVol15m,
    gkVolAnnualized,
    expectedRangeUSD,
    rsi:        candles ? computeRSI(candles) : null,
    macd:       candles ? computeMACD(candles) : null,
    bollingerB: candles ? computeBollingerB(candles) : null,
    stochastic: candles ? computeStochastic(candles) : null,
    roc:        candles ? computeROC(candles) : null,
    vwap:       candles ? computeVWAP(candles) : null,
    autocorr:   candles ? computeReturnAutoCorr(candles) : null,
    velocity:   liveCandles ? computePriceVelocity(liveCandles) : null,
    obImbalance: computeOrderbookImbalance(orderbook),
    brownianPrior,
    lnBinary,
    fatTailBinary,
    hurstExponent: candles ? computeHurst(candles) : null,
    cusum:         candles ? computeCUSUM(candles) : null,
  }
}

// ── Format as quant brief for LLM context ─────────────────────────────────────
export function formatQuantBrief(
  sig:         QuantSignals,
  spot:        number,
  distancePct: number,
  minutesLeft: number,
): string {
  const ds    = distancePct >= 0 ? '+' : ''
  const lines: string[] = ['══════ QUANTITATIVE SIGNALS ══════']

  // ── Pricing models ──────────────────────────────────────────────────────────
  lines.push('\n[PRICING MODELS — use as calibrated prior]')
  if (sig.brownianPrior) {
    const { pQuant, sigmaCandle } = sig.brownianPrior
    lines.push(
      `  Brownian motion P(YES):    ${(pQuant * 100).toFixed(2)}%` +
      `  [σ=${(sigmaCandle * 100).toFixed(3)}%/candle · d=${ds}${distancePct.toFixed(3)}% · t=${minutesLeft.toFixed(1)}min]`
    )
  }
  if (sig.lnBinary) {
    lines.push(
      `  Log-normal binary P(YES):  ${(sig.lnBinary.pYes * 100).toFixed(2)}%` +
      `  [d₂=${sig.lnBinary.d2.toFixed(4)} · σ=${sig.gkVolAnnualized !== null ? (sig.gkVolAnnualized * 100).toFixed(1) + '% ann (GK)' : 'n/a'}]`
    )
  }
  if (sig.fatTailBinary) {
    const diff = sig.lnBinary ? ((sig.fatTailBinary.pYesFat - sig.lnBinary.pYes) * 100) : 0
    lines.push(
      `  Fat-tail binary P(YES):    ${(sig.fatTailBinary.pYesFat * 100).toFixed(2)}%` +
      `  [ν=4 Student-t · ${diff >= 0 ? '+' : ''}${diff.toFixed(2)}pp vs normal — PREFERRED for BTC fat tails]`
    )
  }
  if (sig.gkVol15m !== null) {
    lines.push(
      `  Realized vol (GK):         ${(sig.gkVol15m * 100).toFixed(4)}%/candle  ` +
      `(${sig.gkVolAnnualized !== null ? (sig.gkVolAnnualized * 100).toFixed(0) + '% ann' : ''})`
    )
  }
  if (sig.expectedRangeUSD !== null) {
    lines.push(`  Expected ±$${sig.expectedRangeUSD.toFixed(0)} remaining move (1σ, Brownian)`)
  }
  lines.push(
    `  NOTE: Both models assume zero drift — valid for 15-min horizon. ` +
    `Deviate >15pp only with strong directional evidence from signals below.`
  )

  // ── Momentum ────────────────────────────────────────────────────────────────
  lines.push('\n[MOMENTUM & TREND]')
  if (sig.rsi !== null) {
    const lbl = sig.rsi > 70 ? '⚠ overbought — fading pressure likely' :
                sig.rsi < 30 ? '⚠ oversold — bounce pressure likely' : 'neutral zone'
    lines.push(`  RSI(9):           ${sig.rsi.toFixed(2)}  →  ${lbl}`)
  }
  if (sig.macd) {
    const dir    = sig.macd.histogram > 0 ? '▲ bullish' : '▼ bearish'
    const cross  = Math.abs(sig.macd.histogram) < 0.5 * Math.abs(sig.macd.signal)
      ? ' ← near crossover, momentum shift imminent' : ''
    lines.push(`  MACD(5,10,3):     hist=${sig.macd.histogram.toFixed(2)}  ${dir}${cross}`)
  }
  if (sig.bollingerB) {
    const bb  = sig.bollingerB
    const lbl = bb.pctB > 0.85 ? '⚠ above upper band — overextended' :
                bb.pctB < 0.15 ? '⚠ below lower band — overextended' :
                bb.pctB > 0.6  ? 'upper half' : 'lower half'
    const squeeze = bb.bandwidth < 0.002 ? '  ⚠ SQUEEZE — breakout likely' : ''
    lines.push(`  Bollinger %B(12): ${(bb.pctB * 100).toFixed(1)}%  [${lbl}]  bandwidth=${(bb.bandwidth * 100).toFixed(3)}%${squeeze}`)
  }
  if (sig.stochastic !== null) {
    const lbl = sig.stochastic > 80 ? 'overbought' : sig.stochastic < 20 ? 'oversold' : 'mid-range'
    lines.push(`  Stochastic %K(9): ${sig.stochastic.toFixed(1)}  →  ${lbl}`)
  }
  if (sig.roc !== null) {
    lines.push(`  ROC(5-candle):    ${sig.roc >= 0 ? '+' : ''}${sig.roc.toFixed(4)}%`)
  }
  if (sig.vwap !== null) {
    const vDiff = ((spot - sig.vwap) / sig.vwap) * 100
    lines.push(`  VWAP:             $${sig.vwap.toFixed(2)}  BTC ${vDiff >= 0 ? 'above' : 'below'} by ${Math.abs(vDiff).toFixed(3)}%`)
  }

  // ── Regime ──────────────────────────────────────────────────────────────────
  if (sig.autocorr !== null || sig.hurstExponent !== null) {
    lines.push('\n[REGIME]')
    if (sig.autocorr !== null) {
      const regime = sig.autocorr > 0.15 ? 'TRENDING — extrapolate current direction' :
                     sig.autocorr < -0.15 ? 'MEAN-REVERTING — fade extremes, expect reversal' :
                     'RANDOM WALK — no persistent structure'
      lines.push(`  Lag-1 autocorr:   ${sig.autocorr.toFixed(4)}  →  ${regime}`)
    }
    if (sig.hurstExponent !== null) {
      const H    = sig.hurstExponent
      const hlbl = H > 0.6 ? 'PERSISTENT — momentum has long memory, trend likely continues' :
                   H < 0.4 ? 'ANTI-PERSISTENT — mean-reversion likely, fade extremes' :
                   'RANDOM WALK — no exploitable long-memory structure'
      lines.push(`  Hurst exponent:   H=${H.toFixed(4)}  →  ${hlbl}`)
    }
  }
  if (sig.cusum) {
    if (sig.cusum.jumpDetected) {
      lines.push(
        `\n[⚡ CUSUM JUMP ALERT]  Structural break detected — direction: ${sig.cusum.direction.toUpperCase()}` +
        `  (S⁺=${sig.cusum.posScore.toFixed(2)}, S⁻=${sig.cusum.negScore.toFixed(2)})` +
        `\n  Diffusion physics (Brownian/BS) assume continuous returns — reduce their weight.` +
        `\n  Trust recent momentum + orderbook pressure over quantitative priors this cycle.`
      )
    } else {
      lines.push(`  CUSUM: S⁺=${sig.cusum.posScore.toFixed(2)}, S⁻=${sig.cusum.negScore.toFixed(2)}  → no structural break`)
    }
  }

  // ── Live intra-window velocity ───────────────────────────────────────────────
  if (sig.velocity) {
    const v    = sig.velocity
    const accelNote = Math.abs(v.acceleration) > 5
      ? (v.acceleration > 0 ? '  ↑ accelerating up' : '  ↓ decelerating / reversing')
      : '  → constant pace'
    lines.push(
      `\n[LIVE VELOCITY (1-min)]  ` +
      `${v.velocityPerMin >= 0 ? '+' : ''}$${v.velocityPerMin.toFixed(2)}/min  [${v.direction}]${accelNote}`
    )
    // Minutes to reach strike at current velocity
    if (Math.abs(v.velocityPerMin) > 0.5 && Math.abs(distancePct) > 0) {
      const distanceUSD   = Math.abs(distancePct / 100) * spot
      const minsToStrike  = distanceUSD / Math.abs(v.velocityPerMin)
      const willCross     = minutesLeft > minsToStrike
        ? (v.velocityPerMin > 0 && distancePct < 0) || (v.velocityPerMin < 0 && distancePct > 0)
          ? `⚠ At current velocity reaches strike in ~${minsToStrike.toFixed(1)}min (CROSS LIKELY)`
          : `  At current velocity reaches strike in ~${minsToStrike.toFixed(1)}min`
        : `  Strike unreachable at current velocity in ${minutesLeft.toFixed(1)}min remaining`
      lines.push(`  ${willCross}`)
    }
  }

  // ── Orderbook microstructure ─────────────────────────────────────────────────
  if (sig.obImbalance) {
    const { simple, pressureWeighted: pw } = sig.obImbalance
    const sentiment = pw > 0.2 ? 'strong YES buying pressure' :
                      pw < -0.2 ? 'strong NO buying pressure' :
                      Math.abs(pw) < 0.05 ? 'balanced — no clear edge' : (pw > 0 ? 'mild YES bias' : 'mild NO bias')
    lines.push(
      `\n[ORDERBOOK MICROSTRUCTURE]` +
      `\n  Depth imbalance:     ${simple >= 0 ? '+' : ''}${(simple * 100).toFixed(1)}%  (raw)` +
      `\n  Pressure-weighted:   ${pw >= 0 ? '+' : ''}${(pw * 100).toFixed(1)}%  →  ${sentiment}`
    )
  }

  lines.push('\n══════════════════════════════════')
  return lines.join('\n')
}
