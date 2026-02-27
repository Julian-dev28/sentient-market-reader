import { NextResponse, type NextRequest } from 'next/server'
import { runAgentPipeline } from '@/lib/agents'
import { buildKalshiHeaders } from '@/lib/kalshi-auth'
import type { KalshiMarket, KalshiOrderbook, BTCQuote } from '@/lib/types'
import type { AIProvider } from '@/lib/llm-client'
import { tryLockPipeline, releasePipelineLock } from '@/lib/pipeline-lock'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300  // 5 min — blitz ROMA makes ~6 LLM calls per solve (~90-150s)

/** Compute the current active KXBTC15M event_ticker using ET timezone
 *  Format: KXBTC15M-{YY}{MON}{DD}{HHMM} — date/time in US Eastern Time
 */
function getCurrentEventTicker(): string {
  const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC']
  // Use formatToParts — avoids the new Date(localeString) re-parse bug where
  // the locale string is re-interpreted in the server's local TZ instead of ET.
  const now = new Date()
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', hour12: false,
    }).formatToParts(now)
      .filter(p => p.type !== 'literal')
      .map(p => [p.type, parseInt(p.value)])
  ) as Record<string, number>

  const { year, month, day, hour, minute } = parts

  // Advance to the end of the current 15-min block
  let blockMin  = Math.ceil((minute + 1) / 15) * 15
  let blockHour = hour % 24  // hour12:false can yield 24 at midnight on some engines
  if (blockMin >= 60) { blockMin = 0; blockHour += 1 }

  const yy  = String(year).slice(-2)
  const mon = MONTHS[month - 1]
  const dd  = String(day).padStart(2, '0')
  const hh  = String(blockHour).padStart(2, '0')
  const mm  = String(blockMin).padStart(2, '0')
  return `KXBTC15M-${yy}${mon}${dd}${hh}${mm}`
}

export async function GET(req: NextRequest) {
  // Reject concurrent pipeline runs — each ROMA solve takes ~90-150s; stacking requests
  // fills the Python service queue with zombie tasks and causes cascading timeouts.
  if (!tryLockPipeline()) {
    return NextResponse.json({ error: 'Pipeline already running — retry in ~2min' }, { status: 429 })
  }

  const p = process.env.AI_PROVIDER ?? 'grok'
  const validProviders = ['anthropic', 'openai', 'grok', 'openrouter', 'huggingface'] as const
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

    // Accept markets that Kalshi considers 'active' and have live bid/ask pricing.
    // Avoid yes_ask price range filtering — it rejects valid markets at the start
    // (yes_ask=0 while initialized) and near close (yes_ask=98/99 in final seconds).
    // Kalshi's own `status` field is the authoritative signal.
    const now = Date.now()
    const isTradeable = (m: KalshiMarket) =>
      m.status === 'active' &&
      m.yes_ask > 0 &&   // must have live pricing (0 = not yet priced)
      (m.close_time ? new Date(m.close_time).getTime() > now : true)

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
    const aiRisk   = req.nextUrl.searchParams.get('aiRisk') === 'true'

    // Split-provider: provider2 for ProbabilityModel stage (eliminates inter-stage pause)
    const p2raw    = req.nextUrl.searchParams.get('provider2') ?? process.env.AI_PROVIDER2
    const provider2: AIProvider | undefined =
      p2raw && (validProviders as readonly string[]).includes(p2raw) ? p2raw as AIProvider : undefined

    // Multi-provider parallel: comma-separated ?providers=grok,huggingface for Sentiment ensemble
    const providersRaw = req.nextUrl.searchParams.get('providers') ?? process.env.AI_PROVIDERS ?? ''
    const providers: AIProvider[] | undefined = providersRaw
      ? (providersRaw.split(',').filter(p => (validProviders as readonly string[]).includes(p)) as AIProvider[])
      : undefined

    const pipeline = await runAgentPipeline(markets, quote, orderbook, provider, romaMode, aiRisk, provider2, providers)
    return NextResponse.json(pipeline)
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  } finally {
    releasePipelineLock()
  }
}

