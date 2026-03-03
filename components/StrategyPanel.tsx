'use client'

import type { PerformanceStats, TradeRecord, KalshiMarket } from '@/lib/types'
import { useState, useEffect } from 'react'

const BOT_TRADE_DOLLARS = 100
const MAX_CONTRACTS     = 500

function tradeDefaults(askCents: number) {
  const contracts     = Math.max(1, Math.min(Math.floor(BOT_TRADE_DOLLARS / (askCents / 100)), MAX_CONTRACTS))
  const estimatedCost = contracts * askCents / 100
  const win           = contracts - estimatedCost
  const loss          = estimatedCost
  return { win, loss, contracts, estimatedCost }
}

const RISK_PARAMS = {
  minEdgePct:    3,
  maxDailyLoss:  150,
  maxDrawdownPct: 15,
  maxTrades:      48,
}

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
  const liveAsk    = askIsValid ? rawAsk : 50
  const td         = tradeDefaults(liveAsk)
  const usingEst   = settled.length === 0

  // Performance: actual when data exists, estimated otherwise
  const winRate    = stats.totalTrades > 0 ? stats.winRate : 0.52
  const avgWinPnl  = wins.length   > 0 ? wins.reduce((s, t)   => s + (t.pnl ?? 0), 0) / wins.length                      : td.win
  const avgLossPnl = losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + (t.pnl ?? 0), 0) / losses.length)           : td.loss
  const ev         = winRate * avgWinPnl - (1 - winRate) * avgLossPnl

  // Profit factor
  const pfNum      = avgLossPnl > 0 ? avgWinPnl / avgLossPnl : 0
  const profitFactor = pfNum > 0 ? pfNum.toFixed(2) : '—'

  // Half-Kelly position sizing
  const b          = avgLossPnl > 0 ? avgWinPnl / avgLossPnl : 1
  const kelly      = winRate > 0 ? Math.max(0, (b * winRate - (1 - winRate)) / b) : 0
  const halfKellyPct = (kelly * 0.5 * 100).toFixed(1)
  const halfKellyDollars = portfolioValue ? portfolioValue * kelly * 0.5 : null

  // Implied break-even win rate at current ask
  const breakEvenWinRate = liveAsk / 100  // P(YES) at which EV = 0

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
            label="Trade size (bot fixed)"
            value={`$${BOT_TRADE_DOLLARS}`}
            color="var(--text-primary)"
          />
          <Row
            label="Contracts at current ask"
            value={`${td.contracts}×`}
            color="var(--text-primary)"
            sub={`$${td.estimatedCost.toFixed(2)} cost`}
          />
          <Row
            label="Max win / max loss"
            value={`+$${td.win.toFixed(2)} / -$${td.loss.toFixed(2)}`}
            color="var(--text-primary)"
          />
          <Row
            label="Break-even win rate"
            value={`${(breakEvenWinRate * 100).toFixed(0)}%`}
            color={0.52 > breakEvenWinRate ? 'var(--green-dark)' : 'var(--amber)'}
            sub={`market implied · ROMA targets ~52%`}
          />
        </Section>

        {/* ── Performance ── */}
        <Section title={usingEst ? 'Expected Performance (est.)' : `Performance · ${settled.length} trades`}>
          <Row
            label="Win rate"
            value={stats.totalTrades > 0
              ? `${(winRate * 100).toFixed(1)}%`
              : `~${(winRate * 100).toFixed(0)}% est.`}
            color={winRate >= breakEvenWinRate ? 'var(--green-dark)' : 'var(--pink)'}
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
            sub="win ÷ loss · target > 1.5"
          />
          <Row
            label="EV per trade"
            value={ev > 0 ? `+$${ev.toFixed(2)}` : ev < 0 ? `-$${Math.abs(ev).toFixed(2)}` : '—'}
            color={ev > 0 ? 'var(--green-dark)' : ev < 0 ? 'var(--pink)' : 'var(--text-muted)'}
            sub={usingEst ? `est. · 52% win rate @ ${liveAsk}¢` : undefined}
          />
          <Row
            label="Half-Kelly size"
            value={halfKellyDollars != null
              ? `$${halfKellyDollars.toFixed(2)} (${halfKellyPct}%)`
              : `${halfKellyPct}% of bankroll`}
            color="var(--brown)"
            sub={portfolioValue
              ? `of $${portfolioValue.toFixed(2)} portfolio`
              : 'theoretical optimal'}
          />
        </Section>

        {/* ── How ROMA trades ── */}
        <Section title="How ROMA Trades">
          <div style={{ fontSize: 10, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 8 }}>
            Two parallel AI agents — <strong style={{ color: 'var(--brown)' }}>Sentiment</strong> and{' '}
            <strong style={{ color: 'var(--blue)' }}>Probability</strong> — run every 5 min on the active
            KXBTC15M market. P(YES) estimates are blended via Logarithmic Opinion Pool across six quant
            models (Cornish-Fisher, fat-tail ν=4, GBMM, Bipower Variation, Orderbook-implied, Hurst regime).
          </div>
          <Row label="Trade trigger"    value={`Edge > ${RISK_PARAMS.minEdgePct}%`} color="var(--text-primary)" />
          <Row label="Cycle frequency"  value="Every 5 min"                         color="var(--text-primary)" />
          <Row label="Max trades / day" value={String(RISK_PARAMS.maxTrades)}       color="var(--text-primary)" />
        </Section>

        {/* ── Risk controls ── */}
        <Section title="Risk Controls">
          <Row label="Min edge to trade" value={`${RISK_PARAMS.minEdgePct}%`}    color="var(--brown)" />
          <Row label="Max daily loss"    value={`$${RISK_PARAMS.maxDailyLoss}`}  color="var(--pink)" />
          <Row label="Max drawdown"      value={`${RISK_PARAMS.maxDrawdownPct}%`} color="var(--amber)" />
          <Row label="Position sizing"   value="Half-Kelly"                       color="var(--text-primary)"
            sub="vol scalar × confidence scalar · capped at 10% of portfolio" />
          <Row label="Sentiment filter"  value="> 0.4 contradiction → skip"      color="var(--text-secondary)" />
          <Row label="CUSUM jump guard"  value="Structural break → reduce quant" color="var(--text-secondary)" />
        </Section>

      </div>
    </div>
  )
}
