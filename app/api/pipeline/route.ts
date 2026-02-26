import { NextResponse, type NextRequest } from 'next/server'
import { runAgentPipeline } from '@/lib/agents'
import { buildKalshiHeaders } from '@/lib/kalshi-auth'
import type { KalshiMarket, KalshiOrderbook, BTCQuote } from '@/lib/types'
import type { AIProvider } from '@/lib/llm-client'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 180  // allow up to 3 min — depth=1 ROMA typically completes in ~60s

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

export async function GET(req: NextRequest) {
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

    // Fetch BTC price — Coinbase primary, CMC fallback
    let quote: BTCQuote | null = null

    // ── Primary: Coinbase ────────────────────────────────────────────────────
    const cbRes = await fetch('https://api.coinbase.com/v2/prices/BTC-USD/spot', { cache: 'no-store' }).catch(() => null)
    if (cbRes?.ok) {
      const cb = await cbRes.json()
      const price = parseFloat(cb?.data?.amount)
      if (price > 0) quote = { price, percent_change_1h: 0, percent_change_24h: 0, volume_24h: 0, market_cap: price * 19_700_000, last_updated: new Date().toISOString() }
    }

    // ── Fallback: CoinGecko (includes 24h change) ────────────────────────────
    if (!quote) {
      const cgRes = await fetch(
        'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true',
        { cache: 'no-store' }
      ).catch(() => null)
      if (cgRes?.ok) {
        const data = await cgRes.json()
        const price = data?.bitcoin?.usd
        if (price > 0) quote = { price, percent_change_1h: 0, percent_change_24h: data?.bitcoin?.usd_24h_change ?? 0, volume_24h: 0, market_cap: price * 19_700_000, last_updated: new Date().toISOString() }
      }
    }

    // ── Fallback 2: Jupiter DEX (wBTC on Solana) ─────────────────────────────
    if (!quote) {
      const jupKey = process.env.JUPITER_API_KEY
      if (jupKey) {
        const jupRes = await fetch(
          'https://api.jup.ag/price/v2?ids=9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E',
          { headers: { Authorization: `Bearer ${jupKey}`, Accept: 'application/json' }, cache: 'no-store' }
        ).catch(() => null)
        if (jupRes?.ok) {
          const data = await jupRes.json()
          const price = parseFloat(data?.data?.['9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E']?.price)
          if (price > 0) quote = { price, percent_change_1h: 0, percent_change_24h: 0, volume_24h: 0, market_cap: price * 19_700_000, last_updated: new Date().toISOString() }
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

    const romaMode = req.nextUrl.searchParams.get('mode') ?? process.env.ROMA_MODE ?? 'smart'
    const pipeline = await runAgentPipeline(markets, quote, orderbook, provider, romaMode)
    return NextResponse.json(pipeline)
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

