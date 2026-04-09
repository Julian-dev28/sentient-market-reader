import { NextResponse } from 'next/server'
import { buildKalshiHeaders } from '@/lib/kalshi-auth'
import { normalizeKalshiMarket } from '@/lib/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const KALSHI_BASE = 'https://api.elections.kalshi.com'

/** Compute the current active KXBTC15M event_ticker in US Eastern Time.
 *  Uses formatToParts to avoid the toLocaleString→new Date() re-parse bug where
 *  the locale string is re-interpreted in the server's local TZ instead of ET.
 */
function getCurrentEventTicker(): string {
  const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC']
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

/** A market is still tradeable: window hasn't closed and prices are live (not 0 or 100 = settled extremes) */
function isTradeable(m: { yes_ask: number; close_time?: string }): boolean {
  if (m.close_time && new Date(m.close_time).getTime() <= Date.now()) return false
  return m.yes_ask > 0 && m.yes_ask < 100
}

export async function GET() {
  // ── Attempt 1: query by current event_ticker (most precise) ──────────────
  try {
    const eventTicker = getCurrentEventTicker()
    const path = `/trade-api/v2/markets?event_ticker=${eventTicker}&limit=5`
    const res = await fetch(`${KALSHI_BASE}${path}`, {
      headers: { ...buildKalshiHeaders('GET', path), Accept: 'application/json' },
      cache: 'no-store',
    })
    if (res.ok) {
      const data = await res.json()
      const active = (data.markets ?? []).map(normalizeKalshiMarket).filter(isTradeable)
      if (active.length > 0) return NextResponse.json({ ...data, markets: active })
    }
  } catch { /* fall through */ }

  // ── Attempt 2: series query with auth ─────────────────────────────────────
  try {
    const path = '/trade-api/v2/markets?series_ticker=KXBTC15M&limit=20'
    const res = await fetch(`${KALSHI_BASE}${path}`, {
      headers: { ...buildKalshiHeaders('GET', path), Accept: 'application/json' },
      cache: 'no-store',
    })
    if (res.ok) {
      const data = await res.json()
      const active = (data.markets ?? []).map(normalizeKalshiMarket).filter(isTradeable)
      if (active.length > 0) return NextResponse.json({ ...data, markets: active })
    }
  } catch { /* fall through */ }

  // Both Kalshi queries failed or no tradeable markets yet (between windows)
  return NextResponse.json({ error: 'No active KXBTC15M markets found', markets: [] }, { status: 503 })
}
