import { NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const KALSHI_BASE = 'https://api.elections.kalshi.com/trade-api/v2'

export async function GET() {
  try {
    const res = await fetch(
      `${KALSHI_BASE}/markets?series_ticker=KXBTC15M&status=active&limit=10`,
      {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      }
    )

    if (!res.ok) {
      // If Kalshi returns an error, return mock data so the demo still works
      return NextResponse.json(getMockMarkets())
    }

    const data = await res.json()
    return NextResponse.json(data)
  } catch {
    // Network error — return mock markets
    return NextResponse.json(getMockMarkets())
  }
}

function getMockMarkets() {
  const now = new Date()
  // Round up to next 15-min boundary
  const mins = now.getMinutes()
  const nextBoundary = Math.ceil(mins / 15) * 15
  const expiry = new Date(now)
  expiry.setMinutes(nextBoundary, 0, 0)

  const pad = (n: number) => String(n).padStart(2, '0')
  const day = expiry.getDate()
  const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC']
  const month = months[expiry.getMonth()]
  const hhmm = `${pad(expiry.getHours())}${pad(expiry.getMinutes())}`
  const ticker = `KXBTC15M-${pad(day)}${month}${hhmm}`

  // Mock floor strike based on a realistic BTC price
  const mockStrike = 95000
  return {
    markets: [
      {
        ticker,
        event_ticker: ticker,
        series_ticker: 'KXBTC15M',
        title: 'BTC price up in next 15 mins?',
        yes_sub_title: `Price to beat: $${mockStrike.toLocaleString()}`,
        floor_strike: mockStrike,
        yes_bid: 48,
        yes_ask: 52,
        no_bid: 48,
        no_ask: 52,
        last_price: 50,
        volume: 1240,
        open_interest: 340,
        close_time: expiry.toISOString(),
        expiration_time: expiry.toISOString(),
        status: 'active',
      },
    ],
    cursor: '',
  }
}
