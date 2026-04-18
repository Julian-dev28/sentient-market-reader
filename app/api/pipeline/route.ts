import { NextResponse, type NextRequest } from 'next/server'
import { runAgentPipeline } from '@/lib/agents'
import { buildKalshiHeaders } from '@/lib/kalshi-auth'
import { getBalance } from '@/lib/kalshi-trade'
import type { KalshiMarket, KalshiOrderbook, BTCQuote, OHLCVCandle, DerivativesSignal } from '@/lib/types'
import { normalizeKalshiMarket } from '@/lib/types'
import type { AIProvider } from '@/lib/llm-client'
import { tryLockPipeline, releasePipelineLock } from '@/lib/pipeline-lock'
import { KALSHI_HOST, MONTHS_ET, getCurrentEventTicker, getCurrentKXBTCDEventTicker } from '@/lib/kalshi'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300  // 5 min — blitz ROMA makes ~6 LLM calls per solve (~90-150s)


export async function GET(req: NextRequest) {
  // Reject concurrent pipeline runs — each ROMA solve takes ~90-150s; stacking requests
  // fills the Python service queue with zombie tasks and causes cascading timeouts.
  if (!tryLockPipeline()) {
    return NextResponse.json({ error: 'Pipeline already running — retry in ~2min' }, { status: 429 })
  }

  const p = process.env.AI_PROVIDER ?? 'grok'
  const validProviders = ['anthropic', 'openai', 'grok', 'openrouter', 'huggingface'] as const
  const provider: AIProvider = (validProviders as readonly string[]).includes(p) ? p as AIProvider : 'grok'

  // ── Parse mode params FIRST — determines which data paths are required ──────
  // Must be before any 503 gates so hourly mode isn't blocked by missing 15m markets.
  const romaMode    = req.nextUrl.searchParams.get('mode') ?? process.env.ROMA_MODE ?? 'keen'
  const aiRisk      = req.nextUrl.searchParams.get('aiRisk') === 'true'
  const marketMode  = (req.nextUrl.searchParams.get('marketMode') ?? '15m') as '15m' | 'hourly'
  const isHourlyMode = marketMode === 'hourly'

  const p2raw = req.nextUrl.searchParams.get('provider2') ?? process.env.AI_PROVIDER2
  const provider2: AIProvider | undefined =
    p2raw && (validProviders as readonly string[]).includes(p2raw) ? p2raw as AIProvider : undefined

  const providersRaw = req.nextUrl.searchParams.get('providers') ?? process.env.AI_PROVIDERS ?? ''
  const providers: AIProvider[] | undefined = providersRaw
    ? (providersRaw.split(',').filter(p => (validProviders as readonly string[]).includes(p)) as AIProvider[])
    : undefined

  const orModelOverride = req.nextUrl.searchParams.get('orModel') || undefined

  let apiKeys: Record<string, string> | undefined
  const keysHeader = req.headers.get('x-provider-keys')
  if (keysHeader) {
    try {
      apiKeys = JSON.parse(Buffer.from(keysHeader, 'base64').toString('utf8'))
    } catch { /* ignore malformed header */ }
  }

  // ── Data-fetching phase (before stream starts) ──────────────────────────
  // Any errors here return a plain HTTP response. Once we start the SSE stream,
  // errors are sent as SSE events and the lock is released in the stream's finally.
  let streamStarted = false
  try {
    // Accept markets that Kalshi considers 'active' and have live bid/ask pricing.
    const now = Date.now()
    const isTradeable = (m: KalshiMarket) =>
      m.status === 'active' &&
      m.yes_ask > 0 &&
      (m.close_time ? new Date(m.close_time).getTime() > now : true)

    // Try to fetch the currently active KXBTC15M market using computed event_ticker.
    // In hourly mode this is informational — a missing 15m market is not fatal.
    let markets: KalshiMarket[] = []

    const eventTicker = getCurrentEventTicker()
    const eventPath = `/trade-api/v2/markets?event_ticker=${eventTicker}&limit=5`
    const eventRes = await fetch(
      `${KALSHI_HOST}${eventPath}`,
      { headers: { ...buildKalshiHeaders('GET', eventPath), Accept: 'application/json' }, cache: 'no-store' }
    ).catch(() => null)

    if (eventRes?.ok) {
      const data = await eventRes.json()
      markets = (data.markets ?? []).map(normalizeKalshiMarket).filter(isTradeable)
    }

    // Fallback: series-level query (15m mode only — skip in hourly to avoid serial latency)
    if (!markets.length && !isHourlyMode) {
      const fallbackPath = '/trade-api/v2/markets?series_ticker=KXBTC15M&limit=100'
      const fallbackRes = await fetch(
        `${KALSHI_HOST}${fallbackPath}`,
        { headers: { ...buildKalshiHeaders('GET', fallbackPath), Accept: 'application/json' }, cache: 'no-store' }
      ).catch(() => null)
      if (fallbackRes?.ok) {
        const data = await fallbackRes.json()
        markets = (data.markets ?? []).map(normalizeKalshiMarket).filter(isTradeable)
      }
    }

    // In 15m mode, a missing market means we can't trade — abort early.
    // In hourly mode, we continue and the KXBTCD fetch below provides the market.
    if (!markets.length && !isHourlyMode) {
      console.warn('[pipeline] No active KXBTC15M markets found for', eventTicker)
      return NextResponse.json({ error: 'No active KXBTC15M markets found' }, { status: 503 })
    }

    // Fetch BTC price — Coinbase Exchange ticker only (matches Kalshi's index price exactly).
    // Kalshi KXBTC15M settles against the Coinbase Exchange price.
    let quote: BTCQuote | null = null

    const cbExRes = await fetch('https://api.exchange.coinbase.com/products/BTC-USD/ticker', { cache: 'no-store' }).catch(() => null)
    if (cbExRes?.ok) {
      const cb = await cbExRes.json()
      const price = parseFloat(cb?.price)
      if (price > 0) {
        quote = { price, percent_change_1h: 0, percent_change_24h: 0, volume_24h: 0, market_cap: price * 19_700_000, last_updated: new Date().toISOString() }
        console.log(`[pipeline] BTC spot: $${price.toLocaleString()} (Coinbase Exchange)`)
      }
    }

    if (!quote) {
      console.warn('[pipeline] BTC price unavailable — all sources failed')
      return NextResponse.json({ error: 'BTC price unavailable — all sources failed' }, { status: 503 })
    }

    let portfolioValueCents = 0
    const balResult = await getBalance().catch(() => null)
    if (balResult?.ok && balResult.data) {
      portfolioValueCents = (balResult.data.balance ?? 0) + (balResult.data.portfolio_value ?? 0)
    }

    const kxbtcdEventTicker = isHourlyMode ? getCurrentKXBTCDEventTicker() : null
    const kxbtcdEventPath   = kxbtcdEventTicker
      ? `/trade-api/v2/markets?event_ticker=${kxbtcdEventTicker}&limit=200`
      : null
    // Events API discovery — used as fallback when the computed ticker returns 0 markets.
    // Kalshi KXBTCD doesn't run 24/7; this finds whatever event is actually open right now.
    const kxbtcdEventsPath  = isHourlyMode ? '/trade-api/v2/events?series_ticker=KXBTCD&status=open&limit=10' : null

    // 15m OB: skip in hourly mode. KXBTCD OB fetched after market selection (ticker not known yet).
    const ob15mTicker = markets.length > 0 ? markets[0].ticker : null
    const ob15mPath   = ob15mTicker ? `/trade-api/v2/markets/${ob15mTicker}/orderbook` : null

    // Coinbase candles format: [time_s, low, high, open, close, vol] newest-first
    // granularity=900→15m, 60→1m, 3600→1h, 14400→4h
    const [candleRes, liveCandleRes, candle1hRes, candle4hRes, bybitRes, obRes, kxbtcdRes, kxbtcdEventsRes] = await Promise.all([
      fetch('https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=900&limit=14', { cache: 'no-store' }).catch(() => null),
      fetch('https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60&limit=17', { cache: 'no-store' }).catch(() => null),
      fetch('https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=3600&limit=13', { cache: 'no-store' }).catch(() => null),
      fetch('https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=14400&limit=8', { cache: 'no-store' }).catch(() => null),
      fetch('https://api.bybit.com/v5/market/tickers?category=linear&symbol=BTCUSDT', { cache: 'no-store' }).catch(() => null),
      // 15m orderbook — null when no 15m markets (hourly mode); avoids markets[0] crash
      ob15mPath
        ? fetch(`${KALSHI_HOST}${ob15mPath}`, {
            headers: { ...buildKalshiHeaders('GET', ob15mPath), Accept: 'application/json' },
            cache: 'no-store',
          }).catch(() => null)
        : Promise.resolve(null),
      // KXBTCD markets — only fetched in hourly mode; queries by computed event_ticker
      // so we get exactly the current hour's 188+ strike markets (all with yes_ask > 0)
      kxbtcdEventPath
        ? fetch(`${KALSHI_HOST}${kxbtcdEventPath}`, {
            headers: { ...buildKalshiHeaders('GET', kxbtcdEventPath), Accept: 'application/json' },
            cache: 'no-store',
          }).catch(() => null)
        : Promise.resolve(null),
      // KXBTCD events discovery — runs in parallel as a fallback source.
      // If the computed event ticker finds 0 markets (e.g. off-hours), we use the soonest
      // open event from this response instead of failing.
      kxbtcdEventsPath
        ? fetch(`${KALSHI_HOST}${kxbtcdEventsPath}`, {
            headers: { ...buildKalshiHeaders('GET', kxbtcdEventsPath), Accept: 'application/json' },
            cache: 'no-store',
          }).catch(() => null)
        : Promise.resolve(null),
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

    let candles1h: OHLCVCandle[] = []
    if (candle1hRes?.ok) {
      const raw = await candle1hRes.json()
      candles1h = Array.isArray(raw) ? raw.slice(1, 13) as OHLCVCandle[] : []
    }

    let candles4h: OHLCVCandle[] = []
    if (candle4hRes?.ok) {
      const raw = await candle4hRes.json()
      candles4h = Array.isArray(raw) ? raw.slice(1, 8) as OHLCVCandle[] : []
    }

    console.log(`[pipeline] candles: 15m=${candles.length} 1m=${liveCandles.length} 1h=${candles1h.length} 4h=${candles4h.length} | cb1h=${candle1hRes?.status ?? 'fail'} cb4h=${candle4hRes?.status ?? 'fail'}`)

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

    // ── KXBTCD: select highest-liquidity strike market ─────────────────────
    // Only relevant in hourly mode — skipped entirely in 15m mode.
    let kxbtcdMarket: KalshiMarket | null = null
    let orderbook: KalshiOrderbook | null = null

    if (obRes?.ok) {
      const data = await obRes.json()
      orderbook = data.orderbook ?? null  // 15m orderbook (null if no 15m markets)
    }

    if (isHourlyMode) {
      let kxbtcdMarkets: KalshiMarket[] = []
      const parseKxbtcdMarkets = (data: { markets?: unknown[] }, label: string): KalshiMarket[] => {
        const raw: KalshiMarket[] = (data.markets ?? []).map(normalizeKalshiMarket)
        if (raw.length > 0) {
          const s = raw[0]
          console.log(`[pipeline] KXBTCD ${label}[0]: ticker=${s.ticker} status="${s.status}" yes_ask=${s.yes_ask} close_time=${s.close_time}`)
        }
        const tradeable = raw.filter(m =>
          m.status !== 'settled' && m.status !== 'finalized' && m.status !== 'closed' &&
          m.yes_ask > 0 &&
          (m.close_time ? new Date(m.close_time).getTime() > now + 60_000 : true)  // ≥1 min remaining
        )
        console.log(`[pipeline] KXBTCD ${label}: ${raw.length} raw → ${tradeable.length} tradeable`)
        return tradeable
      }

      if (kxbtcdRes?.ok) {
        const data = await kxbtcdRes.json()
        kxbtcdMarkets = parseKxbtcdMarkets(data, kxbtcdEventTicker!)
      } else {
        console.warn(`[pipeline] KXBTCD fetch failed: HTTP ${kxbtcdRes?.status ?? 'no response'} for ${kxbtcdEventTicker}`)
      }

      // Fallback 1: try next ET hour (handles the "just expired" edge case)
      if (!kxbtcdMarkets.length) {
        const nextTicker = getCurrentKXBTCDEventTicker(1)
        const nextPath   = `/trade-api/v2/markets?event_ticker=${nextTicker}&limit=200`
        console.log(`[pipeline] KXBTCD fallback → trying ${nextTicker}`)
        const nextRes = await fetch(`${KALSHI_HOST}${nextPath}`, {
          headers: { ...buildKalshiHeaders('GET', nextPath), Accept: 'application/json' },
          cache: 'no-store',
        }).catch(() => null)
        if (nextRes?.ok) {
          const data = await nextRes.json()
          kxbtcdMarkets = parseKxbtcdMarkets(data, nextTicker)
        }
      }

      // Fallback 2: events API discovery — finds whatever KXBTCD event is actually open.
      // Kalshi doesn't create an event for every hour; this discovers the actual schedule.
      if (!kxbtcdMarkets.length && kxbtcdEventsRes?.ok) {
        const evData = await kxbtcdEventsRes.json()
        const events: Array<{ event_ticker: string; close_time?: string }> = evData.events ?? []

        // Parse close time from event_ticker (KXBTCD-{YY}{MON}{DD}{HH}) when the API
        // doesn't provide a close_time field directly. EDT = UTC-4 in April.
        const kxbtcdCloseMs = (ticker: string, apiCloseTime?: string): number => {
          if (apiCloseTime) return new Date(apiCloseTime).getTime()
          const m = ticker.match(/^KXBTCD-(\d{2})([A-Z]{3})(\d{2})(\d{2})$/)
          if (!m) return 0
          const [, yy, mon, dd, hh] = m
          const monthIdx = MONTHS_ET.indexOf(mon)
          if (monthIdx === -1) return 0
          // EDT offset: -4h (April is always EDT)
          return Date.UTC(2000 + parseInt(yy), monthIdx, parseInt(dd), parseInt(hh) + 4, 0, 0)
        }

        const futureEvents = events
          .map(e => ({ ...e, closeMs: kxbtcdCloseMs(e.event_ticker, e.close_time) }))
          .filter(e => e.closeMs > now)
          .sort((a, b) => a.closeMs - b.closeMs)   // soonest first

        if (futureEvents.length > 0) {
          const discoveredTicker = futureEvents[0].event_ticker
          console.log(`[pipeline] KXBTCD events API discovered: ${discoveredTicker} (closes ${new Date(futureEvents[0].closeMs).toISOString()})`)
          const discoveredPath = `/trade-api/v2/markets?event_ticker=${discoveredTicker}&limit=200`
          const discoveredRes = await fetch(`${KALSHI_HOST}${discoveredPath}`, {
            headers: { ...buildKalshiHeaders('GET', discoveredPath), Accept: 'application/json' },
            cache: 'no-store',
          }).catch(() => null)
          if (discoveredRes?.ok) {
            const data = await discoveredRes.json()
            kxbtcdMarkets = parseKxbtcdMarkets(data, discoveredTicker)
          }
        } else {
          console.warn(`[pipeline] KXBTCD events API: ${events.length} events found, none with future close_time`)
        }
      }

      if (kxbtcdMarkets.length) {
        // Sort descending by liquidity (volume + open_interest), pick the most liquid strike
        kxbtcdMarket = kxbtcdMarkets.sort(
          (a, b) => (b.volume + b.open_interest) - (a.volume + a.open_interest)
        )[0]
        console.log(`[pipeline] KXBTCD: selected ${kxbtcdMarket.ticker} from ${kxbtcdMarkets.length} strikes (vol=${kxbtcdMarket.volume.toFixed(0)} oi=${kxbtcdMarket.open_interest.toFixed(0)})`)

        // Fetch KXBTCD orderbook for the selected market (overrides 15m OB in hourly mode)
        const kxbtcdObPath = `/trade-api/v2/markets/${kxbtcdMarket.ticker}/orderbook`
        const kxbtcdObRes = await fetch(
          `${KALSHI_HOST}${kxbtcdObPath}`,
          { headers: { ...buildKalshiHeaders('GET', kxbtcdObPath), Accept: 'application/json' }, cache: 'no-store' }
        ).catch(() => null)
        if (kxbtcdObRes?.ok) {
          const data = await kxbtcdObRes.json()
          orderbook = data.orderbook ?? null  // KXBTCD orderbook replaces 15m OB for Grok
        }
      } else {
        console.warn(`[pipeline] KXBTCD: no tradeable markets found (tried ${kxbtcdEventTicker}, next hour, and events API)`)
        return NextResponse.json({ error: 'KXBTCD_NO_MARKET', message: 'No active KXBTCD market right now — the market may not be open at this hour.' }, { status: 503 })
      }
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
            candles1h,
            candles4h,
            isHourlyMode ? kxbtcdMarket : null,  // only activate KXBTCD in hourly mode
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

