'use client'

import { useState, useEffect, useRef } from 'react'

interface HealthData {
  status: string
  provider?: string
  model?: string
  sdk?: string
  error?: string
}
interface LastAnalysis {
  pModel: number
  pMarket: number
  edge: number
  recommendation: string
  sentimentScore: number
  sentimentLabel: string
  btcPrice: number
  strikePrice: number
  completedAt: string
}
interface StatusData {
  running: boolean
  lastAnalysis: LastAnalysis | null
}

function lineColor(line: string): string {
  if (line.startsWith('$'))    return '#8ab4cf'
  if (line.startsWith('[✓]'))  return '#74b896'
  if (line.startsWith('[→]'))  return '#c9a870'
  if (line.startsWith('[◉]'))  return '#e06fa0'
  if (line.startsWith('[✗]'))  return '#e06fa0'
  return 'rgba(255,255,255,0.38)'
}

function buildLines(
  health: HealthData | null,
  status: StatusData | null,
  isRunning: boolean,
): string[] {
  const out: string[] = []

  out.push('$ sentient health --all')

  if (health === null) {
    out.push('[→] connecting to python service...')
  } else if (health.status === 'offline' || health.status === 'error') {
    out.push('[✗] python service offline')
    if (health.error) out.push(`[→] ${health.error.slice(0, 48)}`)
  } else {
    out.push(`[✓] ${health.sdk ?? 'roma-dspy'} · status: ${health.status}`)
    if (health.model)    out.push(`[✓] model: ${health.model}`)
    if (health.provider) out.push(`[✓] provider: ${health.provider}`)
  }

  if (status) {
    out.push(isRunning ? '[◉] pipeline: running' : '[○] pipeline: idle')
    const a = status.lastAnalysis
    if (a) {
      const t = new Date(a.completedAt).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' })
      const edge = `${a.edge >= 0 ? '+' : ''}${(a.edge * 100).toFixed(1)}%`
      out.push(`[→] last ${t} · rec: ${a.recommendation} · edge ${edge}`)
      out.push(`[→] pModel ${(a.pModel * 100).toFixed(1)}% · pMkt ${(a.pMarket * 100).toFixed(1)}%`)
      const btc    = `$${a.btcPrice.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
      const strike = `$${a.strikePrice.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
      out.push(`[→] btc ${btc} · strike ${strike}`)
    } else {
      out.push('[○] no previous analysis found')
    }
  }

  return out
}

interface Props {
  isRunning: boolean
}

export default function TerminalPreview({ isRunning }: Props) {
  const [health, setHealth] = useState<HealthData | null>(null)
  const [status, setStatus] = useState<StatusData | null>(null)

  // Fetch both endpoints; refresh every 12s
  useEffect(() => {
    async function fetchAll() {
      const [h, s] = await Promise.all([
        fetch('/api/python-health', { cache: 'no-store' }).then(r => r.json()).catch(() => ({ status: 'offline' })),
        fetch('/api/pipeline/status', { cache: 'no-store' }).then(r => r.json()).catch(() => null),
      ])
      setHealth(h)
      setStatus(s)
    }
    fetchAll()
    const id = setInterval(fetchAll, 12_000)
    return () => clearInterval(id)
  }, [])

  const lines = buildLines(health, status, isRunning)
  const linesRef = useRef(lines)
  linesRef.current = lines

  const [displayLines, setDisplayLines] = useState<string[]>([])
  const [currentLine, setCurrentLine]   = useState('')
  const stateRef = useRef({ li: 0, ci: 0, pausing: false })

  // Reset typewriter when fresh data arrives
  useEffect(() => {
    stateRef.current = { li: 0, ci: 0, pausing: false }
    setDisplayLines([])
    setCurrentLine('')
  }, [health, status])

  // Typewriter tick — mounted once
  useEffect(() => {
    const id = setInterval(() => {
      const s = stateRef.current
      if (s.pausing) return

      const ls = linesRef.current
      if (s.li >= ls.length) {
        s.pausing = true
        setTimeout(() => {
          stateRef.current = { li: 0, ci: 0, pausing: false }
          setDisplayLines([])
          setCurrentLine('')
        }, 4000)
        return
      }

      const target = ls[s.li]
      if (s.ci < target.length) {
        s.ci++
        setCurrentLine(target.slice(0, s.ci))
      } else {
        setDisplayLines(prev => [...prev, target].slice(-7))
        setCurrentLine('')
        s.li++
        s.ci = 0
        s.pausing = true
        setTimeout(() => { s.pausing = false }, 140)
      }
    }, 26)

    return () => clearInterval(id)
  }, [])

  const serviceOk = health?.status === 'ok'

  return (
    <div style={{
      borderRadius: 14,
      background: 'linear-gradient(160deg, rgba(18,14,10,0.97) 0%, rgba(26,20,14,0.95) 100%)',
      border: '1px solid rgba(139,111,71,0.2)',
      overflow: 'hidden',
      boxShadow: '0 2px 24px rgba(0,0,0,0.18), inset 0 1px 0 rgba(255,255,255,0.04)',
      position: 'relative',
    }}>

      {/* Scanline overlay */}
      <div style={{
        position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 0,
        backgroundImage: 'repeating-linear-gradient(0deg, transparent, transparent 3px, rgba(0,0,0,0.028) 3px, rgba(0,0,0,0.028) 4px)',
      }} />

      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '9px 14px',
        borderBottom: '1px solid rgba(255,255,255,0.055)',
        background: 'rgba(0,0,0,0.22)',
        position: 'relative', zIndex: 1,
      }}>
        <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#ff5f57', display: 'inline-block', flexShrink: 0 }} />
        <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#ffbd2e', display: 'inline-block', flexShrink: 0 }} />
        <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#28c840', display: 'inline-block', flexShrink: 0 }} />
        <span style={{
          flex: 1, textAlign: 'center',
          fontFamily: 'var(--font-geist-mono)', fontSize: 10, fontWeight: 600,
          color: 'rgba(255,255,255,0.28)', letterSpacing: '0.1em', textTransform: 'uppercase',
        }}>
          sentient · roma-dspy
        </span>
        {/* Service status dot */}
        <span style={{
          width: 7, height: 7, borderRadius: '50%', flexShrink: 0, display: 'inline-block',
          background: health === null ? 'rgba(255,255,255,0.1)' : serviceOk ? '#3a9e72' : '#e06fa0',
          boxShadow: serviceOk ? '0 0 8px #3a9e72' : health && !serviceOk ? '0 0 8px #e06fa0' : 'none',
          transition: 'background 0.4s, box-shadow 0.4s',
        }} />
      </div>

      {/* Terminal body */}
      <div style={{
        padding: '12px 16px 14px',
        height: 148,
        overflow: 'hidden',
        position: 'relative', zIndex: 1,
        display: 'flex', flexDirection: 'column', justifyContent: 'flex-end',
      }}>
        {displayLines.map((line, i) => (
          <div key={`${i}-${line.slice(0, 10)}`} style={{
            fontFamily: 'var(--font-geist-mono)',
            fontSize: 11.5, lineHeight: 1.72,
            color: lineColor(line),
            opacity: Math.max(0.22, 0.22 + (i / Math.max(displayLines.length - 1, 1)) * 0.75),
          }}>
            {line}
          </div>
        ))}
        <div style={{
          fontFamily: 'var(--font-geist-mono)',
          fontSize: 11.5, lineHeight: 1.72,
          color: lineColor(currentLine.length > 0 ? currentLine : '$'),
          minHeight: '1.72em',
        }}>
          {currentLine}
          <span style={{ animation: 'blink 0.9s step-end infinite', color: '#8ab4cf', marginLeft: 1 }}>▌</span>
        </div>
      </div>
    </div>
  )
}
