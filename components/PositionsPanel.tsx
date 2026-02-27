'use client'

import { useEffect, useState, useCallback } from 'react'
import type { KalshiBalance, KalshiPosition, KalshiOrder, KalshiFill } from '@/lib/types'

interface PortfolioData {
  balance: KalshiBalance | null
  positions: KalshiPosition[]
  orders: KalshiOrder[]
  fills: KalshiFill[]
}

/** Parse "KXBTC15M-26FEB251615-15" → "26 Feb · 16:15 ET" */
function fmtTicker(ticker: string): string {
  const m = ticker.match(/KXBTC15M-(\d{2})([A-Z]{3})(\d{2})(\d{2})(\d{2})/)
  if (m) {
    const [, , mon, day, hh, mm] = m
    const monTitle = mon[0] + mon.slice(1).toLowerCase()
    return `${parseInt(day)} ${monTitle} · ${hh}:${mm} ET`
  }
  // fallback: trim series prefix
  return ticker.replace('KXBTC15M-', '')
}

/** Order's effective price in cents based on which side */
function orderPrice(ord: KalshiOrder): number {
  return ord.side === 'yes' ? ord.yes_price : ord.no_price
}

export default function PositionsPanel({ liveMode }: { liveMode: boolean }) {
  const [data, setData] = useState<PortfolioData>({ balance: null, positions: [], orders: [], fills: [] })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sellingAll, setSellingAll] = useState(false)
  const [sellError, setSellError] = useState<string | null>(null)
  const [limitingAll, setLimitingAll] = useState(false)
  const [limitError, setLimitError] = useState<string | null>(null)

  const fetchPortfolio = useCallback(async () => {
    if (!liveMode) return
    setLoading(true)
    setError(null)
    try {
      const [balRes, posRes] = await Promise.all([
        fetch('/api/balance', { cache: 'no-store' }),
        fetch('/api/positions', { cache: 'no-store' }),
      ])

      const balBody = await balRes.json().catch(() => null)
      if (!balRes.ok) {
        const rawErr = balBody?.error
        const base = typeof rawErr === 'string' ? rawErr
          : (rawErr?.message ?? rawErr?.code)
          ? String(rawErr.message ?? rawErr.code)
          : `Auth error (HTTP ${balRes.status})`
        // Kalshi returns "authentication_error" during maintenance even with valid credentials
        const errMsg = base === 'authentication_error'
          ? 'authentication_error — Kalshi may be in scheduled maintenance (3–5 AM ET weekdays)'
          : base
        setError(errMsg)
        setLoading(false)
        return
      }

      let positions: KalshiPosition[] = []
      let orders: KalshiOrder[] = []
      let fills: KalshiFill[] = []
      if (posRes.ok) {
        const d = await posRes.json()
        positions = d.positions ?? []
        orders = d.orders ?? []
        fills = d.fills ?? []
      }

      setData({ balance: balBody, positions, orders, fills })
    } catch (err) {
      setError(String(err))
    } finally {
      setLoading(false)
    }
  }, [liveMode])

  async function sellAll() {
    const { positions } = data
    if (positions.length === 0) return
    setSellingAll(true)
    setSellError(null)
    try {
      const results = await Promise.all(
        positions.map(pos => {
          const side = pos.position > 0 ? 'yes' : 'no'
          const count = Math.abs(pos.position)
          return fetch('/api/sell-order', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ticker: pos.ticker, side, count }),
          }).then(r => r.json())
        })
      )
      const failed = results.filter((r) => !r.ok)
      if (failed.length > 0) {
        setSellError(`${failed.length} order(s) failed: ${failed[0].error}`)
      }
      await fetchPortfolio()
    } finally {
      setSellingAll(false)
    }
  }

  async function limitAll() {
    const { positions } = data
    if (positions.length === 0) return
    setLimitingAll(true)
    setLimitError(null)
    try {
      const results = await Promise.all(
        positions.map(pos => {
          const side = pos.position > 0 ? 'yes' : 'no'
          const count = Math.abs(pos.position)
          return fetch('/api/limit-sell-order', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ticker: pos.ticker, side, count }),
          }).then(r => r.json())
        })
      )
      const failed = results.filter((r) => !r.ok)
      if (failed.length > 0) {
        setLimitError(`${failed.length} order(s) failed: ${failed[0].error}`)
      }
      await fetchPortfolio()
    } finally {
      setLimitingAll(false)
    }
  }

  useEffect(() => {
    if (!liveMode) return
    fetchPortfolio()
    const id = setInterval(fetchPortfolio, 2_000)
    return () => clearInterval(id)
  }, [liveMode, fetchPortfolio])

  if (!liveMode) return null

  const { balance, positions, orders, fills } = data

  // balance = liquid cash (excludes capital reserved for resting orders)
  // portfolio_value = current mark-to-market of open positions
  // inOrders = capital committed to resting orders (calculate from orders we have)
  const availableCash  = balance ? balance.balance / 100 : null
  const positionsValue = balance ? balance.portfolio_value / 100 : null
  // inOrders is informational only — Kalshi deducts order cost from balance immediately,
  // so balance already excludes it. Adding it again would double-count.
  const inOrdersCents  = orders.reduce((sum, ord) => {
    const price = ord.side === 'yes' ? ord.yes_price : ord.no_price
    return sum + price * ord.remaining_count
  }, 0)
  const inOrders = inOrdersCents / 100
  const totalEquity = availableCash !== null && positionsValue !== null
    ? availableCash + positionsValue
    : null

  return (
    <div className="card animate-fade-in" style={{ borderColor: '#8ab4cf', background: 'linear-gradient(135deg, rgba(74,127,165,0.06) 0%, rgba(74,127,165,0.02) 100%)' }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--green)', display: 'inline-block', boxShadow: '0 0 6px var(--green)' }} />
          <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)' }}>Kalshi Account</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {data.positions.length > 0 && (
            <>
              <button
                onClick={limitAll}
                disabled={limitingAll}
                style={{
                  padding: '4px 10px', borderRadius: 7, fontSize: 10, fontWeight: 700, cursor: limitingAll ? 'not-allowed' : 'pointer',
                  border: '1px solid #7a8fb5', background: limitingAll ? 'rgba(122,143,181,0.05)' : 'rgba(122,143,181,0.08)',
                  color: '#7a8fb5', letterSpacing: '0.02em', transition: 'all 0.15s',
                }}
                onMouseEnter={e => { if (!limitingAll) { e.currentTarget.style.background = '#7a8fb5'; e.currentTarget.style.color = '#fff' } }}
                onMouseLeave={e => { e.currentTarget.style.background = 'rgba(122,143,181,0.08)'; e.currentTarget.style.color = '#7a8fb5' }}
              >
                {limitingAll ? '…' : '⬆ Limit 99¢'}
              </button>
              <button
                onClick={sellAll}
                disabled={sellingAll}
                style={{
                  padding: '4px 10px', borderRadius: 7, fontSize: 10, fontWeight: 700, cursor: sellingAll ? 'not-allowed' : 'pointer',
                  border: '1px solid #b5687a', background: sellingAll ? 'rgba(181,104,122,0.05)' : 'rgba(181,104,122,0.08)',
                  color: '#b5687a', letterSpacing: '0.02em', transition: 'all 0.15s',
                }}
                onMouseEnter={e => { if (!sellingAll) { e.currentTarget.style.background = '#b5687a'; e.currentTarget.style.color = '#fff' } }}
                onMouseLeave={e => { e.currentTarget.style.background = 'rgba(181,104,122,0.08)'; e.currentTarget.style.color = '#b5687a' }}
              >
                {sellingAll ? '…' : '■ Sell All'}
              </button>
            </>
          )}
          <button onClick={fetchPortfolio} disabled={loading}
            style={{ background: 'none', border: 'none', cursor: loading ? 'wait' : 'pointer', fontSize: 14, color: 'var(--text-muted)', padding: '2px 4px' }}
            title="Refresh">
            {loading ? '⟳' : '↻'}
          </button>
        </div>
      </div>

      {limitError && (
        <div style={{ fontSize: 10, color: 'var(--red)', background: 'var(--red-pale)', borderRadius: 6, padding: '7px 10px', marginBottom: 12, lineHeight: 1.5 }}>
          {limitError}
        </div>
      )}
      {sellError && (
        <div style={{ fontSize: 10, color: 'var(--red)', background: 'var(--red-pale)', borderRadius: 6, padding: '7px 10px', marginBottom: 12, lineHeight: 1.5 }}>
          {sellError}
        </div>
      )}

      {error && (
        <div style={{ fontSize: 10, color: 'var(--red)', background: 'var(--red-pale)', borderRadius: 6, padding: '7px 10px', marginBottom: 12, lineHeight: 1.5 }}>
          {typeof error === 'string' ? error : JSON.stringify(error)}
        </div>
      )}

      {/* Total Equity hero */}
      {totalEquity !== null && (
        <div style={{ padding: '12px 14px', borderRadius: 12, marginBottom: 10, background: 'rgba(255,255,255,0.8)', border: '1px solid var(--border-bright)' }}>
          <div style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', fontWeight: 600, marginBottom: 3 }}>Total Equity</div>
          <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 26, fontWeight: 800, color: 'var(--brown)', letterSpacing: '-0.02em' }}>
            ${totalEquity.toFixed(2)}
          </div>
        </div>
      )}

      {/* Breakdown */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 5, marginBottom: 14 }}>
        {[
          ['Available',   availableCash  !== null ? `$${availableCash.toFixed(2)}`  : '—', 'var(--brown)'],
          ['In Orders',   inOrders > 0            ? `$${inOrders.toFixed(2)}`        : '$0.00', 'var(--amber)'],
          ['Positions',   positionsValue !== null ? `$${positionsValue.toFixed(2)}` : '—', 'var(--green-dark)'],
        ].map(([label, val, col]) => (
          <div key={label} style={{ padding: '8px 10px', borderRadius: 9, background: 'rgba(255,255,255,0.6)', border: '1px solid var(--border)' }}>
            <div style={{ fontSize: 8, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 }}>{label}</div>
            <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 13, fontWeight: 800, color: col }}>{val}</div>
          </div>
        ))}
      </div>

      {/* Open Positions */}
      {positions.length > 0 && (
        <section style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 8 }}>
            Open Positions ({positions.length})
          </div>
          {positions.slice(0, 6).map((pos, i) => {
            const isYes  = pos.position > 0
            const qty    = Math.abs(pos.position)
            const cost   = (pos.market_exposure / 100).toFixed(2)
            const rpnl   = pos.realized_pnl / 100
            const fees   = (pos.fees_paid / 100).toFixed(2)
            return (
              <div key={pos.ticker} style={{
                padding: '8px 0',
                borderBottom: i < positions.length - 1 ? '1px solid var(--border)' : 'none',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 3 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                    <span className={`pill ${isYes ? 'pill-green' : 'pill-pink'}`} style={{ fontSize: 8 }}>
                      {isYes ? '↑ YES' : '↓ NO'}
                    </span>
                    <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 11, fontWeight: 700, color: 'var(--text-primary)' }}>
                      {qty}×
                    </span>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    {rpnl !== 0 && (
                      <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 11, fontWeight: 700, color: rpnl >= 0 ? 'var(--green-dark)' : 'var(--pink)' }}>
                        {rpnl >= 0 ? '+' : ''}${rpnl.toFixed(2)} realized
                      </span>
                    )}
                  </div>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 9, color: 'var(--text-muted)', fontFamily: 'var(--font-geist-mono)' }}>
                    {fmtTicker(pos.ticker)}
                  </span>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>cost <span style={{ fontFamily: 'var(--font-geist-mono)', color: 'var(--text-secondary)' }}>${cost}</span></span>
                    {pos.fees_paid > 0 && <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>fees <span style={{ fontFamily: 'var(--font-geist-mono)' }}>${fees}</span></span>}
                  </div>
                </div>
              </div>
            )
          })}
        </section>
      )}

      {/* Resting Orders */}
      {orders.length > 0 && (
        <section style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 8 }}>
            Open Orders ({orders.length})
          </div>
          {orders.slice(0, 5).map((ord, i) => {
            const price = orderPrice(ord)
            const cost  = ((price / 100) * ord.remaining_count).toFixed(2)
            return (
              <div key={ord.order_id} style={{
                padding: '7px 0',
                borderBottom: i < orders.length - 1 ? '1px solid var(--border)' : 'none',
                display: 'grid', gridTemplateColumns: '1fr auto', gap: 6, alignItems: 'center',
              }}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 3 }}>
                    <span className={`pill ${ord.side === 'yes' ? 'pill-green' : 'pill-pink'}`} style={{ fontSize: 8 }}>
                      BUY {ord.side.toUpperCase()}
                    </span>
                    <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 10, fontWeight: 700, color: 'var(--text-primary)' }}>
                      {ord.remaining_count}×
                    </span>
                    <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 10, color: 'var(--text-muted)' }}>
                      @ {price}¢
                    </span>
                    <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>(${cost})</span>
                  </div>
                  <div style={{ fontSize: 9, color: 'var(--text-muted)', fontFamily: 'var(--font-geist-mono)' }}>
                    {fmtTicker(ord.ticker)}
                    {ord.fill_count > 0 && <span style={{ marginLeft: 6, color: 'var(--green-dark)' }}>{ord.fill_count} filled</span>}
                  </div>
                </div>
                <CancelButton orderId={ord.order_id} onCancel={fetchPortfolio} />
              </div>
            )
          })}
        </section>
      )}

      {/* Recent Fills */}
      {fills.length > 0 && (
        <section>
          <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 8 }}>
            Recent Fills ({fills.length})
          </div>
          {fills.slice(0, 6).map((fill, i) => {
            const price = fill.side === 'yes' ? fill.yes_price : fill.no_price
            const cost  = ((price / 100) * fill.count).toFixed(2)
            const time  = new Date(fill.created_time).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' })
            return (
              <div key={fill.fill_id} style={{
                padding: '6px 0',
                borderBottom: i < Math.min(fills.length, 6) - 1 ? '1px solid var(--border)' : 'none',
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <span className={`pill ${fill.side === 'yes' ? 'pill-green' : 'pill-pink'}`} style={{ fontSize: 7 }}>
                    {fill.action.toUpperCase()} {fill.side.toUpperCase()}
                  </span>
                  <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 9, color: 'var(--text-primary)' }}>
                    {fill.count}× @ {price}¢
                  </span>
                  <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>${cost}</span>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 8, color: 'var(--text-muted)' }}>{time}</div>
                  {parseFloat(fill.fee_cost) > 0 && (
                    <div style={{ fontSize: 7, color: 'var(--text-light)' }}>fee ${fill.fee_cost}</div>
                  )}
                </div>
              </div>
            )
          })}
        </section>
      )}

      {!loading && positions.length === 0 && orders.length === 0 && fills.length === 0 && balance && (
        <div style={{ textAlign: 'center', padding: '12px 0', fontSize: 11, color: 'var(--text-muted)' }}>
          No open positions or orders
        </div>
      )}

      {loading && !balance && (
        <div style={{ textAlign: 'center', padding: '12px 0', fontSize: 11, color: 'var(--text-muted)' }}>
          Connecting to Kalshi...
        </div>
      )}
    </div>
  )
}

function CancelButton({ orderId, onCancel }: { orderId: string; onCancel: () => void }) {
  const [canceling, setCanceling] = useState(false)

  async function handleCancel() {
    setCanceling(true)
    try {
      await fetch(`/api/cancel-order/${orderId}`, { method: 'DELETE' })
      onCancel()
    } finally {
      setCanceling(false)
    }
  }

  return (
    <button onClick={handleCancel} disabled={canceling} style={{
      background: 'none', border: '1px solid var(--pink)', borderRadius: 5,
      padding: '2px 8px', fontSize: 9, color: 'var(--pink)',
      cursor: canceling ? 'not-allowed' : 'pointer', fontWeight: 600, whiteSpace: 'nowrap',
    }}>
      {canceling ? '...' : 'Cancel'}
    </button>
  )
}
