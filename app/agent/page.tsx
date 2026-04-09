'use client'

import { useState, useEffect } from 'react'
import { useAgentEngine } from '@/hooks/useAgentEngine'
import Header from '@/components/Header'
import AgentAllowancePanel from '@/components/AgentAllowancePanel'
import AgentTradeLog from '@/components/AgentTradeLog'
import AgentStatsPanel from '@/components/AgentStatsPanel'
import AgentPipeline from '@/components/AgentPipeline'

export default function AgentPage() {
  const [orModel] = useState('')
  const engine    = useAgentEngine(orModel || undefined)
  const [kalshiBalance, setKalshiBalance] = useState<number>(0)
  const [startError, setStartError] = useState<string | null>(null)

  // Fetch real Kalshi balance on mount to use as default bankroll
  useEffect(() => {
    fetch('/api/balance')
      .then(r => r.json())
      .then(d => {
        // API returns { balance, portfolio_value } in cents
        const dollars = ((d.balance ?? 0) + (d.portfolio_value ?? 0)) / 100
        if (dollars > 0) setKalshiBalance(dollars)
      })
      .catch(() => {})
  }, [])

  async function handleStart(kellyMode: boolean, bankroll: number, kellyPct: number) {
    setStartError(null)
    const frac = kellyPct / 100
    const allowance = kellyMode ? Math.max(1, bankroll * frac) : Math.max(1, engine.allowance)
    const result = await engine.startAgent(allowance, kellyMode, kellyMode ? bankroll : undefined, kellyMode ? frac : undefined)
    if (!result.ok) setStartError(result.error ?? 'Start failed')
  }

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-primary)' }}>
      <Header
        cycleId={engine.pipeline?.cycleId ?? 0}
        isRunning={engine.isRunning}
      />

      <main style={{ maxWidth: 1200, margin: '0 auto', padding: '18px 16px' }}>

        {/* Page title */}
        <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <span style={{
              width: 10, height: 10, borderRadius: '50%', display: 'inline-block',
              background: engine.active ? 'var(--blue)' : 'var(--border)',
              boxShadow: engine.active ? '0 0 8px var(--blue)' : 'none',
              animation: engine.active ? 'pulse-live 1.5s ease-in-out infinite' : 'none',
            }} />
            <h1 style={{ fontSize: 15, fontWeight: 800, color: 'var(--text-primary)', margin: 0 }}>
              Autonomous Agent
            </h1>
          </div>
          <span style={{
            fontSize: 9, color: 'var(--text-muted)', padding: '2px 8px', borderRadius: 6,
            background: 'var(--bg-secondary)', border: '1px solid var(--border)',
          }}>
            Full-deploy · 1 bet / window
          </span>
          {(engine.error || startError) && (
            <span style={{ fontSize: 9, color: 'var(--red)', background: 'var(--red-pale)', padding: '2px 8px', borderRadius: 6, border: '1px solid var(--red)' }}>
              {startError ?? engine.error}
            </span>
          )}
        </div>

        {/* 3-column layout */}
        <div style={{ display: 'grid', gridTemplateColumns: '270px 1fr 260px', gap: 14 }}>

          {/* LEFT — Allowance + control */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <AgentAllowancePanel
              active={engine.active}
              isRunning={engine.isRunning}
              allowance={engine.allowance}
              bankroll={engine.kellyMode ? engine.bankroll : (kalshiBalance || engine.bankroll)}
              defaultBankroll={kalshiBalance}
              kellyMode={engine.kellyMode}
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
              onRunCycle={engine.runCycle}
            />

            {/* Manual run (for testing) */}
            {!engine.active && (
              <button
                onClick={engine.runCycle}
                disabled={engine.isRunning}
                style={{
                  width: '100%', padding: '9px 0', borderRadius: 9, cursor: engine.isRunning ? 'wait' : 'pointer',
                  border: '1px solid var(--border)', background: 'var(--bg-secondary)',
                  fontSize: 11, fontWeight: 700, color: 'var(--text-muted)',
                  opacity: engine.isRunning ? 0.5 : 1,
                }}
              >
                {engine.isRunning ? '◌ Running…' : '↻ Run Once'}
              </button>
            )}
          </div>

          {/* CENTER — Pipeline + trade log */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <AgentPipeline
              streamingAgents={engine.streamingAgents}
              pipeline={engine.pipeline}
              isRunning={engine.isRunning}
            />
            <AgentTradeLog trades={engine.trades} onClearHistory={engine.clearHistory} />
          </div>

          {/* RIGHT — Stats */}
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
