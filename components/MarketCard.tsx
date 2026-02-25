'use client'

import { useEffect, useState } from 'react'
import type { KalshiMarket } from '@/lib/types'

interface MarketCardProps {
  market: KalshiMarket | null
  strikePrice: number
  currentBTCPrice: number
  secondsUntilExpiry: number
  liveMode: boolean
}

const fmt  = (p: number) => p.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
const fmtD = (p: number) => p.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })

function Bar({ value, color }: { value: number; color: string }) {
  return (
    <div style={{ height: 5, borderRadius: 3, background: 'var(--bg-secondary)', overflow: 'hidden' }}>
      <div style={{ height: '100%', width: `${Math.min(100, value)}%`, background: color, borderRadius: 3, transition: 'width 0.5s ease' }} />
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
        ticker,
        side,
        count,
        ...(side === 'yes' ? { yesPrice: ask } : { noPrice: ask }),
        clientOrderId: `manual-${side}-${Date.now()}`,
      }
      const res = await fetch('/api/place-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok || !data.ok) {
        setOrder({ status: 'err', message: data.error ?? `HTTP ${res.status}` })
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
      <Bar value={ask} color={color} />

      {/* Buy controls — only in live mode */}
      {liveMode && order.status === 'idle' && (
        <button
          onClick={() => setOrder({ status: 'confirm', count: 1 })}
          style={{
            marginTop: 8, width: '100%', padding: '5px 0', borderRadius: 7,
            background: color + '22', border: `1px solid ${borderCol}`,
            fontSize: 10, fontWeight: 800, color,
            cursor: 'pointer', transition: 'background 0.15s',
          }}
        >
          BUY {label} @ {ask}¢
        </button>
      )}

      {liveMode && order.status === 'confirm' && (
        <div style={{ marginTop: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 5 }}>
            <span style={{ fontSize: 9, color: 'var(--text-muted)', flexShrink: 0 }}>Qty</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
              <button onClick={() => setCount(c => Math.max(1, c - 1))} style={{ width: 18, height: 18, borderRadius: 4, border: '1px solid var(--border)', background: 'white', cursor: 'pointer', fontSize: 12, lineHeight: 1, color: 'var(--text-secondary)' }}>−</button>
              <input
                type="number"
                min={1}
                max={500}
                value={count}
                onChange={e => {
                  const v = parseInt(e.target.value, 10)
                  if (!isNaN(v)) setCount(Math.max(1, Math.min(500, v)))
                }}
                style={{
                  fontFamily: 'var(--font-geist-mono)', fontSize: 13, fontWeight: 800,
                  color: 'var(--text-primary)', width: 44, textAlign: 'center',
                  border: '1px solid var(--border)', borderRadius: 5,
                  padding: '1px 4px', background: 'white', outline: 'none',
                  MozAppearance: 'textfield',
                }}
              />
              <button onClick={() => setCount(c => Math.min(500, c + 1))} style={{ width: 18, height: 18, borderRadius: 4, border: '1px solid var(--border)', background: 'white', cursor: 'pointer', fontSize: 12, lineHeight: 1, color: 'var(--text-secondary)' }}>+</button>
            </div>
            <span style={{ fontSize: 9, color: 'var(--text-muted)', marginLeft: 'auto' }}>${cost}</span>
          </div>
          <div style={{ display: 'flex', gap: 5 }}>
            <button onClick={() => setOrder({ status: 'idle' })} style={{ flex: 1, padding: '5px 0', borderRadius: 6, border: '1px solid var(--border)', background: 'white', fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', cursor: 'pointer' }}>
              Cancel
            </button>
            <button onClick={placeIt} style={{ flex: 2, padding: '5px 0', borderRadius: 6, border: `1px solid ${borderCol}`, background: color, fontSize: 10, fontWeight: 800, color: '#fff', cursor: 'pointer' }}>
              Confirm Buy
            </button>
          </div>
        </div>
      )}

      {liveMode && order.status === 'placing' && (
        <div style={{ marginTop: 8, textAlign: 'center', fontSize: 10, color: 'var(--text-muted)' }}>
          Placing order...
        </div>
      )}

      {liveMode && order.status === 'ok' && (
        <div style={{ marginTop: 8, padding: '6px 8px', borderRadius: 6, background: 'var(--green-pale)', border: '1px solid #a8d8b5' }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--green-dark)' }}>✓ Order placed</div>
          <div style={{ fontSize: 9, color: 'var(--text-muted)', fontFamily: 'var(--font-geist-mono)', marginTop: 2 }}>
            {order.fillCount > 0 ? `Filled ${order.fillCount}×` : 'Resting on book'}
          </div>
        </div>
      )}

      {liveMode && order.status === 'err' && (
        <div style={{ marginTop: 8, padding: '6px 8px', borderRadius: 6, background: 'var(--red-pale)', border: '1px solid #e0b0b0' }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--red)' }}>Order failed</div>
          <div style={{ fontSize: 9, color: 'var(--red)', marginTop: 2, lineHeight: 1.4 }}>{order.message}</div>
          <button onClick={() => setOrder({ status: 'idle' })} style={{ marginTop: 4, fontSize: 9, color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>Dismiss</button>
        </div>
      )}
    </div>
  )
}

export default function MarketCard({ market, strikePrice, currentBTCPrice, secondsUntilExpiry, liveMode }: MarketCardProps) {
  const [countdown, setCountdown] = useState(secondsUntilExpiry)

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

  const upColor   = 'var(--green)'
  const downColor = 'var(--pink)'
  const trendCol  = above ? upColor : downColor

  return (
    <div className="card bracket-card" style={{ overflow: 'hidden', padding: 0 }}>
      {/* Top gradient bar */}
      <div style={{
        height: 4,
        background: above
          ? 'linear-gradient(90deg, var(--green) 0%, var(--green-light) 100%)'
          : 'linear-gradient(90deg, var(--pink-dark) 0%, var(--pink-light) 100%)',
        borderRadius: '18px 18px 0 0',
      }} />

      <div style={{ padding: '16px 18px' }}>
        {/* Title row */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <span className="status-dot live" />
            <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: '0.07em', textTransform: 'uppercase' }}>Active Market</span>
          </div>
          {market && (
            <span style={{
              fontFamily: 'var(--font-geist-mono)', fontSize: 9, color: 'var(--text-muted)',
              padding: '2px 7px', borderRadius: 5,
              background: 'var(--cream-dark)', border: '1px solid var(--border)',
            }}>{market.ticker}</span>
          )}
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
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div>
                  <div style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 3 }}>BTC Now</div>
                  <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 20, fontWeight: 800, color: trendCol }}>
                    {currentBTCPrice > 0 ? fmt(currentBTCPrice) : '—'}
                  </div>
                </div>
                <div style={{ textAlign: 'center' }}>
                  <div style={{
                    width: 38, height: 38, borderRadius: '50%',
                    background: above ? 'rgba(106,170,122,0.2)' : 'rgba(212,115,142,0.2)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 20, fontWeight: 800, color: trendCol,
                  }}>{above ? '↑' : '↓'}</div>
                </div>
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

            {/* YES / NO with buy buttons */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12 }}>
              <BuyBox label="YES" bid={market.yes_bid} ask={market.yes_ask} side="yes" ticker={market.ticker}
                color="var(--green)" bg="var(--green-pale)" borderCol="#aed5b8" liveMode={liveMode} />
              <BuyBox label="NO"  bid={market.no_bid}  ask={market.no_ask}  side="no"  ticker={market.ticker}
                color="var(--pink)"  bg="var(--pink-pale)"  borderCol="#e0b0bf"  liveMode={liveMode} />
            </div>

            {/* Countdown */}
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '10px 14px', borderRadius: 10,
              background: urgency ? 'var(--pink-pale)' : 'var(--cream)',
              border: urgency ? '1px solid #e0b0bf' : '1px solid var(--border)',
            }}>
              <div>
                <div style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Expires in</div>
                <div style={{ fontSize: 9, color: 'var(--text-light)', marginTop: 1 }}>CF Benchmarks settlement</div>
              </div>
              <div style={{
                fontFamily: 'var(--font-geist-mono)', fontSize: 22, fontWeight: 800,
                color: urgency ? 'var(--pink)' : 'var(--green)',
              }}>
                {`${mins}:${String(secs).padStart(2, '0')}`}
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
            <div style={{ fontSize: 26, marginBottom: 8 }}>⏳</div>
            <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>No open KXBTC15M markets</div>
            <div style={{ fontSize: 11, color: 'var(--text-light)', marginTop: 4 }}>Waiting for next 15-min window...</div>
          </div>
        )}
      </div>
    </div>
  )
}
