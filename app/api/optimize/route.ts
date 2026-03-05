import { NextResponse, type NextRequest } from 'next/server'
import type { TradeRecord, DailyOptParams } from '@/lib/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * POST /api/optimize
 * Body: { trades: TradeRecord[], calibration: CalibrationResult }
 * Calls Python optimize service → returns DailyOptParams
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()

    const pythonRes = await fetch('http://localhost:8001/optimize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(55000),
    })

    if (!pythonRes.ok) {
      const err = await pythonRes.json().catch(() => ({}))
      return NextResponse.json({ error: err.detail ?? 'Python optimize failed' }, { status: pythonRes.status })
    }

    const result = await pythonRes.json() as DailyOptParams
    return NextResponse.json(result)
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
