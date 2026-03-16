import { NextRequest, NextResponse } from 'next/server'
import { buildKalshiHeaders } from '@/lib/kalshi-auth'

const KALSHI_BASE = 'https://api.elections.kalshi.com/trade-api/v2'

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ orderId: string }> },
) {
  const { orderId } = await params
  const path = `/trade-api/v2/portfolio/orders/${orderId}`
  const headers = await buildKalshiHeaders('GET', path)

  const res = await fetch(`${KALSHI_BASE}/portfolio/orders/${orderId}`, { headers })
  const data = await res.json().catch(() => ({}))
  return NextResponse.json(data, { status: res.status })
}
