import { NextResponse } from 'next/server'
import { serverAgent } from '@/lib/server-agent'

export const runtime = 'nodejs'

export async function POST() {
  serverAgent.clearHistory()
  return NextResponse.json({ ok: true })
}
