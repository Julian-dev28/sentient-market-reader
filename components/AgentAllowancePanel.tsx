'use client'

import { useState, useEffect, useRef } from 'react'
import type { AgentPhase } from '@/lib/agent-shared'

interface AgentAllowancePanelProps {
  active: boolean
  isRunning: boolean
  allowance: number
  bankroll: number
  kellyMode: boolean
  nextCycleIn: number
  windowKey: string | null
  windowBetPlaced: boolean
  orderError?: string | null
  currentD?: number
  confidenceThreshold?: number
  lastPollAt?: number | null
  strikePrice?: number
  gkVol?: number
  agentPhase?: AgentPhase
  windowCloseAt?: number
  onStart: (kellyMode: boolean, bankroll: number, kellyPct: number) => void
  onStop: () => void
  onSetAllowance: (amount: number, kellyMode?: boolean, bankroll?: number) => void
  onRunCycle: () => void
}

export default function AgentAllowancePanel({
  active, isRunning, allowance, bankroll, kellyMode, nextCycleIn,
  windowKey, windowBetPlaced, orderError, currentD: serverD, confidenceThreshold = 1.0,
  lastPollAt, strikePrice, gkVol = 0.002, agentPhase = 'idle', windowCloseAt = 0,
  onStart, onStop, onSetAllowance,
}: AgentAllowancePanelProps) {
  const [editingBankroll, setEditingBankroll] = useState(false)
  const [editVal, setEditVal] = useState('')
  const [localKelly, setLocalKelly] = useState(kellyMode)
  const [localBankroll, setLocalBankroll] = useState(bankroll || 400)
  const [kellyPct, setKellyPct] = useState(25)
  const [liveD, setLiveD] = useState<number | undefined>(serverD)
  const liveDRef = useRef<number | undefined>(serverD)

  useEffect(() => { setLiveD(serverD); liveDRef.current = serverD }, [serverD])
  useEffect(() => { setLocalKelly(kellyMode) }, [kellyMode])
  useEffect(() => { if (bankroll > 0) setLocalBankroll(bankroll) }, [bankroll])

  // Fetch BTC price every 2s and recompute d locally — only while actively monitoring
  useEffect(() => {
    if (!active || !strikePrice || strikePrice <= 0 || agentPhase !== 'monitoring') return
    const compute = async () => {
      try {
        const res = await fetch('/api/btc-price', { cache: 'no-store' })
        if (!res.ok) return
        const { price } = await res.json()
        if (!price || price <= 0) return
        // Use actual window close time if available, else fall back to 7 min
        const minutesLeft = windowCloseAt > 0
          ? Math.max(0.5, (windowCloseAt - Date.now()) / 60_000)
          : 7
        const candlesLeft = minutesLeft / 15
        const d = Math.log(price / strikePrice) / (gkVol * Math.sqrt(candlesLeft))
        setLiveD(d)
        liveDRef.current = d
      } catch {}
    }
    compute()
    const id = setInterval(compute, 2_000)
    return () => clearInterval(id)
  }, [active, strikePrice, gkVol, agentPhase, windowCloseAt])

  const currentD = liveD
  const mins = Math.floor(nextCycleIn / 60)
  const secs = Math.floor(nextCycleIn % 60)

  const accentCol  = active ? 'var(--green)'      : 'var(--blue)'
  const accentDark = active ? 'var(--green-dark)' : 'var(--blue-dark)'
  const accentPale = active ? 'var(--green-pale)' : 'var(--blue-pale)'
  const accentBdr  = active ? '#164030'           : '#243850'

  const perTrade = localKelly
    ? Math.max(1, (localBankroll * kellyPct) / 100)
    : allowance

  return (
    <div className="card bracket-card" style={{
      padding: '14px 16px',
      border: `1.5px solid ${active ? accentBdr : '#8ab4cf'}`,
      background: active ? accentPale : 'rgba(74,127,165,0.04)',
      transition: 'all 0.3s ease',
    }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <span style={{
            width: 8, height: 8, borderRadius: '50%', display: 'inline-block', flexShrink: 0,
            background: active ? accentCol : 'var(--border)',
            boxShadow: active ? `0 0 6px ${accentCol}` : 'none',
            animation: active ? 'pulse-live 1.5s ease-in-out infinite' : 'none',
          }} />
          <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.07em', textTransform: 'uppercase', color: active ? accentDark : 'var(--text-muted)' }}>
            Trade Agent
          </span>
          <span style={{
            fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 4,
            background: accentPale, border: `1px solid ${accentBdr}`,
            color: active ? accentDark : 'var(--blue-dark)',
          }}>
            {active ? 'LIVE' : 'IDLE'}
          </span>
          {(active ? kellyMode : localKelly) && (
            <span style={{ fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 4, background: 'var(--amber-pale)', border: '1px solid var(--amber)', color: 'var(--amber)' }}>
              KELLY
            </span>
          )}
        </div>
        {active && isRunning && (
          <span style={{ animation: 'spin-slow 1s linear infinite', display: 'inline-block', color: 'var(--blue)', fontSize: 11 }}>◌</span>
        )}
      </div>

      {/* Kelly / Fixed toggle — only show when not active */}
      {!active && (
        <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
          {(['Fixed', 'Kelly'] as const).map(mode => (
            <button key={mode} onClick={() => setLocalKelly(mode === 'Kelly')} style={{
              flex: 1, padding: '5px 0', borderRadius: 7, cursor: 'pointer', fontSize: 11, fontWeight: 700,
              border: `1px solid ${(mode === 'Kelly') === localKelly ? 'var(--brown)' : 'var(--border)'}`,
              background: (mode === 'Kelly') === localKelly ? 'var(--brown-pale)' : 'transparent',
              color: (mode === 'Kelly') === localKelly ? 'var(--brown-dark)' : 'var(--text-muted)',
              transition: 'all 0.15s',
            }}>
              {mode}
            </button>
          ))}
        </div>
      )}

      {/* Bet config */}
      {localKelly && !active ? (
        /* Kelly mode: bankroll + pct inputs */
        <div style={{ marginBottom: 12 }}>
          <div style={{ padding: '10px 12px', borderRadius: 10, background: 'var(--bg-secondary)', border: '1px solid var(--border-bright)', marginBottom: 8 }}>
            <div style={{ fontSize: 8, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', fontWeight: 600, marginBottom: 4 }}>
              Total Bankroll
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 18, fontWeight: 800, color: 'var(--text-secondary)' }}>$</span>
              <input
                type="number" min="10" step="10"
                value={localBankroll}
                onChange={e => setLocalBankroll(parseFloat(e.target.value) || 0)}
                style={{
                  fontFamily: 'var(--font-geist-mono)', fontSize: 22, fontWeight: 800,
                  color: 'var(--brown)', letterSpacing: '-0.02em',
                  background: 'transparent', border: 'none', outline: 'none', width: '100%', padding: 0,
                }}
              />
            </div>
          </div>

          {/* Kelly percentage slider */}
          <div style={{ padding: '10px 12px', borderRadius: 10, background: 'var(--bg-secondary)', border: '1px solid var(--border-bright)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
              <span style={{ fontSize: 8, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', fontWeight: 600 }}>
                Per Trade
              </span>
              <span style={{ fontSize: 8, fontFamily: 'var(--font-geist-mono)', color: 'var(--amber)', fontWeight: 700 }}>
                {kellyPct}% = ${Math.max(1, (localBankroll * kellyPct / 100)).toFixed(2)}
              </span>
            </div>
            <input
              type="range" min="5" max="50" step="5"
              value={kellyPct}
              onChange={e => setKellyPct(parseInt(e.target.value))}
              style={{ width: '100%', accentColor: 'var(--amber)' }}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 2 }}>
              <span style={{ fontSize: 7, color: 'var(--text-muted)' }}>5% safe</span>
              <span style={{ fontSize: 7, color: 'var(--text-muted)' }}>25% optimal</span>
              <span style={{ fontSize: 7, color: 'var(--red)' }}>50% risky</span>
            </div>
          </div>
        </div>
      ) : kellyMode && active ? (
        /* Kelly mode active: show live bankroll */
        <div style={{ padding: '10px 12px', borderRadius: 10, background: 'var(--bg-secondary)', border: '1px solid var(--border-bright)', marginBottom: 12 }}>
          <div style={{ fontSize: 8, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', fontWeight: 600, marginBottom: 2 }}>
            Bankroll · auto-compounding
          </div>
          <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 22, fontWeight: 800, color: 'var(--amber)', letterSpacing: '-0.02em' }}>
            ${bankroll.toFixed(2)}
          </div>
          <div style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 2 }}>
            Next bet: <span style={{ color: 'var(--amber)', fontWeight: 700 }}>${allowance.toFixed(2)}</span> ({Math.round(allowance / bankroll * 100)}% of bankroll)
          </div>
        </div>
      ) : (
        /* Fixed mode: tap to edit allowance */
        <div
          onClick={() => { if (!editingBankroll) { setEditVal(allowance.toFixed(2)); setEditingBankroll(true) } }}
          style={{ padding: '10px 12px', borderRadius: 10, background: 'var(--bg-secondary)', border: `1px solid ${editingBankroll ? 'var(--blue)' : 'var(--border-bright)'}`, marginBottom: 12, cursor: editingBankroll ? 'default' : 'text', transition: 'border-color 0.15s' }}
        >
          <div style={{ fontSize: 8, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', fontWeight: 600, marginBottom: 2 }}>
            Bet per trade {!active && !editingBankroll && <span style={{ color: 'var(--blue)' }}>· tap to edit</span>}
          </div>
          {editingBankroll ? (
            <input
              autoFocus type="number" min="1" step="10"
              value={editVal}
              onChange={e => setEditVal(e.target.value)}
              onBlur={() => {
                const n = parseFloat(editVal)
                if (!isNaN(n) && n > 0) onSetAllowance(n)
                setEditingBankroll(false)
              }}
              onKeyDown={e => {
                if (e.key === 'Enter') { (e.target as HTMLInputElement).blur() }
                if (e.key === 'Escape') { setEditingBankroll(false) }
              }}
              style={{
                fontFamily: 'var(--font-geist-mono)', fontSize: 24, fontWeight: 800,
                color: 'var(--brown)', letterSpacing: '-0.02em',
                background: 'transparent', border: 'none', outline: 'none', width: '100%', padding: 0,
              }}
            />
          ) : (
            <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 24, fontWeight: 800, color: allowance > 0 ? 'var(--brown)' : 'var(--red)', letterSpacing: '-0.02em' }}>
              ${allowance.toFixed(2)}
            </div>
          )}
          {allowance <= 0 && !editingBankroll && (
            <div style={{ fontSize: 9, color: 'var(--red)', marginTop: 2 }}>Set a bet amount to continue</div>
          )}
        </div>
      )}

      {/* D-score monitor */}
      {active && (
        <div style={{ marginBottom: 12, padding: '10px 12px', borderRadius: 9, background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
            <span style={{ fontSize: 8, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', fontWeight: 700 }}>
              D-Score Monitor
            </span>
            {windowKey && (
              <span style={{ fontSize: 8, fontFamily: 'var(--font-geist-mono)', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 130 }}>
                {windowKey.split('-').slice(-2).join('-')}
              </span>
            )}
          </div>

          {/* Phase-aware status display */}
          {(agentPhase === 'bootstrap' || agentPhase === 'pipeline') ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ animation: 'spin-slow 1s linear infinite', display: 'inline-block', color: 'var(--blue)', fontSize: 11 }}>◌</span>
              <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--blue-dark)' }}>
                {agentPhase === 'bootstrap' ? 'Fetching market data…' : 'Running pipeline…'}
              </span>
            </div>
          ) : agentPhase === 'bet_placed' ? (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                <div style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--green)', boxShadow: '0 0 5px var(--green)', flexShrink: 0 }} />
                <span style={{ fontSize: 11, fontWeight: 800, color: 'var(--green-dark)' }}>Bet placed ✓</span>
              </div>
              {windowCloseAt > 0 && (
                <div style={{ fontSize: 8, color: 'var(--text-muted)' }}>
                  Window closes in {mins}:{String(secs).padStart(2, '0')} · awaiting result
                </div>
              )}
            </div>
          ) : agentPhase === 'pass_skipped' ? (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                <div style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--amber)', flexShrink: 0 }} />
                <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--amber)' }}>PASS — skipping window</span>
              </div>
              <div style={{ fontSize: 8, color: 'var(--text-muted)' }}>
                {nextCycleIn > 0 ? `Next window in ${mins}:${String(secs).padStart(2, '0')}` : 'Waiting for next window…'}
              </div>
            </div>
          ) : agentPhase === 'order_failed' ? (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                <div style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--red)', flexShrink: 0 }} />
                <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--red)' }}>Order failed — retrying</span>
              </div>
              <div style={{ fontSize: 8, color: 'var(--text-muted)' }}>
                {nextCycleIn > 0 ? `Retry in ${mins}:${String(secs).padStart(2, '0')}` : 'Retrying…'}
              </div>
            </div>
          ) : agentPhase === 'monitoring' && lastPollAt ? (
            <>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 4 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
                  <span style={{
                    fontFamily: 'var(--font-geist-mono)', fontSize: 20, fontWeight: 800, letterSpacing: '-0.03em',
                    color: Math.abs(currentD ?? 0) >= confidenceThreshold ? 'var(--green-dark)' : 'var(--text-primary)',
                  }}>
                    {currentD !== undefined ? (currentD >= 0 ? '+' : '') + currentD.toFixed(3) : '—'}
                  </span>
                  <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>/ {currentD !== undefined && currentD < 0 ? '-' : ''}{confidenceThreshold}</span>
                </div>
              </div>
              <div style={{ height: 4, borderRadius: 2, background: 'var(--border)', overflow: 'hidden', marginBottom: 4 }}>
                <div style={{
                  height: '100%', borderRadius: 2,
                  width: `${Math.min(100, (Math.abs(currentD ?? 0) / confidenceThreshold) * 100)}%`,
                  background: Math.abs(currentD ?? 0) >= confidenceThreshold
                    ? 'var(--green)'
                    : Math.abs(currentD ?? 0) >= confidenceThreshold * 0.75
                      ? 'var(--amber)'
                      : 'var(--blue)',
                  transition: 'width 0.4s ease, background 0.3s ease',
                }} />
              </div>
              <div style={{ fontSize: 8, color: 'var(--text-muted)' }}>
                {Math.abs(currentD ?? 0) >= confidenceThreshold
                  ? '⚡ Signal strong — launching pipeline'
                  : `${((1 - Math.abs(currentD ?? 0) / confidenceThreshold) * 100).toFixed(0)}% to threshold · live`}
              </div>
            </>
          ) : (
            /* waiting / idle / unknown */
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <div style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--border)', flexShrink: 0 }} />
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                {nextCycleIn > 0
                  ? `Next window in ${mins}:${String(secs).padStart(2, '0')}`
                  : agentPhase === 'waiting' ? 'Waiting for valid window…' : 'Monitoring…'}
              </span>
            </div>
          )}

          {orderError && (
            <div style={{ marginTop: 6, fontSize: 8, color: 'var(--red)', fontFamily: 'var(--font-geist-mono)', lineHeight: 1.4, wordBreak: 'break-word', borderTop: '1px solid var(--border)', paddingTop: 5 }}>
              ⚠ {orderError}
            </div>
          )}
        </div>
      )}

      {/* Start / Stop */}
      {!active ? (
        <button
          onClick={() => onStart(localKelly, localBankroll, kellyPct)}
          style={{
            width: '100%', padding: '12px 0', borderRadius: 9, cursor: 'pointer',
            border: '1px solid var(--green)',
            background: 'linear-gradient(135deg, #164030 0%, var(--green) 100%)',
            fontSize: 13, fontWeight: 800, color: '#fff', letterSpacing: '0.03em',
            boxShadow: '0 2px 12px rgba(80,168,120,0.25)', transition: 'all 0.15s',
          }}
          onMouseEnter={e => { e.currentTarget.style.opacity = '0.88' }}
          onMouseLeave={e => { e.currentTarget.style.opacity = '1' }}
        >
          ▶ Start Agent {localKelly ? `· Kelly ${kellyPct}%` : '· Fixed'}
        </button>
      ) : (
        <button onClick={onStop} style={{
          width: '100%', padding: '12px 0', borderRadius: 9, cursor: 'pointer',
          border: '1px solid var(--pink)', background: 'var(--pink-pale)',
          fontSize: 13, fontWeight: 800, color: 'var(--pink)', letterSpacing: '0.03em',
          transition: 'all 0.15s',
        }}
          onMouseEnter={e => { e.currentTarget.style.background = 'var(--pink)'; e.currentTarget.style.color = '#fff' }}
          onMouseLeave={e => { e.currentTarget.style.background = 'var(--pink-pale)'; e.currentTarget.style.color = 'var(--pink)' }}
        >
          ■ Stop Agent
        </button>
      )}
    </div>
  )
}
