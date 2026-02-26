'use client'

import { useEffect, useState } from 'react'

interface HeaderProps {
  cycleId: number
  isRunning: boolean
  nextCycleIn: number
  liveMode: boolean
  onToggleLive: () => void
}

/** SVG ring showing fraction of next-cycle countdown remaining */
function CycleRing({ seconds, total = 300, running }: { seconds: number; total?: number; running: boolean }) {
  const r    = 14
  const circ = 2 * Math.PI * r
  const frac = running ? 1 : Math.max(0, Math.min(1, seconds / total))
  const offset = circ * (1 - frac)

  return (
    <svg width={36} height={36} style={{ transform: 'rotate(-90deg)', flexShrink: 0 }}>
      <circle cx={18} cy={18} r={r} fill="none" stroke="var(--border)" strokeWidth={2.5} />
      <circle
        cx={18} cy={18} r={r} fill="none"
        stroke={running ? 'var(--pink)' : frac < 0.25 ? 'var(--amber)' : 'var(--green)'}
        strokeWidth={2.5}
        strokeDasharray={circ}
        strokeDashoffset={running ? 0 : offset}
        strokeLinecap="round"
        style={{ transition: 'stroke-dashoffset 1s linear, stroke 0.4s ease' }}
      />
    </svg>
  )
}

export default function Header({ cycleId, isRunning, nextCycleIn, liveMode, onToggleLive }: HeaderProps) {
  const [time, setTime] = useState('')

  useEffect(() => {
    const update = () => setTime(
      new Date().toLocaleTimeString('en-US', {
        hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'UTC',
      }) + ' UTC'
    )
    update()
    const id = setInterval(update, 1000)
    return () => clearInterval(id)
  }, [])

  return (
    <header style={{
      borderBottom: '1px solid var(--border)',
      padding: '10px 24px',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      background: 'rgba(253,248,243,0.90)',
      backdropFilter: 'blur(20px)',
      WebkitBackdropFilter: 'blur(20px)',
      position: 'sticky', top: 0, zIndex: 100,
    }}>
      {/* Brand */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, letterSpacing: '-0.03em', lineHeight: 1.15, color: 'var(--text-primary)' }}>
              Sentient <span style={{ color: 'var(--blue)' }}>ROMA</span>
            </div>
            <div style={{ fontSize: 9, color: 'var(--text-muted)', letterSpacing: '0.06em', textTransform: 'uppercase', marginTop: 1 }}>
              Multi-Agent Pipeline · Kalshi KXBTC15M
            </div>
          </div>
        </div>

        <div style={{ height: 22, width: 1, background: 'var(--border)', margin: '0 2px' }} />

        <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
          <span className="pill pill-brown">KXBTC15M</span>
          <span className={`pill ${liveMode ? 'pill-pink' : 'pill-cream'}`} style={{ transition: 'all 0.3s ease' }}>
            {liveMode ? '● LIVE' : 'PAPER'}
          </span>
          <span className="pill pill-green">15-MIN BTC</span>
        </div>
      </div>

      {/* Right controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>

        {/* Live / Paper toggle */}
        <button
          onClick={onToggleLive}
          title={liveMode ? 'Switch to paper trading' : 'Switch to live trading — real Kalshi orders'}
          style={{
            display: 'flex', alignItems: 'center', gap: 7,
            padding: '5px 12px', borderRadius: 9, cursor: 'pointer',
            border: liveMode ? '1px solid var(--green-dark)' : '1px solid var(--border-bright)',
            background: liveMode ? 'var(--green-pale)' : 'var(--cream)',
            transition: 'all 0.25s ease',
          }}
        >
          <div style={{
            width: 28, height: 15, borderRadius: 8,
            background: liveMode ? 'var(--green)' : 'var(--border-bright)',
            position: 'relative', transition: 'background 0.25s', flexShrink: 0,
          }}>
            <div style={{
              position: 'absolute', top: 2,
              left: liveMode ? 15 : 2,
              width: 11, height: 11, borderRadius: '50%',
              background: '#fff',
              transition: 'left 0.25s cubic-bezier(0.34,1.56,0.64,1)',
              boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
            }} />
          </div>
          <span style={{ fontSize: 10, fontWeight: 700, color: liveMode ? 'var(--green-dark)' : 'var(--text-muted)', whiteSpace: 'nowrap' }}>
            {liveMode ? 'LIVE' : 'PAPER'}
          </span>
        </button>

        {/* Cycle ring + label */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <CycleRing seconds={nextCycleIn} running={isRunning} />
            <div style={{
              position: 'absolute',
              fontFamily: 'var(--font-geist-mono)', fontSize: 8, fontWeight: 800,
              color: isRunning ? 'var(--pink)' : 'var(--text-secondary)',
              transition: 'color 0.3s',
            }}>
              {isRunning ? (
                <span style={{ animation: 'pulse-dot 0.7s ease infinite', display: 'inline-block' }}>●</span>
              ) : nextCycleIn}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 9, color: 'var(--text-muted)', lineHeight: 1 }}>
              {isRunning ? 'Running' : 'Next cycle'}
            </div>
            <div style={{ fontSize: 10, fontWeight: 700, color: isRunning ? 'var(--pink)' : 'var(--text-secondary)', lineHeight: 1.4 }}>
              {isRunning ? 'ACTIVE' : `${nextCycleIn}s`}
            </div>
          </div>
        </div>

        {/* Cycle badge */}
        <div style={{
          padding: '5px 12px', borderRadius: 9,
          background: 'var(--brown-pale)',
          border: '1px solid var(--border-bright)',
        }}>
          <div style={{ fontSize: 9, color: 'var(--text-muted)', lineHeight: 1, marginBottom: 2 }}>Cycle</div>
          <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 14, fontWeight: 800, color: 'var(--brown)' }}>
            #{cycleId}
          </div>
        </div>

        {/* Live clock */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span className="status-dot live" />
          <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 11, color: 'var(--text-secondary)' }}>
            {time}
          </span>
        </div>
      </div>
    </header>
  )
}
