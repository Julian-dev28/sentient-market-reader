import { NextResponse } from 'next/server'
import { buildKalshiHeaders } from '@/lib/kalshi-auth'
import { KALSHI_HOST, MONTHS_ET, getETParts } from '@/lib/kalshi'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Debug endpoint — shows what KXBTCD events and markets Kalshi currently has open.
 * GET /api/kxbtcd-debug
 * Returns: { events, sampleMarkets, computedTicker }
 */
export async function GET() {
  const now = new Date()

  // Compute what our ET-based ticker generator would produce
  const { year, month, day, hour } = getETParts()
  const closeHour = (hour % 24) + 1
  const yy = String(year).slice(-2)
  const mon = MONTHS_ET[month - 1]
  const dd = String(day).padStart(2, '0')
  const hh = String(closeHour).padStart(2, '0')
  const computedTicker = `KXBTCD-${yy}${mon}${dd}${hh}`

  // Fetch open events from Kalshi events API
  const eventsPath = '/trade-api/v2/events?series_ticker=KXBTCD&status=open&limit=20'
  const eventsRes = await fetch(`${KALSHI_HOST}${eventsPath}`, {
    headers: { ...buildKalshiHeaders('GET', eventsPath), Accept: 'application/json' },
    cache: 'no-store',
  }).catch(() => null)

  const eventsData = eventsRes?.ok ? await eventsRes.json() : null
  const events = eventsData?.events ?? []

  // Also fetch the computed ticker's markets to see what we get
  const computedPath = `/trade-api/v2/markets?event_ticker=${computedTicker}&limit=10`
  const computedRes = await fetch(`${KALSHI_HOST}${computedPath}`, {
    headers: { ...buildKalshiHeaders('GET', computedPath), Accept: 'application/json' },
    cache: 'no-store',
  }).catch(() => null)
  const computedData = computedRes?.ok ? await computedRes.json() : null

  return NextResponse.json({
    utcNow: now.toISOString(),
    etParts: { year, month, day, hour },
    computedTicker,
    computedTickerMarkets: {
      status: computedRes?.status,
      count: computedData?.markets?.length ?? 0,
      sample: (computedData?.markets ?? []).slice(0, 3).map((m: Record<string, unknown>) => ({
        ticker: m.ticker,
        status: m.status,
        yes_ask: m.yes_ask,
        close_time: m.close_time,
      })),
    },
    openEvents: {
      status: eventsRes?.status,
      count: events.length,
      events: events.map((e: Record<string, unknown>) => ({
        event_ticker: e.event_ticker,
        title: e.title,
        close_time: e.close_time ?? e.end_date,
        status: e.status,
      })),
    },
  })
}
