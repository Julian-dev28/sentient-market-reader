import { NextResponse } from 'next/server'
import { runAgentPipeline } from '@/lib/agents'
import { buildKalshiHeaders } from '@/lib/kalshi-auth'
import type { KalshiMarket, KalshiOrderbook, BTCQuote } from '@/lib/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300  // allow up to 5 min for ROMA multi-agent loop

/** Compute the current active KXBTC15M event_ticker using ET timezone
 *  Format: KXBTC15M-{YY}{MON}{DD}{HHMM} — date/time in US Eastern Time
 */
function getCurrentEventTicker(): string {
  const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC']
  // Get current ET time (approximation: UTC-5 for EST, UTC-4 for EDT)
  // Use Intl for accuracy
  const now = new Date()
  const etStr = now.toLocaleString('en-US', { timeZone: 'America/New_York' })
  const et = new Date(etStr)
  const mins = et.getMinutes()
  // Current 15-min block end
  const blockEnd = Math.ceil((mins + 1) / 15) * 15
  et.setMinutes(blockEnd, 0, 0)

  const yy = String(et.getFullYear()).slice(-2)
  const mon = MONTHS[et.getMonth()]
  const dd = String(et.getDate()).padStart(2, '0')
  const hh = String(et.getHours()).padStart(2, '0')
  const mm = String(et.getMinutes() % 60).padStart(2, '0')
  return `KXBTC15M-${yy}${mon}${dd}${hh}${mm}`
}

export async function GET() {
  try {
    // Try to fetch the currently active market using computed event_ticker
    let markets: KalshiMarket[] = []

    const eventTicker = getCurrentEventTicker()
    const eventPath = `/trade-api/v2/markets?event_ticker=${eventTicker}&limit=5`
    const eventRes = await fetch(
      `https://api.elections.kalshi.com${eventPath}`,
      { headers: { ...buildKalshiHeaders('GET', eventPath), Accept: 'application/json' }, cache: 'no-store' }
    ).catch(() => null)

    if (eventRes?.ok) {
      const data = await eventRes.json()
      markets = (data.markets ?? []).filter((m: KalshiMarket) => m.yes_ask > 0)
    }

    // Fallback: query recent series markets without status filter
    if (!markets.length) {
      const fallbackPath = '/trade-api/v2/markets?series_ticker=KXBTC15M&limit=100'
      const fallbackRes = await fetch(
        `https://api.elections.kalshi.com${fallbackPath}`,
        { headers: { ...buildKalshiHeaders('GET', fallbackPath), Accept: 'application/json' }, cache: 'no-store' }
      ).catch(() => null)
      if (fallbackRes?.ok) {
        const data = await fallbackRes.json()
        markets = (data.markets ?? []).filter((m: KalshiMarket) => m.yes_ask > 0)
      }
    }

    if (!markets.length) {
      markets = getMockMarkets()
    }

    // Fetch BTC price
    const cmcKey = process.env.CMC_API_KEY ?? ''
    let quote: BTCQuote | null = null
    if (cmcKey) {
      const priceRes = await fetch(
        'https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?symbol=BTC&convert=USD',
        {
          headers: { 'X-CMC_PRO_API_KEY': cmcKey, Accept: 'application/json' },
          cache: 'no-store',
        }
      ).catch(() => null)
      if (priceRes?.ok) {
        const data = await priceRes.json()
        const q = data?.data?.BTC?.quote?.USD
        if (q) {
          quote = {
            price: q.price,
            percent_change_1h: q.percent_change_1h,
            percent_change_24h: q.percent_change_24h,
            volume_24h: q.volume_24h,
            market_cap: q.market_cap,
            last_updated: q.last_updated,
          }
        }
      }
    }

    if (!quote) {
      quote = getMockQuote()
    }

    // Fetch orderbook for nearest market
    let orderbook: KalshiOrderbook | null = null
    if (markets.length > 0) {
      const obPath = `/trade-api/v2/markets/${markets[0].ticker}/orderbook`
      const obRes = await fetch(
        `https://api.elections.kalshi.com${obPath}`,
        { headers: { ...buildKalshiHeaders('GET', obPath), Accept: 'application/json' }, cache: 'no-store' }
      ).catch(() => null)
      if (obRes?.ok) {
        const data = await obRes.json()
        orderbook = data.orderbook ?? null
      }
    }

    const pipeline = await runAgentPipeline(markets, quote, orderbook)
    return NextResponse.json(pipeline)
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

function getMockQuote(): BTCQuote {
  const base = 95000 + (Math.random() - 0.5) * 4000
  return {
    price: base,
    percent_change_1h: (Math.random() - 0.48) * 1.5,
    percent_change_24h: (Math.random() - 0.45) * 5,
    volume_24h: 28_000_000_000,
    market_cap: base * 19_700_000,
    last_updated: new Date().toISOString(),
  }
}

function getMockMarkets(): KalshiMarket[] {
  const now = new Date()
  const mins = now.getMinutes()
  const nextBoundary = Math.ceil(mins / 15) * 15
  const expiry = new Date(now)
  expiry.setMinutes(nextBoundary, 0, 0)

  const pad = (n: number) => String(n).padStart(2, '0')
  const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC']
  const ticker = `KXBTC15M-${pad(expiry.getDate())}${months[expiry.getMonth()]}${pad(expiry.getHours())}${pad(expiry.getMinutes())}`

  const mockStrike = 95000
  return [{
    ticker,
    event_ticker: ticker,
    series_ticker: 'KXBTC15M',
    title: 'BTC price up in next 15 mins?',
    yes_sub_title: `Price to beat: $${mockStrike.toLocaleString()}`,
    floor_strike: mockStrike,
    yes_bid: 48, yes_ask: 52, no_bid: 48, no_ask: 52,
    last_price: 50, volume: 1240, open_interest: 340,
    close_time: expiry.toISOString(),
    expiration_time: expiry.toISOString(),
    status: 'active',
  }]
}
