import { NextResponse } from 'next/server'
import { serverAgent } from '@/lib/server-agent'
import { agentStore } from '@/lib/agent-store'

export const runtime = 'nodejs'

export async function GET() {
  const liveState = serverAgent.getState()
  // If this instance has an active agent, return it immediately
  if (liveState.active) return NextResponse.json(liveState)
  // Otherwise fall back to KV — handles cold starts and cross-instance calls
  const kvState = await agentStore.loadState().catch(() => null)
  return NextResponse.json(kvState ?? liveState)
}
