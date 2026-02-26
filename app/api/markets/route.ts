import { NextResponse } from 'next/server'
import { buildKalshiHeaders } from '@/lib/kalshi-auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const KALSHI_BASE = 'https://api.elections.kalshi.com/trade-api/v2'

/** Compute the current active KXBTC15M event_ticker in US Eastern Time */
function getCurrentEventTicker(): string {
  const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC']
  const now = new Date()
  const etStr = now.toLocaleString('en-US', { timeZone: 'America/New_York' })
  const et = new Date(etStr)
  const mins = et.getMinutes()
  const blockEnd = Math.ceil((mins + 1) / 15) * 15
  et.setMinutes(blockEnd, 0, 0)

  const yy  = String(et.getFullYear()).slice(-2)
  const mon = MONTHS[et.getMonth()]
  const dd  = String(et.getDate()).padStart(2, '0')
  const hh  = String(et.getHours()).padStart(2, '0')
  const mm  = String(et.getMinutes() % 60).padStart(2, '0')
  return `KXBTC15M-${yy}${mon}${dd}${hh}${mm}`
}

/** A market is still tradeable: window hasn't closed and prices are live (not 0 or 100 = settled extremes) */
function isTradeable(m: { yes_ask: number; close_time?: string }): boolean {
  if (m.close_time && new Date(m.close_time).getTime() <= Date.now()) return false
  return m.yes_ask > 1 && m.yes_ask < 99
}

export async function GET() {
  // ── Attempt 1: query by current event_ticker (most precise) ──────────────
  try {
    const eventTicker = getCurrentEventTicker()
    const path = `/trade-api/v2/markets?event_ticker=${eventTicker}&limit=5`
    const res = await fetch(`https://api.elections.kalshi.com${path}`, {
      headers: { ...buildKalshiHeaders('GET', path), Accept: 'application/json' },
      cache: 'no-store',
    })
    if (res.ok) {
      const data = await res.json()
      const active = (data.markets ?? []).filter(isTradeable)
      if (active.length > 0) return NextResponse.json({ ...data, markets: active })
    }
  } catch { /* fall through */ }

  // ── Attempt 2: series query with auth ─────────────────────────────────────
  try {
    const path = '/trade-api/v2/markets?series_ticker=KXBTC15M&limit=20'
    const res = await fetch(`https://api.elections.kalshi.com${path}`, {
      headers: { ...buildKalshiHeaders('GET', path), Accept: 'application/json' },
      cache: 'no-store',
    })
    if (res.ok) {
      const data = await res.json()
      const active = (data.markets ?? []).filter(isTradeable)
      if (active.length > 0) return NextResponse.json({ ...data, markets: active })
    }
  } catch { /* fall through */ }

  // Both Kalshi queries failed or no tradeable markets yet (between windows)
  return NextResponse.json({ error: 'No active KXBTC15M markets found', markets: [] }, { status: 503 })
}
