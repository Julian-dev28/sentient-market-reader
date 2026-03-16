'use client'

import type { AgentStats } from '@/lib/types'

interface AgentStatsPanelProps {
  stats: AgentStats
  allowance: number
  initialAllowance: number
  kalshiBalance?: number  // live Kalshi account balance in dollars
}

export default function AgentStatsPanel({ stats, allowance, initialAllowance, kalshiBalance }: AgentStatsPanelProps) {
  // Account balance: use live Kalshi balance + session P&L if available, else fallback to initialAllowance
  const baseBalance = kalshiBalance && kalshiBalance > 0 ? kalshiBalance : initialAllowance
  const accountBalance = baseBalance + stats.totalPnl
  const totalReturn = baseBalance > 0
    ? (stats.totalPnl / baseBalance) * 100
    : 0

  const rows: [string, string, string?][] = [
    ['Bet per trade', `$${allowance.toFixed(2)}`, undefined],
    ['Windows', String(stats.windowsTraded), undefined],
    ['Bets placed', String(stats.totalSlices), undefined],
    ['Win rate', stats.wins + stats.losses > 0 ? `${(stats.winRate * 100).toFixed(0)}%` : '—', undefined],
    ['W / L', `${stats.wins} / ${stats.losses}`, undefined],
    ['Realized P&L', `${stats.totalPnl >= 0 ? '+' : ''}$${stats.totalPnl.toFixed(2)}`,
      stats.totalPnl >= 0 ? 'var(--green)' : 'var(--red)'],
    ['Best window', stats.windowsTraded > 0 ? `${stats.bestWindow >= 0 ? '+' : ''}$${stats.bestWindow.toFixed(2)}` : '—',
      stats.bestWindow > 0 ? 'var(--green)' : undefined],
    ['Worst window', stats.windowsTraded > 0 ? `${stats.worstWindow >= 0 ? '+' : ''}$${stats.worstWindow.toFixed(2)}` : '—',
      stats.worstWindow < 0 ? 'var(--red)' : undefined],
  ]

  return (
    <div className="card" style={{ padding: '14px 16px' }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 12 }}>
        Session Stats
      </div>

      {/* Account balance */}
      <div style={{ padding: '10px 12px', borderRadius: 10, background: 'var(--bg-secondary)', border: '1px solid var(--border-bright)', marginBottom: 12 }}>
        <div style={{ fontSize: 8, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 2 }}>
          Account balance
        </div>
        <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 20, fontWeight: 800, color: accountBalance >= baseBalance ? 'var(--green)' : 'var(--red)' }}>
          ${accountBalance.toFixed(2)}
        </div>
        {baseBalance > 0 && (
          <div style={{ fontSize: 9, fontFamily: 'var(--font-geist-mono)', color: totalReturn >= 0 ? 'var(--green)' : 'var(--red)', marginTop: 1 }}>
            {totalReturn >= 0 ? '+' : ''}{totalReturn.toFixed(1)}% vs start
          </div>
        )}
      </div>

      {/* Stats rows */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        {rows.map(([label, val, col]) => (
          <div key={label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 0', borderBottom: '1px solid var(--border)' }}>
            <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{label}</span>
            <span style={{ fontSize: 11, fontFamily: 'var(--font-geist-mono)', fontWeight: 700, color: col ?? 'var(--text-primary)' }}>
              {val}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
