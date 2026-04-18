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
import crypto from 'crypto'

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
// nu: degrees of freedom, calibrated to observed excess kurtosis for dynamic fitting.
export function computeFatTailBinary(
  spot: number,
  strike: number,
  sigmaAnnualized: number,
  minutesLeft: number,
  nu = 4,
): { pYesFat: number; d2: number; nu: number } | null {
  if (spot <= 0 || strike <= 0 || sigmaAnnualized <= 0 || minutesLeft <= 0) return null
  const T  = minutesLeft / (365 * 24 * 60)
  const d2 = (Math.log(spot / strike) - 0.5 * sigmaAnnualized ** 2 * T) /
              (sigmaAnnualized * Math.sqrt(T))
  return { pYesFat: studentTCDF(d2, nu), d2, nu }
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

// ── Bipower Variation (Barndorff-Nielsen & Shephard, 2004) ────────────────────
// Jump-robust realized volatility: BV = (π/2) × mean(|r_i| × |r_{i+1}|)
// Regular realized variance (RV) is inflated by jumps; BV filters them out.
// Jump ratio JR = RV/BV − 1 ≥ 0 measures the fraction of variance from discrete jumps.
// Use bvVol (not gkVol) in option pricing when jumps are detected.
export function computeBipowerVariation(candles: OHLCVCandle[]): {
  bv: number        // bipower variation (jump-robust variance)
  rv: number        // total realized variance
  jumpRatio: number // RV/BV − 1: proportion of variance attributable to jumps
  bvVol: number     // sqrt(BV): jump-robust per-candle vol
} | null {
  const closes = [...candles].reverse().map(c => c[4])
  if (closes.length < 4) return null
  const lr: number[] = []
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0) lr.push(Math.log(closes[i] / closes[i - 1]))
  }
  if (lr.length < 3) return null
  const rv = lr.reduce((s, r) => s + r * r, 0) / lr.length
  const bv = (Math.PI / 2) * lr.slice(1).reduce((s, r, i) => s + Math.abs(lr[i]) * Math.abs(r), 0) / (lr.length - 1)
  const jumpRatio = Math.max(0, rv / Math.max(bv, 1e-20) - 1)
  return { bv, rv, jumpRatio, bvVol: Math.sqrt(Math.max(bv, 0)) }
}

// ── Realized skewness + excess kurtosis ──────────────────────────────────────
// γ₁ = E[(r−μ)³] / σ³  (negative = left-tail heavier, BTC typically slightly negative)
// γ₂ = E[(r−μ)⁴] / σ⁴ − 3  (positive = fat tails, BTC typically 2–6)
export function computeSkewKurt(candles: OHLCVCandle[]): {
  skew: number
  excessKurt: number
} | null {
  const closes = [...candles].reverse().map(c => c[4])
  if (closes.length < 5) return null
  const lr: number[] = []
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0) lr.push(Math.log(closes[i] / closes[i - 1]))
  }
  const n = lr.length
  if (n < 4) return null
  const mean = lr.reduce((s, r) => s + r, 0) / n
  const m2 = lr.reduce((s, r) => s + (r - mean) ** 2, 0) / n
  const m3 = lr.reduce((s, r) => s + (r - mean) ** 3, 0) / n
  const m4 = lr.reduce((s, r) => s + (r - mean) ** 4, 0) / n
  if (m2 <= 0) return null
  return { skew: m3 / m2 ** 1.5, excessKurt: m4 / m2 ** 2 - 3 }
}

// ── Cornish-Fisher d₂ adjustment ──────────────────────────────────────────────
// Maps a standard normal quantile to the equivalent quantile of a distribution
// with observed skew γ₁ and excess kurtosis γ₂ (Edgeworth expansion, 2nd order).
// d₂_CF = z + (γ₁/6)(z²−1) + (γ₂/24)(z³−3z) − (γ₁²/36)(2z³−5z)
// Applying normalCDF(d₂_CF) yields a skew/kurtosis-corrected option price.
function cornishFisherAdjust(d2: number, skew: number, excessKurt: number): number {
  const z = d2
  return z
    + (skew / 6)          * (z * z - 1)
    + (excessKurt / 24)   * (z ** 3 - 3 * z)
    - ((skew * skew) / 36) * (2 * z ** 3 - 5 * z)
}

// ── Skew/kurtosis-adjusted binary option (Cornish-Fisher) ────────────────────
// Same d₂ formula as log-normal binary, but adjusted for empirical higher moments.
// Captures the asymmetric crash risk and fat-tail structure of BTC returns.
export function computeSkewAdjBinary(
  spot: number,
  strike: number,
  sigmaAnnualized: number,
  minutesLeft: number,
  skew: number,
  excessKurt: number,
): { pYesSkewAdj: number; d2: number; d2CF: number } | null {
  if (spot <= 0 || strike <= 0 || sigmaAnnualized <= 0 || minutesLeft <= 0) return null
  const T  = minutesLeft / (365 * 24 * 60)
  const d2 = (Math.log(spot / strike) - 0.5 * sigmaAnnualized ** 2 * T) /
             (sigmaAnnualized * Math.sqrt(T))
  const d2CF = cornishFisherAdjust(d2, skew, excessKurt)
  return { pYesSkewAdj: normalCDF(d2CF), d2, d2CF }
}

// ── Binary option Greeks (Delta, Theta) ───────────────────────────────────────
// Delta Δ = ∂P/∂S = φ(d₂)/(σ·S·√T)  — probability gain per $1 BTC price move
// Theta Θ = ∂P/∂t (per minute) = −φ(d₂)·σ/(2√T) × (1 / (365·24·60))
// High |Δ| → near the strike, very price-sensitive.
// High |Θ| → time is rapidly collapsing the distribution toward the current spot.
export function computeBinaryGreeks(
  spot: number,
  strike: number,
  sigmaAnnualized: number,
  minutesLeft: number,
): { delta: number; thetaPerMin: number; d2: number } | null {
  if (spot <= 0 || strike <= 0 || sigmaAnnualized <= 0 || minutesLeft <= 0) return null
  const T   = minutesLeft / (365 * 24 * 60)
  const sqT = Math.sqrt(T)
  const d2  = (Math.log(spot / strike) - 0.5 * sigmaAnnualized ** 2 * T) /
              (sigmaAnnualized * sqT)
  const phi = Math.exp(-0.5 * d2 * d2) / Math.sqrt(2 * Math.PI)
  return {
    delta:      phi / (sigmaAnnualized * spot * sqT),
    thetaPerMin: -(phi * sigmaAnnualized * spot) / (2 * sqT) / (365 * 24 * 60),
    d2,
  }
}

// ── Volatility of Volatility (VoV) ────────────────────────────────────────────
// Coefficient of variation of |log-returns|: VoV = std(|r|) / mean(|r|)
// High VoV → vol is itself unstable → quant pricing models less reliable this cycle.
// Low VoV  → vol is stable → models can be trusted more.
export function computeVolOfVol(candles: OHLCVCandle[]): number | null {
  const closes = [...candles].reverse().map(c => c[4])
  if (closes.length < 5) return null
  const absRets: number[] = []
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0) absRets.push(Math.abs(Math.log(closes[i] / closes[i - 1])))
  }
  if (absRets.length < 4) return null
  const mean = absRets.reduce((s, r) => s + r, 0) / absRets.length
  const std  = Math.sqrt(absRets.reduce((s, r) => s + (r - mean) ** 2, 0) / absRets.length)
  return mean > 0 ? std / mean : null
}

// ── Orderbook-implied probability ─────────────────────────────────────────────
// Converts pressure-weighted orderbook imbalance to a P(YES) point estimate.
// Buyers paying up for YES = crowd expects YES; pressure maps linearly to [0.20, 0.80].
// Treated as a weak auxiliary signal in the LOP (lower weight than pricing models).
export function computeOrderbookImpliedProb(
  obImbalance: { simple: number; pressureWeighted: number } | null,
): number | null {
  if (!obImbalance) return null
  const pw = Math.max(-1, Math.min(1, obImbalance.pressureWeighted))
  return Math.max(0.05, Math.min(0.95, 0.5 + pw * 0.30))
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

// ── Average True Range (ATR) ──────────────────────────────────────────────────
// Empirical price range per candle — more robust than σ-based expected range.
// Accounts for gap opens between candles that Brownian models miss.
export function computeATR(candles: OHLCVCandle[], period = 9): number | null {
  if (candles.length < 2) return null
  const ordered = [...candles].reverse()  // oldest first
  const trs: number[] = []
  for (let i = 1; i < ordered.length; i++) {
    const [, low, high] = ordered[i]
    const prevClose = ordered[i - 1][4]
    trs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)))
  }
  if (!trs.length) return null
  const p = Math.min(period, trs.length)
  return trs.slice(-p).reduce((a, b) => a + b, 0) / p
}

// ── Volume trend ──────────────────────────────────────────────────────────────
// Compares latest candle volume to recent average. High volume on a move = conviction.
// Low volume on a move = suspect — likely to fade.
export function computeVolumeTrend(candles: OHLCVCandle[], period = 5): {
  avgVolume: number
  latestVolume: number
  trend: 'increasing' | 'decreasing' | 'flat'
  ratio: number   // latestVolume / avgVolume: >1.25 = increasing, <0.75 = decreasing
} | null {
  if (candles.length < 2) return null
  const recent = candles.slice(0, Math.min(period, candles.length))
  const volumes = recent.map(c => c[5])
  const avgVolume = volumes.reduce((a, b) => a + b, 0) / volumes.length
  const latestVolume = candles[0][5]
  const ratio = avgVolume > 0 ? latestVolume / avgVolume : 1
  return {
    avgVolume,
    latestVolume,
    ratio,
    trend: ratio > 1.25 ? 'increasing' : ratio < 0.75 ? 'decreasing' : 'flat',
  }
}

// ── 1-min micro-momentum (current window green/red streak) ────────────────────
// Fraction of recent 1-min candles that are green (close >= open).
// >65% green = strong short-term bullish pressure. <35% = bearish.
// Streak: consecutive same-direction candles — length indicates momentum conviction.
export function computeMicroMomentum(liveCandles: OHLCVCandle[], n = 8): {
  greenFraction: number   // 0–1 fraction of recent 1-min candles that are green
  streak: number          // +N = N consecutive green, −N = N consecutive red (newest first)
  direction: 'up' | 'down' | 'mixed'
} | null {
  if (!liveCandles?.length) return null
  const recent = liveCandles.slice(0, Math.min(n, liveCandles.length))
  const isGreen = (c: OHLCVCandle) => c[4] >= c[3]
  const greens = recent.filter(isGreen).length
  const greenFraction = greens / recent.length
  let streak = 0
  const firstDir = isGreen(recent[0])
  for (const c of recent) {
    if (isGreen(c) === firstDir) streak++
    else break
  }
  return {
    greenFraction,
    streak: firstDir ? streak : -streak,
    direction: greenFraction > 0.65 ? 'up' : greenFraction < 0.35 ? 'down' : 'mixed',
  }
}

// ── On-Balance Volume (OBV) ───────────────────────────────────────────────────
// Cumulative volume-in-direction-of-price. Rising OBV on up moves = smart money
// confirming the move. Divergence (price up, OBV falling) = warning sign.
function computeOBV(candles: OHLCVCandle[]): {
  trend: 'rising' | 'falling' | 'flat'
  changeRate: number  // fractional change in OBV over last 6 candles
} | null {
  if (candles.length < 6) return null
  const ordered = [...candles].reverse()  // oldest first
  let obv = 0
  const obvSeries: number[] = [0]
  for (let i = 1; i < ordered.length; i++) {
    const close = ordered[i][4], prevClose = ordered[i - 1][4], vol = ordered[i][5]
    if (close > prevClose) obv += vol
    else if (close < prevClose) obv -= vol
    obvSeries.push(obv)
  }
  const n = obvSeries.length
  const recent = obvSeries.slice(-3).reduce((a, b) => a + b, 0) / 3
  const prior  = obvSeries.slice(-6, -3).reduce((a, b) => a + b, 0) / 3
  const absBase = Math.max(Math.abs(prior), 1e-9)
  const changeRate = (recent - prior) / absBase
  return {
    trend: changeRate > 0.05 ? 'rising' : changeRate < -0.05 ? 'falling' : 'flat',
    changeRate,
  }
}

// ── Money Flow Index (MFI) ────────────────────────────────────────────────────
// RSI weighted by dollar volume flow: MFI > 80 = overbought (bearish pressure likely),
// MFI < 20 = oversold (bullish pressure likely). Filters out volume-less price moves.
function computeMFI(candles: OHLCVCandle[], period = 9): number | null {
  if (candles.length < period + 1) return null
  const ordered = [...candles].reverse()
  const recent  = ordered.slice(-(period + 1))
  let posFlow = 0, negFlow = 0
  for (let i = 1; i < recent.length; i++) {
    const [, lo, hi, , cl, vol] = recent[i]
    const [, pLo, pHi, , pCl] = recent[i - 1]
    const tp  = (hi + lo + cl) / 3
    const pTp = (pHi + pLo + pCl) / 3
    const rawFlow = tp * vol
    if (tp > pTp) posFlow += rawFlow
    else if (tp < pTp) negFlow += rawFlow
  }
  if (negFlow === 0) return 100
  return 100 - (100 / (1 + posFlow / negFlow))
}

// ── Efficiency Ratio (Perry Kaufman, 1995) ────────────────────────────────────
// ER = net directional move / total path length. Range: 0 (random) → 1 (perfect trend).
// More intuitive than Hurst for short timeframes — directly measures trend quality.
// ER > 0.6 = strong trend (trust momentum signals). ER < 0.3 = choppy (fade extremes).
function computeEfficiencyRatio(candles: OHLCVCandle[], period = 10): number | null {
  const p = Math.min(period, candles.length)
  if (p < 4) return null
  const ordered = [...candles].reverse()
  const recent  = ordered.slice(-p)
  const netMove = Math.abs(recent[p - 1][4] - recent[0][4])
  let totalPath = 0
  for (let i = 1; i < recent.length; i++) totalPath += Math.abs(recent[i][4] - recent[i - 1][4])
  return totalPath === 0 ? 0 : Math.min(1, netMove / totalPath)
}

// ── Donchian channel + %rank ──────────────────────────────────────────────────
// %rank = where current price sits within N-period high-low range.
// 0 = at range low (support), 1 = at range high (resistance / breakout).
// Breakout above 0.95 or below 0.05 = potential trend acceleration.
function computeDonchian(candles: OHLCVCandle[], period = 12): {
  upper: number; lower: number; pctRank: number
} | null {
  const p = Math.min(period, candles.length)
  if (p < 3) return null
  const recent = candles.slice(0, p)
  const upper  = Math.max(...recent.map(c => c[2]))
  const lower  = Math.min(...recent.map(c => c[1]))
  if (upper === lower) return null
  return { upper, lower, pctRank: Math.max(0, Math.min(1, (candles[0][4] - lower) / (upper - lower))) }
}

// ── Price Z-score (mean reversion signal) ─────────────────────────────────────
// How many std deviations current close is from N-candle rolling mean.
// |Z| > 2 = statistically extreme — mean reversion pressure increases.
// |Z| < 0.5 = near center of recent range — no mean-reversion edge.
function computePriceZScore(candles: OHLCVCandle[], period = 12): number | null {
  const p = Math.min(period, candles.length)
  if (p < 4) return null
  const closes = candles.slice(0, p).map(c => c[4])
  const mean   = closes.reduce((a, b) => a + b, 0) / closes.length
  const std    = Math.sqrt(closes.reduce((s, c) => s + (c - mean) ** 2, 0) / closes.length)
  return std > 0 ? (closes[0] - mean) / std : 0
}

// ── RSI divergence (4-candle lookback) ────────────────────────────────────────
// Bullish: price lower low but RSI higher low → hidden bullish momentum.
// Bearish: price higher high but RSI lower high → hidden bearish momentum.
// Both are high-conviction reversal signals when at oscillator extremes.
function detectRSIDivergence(candles: OHLCVCandle[]): {
  type: 'bullish' | 'bearish' | 'none'
} | null {
  if (candles.length < 8) return null
  const rsiNow  = computeRSI(candles, 9)
  const rsiOld  = computeRSI(candles.slice(4), 9)
  if (rsiNow === null || rsiOld === null) return null
  const priceNow = candles[0][4], priceOld = candles[4][4]
  const priceUp  = priceNow > priceOld
  const rsiUp    = rsiNow > rsiOld
  if (priceUp && !rsiUp) return { type: 'bearish' }
  if (!priceUp && rsiUp) return { type: 'bullish' }
  return { type: 'none' }
}

// ── MACD histogram slope (momentum acceleration) ──────────────────────────────
// Rate of change of the MACD histogram: positive = momentum building (confirm direction),
// negative = momentum fading (potential reversal even if histogram still positive).
function computeMACDSlope(candles: OHLCVCandle[]): number | null {
  if (candles.length < 14) return null
  const now  = computeMACD(candles)
  const prev = computeMACD(candles.slice(1))
  if (!now || !prev) return null
  return now.histogram - prev.histogram
}

// ── 1-min candle pattern detection ───────────────────────────────────────────
// Detects classic single-candle reversal patterns on the most recent 1-min candle.
// Hammer: long lower wick, small body at top → bullish reversal signal.
// Shooting star: long upper wick, small body at bottom → bearish reversal signal.
// Doji: tiny body → indecision, potential reversal.
// Engulfing: current candle body engulfs prior candle body (strong reversal signal).
function detectCandlePattern(liveCandles: OHLCVCandle[]): {
  type: 'hammer' | 'shooting_star' | 'doji' | 'engulfing_bull' | 'engulfing_bear' | 'none'
  strength: number   // 0–1
} | null {
  if (!liveCandles?.length) return null
  const [, lo, hi, op, cl] = liveCandles[0]
  const range = hi - lo
  if (range === 0) return { type: 'doji', strength: 1 }
  const body      = Math.abs(cl - op)
  const bodyRatio = body / range
  const upperWick = hi - Math.max(op, cl)
  const lowerWick = Math.min(op, cl) - lo
  // Doji
  if (bodyRatio < 0.1) return { type: 'doji', strength: 1 - bodyRatio * 5 }
  // Hammer: long lower wick, small body, close > open
  if (lowerWick > 2 * body && upperWick < body * 0.5 && cl >= op)
    return { type: 'hammer', strength: Math.min(1, lowerWick / (3 * body)) }
  // Shooting star: long upper wick, small body, close < open
  if (upperWick > 2 * body && lowerWick < body * 0.5 && cl < op)
    return { type: 'shooting_star', strength: Math.min(1, upperWick / (3 * body)) }
  // Engulfing (requires previous candle)
  if (liveCandles.length >= 2) {
    const [, , , pOp, pCl] = liveCandles[1]
    const prevBody = Math.abs(pCl - pOp)
    if (prevBody > 0) {
      if (pCl < pOp && cl >= op && body > prevBody && op <= pCl && cl >= pOp)
        return { type: 'engulfing_bull', strength: Math.min(1, body / prevBody - 1) }
      if (pCl >= pOp && cl < op && body > prevBody && op >= pCl && cl <= pOp)
        return { type: 'engulfing_bear', strength: Math.min(1, body / prevBody - 1) }
    }
  }
  return { type: 'none', strength: 0 }
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
  const ssx   = xs.reduce((s, x) => s + (x - mx) ** 2, 0)
  const slope = ssx > 0
    ? xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0) / ssx
    : 0  // all candles same timestamp — flat, treat as zero velocity
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
  fatTailBinary: { pYesFat: number; d2: number; nu: number } | null                    // Student-t (dynamic ν)
  skewAdjBinary: { pYesSkewAdj: number; d2: number; d2CF: number } | null  // Cornish-Fisher
  binaryGreeks:  { delta: number; thetaPerMin: number; d2: number } | null // Δ and Θ
  // Long-memory & regime
  hurstExponent:  number | null
  cusum:          { posScore: number; negScore: number; jumpDetected: boolean; direction: 'up' | 'down' | 'none' } | null
  // Higher-moment volatility
  bipowerVar:    { bv: number; rv: number; jumpRatio: number; bvVol: number } | null
  skewKurt:      { skew: number; excessKurt: number } | null
  volOfVol:      number | null  // coefficient of variation of |returns|
  // Auxiliary probability
  obImpliedProb: number | null  // orderbook-implied P(YES) ∈ [0.05, 0.95]
  // Additional signals
  atr:            number | null  // Average True Range per candle ($)
  volumeTrend:    { avgVolume: number; latestVolume: number; trend: string; ratio: number } | null
  microMomentum:  { greenFraction: number; streak: number; direction: string } | null  // 1-min micro-momentum
  intraVwap:      number | null  // VWAP over current window (1-min candles)
  // Multi-timeframe trend (1h and 4h candles)
  trend1h:        { direction: 'bullish' | 'bearish' | 'flat'; netChangePct: number; upFraction: number; streak: number } | null
  trend4h:        { direction: 'bullish' | 'bearish' | 'flat'; netChangePct: number; upFraction: number; streak: number } | null
  // Extended signals (no external API needed)
  obv:            { trend: 'rising' | 'falling' | 'flat'; changeRate: number } | null
  mfi:            number | null  // Money Flow Index 0-100
  efficiencyRatio: number | null  // 0=random walk, 1=perfect trend
  donchian:       { upper: number; lower: number; pctRank: number } | null
  priceZScore:    number | null  // std deviations from 12-candle mean
  rsiDivergence:  { type: 'bullish' | 'bearish' | 'none' } | null
  macdSlope:      number | null  // rate of change of MACD histogram (momentum accel)
  candlePattern:  { type: string; strength: number } | null  // 1-min pattern
}

// ── Calibrate Student-t ν from sample excess kurtosis ─────────────────────────
// Excess kurtosis γ₂ = E[(r-μ)^4] / σ^4 - 3 for Student-t reduces to 6/(ν-4) for ν>4
// Invert: ν ≈ 4 + 6/γ₂ (cap at 4min, 20max for stability)
function calibrateStudentNu(skewKurt: { skew: number; excessKurt: number }): number {
  if (skewKurt.excessKurt <= 0) return 4
  return Math.max(4, Math.min(20, 4 + 6 / skewKurt.excessKurt))
}

// ── Multi-timeframe trend helper ──────────────────────────────────────────────
function computeTrend(
  candles: OHLCVCandle[] | undefined,
): { direction: 'bullish' | 'bearish' | 'flat'; netChangePct: number; upFraction: number; streak: number } | null {
  if (!candles || candles.length < 2) return null
  // candles are newest-first; reverse to oldest-first for streak calc
  const ordered = [...candles].reverse()
  const upCount = ordered.filter(c => c[4] >= c[3]).length
  const netChangePct = ordered.length
    ? ((ordered[ordered.length - 1][4] - ordered[0][3]) / ordered[0][3]) * 100
    : 0
  const direction: 'bullish' | 'bearish' | 'flat' =
    netChangePct >= 0.15 ? 'bullish' : netChangePct <= -0.15 ? 'bearish' : 'flat'
  // Consecutive streak from newest (candles[0])
  let streak = 1
  const isUp = candles[0][4] >= candles[0][3]
  for (let i = 1; i < candles.length; i++) {
    if ((candles[i][4] >= candles[i][3]) === isUp) streak++
    else break
  }
  return { direction, netChangePct, upFraction: upCount / ordered.length, streak }
}

const quantCache = new Map<string, QuantSignals>()

export function computeQuantSignals(
  candles:     OHLCVCandle[] | undefined,
  liveCandles: OHLCVCandle[] | undefined,
  orderbook:   KalshiOrderbook | null | undefined,
  spot:        number,
  strike:      number,
  distancePct: number,
  minutesLeft: number,
  candles1h?:  OHLCVCandle[],  // 1h candles, newest first — intraday trend
  candles4h?:  OHLCVCandle[],  // 4h candles, newest first — macro trend
): QuantSignals {
  const input = {candles, liveCandles, orderbook, spot, strike, distancePct, minutesLeft, candles1h, candles4h}
  const key = crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex')
  if (quantCache.has(key)) return quantCache.get(key)!
  const gkVol15m        = candles ? computeGarmanKlassVol(candles) : null
  // BTC trades 24/7 — annualize over 365d × 24h × 4 candles/h = 35,040 periods/year
  const gkVolAnnualized = gkVol15m !== null ? gkVol15m * Math.sqrt(35_040) : null
  const brownianPrior   = candles ? computeBrownianPrior(candles, distancePct, minutesLeft) : null
  const lnBinary        = gkVolAnnualized !== null
    ? computeLogNormalBinary(spot, strike, gkVolAnnualized, minutesLeft)
    : null

  // Compute skew/kurt for dynamic Student-t tail calibration
  const skewKurt = candles ? computeSkewKurt(candles) : null
  const dynamicNu = skewKurt ? calibrateStudentNu(skewKurt) : 4

  // Fat-tail binary uses Student-t(ν from data) instead of normal — more accurate for BTC tails
  const fatTailBinary   = gkVolAnnualized !== null
    ? computeFatTailBinary(spot, strike, gkVolAnnualized, minutesLeft, dynamicNu)
    : null
  const expectedRangeUSD = brownianPrior
    ? brownianPrior.sigmaPerMin * Math.sqrt(minutesLeft) * spot
    : null

  // Higher-moment analysis
  const bipowerVar = candles ? computeBipowerVariation(candles) : null
  const volOfVol   = candles ? computeVolOfVol(candles) : null

  // Cornish-Fisher skew/kurtosis-adjusted binary
  // When jumps detected, prefer bipower vol (jump-robust) over GK vol
  const bvAnnualized = bipowerVar
    ? bipowerVar.bvVol * Math.sqrt(35_040)
    : gkVolAnnualized
  const sigmaForSkewAdj = (bipowerVar && bipowerVar.jumpRatio > 0.3)
    ? (bvAnnualized ?? gkVolAnnualized)
    : gkVolAnnualized
  const skewAdjBinary = sigmaForSkewAdj !== null && skewKurt !== null
    ? computeSkewAdjBinary(spot, strike, sigmaForSkewAdj, minutesLeft, skewKurt.skew, skewKurt.excessKurt)
    : null

  // Binary Greeks — use bipower vol when jumps present, else GK
  const binaryGreeks = sigmaForSkewAdj !== null
    ? computeBinaryGreeks(spot, strike, sigmaForSkewAdj, minutesLeft)
    : null

  const obImbalance   = computeOrderbookImbalance(orderbook)
  const obImpliedProb = computeOrderbookImpliedProb(obImbalance)

  const atr            = candles ? computeATR(candles) : null
  const volumeTrend    = candles ? computeVolumeTrend(candles) : null
  const microMomentum  = liveCandles ? computeMicroMomentum(liveCandles) : null
  const intraVwap      = liveCandles ? computeVWAP(liveCandles) : null
  const obv            = candles ? computeOBV(candles) : null
  const mfi            = candles ? computeMFI(candles) : null
  const efficiencyRatio = candles ? computeEfficiencyRatio(candles) : null
  const donchian       = candles ? computeDonchian(candles) : null
  const priceZScore    = candles ? computePriceZScore(candles) : null
  const rsiDivergence  = candles ? detectRSIDivergence(candles) : null
  const macdSlope      = candles ? computeMACDSlope(candles) : null
  const candlePattern  = liveCandles ? detectCandlePattern(liveCandles) : null

  const result: QuantSignals = {
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
    obImbalance,
    atr,
    volumeTrend,
    microMomentum,
    intraVwap,
    obv,
    mfi,
    efficiencyRatio,
    donchian,
    priceZScore,
    rsiDivergence,
    macdSlope,
    candlePattern,
    brownianPrior,
    lnBinary,
    fatTailBinary,
    skewAdjBinary,
    binaryGreeks,
    hurstExponent: candles ? computeHurst(candles) : null,
    cusum:         candles ? computeCUSUM(candles) : null,
    bipowerVar,
    skewKurt,
    volOfVol,
    obImpliedProb,
    trend1h: computeTrend(candles1h),
    trend4h: computeTrend(candles4h),
  }
  quantCache.set(key, result)
  return result
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

  // ── Multi-timeframe trend ───────────────────────────────────────────────────
  if (sig.trend4h || sig.trend1h) {
    lines.push('\n[MULTI-TIMEFRAME TREND — anchor your directional prior here]')
    if (sig.trend4h) {
      const t = sig.trend4h
      const streak = `${t.streak}-candle ${t.direction === 'bullish' ? '▲' : t.direction === 'bearish' ? '▼' : '—'} streak`
      lines.push(
        `  4h macro trend:   ${t.direction.toUpperCase().padEnd(7)} | net ${t.netChangePct >= 0 ? '+' : ''}${t.netChangePct.toFixed(2)}% | ${Math.round(t.upFraction * 100)}% candles up | ${streak}`
      )
    }
    if (sig.trend1h) {
      const t = sig.trend1h
      const streak = `${t.streak}-candle ${t.direction === 'bullish' ? '▲' : t.direction === 'bearish' ? '▼' : '—'} streak`
      lines.push(
        `  1h intraday trend: ${t.direction.toUpperCase().padEnd(7)} | net ${t.netChangePct >= 0 ? '+' : ''}${t.netChangePct.toFixed(2)}% | ${Math.round(t.upFraction * 100)}% candles up | ${streak}`
      )
    }
    // Alignment note
    const t4 = sig.trend4h?.direction
    const t1 = sig.trend1h?.direction
    if (t4 && t1) {
      if (t4 === t1 && t4 !== 'flat') {
        lines.push(`  → ALIGNED ${t4.toUpperCase()}: Both timeframes agree — strong prior. A single 15m counter-move is likely noise.`)
      } else if (t4 !== 'flat' && t1 !== 'flat' && t4 !== t1) {
        lines.push(`  → CONFLICTED: 4h is ${t4.toUpperCase()}, 1h is ${t1.toUpperCase()}. Intraday trend is reversing vs macro. Weight d-score + orderbook heavily.`)
      }
    }
  }

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
      `  [ν=4 Student-t · ${diff >= 0 ? '+' : ''}${diff.toFixed(2)}pp vs normal]`
    )
  }
  if (sig.skewAdjBinary) {
    const cf = sig.skewAdjBinary
    const sk = sig.skewKurt
    lines.push(
      `  Cornish-Fisher P(YES):     ${(cf.pYesSkewAdj * 100).toFixed(2)}%` +
      `  [d₂=${cf.d2.toFixed(3)} → d₂_CF=${cf.d2CF.toFixed(3)}` +
      (sk ? `  γ₁=${cf.d2 < cf.d2CF ? '+' : ''}${sk.skew.toFixed(3)} γ₂=${sk.excessKurt.toFixed(2)}` : '') +
      `]`
    )
  }
  if (sig.bipowerVar) {
    const bv = sig.bipowerVar
    const jr = bv.jumpRatio
    lines.push(
      `  Bipower variation vol:     ${(bv.bvVol * 100).toFixed(4)}%/candle (jump-robust)` +
      `  [JR=${jr.toFixed(3)} — ${jr > 0.3 ? '⚠ JUMP VARIANCE DOMINATES: use bvVol for pricing' : jr > 0.1 ? 'moderate jump component' : 'continuous diffusion regime'}]`
    )
  }
  if (sig.binaryGreeks) {
    const g = sig.binaryGreeks
    lines.push(
      `  Binary Greeks:  Δ=${g.delta.toFixed(6)}/$ BTC  Θ=${(g.thetaPerMin * 100).toFixed(6)}pp/min` +
      `  [Δ near-ATM if Δ×$1000>0.5%; Θ shows P decay rate — high Θ = fast time kill]`
    )
  }
  if (sig.volOfVol !== null) {
    const vov = sig.volOfVol
    lines.push(
      `  Vol-of-Vol (VoV):          ${vov.toFixed(3)}` +
      `  [${vov > 1.0 ? '⚠ HIGH — vol unstable, quant models less reliable' : vov > 0.6 ? 'moderate vol instability' : 'stable vol — quant models reliable'}]`
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
  if (sig.atr !== null) {
    lines.push(
      `  ATR(9):                    $${sig.atr.toFixed(0)}/candle (empirical range)` +
      (sig.expectedRangeUSD !== null
        ? `  [${sig.atr > sig.expectedRangeUSD ? 'ATR>1σ: fatter tails than model' : 'ATR<1σ: model may overstate range'}]`
        : '')
    )
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
    lines.push(`  VWAP (15-min):    $${sig.vwap.toFixed(2)}  BTC ${vDiff >= 0 ? 'above' : 'below'} by ${Math.abs(vDiff).toFixed(3)}%`)
  }
  if (sig.intraVwap !== null) {
    const ivDiff = ((spot - sig.intraVwap) / sig.intraVwap) * 100
    lines.push(`  VWAP (1-min):     $${sig.intraVwap.toFixed(2)}  BTC ${ivDiff >= 0 ? 'above' : 'below'} by ${Math.abs(ivDiff).toFixed(3)}% — intra-window`)
  }
  if (sig.volumeTrend !== null) {
    const vt = sig.volumeTrend
    const lbl = vt.trend === 'increasing' ? '▲ above avg — conviction move' :
                vt.trend === 'decreasing' ? '▼ below avg — suspect, may fade' : '→ average'
    lines.push(`  Volume trend:     ${vt.ratio.toFixed(2)}× avg  →  ${lbl}`)
  }
  if (sig.microMomentum !== null) {
    const mm = sig.microMomentum
    const streakStr = mm.streak > 0 ? `${mm.streak} consecutive GREEN` : `${Math.abs(mm.streak)} consecutive RED`
    const convLbl = Math.abs(mm.streak) >= 5 ? ' — HIGH CONVICTION' : Math.abs(mm.streak) >= 3 ? ' — moderate' : ''
    lines.push(
      `  1-min momentum:   ${(mm.greenFraction * 100).toFixed(0)}% green bars` +
      `  [${streakStr}${convLbl}]` +
      `  → ${mm.direction.toUpperCase()}`
    )
  }
  if (sig.candlePattern !== null && sig.candlePattern.type !== 'none') {
    const cp = sig.candlePattern
    const desc: Record<string, string> = {
      hammer:         '🔨 HAMMER — bullish reversal signal on 1-min',
      shooting_star:  '⭐ SHOOTING STAR — bearish reversal signal on 1-min',
      doji:           '⊥ DOJI — indecision / potential reversal on 1-min',
      engulfing_bull: '▲ BULLISH ENGULFING — strong bullish reversal signal',
      engulfing_bear: '▼ BEARISH ENGULFING — strong bearish reversal signal',
    }
    lines.push(`  1-min pattern:    ${desc[cp.type] ?? cp.type}  (strength: ${(cp.strength * 100).toFixed(0)}%)`)
  }
  if (sig.obv !== null) {
    const obv = sig.obv
    const lbl = obv.trend === 'rising'  ? '▲ RISING — volume confirms bullish move' :
                obv.trend === 'falling' ? '▼ FALLING — volume confirms bearish move or warns of bull fade' :
                                          '→ flat'
    lines.push(`  OBV trend:        ${lbl}  (Δ${obv.changeRate >= 0 ? '+' : ''}${(obv.changeRate * 100).toFixed(1)}%)`)
  }
  if (sig.mfi !== null) {
    const lbl = sig.mfi > 80 ? '⚠ overbought — reversal pressure (volume confirms)' :
                sig.mfi < 20 ? '⚠ oversold — bounce pressure (volume confirms)' :
                sig.mfi > 60 ? 'bullish zone' : sig.mfi < 40 ? 'bearish zone' : 'neutral'
    lines.push(`  MFI(9):           ${sig.mfi.toFixed(1)}  →  ${lbl}`)
  }
  if (sig.efficiencyRatio !== null) {
    const er = sig.efficiencyRatio
    const lbl = er > 0.6 ? 'STRONG TREND — momentum signals highly reliable' :
                er > 0.35 ? 'moderate trend' :
                'CHOPPY / RANDOM — fade extremes, momentum signals unreliable'
    lines.push(`  Efficiency Ratio: ${er.toFixed(3)}  →  ${lbl}`)
  }
  if (sig.rsiDivergence !== null && sig.rsiDivergence.type !== 'none') {
    const rdiv = sig.rsiDivergence
    const desc = rdiv.type === 'bullish'
      ? '⚡ BULLISH DIVERGENCE — price lower low, RSI higher low → hidden bullish pressure, potential reversal UP'
      : '⚡ BEARISH DIVERGENCE — price higher high, RSI lower high → hidden bearish pressure, potential reversal DOWN'
    lines.push(`  RSI divergence:   ${desc}`)
  }
  if (sig.macdSlope !== null) {
    const slope = sig.macdSlope
    const lbl = slope > 0.5  ? '▲ ACCELERATING — momentum building fast' :
                slope > 0    ? '↗ building' :
                slope < -0.5 ? '▼ DECELERATING FAST — momentum dying, reversal risk' :
                               '↘ fading'
    lines.push(`  MACD accel:       ${slope >= 0 ? '+' : ''}${slope.toFixed(3)}  →  ${lbl}`)
  }
  if (sig.donchian !== null) {
    const dc = sig.donchian
    const pct = (dc.pctRank * 100).toFixed(1)
    const lbl = dc.pctRank > 0.92 ? '⚠ AT RANGE HIGH — resistance / breakout zone' :
                dc.pctRank < 0.08 ? '⚠ AT RANGE LOW — support / breakdown zone' :
                dc.pctRank > 0.65 ? 'upper half of range' :
                dc.pctRank < 0.35 ? 'lower half of range' : 'mid-range'
    lines.push(`  Donchian(12):     ${pct}% of range  [${lbl}]  H=$${dc.upper.toFixed(0)} L=$${dc.lower.toFixed(0)}`)
  }
  if (sig.priceZScore !== null) {
    const z = sig.priceZScore
    const lbl = Math.abs(z) > 2 ? `⚠ EXTREME (${z.toFixed(2)}σ) — strong mean reversion pressure` :
                Math.abs(z) > 1.2 ? `stretched (${z.toFixed(2)}σ) — moderate reversion pressure` :
                `neutral (${z.toFixed(2)}σ)`
    lines.push(`  Price Z-score:    ${lbl}`)
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
  if (Math.abs(distancePct) > 0 && minutesLeft > 0) {
    const distUSD    = Math.abs(distancePct / 100) * spot
    const reqVel     = distUSD / minutesLeft
    // Frame the question correctly: what needs to happen for YES to win/lose
    const yesWins    = distancePct >= 0  // BTC currently above strike → YES wins by default
    const scenario   = yesWins
      ? `YES wins unless BTC FALLS $${distUSD.toFixed(0)} — need -$${reqVel.toFixed(2)}/min downward for NO to win`
      : `YES wins only if BTC RISES $${distUSD.toFixed(0)} — need +$${reqVel.toFixed(2)}/min for YES to win`
    lines.push(
      `\n[STRIKE REACHABILITY — CRITICAL]` +
      `\n  ${scenario}` +
      `\n  Time remaining: ${minutesLeft.toFixed(1)}min`
    )
    if (sig.velocity) {
      const v       = sig.velocity
      const toward  = (distancePct < 0 && v.velocityPerMin > 0) || (distancePct > 0 && v.velocityPerMin < 0)
      const ratio   = reqVel > 0 ? Math.abs(v.velocityPerMin) / reqVel : 0
      const accelNote = Math.abs(v.acceleration) > 5
        ? (v.acceleration > 0 ? ' ↑accelerating' : ' ↓decelerating')
        : ' →constant'
      lines.push(
        `  Current velocity:  ${v.velocityPerMin >= 0 ? '+' : ''}$${v.velocityPerMin.toFixed(2)}/min` +
        `  [${v.direction}${accelNote}]  ${(ratio * 100).toFixed(0)}% of required pace`
      )
      if (!toward) {
        lines.push(`  ⛔ MOVING AWAY FROM STRIKE — strike physically unreachable unless reversal`)
      } else if (ratio < 0.4) {
        lines.push(`  ⛔ VELOCITY TOO SLOW (${(ratio * 100).toFixed(0)}% of needed) — strike unreachable at current pace`)
      } else if (ratio < 0.75) {
        lines.push(`  ⚠  Below required pace (${(ratio * 100).toFixed(0)}%) — needs acceleration to reach strike`)
      } else {
        const minsToStrike = distUSD / Math.abs(v.velocityPerMin)
        const msg = minsToStrike <= minutesLeft
          ? `✓ On pace — reaches strike in ~${minsToStrike.toFixed(1)}min (${minutesLeft.toFixed(1)}min remaining)`
          : `  Borderline — ${minsToStrike.toFixed(1)}min at current pace vs ${minutesLeft.toFixed(1)}min left`
        lines.push(`  ${msg}`)
      }
    } else {
      lines.push(`  [No live velocity data — use physics priors for reachability]`)
    }
  } else if (sig.velocity) {
    const v = sig.velocity
    const accelNote = Math.abs(v.acceleration) > 5
      ? (v.acceleration > 0 ? ' ↑accelerating' : ' ↓decelerating') : ' →constant'
    lines.push(`\n[LIVE VELOCITY (1-min)]  ${v.velocityPerMin >= 0 ? '+' : ''}$${v.velocityPerMin.toFixed(2)}/min  [${v.direction}${accelNote}]`)
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
