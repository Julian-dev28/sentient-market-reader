/**
 * Momentum Markov Chain — predicts BTC price direction from 1-min return states.
 *
 * Old model: states = BTC % distance from strike → trivially predicted "stays where it is"
 * New model: states = 1-min % price CHANGE bins → captures momentum persistence & reversal
 *
 * Core prediction (predictFromMomentum):
 *   Given current momentum state, propagate the state distribution forward T steps
 *   using Chapman-Kolmogorov (dist @ P^T). Accumulate expected drift + variance.
 *   P(YES) = P(cumulative drift > required_threshold) via Gaussian approximation.
 *
 *   required_threshold ≈ -distanceFromStrikePct
 *     BTC 2% above strike → need drift > -2% (can drop up to 2% and still win YES)
 *     BTC 1% below strike → need drift > +1% (must rally 1%+ to win YES)
 */

export const NUM_STATES = 9

// 1-min % price change breakpoints (boundaries between states)
const BOUNDS = [-1.5, -1.0, -0.5, -0.2, 0.2, 0.5, 1.0, 1.5] as const

export const STATE_LABELS = [
  '< −1.5%',      // 0 strong down
  '−1.5→−1%',     // 1
  '−1→−0.5%',     // 2
  '−0.5→−0.2%',   // 3
  '±0.2% flat',   // 4
  '0.2→0.5%',     // 5
  '0.5→1%',       // 6
  '1→1.5%',       // 7
  '> 1.5%',       // 8 strong up
]

// Representative return (% per minute) for each state — used for drift projection
const STATE_RETURNS: readonly number[] = [-2.0, -1.25, -0.75, -0.35, 0.0, 0.35, 0.75, 1.25, 2.0]

// Within-state return volatility (% per minute) — within-bin variance contribution
const STATE_VOL: readonly number[] = [1.0, 0.35, 0.25, 0.15, 0.10, 0.15, 0.25, 0.35, 1.0]

/** Map a 1-min % price change to a discrete momentum state 0–8 */
export function priceChangeToState(pct: number): number {
  for (let i = 0; i < BOUNDS.length; i++) {
    if (pct < BOUNDS[i]) return i
  }
  return BOUNDS.length  // state 8: > +1.5%
}

/** Build NUM_STATES × NUM_STATES transition probability matrix from a state sequence */
export function buildTransitionMatrix(states: number[]): number[][] {
  const counts: number[][] = Array.from({ length: NUM_STATES }, () =>
    new Array<number>(NUM_STATES).fill(0),
  )
  for (let i = 0; i < states.length - 1; i++) {
    const from = states[i]
    const to   = states[i + 1]
    if (from >= 0 && from < NUM_STATES && to >= 0 && to < NUM_STATES) {
      counts[from][to]++
    }
  }
  return counts.map(row => {
    const total = row.reduce((a, b) => a + b, 0)
    if (total === 0) return new Array<number>(NUM_STATES).fill(1 / NUM_STATES)
    return row.map(c => c / total)
  })
}

// Abramowitz & Stegun normal CDF approximation (max error 7.5e-8)
function normalCDF(z: number): number {
  if (z >  8) return 1
  if (z < -8) return 0
  const t    = 1 / (1 + 0.3275911 * Math.abs(z))
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))))
  const erf  = 1 - poly * Math.exp(-(z * z))
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2
}

export interface MomentumForecast {
  pYes:             number   // P(BTC > strike at expiry)
  pNo:              number   // 1 - pYes
  expectedDriftPct: number   // expected cumulative % price change over T steps
  requiredDriftPct: number   // drift needed for YES (≈ −distanceFromStrikePct)
  sigma:            number   // std dev of cumulative drift distribution
  zScore:           number   // (expectedDrift − requiredDrift) / sigma
  persist:          number   // P[currentState][currentState] — momentum self-persistence
  jStar:            number   // argmax(P[currentState]) — most likely next momentum state
  enterYes:         boolean  // strong YES: pYes >= 0.65 AND persist >= TAU
  enterNo:          boolean  // strong NO:  pYes <= 0.35 AND persist >= TAU
}

const STRONG_THRESHOLD = 0.65   // pYes >= this → strong YES signal
const PERSIST_TAU      = 0.80   // minimum momentum self-persistence for strong signal

/**
 * Predict P(BTC > strike at expiry) from the momentum Markov chain.
 *
 * Uses Chapman-Kolmogorov to propagate state distribution forward T steps,
 * accumulating expected drift (E[Σ r_t]) and variance (Var[Σ r_t]).
 * Then: P(YES) = Φ((E[drift] − required_drift) / σ)
 */
export function predictFromMomentum(
  P: number[][],
  currentState: number,
  minutesUntilExpiry: number,
  distanceFromStrikePct: number,
): MomentumForecast {
  const T = Math.max(1, Math.round(minutesUntilExpiry))
  // For YES: need cumulative drift > -distanceFromStrikePct
  // (BTC above by 2% → can drop up to 2%; below by 1% → must rally 1%+)
  const requiredDriftPct = -distanceFromStrikePct

  // State probability distribution — start fully in current state
  let dist = new Array<number>(NUM_STATES).fill(0)
  dist[Math.max(0, Math.min(NUM_STATES - 1, currentState))] = 1.0

  let expectedDrift = 0
  let varianceSum   = 0

  for (let t = 0; t < T; t++) {
    // E[r_t] and E[r_t²] for this step given current distribution
    let stepMean = 0
    let stepE2   = 0
    for (let i = 0; i < NUM_STATES; i++) {
      if (dist[i] === 0) continue
      stepMean += dist[i] * STATE_RETURNS[i]
      stepE2   += dist[i] * (STATE_VOL[i] ** 2 + STATE_RETURNS[i] ** 2)
    }
    const stepVar = stepE2 - stepMean ** 2

    expectedDrift += stepMean
    varianceSum   += Math.max(0, stepVar)

    // Propagate: dist = dist @ P
    const next = new Array<number>(NUM_STATES).fill(0)
    for (let i = 0; i < NUM_STATES; i++) {
      if (dist[i] === 0) continue
      for (let j = 0; j < NUM_STATES; j++) {
        next[j] += dist[i] * P[i][j]
      }
    }
    dist = next
  }

  const sigma  = Math.sqrt(Math.max(varianceSum, 0.01))
  const zScore = (expectedDrift - requiredDriftPct) / sigma
  const pYes   = normalCDF(zScore)

  // Persistence and most likely next state from current row
  const row    = P[Math.max(0, Math.min(NUM_STATES - 1, currentState))]
  const jStar  = row.reduce<number>((best, p, j) => (p > row[best] ? j : best), 0)
  const persist = row[currentState]   // self-persistence: P[s][s]

  const enterYes = pYes >= STRONG_THRESHOLD && persist >= PERSIST_TAU
  const enterNo  = pYes <= (1 - STRONG_THRESHOLD) && persist >= PERSIST_TAU

  return {
    pYes,
    pNo:             1 - pYes,
    expectedDriftPct: expectedDrift,
    requiredDriftPct,
    sigma,
    zScore,
    persist,
    jStar,
    enterYes,
    enterNo,
  }
}
