'use client'

interface BotPanelProps {
  active: boolean
  liveMode: boolean
  isRunning: boolean
  nextCycleIn: number
  lastAction: string | null
  lastSide: 'yes' | 'no' | null
  lastPrice: number | null
  tradeCount: number
  onStart: () => void
  onStop: () => void
}

export default function BotPanel({
  active, liveMode, isRunning, nextCycleIn,
  lastAction, lastSide, lastPrice, tradeCount,
  onStart, onStop,
}: BotPanelProps) {
  const mins = Math.floor(nextCycleIn / 60)
  const secs = Math.floor(nextCycleIn % 60)

  const accentCol = liveMode ? 'var(--green)' : 'var(--amber)'
  const accentDark = liveMode ? 'var(--green-dark)' : '#b87a20'
  const accentPale = liveMode ? 'var(--green-pale)' : 'rgba(212,135,44,0.1)'
  const accentBdr  = liveMode ? '#9ecfb8' : '#d4a060'

  return (
    <div className="card bracket-card" style={{
      padding: '14px 16px',
      border: active ? `1.5px solid ${accentBdr}` : '1px solid var(--border)',
      background: active ? accentPale : 'white',
      transition: 'all 0.3s ease',
    }}>
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <span style={{
            width: 8, height: 8, borderRadius: '50%', flexShrink: 0, display: 'inline-block',
            background: active ? accentCol : 'var(--border)',
            boxShadow: active ? `0 0 6px ${accentCol}` : 'none',
            animation: active ? 'pulse-live 1.5s ease-in-out infinite' : 'none',
          }} />
          <span style={{
            fontSize: 10, fontWeight: 800, letterSpacing: '0.07em', textTransform: 'uppercase',
            color: active ? accentDark : 'var(--text-muted)',
          }}>
            Trade Bot
          </span>
          <span style={{
            fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 4,
            background: active ? (liveMode ? 'var(--green-pale)' : 'rgba(212,135,44,0.15)') : 'var(--bg-secondary)',
            border: `1px solid ${active ? accentBdr : 'var(--border)'}`,
            color: active ? accentDark : 'var(--text-muted)',
          }}>
            {active ? (liveMode ? 'LIVE' : 'PAPER') : 'OFF'}
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

      {/* Start / Stop */}
      {!active ? (
        <button onClick={onStart} style={{
          width: '100%', padding: '12px 0', borderRadius: 9, cursor: 'pointer',
          border: liveMode ? '1px solid var(--green-dark)' : '1px solid var(--brown)',
          background: liveMode
            ? 'linear-gradient(135deg, var(--green-dark) 0%, var(--green) 100%)'
            : 'linear-gradient(135deg, #7a5c32 0%, var(--brown) 100%)',
          fontSize: 13, fontWeight: 800, color: '#fff', letterSpacing: '0.03em',
          boxShadow: liveMode ? '0 2px 12px rgba(74,148,112,0.35)' : '0 2px 8px rgba(139,111,71,0.3)',
          transition: 'all 0.15s',
        }}
          onMouseEnter={e => { e.currentTarget.style.opacity = '0.88' }}
          onMouseLeave={e => { e.currentTarget.style.opacity = '1' }}
        >
          ▶ Start Bot · $100 / trade
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
          ■ Stop Bot
        </button>
      )}

      {/* Last signal */}
      {lastAction && (
        <div style={{
          marginTop: 10, padding: '8px 10px', borderRadius: 8,
          background: 'rgba(255,255,255,0.65)', border: '1px solid var(--border)',
        }}>
          <div style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 3 }}>
            Last signal
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{
              fontFamily: 'var(--font-geist-mono)', fontSize: 12, fontWeight: 800,
              color: lastAction === 'PASS' ? 'var(--text-muted)'
                : lastSide === 'yes' ? 'var(--green)' : 'var(--pink)',
            }}>
              {lastAction === 'PASS' ? '— PASS' : `BUY ${lastSide?.toUpperCase()} @ ${lastPrice}¢`}
            </span>
            {tradeCount > 0 && (
              <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-secondary)' }}>
                {tradeCount} trade{tradeCount !== 1 ? 's' : ''}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Paper mode note */}
      {!liveMode && (
        <div style={{ marginTop: 8, fontSize: 9, color: 'var(--text-muted)', textAlign: 'center', lineHeight: 1.4 }}>
          Paper mode — enable Live Trading to place real orders
        </div>
      )}
    </div>
  )
}
