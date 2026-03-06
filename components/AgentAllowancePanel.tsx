'use client'

import { useState } from 'react'

interface AgentAllowancePanelProps {
  active: boolean
  liveMode: boolean
  isRunning: boolean
  allowance: number
  nextCycleIn: number
  windowKey: string | null
  windowBetPlaced: boolean
  onStart: () => void
  onStop: () => void
  onSetAllowance: (amount: number) => void
  onRunCycle: () => void
}

export default function AgentAllowancePanel({
  active, liveMode, isRunning, allowance, nextCycleIn,
  windowKey, windowBetPlaced, onStart, onStop, onSetAllowance, onRunCycle,
}: AgentAllowancePanelProps) {
  const [editing, setEditing] = useState(false)
  const [editVal, setEditVal] = useState('')

  const mins = Math.floor(nextCycleIn / 60)
  const secs = Math.floor(nextCycleIn % 60)

  const accentCol  = active && liveMode ? 'var(--green)'     : 'var(--blue)'
  const accentDark = active && liveMode ? 'var(--green-dark)' : '#2e5f82'
  const accentPale = active && liveMode ? 'var(--green-pale)' : 'rgba(74,127,165,0.08)'
  const accentBdr  = active && liveMode ? '#9ecfb8'           : '#8ab4cf'


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
            background: active && liveMode ? 'var(--green-pale)' : 'rgba(74,127,165,0.12)',
            border: `1px solid ${accentBdr}`,
            color: active ? accentDark : 'var(--blue)',
          }}>
            {active ? (liveMode ? 'LIVE' : 'PAPER') : 'IDLE'}
          </span>
        </div>
        {active && (
          <span style={{ fontSize: 9, fontFamily: 'var(--font-geist-mono)', color: 'var(--text-muted)' }}>
            {isRunning
              ? <span style={{ animation: 'spin-slow 1s linear infinite', display: 'inline-block' }}>◌</span>
              : `↻ ${mins}:${String(secs).padStart(2, '0')}`}
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
        <div style={{ marginBottom: 12, padding: '8px 10px', borderRadius: 9, background: 'rgba(255,255,255,0.5)', border: '1px solid var(--border)' }}>
          <div style={{ fontSize: 8, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600, marginBottom: 4 }}>
            Current Window
          </div>
          <div style={{ fontSize: 9, fontFamily: 'var(--font-geist-mono)', color: 'var(--text-secondary)', marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {windowKey}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <div style={{ width: 6, height: 6, borderRadius: '50%', background: windowBetPlaced ? 'var(--green)' : 'var(--amber)', flexShrink: 0 }} />
            <span style={{ fontSize: 9, fontWeight: 700, color: windowBetPlaced ? 'var(--green-dark)' : 'var(--amber)' }}>
              {windowBetPlaced ? 'Bet placed' : 'Waiting for signal'}
            </span>
          </div>
        </div>
      )}

      {/* Start / Stop */}
      {!active ? (
        <button onClick={onStart} style={{
          width: '100%', padding: '12px 0', borderRadius: 9, cursor: 'pointer',
          border: '1px solid #2e5f82',
          background: 'linear-gradient(135deg, #2e5f82 0%, var(--blue) 100%)',
          fontSize: 13, fontWeight: 800, color: '#fff', letterSpacing: '0.03em',
          boxShadow: '0 2px 12px rgba(74,127,165,0.35)',
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
          border: '1px solid #b5687a', background: 'rgba(181,104,122,0.08)',
          fontSize: 13, fontWeight: 800, color: '#b5687a', letterSpacing: '0.03em',
          transition: 'all 0.15s',
        }}
          onMouseEnter={e => { e.currentTarget.style.background = '#b5687a'; e.currentTarget.style.color = '#fff' }}
          onMouseLeave={e => { e.currentTarget.style.background = 'rgba(181,104,122,0.08)'; e.currentTarget.style.color = '#b5687a' }}
        >
          ■ Stop Agent
        </button>
      )}

      {!liveMode && (
        <div style={{ marginTop: 8, fontSize: 10, color: 'var(--red)', textAlign: 'center', lineHeight: 1.5, fontWeight: 700, background: 'var(--red-pale)', padding: '6px 10px', borderRadius: 7, border: '1px solid var(--red)' }}>
          ⚠ Enable Live Trading — agent will not place orders in paper mode
        </div>
      )}
    </div>
  )
}
