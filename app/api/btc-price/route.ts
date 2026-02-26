import { NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  // ── Primary: Coinbase (no key, no geo-restriction) ───────────────────────
  try {
    const cbRes = await fetch('https://api.coinbase.com/v2/prices/BTC-USD/spot', { cache: 'no-store' })
    if (cbRes.ok) {
      const cb = await cbRes.json()
      const price = parseFloat(cb?.data?.amount)
      if (price > 0) {
        return NextResponse.json({
          price,
          percent_change_1h:  0,
          percent_change_24h: 0,
          volume_24h:         0,
          market_cap:         price * 19_700_000,
          last_updated:       new Date().toISOString(),
          source: 'coinbase',
        })
      }
    }
  } catch { /* fall through to CMC */ }

  // ── Fallback: CoinMarketCap ──────────────────────────────────────────────
  const apiKey = process.env.CMC_API_KEY
  if (apiKey) {
    try {
      const res = await fetch(
        'https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?symbol=BTC&convert=USD',
        {
          headers: { 'X-CMC_PRO_API_KEY': apiKey, Accept: 'application/json' },
          cache: 'no-store',
        }
      )
      if (res.ok) {
        const data = await res.json()
        const q = data?.data?.BTC?.quote?.USD
        if (q?.price > 0) {
          return NextResponse.json({
            price: q.price,
            percent_change_1h: q.percent_change_1h,
            percent_change_24h: q.percent_change_24h,
            volume_24h: q.volume_24h,
            market_cap: q.market_cap,
            last_updated: q.last_updated,
            source: 'coinmarketcap',
          })
        }
      }
    } catch { /* fall through to error */ }
  }

  return NextResponse.json({ error: 'All BTC price sources failed' }, { status: 502 })
}
