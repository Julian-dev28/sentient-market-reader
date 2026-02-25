import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const KALSHI_BASE = 'https://api.elections.kalshi.com/trade-api/v2'

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ ticker: string }> }
) {
  const { ticker } = await params
  try {
    const res = await fetch(
      `${KALSHI_BASE}/markets/${encodeURIComponent(ticker)}/orderbook`,
      {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      }
    )

    if (!res.ok) {
      return NextResponse.json(getMockOrderbook())
    }

    const data = await res.json()
    return NextResponse.json(data)
  } catch {
    return NextResponse.json(getMockOrderbook())
  }
}

function getMockOrderbook() {
  return {
    orderbook: {
      yes: [
        { price: 52, delta: 120 },
        { price: 51, delta: 85 },
        { price: 50, delta: 200 },
      ],
      no: [
        { price: 48, delta: 95 },
        { price: 47, delta: 110 },
        { price: 46, delta: 75 },
      ],
    },
  }
}
