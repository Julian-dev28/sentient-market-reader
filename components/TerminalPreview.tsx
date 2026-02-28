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

// ── Color helpers ────────────────────────────────────────────────────────────
function valueColor(v: string): string {
  if (v === 'ok' || v === 'YES' || v === 'true') return '#1a7a3a'
  if (v === 'offline' || v === 'NO' || v === 'false' || v === 'error') return '#cc2233'
  if (v.startsWith('+')) return '#1a7a3a'
  if (v.startsWith('-') && v.length > 1 && v[1] !== '-') return '#cc2233'
  return '#111111'
}

// ── Build lines from real API data ──────────────────────────────────────────
function buildLines(health: HealthData | null, status: StatusData | null): string[] {
  if (!health && !status) return ['connecting...']

  const ts = new Date().toLocaleTimeString('en-US', { hour12: false })
  const out: string[] = []

  out.push(`health @ ${ts}:`)
  if (!health) {
    out.push('  status:    fetching')
  } else if (health.status === 'offline' || health.status === 'error') {
    out.push('  status:    offline')
  } else {
    out.push(`  status:    ${health.status}`)
    if (health.model) out.push(`  model:     ${health.model}`)
    if (health.sdk)   out.push(`  sdk:       ${health.sdk}`)
  }

  out.push('pipeline:')
  if (!status) {
    out.push('  running:   fetching')
  } else {
    out.push(`  running:   ${status.running}`)
    const a = status.lastAnalysis
    if (a) {
      const t = new Date(a.completedAt).toLocaleTimeString('en-US', { hour12: false })
      out.push(`  completed: ${t}`)
      out.push(`  rec:       ${a.recommendation}`)
      out.push(`  edge:      ${a.edge >= 0 ? '+' : ''}${(a.edge * 100).toFixed(2)}%`)
      out.push(`  pModel:    ${(a.pModel * 100).toFixed(2)}%`)
      out.push(`  pMarket:   ${(a.pMarket * 100).toFixed(2)}%`)
      out.push(`  btc:       $${a.btcPrice.toLocaleString('en-US', { maximumFractionDigits: 2 })}`)
      out.push(`  strike:    $${a.strikePrice.toLocaleString('en-US', { maximumFractionDigits: 2 })}`)
      out.push(`  sent:      ${a.sentimentScore.toFixed(3)} · ${a.sentimentLabel}`)
    } else {
      out.push('  last:      no data')
    }
  }

  return out
}

// ── Render a single line with key/value coloring ─────────────────────────────
function LineContent({ text }: { text: string }) {
  const trimmed = text.trimStart()
  const indent  = text.slice(0, text.length - trimmed.length)

  // Section header (no indent, ends with : or contains @)
  if (!indent) {
    return <span style={{ color: '#1a4fa0', fontWeight: 700 }}>{text}</span>
  }

  const sep = trimmed.indexOf(': ')
  if (sep > 0) {
    const key = trimmed.slice(0, sep + 1)
    const val = trimmed.slice(sep + 2)
    return (
      <>
        <span style={{ color: '#888888' }}>{indent}{key} </span>
        <span style={{ color: valueColor(val), fontWeight: 600 }}>{val}</span>
      </>
    )
  }

  return <span style={{ color: '#555' }}>{text}</span>
}

// ── Partial line while typing (color transitions at ': ') ────────────────────
function TypingLine({ text }: { text: string }) {
  const trimmed = text.trimStart()
  const indent  = text.slice(0, text.length - trimmed.length)

  if (!indent) {
    return <span style={{ color: '#1a4fa0', fontWeight: 700 }}>{text}</span>
  }

  const sep = trimmed.indexOf(': ')
  if (sep > 0) {
    const key = trimmed.slice(0, sep + 1)
    const val = trimmed.slice(sep + 2)
    return (
      <>
        <span style={{ color: '#888888' }}>{indent}{key} </span>
        <span style={{ color: valueColor(val) || '#111' }}>{val}</span>
      </>
    )
  }

  return <span style={{ color: '#888888' }}>{text}</span>
}

// ── Main component ───────────────────────────────────────────────────────────
interface Props { isRunning: boolean }

export default function TerminalPreview({ isRunning: _isRunning }: Props) {
  const [health, setHealth] = useState<HealthData | null>(null)
  const [status, setStatus] = useState<StatusData | null>(null)

  useEffect(() => {
    async function fetchAll() {
      const [h, s] = await Promise.all([
        fetch('/api/python-health',   { cache: 'no-store' }).then(r => r.json()).catch(() => ({ status: 'offline' })),
        fetch('/api/pipeline/status', { cache: 'no-store' }).then(r => r.json()).catch(() => null),
      ])
      setHealth(h)
      setStatus(s)
    }
    fetchAll()
    const id = setInterval(fetchAll, 12_000)
    return () => clearInterval(id)
  }, [])

  const lines = buildLines(health, status)
  const linesRef = useRef(lines)
  linesRef.current = lines

  const [displayLines, setDisplayLines] = useState<string[]>([])
  const [currentLine, setCurrentLine]   = useState('')
  const stateRef = useRef({ li: 0, ci: 0, pausing: false })

  // Reset + retype whenever fresh data arrives
  useEffect(() => {
    stateRef.current = { li: 0, ci: 0, pausing: false }
    setDisplayLines([])
    setCurrentLine('')
  }, [health, status])

  // Typewriter tick
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
        }, 8000)
        return
      }
      const target = ls[s.li]
      if (s.ci < target.length) {
        s.ci++
        setCurrentLine(target.slice(0, s.ci))
      } else {
        setDisplayLines(prev => [...prev, target])
        setCurrentLine('')
        s.li++
        s.ci = 0
        s.pausing = true
        setTimeout(() => { s.pausing = false }, 120)
      }
    }, 55)
    return () => clearInterval(id)
  }, [])

  const serviceOk = health?.status === 'ok'
  const scrollRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to bottom as lines come in
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [displayLines, currentLine])

  return (
    <div style={{
      borderRadius: 12,
      background: '#ffffff',
      border: '1px solid var(--border)',
      overflow: 'hidden',
      boxShadow: '0 1px 8px rgba(0,0,0,0.07)',
    }}>
      {/* Header */}
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

      {/* Body */}
      <div ref={scrollRef} style={{
        padding: '12px 16px 14px',
        height: 160,
        overflowY: 'auto',
        background: '#ffffff',
        display: 'flex', flexDirection: 'column',
        scrollbarWidth: 'none',
      }}>
        {displayLines.map((line, i) => (
          <div key={`${i}-${line.slice(0, 12)}`} style={{
            fontFamily: 'var(--font-geist-mono)',
            fontSize: 11.5, lineHeight: 1.72,
          }}>
            <LineContent text={line} />
          </div>
        ))}

        {/* Currently typing line */}
        <div style={{
          fontFamily: 'var(--font-geist-mono)',
          fontSize: 11.5, lineHeight: 1.72,
          minHeight: '1.72em',
        }}>
          <TypingLine text={currentLine} />
          <span style={{ animation: 'blink 0.9s step-end infinite', color: '#1a4fa0', marginLeft: 1 }}>▌</span>
        </div>
      </div>
    </div>
  )
}
