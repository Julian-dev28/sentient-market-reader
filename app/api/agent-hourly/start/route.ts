import { NextRequest, NextResponse } from 'next/server'
import { hourlyServerAgent } from '@/lib/server-agent-hourly'

export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  const { allowance, kellyMode, bankroll, kellyPct } = await req.json().catch(() => ({}))
  if (typeof allowance !== 'number' || allowance <= 0) {
    return NextResponse.json({ error: 'allowance must be a positive number' }, { status: 400 })
  }
  hourlyServerAgent.start(allowance, !!kellyMode, bankroll ?? undefined, kellyPct ?? 0.18)
  return NextResponse.json({ ok: true, state: hourlyServerAgent.getState() })
}
