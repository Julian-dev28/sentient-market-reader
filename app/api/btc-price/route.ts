import { NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const apiKey = process.env.CMC_API_KEY
  if (!apiKey) {
    return NextResponse.json({ error: 'CMC_API_KEY not configured' }, { status: 500 })
  }

  try {
    const res = await fetch(
      'https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?symbol=BTC&convert=USD',
      {
        headers: {
          'X-CMC_PRO_API_KEY': apiKey,
          Accept: 'application/json',
        },
        cache: 'no-store',
      }
    )

    if (!res.ok) {
      const text = await res.text()
      return NextResponse.json({ error: `CMC error: ${res.status}`, detail: text }, { status: 502 })
    }

    const data = await res.json()
    const q = data?.data?.BTC?.quote?.USD

    if (!q) {
      return NextResponse.json({ error: 'No BTC quote in CMC response' }, { status: 502 })
    }

    return NextResponse.json({
      price: q.price,
      percent_change_1h: q.percent_change_1h,
      percent_change_24h: q.percent_change_24h,
      volume_24h: q.volume_24h,
      market_cap: q.market_cap,
      last_updated: q.last_updated,
    })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
