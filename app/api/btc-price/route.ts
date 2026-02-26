import { NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  // ── Primary: CoinMarketCap ───────────────────────────────────────────────
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
    } catch { /* fall through to Binance */ }
  }

  // ── Fallback: Binance (no key required, real-time) ───────────────────────
  try {
    const [tickerRes, statsRes] = await Promise.all([
      fetch('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT', { cache: 'no-store' }),
      fetch('https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT',  { cache: 'no-store' }),
    ])
    if (tickerRes.ok && statsRes.ok) {
      const ticker = await tickerRes.json()
      const stats  = await statsRes.json()
      const price  = parseFloat(ticker.price)
      if (price > 0) {
        return NextResponse.json({
          price,
          percent_change_1h:  0,  // Binance 24hr doesn't include 1h; agents use 24h
          percent_change_24h: parseFloat(stats.priceChangePercent),
          volume_24h:         parseFloat(stats.quoteVolume),
          market_cap:         price * 19_700_000,
          last_updated:       new Date().toISOString(),
          source: 'binance',
        })
      }
    }
  } catch { /* fall through to error */ }

  return NextResponse.json({ error: 'All BTC price sources failed' }, { status: 502 })
}
