'use client'

import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, ReferenceLine, Tooltip, CartesianGrid } from 'recharts'
import type { PricePoint } from '@/lib/types'

interface TooltipPayload { value: number; payload: { timestamp: number } }

function CustomTooltip({ active, payload }: { active?: boolean; payload?: TooltipPayload[] }) {
  if (!active || !payload?.length) return null
  const { value, payload: inner } = payload[0]
  const time = new Date(inner.timestamp).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
  return (
    <div style={{
      background: 'rgba(255,255,255,0.96)', border: '1px solid var(--border)', borderRadius: 10,
      padding: '8px 12px', fontSize: 11, fontFamily: 'var(--font-geist-mono)',
      boxShadow: '0 4px 20px rgba(155,118,83,0.12)',
      backdropFilter: 'blur(8px)',
    }}>
      <div style={{ color: 'var(--text-muted)', marginBottom: 2 }}>{time}</div>
      <div style={{ color: 'var(--brown)', fontWeight: 700, fontSize: 14 }}>${value.toLocaleString('en-US', { maximumFractionDigits: 0 })}</div>
    </div>
  )
}

export default function PriceChart({ priceHistory, strikePrice, currentPrice }: { priceHistory: PricePoint[]; strikePrice: number; currentPrice: number }) {
  const data = priceHistory.map(p => ({
    timestamp: p.timestamp,
    price: p.price,
    time: new Date(p.timestamp).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' }),
  }))

  const prices = data.map(d => d.price)
  const min = prices.length ? Math.min(...prices) : currentPrice * 0.999
  const max = prices.length ? Math.max(...prices) : currentPrice * 1.001
  const pad = (max - min) * 0.4 || 300
  const domain: [number, number] = [min - pad, max + pad]
  const above = strikePrice > 0 && currentPrice > strikePrice

  const lineColor = above ? 'var(--green)' : 'var(--pink)'
  const gradStop1 = above ? '#3a9e72' : '#d4738e'
  const gradStop2 = above ? '#8dc49a' : '#e8a0b4'

  return (
    <div className="card" style={{ padding: '18px 14px 10px 14px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14, padding: '0 4px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 2 }}>BTC / USD</div>
            <div style={{
              fontFamily: 'var(--font-geist-mono)', fontSize: 28, fontWeight: 800,
              color: lineColor, letterSpacing: '-0.02em',
              transition: 'color 0.5s ease',
            }}>
              {currentPrice > 0 ? `$${currentPrice.toLocaleString('en-US', { maximumFractionDigits: 0 })}` : '—'}
            </div>
          </div>

          {/* Above/below pill */}
          <div style={{
            padding: '6px 12px', borderRadius: 9,
            background: above ? 'var(--green-pale)' : 'var(--pink-pale)',
            border: `1px solid ${above ? '#b8dfc3' : '#e0b0bf'}`,
            transition: 'all 0.5s ease',
          }}>
            <div style={{
              fontSize: 11, fontWeight: 800,
              color: above ? 'var(--green-dark)' : 'var(--pink-dark)',
              display: 'flex', alignItems: 'center', gap: 4,
            }}>
              <span style={{ animation: 'iconBeat 3s ease infinite', display: 'inline-block' }}>
                {above ? '↑' : '↓'}
              </span>
              {above ? 'ABOVE STRIKE' : 'BELOW STRIKE'}
            </div>
          </div>
        </div>

        {strikePrice > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--text-muted)' }}>
            <div style={{ width: 18, height: 2, background: 'var(--amber)', borderRadius: 1 }} />
            <span>Strike ${strikePrice.toLocaleString('en-US', { maximumFractionDigits: 0 })}</span>
          </div>
        )}
      </div>

      {data.length < 2 ? (
        <div style={{ height: 220, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
          <div style={{ fontSize: 10, letterSpacing: '0.07em', color: 'var(--text-muted)', textTransform: 'uppercase' }}>// COLLECTING</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Price history loading...</div>
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          <AreaChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id="priceGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor={gradStop1} stopOpacity={0.2} />
                <stop offset="95%" stopColor={gradStop2} stopOpacity={0.01} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
            <XAxis
              dataKey="time"
              tick={{ fill: 'var(--text-muted)', fontSize: 9, fontFamily: 'var(--font-geist-mono)' }}
              axisLine={false} tickLine={false} interval="preserveStartEnd"
            />
            <YAxis
              tickFormatter={v => `$${(v / 1000).toFixed(1)}k`}
              tick={{ fill: 'var(--text-muted)', fontSize: 9, fontFamily: 'var(--font-geist-mono)' }}
              axisLine={false} tickLine={false} width={48} domain={domain}
            />
            {strikePrice > 0 && (
              <ReferenceLine y={strikePrice} stroke="var(--amber)" strokeDasharray="5 3" strokeWidth={1.5}
                label={{ value: 'STRIKE', fill: 'var(--amber)', fontSize: 9, fontFamily: 'var(--font-geist-mono)', position: 'insideTopRight' }}
              />
            )}
            <Tooltip content={<CustomTooltip />} />
            <Area
              type="monotone" dataKey="price"
              stroke={lineColor} strokeWidth={2.5}
              fill="url(#priceGrad)"
              dot={false}
              activeDot={{ r: 4, fill: lineColor, stroke: '#fff', strokeWidth: 2 }}
              style={{ transition: 'stroke 0.5s ease' }}
            />
          </AreaChart>
        </ResponsiveContainer>
      )}
    </div>
  )
}
