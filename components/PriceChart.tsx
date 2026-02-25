'use client'

import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, ReferenceLine, Tooltip, CartesianGrid } from 'recharts'
import type { PricePoint } from '@/lib/types'

interface TooltipPayload { value: number; payload: { timestamp: number } }

function CustomTooltip({ active, payload }: { active?: boolean; payload?: TooltipPayload[] }) {
  if (!active || !payload?.length) return null
  const { value, payload: inner } = payload[0]
  const time = new Date(inner.timestamp).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
  return (
    <div style={{ background: '#fff', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 12px', fontSize: 11, fontFamily: 'var(--font-geist-mono)', boxShadow: '0 4px 16px rgba(155,118,83,0.1)' }}>
      <div style={{ color: 'var(--text-muted)', marginBottom: 2 }}>{time}</div>
      <div style={{ color: 'var(--brown)', fontWeight: 700, fontSize: 13 }}>${value.toLocaleString('en-US', { maximumFractionDigits: 0 })}</div>
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

  return (
    <div className="card" style={{ padding: '18px 14px 10px 14px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14, padding: '0 4px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 2 }}>BTC / USD</div>
            <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 22, fontWeight: 800, color: above ? 'var(--green)' : 'var(--pink)', letterSpacing: '-0.02em' }}>
              {currentPrice > 0 ? `$${currentPrice.toLocaleString('en-US', { maximumFractionDigits: 0 })}` : '—'}
            </div>
          </div>
          <div style={{
            padding: '5px 10px', borderRadius: 8,
            background: above ? 'var(--green-pale)' : 'var(--pink-pale)',
            border: `1px solid ${above ? '#b8dfc3' : '#e0b0bf'}`,
            fontSize: 11, fontWeight: 700,
            color: above ? 'var(--green-dark)' : 'var(--pink-dark)',
          }}>
            {above ? '↑ ABOVE STRIKE' : '↓ BELOW STRIKE'}
          </div>
        </div>
        {strikePrice > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--text-muted)' }}>
            <div style={{ width: 16, height: 2, background: 'var(--amber)', borderRadius: 1 }} />
            <span>Strike ${strikePrice.toLocaleString('en-US', { maximumFractionDigits: 0 })}</span>
          </div>
        )}
      </div>

      {data.length < 2 ? (
        <div style={{ height: 220, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
          <div style={{ fontSize: 22 }}>📊</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Collecting price history...</div>
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          <AreaChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id="warmGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor="var(--brown-light)" stopOpacity={0.18} />
                <stop offset="95%" stopColor="var(--brown-light)" stopOpacity={0.01} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
            <XAxis dataKey="time" tick={{ fill: 'var(--text-muted)', fontSize: 9, fontFamily: 'var(--font-geist-mono)' }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
            <YAxis tickFormatter={v => `$${(v/1000).toFixed(1)}k`} tick={{ fill: 'var(--text-muted)', fontSize: 9, fontFamily: 'var(--font-geist-mono)' }} axisLine={false} tickLine={false} width={48} domain={domain} />
            {strikePrice > 0 && (
              <ReferenceLine y={strikePrice} stroke="var(--amber)" strokeDasharray="5 3" strokeWidth={1.5}
                label={{ value: 'STRIKE', fill: 'var(--amber)', fontSize: 9, fontFamily: 'var(--font-geist-mono)', position: 'insideTopRight' }} />
            )}
            <Tooltip content={<CustomTooltip />} />
            <Area type="monotone" dataKey="price" stroke="var(--brown)" strokeWidth={2.5} fill="url(#warmGrad)"
              dot={false} activeDot={{ r: 4, fill: 'var(--brown)', stroke: '#fff', strokeWidth: 2 }} />
          </AreaChart>
        </ResponsiveContainer>
      )}
    </div>
  )
}
