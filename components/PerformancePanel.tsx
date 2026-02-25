'use client'

import type { PerformanceStats, TradeRecord } from '@/lib/types'
import { ResponsiveContainer, LineChart, Line, Tooltip, ReferenceLine } from 'recharts'

export default function PerformancePanel({ stats, trades }: { stats: PerformanceStats; trades: TradeRecord[] }) {
  const settled = trades.filter(t => t.outcome !== 'PENDING')
  let cum = 0
  const curve = settled.map((t, i) => { cum += t.pnl ?? 0; return { i, pnl: cum } })
  const pnlColor = stats.totalPnl >= 0 ? 'var(--green)' : 'var(--pink)'

  return (
    <div className="card">
      <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 12 }}>Session Performance</div>

      {/* P&L hero */}
      <div style={{
        padding: '14px 16px', borderRadius: 12, marginBottom: 12,
        background: stats.totalPnl >= 0 ? 'var(--green-pale)' : 'var(--pink-pale)',
        border: `1px solid ${stats.totalPnl >= 0 ? '#b8dfc3' : '#e0b0bf'}`,
      }}>
        <div style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', fontWeight: 600, marginBottom: 3 }}>Total P&amp;L (paper)</div>
        <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 30, fontWeight: 800, color: pnlColor, letterSpacing: '-0.03em' }}>
          {stats.totalPnl >= 0 ? '+' : ''}${stats.totalPnl.toFixed(2)}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 12 }}>
        {[
          ['Win Rate',  stats.totalTrades > 0 ? `${(stats.winRate * 100).toFixed(0)}%` : '—',  stats.winRate > 0.5 ? 'var(--green)' : stats.winRate < 0.45 && stats.totalTrades > 0 ? 'var(--pink)' : 'var(--amber)'],
          ['Trades',    String(stats.totalTrades), 'var(--text-primary)'],
          ['Avg Edge',  stats.totalTrades > 0 ? `${(stats.avgEdge * 100).toFixed(1)}%` : '—', 'var(--brown)'],
          ['W / L',     `${stats.wins} / ${stats.losses}`, 'var(--text-primary)'],
        ].map(([label, val, col]) => (
          <div key={label} style={{ padding: '9px 11px', borderRadius: 9, background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
            <div style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600, marginBottom: 3 }}>{label}</div>
            <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 16, fontWeight: 800, color: col, letterSpacing: '-0.02em' }}>{val}</div>
          </div>
        ))}
      </div>

      {curve.length > 1 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 600, marginBottom: 6 }}>Equity Curve</div>
          <ResponsiveContainer width="100%" height={60}>
            <LineChart data={curve} margin={{ top: 2, right: 2, bottom: 0, left: 0 }}>
              <ReferenceLine y={0} stroke="var(--border-bright)" strokeDasharray="3 3" />
              <Tooltip formatter={(v: number | undefined) => [`$${(v ?? 0).toFixed(2)}`, 'P&L']}
                contentStyle={{ background: '#fff', border: '1px solid var(--border)', borderRadius: 6, fontSize: 10 }} />
              <Line type="monotone" dataKey="pnl" stroke={pnlColor} strokeWidth={2.5} dot={false}
                activeDot={{ r: 3, fill: pnlColor, stroke: '#fff', strokeWidth: 2 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      <div style={{ borderTop: '1px solid var(--border)', paddingTop: 10 }}>
        <div style={{ fontSize: 9, color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>Risk Params</div>
        {([
          ['Min edge',       '3%',         'var(--brown)'],
          ['Max daily loss', '$150',        'var(--pink)'],
          ['Max drawdown',   '15%',         'var(--amber)'],
          ['Sizing',         'Half-Kelly',  'var(--green)'],
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
