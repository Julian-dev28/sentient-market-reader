'use client'

import { useEffect, useState } from 'react'
import type { MarkovOutput } from '@/lib/types'
import { STATE_LABELS } from '@/lib/markov/chain'

interface MarkovPanelProps {
  markov: MarkovOutput | null
}

/** Interpolate 0–1 value to a blue→green heatmap color */
function heatColor(v: number): string {
  const clamped = Math.max(0, Math.min(1, v))
  if (clamped < 0.01) return 'transparent'
  // low: slate blue → high: emerald green
  const r = Math.round(58  + (45  - 58)  * clamped)
  const g = Math.round(114 + (158 - 114) * clamped)
  const b = Math.round(168 + (107 - 168) * clamped)
  return `rgba(${r},${g},${b},${0.18 + clamped * 0.72})`
}

/** Short axis labels for the 9-state momentum heatmap */
const AXIS_LABELS = ['<-1.5', '-1.5/-1', '-1/-.5', '-.5/-.2', '±.2', '.2/.5', '.5/1', '1/1.5', '>1.5']

export default function MarkovPanel({ markov }: MarkovPanelProps) {
  const [visible, setVisible] = useState(false)
  useEffect(() => { const id = setTimeout(() => setVisible(true), 80); return () => clearTimeout(id) }, [])

  if (!markov) {
    return (
      <div className="card" style={{ padding: '14px 16px', opacity: 0.5 }}>
        <div style={{ fontSize: 10, fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
          Markov Chain
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>Awaiting first cycle…</div>
      </div>
    )
  }

  const {
    currentState, stateLabel, historyLength,
    pHatYes, pHatNo,
    expectedDriftPct, requiredDriftPct, sigma, zScore,
    jStar, jStarLabel, persist,
    enterYes, enterNo, tau,
    transitionMatrix, numStates,
  } = markov

  const rec         = markov.recommendation ?? 'NO_TRADE'
  const hasSignal   = enterYes || enterNo
  const signalSide  = enterYes ? 'YES' : 'NO'
  const signalColor = enterYes ? 'var(--green-dark)' : enterNo ? 'var(--blue-dark)' : 'var(--text-muted)'
  const signalBg    = enterYes ? 'var(--green-pale)' : enterNo ? 'rgba(58,114,168,0.10)' : 'var(--bg-secondary)'
  const signalBorder = enterYes ? 'rgba(45,158,107,0.35)' : enterNo ? 'rgba(58,114,168,0.35)' : 'var(--border)'

  const persistPct  = (persist * 100).toFixed(1)
  const pYesPct     = (pHatYes * 100).toFixed(1)
  const pNoPct      = (pHatNo  * 100).toFixed(1)
  const expSign     = (expectedDriftPct ?? 0) >= 0 ? '+' : ''
  const reqSign     = (requiredDriftPct ?? 0) >= 0 ? '+' : ''
  const zStr        = (zScore ?? 0).toFixed(2)
  const dirColor    = rec === 'YES' ? 'var(--green-dark)' : rec === 'NO' ? 'var(--blue-dark)' : 'var(--text-muted)'

  return (
    <div
      className="card"
      style={{
        padding: '14px 16px',
        opacity: visible ? 1 : 0,
        transform: visible ? 'none' : 'translateY(6px)',
        transition: 'opacity 0.4s, transform 0.4s',
        border: hasSignal ? `1.5px solid ${signalBorder}` : '1px solid var(--border)',
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div style={{ fontSize: 10, fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
          Markov Chain
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>{historyLength} obs</span>
          <span style={{
            fontSize: 9, fontWeight: 800, padding: '2px 7px', borderRadius: 5,
            background: signalBg, color: signalColor,
            border: `1px solid ${signalBorder}`,
            letterSpacing: '0.06em', textTransform: 'uppercase',
          }}>
            {hasSignal ? `ENTER ${signalSide}` : 'NO ENTRY'}
          </span>
        </div>
      </div>

      {/* Current state indicator */}
      <div style={{
        marginBottom: 10, padding: '7px 10px', borderRadius: 8,
        background: 'var(--bg-secondary)', border: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', gap: 10,
      }}>
        <div>
          <div style={{ fontSize: 8, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 2 }}>Current State</div>
          <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 13, fontWeight: 800, color: 'var(--text-primary)' }}>
            S{currentState} <span style={{ fontSize: 10, fontWeight: 400, color: 'var(--text-secondary)' }}>{stateLabel}</span>
          </div>
        </div>
        <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
          <div style={{ fontSize: 8, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 2 }}>j* next state</div>
          <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)' }}>
            S{jStar} <span style={{ fontSize: 9, fontWeight: 400 }}>{jStarLabel}</span>
          </div>
        </div>
      </div>

      {/* Momentum forecast stats */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6, marginBottom: 10 }}>
        {[
          {
            label: 'Expected drift',
            value: `${expSign}${(expectedDriftPct ?? 0).toFixed(3)}%`,
            sub: `over T minutes`,
            color: (expectedDriftPct ?? 0) >= 0 ? 'var(--green-dark)' : 'var(--blue-dark)',
            bg:    (expectedDriftPct ?? 0) >= 0 ? 'var(--green-pale)' : 'rgba(58,114,168,0.10)',
          },
          {
            label: 'Required drift',
            value: `${reqSign}${(requiredDriftPct ?? 0).toFixed(3)}%`,
            sub: `to end ${rec === 'YES' ? 'above' : 'below'} strike`,
            color: 'var(--text-secondary)',
            bg:    'var(--bg-secondary)',
          },
          {
            label: 'Persist',
            value: `${persistPct}%`,
            sub: `τ = ${(tau * 100).toFixed(0)}%`,
            color: persist >= tau ? 'var(--green-dark)' : 'var(--text-secondary)',
            bg:    persist >= tau ? 'var(--green-pale)'  : 'var(--bg-secondary)',
          },
        ].map(({ label, value, sub, color, bg }) => (
          <div key={label} style={{
            padding: '7px 9px', borderRadius: 8,
            background: bg, border: '1px solid var(--border)',
          }}>
            <div style={{ fontSize: 8, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 2 }}>{label}</div>
            <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 13, fontWeight: 800, color }}>{value}</div>
            <div style={{ fontSize: 8, color: 'var(--text-muted)', marginTop: 1 }}>{sub}</div>
          </div>
        ))}
      </div>

      {/* P(YES/NO) + z-score */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6, marginBottom: 10 }}>
        {[
          { label: 'P(YES)',  value: `${pYesPct}%`,   color: dirColor,               bg: 'var(--bg-secondary)' },
          { label: 'P(NO)',   value: `${pNoPct}%`,     color: 'var(--text-secondary)',bg: 'var(--bg-secondary)' },
          { label: 'Z-score', value: zStr,             color: Math.abs(zScore ?? 0) >= 1 ? dirColor : 'var(--text-secondary)', bg: 'var(--bg-secondary)' },
        ].map(({ label, value, color, bg }) => (
          <div key={label} style={{ padding: '7px 9px', borderRadius: 8, background: bg, border: '1px solid var(--border)' }}>
            <div style={{ fontSize: 8, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 2 }}>{label}</div>
            <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 13, fontWeight: 800, color }}>{value}</div>
          </div>
        ))}
      </div>

      {/* Transition matrix heatmap */}
      <div>
        <div style={{ fontSize: 8, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 5 }}>
          Transition Matrix P — current row highlighted
        </div>

        {/* Column labels */}
        <div style={{ display: 'grid', gridTemplateColumns: `20px repeat(${numStates}, 1fr)`, gap: 1, marginBottom: 2 }}>
          <div />
          {AXIS_LABELS.slice(0, numStates).map((l, j) => (
            <div key={j} style={{
              fontSize: 6, color: j >= 5 ? 'var(--green-dark)' : 'var(--blue-dark)',
              textAlign: 'center', fontWeight: j === jStar ? 800 : 400,
              overflow: 'hidden', whiteSpace: 'nowrap',
            }}>
              {l}
            </div>
          ))}
        </div>

        {/* Matrix rows */}
        {transitionMatrix.map((row, i) => (
          <div
            key={i}
            style={{
              display: 'grid',
              gridTemplateColumns: `20px repeat(${numStates}, 1fr)`,
              gap: 1,
              marginBottom: 1,
              opacity: i === currentState ? 1 : 0.55,
              transform: i === currentState ? 'scaleY(1.15)' : 'none',
              transition: 'opacity 0.3s',
            }}
          >
            {/* Row label */}
            <div style={{
              fontSize: 6, color: i >= 5 ? 'var(--green-dark)' : 'var(--blue-dark)',
              display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
              paddingRight: 2, fontWeight: i === currentState ? 800 : 400,
            }}>
              {AXIS_LABELS[i]}
            </div>
            {/* Cells */}
            {row.map((p, j) => (
              <div
                key={j}
                title={`S${i}→S${j}: ${(p * 100).toFixed(1)}% (${STATE_LABELS[i]} → ${STATE_LABELS[j]})`}
                style={{
                  height: 10,
                  borderRadius: 2,
                  background: heatColor(p),
                  border: i === currentState && j === jStar
                    ? '1px solid rgba(212,135,44,0.8)'
                    : i === currentState
                    ? '1px solid rgba(255,255,255,0.1)'
                    : '1px solid transparent',
                  transition: 'background 0.4s',
                }}
              />
            ))}
          </div>
        ))}

        {/* Legend */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, justifyContent: 'flex-end' }}>
          <div style={{ display: 'flex', gap: 1 }}>
            {[0.05, 0.2, 0.4, 0.7, 1.0].map(v => (
              <div key={v} style={{ width: 12, height: 6, borderRadius: 1, background: heatColor(v) }} />
            ))}
          </div>
          <span style={{ fontSize: 7, color: 'var(--text-muted)' }}>low → high P</span>
          <span style={{ fontSize: 7, color: 'var(--amber)', marginLeft: 4 }}>■ j* cell</span>
        </div>
      </div>
    </div>
  )
}
