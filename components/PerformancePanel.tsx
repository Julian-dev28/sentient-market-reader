'use client'

import type { PerformanceStats, TradeRecord } from '@/lib/types'
import { ResponsiveContainer, AreaChart, Area, ReferenceLine, Tooltip, CartesianGrid } from 'recharts'
import { useCountUp } from '@/hooks/useCountUp'

export default function PerformancePanel({ stats, trades }: { stats: PerformanceStats; trades: TradeRecord[] }) {
  const settled  = trades.filter(t => t.outcome !== 'PENDING')
  let cum = 0
  const curve    = settled.map((t, i) => { cum += t.pnl ?? 0; return { i, pnl: cum } })
  const pnlColor = stats.totalPnl >= 0 ? 'var(--green)' : 'var(--pink)'
  const pnlGrad  = stats.totalPnl >= 0 ? ['#3a9e72', '#8dc49a'] : ['#d4738e', '#e8a0b4']

  // Animate the headline P&L and win rate
  const animatedPnl     = useCountUp(stats.totalPnl, 900)
  const animatedWinRate = useCountUp(stats.winRate * 100, 800)
  const animatedEdge    = useCountUp(stats.avgEdge * 100, 800)

  const totalAll = stats.totalTrades + stats.pending
  const statCards = [
    {
      label: 'Win Rate',
      val: stats.totalTrades > 0 ? `${animatedWinRate.toFixed(0)}%` : totalAll > 0 ? 'pending' : '—',
      color: stats.winRate > 0.5 ? 'var(--green)' : stats.winRate < 0.45 && stats.totalTrades > 0 ? 'var(--pink)' : 'var(--amber)',
    },
    {
      label: 'Trades',
      val: totalAll > 0 ? `${stats.totalTrades}${stats.pending > 0 ? ` +${stats.pending}p` : ''}` : '0',
      color: 'var(--text-primary)',
    },
    { label: 'Avg Edge', val: totalAll > 0 ? `${animatedEdge.toFixed(1)}%` : '—', color: 'var(--brown)' },
    { label: 'W / L',    val: `${stats.wins} / ${stats.losses}`,                   color: 'var(--text-primary)' },
  ]

  return (
    <div className="card">
      <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 12 }}>Session Performance</div>

      {/* P&L hero */}
      <div style={{
        padding: '14px 16px', borderRadius: 14, marginBottom: 12,
        background: stats.totalPnl >= 0 ? 'var(--green-pale)' : 'var(--pink-pale)',
        border: `1px solid ${stats.totalPnl >= 0 ? '#b8dfc3' : '#e0b0bf'}`,
        transition: 'background 0.5s ease, border-color 0.5s ease',
      }}>
        <div style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', fontWeight: 600, marginBottom: 3 }}>
          Total P&amp;L (paper)
        </div>
        <div style={{
          fontFamily: 'var(--font-geist-mono)', fontSize: 32, fontWeight: 800,
          color: pnlColor, letterSpacing: '-0.03em',
          transition: 'color 0.5s ease',
        }}>
          {animatedPnl >= 0 ? '+' : ''}${animatedPnl.toFixed(2)}
        </div>
      </div>

      {/* Stats grid — staggered slide-up */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 12 }}>
        {statCards.map(({ label, val, color }, i) => (
          <div key={label} style={{
            padding: '9px 11px', borderRadius: 9,
            background: 'var(--bg-secondary)', border: '1px solid var(--border)',
            animation: `slideUpFade 0.35s ${i * 60}ms ease both`,
          }}>
            <div style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600, marginBottom: 3 }}>{label}</div>
            <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 16, fontWeight: 800, color, letterSpacing: '-0.02em' }}>{val}</div>
          </div>
        ))}
      </div>

      {/* Equity curve */}
      {curve.length > 1 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 600, marginBottom: 6 }}>Equity Curve</div>
          <ResponsiveContainer width="100%" height={64}>
            <AreaChart data={curve} margin={{ top: 2, right: 2, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="pnlGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor={pnlGrad[0]} stopOpacity={0.22} />
                  <stop offset="95%" stopColor={pnlGrad[1]} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
              <ReferenceLine y={0} stroke="var(--border-bright)" strokeDasharray="3 3" />
              <Tooltip
                formatter={(v: number | undefined) => [`$${(v ?? 0).toFixed(2)}`, 'P&L']}
                contentStyle={{ background: '#fff', border: '1px solid var(--border)', borderRadius: 8, fontSize: 10, boxShadow: '0 4px 16px rgba(155,118,83,0.1)' }}
              />
              <Area
                type="monotone" dataKey="pnl" stroke={pnlColor} strokeWidth={2.5}
                fill="url(#pnlGrad)" dot={false}
                activeDot={{ r: 3, fill: pnlColor, stroke: '#fff', strokeWidth: 2 }}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Risk params */}
      <div style={{ borderTop: '1px solid var(--border)', paddingTop: 10 }}>
        <div style={{ fontSize: 9, color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>Risk Params</div>
        {([
          ['Min edge',       '3%',        'var(--brown)'],
          ['Max daily loss', '$150',       'var(--pink)'],
          ['Max drawdown',   '15%',        'var(--amber)'],
          ['Sizing',         'Half-Kelly', 'var(--green)'],
        ] as const).map(([k, v, c]) => (
          <div key={k} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
            <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{k}</span>
            <span style={{ fontSize: 10, fontFamily: 'var(--font-geist-mono)', fontWeight: 600, color: c }}>{v}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
