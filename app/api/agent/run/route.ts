import { NextResponse } from 'next/server'
import { serverAgent } from '@/lib/server-agent'

export const runtime = 'nodejs'

/** POST /api/agent/run — manually trigger a pipeline cycle */
export async function POST() {
  serverAgent.triggerCycle()  // intentionally not awaited — result comes via SSE
  return NextResponse.json({ ok: true })
}
