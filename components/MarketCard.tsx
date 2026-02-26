'use client'

import { useEffect, useState } from 'react'
import type { KalshiMarket, KalshiOrderbook } from '@/lib/types'

interface MarketCardProps {
  market: KalshiMarket | null
  orderbook: KalshiOrderbook | null
  strikePrice: number
  currentBTCPrice: number
  secondsUntilExpiry: number
  liveMode: boolean
  onRefresh?: () => void
}

const fmt  = (p: number) => p.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
const fmtD = (p: number) => p.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })

/** SVG arc ring showing remaining fraction */
function CountdownRing({ seconds, total = 900, urgent }: { seconds: number; total?: number; urgent: boolean }) {
  const r    = 22
  const circ = 2 * Math.PI * r
  const frac = Math.max(0, Math.min(1, seconds / total))
  const offset = circ * (1 - frac)

  return (
    <svg width={56} height={56} style={{ transform: 'rotate(-90deg)', flexShrink: 0 }}>
      <circle cx={28} cy={28} r={r} fill="none" stroke="var(--border)" strokeWidth={3} />
      <circle
        cx={28} cy={28} r={r} fill="none"
        stroke={urgent ? 'var(--pink)' : frac < 0.3 ? 'var(--amber)' : 'var(--green)'}
        strokeWidth={3}
        strokeDasharray={circ}
        strokeDashoffset={offset}
        strokeLinecap="round"
        style={{ transition: 'stroke-dashoffset 1s linear, stroke 0.5s ease' }}
      />
    </svg>
  )
}

/** Animated bid/ask bar */
function AnimatedBar({ value, color }: { value: number; color: string }) {
  const [width, setWidth] = useState(0)
  useEffect(() => { const id = setTimeout(() => setWidth(Math.min(100, value)), 100); return () => clearTimeout(id) }, [value])
  return (
    <div style={{ height: 5, borderRadius: 3, background: 'var(--bg-secondary)', overflow: 'hidden' }}>
      <div style={{
        height: '100%', width: `${width}%`, background: color, borderRadius: 3,
        transition: 'width 0.6s cubic-bezier(0.34,1.56,0.64,1)',
        position: 'relative',
      }}>
        <div style={{
          position: 'absolute', inset: 0,
          background: 'linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.5) 50%, transparent 100%)',
          backgroundSize: '200% 100%',
          animation: 'shimmer 2s ease infinite',
          borderRadius: 3,
        }} />
      </div>
    </div>
  )
}

type OrderState = { status: 'idle' } | { status: 'confirm'; count: number } | { status: 'placing' } | { status: 'ok'; orderId: string; fillCount: number } | { status: 'err'; message: string }

function BuyBox({
  label, bid, ask, side, ticker, color, bg, borderCol, liveMode,
}: {
  label: 'YES' | 'NO'
  bid: number; ask: number
  side: 'yes' | 'no'
  ticker: string
  color: string; bg: string; borderCol: string
  liveMode: boolean
}) {
  const [order, setOrder] = useState<OrderState>({ status: 'idle' })
  const [count, setCount] = useState(1)

  async function placeIt() {
    setOrder({ status: 'placing' })
    try {
      const body = {
        ticker, side, count,
        ...(side === 'yes' ? { yesPrice: ask } : { noPrice: ask }),
        clientOrderId: `manual-${side}-${Date.now()}`,
      }
      const res  = await fetch('/api/place-order', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const data = await res.json()
      if (!res.ok || !data.ok) {
        const rawErr = data.error
        const errMsg = typeof rawErr === 'string' ? rawErr
          : (rawErr?.message ?? rawErr?.code) ? String(rawErr.message ?? rawErr.code)
          : `HTTP ${res.status}`
        setOrder({ status: 'err', message: errMsg })
      } else {
        setOrder({ status: 'ok', orderId: data.order?.order_id ?? '', fillCount: data.order?.fill_count ?? 0 })
        setTimeout(() => setOrder({ status: 'idle' }), 4000)
      }
    } catch (err) {
      setOrder({ status: 'err', message: String(err) })
    }
  }

  const cost = ((ask / 100) * count).toFixed(2)

  return (
    <div style={{ padding: '10px 12px', borderRadius: 10, background: bg, border: `1px solid ${borderCol}` }}>
      <div style={{ fontSize: 11, fontWeight: 800, color, marginBottom: 7 }}>{label}</div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
        <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>Bid</span>
        <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>{bid}¢</span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 7 }}>
        <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>Ask</span>
        <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>{ask}¢</span>
      </div>
      <AnimatedBar value={ask} color={color} />

      {liveMode && order.status === 'idle' && (
        <button
          onClick={() => setOrder({ status: 'confirm', count: 1 })}
          style={{
            marginTop: 8, width: '100%', padding: '5px 0', borderRadius: 7,
            background: color + '22', border: `1px solid ${borderCol}`,
            fontSize: 10, fontWeight: 800, color,
            cursor: 'pointer', transition: 'background 0.15s, transform 0.15s',
          }}
          onMouseEnter={e => (e.currentTarget.style.transform = 'scale(1.02)')}
          onMouseLeave={e => (e.currentTarget.style.transform = 'scale(1)')}
        >
          BUY {label} @ {ask}¢
        </button>
      )}

      {liveMode && order.status === 'confirm' && (
        <div style={{ marginTop: 8, animation: 'scaleIn 0.2s ease' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 5 }}>
            <span style={{ fontSize: 9, color: 'var(--text-muted)', flexShrink: 0 }}>Qty</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
              <button onClick={() => setCount(c => Math.max(1, c - 1))} style={{ width: 18, height: 18, borderRadius: 4, border: '1px solid var(--border)', background: 'white', cursor: 'pointer', fontSize: 12, lineHeight: 1, color: 'var(--text-secondary)' }}>−</button>
              <input
                type="number" min={1} max={500} value={count}
                onChange={e => { const v = parseInt(e.target.value, 10); if (!isNaN(v)) setCount(Math.max(1, Math.min(500, v))) }}
                style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 13, fontWeight: 800, color: 'var(--text-primary)', width: 44, textAlign: 'center', border: '1px solid var(--border)', borderRadius: 5, padding: '1px 4px', background: 'white', outline: 'none', MozAppearance: 'textfield' }}
              />
              <button onClick={() => setCount(c => Math.min(500, c + 1))} style={{ width: 18, height: 18, borderRadius: 4, border: '1px solid var(--border)', background: 'white', cursor: 'pointer', fontSize: 12, lineHeight: 1, color: 'var(--text-secondary)' }}>+</button>
            </div>
            <span style={{ fontSize: 9, color: 'var(--text-muted)', marginLeft: 'auto' }}>${cost}</span>
          </div>
          <div style={{ display: 'flex', gap: 5 }}>
            <button onClick={() => setOrder({ status: 'idle' })} style={{ flex: 1, padding: '5px 0', borderRadius: 6, border: '1px solid var(--border)', background: 'white', fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', cursor: 'pointer' }}>Cancel</button>
            <button onClick={placeIt} style={{ flex: 2, padding: '5px 0', borderRadius: 6, border: `1px solid ${borderCol}`, background: color, fontSize: 10, fontWeight: 800, color: '#fff', cursor: 'pointer' }}>Confirm Buy</button>
          </div>
        </div>
      )}

      {liveMode && order.status === 'placing' && (
        <div style={{ marginTop: 8, textAlign: 'center', fontSize: 10, color: 'var(--text-muted)' }}>
          <span style={{ animation: 'spin-slow 1s linear infinite', display: 'inline-block', marginRight: 4 }}>◌</span>
          Placing order...
        </div>
      )}

      {liveMode && order.status === 'ok' && (
        <div style={{ marginTop: 8, padding: '6px 8px', borderRadius: 6, background: 'var(--green-pale)', border: '1px solid #a8d8b5', animation: 'scaleIn 0.2s ease' }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--green-dark)' }}>✓ Order placed</div>
          <div style={{ fontSize: 9, color: 'var(--text-muted)', fontFamily: 'var(--font-geist-mono)', marginTop: 2 }}>
            {order.fillCount > 0 ? `Filled ${order.fillCount}×` : 'Resting on book'}
          </div>
        </div>
      )}

      {liveMode && order.status === 'err' && (
        <div style={{ marginTop: 8, padding: '6px 8px', borderRadius: 6, background: 'var(--red-pale)', border: '1px solid #e0b0b0', animation: 'scaleIn 0.2s ease' }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--red)' }}>Order failed</div>
          <div style={{ fontSize: 9, color: 'var(--red)', marginTop: 2, lineHeight: 1.4 }}>{order.message}</div>
          <button onClick={() => setOrder({ status: 'idle' })} style={{ marginTop: 4, fontSize: 9, color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>Dismiss</button>
        </div>
      )}
    </div>
  )
}

export default function MarketCard({ market, orderbook, strikePrice, currentBTCPrice, secondsUntilExpiry, liveMode, onRefresh }: MarketCardProps) {
  const [countdown, setCountdown] = useState(secondsUntilExpiry)
  const [spinning, setSpinning] = useState(false)

  function handleRefresh() {
    if (spinning) return
    setSpinning(true)
    onRefresh?.()
    setTimeout(() => setSpinning(false), 800)
  }

  useEffect(() => { setCountdown(secondsUntilExpiry) }, [secondsUntilExpiry])
  useEffect(() => {
    const id = setInterval(() => setCountdown(c => Math.max(0, c - 1)), 1000)
    return () => clearInterval(id)
  }, [])

  const mins    = Math.floor(countdown / 60)
  const secs    = Math.floor(countdown % 60)
  const urgency = countdown > 0 && countdown < 120
  const above   = strikePrice > 0 && currentBTCPrice > strikePrice
  const diff    = currentBTCPrice - strikePrice
  const pct     = strikePrice > 0 ? (diff / strikePrice) * 100 : 0
  const trendCol = above ? 'var(--green)' : 'var(--pink)'

  return (
    <div className="card bracket-card" style={{ overflow: 'hidden', padding: 0 }}>
      {/* Top gradient bar — animates with above/below */}
      <div style={{
        height: 4,
        background: above
          ? 'linear-gradient(90deg, var(--green-dark) 0%, var(--green-light) 100%)'
          : 'linear-gradient(90deg, var(--pink-dark) 0%, var(--pink-light) 100%)',
        borderRadius: '18px 18px 0 0',
        transition: 'background 0.6s ease',
      }} />

      <div style={{ padding: '16px 18px' }}>
        {/* Title row */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <span className="status-dot live" />
            <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: '0.07em', textTransform: 'uppercase' }}>Active Market</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {market && (
              <span style={{
                fontFamily: 'var(--font-geist-mono)', fontSize: 9, color: 'var(--text-muted)',
                padding: '2px 7px', borderRadius: 5,
                background: 'var(--cream-dark)', border: '1px solid var(--border)',
              }}>{market.ticker}</span>
            )}
            <button
              onClick={handleRefresh}
              title="Refresh market data"
              style={{
                width: 22, height: 22, borderRadius: 6, border: '1px solid var(--border)',
                background: 'var(--cream-dark)', cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 11, color: 'var(--text-muted)',
                transition: 'border-color 0.15s, color 0.15s',
              }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--blue)'; e.currentTarget.style.color = 'var(--blue)' }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--text-muted)' }}
            >
              <span style={{ display: 'inline-block', animation: spinning ? 'spin-slow 0.8s linear infinite' : 'none' }}>↻</span>
            </button>
          </div>
        </div>

        {market ? (
          <>
            {/* Strike price */}
            <div style={{ marginBottom: 14, padding: '14px 16px', background: 'var(--bg-secondary)', borderRadius: 12, border: '1px solid var(--border)' }}>
              <div style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', fontWeight: 600, marginBottom: 5 }}>
                Price to Beat
              </div>
              <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 28, fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.03em', lineHeight: 1 }}>
                {strikePrice > 0 ? fmtD(strikePrice) : '—'}
              </div>
              <div style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 4 }}>
                Kalshi <code style={{ background: 'var(--brown-pale)', color: 'var(--brown)', padding: '1px 5px', borderRadius: 3, fontSize: 9 }}>floor_strike</code>
              </div>
            </div>

            {/* BTC vs Strike */}
            <div style={{
              padding: '12px 14px', borderRadius: 12, marginBottom: 12,
              background: above ? 'var(--green-pale)' : 'var(--pink-pale)',
              border: `1px solid ${above ? '#b8dfc3' : '#e0b8c6'}`,
              transition: 'background 0.5s ease, border-color 0.5s ease',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div>
                  <div style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 3 }}>BTC Now</div>
                  <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 22, fontWeight: 800, color: trendCol, transition: 'color 0.5s ease' }}>
                    {currentBTCPrice > 0 ? fmt(currentBTCPrice) : '—'}
                  </div>
                </div>
                <div style={{
                  width: 40, height: 40, borderRadius: '50%',
                  background: above ? 'rgba(106,170,122,0.2)' : 'rgba(212,115,142,0.2)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 22, fontWeight: 800, color: trendCol,
                  transition: 'all 0.5s ease',
                  animation: 'iconBeat 3s ease infinite',
                }}>{above ? '↑' : '↓'}</div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 3 }}>vs Strike</div>
                  <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 14, fontWeight: 800, color: trendCol }}>
                    {strikePrice > 0 ? `${diff >= 0 ? '+' : ''}${fmt(diff)}` : '—'}
                  </div>
                  <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 10, color: trendCol }}>
                    {pct >= 0 ? '+' : ''}{pct.toFixed(3)}%
                  </div>
                </div>
              </div>
            </div>

            {/* YES / NO order boxes */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12 }}>
              <BuyBox label="YES" bid={market.yes_bid} ask={market.yes_ask} side="yes" ticker={market.ticker}
                color="var(--green)" bg="var(--green-pale)" borderCol="#9ecfb8" liveMode={liveMode} />
              <BuyBox label="NO"  bid={market.no_bid}  ask={market.no_ask}  side="no"  ticker={market.ticker}
                color="var(--blue)"  bg="var(--blue-pale)"  borderCol="#a8cce0"  liveMode={liveMode} />
            </div>

            {/* Orderbook depth — refreshes every 4s */}
            {orderbook && (
              <div style={{ marginBottom: 12, padding: '10px 12px', borderRadius: 10, background: 'var(--cream)', border: '1px solid var(--border)' }}>
                <div style={{ fontSize: 8, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 8 }}>
                  Order Depth
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  {/* YES depth */}
                  <div>
                    <div style={{ fontSize: 8, color: 'var(--green-dark)', fontWeight: 700, marginBottom: 4 }}>YES</div>
                    {(orderbook.yes ?? []).slice(0, 5).map((lvl, i) => {
                      const maxDelta = Math.max(...(orderbook.yes ?? []).slice(0, 5).map(l => Math.abs(l.delta)))
                      const pct = maxDelta > 0 ? (Math.abs(lvl.delta) / maxDelta) * 100 : 0
                      return (
                        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 3 }}>
                          <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 9, color: 'var(--text-muted)', width: 22, textAlign: 'right', flexShrink: 0 }}>{lvl.price}¢</span>
                          <div style={{ flex: 1, height: 5, borderRadius: 2, background: 'var(--border)', overflow: 'hidden' }}>
                            <div style={{ height: '100%', width: `${pct}%`, background: 'var(--green)', borderRadius: 2, transition: 'width 0.4s ease' }} />
                          </div>
                          <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 8, color: 'var(--text-light)', width: 26, flexShrink: 0 }}>{Math.abs(lvl.delta)}</span>
                        </div>
                      )
                    })}
                  </div>
                  {/* NO depth */}
                  <div>
                    <div style={{ fontSize: 8, color: 'var(--blue)', fontWeight: 700, marginBottom: 4 }}>NO</div>
                    {(orderbook.no ?? []).slice(0, 5).map((lvl, i) => {
                      const maxDelta = Math.max(...(orderbook.no ?? []).slice(0, 5).map(l => Math.abs(l.delta)))
                      const pct = maxDelta > 0 ? (Math.abs(lvl.delta) / maxDelta) * 100 : 0
                      return (
                        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 3 }}>
                          <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 9, color: 'var(--text-muted)', width: 22, textAlign: 'right', flexShrink: 0 }}>{lvl.price}¢</span>
                          <div style={{ flex: 1, height: 5, borderRadius: 2, background: 'var(--border)', overflow: 'hidden' }}>
                            <div style={{ height: '100%', width: `${pct}%`, background: 'var(--blue)', borderRadius: 2, transition: 'width 0.4s ease' }} />
                          </div>
                          <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 8, color: 'var(--text-light)', width: 26, flexShrink: 0 }}>{Math.abs(lvl.delta)}</span>
                        </div>
                      )
                    })}
                  </div>
                </div>
              </div>
            )}

            {/* Countdown with SVG ring */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: 12,
              padding: '10px 14px', borderRadius: 12,
              background: urgency ? 'var(--pink-pale)' : 'var(--cream)',
              border: urgency ? '1px solid #e0b0bf' : '1px solid var(--border)',
              transition: 'all 0.5s ease',
            }}>
              <CountdownRing seconds={countdown} urgent={urgency} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 2 }}>Expires in</div>
                <div style={{
                  fontFamily: 'var(--font-geist-mono)', fontSize: 24, fontWeight: 800,
                  color: urgency ? 'var(--pink)' : 'var(--green)',
                  lineHeight: 1,
                  animation: urgency ? 'urgentPulse 1s ease infinite' : 'none',
                }}>
                  {`${mins}:${String(secs).padStart(2, '0')}`}
                </div>
                <div style={{ fontSize: 9, color: 'var(--text-light)', marginTop: 2 }}>CF Benchmarks settlement</div>
              </div>
            </div>

            {/* Vol / OI */}
            <div style={{ display: 'flex', gap: 16, marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
              {[['Volume', market.volume], ['Open Interest', market.open_interest]].map(([k, v]) => (
                <div key={String(k)}>
                  <div style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{k}</div>
                  <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>
                    {Number(v).toLocaleString()}
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <div style={{ padding: '32px 0', textAlign: 'center' }}>
            <div style={{ fontSize: 11, letterSpacing: '0.06em', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: 6 }}>// WAITING</div>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', fontWeight: 500 }}>No open KXBTC15M markets</div>
            <div style={{ fontSize: 11, color: 'var(--text-light)', marginTop: 4 }}>Next 15-min window...</div>
          </div>
        )}
      </div>
    </div>
  )
}
