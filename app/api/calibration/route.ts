import { NextResponse, type NextRequest } from 'next/server'
import type { TradeRecord, CalibrationResult, CalibrationBucket, SignalImportance } from '@/lib/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Brier score: mean((p_model - outcome)^2). Perfect=0, Random=0.25 */
function brierScore(trades: TradeRecord[]): number {
  if (!trades.length) return 0.25
  const sum = trades.reduce((s, t) => {
    const outcome = t.outcome === 'WIN' ? 1 : 0
    return s + Math.pow(t.pModel - outcome, 2)
  }, 0)
  return sum / trades.length
}

/** Log loss: -mean(y*log(p) + (1-y)*log(1-p)). Penalises confident errors heavily. */
function logLoss(trades: TradeRecord[]): number {
  if (!trades.length) return Math.log(2)
  const eps = 1e-7
  const sum = trades.reduce((s, t) => {
    const y = t.outcome === 'WIN' ? 1 : 0
    const p = Math.max(eps, Math.min(1 - eps, t.pModel))
    return s - (y * Math.log(p) + (1 - y) * Math.log(1 - p))
  }, 0)
  return sum / trades.length
}

/** ROC-AUC via trapezoidal rule. Measures ranking quality. */
function rocAuc(trades: TradeRecord[]): number {
  if (trades.length < 2) return 0.5
  const sorted = [...trades].sort((a, b) => b.pModel - a.pModel)
  const positives = trades.filter(t => t.outcome === 'WIN').length
  const negatives = trades.length - positives
  if (!positives || !negatives) return 0.5

  let tpCount = 0, fpCount = 0, auc = 0
  let prevFp = 0, prevTp = 0
  for (const t of sorted) {
    if (t.outcome === 'WIN') tpCount++
    else fpCount++
    auc += ((fpCount - prevFp) / negatives) * ((tpCount + prevTp) / 2 / positives)
    prevFp = fpCount; prevTp = tpCount
  }
  return auc
}

/** Calibration buckets: bin pModel into 10% intervals, measure actual win rate */
function calibrationBuckets(trades: TradeRecord[]): CalibrationBucket[] {
  const bins: Record<number, { pSum: number; wins: number; count: number }> = {}
  for (let b = 5; b <= 95; b += 10) bins[b] = { pSum: 0, wins: 0, count: 0 }

  for (const t of trades) {
    const bucket = Math.round(t.pModel * 10) * 10 - 5  // map to nearest 5,15,25...95
    const key = Math.max(5, Math.min(95, bucket))
    if (!bins[key]) bins[key] = { pSum: 0, wins: 0, count: 0 }
    bins[key].pSum += t.pModel
    if (t.outcome === 'WIN') bins[key].wins++
    bins[key].count++
  }

  return Object.entries(bins)
    .filter(([, v]) => v.count > 0)
    .map(([key, v]) => {
      const pMid = parseInt(key) / 100
      const lo = Math.round((pMid - 0.05) * 100)
      const hi = Math.round((pMid + 0.05) * 100)
      return {
        bucket: `${lo}–${hi}%`,
        pMid,
        predicted: v.pSum / v.count,
        actual: v.wins / v.count,
        count: v.count,
      }
    })
    .sort((a, b) => a.pMid - b.pMid)
}

/** Signal hit rate: for each boolean signal, how often does it predict correctly? */
function signalImportances(trades: TradeRecord[]): SignalImportance[] {
  const withSignals = trades.filter(t => t.signals)
  if (withSignals.length < 3) return []

  type AccEntry = { correct: number; total: number; coefSum: number }
  const acc: Record<string, AccEntry> = {}

  function track(name: string, predictYes: boolean, actualYes: boolean, magnitude: number) {
    if (!acc[name]) acc[name] = { correct: 0, total: 0, coefSum: 0 }
    acc[name].total++
    acc[name].coefSum += magnitude
    if (predictYes === actualYes) acc[name].correct++
  }

  for (const t of withSignals) {
    const s = t.signals!
    const win = t.outcome === 'WIN'
    // For YES trades: win = BTC ended above strike. For NO trades: win = BTC ended below.
    const actualYes = t.side === 'yes' ? win : !win

    track('sentiment',        s.sentimentScore > 0.1, actualYes, Math.abs(s.sentimentScore))
    track('momentum',         s.sentimentMomentum > 0.1, actualYes, Math.abs(s.sentimentMomentum))
    track('orderbook',        s.orderbookSkew > 0.1, actualYes, Math.abs(s.orderbookSkew))
    track('above_strike',     s.aboveStrike, actualYes, Math.abs(s.distancePct))
    track('high_confidence',  s.confidence === 'high', win, 1)
    track('time_decay',       s.minutesLeft < 5, win, 1)  // gate-driven trades
    track('price_momentum_1h',s.priceMomentum1h > 0, actualYes, Math.abs(s.priceMomentum1h))
    if (s.gkVol != null) {
      track('high_vol',       s.gkVol > 0.003, !s.aboveStrike, s.gkVol)  // high vol → direction flip risk
    }
  }

  return Object.entries(acc)
    .filter(([, v]) => v.total >= 3)
    .map(([feature, v]) => ({
      feature,
      coefficient: (v.coefSum / v.total),
      direction: (v.correct / v.total > 0.6 ? 'bullish' : v.correct / v.total < 0.4 ? 'bearish' : 'mixed') as 'bullish' | 'bearish' | 'mixed',
      accuracy: v.correct / v.total,
      count: v.total,
    }))
    .sort((a, b) => Math.abs(b.accuracy - 0.5) - Math.abs(a.accuracy - 0.5))
}

/**
 * GET /api/calibration?trades=[JSON]
 * Accepts trade history as JSON body (POST) or reads from server-side store.
 * Since trades are in localStorage, the client must POST them.
 *
 * POST /api/calibration — body: { trades: TradeRecord[] }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as { trades: TradeRecord[] }
    const allTrades = body.trades ?? []
    const settled = allTrades.filter(t => t.outcome !== 'PENDING')

    if (!settled.length) {
      return NextResponse.json({
        brierScore: 0.25,
        logLoss: Math.log(2),
        rocAuc: 0.5,
        totalTrades: 0,
        settledTrades: 0,
        overallWinRate: 0,
        avgPModel: 0,
        buckets: [],
        signals: [],
        plattA: null,
        plattB: null,
        computedAt: new Date().toISOString(),
      } satisfies CalibrationResult)
    }

    const wins = settled.filter(t => t.outcome === 'WIN')

    const result: CalibrationResult = {
      brierScore:      brierScore(settled),
      logLoss:         logLoss(settled),
      rocAuc:          rocAuc(settled),
      totalTrades:     allTrades.length,
      settledTrades:   settled.length,
      overallWinRate:  wins.length / settled.length,
      avgPModel:       settled.reduce((s, t) => s + t.pModel, 0) / settled.length,
      buckets:         calibrationBuckets(settled),
      signals:         signalImportances(settled),
      plattA:          null,  // computed by Python service after 30+ trades
      plattB:          null,
      computedAt:      new Date().toISOString(),
    }

    // If enough trades, call Python service for Platt scaling
    if (settled.length >= 20) {
      try {
        const pythonRes = await fetch('http://localhost:8001/calibrate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            predictions: settled.map(t => t.pModel),
            outcomes:    settled.map(t => t.outcome === 'WIN' ? 1 : 0),
          }),
          signal: AbortSignal.timeout(8000),
        })
        if (pythonRes.ok) {
          const cal = await pythonRes.json()
          result.plattA = cal.a ?? null
          result.plattB = cal.b ?? null
        }
      } catch { /* Python service unavailable — skip Platt */ }
    }

    return NextResponse.json(result)
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 400 })
  }
}
