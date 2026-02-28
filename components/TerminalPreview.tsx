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
  if (line.startsWith('$'))    return '#1a4fa0'   // blue prompt
  if (line.startsWith('[✓]'))  return '#1a7a3a'   // dark green
  if (line.startsWith('[→]'))  return '#222222'   // near-black info
  if (line.startsWith('[◉]'))  return '#cc2233'   // red active
  if (line.startsWith('[✗]'))  return '#cc2233'   // red error
  return '#555555'
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
      borderRadius: 12,
      background: '#ffffff',
      border: '1px solid var(--border)',
      overflow: 'hidden',
      boxShadow: '0 1px 8px rgba(0,0,0,0.07)',
    }}>

      {/* Header — no window buttons, just title + status */}
      <div style={{
        display: 'flex', alignItems: 'center',
        padding: '7px 14px',
        borderBottom: '1px solid var(--border)',
        background: '#f5f5f5',
      }}>
        <span style={{
          flex: 1,
          fontFamily: 'var(--font-geist-mono)', fontSize: 10, fontWeight: 700,
          color: '#333', letterSpacing: '0.08em', textTransform: 'uppercase',
        }}>
          sentient · roma-dspy
        </span>
        {/* Service status dot */}
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 5,
          fontFamily: 'var(--font-geist-mono)', fontSize: 9, fontWeight: 600,
          color: health === null ? '#999' : serviceOk ? '#1a7a3a' : '#cc2233',
        }}>
          <span style={{
            width: 6, height: 6, borderRadius: '50%', display: 'inline-block',
            background: health === null ? '#ccc' : serviceOk ? '#1a7a3a' : '#cc2233',
          }} />
          {health === null ? 'connecting' : serviceOk ? 'online' : 'offline'}
        </span>
      </div>

      {/* Terminal body */}
      <div style={{
        padding: '12px 16px 14px',
        height: 148,
        overflow: 'hidden',
        background: '#ffffff',
        display: 'flex', flexDirection: 'column', justifyContent: 'flex-end',
      }}>
        {displayLines.map((line, i) => (
          <div key={`${i}-${line.slice(0, 10)}`} style={{
            fontFamily: 'var(--font-geist-mono)',
            fontSize: 11.5, lineHeight: 1.72,
            color: lineColor(line),
            opacity: Math.max(0.3, 0.3 + (i / Math.max(displayLines.length - 1, 1)) * 0.7),
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
          <span style={{ animation: 'blink 0.9s step-end infinite', color: '#1a4fa0', marginLeft: 1 }}>▌</span>
        </div>
      </div>
    </div>
  )
}
