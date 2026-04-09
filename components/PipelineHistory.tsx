'use client'

import { useState } from 'react'
import type { PipelineState } from '@/lib/types'

interface Props {
  history: PipelineState[]
}

function fmt(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
}

function duration(state: PipelineState): string {
  if (!state.cycleStartedAt || !state.cycleCompletedAt) return '—'
  const ms = new Date(state.cycleCompletedAt).getTime() - new Date(state.cycleStartedAt).getTime()
  return ms >= 60_000 ? `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s` : `${Math.round(ms / 1000)}s`
}

export default function PipelineHistory({ history }: Props) {
  const [expanded, setExpanded] = useState<number | null>(null)
  const [open, setOpen]         = useState(true)

  if (history.length === 0) return null

  return (
    <div className="card">
      <button
        onClick={() => setOpen(v => !v)}
        style={{
          width: '100%', textAlign: 'left', cursor: 'pointer',
          background: 'transparent', border: 'none', padding: 0,
          marginBottom: open ? 12 : 0,
          display: 'flex', alignItems: 'center', gap: 6,
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)' }}>Cycle History</span>
        <span style={{ marginLeft: 'auto', fontSize: 9, fontWeight: 700, color: 'var(--text-muted)', background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 4, padding: '2px 7px' }}>
          {history.length} cycle{history.length !== 1 ? 's' : ''}
        </span>
        <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>{open ? '▲' : '▼'}</span>
      </button>

      {open && <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {history.map((cycle, idx) => {
          const prob = cycle.agents.probability.output
          const sent = cycle.agents.sentiment.output
          const exec = cycle.agents.execution.output
          const rec  = prob?.recommendation ?? 'NO_TRADE'
          const isOpen = expanded === cycle.cycleId

          const recColor = rec === 'YES' ? 'var(--green-dark)' : rec === 'NO' ? 'var(--blue-dark)' : 'var(--text-muted)'
          const recBg    = rec === 'YES' ? 'var(--green-pale)' : rec === 'NO' ? 'var(--blue-pale)' : 'var(--bg-secondary)'
          const recBdr   = rec === 'YES' ? '#9ecfb8' : rec === 'NO' ? '#a8cce0' : 'var(--border)'
          const recLabel = rec === 'YES' ? 'BUY YES' : rec === 'NO' ? 'BUY NO' : 'PASS'

          return (
            <div
              key={cycle.cycleStartedAt ?? `cycle-${idx}`}
              style={{
                borderRadius: 10,
                border: '1px solid var(--border)',
                background: isOpen ? 'var(--bg-secondary)' : 'transparent',
                overflow: 'hidden',
                transition: 'background 0.15s',
              }}
            >
              {/* Row */}
              <button
                onClick={() => setExpanded(isOpen ? null : cycle.cycleId)}
                style={{
                  width: '100%', textAlign: 'left', cursor: 'pointer',
                  padding: '8px 10px', background: 'transparent', border: 'none',
                  display: 'flex', alignItems: 'center', gap: 8,
                }}
              >
                {/* Time */}
                <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 10, color: 'var(--text-muted)', flexShrink: 0, width: 58 }}>
                  {cycle.cycleCompletedAt ? fmt(cycle.cycleCompletedAt) : '—'}
                </span>

                {/* Cycle ID */}
                <span style={{ fontSize: 9, color: 'var(--text-muted)', flexShrink: 0 }}>#{cycle.cycleId}</span>

                {/* Recommendation pill */}
                <span style={{
                  fontSize: 9, fontWeight: 800, padding: '2px 7px', borderRadius: 4, flexShrink: 0,
                  color: recColor, background: recBg, border: `1px solid ${recBdr}`,
                  letterSpacing: '0.04em',
                }}>
                  {recLabel}
                </span>

                {/* Edge */}
                {prob && (
                  <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 10, fontWeight: 700, color: prob.edgePct >= 0 ? 'var(--green-dark)' : 'var(--pink)', flexShrink: 0 }}>
                    {prob.edgePct >= 0 ? '+' : ''}{prob.edgePct.toFixed(1)}%
                  </span>
                )}

                {/* pModel vs pMarket */}
                {prob && (
                  <span style={{ fontSize: 9, color: 'var(--text-muted)', marginLeft: 'auto', flexShrink: 0 }}>
                    <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>{Math.round(prob.pModel * 100)}%</span>
                    <span style={{ margin: '0 3px' }}>vs</span>
                    <span>{Math.round(prob.pMarket * 100)}¢</span>
                  </span>
                )}

                {/* Expand chevron */}
                <span style={{ fontSize: 9, color: 'var(--text-muted)', flexShrink: 0, marginLeft: prob ? 0 : 'auto' }}>
                  {isOpen ? '▲' : '▼'}
                </span>
              </button>

              {/* Expanded detail */}
              {isOpen && (
                <div style={{ padding: '0 10px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ borderTop: '1px solid var(--border)', marginBottom: 6 }} />

                  {/* Probability row */}
                  {prob && (
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 5 }}>
                      {[
                        ['ROMA', `${Math.round(prob.pModel * 100)}% YES`],
                        ['Market', `${Math.round(prob.pMarket * 100)}¢`],
                        ['Confidence', prob.confidence],
                      ].map(([k, v]) => (
                        <div key={k} style={{ padding: '5px 7px', borderRadius: 7, background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
                          <div style={{ fontSize: 8, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 2 }}>{k}</div>
                          <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 11, fontWeight: 700, color: 'var(--text-primary)' }}>{v}</div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Sentiment + trade */}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 5 }}>
                    {sent && (
                      <div style={{ padding: '5px 7px', borderRadius: 7, background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
                        <div style={{ fontSize: 8, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 2 }}>Sentiment</div>
                        <div style={{ fontSize: 11, fontWeight: 700, color: sent.score > 0.1 ? 'var(--green-dark)' : sent.score < -0.1 ? 'var(--pink)' : 'var(--text-muted)' }}>
                          {sent.score > 0.4 ? 'Bullish' : sent.score > 0.1 ? 'Mild bull' : sent.score < -0.4 ? 'Bearish' : sent.score < -0.1 ? 'Mild bear' : 'Neutral'}
                        </div>
                      </div>
                    )}
                    {exec && exec.action !== 'PASS' && (
                      <div style={{ padding: '5px 7px', borderRadius: 7, background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
                        <div style={{ fontSize: 8, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 2 }}>Entry</div>
                        <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 11, fontWeight: 700, color: 'var(--text-primary)' }}>
                          {exec.contracts}× @ {exec.limitPrice}¢
                        </div>
                      </div>
                    )}
                    <div style={{ padding: '5px 7px', borderRadius: 7, background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
                      <div style={{ fontSize: 8, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 2 }}>Duration</div>
                      <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 11, fontWeight: 700, color: 'var(--text-muted)' }}>{duration(cycle)}</div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>}
    </div>
  )
}
