'use client'

import { useState, useEffect } from 'react'
import { useAgentEngine } from '@/hooks/useAgentEngine'
import Header from '@/components/Header'
import AgentAllowancePanel from '@/components/AgentAllowancePanel'
import AgentTradeLog from '@/components/AgentTradeLog'
import AgentStatsPanel from '@/components/AgentStatsPanel'
import AgentPipeline from '@/components/AgentPipeline'

export default function AgentPage() {
  const [liveMode, setLiveMode]             = useState(false)
  const [showLiveWarning, setShowLiveWarning] = useState(false)
  const [orModel]                           = useState('')

  useEffect(() => {
    if (localStorage.getItem('sentient-live-mode') === 'true') setLiveMode(true)
  }, [])

  const engine = useAgentEngine(liveMode, orModel || undefined)

  function handleStart() { engine.startAgent(engine.allowance) }

  function handleLiveToggle() {
    if (!liveMode) setShowLiveWarning(true)
    else { setLiveMode(false); localStorage.setItem('sentient-live-mode', 'false') }
  }
  function confirmLive() {
    setShowLiveWarning(false)
    setLiveMode(true)
    localStorage.setItem('sentient-live-mode', 'true')
  }

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-primary)' }}>
      <Header
        liveMode={liveMode}
        onToggleLive={handleLiveToggle}
        cycleId={engine.pipeline?.cycleId ?? 0}
        isRunning={engine.isRunning}
        nextCycleIn={engine.nextCycleIn}
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
          {engine.error && (
            <span style={{ fontSize: 9, color: 'var(--red)', background: 'var(--red-pale)', padding: '2px 8px', borderRadius: 6, border: '1px solid var(--red)' }}>
              {engine.error}
            </span>
          )}
        </div>

        {/* 3-column layout */}
        <div style={{ display: 'grid', gridTemplateColumns: '270px 1fr 260px', gap: 14 }}>

          {/* LEFT — Allowance + control */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <AgentAllowancePanel
              active={engine.active}
              liveMode={liveMode}
              isRunning={engine.isRunning}
              allowance={engine.allowance}
              nextCycleIn={engine.nextCycleIn}
              windowKey={engine.windowKey}
              windowBetPlaced={engine.windowBetPlaced}
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
            />
          </div>
        </div>
      </main>

      {/* Live mode warning modal */}
      {showLiveWarning && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 200,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <div style={{
            background: 'var(--bg-card)', borderRadius: 16, padding: '28px 32px', maxWidth: 360, width: '90%',
            border: '1.5px solid var(--green)', boxShadow: '0 8px 40px rgba(0,0,0,0.2)',
          }}>
            <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--text-primary)', marginBottom: 10 }}>Enable Live Trading?</div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 16 }}>
              Real orders will be placed on Kalshi with real money. The agent will deploy real capital each cycle.
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => setShowLiveWarning(false)} style={{
                flex: 1, padding: '10px 0', borderRadius: 9, cursor: 'pointer',
                border: '1px solid var(--border)', background: 'transparent',
                fontSize: 12, fontWeight: 700, color: 'var(--text-muted)',
              }}>Cancel</button>
              <button onClick={confirmLive} style={{
                flex: 1, padding: '10px 0', borderRadius: 9, cursor: 'pointer',
                border: '1px solid var(--green)', background: 'var(--green-pale)',
                fontSize: 12, fontWeight: 800, color: 'var(--green-dark)',
              }}>Enable Live</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
