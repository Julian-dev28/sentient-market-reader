'use client'

import type { PerformanceStats, TradeRecord } from '@/lib/types'
import { useState, useEffect } from 'react'

const FALLBACK_CAPITAL = 1000   // used when balance hasn't loaded yet
const ULTIMATE_GOAL    = 1000   // $1 000 absolute P&L goal

const RANKS = [
  { min: -Infinity, label: 'Bag Holder',   icon: '💀', color: '#c07070' },
  { min: 0,         label: 'Rookie',       icon: '🌱', color: 'var(--text-muted)' },
  { min: 5,         label: 'Paper Trader', icon: '📄', color: 'var(--brown)' },
  { min: 15,        label: 'Edge Hunter',  icon: '🎯', color: 'var(--amber)' },
  { min: 30,        label: 'Quant Pro',    icon: '⚡', color: 'var(--blue)' },
  { min: 60,        label: 'Quant Shark',  icon: '🦈', color: 'var(--green)' },
  { min: 90,        label: 'LEGEND',       icon: '🏆', color: '#d4a800' },
]

function getRank(pctToUltimate: number) {
  let rank = RANKS[0]
  for (const r of RANKS) { if (pctToUltimate >= r.min) rank = r }
  return rank
}

function MeterBar({ value, max, color, glow }: { value: number; max: number; color: string; glow?: boolean }) {
  const [width, setWidth] = useState(0)
  const pct = Math.max(0, Math.min(100, (value / max) * 100))
  useEffect(() => { const id = setTimeout(() => setWidth(pct), 120); return () => clearTimeout(id) }, [pct])
  return (
    <div style={{ height: 10, borderRadius: 5, background: 'var(--bg-secondary)', overflow: 'hidden', position: 'relative' }}>
      <div style={{
        height: '100%', width: `${width}%`, background: color, borderRadius: 5,
        transition: 'width 0.9s cubic-bezier(0.34,1.56,0.64,1)',
        boxShadow: glow ? `0 0 8px ${color}88` : 'none',
        position: 'relative',
      }}>
        <div style={{
          position: 'absolute', inset: 0,
          background: 'linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.35) 50%, transparent 100%)',
          backgroundSize: '200% 100%', animation: 'shimmer 2.2s ease infinite', borderRadius: 5,
        }} />
      </div>
    </div>
  )
}

export default function ChallengePanel({ stats, trades }: { stats: PerformanceStats; trades: TradeRecord[] }) {
  const [portfolioValue, setPortfolioValue] = useState<number | null>(null)

  useEffect(() => {
    fetch('/api/balance', { cache: 'no-store' })
      .then(r => r.json())
      .then(d => { if (d.portfolio_value) setPortfolioValue(d.portfolio_value / 100) })
      .catch(() => {})
  }, [])

  const startingCapital = portfolioValue ?? FALLBACK_CAPITAL
  const challengeGoal   = Math.round(startingCapital * 0.25 * 100) / 100  // 25% of account

  const settled    = trades.filter(t => t.outcome !== 'PENDING')
  const winTrades  = settled.filter(t => t.outcome === 'WIN')
  const pnl        = stats.totalPnl

  // Win streak (consecutive wins from the end)
  let streak = 0
  for (let i = settled.length - 1; i >= 0; i--) {
    if (settled[i].outcome === 'WIN') streak++; else break
  }

  // Avg payout per winning trade (or estimate $50 if no history)
  const avgWinPnl = winTrades.length > 0
    ? winTrades.reduce((s, t) => s + (t.pnl ?? 0), 0) / winTrades.length
    : 50

  const challengePct        = Math.min(100, (pnl / challengeGoal) * 100)
  const ultimatePct         = Math.min(100, (pnl / ULTIMATE_GOAL) * 100)
  const challengeRemaining  = Math.max(0, challengeGoal - pnl)
  const ultimateRemaining   = Math.max(0, ULTIMATE_GOAL - pnl)
  const challengeDone       = pnl >= challengeGoal
  const ultimateDone        = pnl >= ULTIMATE_GOAL

  const winsNeededChallenge = avgWinPnl > 0 ? Math.ceil(challengeRemaining / avgWinPnl) : null
  const winsNeededUltimate  = avgWinPnl > 0 ? Math.ceil(ultimateRemaining  / avgWinPnl) : null
  const rank = getRank(Math.max(0, ultimatePct))

  // Next rank threshold
  const rankIdx     = RANKS.indexOf(rank)
  const nextRank    = RANKS[rankIdx + 1] ?? null
  const toNextRank  = nextRank ? (nextRank.min / 100) * ULTIMATE_GOAL - pnl : null

  return (
    <div className="card">
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <span style={{ fontSize: 14 }}>🎯</span>
          <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)' }}>Daily Challenge</span>
        </div>
        {/* Rank badge */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 5,
          padding: '3px 10px', borderRadius: 20,
          background: 'var(--bg-secondary)', border: '1px solid var(--border)',
        }}>
          <span style={{ fontSize: 12 }}>{rank.icon}</span>
          <span style={{ fontSize: 10, fontWeight: 800, color: rank.color, letterSpacing: '0.02em' }}>{rank.label}</span>
        </div>
      </div>

      {/* Win streak banner */}
      {streak >= 2 && (
        <div style={{
          marginBottom: 12, padding: '7px 12px', borderRadius: 9,
          background: 'var(--green-pale)', border: '1px solid #a8d8b5',
          display: 'flex', alignItems: 'center', gap: 7,
          animation: 'scaleIn 0.2s ease',
        }}>
          <span style={{ fontSize: 14 }}>{'🔥'.repeat(Math.min(streak, 5))}</span>
          <div>
            <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--green-dark)' }}>{streak}-win streak!</div>
            <div style={{ fontSize: 9, color: 'var(--text-muted)' }}>Keep the momentum going</div>
          </div>
        </div>
      )}

      {/* ── Challenge goal ── */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 5 }}>
          <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            {challengeDone ? '✓ Challenge Complete!' : `Challenge — 25% of $${startingCapital.toFixed(0)}`}
          </span>
          <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 11, fontWeight: 700, color: challengeDone ? 'var(--green)' : 'var(--amber)' }}>
            ${pnl.toFixed(0)} / ${challengeGoal.toFixed(0)}
          </span>
        </div>
        <MeterBar value={pnl} max={challengeGoal} color={challengeDone ? 'var(--green)' : 'var(--amber)'} glow={challengeDone} />
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
          <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>
            {challengeDone ? '🎉 Goal reached!' : `$${challengeRemaining.toFixed(0)} to go`}
          </span>
          <span style={{ fontSize: 9, fontFamily: 'var(--font-geist-mono)', fontWeight: 700, color: 'var(--amber)' }}>
            {challengePct.toFixed(1)}%
          </span>
        </div>
      </div>

      {/* ── Ultimate goal ── */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 5 }}>
          <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            {ultimateDone ? '🏆 LEGEND!' : 'Ultimate Goal — $1,000'}
          </span>
          <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 11, fontWeight: 700, color: ultimateDone ? '#d4a800' : 'var(--blue)' }}>
            ${pnl.toFixed(0)} / $1,000
          </span>
        </div>
        <MeterBar value={pnl} max={ULTIMATE_GOAL} color={ultimateDone ? '#d4a800' : 'var(--blue)'} glow={ultimateDone} />
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
          <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>
            {ultimateDone ? '🏆 LEGEND status reached!' : `$${ultimateRemaining.toFixed(0)} to go`}
          </span>
          <span style={{ fontSize: 9, fontFamily: 'var(--font-geist-mono)', fontWeight: 700, color: 'var(--blue)' }}>
            {ultimatePct.toFixed(1)}%
          </span>
        </div>
      </div>

      {/* ── Next rank ── */}
      {nextRank && toNextRank !== null && toNextRank > 0 && (
        <div style={{
          marginBottom: 14, padding: '8px 11px', borderRadius: 9,
          background: 'var(--bg-secondary)', border: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>
            Next rank: <span style={{ fontWeight: 700, color: nextRank.color }}>{nextRank.icon} {nextRank.label}</span>
          </span>
          <span style={{ fontSize: 10, fontFamily: 'var(--font-geist-mono)', fontWeight: 700, color: 'var(--text-muted)' }}>
            ${toNextRank.toFixed(0)} away
          </span>
        </div>
      )}

      {/* ── Route to goal ── */}
      <div style={{ borderTop: '1px solid var(--border)', paddingTop: 10 }}>
        <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 8 }}>
          Route to Goal
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          {/* Avg win */}
          <div style={{
            padding: '8px 11px', borderRadius: 8,
            background: 'var(--bg-secondary)', border: '1px solid var(--border)',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          }}>
            <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>
              {winTrades.length > 0 ? 'Avg win payout' : 'Est. win payout'}
            </span>
            <span style={{ fontSize: 10, fontFamily: 'var(--font-geist-mono)', fontWeight: 700, color: 'var(--green)' }}>
              +${avgWinPnl.toFixed(0)} / trade
            </span>
          </div>

          {/* Wins to challenge */}
          {!challengeDone && winsNeededChallenge !== null && (
            <div style={{
              padding: '8px 11px', borderRadius: 8,
              background: 'rgba(212,135,44,0.07)', border: '1px solid rgba(212,135,44,0.3)',
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            }}>
              <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>
                Wins to clear challenge
              </span>
              <span style={{ fontSize: 13, fontFamily: 'var(--font-geist-mono)', fontWeight: 800, color: 'var(--amber)' }}>
                ×{winsNeededChallenge}
              </span>
            </div>
          )}

          {/* Wins to ultimate */}
          {!ultimateDone && winsNeededUltimate !== null && (
            <div style={{
              padding: '8px 11px', borderRadius: 8,
              background: 'rgba(74,127,165,0.07)', border: '1px solid rgba(74,127,165,0.25)',
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            }}>
              <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>
                Wins to $1k goal
              </span>
              <span style={{ fontSize: 13, fontFamily: 'var(--font-geist-mono)', fontWeight: 800, color: 'var(--blue)' }}>
                ×{winsNeededUltimate}
              </span>
            </div>
          )}

          {/* Best single trade potential */}
          {stats.bestTrade > 0 && (
            <div style={{
              padding: '8px 11px', borderRadius: 8,
              background: 'var(--bg-secondary)', border: '1px solid var(--border)',
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            }}>
              <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>Best single trade</span>
              <span style={{ fontSize: 10, fontFamily: 'var(--font-geist-mono)', fontWeight: 700, color: 'var(--green)' }}>
                +${stats.bestTrade.toFixed(0)}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
