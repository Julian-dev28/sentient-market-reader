'use client'

import type { PerformanceStats, TradeRecord } from '@/lib/types'
import { useState, useEffect } from 'react'

// $160k/year broken down
const ANNUAL_GOAL  = 160_000
const DAILY_GOAL   = ANNUAL_GOAL / 365          // $438.36
const WARMUP_GOAL  = DAILY_GOAL  * 0.10         // 10% of daily = $43.84 starter
const WEEKLY_GOAL  = ANNUAL_GOAL / 52           // $3,076.92
const MONTHLY_GOAL = ANNUAL_GOAL / 12           // $13,333.33

// min = % of ANNUAL_GOAL; icon = plain text symbol
const RANKS = [
  { min: -Infinity, label: 'Unpaid Intern',  icon: '○', color: '#a07070',          dollars: 0       },
  { min: 0.25,      label: 'Junior Analyst', icon: '◇', color: 'var(--text-muted)', dollars: 400     },
  { min: 1,         label: 'Analyst',        icon: '△', color: 'var(--brown)',       dollars: 1_600   },
  { min: 5,         label: 'Sr. Analyst',    icon: '▷', color: 'var(--amber)',       dollars: 8_000   },
  { min: 10,        label: 'Manager',        icon: '◈', color: 'var(--blue)',        dollars: 16_000  },
  { min: 25,        label: 'Director',       icon: '★', color: '#7b5ea7',           dollars: 40_000  },
  { min: 50,        label: 'VP',             icon: '◆', color: 'var(--green)',       dollars: 80_000  },
  { min: 100,       label: 'CEO',            icon: '✦', color: '#d4a800',           dollars: 160_000 },
]

function getRank(pctOfAnnual: number) {
  let rank = RANKS[0]
  for (const r of RANKS) { if (pctOfAnnual >= r.min) rank = r }
  return rank
}

function MeterBar({ value, max, color, glow }: { value: number; max: number; color: string; glow?: boolean }) {
  const [width, setWidth] = useState(0)
  const pct = Math.max(0, Math.min(100, (value / max) * 100))
  useEffect(() => { const id = setTimeout(() => setWidth(pct), 120); return () => clearTimeout(id) }, [pct])
  return (
    <div style={{ height: 10, borderRadius: 5, background: 'var(--bg-secondary)', overflow: 'hidden' }}>
      <div style={{
        height: '100%', width: `${width}%`, background: color, borderRadius: 5,
        transition: 'width 0.9s cubic-bezier(0.34,1.56,0.64,1)',
        boxShadow: glow ? `0 0 10px ${color}99` : 'none',
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

function StatRow({ label, value, color, highlight }: { label: string; value: string; color?: string; highlight?: boolean }) {
  return (
    <div style={{
      padding: '7px 11px', borderRadius: 8,
      background: highlight ? 'rgba(212,135,44,0.07)' : 'var(--bg-secondary)',
      border: highlight ? '1px solid rgba(212,135,44,0.3)' : '1px solid var(--border)',
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    }}>
      <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>{label}</span>
      <span style={{ fontSize: 11, fontFamily: 'var(--font-geist-mono)', fontWeight: 800, color: color ?? 'var(--text-primary)' }}>
        {value}
      </span>
    </div>
  )
}

export default function ChallengePanel({ stats, trades }: { stats: PerformanceStats; trades: TradeRecord[] }) {
  const settled   = trades.filter(t => t.outcome !== 'PENDING')
  const winTrades = settled.filter(t => t.outcome === 'WIN')
  const pnl       = stats.totalPnl

  // Win streak
  let streak = 0
  for (let i = settled.length - 1; i >= 0; i--) {
    if (settled[i].outcome === 'WIN') streak++; else break
  }

  const avgWinPnl = winTrades.length > 0
    ? winTrades.reduce((s, t) => s + (t.pnl ?? 0), 0) / winTrades.length
    : 50

  const dailyPct   = Math.min(100, (pnl / DAILY_GOAL)  * 100)
  const annualPct  = Math.min(100, (pnl / ANNUAL_GOAL) * 100)
  const dailyDone  = pnl >= DAILY_GOAL
  const annualDone = pnl >= ANNUAL_GOAL

  const dailyRemaining  = Math.max(0, DAILY_GOAL  - pnl)
  const weeklyRemaining = Math.max(0, WEEKLY_GOAL - pnl)
  const annualRemaining = Math.max(0, ANNUAL_GOAL - pnl)

  const winsToDay  = avgWinPnl > 0 ? Math.ceil(dailyRemaining  / avgWinPnl) : null
  const winsToWeek = avgWinPnl > 0 ? Math.ceil(weeklyRemaining / avgWinPnl) : null
  const daysAtPace = (pnl > 0 && avgWinPnl > 0 && settled.length > 0)
    ? Math.ceil(annualRemaining / (pnl / Math.max(1, settled.length) * 3))
    : null

  const rank     = getRank(Math.max(0, annualPct))
  const rankIdx  = RANKS.indexOf(rank)
  const nextRank = RANKS[rankIdx + 1] ?? null
  const toNextRank = nextRank ? nextRank.dollars - pnl : null

  return (
    <div className="card">
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 14, fontWeight: 800, color: 'var(--amber)' }}>$</span>
            <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)' }}>$160k Challenge</span>
          </div>
          <div style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 2, marginLeft: 21 }}>
            ${DAILY_GOAL.toFixed(2)}/day · ${WEEKLY_GOAL.toFixed(0)}/wk · ${MONTHLY_GOAL.toFixed(0)}/mo
          </div>
        </div>
        {/* Rank badge */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 5,
          padding: '3px 10px', borderRadius: 20,
          background: 'var(--bg-secondary)', border: '1px solid var(--border)',
        }}>
          <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 12, fontWeight: 800, color: rank.color }}>{rank.icon}</span>
          <span style={{ fontSize: 10, fontWeight: 800, color: rank.color }}>{rank.label}</span>
        </div>
      </div>

      {/* Win streak banner */}
      {streak >= 2 && (
        <div style={{
          marginBottom: 12, padding: '7px 12px', borderRadius: 9,
          background: 'var(--green-pale)', border: '1px solid #a8d8b5',
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 16, fontWeight: 800, color: 'var(--green)' }}>
            {'+'.repeat(Math.min(streak, 5))}
          </span>
          <div>
            <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--green-dark)' }}>{streak}-win streak</div>
            <div style={{ fontSize: 9, color: 'var(--text-muted)' }}>Keep the momentum going</div>
          </div>
        </div>
      )}

      {/* ── Warm-up: 10% of daily ── */}
      {!dailyDone && (() => {
        const warmupDone = pnl >= WARMUP_GOAL
        const warmupPct  = Math.min(100, (pnl / WARMUP_GOAL) * 100)
        return (
          <div style={{ marginBottom: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 5 }}>
              <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                {warmupDone ? '+ Warm-Up Done' : 'Warm-Up — 10% of daily'}
              </span>
              <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 11, fontWeight: 700, color: warmupDone ? 'var(--green)' : 'var(--text-muted)' }}>
                ${pnl.toFixed(2)} / ${WARMUP_GOAL.toFixed(2)}
              </span>
            </div>
            <MeterBar value={pnl} max={WARMUP_GOAL} color={warmupDone ? 'var(--green)' : '#9ecfb8'} glow={warmupDone} />
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
              <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>
                {warmupDone ? '+ First $' + WARMUP_GOAL.toFixed(2) + ' earned' : `$${Math.max(0, WARMUP_GOAL - pnl).toFixed(2)} to start`}
              </span>
              <span style={{ fontSize: 9, fontFamily: 'var(--font-geist-mono)', fontWeight: 700, color: 'var(--text-muted)' }}>
                {warmupPct.toFixed(1)}%
              </span>
            </div>
          </div>
        )
      })()}

      {/* ── Daily goal ── */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 5 }}>
          <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            {dailyDone ? '+ Daily Target Hit!' : "Today's Target"}
          </span>
          <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 11, fontWeight: 700, color: dailyDone ? 'var(--green)' : 'var(--amber)' }}>
            ${pnl.toFixed(2)} / ${DAILY_GOAL.toFixed(2)}
          </span>
        </div>
        <MeterBar value={pnl} max={DAILY_GOAL} color={dailyDone ? 'var(--green)' : 'var(--amber)'} glow={dailyDone} />
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
          <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>
            {dailyDone ? '+ Daily salary earned' : `$${dailyRemaining.toFixed(2)} to go`}
          </span>
          <span style={{ fontSize: 9, fontFamily: 'var(--font-geist-mono)', fontWeight: 700, color: 'var(--amber)' }}>
            {dailyPct.toFixed(1)}%
          </span>
        </div>
      </div>

      {/* ── Annual goal ── */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 5 }}>
          <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            {annualDone ? '✦ CEO!' : 'Annual — $160,000'}
          </span>
          <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 11, fontWeight: 700, color: annualDone ? '#d4a800' : 'var(--blue)' }}>
            ${pnl.toFixed(0)} / $160k
          </span>
        </div>
        <MeterBar value={pnl} max={ANNUAL_GOAL} color={annualDone ? '#d4a800' : 'var(--blue)'} glow={annualDone} />
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
          <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>
            {annualDone ? '✦ CEO status!' : `$${annualRemaining.toLocaleString('en-US', { maximumFractionDigits: 0 })} to go`}
          </span>
          <span style={{ fontSize: 9, fontFamily: 'var(--font-geist-mono)', fontWeight: 700, color: 'var(--blue)' }}>
            {annualPct.toFixed(3)}%
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
            Next: <span style={{ fontWeight: 700, color: nextRank.color, fontFamily: 'var(--font-geist-mono)' }}>{nextRank.icon}</span>{' '}
            <span style={{ fontWeight: 700, color: nextRank.color }}>{nextRank.label}</span>
            <span style={{ color: 'var(--text-muted)', marginLeft: 5 }}>@ ${nextRank.dollars.toLocaleString()}</span>
          </span>
          <span style={{ fontSize: 10, fontFamily: 'var(--font-geist-mono)', fontWeight: 700, color: 'var(--text-muted)' }}>
            ${toNextRank.toLocaleString('en-US', { maximumFractionDigits: 0 })} away
          </span>
        </div>
      )}

      {/* ── Rank ladder ── */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>
          Rank Ladder
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          {RANKS.filter(r => r.dollars > 0).map(r => {
            const reached = pnl >= r.dollars
            const isCurrent = r.label === rank.label
            return (
              <div key={r.label} style={{
                display: 'flex', alignItems: 'center', gap: 7,
                padding: '4px 8px', borderRadius: 6,
                background: isCurrent ? 'rgba(74,127,165,0.08)' : 'transparent',
                opacity: reached ? 1 : 0.4,
              }}>
                <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 12, flexShrink: 0, color: reached ? r.color : 'var(--text-muted)' }}>{r.icon}</span>
                <span style={{ fontSize: 10, fontWeight: reached ? 700 : 400, color: reached ? r.color : 'var(--text-muted)', flex: 1 }}>
                  {r.label}
                </span>
                <span style={{ fontSize: 9, fontFamily: 'var(--font-geist-mono)', color: reached ? r.color : 'var(--text-muted)', fontWeight: reached ? 700 : 400 }}>
                  ${r.dollars.toLocaleString()}
                </span>
                {isCurrent && <span style={{ fontSize: 9, fontFamily: 'var(--font-geist-mono)', color: r.color }}>◀</span>}
              </div>
            )
          })}
        </div>
      </div>

      {/* ── Route to goal ── */}
      <div style={{ borderTop: '1px solid var(--border)', paddingTop: 10 }}>
        <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 8 }}>
          Route to $160k
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <StatRow
            label={winTrades.length > 0 ? 'Avg win / trade' : 'Est. win / trade'}
            value={`+$${avgWinPnl.toFixed(0)}`}
            color="var(--green)"
          />
          {!dailyDone && winsToDay !== null && (
            <StatRow label="Wins to hit today's target" value={`x${winsToDay}`} color="var(--amber)" highlight />
          )}
          {winsToWeek !== null && (
            <StatRow label="Wins to hit weekly target" value={`x${winsToWeek}`} color="var(--blue)" />
          )}
          {daysAtPace !== null && (
            <StatRow label="Days at current pace to $160k" value={`~${daysAtPace.toLocaleString()} days`} color="var(--text-muted)" />
          )}
          {stats.bestTrade > 0 && (
            <StatRow label="Best single trade" value={`+$${stats.bestTrade.toFixed(0)}`} color="var(--green)" />
          )}
        </div>
      </div>
    </div>
  )
}
