import { NextRequest, NextResponse } from 'next/server'
import { buildKalshiHeaders } from '@/lib/kalshi-auth'
import { KALSHI_BASE } from '@/lib/kalshi'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ orderId: string }> },
) {
  const { orderId } = await params
  const path = `/trade-api/v2/portfolio/orders/${orderId}`
  const headers = buildKalshiHeaders('GET', path)

  const res = await fetch(`${KALSHI_BASE}/portfolio/orders/${orderId}`, { headers })
  const data = await res.json().catch(() => ({}))
  return NextResponse.json(data, { status: res.status })
}
