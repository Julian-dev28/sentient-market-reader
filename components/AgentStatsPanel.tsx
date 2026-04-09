'use client'

import type { AgentStats } from '@/lib/types'

interface AgentStatsPanelProps {
  stats: AgentStats
  allowance: number
  initialAllowance: number
  kalshiBalance?: number
}

export default function AgentStatsPanel({ stats, allowance, initialAllowance, kalshiBalance }: AgentStatsPanelProps) {
  const baseBalance    = kalshiBalance && kalshiBalance > 0 ? kalshiBalance : initialAllowance
  const accountBalance = baseBalance + stats.totalPnl
  const totalReturn    = baseBalance > 0 ? (stats.totalPnl / baseBalance) * 100 : 0
  const hasTrades      = stats.wins + stats.losses > 0
  const winRate        = hasTrades ? stats.winRate * 100 : null
  const roi            = stats.totalDeployed > 0 ? (stats.totalPnl / stats.totalDeployed) * 100 : null
  const pnlColor       = stats.totalPnl > 0 ? 'var(--green)' : stats.totalPnl < 0 ? 'var(--red)' : 'var(--text-muted)'
  const pnlSign        = stats.totalPnl >= 0 ? '+' : ''

  return (
    <div className="card" style={{ padding: '14px 16px' }}>

      {/* ── All-time P&L — most important number ── */}
      <div style={{
        padding: '12px 14px', borderRadius: 10, marginBottom: 12,
        background: 'var(--bg-secondary)',
        border: `1.5px solid ${stats.totalPnl > 0 ? '#164030' : stats.totalPnl < 0 ? '#4a1010' : 'var(--border-bright)'}`,
      }}>
        <div style={{ fontSize: 8, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', fontWeight: 600, marginBottom: 3 }}>
          All-time P&amp;L
        </div>
        <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 26, fontWeight: 800, color: pnlColor, letterSpacing: '-0.03em', lineHeight: 1 }}>
          {pnlSign}${Math.abs(stats.totalPnl).toFixed(2)}
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
          {baseBalance > 0 && (
            <span style={{ fontSize: 9, fontFamily: 'var(--font-geist-mono)', color: pnlColor, fontWeight: 700 }}>
              {totalReturn >= 0 ? '+' : ''}{totalReturn.toFixed(1)}% ROI
            </span>
          )}
          {roi !== null && (
            <span style={{ fontSize: 9, fontFamily: 'var(--font-geist-mono)', color: 'var(--text-muted)' }}>
              {roi >= 0 ? '+' : ''}{roi.toFixed(1)}% on deployed
            </span>
          )}
        </div>
      </div>

      {/* ── Win rate bar ── */}
      {hasTrades && winRate !== null && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
            <span style={{ fontSize: 9, color: 'var(--text-muted)', fontWeight: 600 }}>
              Win rate · {stats.wins}W / {stats.losses}L
            </span>
            <span style={{ fontSize: 10, fontFamily: 'var(--font-geist-mono)', fontWeight: 800, color: winRate >= 80 ? 'var(--green)' : winRate >= 60 ? 'var(--amber)' : 'var(--red)' }}>
              {winRate.toFixed(0)}%
            </span>
          </div>
          <div style={{ height: 5, borderRadius: 3, background: 'var(--border)', overflow: 'hidden' }}>
            <div style={{
              height: '100%', borderRadius: 3,
              width: `${winRate}%`,
              background: winRate >= 80 ? 'var(--green)' : winRate >= 60 ? 'var(--amber)' : 'var(--red)',
              transition: 'width 0.5s ease',
            }} />
          </div>
        </div>
      )}

      {/* ── Stats rows ── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        {([
          ['Windows',      stats.windowsTraded > 0 ? String(stats.windowsTraded) : '—', undefined],
          ['Bets placed',  stats.totalSlices   > 0 ? String(stats.totalSlices)   : '—', undefined],
          ['Deployed',     stats.totalDeployed > 0 ? `$${stats.totalDeployed.toFixed(2)}` : '—', undefined],
          ['Best window',  hasTrades ? `${stats.bestWindow  >= 0 ? '+' : ''}$${stats.bestWindow.toFixed(2)}`  : '—',
            stats.bestWindow  > 0 ? 'var(--green)' : undefined],
          ['Worst window', hasTrades ? `${stats.worstWindow >= 0 ? '+' : ''}$${stats.worstWindow.toFixed(2)}` : '—',
            stats.worstWindow < 0 ? 'var(--red)'   : undefined],
          ['Per-trade bet', `$${allowance.toFixed(2)}`, undefined],
        ] as [string, string, string | undefined][]).map(([label, val, col]) => (
          <div key={label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 0', borderBottom: '1px solid var(--border)' }}>
            <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{label}</span>
            <span style={{ fontSize: 11, fontFamily: 'var(--font-geist-mono)', fontWeight: 700, color: col ?? 'var(--text-primary)' }}>
              {val}
            </span>
          </div>
        ))}
      </div>

      {/* ── Kalshi live balance ── */}
      {baseBalance > 0 && (
        <div style={{ marginTop: 10, padding: '8px 12px', borderRadius: 8, background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>Kalshi balance</span>
            <span style={{ fontSize: 12, fontFamily: 'var(--font-geist-mono)', fontWeight: 800, color: 'var(--text-primary)' }}>
              ${accountBalance.toFixed(2)}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
