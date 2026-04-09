'use client'

import type { PerformanceStats, TradeRecord, KalshiMarket } from '@/lib/types'
import { useState, useEffect } from 'react'

// Strategy constants — must match lib/agents/risk-manager.ts RISK_PARAMS exactly
const RISK_PARAMS = {
  minEdgePct:        6,    // minimum after-fee EV% to trade (empirically validated on 2,690 fills)
  maxDailyLossFloor: 50,   // $ daily loss floor
  maxGivebackMult:   1.5,  // stop if session P&L falls > 1.5× daily-loss cap from peak
  maxTrades:         48,
  maxTradePct:       15,   // max % of portfolio per trade (quarter-Kelly cap)
  entryWindow:      '3–9', // minutes before close (95.7% wr in this window)
}
// Empirical win rate in the confirmed d∈[1.0,1.2] zone (3-9min window, 2,690 live fills)
const EMPIRICAL_WIN_RATE = 0.957

function Row({ label, value, color, sub }: { label: string; value: string; color?: string; sub?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
      <span style={{ fontSize: 10, color: 'var(--text-muted)', flex: 1, paddingRight: 8 }}>{label}</span>
      <div style={{ textAlign: 'right', flexShrink: 0 }}>
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

export default function StrategyPanel({ stats, trades, market }: {
  stats: PerformanceStats
  trades: TradeRecord[]
  market?: KalshiMarket | null
}) {
  const [portfolioValue, setPortfolioValue] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    async function loadBalance() {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const r = await fetch('/api/balance')
          const d: { balance?: number; portfolio_value?: number } = await r.json()
          if (cancelled) return
          const cash = typeof d.balance         === 'number' ? d.balance         : 0
          const pos  = typeof d.portfolio_value === 'number' ? d.portfolio_value : 0
          setPortfolioValue((cash + pos) / 100)
          return
        } catch {
          if (attempt < 2) await new Promise(res => setTimeout(res, 2000))
        }
      }
    }
    loadBalance()
    return () => { cancelled = true }
  }, [])

  const settled  = trades.filter(t => t.outcome !== 'PENDING')
  const pending  = trades.filter(t => t.outcome === 'PENDING')
  const wins     = settled.filter(t => t.outcome === 'WIN')
  const losses   = settled.filter(t => t.outcome === 'LOSS')
  const realizedPnl     = settled.reduce((s, t) => s + (t.pnl ?? 0), 0)
  const pendingExposure = pending.reduce((s, t) => s + t.estimatedCost, 0)

  // Validate ask: must be 5–95¢ to be meaningful
  const rawAsk     = market?.yes_ask
  const askIsValid = rawAsk != null && rawAsk >= 5 && rawAsk <= 95
  const liveAsk    = askIsValid ? rawAsk : 81  // 81¢ = empirical average ask at d∈[1.0,1.2]
  const usingEst   = settled.length === 0

  // Performance: actual when data exists, empirical baseline otherwise
  const winRate    = stats.totalTrades > 0 ? stats.winRate : EMPIRICAL_WIN_RATE
  const avgWinPnl  = wins.length   > 0 ? wins.reduce((s, t) => s + (t.pnl ?? 0), 0) / wins.length   : (1 - liveAsk / 100) * 10
  const avgLossPnl = losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + (t.pnl ?? 0), 0) / losses.length) : (liveAsk / 100) * 10
  const ev         = winRate * avgWinPnl - (1 - winRate) * avgLossPnl

  // Profit factor
  const pfNum        = avgLossPnl > 0 ? avgWinPnl / avgLossPnl : 0
  const profitFactor = pfNum > 0 ? pfNum.toFixed(2) : '—'

  // Quarter-Kelly position sizing (0.25× validated in 787-trade backtest)
  const b               = avgLossPnl > 0 ? avgWinPnl / avgLossPnl : 1
  const kelly           = winRate > 0 ? Math.max(0, (b * winRate - (1 - winRate)) / b) : 0
  const qKellyPct       = (kelly * 0.25 * 100).toFixed(1)
  const qKellyDollars   = portfolioValue ? portfolioValue * kelly * 0.25 : null

  // Implied break-even win rate at current ask
  const breakEvenWinRate = liveAsk / 100

  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', maxHeight: 440 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 14, flexShrink: 0 }}>Strategy &amp; ETA</div>

      <div style={{ overflowY: 'auto', flex: 1, paddingRight: 2 }}>

        {/* ── Portfolio snapshot ── */}
        <Section title="Portfolio">
          <Row
            label="Kalshi account value"
            value={portfolioValue != null
              ? `$${portfolioValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
              : '—'}
            color="var(--blue)"
          />
          <Row
            label="Session P&L (realized)"
            value={settled.length > 0
              ? `${realizedPnl >= 0 ? '+' : ''}$${realizedPnl.toFixed(2)}`
              : '—'}
            color={realizedPnl > 0 ? 'var(--green-dark)' : realizedPnl < 0 ? 'var(--pink)' : 'var(--text-muted)'}
            sub={settled.length > 0
              ? `${settled.length} settled · ${wins.length}W ${losses.length}L`
              : 'no settled trades yet'}
          />
          {pending.length > 0 && (
            <Row
              label="Pending trades"
              value={`${pending.length} open`}
              color="var(--amber)"
              sub={`$${pendingExposure.toFixed(2)} at risk`}
            />
          )}
        </Section>

        {/* ── Current trade setup ── */}
        <Section title={`Trade Setup · ${askIsValid ? 'Live' : 'Est.'} ${liveAsk}¢ ask`}>
          <Row
            label="Position sizing"
            value="Quarter-Kelly (0.25×)"
            color="var(--text-primary)"
            sub="Kelly fraction × 0.25 × portfolio × vol scalar"
          />
          {qKellyDollars != null && (
            <Row
              label={`Kelly size at ${(winRate * 100).toFixed(0)}% wr`}
              value={`$${qKellyDollars.toFixed(2)} (${qKellyPct}%)`}
              color="var(--brown)"
              sub={`of $${portfolioValue!.toFixed(2)} portfolio`}
            />
          )}
          <Row
            label="Break-even win rate"
            value={`${(breakEvenWinRate * 100).toFixed(0)}%`}
            color={EMPIRICAL_WIN_RATE > breakEvenWinRate ? 'var(--green-dark)' : 'var(--amber)'}
            sub={`market implied · ROMA targets ~${(EMPIRICAL_WIN_RATE * 100).toFixed(0)}%`}
          />
        </Section>

        {/* ── Performance ── */}
        <Section title={usingEst ? 'Expected Performance (est.)' : `Performance · ${settled.length} trades`}>
          <Row
            label="Win rate"
            value={stats.totalTrades > 0
              ? `${(winRate * 100).toFixed(1)}%`
              : `~${(EMPIRICAL_WIN_RATE * 100).toFixed(0)}% (empirical)`}
            color={winRate >= breakEvenWinRate ? 'var(--green-dark)' : 'var(--pink)'}
            sub={stats.totalTrades === 0 ? '2,690 live fills · d∈[1.0,1.2] · 3-9min' : undefined}
          />
          <Row
            label="Avg win"
            value={`+$${avgWinPnl.toFixed(2)}`}
            color="var(--green-dark)"
            sub={usingEst ? `est. at ${liveAsk}¢ ask` : undefined}
          />
          <Row
            label="Avg loss"
            value={`-$${avgLossPnl.toFixed(2)}`}
            color="var(--pink)"
            sub={usingEst ? `est. at ${liveAsk}¢ ask` : undefined}
          />
          <Row
            label="Profit factor"
            value={String(profitFactor)}
            color={pfNum >= 1.5 ? 'var(--green-dark)' : pfNum >= 1.0 ? 'var(--amber)' : 'var(--pink)'}
            sub="gross wins ÷ gross losses · target > 1.5"
          />
          <Row
            label="EV per trade"
            value={ev > 0 ? `+$${ev.toFixed(2)}` : ev < 0 ? `-$${Math.abs(ev).toFixed(2)}` : '—'}
            color={ev > 0 ? 'var(--green-dark)' : ev < 0 ? 'var(--pink)' : 'var(--text-muted)'}
            sub={usingEst ? `est. · ${(EMPIRICAL_WIN_RATE*100).toFixed(0)}% wr @ ${liveAsk}¢` : undefined}
          />
        </Section>

        {/* ── How ROMA trades ── */}
        <Section title="How ROMA Trades">
          <div style={{ fontSize: 10, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 8 }}>
            Pure quant Brownian model — d-score gates entry to the confirmed [1.0, 1.2] edge zone only.
            Sentiment runs as context; probability uses Cornish-Fisher + fat-tail (ν=4) + GK vol.
            Entry window: 3–9 min before close (95.7% wr empirical).
          </div>
          <Row label="Entry trigger"    value={`d∈[1.0,1.2] + edge > ${RISK_PARAMS.minEdgePct}%`} color="var(--text-primary)" />
          <Row label="Entry window"     value={`${RISK_PARAMS.entryWindow} min before close`}      color="var(--text-primary)" />
          <Row label="Max trades / day" value={String(RISK_PARAMS.maxTrades)}                      color="var(--text-primary)" />
        </Section>

        {/* ── Risk controls ── */}
        <Section title="Risk Controls">
          <Row label="Min edge to trade" value={`${RISK_PARAMS.minEdgePct}% after fees`} color="var(--brown)" />
          <Row label="Max daily loss"    value={`$${RISK_PARAMS.maxDailyLossFloor} floor`} color="var(--pink)" />
          <Row label="Session giveback"  value={`${RISK_PARAMS.maxGivebackMult}× daily loss cap`} color="var(--amber)"
            sub="stop if today's P&L falls > 1.5× loss cap from peak" />
          <Row label="Position sizing"   value="Quarter-Kelly (0.25×)"                 color="var(--text-primary)"
            sub={`vol + conf scalars · capped at ${RISK_PARAMS.maxTradePct}% of portfolio`} />
          <Row label="Maker fee"         value="0.0175 × C × P × (1-P)"               color="var(--text-secondary)"
            sub="deducted from every trade (win and loss)" />
          <Row label="CUSUM jump guard"  value="Structural break → NO_TRADE"           color="var(--text-secondary)" />
        </Section>

      </div>
    </div>
  )
}
