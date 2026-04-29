import { NextResponse } from 'next/server'
import { hourlyServerAgent } from '@/lib/server-agent-hourly'

export const runtime = 'nodejs'

export async function POST() {
  hourlyServerAgent.clearHistory()
  return NextResponse.json({ ok: true })
}
