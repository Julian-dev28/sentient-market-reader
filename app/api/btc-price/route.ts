import { NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  // ── Primary: Coinbase (no key required) ─────────────────────────────────
  try {
    const res = await fetch('https://api.coinbase.com/v2/prices/BTC-USD/spot', { cache: 'no-store' })
    if (res.ok) {
      const cb = await res.json()
      const price = parseFloat(cb?.data?.amount)
      if (price > 0) {
        return NextResponse.json({
          price,
          percent_change_1h:  0,
          percent_change_24h: 0,
          source: 'coinbase',
          last_updated: new Date().toISOString(),
        })
      }
    }
  } catch { /* fall through */ }

  // ── Fallback: CoinGecko (no key, generous free tier) ─────────────────────
  try {
    const res = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true',
      { cache: 'no-store' }
    )
    if (res.ok) {
      const data = await res.json()
      const price = data?.bitcoin?.usd
      if (price > 0) {
        return NextResponse.json({
          price,
          percent_change_1h:  0,
          percent_change_24h: data?.bitcoin?.usd_24h_change ?? 0,
          source: 'coingecko',
          last_updated: new Date().toISOString(),
        })
      }
    }
  } catch { /* fall through */ }

  return NextResponse.json({ error: 'All BTC price sources failed' }, { status: 502 })
}
