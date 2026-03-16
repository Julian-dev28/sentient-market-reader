import { NextResponse } from 'next/server'
import { readTradeLog, clearTradeLog } from '@/lib/trade-log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json({ trades: readTradeLog() })
}

export async function DELETE() {
  clearTradeLog()
  return NextResponse.json({ ok: true })
}
