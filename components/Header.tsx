'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

interface HeaderProps {
  cycleId: number
  isRunning: boolean
  lastCompletedAt?: string   // ISO timestamp of last pipeline completion
  onRunCycle?: () => void
}

export default function Header({ cycleId, isRunning, lastCompletedAt, onRunCycle }: HeaderProps) {
  const pathname = usePathname()
  const [time, setTime] = useState('')
  const [dataAgeSec, setDataAgeSec] = useState<number | null>(null)

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

  useEffect(() => {
    if (!lastCompletedAt) { setDataAgeSec(null); return }
    const completedAt = new Date(lastCompletedAt).getTime()
    const tick = () => setDataAgeSec(Math.floor((Date.now() - completedAt) / 1000))
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [lastCompletedAt])

  const stale = dataAgeSec !== null && dataAgeSec >= 600   // >10 min
  const aging = dataAgeSec !== null && dataAgeSec >= 300   // >5 min
  function fmtAge(s: number) {
    const m = Math.floor(s / 60)
    return m > 0 ? `${m}m ${s % 60}s` : `${s}s`
  }

  return (
    <header style={{
      borderBottom: '1px solid var(--border)',
      padding: '10px 24px',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      background: 'rgba(5,5,7,0.85)',
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

        {/* Page nav */}
        {(['/dashboard', '/agent'] as const).map((href, i) => {
          const label = i === 0 ? 'Dashboard' : 'Agent'
          const active = pathname === href
          return (
            <Link key={href} href={href} style={{
              fontSize: 11, fontWeight: active ? 800 : 600,
              padding: '3px 10px', borderRadius: 7, textDecoration: 'none',
              border: active ? '1.5px solid var(--blue)' : '1px solid transparent',
              background: active ? 'rgba(74,127,165,0.10)' : 'transparent',
              color: active ? 'var(--blue)' : 'var(--text-muted)',
              transition: 'all 0.15s',
            }}>
              {label}
            </Link>
          )
        })}

        <div style={{ height: 22, width: 1, background: 'var(--border)', margin: '0 2px' }} />

        <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
          <span className="pill pill-brown">KXBTC15M</span>
          <span className="pill pill-green">
            ● LIVE
          </span>
          <span className="pill pill-green">15-MIN BTC</span>
        </div>
      </div>

      {/* Right controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>


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

        {/* Data age badge */}
        {!isRunning && dataAgeSec !== null && (aging || stale) && (
          <button
            onClick={onRunCycle}
            title="Data is stale — click to re-run pipeline"
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '4px 10px', borderRadius: 8, cursor: onRunCycle ? 'pointer' : 'default',
              border: `1px solid ${stale ? 'rgba(212,85,130,0.5)' : 'rgba(212,135,44,0.4)'}`,
              background: stale ? 'rgba(212,85,130,0.08)' : 'rgba(212,135,44,0.08)',
              transition: 'all 0.3s',
            }}
          >
            <span style={{ fontSize: 10, color: stale ? 'var(--pink)' : 'var(--amber)' }}>
              {stale ? '⚠' : '◷'}
            </span>
            <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 10, fontWeight: 700, color: stale ? 'var(--pink)' : 'var(--amber)', whiteSpace: 'nowrap' }}>
              {fmtAge(dataAgeSec)} old
            </span>
            {onRunCycle && (
              <span style={{ fontSize: 9, color: stale ? 'var(--pink)' : 'var(--amber)', opacity: 0.7 }}>· re-run</span>
            )}
          </button>
        )}

        {/* Live clock */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span className="status-dot live" />
          <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 11, color: 'var(--text-secondary)' }}>
            {time}
          </span>
        </div>

        {/* Settings link */}
        <Link
          href="/settings"
          title="Settings"
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: 30, height: 30, borderRadius: 8,
            border: '1px solid var(--border)', background: 'transparent',
            color: 'var(--text-muted)', textDecoration: 'none', fontSize: 15,
            transition: 'all 0.15s',
          }}
          onMouseEnter={e => {
            (e.currentTarget as HTMLAnchorElement).style.borderColor = 'var(--border-bright)'
            ;(e.currentTarget as HTMLAnchorElement).style.color = 'var(--text-secondary)'
          }}
          onMouseLeave={e => {
            (e.currentTarget as HTMLAnchorElement).style.borderColor = 'var(--border)'
            ;(e.currentTarget as HTMLAnchorElement).style.color = 'var(--text-muted)'
          }}
        >
          ⚙
        </Link>
      </div>
    </header>
  )
}
