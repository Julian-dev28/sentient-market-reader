'use client'

import { useEffect, useState } from 'react'

interface HeaderProps {
  cycleId: number
  isRunning: boolean
  nextCycleIn: number
  liveMode: boolean
  onToggleLive: () => void
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
      padding: '11px 24px',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      background: 'rgba(253,248,243,0.88)',
      backdropFilter: 'blur(18px)',
      WebkitBackdropFilter: 'blur(18px)',
      position: 'sticky', top: 0, zIndex: 100,
    }}>
      {/* Brand */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 34, height: 34, borderRadius: 10,
            background: 'linear-gradient(135deg, var(--brown) 0%, var(--pink) 55%, var(--green) 100%)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 16, fontWeight: 800, color: '#fff',
            boxShadow: '0 2px 10px rgba(155,118,83,0.3)',
            flexShrink: 0,
          }}>S</div>
          <div>
            <div style={{ fontSize: 15, fontWeight: 800, letterSpacing: '-0.02em', lineHeight: 1.15 }}>
              <span style={{ color: 'var(--text-primary)' }}>Sentient </span>
              <span className="grad-brown-pink">ROMA</span>
            </div>
            <div style={{ fontSize: 9, color: 'var(--text-muted)', letterSpacing: '0.09em', textTransform: 'uppercase', marginTop: 1 }}>
              ROMA Multi-Agent · Kalshi Algotrader
            </div>
          </div>
        </div>

        <div style={{ height: 22, width: 1, background: 'var(--border)', margin: '0 2px' }} />

        <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
          <span className="pill pill-brown">KXBTC15M</span>
          <span className={`pill ${liveMode ? 'pill-pink' : 'pill-cream'}`}>
            {liveMode ? '● LIVE TRADING' : 'PAPER TRADING'}
          </span>
          <span className="pill pill-green">15-MIN BTC</span>
        </div>
      </div>

      {/* Right */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>

        {/* Live / Paper toggle */}
        <button
          onClick={onToggleLive}
          title={liveMode ? 'Switch to paper trading' : 'Switch to live trading — real Kalshi orders'}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '5px 12px', borderRadius: 9, cursor: 'pointer',
            border: liveMode ? '1px solid var(--green-dark)' : '1px solid var(--border-bright)',
            background: liveMode ? 'var(--green-pale)' : 'var(--cream)',
            transition: 'all 0.2s',
          }}
        >
          <div style={{
            width: 28, height: 15, borderRadius: 8,
            background: liveMode ? 'var(--green)' : 'var(--border-bright)',
            position: 'relative', transition: 'background 0.2s', flexShrink: 0,
          }}>
            <div style={{
              position: 'absolute', top: 2,
              left: liveMode ? 15 : 2,
              width: 11, height: 11, borderRadius: '50%',
              background: '#fff',
              transition: 'left 0.2s',
              boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
            }} />
          </div>
          <span style={{ fontSize: 10, fontWeight: 700, color: liveMode ? 'var(--green-dark)' : 'var(--text-muted)', whiteSpace: 'nowrap' }}>
            {liveMode ? 'LIVE' : 'PAPER'}
          </span>
        </button>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 1 }}>Next cycle</div>
          <div style={{
            fontFamily: 'var(--font-geist-mono)', fontSize: 14, fontWeight: 700,
            color: isRunning ? 'var(--pink)' : 'var(--text-secondary)',
          }}>
            {isRunning
              ? <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}><span className="status-dot running" />RUNNING</span>
              : `${nextCycleIn}s`}
          </div>
        </div>

        <div style={{
          padding: '5px 12px', borderRadius: 9,
          background: 'var(--brown-pale)',
          border: '1px solid var(--border-bright)',
        }}>
          <div style={{ fontSize: 9, color: 'var(--text-muted)' }}>Cycle</div>
          <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 14, fontWeight: 800, color: 'var(--brown)' }}>
            #{cycleId}
          </div>
        </div>

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
