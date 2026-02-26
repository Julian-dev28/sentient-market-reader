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

type OrderState = { status: 'idle' } | { status: 'placing' } | { status: 'ok'; orderId: string; fillCount: number } | { status: 'err'; message: string }

const QUICK_AMTS = [10, 20, 50]

/** Unified YES / NO trade box — dollar-amount based */
function TradeBox({ yesBid, yesAsk, noBid, noAsk, ticker, liveMode }: {
  yesBid: number; yesAsk: number
  noBid: number;  noAsk: number
  ticker: string
  liveMode: boolean
}) {
  const [side, setSide]     = useState<'yes' | 'no'>('yes')
  const [amtStr, setAmtStr] = useState('10')   // dollar amount as string
  const [order, setOrder]   = useState<OrderState>({ status: 'idle' })

  const isYes  = side === 'yes'
  const bid    = isYes ? yesBid  : noBid
  const ask    = isYes ? yesAsk  : noAsk
  const col    = isYes ? 'var(--green)' : 'var(--pink)'
  const colBdr = isYes ? '#9ecfb8'      : '#e0b0bf'
  const colBg  = isYes ? 'var(--green-pale)' : 'var(--pink-pale)'

  // Derive contracts from dollar amount: floor($ / price_per_contract)
  const amt       = Math.max(0.01, parseFloat(amtStr) || 0.01)
  const contracts = Math.max(1, Math.floor(amt / (ask / 100)))
  const actualCost = (contracts * ask / 100).toFixed(2)
  const profit     = (contracts * (1 - ask / 100)).toFixed(2)

  function handleAmt(raw: string) {
    if (raw === '' || /^\d*\.?\d*$/.test(raw)) setAmtStr(raw)
  }
  function handleAmtBlur() {
    const v = parseFloat(amtStr)
    setAmtStr(isNaN(v) || v <= 0 ? '1' : String(v))
  }

  async function placeIt() {
    if (!liveMode) return
    setOrder({ status: 'placing' })
    try {
      const body = {
        ticker, side, count: contracts,
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

  return (
    <div style={{ borderRadius: 12, border: '1px solid var(--border)', background: 'white', overflow: 'hidden' }}>

      {/* YES / NO pill toggles */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0 }}>
        {(['yes', 'no'] as const).map(s => {
          const active = side === s
          const a = s === 'yes' ? yesAsk : noAsk
          const activeCol = s === 'yes' ? 'var(--green)' : 'var(--pink)'
          const activeBg  = s === 'yes' ? 'var(--green-pale)' : 'var(--pink-pale)'
          const activeBdr = s === 'yes' ? '#9ecfb8' : '#e0b0bf'
          return (
            <button key={s} onClick={() => { setSide(s); setOrder({ status: 'idle' }) }}
              style={{
                padding: '11px 8px', border: 'none',
                borderBottom: active ? `2px solid ${activeCol}` : '2px solid var(--border)',
                background: active ? activeBg : 'var(--bg-secondary)',
                cursor: 'pointer', transition: 'all 0.18s',
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1,
              }}>
              <span style={{ fontSize: 10, fontWeight: 800, color: active ? activeCol : 'var(--text-muted)', letterSpacing: '0.05em' }}>
                {s === 'yes' ? 'YES' : 'NO'}
              </span>
              <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 15, fontWeight: 800, color: active ? activeCol : 'var(--text-secondary)' }}>
                {a}¢
              </span>
            </button>
          )
        })}
      </div>

      <div style={{ padding: '12px 14px' }}>
        {/* Bid / Ask row */}
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
          <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>Bid</span>
          <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)' }}>{bid}¢</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
          <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>Ask</span>
          <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 12, fontWeight: 700, color: 'var(--text-primary)' }}>{ask}¢</span>
        </div>
        <AnimatedBar value={ask / 2} color={col} />

        {/* Quick-buy buttons */}
        <div style={{ marginTop: 10, display: 'flex', gap: 5 }}>
          {QUICK_AMTS.map(q => (
            <button key={q} onClick={() => { setAmtStr(String(q)); setOrder({ status: 'idle' }) }}
              style={{
                flex: 1, padding: '5px 0', borderRadius: 7,
                border: amtStr === String(q) ? `1.5px solid ${col}` : '1px solid var(--border)',
                background: amtStr === String(q) ? colBg : 'var(--bg-secondary)',
                fontSize: 11, fontWeight: 700,
                color: amtStr === String(q) ? col : 'var(--text-muted)',
                cursor: 'pointer', transition: 'all 0.15s',
                fontFamily: 'var(--font-geist-mono)',
              }}>
              ${q}
            </button>
          ))}
        </div>

        {/* Dollar amount input */}
        <div style={{ marginTop: 7, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'nowrap' }}>
          <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-secondary)', flexShrink: 0 }}>$</span>
          <input
            type="text" inputMode="decimal" value={amtStr}
            onChange={e => handleAmt(e.target.value)}
            onBlur={handleAmtBlur}
            onFocus={e => e.target.select()}
            style={{
              flex: 1, minWidth: 0, textAlign: 'center', fontFamily: 'var(--font-geist-mono)',
              fontSize: 15, fontWeight: 800, color: 'var(--text-primary)',
              border: '1px solid var(--border)', borderRadius: 6, padding: '5px 8px',
              background: 'white', outline: 'none',
            }}
          />
        </div>

        {/* Contracts + payout breakdown */}
        <div style={{ marginTop: 6, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{contracts} contract{contracts !== 1 ? 's' : ''} · cost ${actualCost}</span>
          <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--green-dark)', fontFamily: 'var(--font-geist-mono)' }}>+${profit} if wins</span>
        </div>

        {/* Action states */}
        {order.status === 'idle' && (
          <button onClick={placeIt} disabled={!liveMode}
            style={{
              marginTop: 10, width: '100%', padding: '11px 0', borderRadius: 9,
              border: liveMode ? `1px solid ${colBdr}` : '1px solid var(--border)',
              background: liveMode ? colBg : 'var(--bg-secondary)',
              fontSize: 12, fontWeight: 800,
              color: liveMode ? col : 'var(--text-muted)',
              cursor: liveMode ? 'pointer' : 'not-allowed',
              transition: 'all 0.15s', letterSpacing: '0.03em',
            }}
            onMouseEnter={e => { if (liveMode) { e.currentTarget.style.background = col; e.currentTarget.style.color = '#fff' } }}
            onMouseLeave={e => { if (liveMode) { e.currentTarget.style.background = colBg; e.currentTarget.style.color = col } }}
          >
            {liveMode ? `BUY ${isYes ? 'YES' : 'NO'} · $${actualCost}` : `Paper only · ${isYes ? 'YES' : 'NO'} @ ${ask}¢`}
          </button>
        )}

        {order.status === 'placing' && (
          <div style={{ marginTop: 10, padding: '11px 0', textAlign: 'center', fontSize: 11, color: 'var(--text-muted)' }}>
            <span style={{ animation: 'spin-slow 1s linear infinite', display: 'inline-block', marginRight: 5 }}>◌</span>
            Placing order...
          </div>
        )}

        {order.status === 'ok' && (
          <div style={{ marginTop: 10, padding: '10px 12px', borderRadius: 9, background: 'var(--green-pale)', border: '1px solid #a8d8b5', animation: 'scaleIn 0.2s ease' }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--green-dark)' }}>✓ Order placed</div>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--font-geist-mono)', marginTop: 2 }}>
              {order.fillCount > 0 ? `Filled ${order.fillCount}×` : 'Resting on book'}
            </div>
          </div>
        )}

        {order.status === 'err' && (
          <div style={{ marginTop: 10, padding: '10px 12px', borderRadius: 9, background: 'var(--red-pale)', border: '1px solid #e0b0b0', animation: 'scaleIn 0.2s ease' }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--red)' }}>Order failed</div>
            <div style={{ fontSize: 10, color: 'var(--red)', marginTop: 2, lineHeight: 1.4 }}>{order.message}</div>
            <button onClick={() => setOrder({ status: 'idle' })} style={{ marginTop: 5, fontSize: 10, color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>Dismiss</button>
          </div>
        )}
      </div>
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

            {/* Unified YES / NO trade box */}
            <div style={{ marginBottom: 12 }}>
              <TradeBox
                yesBid={market.yes_bid} yesAsk={market.yes_ask}
                noBid={market.no_bid}   noAsk={market.no_ask}
                ticker={market.ticker}  liveMode={liveMode}
              />
            </div>

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
