import { NextResponse, type NextRequest } from 'next/server'
import { runAgentPipeline } from '@/lib/agents'
import { buildKalshiHeaders } from '@/lib/kalshi-auth'
import type { KalshiMarket, KalshiOrderbook, BTCQuote } from '@/lib/types'
import type { AIProvider } from '@/lib/llm-client'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300  // allow up to 5 min for full pipeline + roma-dspy service calls

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

export async function GET(_req: NextRequest) {
  const p = process.env.AI_PROVIDER ?? 'grok'
  const validProviders = ['anthropic', 'openai', 'grok', 'openrouter'] as const
  const provider: AIProvider = (validProviders as readonly string[]).includes(p) ? p as AIProvider : 'grok'
  try {
    // Try to fetch the currently active market using computed event_ticker
    let markets: KalshiMarket[] = []

    const eventTicker = getCurrentEventTicker()
    const eventPath = `/trade-api/v2/markets?event_ticker=${eventTicker}&limit=5`
    const eventRes = await fetch(
      `https://api.elections.kalshi.com${eventPath}`,
      { headers: { ...buildKalshiHeaders('GET', eventPath), Accept: 'application/json' }, cache: 'no-store' }
    ).catch(() => null)

    // Only accept markets that are genuinely open for trading:
    // close_time must be in the future, and prices must be live (not 0 or 100 = settled extremes)
    const now = Date.now()
    const isTradeable = (m: KalshiMarket) =>
      (m.close_time ? new Date(m.close_time).getTime() > now : true) &&
      m.yes_ask > 1 && m.yes_ask < 99

    if (eventRes?.ok) {
      const data = await eventRes.json()
      markets = (data.markets ?? []).filter(isTradeable)
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
        markets = (data.markets ?? []).filter(isTradeable)
      }
    }

    if (!markets.length) {
      return NextResponse.json({ error: 'No active KXBTC15M markets found' }, { status: 503 })
    }

    // Fetch BTC price — CMC first, Binance fallback
    let quote: BTCQuote | null = null

    const cmcKey = process.env.CMC_API_KEY ?? ''
    if (cmcKey) {
      const priceRes = await fetch(
        'https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?symbol=BTC&convert=USD',
        { headers: { 'X-CMC_PRO_API_KEY': cmcKey, Accept: 'application/json' }, cache: 'no-store' }
      ).catch(() => null)
      if (priceRes?.ok) {
        const data = await priceRes.json()
        const q = data?.data?.BTC?.quote?.USD
        if (q?.price > 0) {
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

    // Binance fallback — free, real-time, no key required
    if (!quote) {
      const [tickerRes, statsRes] = await Promise.all([
        fetch('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT', { cache: 'no-store' }).catch(() => null),
        fetch('https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT',  { cache: 'no-store' }).catch(() => null),
      ])
      if (tickerRes?.ok && statsRes?.ok) {
        const ticker = await tickerRes.json()
        const stats  = await statsRes.json()
        const price  = parseFloat(ticker.price)
        if (price > 0) {
          quote = {
            price,
            percent_change_1h: 0,
            percent_change_24h: parseFloat(stats.priceChangePercent),
            volume_24h: parseFloat(stats.quoteVolume),
            market_cap: price * 19_700_000,
            last_updated: new Date().toISOString(),
          }
        }
      }
    }

    if (!quote) {
      return NextResponse.json({ error: 'BTC price unavailable — all sources failed' }, { status: 503 })
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

    const pipeline = await runAgentPipeline(markets, quote, orderbook, provider)
    return NextResponse.json(pipeline)
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

