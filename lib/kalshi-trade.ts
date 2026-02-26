/**
 * Kalshi Portfolio / Trading API
 * ────────────────────────────────
 * Authenticated endpoints (RSA-PSS signed).
 * All prices are in cents (1–99).
 */

import { buildKalshiHeaders } from './kalshi-auth'
import type { KalshiBalance, KalshiPosition, KalshiOrder, KalshiFill } from './types'

const KALSHI_BASE = 'https://api.elections.kalshi.com/trade-api/v2'

/** Safely extract a string error message from a Kalshi API response body.
 *  Kalshi sometimes returns error as an object: {code, message, details}.
 */
function extractError(body: unknown, status: number): string {
  if (!body || typeof body !== 'object') return `HTTP ${status}`
  const b = body as Record<string, unknown>
  const err = b.error
  if (typeof err === 'string') return err
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>
    return String(e.message ?? e.code ?? JSON.stringify(err))
  }
  if (typeof b.message === 'string') return b.message
  return `HTTP ${status}`
}

export interface PlaceOrderParams {
  ticker: string
  side: 'yes' | 'no'
  count: number           // number of contracts
  yesPrice?: number       // limit price in cents for YES side
  noPrice?: number        // limit price in cents for NO side
  clientOrderId?: string
}

export interface PlaceOrderResult {
  ok: boolean
  order?: KalshiOrder
  error?: string
}

export async function placeOrder(params: PlaceOrderParams): Promise<PlaceOrderResult> {
  const path = '/trade-api/v2/portfolio/orders'
  const body = {
    ticker: params.ticker,
    side: params.side,
    action: 'buy',
    count: params.count,
    ...(params.yesPrice !== undefined ? { yes_price: params.yesPrice } : {}),
    ...(params.noPrice  !== undefined ? { no_price:  params.noPrice  } : {}),
    time_in_force: 'good_till_canceled',
    ...(params.clientOrderId ? { client_order_id: params.clientOrderId } : {}),
  }

  try {
    const headers = buildKalshiHeaders('POST', path)
    if (!headers['KALSHI-ACCESS-KEY']) {
      return { ok: false, error: 'Missing Kalshi credentials' }
    }

    const res = await fetch(`${KALSHI_BASE}/portfolio/orders`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    const data = await res.json()
    if (!res.ok) {
      return { ok: false, error: extractError(data, res.status) }
    }
    return { ok: true, order: data.order as KalshiOrder }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
}

export async function cancelOrder(orderId: string): Promise<{ ok: boolean; error?: string }> {
  const path = `/trade-api/v2/portfolio/orders/${orderId}`
  try {
    const headers = buildKalshiHeaders('DELETE', path)
    const res = await fetch(`${KALSHI_BASE}/portfolio/orders/${orderId}`, {
      method: 'DELETE',
      headers,
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      return { ok: false, error: extractError(data, res.status) }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
}

export interface BalanceResult {
  ok: boolean
  data?: KalshiBalance
  error?: string
  status?: number
}

export async function getBalance(): Promise<BalanceResult> {
  const path = '/trade-api/v2/portfolio/balance'
  try {
    const headers = buildKalshiHeaders('GET', path)
    if (!headers['KALSHI-ACCESS-KEY']) {
      return { ok: false, error: 'Kalshi API key not configured' }
    }
    const res = await fetch(`${KALSHI_BASE}/portfolio/balance`, { headers, cache: 'no-store' })
    const body = await res.json().catch(() => null)
    if (!res.ok) {
      return { ok: false, error: extractError(body, res.status), status: res.status }
    }
    return { ok: true, data: body as KalshiBalance }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
}

export interface PositionsResult {
  ok: boolean
  positions?: KalshiPosition[]
  orders?: KalshiOrder[]
  error?: string
  status?: number
}

export async function getPositions(): Promise<PositionsResult> {
  const path = '/trade-api/v2/portfolio/positions'
  try {
    const headers = buildKalshiHeaders('GET', path)
    if (!headers['KALSHI-ACCESS-KEY']) {
      return { ok: false, error: 'Kalshi API key not configured', positions: [], orders: [] }
    }
    // sign path without query params, add query to URL
    const res = await fetch(`${KALSHI_BASE}/portfolio/positions?limit=50&count_filter=position`, { headers, cache: 'no-store' })
    const body = await res.json().catch(() => null)
    if (!res.ok) {
      return { ok: false, error: extractError(body, res.status), status: res.status, positions: [], orders: [] }
    }
    return { ok: true, positions: (body.market_positions ?? []) as KalshiPosition[], orders: [] }
  } catch (err) {
    return { ok: false, error: String(err), positions: [], orders: [] }
  }
}

export async function getFills(limit = 20): Promise<{ ok: boolean; fills: KalshiFill[]; error?: string }> {
  const path = '/trade-api/v2/portfolio/fills'
  try {
    const headers = buildKalshiHeaders('GET', path)
    if (!headers['KALSHI-ACCESS-KEY']) return { ok: false, fills: [], error: 'Missing credentials' }
    const res = await fetch(`${KALSHI_BASE}/portfolio/fills?limit=${limit}`, { headers, cache: 'no-store' })
    const body = await res.json().catch(() => null)
    if (!res.ok) return { ok: false, fills: [], error: extractError(body, res.status) }
    return { ok: true, fills: (body.fills ?? []) as KalshiFill[] }
  } catch (err) {
    return { ok: false, fills: [], error: String(err) }
  }
}

export async function getOrders(status?: string): Promise<{ ok: boolean; orders: KalshiOrder[]; error?: string }> {
  const path = '/trade-api/v2/portfolio/orders'
  try {
    const headers = buildKalshiHeaders('GET', path)
    if (!headers['KALSHI-ACCESS-KEY']) return { ok: false, orders: [], error: 'Missing credentials' }
    const query = status ? `?status=${status}&limit=20` : '?limit=20'
    const res = await fetch(`${KALSHI_BASE}/portfolio/orders${query}`, { headers, cache: 'no-store' })
    const body = await res.json().catch(() => null)
    if (!res.ok) {
      return { ok: false, orders: [], error: extractError(body, res.status) }
    }
    return { ok: true, orders: (body.orders ?? []) as KalshiOrder[] }
  } catch (err) {
    return { ok: false, orders: [], error: String(err) }
  }
}
