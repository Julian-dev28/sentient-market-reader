import type { KalshiMarket, KalshiOrderbook } from './types'

const KALSHI_BASE = 'https://api.elections.kalshi.com/trade-api/v2'

export async function getOpenBTCMarkets(): Promise<KalshiMarket[]> {
  // Kalshi uses "active" for currently open markets
  const url = `${KALSHI_BASE}/markets?series_ticker=KXBTC15M&status=active&limit=10`
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    next: { revalidate: 0 },
  })
  if (!res.ok) throw new Error(`Kalshi markets error: ${res.status}`)
  const data = await res.json()
  return (data.markets ?? []) as KalshiMarket[]
}

export async function getMarketOrderbook(ticker: string): Promise<KalshiOrderbook> {
  const url = `${KALSHI_BASE}/markets/${encodeURIComponent(ticker)}/orderbook`
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    next: { revalidate: 0 },
  })
  if (!res.ok) throw new Error(`Kalshi orderbook error: ${res.status}`)
  const data = await res.json()
  return data.orderbook as KalshiOrderbook
}

/** Find the nearest-expiry open market in the series */
export function findNearestMarket(markets: KalshiMarket[]): KalshiMarket | null {
  if (!markets.length) return null
  return markets.sort(
    (a, b) => new Date(a.expiration_time).getTime() - new Date(b.expiration_time).getTime()
  )[0]
}

/** Minutes until a market closes (uses close_time — the actual 15-min window end) */
export function minutesUntilExpiry(market: KalshiMarket): number {
  // close_time is the 15-minute window end; expiration_time can be days later
  const closeTime = market.close_time || market.expiration_time
  const ms = new Date(closeTime).getTime() - Date.now()
  return Math.max(0, ms / 60_000)
}

/** Seconds until a market closes */
export function secondsUntilExpiry(market: KalshiMarket): number {
  const closeTime = market.close_time || market.expiration_time
  const ms = new Date(closeTime).getTime() - Date.now()
  return Math.max(0, ms / 1_000)
}
