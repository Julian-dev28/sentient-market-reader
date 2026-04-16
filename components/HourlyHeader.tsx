'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

interface HourlyHeaderProps {
  cycleId: number
  isRunning: boolean
  lastCompletedAt?: string
  onRunCycle?: () => void
}

export default function HourlyHeader({ cycleId, isRunning, lastCompletedAt, onRunCycle }: HourlyHeaderProps) {
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

  const stale = dataAgeSec !== null && dataAgeSec >= 3600   // >1h (whole window)
  const aging = dataAgeSec !== null && dataAgeSec >= 1800   // >30 min
  function fmtAge(s: number) {
    const m = Math.floor(s / 60)
    return m > 0 ? `${m}m ${s % 60}s` : `${s}s`
  }

  return (
    <header style={{
      borderBottom: '1px solid rgba(224,111,160,0.2)',
      padding: '10px 24px',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      background: 'var(--bg-card)',
      position: 'sticky', top: 0, zIndex: 100,
    }}>
      {/* Pink top accent line */}
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2, background: 'var(--pink)', opacity: 0.6 }} />

      {/* Brand */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, letterSpacing: '-0.03em', lineHeight: 1.15, color: 'var(--text-primary)' }}>
              Sentient <span style={{ color: 'var(--pink)' }}>HOURLY</span>
            </div>
            <div style={{ fontSize: 9, color: 'var(--text-muted)', letterSpacing: '0.06em', textTransform: 'uppercase', marginTop: 1 }}>
              Grok Price Prediction · Kalshi KXBTCD
            </div>
          </div>
        </div>

        <div style={{ height: 22, width: 1, background: 'var(--border)', margin: '0 2px' }} />

        {/* Mode tabs */}
        <Link href="/dashboard" style={{
          fontSize: 11, fontWeight: 500,
          padding: '4px 12px', borderRadius: 7, textDecoration: 'none',
          background: 'transparent',
          color: 'var(--text-muted)',
          transition: 'all 0.15s',
          border: 'none',
        }}>
          15m
        </Link>
        <div style={{
          fontSize: 11, fontWeight: 700,
          padding: '4px 12px', borderRadius: 7,
          background: 'rgba(224,111,160,0.12)',
          border: '1px solid rgba(224,111,160,0.3)',
          color: 'var(--pink)',
        }}>
          ◷ 1h
        </div>

        <div style={{ height: 22, width: 1, background: 'var(--border)', margin: '0 2px' }} />

        {/* Page nav */}
        {(['/agent'] as const).map((href) => {
          const active = pathname === href
          return (
            <Link key={href} href={href} style={{
              fontSize: 11, fontWeight: active ? 700 : 500,
              padding: '4px 12px', borderRadius: 7, textDecoration: 'none',
              background: active ? 'var(--bg-secondary)' : 'transparent',
              color: active ? 'var(--text-primary)' : 'var(--text-muted)',
              transition: 'all 0.15s',
            }}>
              Agent
            </Link>
          )
        })}

        <div style={{ height: 22, width: 1, background: 'var(--border)', margin: '0 2px' }} />

        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', letterSpacing: '0.03em' }}>KXBTCD</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, fontWeight: 600, color: 'var(--pink)' }}>
            <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--pink)', display: 'inline-block', animation: 'pulse-live 2s ease-in-out infinite' }} />
            Live · 1h BTC
          </span>
        </div>
      </div>

      {/* Right controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        {/* Cycle badge */}
        <div style={{ padding: '5px 12px', borderRadius: 9, background: 'rgba(224,111,160,0.08)', border: '1px solid rgba(224,111,160,0.2)' }}>
          <div style={{ fontSize: 9, color: 'var(--text-muted)', lineHeight: 1, marginBottom: 2 }}>Cycle</div>
          <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 14, fontWeight: 800, color: 'var(--pink)' }}>#{cycleId}</div>
        </div>

        {/* Data age badge */}
        {!isRunning && dataAgeSec !== null && (aging || stale) && (
          <button onClick={onRunCycle} title="Data is stale — click to re-run" style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 8, cursor: onRunCycle ? 'pointer' : 'default', border: `1px solid ${stale ? 'rgba(212,85,130,0.5)' : 'rgba(212,135,44,0.4)'}`, background: stale ? 'rgba(212,85,130,0.08)' : 'rgba(212,135,44,0.08)', transition: 'all 0.3s' }}>
            <span style={{ fontSize: 10, color: stale ? 'var(--pink)' : 'var(--amber)' }}>{stale ? '⚠' : '◷'}</span>
            <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 10, fontWeight: 700, color: stale ? 'var(--pink)' : 'var(--amber)', whiteSpace: 'nowrap' }}>{fmtAge(dataAgeSec)} old</span>
            {onRunCycle && <span style={{ fontSize: 9, color: stale ? 'var(--pink)' : 'var(--amber)', opacity: 0.7 }}>· re-run</span>}
          </button>
        )}

        {/* Live clock */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span className="status-dot live" style={{ background: 'var(--pink)' }} />
          <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 11, color: 'var(--text-secondary)' }}>{time}</span>
        </div>

        {/* Settings */}
        <Link href="/settings" title="Settings" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 30, borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-muted)', textDecoration: 'none', fontSize: 15, transition: 'all 0.15s' }}>
          ⚙
        </Link>
      </div>
    </header>
  )
}
