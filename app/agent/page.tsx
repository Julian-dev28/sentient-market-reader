'use client'

import { useState, useEffect } from 'react'
import { useAgentEngine } from '@/hooks/useAgentEngine'
import { useHourlyAgentEngine } from '@/hooks/useHourlyAgentEngine'
import Header from '@/components/Header'
import AgentAllowancePanel from '@/components/AgentAllowancePanel'
import AgentTradeLog from '@/components/AgentTradeLog'
import AgentStatsPanel from '@/components/AgentStatsPanel'
import AgentPipeline from '@/components/AgentPipeline'

export default function AgentPage() {
  const [orModel] = useState('')
  const [market, setMarket] = useState<'15m' | '1h'>('15m')

  const engine15m  = useAgentEngine(orModel || undefined)
  const engine1h   = useHourlyAgentEngine()
  const engine     = market === '15m' ? engine15m : engine1h

  const [kalshiBalance, setKalshiBalance] = useState<number>(0)
  const [startError, setStartError]       = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/balance')
      .then(r => r.json())
      .then(d => {
        const dollars = ((d.balance ?? 0) + (d.portfolio_value ?? 0)) / 100
        if (dollars > 0) setKalshiBalance(dollars)
      })
      .catch(() => {})
  }, [])

  // Reset error when switching market
  useEffect(() => { setStartError(null) }, [market])

  async function handleStart(kellyMode: boolean, bankroll: number, kellyPct: number, aiMode: boolean) {
    setStartError(null)
    const frac      = kellyPct / 100
    const allowance = kellyMode ? Math.max(1, bankroll * frac) : Math.max(1, engine.allowance)
    const result    = market === '15m'
      ? await engine15m.startAgent(allowance, kellyMode, kellyMode ? bankroll : undefined, kellyMode ? frac : undefined, aiMode)
      : await engine1h.startAgent(allowance, kellyMode, kellyMode ? bankroll : undefined, kellyMode ? frac : undefined)
    if (!result.ok) setStartError(result.error ?? 'Start failed')
  }

  const isAnyActive = engine15m.active || engine1h.active

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-primary)' }}>
      <Header
        cycleId={engine.pipeline?.cycleId ?? 0}
        isRunning={engine.isRunning}
      />

      <main style={{ maxWidth: 1200, margin: '0 auto', padding: '18px 16px' }}>

        {/* Page title + market selector */}
        <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <span style={{
              width: 10, height: 10, borderRadius: '50%', display: 'inline-block',
              background: isAnyActive ? 'var(--blue)' : 'var(--border)',
              boxShadow: isAnyActive ? '0 0 8px var(--blue)' : 'none',
              animation: isAnyActive ? 'pulse-live 1.5s ease-in-out infinite' : 'none',
            }} />
            <h1 style={{ fontSize: 15, fontWeight: 800, color: 'var(--text-primary)', margin: 0 }}>
              Autonomous Agent
            </h1>
          </div>

          {/* 15m / 1h selector */}
          <div style={{ display: 'flex', gap: 3, padding: 3, borderRadius: 9, background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
            {(['15m', '1h'] as const).map(m => {
              const isActive   = market === m
              const agentOn    = m === '15m' ? engine15m.active : engine1h.active
              return (
                <button
                  key={m}
                  onClick={() => setMarket(m)}
                  style={{
                    padding: '4px 12px', borderRadius: 7, cursor: 'pointer', fontSize: 11, fontWeight: 800,
                    border: 'none',
                    background: isActive ? 'var(--blue)' : 'transparent',
                    color: isActive ? '#fff' : 'var(--text-muted)',
                    transition: 'all 0.15s',
                    display: 'flex', alignItems: 'center', gap: 5,
                  }}
                >
                  {m === '15m' ? 'KXBTC15M' : 'KXBTCD · 1h'}
                  {agentOn && (
                    <span style={{ width: 5, height: 5, borderRadius: '50%', background: isActive ? '#fff' : 'var(--green)', display: 'inline-block', flexShrink: 0 }} />
                  )}
                </button>
              )
            })}
          </div>

          <span style={{
            fontSize: 9, color: 'var(--text-muted)', padding: '2px 8px', borderRadius: 6,
            background: 'var(--bg-secondary)', border: '1px solid var(--border)',
          }}>
            {market === '15m' ? 'Tiered Kelly · Markov + RiskManager' : '1h KXBTCD · Markov + RiskManager · Coinbase'}
          </span>

          {(engine.error || startError) && (
            <span style={{ fontSize: 9, color: 'var(--red)', background: 'var(--red-pale)', padding: '2px 8px', borderRadius: 6, border: '1px solid var(--red)' }}>
              {startError ?? engine.error}
            </span>
          )}
        </div>

        {/* 3-column layout */}
        <div style={{ display: 'grid', gridTemplateColumns: '270px 1fr 260px', gap: 14 }}>

          {/* LEFT — control panel */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <AgentAllowancePanel
              active={engine.active}
              isRunning={engine.isRunning}
              allowance={engine.allowance}
              bankroll={engine.kellyMode ? engine.bankroll : (kalshiBalance || engine.bankroll)}
              defaultBankroll={kalshiBalance}
              kellyMode={engine.kellyMode}
              aiMode={engine.aiMode ?? false}
              nextCycleIn={engine.nextCycleIn}
              windowKey={engine.windowKey}
              windowBetPlaced={engine.windowBetPlaced}
              orderError={engine.orderError}
              currentD={engine.currentD}
              confidenceThreshold={engine.confidenceThreshold}
              lastPollAt={engine.lastPollAt}
              strikePrice={engine.strikePrice}
              gkVol={engine.gkVol}
              agentPhase={engine.agentPhase}
              windowCloseAt={engine.windowCloseAt}
              onStart={handleStart}
              onStop={engine.stopAgent}
              onSetAllowance={engine.setAllowanceAmount}
              onRunCycle={market === '15m' ? engine15m.runCycle : undefined}
            />

            {/* Manual run — 15m only, not active */}
            {market === '15m' && !engine15m.active && (
              <button
                onClick={engine15m.runCycle}
                disabled={engine15m.isRunning}
                style={{
                  width: '100%', padding: '9px 0', borderRadius: 9, cursor: engine15m.isRunning ? 'wait' : 'pointer',
                  border: '1px solid var(--border)', background: 'var(--bg-secondary)',
                  fontSize: 11, fontWeight: 700, color: 'var(--text-muted)',
                  opacity: engine15m.isRunning ? 0.5 : 1,
                }}
              >
                {engine15m.isRunning ? '◌ Running…' : '↻ Run Once'}
              </button>
            )}
          </div>

          {/* CENTER — pipeline + trade log */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <AgentPipeline
              streamingAgents={engine.streamingAgents}
              pipeline={engine.pipeline}
              isRunning={engine.isRunning}
            />
            <AgentTradeLog trades={engine.trades} onClearHistory={engine.clearHistory} />
          </div>

          {/* RIGHT — stats */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <AgentStatsPanel
              stats={engine.stats}
              allowance={engine.allowance}
              initialAllowance={engine.initialAllowance}
              kalshiBalance={kalshiBalance}
            />
          </div>

        </div>
      </main>
    </div>
  )
}
