'use client'

import type { PerformanceStats, TradeRecord } from '@/lib/types'
import { useState, useEffect } from 'react'

const DAILY_GOAL   = 160_000 / 365   // $438.36
const WEEKLY_GOAL  = 160_000 / 52
const ANNUAL_GOAL  = 160_000
const RISK_PARAMS  = {
  minEdgePct:    3,
  maxDailyLoss:  150,
  maxDrawdownPct: 15,
  maxTrades:      48,
  minContracts:  100,
  maxContracts:  500,
}

function Row({ label, value, color, sub }: { label: string; value: string; color?: string; sub?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
      <span style={{ fontSize: 10, color: 'var(--text-muted)', flex: 1 }}>{label}</span>
      <div style={{ textAlign: 'right' }}>
        <span style={{ fontSize: 11, fontFamily: 'var(--font-geist-mono)', fontWeight: 700, color: color ?? 'var(--text-primary)' }}>{value}</span>
        {sub && <div style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 1 }}>{sub}</div>}
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 9, fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>{title}</div>
      {children}
    </div>
  )
}

export default function StrategyPanel({ stats, trades }: { stats: PerformanceStats; trades: TradeRecord[] }) {
  const [portfolioValue, setPortfolioValue] = useState<number | null>(null)

  useEffect(() => {
    fetch('/api/balance', { cache: 'no-store' })
      .then(r => r.json())
      .then(d => { if (d.portfolio_value) setPortfolioValue(d.portfolio_value / 100) })
      .catch(() => {})
  }, [])

  const pnl        = stats.totalPnl
  const settled    = trades.filter(t => t.outcome !== 'PENDING')
  const winTrades  = settled.filter(t => t.outcome === 'WIN')
  const lossTrades = settled.filter(t => t.outcome === 'LOSS')

  const avgWinPnl  = winTrades.length  > 0 ? winTrades.reduce((s, t)  => s + (t.pnl ?? 0), 0) / winTrades.length  : 50
  const avgLossPnl = lossTrades.length > 0 ? Math.abs(lossTrades.reduce((s, t) => s + (t.pnl ?? 0), 0) / lossTrades.length) : 30
  const winRate    = stats.totalTrades > 0 ? stats.winRate : 0.52   // default estimate
  const ev         = winRate * avgWinPnl - (1 - winRate) * avgLossPnl  // expected value per trade

  // ETA to daily goal
  const dailyRemaining  = Math.max(0, DAILY_GOAL  - pnl)
  const weeklyRemaining = Math.max(0, WEEKLY_GOAL - pnl)
  const annualRemaining = Math.max(0, ANNUAL_GOAL - pnl)

  // Wins needed (raw, ignoring losses)
  const winsToDaily  = avgWinPnl > 0 ? Math.ceil(dailyRemaining  / avgWinPnl) : '—'
  const winsToWeekly = avgWinPnl > 0 ? Math.ceil(weeklyRemaining / avgWinPnl) : '—'

  // ETA via expected value — how many 5-min cycles to accumulate remaining P&L
  const cyclesToDaily  = ev > 0 ? Math.ceil(dailyRemaining  / ev) : null
  const cyclesToWeekly = ev > 0 ? Math.ceil(weeklyRemaining / ev) : null
  const minsToDaily    = cyclesToDaily  != null ? cyclesToDaily  * 5 : null
  const minsToWeekly   = cyclesToWeekly != null ? cyclesToWeekly * 5 : null

  function fmtTime(mins: number | null) {
    if (mins == null) return '—'
    if (mins < 60)   return `~${mins}m`
    const h = Math.floor(mins / 60), m = mins % 60
    return m > 0 ? `~${h}h ${m}m` : `~${h}h`
  }

  // From current portfolio: how many all-in trades at avg win to hit daily goal
  const portfolioWins = portfolioValue && avgWinPnl > 0 && dailyRemaining > 0
    ? Math.ceil(dailyRemaining / avgWinPnl)
    : null

  // Profit factor
  const profitFactor = avgLossPnl > 0 ? (avgWinPnl / avgLossPnl).toFixed(2) : '—'

  // Kelly fraction estimate
  const b = avgLossPnl > 0 ? avgWinPnl / avgLossPnl : 1
  const kelly = winRate > 0 ? Math.max(0, (b * winRate - (1 - winRate)) / b) : 0
  const halfKelly = (kelly * 0.5 * 100).toFixed(1)

  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', maxHeight: 440 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 14, flexShrink: 0 }}>Strategy &amp; ETA</div>

      <div style={{ overflowY: 'auto', flex: 1, paddingRight: 2 }}>
      {/* ── Portfolio snapshot ── */}
      <Section title="Portfolio">
        <Row
          label="Kalshi portfolio value"
          value={portfolioValue != null ? `$${portfolioValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'}
          color="var(--blue)"
        />
        <Row
          label="Session P&L"
          value={`${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`}
          color={pnl >= 0 ? 'var(--green)' : 'var(--pink)'}
        />
        <Row
          label="Daily target remaining"
          value={`$${dailyRemaining.toFixed(2)}`}
          color="var(--amber)"
          sub={`$${DAILY_GOAL.toFixed(2)}/day · $160k/yr`}
        />
      </Section>

      {/* ── ETA to goals ── */}
      <Section title="ETA to Daily Goal">
        <Row label="Wins needed (at avg win)"    value={`×${winsToDaily}`}           color="var(--amber)" />
        <Row label="ETA via expected value"       value={fmtTime(minsToDaily)}         color="var(--green)"
          sub={ev > 0 ? `EV = +$${ev.toFixed(2)}/cycle` : 'not enough data yet'} />
        <Row label="Wins to weekly goal"          value={`×${winsToWeekly}`}          color="var(--text-secondary)" />
        <Row label="ETA to weekly"                value={fmtTime(minsToWeekly)}        color="var(--text-secondary)" />
        {portfolioWins != null && (
          <Row label="Wins from portfolio balance" value={`×${portfolioWins}`}         color="var(--blue)"
            sub={`based on $${portfolioValue?.toFixed(0)} account`} />
        )}
      </Section>

      {/* ── Strategy ── */}
      <Section title="How ROMA Trades">
        <div style={{ fontSize: 10, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 8 }}>
          ROMA runs two parallel AI agents — <strong style={{ color: 'var(--brown)' }}>Sentiment</strong> (macro + news) and{' '}
          <strong style={{ color: 'var(--blue)' }}>Probability</strong> (quant physics) — every 5 minutes on the active
          Kalshi KXBTC15M binary market. Each agent produces an independent P(YES) estimate which are blended via
          Logarithmic Opinion Pool. Six quant models (Cornish-Fisher, fat-tail ν=4, Brownian, Bipower Variation,
          Orderbook-implied, Hurst regime) anchor the final probability.
        </div>
        <Row label="Trade trigger"        value={`Edge > ${RISK_PARAMS.minEdgePct}%`}  color="var(--text-primary)" />
        <Row label="Signal"               value="6-model LOP blend"                    color="var(--text-primary)" />
        <Row label="Cycle frequency"      value="Every 5 min"                          color="var(--text-primary)" />
        <Row label="Max trades / day"     value={String(RISK_PARAMS.maxTrades)}        color="var(--text-primary)" />
      </Section>

      {/* ── Expectations ── */}
      <Section title="Expectations">
        <Row
          label="Win rate"
          value={stats.totalTrades > 0 ? `${(winRate * 100).toFixed(1)}%` : `~${(winRate * 100).toFixed(0)}% est.`}
          color={winRate > 0.5 ? 'var(--green)' : 'var(--amber)'}
        />
        <Row
          label="Avg win / loss"
          value={`+$${avgWinPnl.toFixed(0)} / -$${avgLossPnl.toFixed(0)}`}
          color="var(--text-primary)"
        />
        <Row
          label="Profit factor"
          value={String(profitFactor)}
          color={Number(profitFactor) >= 1.5 ? 'var(--green)' : 'var(--amber)'}
          sub="avg win ÷ avg loss — target > 1.5"
        />
        <Row
          label="Expected value / trade"
          value={ev > 0 ? `+$${ev.toFixed(2)}` : `$${ev.toFixed(2)}`}
          color={ev > 0 ? 'var(--green)' : 'var(--pink)'}
          sub={stats.totalTrades === 0 ? 'estimated (no settled trades yet)' : undefined}
        />
        <Row
          label="Half-Kelly fraction"
          value={`${halfKelly}% of bankroll`}
          color="var(--brown)"
          sub="theoretical optimal position size"
        />
      </Section>

      {/* ── Risk controls ── */}
      <Section title="Risk Controls">
        <Row label="Min edge to trade"      value={`${RISK_PARAMS.minEdgePct}%`}         color="var(--brown)" />
        <Row label="Max daily loss"         value={`$${RISK_PARAMS.maxDailyLoss}`}        color="var(--pink)" />
        <Row label="Max drawdown"           value={`${RISK_PARAMS.maxDrawdownPct}%`}      color="var(--amber)" />
        <Row label="Position size"          value={`${RISK_PARAMS.minContracts}–${RISK_PARAMS.maxContracts} contracts`} color="var(--text-primary)"
          sub="Half-Kelly × vol scalar × confidence" />
        <Row label="Sentiment filter"       value="> 0.4 contradiction → skip"           color="var(--text-secondary)" />
        <Row label="CUSUM jump guard"       value="Structural break → reduce quant weight" color="var(--text-secondary)" />
      </Section>
      </div>{/* end scroll container */}
    </div>
  )
}
