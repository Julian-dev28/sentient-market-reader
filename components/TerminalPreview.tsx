'use client'

import { useState, useEffect, useRef } from 'react'

const MODEL_MAP: Record<string, string> = {
  blitz: 'grok-4-1-fast',
  sharp: 'grok-3-mini-fast',
  keen:  'grok-3',
  smart: 'grok-4-0709',
}
const SENT_MODE_MAP: Record<string, string> = {
  blitz: 'blitz', sharp: 'sharp', keen: 'sharp', smart: 'keen',
}

function lineColor(line: string): string {
  if (line.startsWith('$'))    return '#8ab4cf'  // blue prompt
  if (line.startsWith('[✓]'))  return '#74b896'  // green success
  if (line.startsWith('[→]'))  return '#c9a870'  // amber info
  if (line.startsWith('[◉]'))  return '#e06fa0'  // pink active
  if (line.startsWith('[○]'))  return 'rgba(255,255,255,0.38)'
  return 'rgba(255,255,255,0.45)'
}

interface Props {
  romaMode: string
  sentMode?: string
  probMode?: string
  isRunning: boolean
}

export default function TerminalPreview({ romaMode, sentMode, probMode, isRunning }: Props) {
  const effectiveSent = sentMode ?? SENT_MODE_MAP[romaMode] ?? romaMode
  const effectiveProb = probMode ?? romaMode

  // Recomputed each render — linesRef always reflects latest props
  const lines = [
    `$ sentient init --mode ${romaMode}`,
    `[✓] roma-dspy · framework ready`,
    `[✓] sent  ·  ${MODEL_MAP[effectiveSent] ?? effectiveSent}`,
    `[✓] prob  ·  ${MODEL_MAP[effectiveProb] ?? effectiveProb}`,
    `[→] atomize → plan → exec×N → aggregate → extract`,
    `[→] kalshi KXBTC15M · BTC/USD · 15-min window`,
    isRunning ? `[◉] pipeline active · solving...` : `[○] standby · run cycle to begin`,
  ]

  const linesRef = useRef(lines)
  linesRef.current = lines

  const [displayLines, setDisplayLines] = useState<string[]>([])
  const [currentLine, setCurrentLine]   = useState('')
  const stateRef = useRef({ li: 0, ci: 0, pausing: false })

  // Reset typewriter on config change (not on isRunning)
  const resetKey = `${romaMode}|${sentMode ?? ''}|${probMode ?? ''}`
  useEffect(() => {
    stateRef.current = { li: 0, ci: 0, pausing: false }
    setDisplayLines([])
    setCurrentLine('')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey])

  // Typewriter tick — mounted once, lives for component lifetime
  useEffect(() => {
    const id = setInterval(() => {
      const s = stateRef.current
      if (s.pausing) return

      const ls = linesRef.current
      if (s.li >= ls.length) {
        // All done — pause then loop
        s.pausing = true
        setTimeout(() => {
          stateRef.current = { li: 0, ci: 0, pausing: false }
          setDisplayLines([])
          setCurrentLine('')
        }, 3400)
        return
      }

      const target = ls[s.li]
      if (s.ci < target.length) {
        s.ci++
        setCurrentLine(target.slice(0, s.ci))
      } else {
        // Line complete — commit and advance
        setDisplayLines(prev => [...prev, target].slice(-6))
        setCurrentLine('')
        s.li++
        s.ci = 0
        s.pausing = true
        setTimeout(() => { s.pausing = false }, 155)
      }
    }, 28)

    return () => clearInterval(id)
  }, []) // mount once

  return (
    <div style={{
      borderRadius: 14,
      background: 'linear-gradient(160deg, rgba(18,14,10,0.97) 0%, rgba(26,20,14,0.95) 100%)',
      border: '1px solid rgba(139,111,71,0.2)',
      overflow: 'hidden',
      boxShadow: '0 2px 24px rgba(0,0,0,0.18), inset 0 1px 0 rgba(255,255,255,0.04)',
      position: 'relative',
    }}>

      {/* Subtle scanline overlay */}
      <div style={{
        position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 0,
        backgroundImage: 'repeating-linear-gradient(0deg, transparent, transparent 3px, rgba(0,0,0,0.028) 3px, rgba(0,0,0,0.028) 4px)',
      }} />

      {/* Header bar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '9px 14px',
        borderBottom: '1px solid rgba(255,255,255,0.055)',
        background: 'rgba(0,0,0,0.22)',
        position: 'relative', zIndex: 1,
      }}>
        {/* macOS traffic lights */}
        <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#ff5f57', display: 'inline-block', flexShrink: 0 }} />
        <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#ffbd2e', display: 'inline-block', flexShrink: 0 }} />
        <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#28c840', display: 'inline-block', flexShrink: 0 }} />

        {/* Title */}
        <span style={{
          flex: 1, textAlign: 'center',
          fontFamily: 'var(--font-geist-mono)', fontSize: 10, fontWeight: 600,
          color: 'rgba(255,255,255,0.28)', letterSpacing: '0.1em', textTransform: 'uppercase',
        }}>
          sentient · roma-dspy · {romaMode}
        </span>

        {/* Status dot */}
        <span style={{
          width: 7, height: 7, borderRadius: '50%', flexShrink: 0, display: 'inline-block',
          background: isRunning ? '#3a9e72' : 'rgba(255,255,255,0.1)',
          boxShadow: isRunning ? '0 0 8px #3a9e72' : 'none',
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
          <div key={`${i}-${line.slice(0, 8)}`} style={{
            fontFamily: 'var(--font-geist-mono)',
            fontSize: 11.5, lineHeight: 1.72,
            color: lineColor(line),
            opacity: Math.max(0.25, 0.25 + (i / Math.max(displayLines.length - 1, 1)) * 0.72),
          }}>
            {line}
          </div>
        ))}

        {/* Current line being typed + blinking cursor */}
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
