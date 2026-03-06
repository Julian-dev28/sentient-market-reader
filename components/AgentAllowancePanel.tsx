'use client'

import { useState, useEffect } from 'react'

interface AgentAllowancePanelProps {
  active: boolean
  isRunning: boolean
  allowance: number
  nextCycleIn: number
  windowKey: string | null
  windowBetPlaced: boolean
  orderError?: string | null
  currentD?: number
  confidenceThreshold?: number
  lastPollAt?: number | null
  onStart: () => void
  onStop: () => void
  onSetAllowance: (amount: number) => void
  onRunCycle: () => void
}

export default function AgentAllowancePanel({
  active, isRunning, allowance, nextCycleIn,
  windowKey, windowBetPlaced, orderError, currentD, confidenceThreshold = 1.0,
  lastPollAt, onStart, onStop, onSetAllowance, onRunCycle,
}: AgentAllowancePanelProps) {
  const [editing, setEditing] = useState(false)
  const [editVal, setEditVal] = useState('')
  const [secsAgo, setSecsAgo] = useState<number | null>(null)

  useEffect(() => {
    if (!lastPollAt) { setSecsAgo(null); return }
    const tick = () => setSecsAgo(Math.round((Date.now() - lastPollAt) / 1000))
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [lastPollAt])

  const mins = Math.floor(nextCycleIn / 60)
  const secs = Math.floor(nextCycleIn % 60)

  const accentCol  = active ? 'var(--green)'      : 'var(--blue)'
  const accentDark = active ? 'var(--green-dark)' : 'var(--blue-dark)'
  const accentPale = active ? 'var(--green-pale)' : 'var(--blue-pale)'
  const accentBdr  = active ? '#164030'           : '#243850'


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
            background: accentPale,
            border: `1px solid ${accentBdr}`,
            color: active ? accentDark : 'var(--blue-dark)',
          }}>
            {active ? 'LIVE' : 'IDLE'}
          </span>
        </div>
        {active && (
          <span style={{ fontSize: 9, fontFamily: 'var(--font-geist-mono)', color: 'var(--text-muted)' }}>
            {isRunning
              ? <span style={{ animation: 'spin-slow 1s linear infinite', display: 'inline-block' }}>◌</span>
              : windowBetPlaced
                ? <span style={{ color: 'var(--green-dark)', fontWeight: 700 }}>bet live ✓</span>
                : nextCycleIn > 0
                  ? `↻ ${mins}:${String(secs).padStart(2, '0')}`
                  : <span style={{ color: 'var(--amber)' }}>watching…</span>}
          </span>
        )}
      </div>

      {/* Allowance hero — click to edit */}
      <div
        onClick={() => { if (!editing) { setEditVal(allowance.toFixed(2)); setEditing(true) } }}
        style={{ padding: '10px 12px', borderRadius: 10, background: 'var(--bg-secondary)', border: `1px solid ${editing ? 'var(--blue)' : 'var(--border-bright)'}`, marginBottom: 12, cursor: editing ? 'default' : 'text', transition: 'border-color 0.15s' }}
      >
        <div style={{ fontSize: 8, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', fontWeight: 600, marginBottom: 2 }}>
          Bet per trade {!active && !editing && <span style={{ color: 'var(--blue)', fontStyle: 'normal' }}>· tap to edit</span>}
        </div>
        {editing ? (
          <input
            autoFocus
            type="number" min="1" step="10"
            value={editVal}
            onChange={e => setEditVal(e.target.value)}
            onBlur={() => {
              const n = parseFloat(editVal)
              if (!isNaN(n) && n > 0) onSetAllowance(n)
              setEditing(false)
            }}
            onKeyDown={e => {
              if (e.key === 'Enter') { (e.target as HTMLInputElement).blur() }
              if (e.key === 'Escape') { setEditing(false) }
            }}
            style={{
              fontFamily: 'var(--font-geist-mono)', fontSize: 24, fontWeight: 800,
              color: 'var(--brown)', letterSpacing: '-0.02em',
              background: 'transparent', border: 'none', outline: 'none',
              width: '100%', padding: 0,
            }}
          />
        ) : (
          <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 24, fontWeight: 800, color: allowance > 0 ? 'var(--brown)' : 'var(--red)', letterSpacing: '-0.02em' }}>
            ${allowance.toFixed(2)}
          </div>
        )}
        {allowance <= 0 && !editing && (
          <div style={{ fontSize: 9, color: 'var(--red)', marginTop: 2 }}>Set a bet amount to continue</div>
        )}
      </div>

      {/* Current window status */}
      {windowKey && (
        <div style={{ marginBottom: 12, padding: '8px 10px', borderRadius: 9, background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
          <div style={{ fontSize: 8, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600, marginBottom: 4 }}>
            Current Window
          </div>
          <div style={{ fontSize: 9, fontFamily: 'var(--font-geist-mono)', color: 'var(--text-secondary)', marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {windowKey}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
            <div style={{ width: 6, height: 6, borderRadius: '50%', background: windowBetPlaced ? 'var(--green)' : orderError ? 'var(--red)' : 'var(--amber)', flexShrink: 0 }} />
            <span style={{ fontSize: 9, fontWeight: 700, color: windowBetPlaced ? 'var(--green-dark)' : orderError ? 'var(--red)' : 'var(--amber)' }}>
              {windowBetPlaced ? 'Bet placed' : orderError ? 'Order failed' : currentD !== undefined && Math.abs(currentD) > 0 ? `Watching… d=${Math.abs(currentD).toFixed(2)}/${confidenceThreshold}` : 'Waiting for signal'}
            </span>
          </div>
          {orderError && (
            <div style={{ marginTop: 4, fontSize: 8, color: 'var(--red)', fontFamily: 'var(--font-geist-mono)', lineHeight: 1.4, wordBreak: 'break-word' }}>
              {orderError}
            </div>
          )}
          {secsAgo !== null && (
            <div style={{ marginTop: 4, fontSize: 8, color: 'var(--text-muted)', fontFamily: 'var(--font-geist-mono)' }}>
              last checked {secsAgo}s ago
            </div>
          )}
        </div>
      )}

      {/* Start / Stop */}
      {!active ? (
        <button onClick={onStart} style={{
          width: '100%', padding: '12px 0', borderRadius: 9, cursor: 'pointer',
          border: '1px solid var(--green)',
          background: 'linear-gradient(135deg, #164030 0%, var(--green) 100%)',
          fontSize: 13, fontWeight: 800, color: '#fff', letterSpacing: '0.03em',
          boxShadow: '0 2px 12px rgba(80,168,120,0.25)',
          transition: 'all 0.15s',
        }}
          onMouseEnter={e => { e.currentTarget.style.opacity = '0.88' }}
          onMouseLeave={e => { e.currentTarget.style.opacity = '1' }}
        >
          ▶ Start Agent
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
