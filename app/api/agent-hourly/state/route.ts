import { NextResponse } from 'next/server'
import { hourlyServerAgent } from '@/lib/server-agent-hourly'
import { hourlyAgentStore } from '@/lib/agent-store-hourly'

export const runtime = 'nodejs'

export async function GET() {
  const liveState = hourlyServerAgent.getState()
  if (liveState.active) return NextResponse.json(liveState)
  const kvState = await hourlyAgentStore.loadState().catch(() => null)
  return NextResponse.json(kvState ?? liveState)
}
