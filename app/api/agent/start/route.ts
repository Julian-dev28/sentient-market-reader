import { NextRequest, NextResponse } from 'next/server'
import { serverAgent } from '@/lib/server-agent'

export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  const { allowance, orModel, kellyMode, bankroll, kellyPct, aiMode } = await req.json().catch(() => ({}))
  if (typeof allowance !== 'number' || allowance <= 0) {
    return NextResponse.json({ error: 'allowance must be a positive number' }, { status: 400 })
  }
  serverAgent.start(allowance, orModel ?? undefined, !!kellyMode, bankroll ?? undefined, kellyPct ?? 0.25, !!aiMode)
  return NextResponse.json({ ok: true, state: serverAgent.getState() })
}
