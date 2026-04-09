import { NextRequest, NextResponse } from 'next/server'
import { serverAgent } from '@/lib/server-agent'

export const runtime = 'nodejs'

/** PATCH /api/agent/config — update allowance while agent is running */
export async function PATCH(req: NextRequest) {
  const { allowance, kellyMode, bankroll } = await req.json().catch(() => ({}))
  if (typeof allowance === 'number' && allowance >= 0) {
    serverAgent.setAllowance(allowance, kellyMode, bankroll)
  }
  return NextResponse.json({ ok: true, state: serverAgent.getState() })
}
