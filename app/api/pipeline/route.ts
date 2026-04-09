import { NextResponse, type NextRequest } from 'next/server'
import { runAgentPipeline } from '@/lib/agents'
import { buildKalshiHeaders } from '@/lib/kalshi-auth'
import { getBalance } from '@/lib/kalshi-trade'
import type { KalshiMarket, KalshiOrderbook, BTCQuote, OHLCVCandle, DerivativesSignal } from '@/lib/types'
import { normalizeKalshiMarket } from '@/lib/types'
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

  // ── Data-fetching phase (before stream starts) ──────────────────────────
  // Any errors here return a plain HTTP response. Once we start the SSE stream,
  // errors are sent as SSE events and the lock is released in the stream's finally.
  let streamStarted = false
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
    const now = Date.now()
    const isTradeable = (m: KalshiMarket) =>
      m.status === 'active' &&
      m.yes_ask > 0 &&
      (m.close_time ? new Date(m.close_time).getTime() > now : true)

    if (eventRes?.ok) {
      const data = await eventRes.json()
      markets = (data.markets ?? []).map(normalizeKalshiMarket).filter(isTradeable)
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
        markets = (data.markets ?? []).map(normalizeKalshiMarket).filter(isTradeable)
      }
    }

    if (!markets.length) {
      return NextResponse.json({ error: 'No active KXBTC15M markets found' }, { status: 503 })
    }

    // Fetch BTC price — Coinbase primary, fallbacks
    let quote: BTCQuote | null = null

    const cbRes = await fetch('https://api.coinbase.com/v2/prices/BTC-USD/spot', { cache: 'no-store' }).catch(() => null)
    if (cbRes?.ok) {
      const cb = await cbRes.json()
      const price = parseFloat(cb?.data?.amount)
      if (price > 0) quote = { price, percent_change_1h: 0, percent_change_24h: 0, volume_24h: 0, market_cap: price * 19_700_000, last_updated: new Date().toISOString() }
    }

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

    // Fetch Kalshi balance for portfolio-aware risk/execution sizing
    let portfolioValueCents = 0
    const balResult = await getBalance().catch(() => null)
    if (balResult?.ok && balResult.data) {
      portfolioValueCents = (balResult.data.balance ?? 0) + (balResult.data.portfolio_value ?? 0)
    }

    // Fetch candles, live candles, derivatives, orderbook in parallel
    const [candleRes, liveCandleRes, bybitRes, obRes] = await Promise.all([
      fetch('https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=900&limit=13', { cache: 'no-store' }).catch(() => null),
      fetch('https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60&limit=16', { cache: 'no-store' }).catch(() => null),
      fetch('https://api.bybit.com/v5/market/tickers?category=linear&symbol=BTCUSDT', { cache: 'no-store' }).catch(() => null),
      fetch(`https://api.elections.kalshi.com/trade-api/v2/markets/${markets[0].ticker}/orderbook`, {
        headers: { ...buildKalshiHeaders('GET', `/trade-api/v2/markets/${markets[0].ticker}/orderbook`), Accept: 'application/json' },
        cache: 'no-store',
      }).catch(() => null),
    ])

    let candles: OHLCVCandle[] = []
    if (candleRes?.ok) {
      const raw = await candleRes.json()
      candles = Array.isArray(raw) ? raw.slice(1, 13) as OHLCVCandle[] : []
    }

    let liveCandles: OHLCVCandle[] = []
    if (liveCandleRes?.ok) {
      const raw = await liveCandleRes.json()
      liveCandles = Array.isArray(raw) ? raw as OHLCVCandle[] : []
    }

    let derivatives: DerivativesSignal | null = null
    if (bybitRes?.ok) {
      const data = await bybitRes.json()
      const ticker = data?.result?.list?.[0]
      if (ticker) {
        const markPrice = parseFloat(ticker.markPrice)
        const indexPrice = parseFloat(ticker.indexPrice)
        const fundingRate = parseFloat(ticker.fundingRate)
        if (markPrice > 0 && indexPrice > 0 && !isNaN(fundingRate)) {
          derivatives = { fundingRate, basis: ((markPrice - indexPrice) / indexPrice) * 100, markPrice, indexPrice, source: 'bybit' }
        }
      }
    }

    let orderbook: KalshiOrderbook | null = null
    if (obRes?.ok) {
      const data = await obRes.json()
      orderbook = data.orderbook ?? null
    }

    // ── Parse query params ────────────────────────────────────────────────
    const romaMode = req.nextUrl.searchParams.get('mode') ?? process.env.ROMA_MODE ?? 'keen'
    const aiRisk   = req.nextUrl.searchParams.get('aiRisk') === 'true'

    const p2raw = req.nextUrl.searchParams.get('provider2') ?? process.env.AI_PROVIDER2
    const provider2: AIProvider | undefined =
      p2raw && (validProviders as readonly string[]).includes(p2raw) ? p2raw as AIProvider : undefined

    const providersRaw = req.nextUrl.searchParams.get('providers') ?? process.env.AI_PROVIDERS ?? ''
    const providers: AIProvider[] | undefined = providersRaw
      ? (providersRaw.split(',').filter(p => (validProviders as readonly string[]).includes(p)) as AIProvider[])
      : undefined

    const orModelOverride  = req.nextUrl.searchParams.get('orModel') || undefined

    // Read user-provided API keys from request header (base64-encoded JSON)
    let apiKeys: Record<string, string> | undefined
    const keysHeader = req.headers.get('x-provider-keys')
    if (keysHeader) {
      try {
        apiKeys = JSON.parse(Buffer.from(keysHeader, 'base64').toString('utf8'))
      } catch { /* ignore malformed header */ }
    }

    // ── SSE stream phase ──────────────────────────────────────────────────
    // All data is fetched; start the event stream. Lock is released in stream's finally.
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      async start(controller) {
        function enc(event: string, data: unknown) {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
        }
        try {
          const pipeline = await runAgentPipeline(
            markets, quote!, orderbook, provider, romaMode, aiRisk,
            provider2, providers,
            candles, liveCandles, derivatives, orModelOverride, req.signal,
            (key, result) => enc('agent', { key, result }),
            portfolioValueCents,
            apiKeys,
          )
          enc('done', pipeline)
        } catch (err) {
          if (err instanceof Error && err.name === 'AbortError') {
            enc('aborted', {})
          } else {
            enc('error', { message: String(err) })
          }
        } finally {
          releasePipelineLock()
          controller.close()
        }
      },
    })

    streamStarted = true
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',  // disable nginx buffering
      },
    })
  } finally {
    // Only release lock here if stream never started (data-fetch error path).
    // If the stream started, it owns the lock and releases it in its own finally.
    if (!streamStarted) releasePipelineLock()
  }
}

