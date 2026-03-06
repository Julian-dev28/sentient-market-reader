import { NextResponse } from 'next/server'
import { serverAgent } from '@/lib/server-agent'

export const runtime = 'nodejs'

export async function POST() {
  serverAgent.stop()
  return NextResponse.json({ ok: true })
}
