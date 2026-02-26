'use client'

import { useState, useEffect, useRef } from 'react'
import type { PipelineState, AgentStatus } from '@/lib/types'

// ── ROMA stage definitions ──────────────────────────────────────────────────
const ROMA_STAGES = [
  { id: 'atomize',   label: 'ATOMIZE',    icon: '◎', color: 'var(--brown)',  rgb: '125,112,96',  startAt: 0,  endAt: 7   },
  { id: 'plan',      label: 'PLAN',       icon: '◉', color: 'var(--blue)',   rgb: '74,127,165',  startAt: 7,  endAt: 20  },
  { id: 'execute',   label: 'EXECUTE ×N', icon: '▶', color: 'var(--green)',  rgb: '74,148,112',  startAt: 20, endAt: 76  },
  { id: 'aggregate', label: 'AGGREGATE',  icon: '⬟', color: 'var(--amber)',  rgb: '160,120,64',  startAt: 76, endAt: 93  },
  { id: 'extract',   label: 'EXTRACT',    icon: '◈', color: 'var(--pink)',   rgb: '181,96,112',  startAt: 93, endAt: 999 },
]

const LOG_MESSAGES: [number, string][] = [
  [0,  '› Sending market context to Atomizer'],
  [4,  '› Task complexity — initiating decomposition'],
  [8,  '› Planner mapping market structure'],
  [14, '› Generating 3–5 parallel analysis subtasks'],
  [20, '› Dispatching Executors in parallel'],
  [28, '› Executor A — BTC 1h momentum signal'],
  [38, '› Executor B — Kalshi orderbook sentiment'],
  [48, '› Executor C — P(YES) vs time decay model'],
  [58, '› Executor D — Edge vs market-implied prob'],
  [67, '› Executor E — Risk-adjusted trade signal'],
  [76, '› Aggregator synthesizing subtask results'],
  [83, '› Building unified market thesis'],
  [90, '› Aggregation complete'],
  [93, '› Extracting structured trading parameters'],
  [97, '› Mapping ROMA output → pModel, edge, rec'],
]

// ── Running loader ──────────────────────────────────────────────────────────
function RomaLoader({ elapsed }: { elapsed: number }) {
  const sec    = elapsed / 1000
  const mins   = Math.floor(sec / 60)
  const secs   = Math.floor(sec % 60)
  const timeStr = `${mins}:${String(secs).padStart(2, '0')}`

  const visibleLogs = LOG_MESSAGES.filter(([t]) => sec >= t).slice(-5)

  return (
    <div style={{ padding: '2px 0' }}>

      {/* ── Stage pipeline ── */}
      <div style={{ display: 'flex', alignItems: 'flex-start', marginBottom: 20, padding: '8px 4px 0' }}>
        {ROMA_STAGES.map((stage, i) => {
          const active = sec >= stage.startAt && sec < stage.endAt
          const done   = sec >= stage.endAt

          return (
            <div key={stage.id} style={{ display: 'flex', alignItems: 'center', flex: 1, minWidth: 0 }}>
              {/* Node column */}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, flex: 'none', position: 'relative' }}>

                {/* Ripple rings */}
                {active && ([64, 52] as const).map((size, ri) => (
                  <div key={ri} style={{
                    position: 'absolute', top: '50%', left: '50%',
                    transform: 'translate(-50%, -62%)',
                    width: size + 20, height: size + 20, borderRadius: '50%',
                    border: `1px solid rgba(${stage.rgb},${0.3 - ri * 0.1})`,
                    animation: `rippleOut 1.6s ease-out ${ri * 0.5}s infinite`,
                    pointerEvents: 'none',
                  }} />
                ))}

                {/* Main node */}
                <div style={{
                  width: 58, height: 58, borderRadius: '50%',
                  border: `2px solid ${(active || done) ? stage.color : 'var(--border)'}`,
                  background: done
                    ? `rgba(${stage.rgb},0.12)`
                    : active
                    ? `rgba(${stage.rgb},0.07)`
                    : 'rgba(255,255,255,0.5)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: done ? 16 : 20,
                  color: (active || done) ? stage.color : 'var(--text-light)',
                  transition: 'all 0.5s cubic-bezier(0.34,1.56,0.64,1)',
                  boxShadow: active
                    ? `0 0 0 4px rgba(${stage.rgb},0.12), 0 0 20px 4px rgba(${stage.rgb},0.18)`
                    : 'none',
                  position: 'relative', overflow: 'hidden',
                }}>
                  {active && (
                    <div style={{
                      position: 'absolute', inset: 0, borderRadius: '50%',
                      background: `conic-gradient(from 0deg, transparent 70%, rgba(${stage.rgb},0.28) 100%)`,
                      animation: 'spin-slow 1.8s linear infinite',
                    }} />
                  )}
                  <span style={{ position: 'relative', zIndex: 1, animation: active ? 'iconBeat 1.2s ease-in-out infinite' : 'none' }}>
                    {done ? '✓' : stage.icon}
                  </span>
                </div>

                <span style={{
                  fontSize: 9, fontWeight: 700, letterSpacing: '0.08em',
                  color: active ? stage.color : done ? stage.color + 'bb' : 'var(--text-light)',
                  textTransform: 'uppercase', textAlign: 'center', lineHeight: 1.2,
                  maxWidth: 60, whiteSpace: 'nowrap',
                  transition: 'color 0.4s',
                }}>{stage.label}</span>
              </div>

              {/* Connector */}
              {i < ROMA_STAGES.length - 1 && (
                <div style={{
                  flex: 1, height: 3, margin: '0 6px', marginBottom: 24,
                  background: done ? `rgba(${stage.rgb},0.3)` : 'var(--border)',
                  position: 'relative', overflow: 'hidden',
                  borderRadius: 2, transition: 'background 0.6s ease',
                }}>
                  {(active || (sec >= stage.startAt && sec < ROMA_STAGES[i + 1].endAt)) && [0, 0.35, 0.7].map((delay, di) => (
                    <div key={di} style={{
                      position: 'absolute', top: '50%', transform: 'translateY(-50%)',
                      width: 6, height: 6, borderRadius: '50%',
                      background: stage.color,
                      animation: `dataPacket 1.1s ${delay}s linear infinite`,
                    }} />
                  ))}
                  {done && (
                    <div style={{
                      position: 'absolute', inset: 0,
                      background: `linear-gradient(90deg, rgba(${stage.rgb},0.45), rgba(${stage.rgb},0.15))`,
                    }} />
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* ── Terminal log ── */}
      <div style={{
        borderRadius: 10,
        background: 'rgba(26,24,20,0.03)',
        border: '1px solid var(--border)',
        overflow: 'hidden',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '7px 14px',
          borderBottom: '1px solid var(--border)',
          background: 'rgba(26,24,20,0.02)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <span className="status-dot running" style={{ width: 6, height: 6 }} />
            <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', color: 'var(--text-muted)', textTransform: 'uppercase' }}>roma · solve</span>
          </div>
          <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)' }}>{timeStr}</span>
        </div>

        <div style={{ padding: '10px 14px', minHeight: 78, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', gap: 4 }}>
          {visibleLogs.map(([t, msg], idx) => {
            const isLatest = idx === visibleLogs.length - 1
            return (
              <div key={t} style={{
                display: 'flex', alignItems: 'center', gap: 10,
                opacity: isLatest ? 1 : 0.35 + idx * 0.12,
                animation: isLatest ? 'logEntry 0.25s ease forwards' : 'none',
              }}>
                <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 9.5, color: isLatest ? 'var(--brown)' : 'var(--text-light)', flexShrink: 0 }}>
                  {String(Math.floor(t / 60)).padStart(1, '0')}:{String(t % 60).padStart(2, '0')}
                </span>
                <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 10.5, color: isLatest ? 'var(--text-primary)' : 'var(--text-muted)', lineHeight: 1.4 }}>
                  {msg}
                  {isLatest && <span style={{ animation: 'blink 0.9s step-end infinite', marginLeft: 2, color: 'var(--blue)' }}>▌</span>}
                </span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ── Agent cards (post-run results) ──────────────────────────────────────────
const AGENTS = [
  { key: 'marketDiscovery' as const, label: 'Market Discovery', short: 'MARKET',   icon: '◎', desc: 'KXBTC15M scan',     color: 'var(--brown)',  rgb: '125,112,96',  bg: 'var(--brown-pale)', border: '#cbc6be' },
  { key: 'priceFeed'       as const, label: 'Price Feed',       short: 'PRICE',    icon: '◈', desc: 'CMC BTC feed',      color: 'var(--green)',  rgb: '74,148,112',  bg: 'var(--green-pale)', border: '#9ecfb8' },
  { key: 'sentiment'       as const, label: 'Sentiment',        short: 'SENTIMENT',icon: '◉', desc: 'roma-dspy',         color: 'var(--blue)',   rgb: '74,127,165',  bg: 'var(--blue-pale)',  border: '#a8cce0' },
  { key: 'probability'     as const, label: 'Probability',      short: 'PROB',     icon: '⬟', desc: 'roma-dspy',         color: 'var(--amber)',  rgb: '160,120,64',  bg: 'var(--amber-pale)', border: '#d0b888' },
  { key: 'risk'            as const, label: 'Risk Manager',     short: 'RISK',     icon: '⬡', desc: 'Kelly + limits',    color: 'var(--brown)',  rgb: '125,112,96',  bg: 'var(--brown-pale)', border: '#cbc6be' },
  { key: 'execution'       as const, label: 'Execution',        short: 'EXEC',     icon: '▶', desc: 'Paper order',       color: 'var(--green)',  rgb: '74,148,112',  bg: 'var(--green-pale)', border: '#9ecfb8' },
]

function Bullet({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 4 }}>
      <span style={{ fontSize: 9, color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', flexShrink: 0 }}>
        · {label}
      </span>
      <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 11, fontWeight: 700, color: color ?? 'var(--text-primary)', letterSpacing: '-0.01em' }}>
        {value}
      </span>
    </div>
  )
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function AgentBullets({ agentKey, output, color }: { agentKey: string; output: any; color: string }) {
  if (!output) return null

  if (agentKey === 'marketDiscovery') return (
    <>
      <Bullet label="Market"  value={output.activeMarket?.ticker ?? '—'} color={color} />
      <Bullet label="Strike"  value={output.strikePrice ? `$${output.strikePrice.toLocaleString('en-US', { maximumFractionDigits: 2 })}` : '—'} />
      <Bullet label="Expiry"  value={output.minutesUntilExpiry != null ? `${output.minutesUntilExpiry.toFixed(1)} min` : '—'} />
    </>
  )

  if (agentKey === 'priceFeed') return (
    <>
      <Bullet label="BTC"      value={output.currentPrice ? `$${output.currentPrice.toLocaleString('en-US', { maximumFractionDigits: 2 })}` : '—'} color={color} />
      <Bullet label="vs Strike" value={output.distanceFromStrikePct != null ? `${output.distanceFromStrikePct >= 0 ? '+' : ''}${output.distanceFromStrikePct.toFixed(3)}%` : '—'} />
      <Bullet label="1h"       value={output.change1h != null ? `${output.change1h >= 0 ? '+' : ''}${output.change1h.toFixed(3)}%` : '—'} />
    </>
  )

  if (agentKey === 'sentiment') return (
    <>
      <Bullet label="Score"   value={output.score != null ? output.score.toFixed(3) : '—'} color={color} />
      <Bullet label="Label"   value={output.label?.replace(/_/g, ' ') ?? '—'} />
      <Bullet label="Model"   value={output.provider ?? '—'} />
      {(output.signals ?? []).slice(0, 3).map((s: string, i: number) => (
        <div key={i} style={{ fontSize: 10, color: 'var(--text-secondary)', lineHeight: 1.5, paddingLeft: 10, marginBottom: 2 }}>
          · {s.length > 55 ? s.slice(0, 55) + '…' : s}
        </div>
      ))}
    </>
  )

  if (agentKey === 'probability') return (
    <>
      <Bullet label="P(Model)"  value={output.pModel != null ? `${(output.pModel * 100).toFixed(1)}%` : '—'} color={color} />
      <Bullet label="P(Market)" value={output.pMarket != null ? `${(output.pMarket * 100).toFixed(1)}%` : '—'} />
      <Bullet label="Edge"      value={output.edgePct != null ? `${output.edgePct >= 0 ? '+' : ''}${output.edgePct.toFixed(1)}%` : '—'} color={output.edgePct >= 0 ? 'var(--green)' : 'var(--pink)'} />
      <Bullet label="Rec"       value={output.recommendation ?? '—'} color={output.recommendation === 'YES' ? 'var(--green)' : output.recommendation === 'NO' ? 'var(--pink)' : 'var(--text-muted)'} />
      <Bullet label="Conf"      value={output.confidence ?? '—'} />
    </>
  )

  if (agentKey === 'risk') return (
    <>
      <Bullet label="Approved"  value={output.approved ? 'YES' : 'NO'} color={output.approved ? 'var(--green)' : 'var(--pink)'} />
      <Bullet label="Size"      value={output.positionSize != null ? `${output.positionSize} contracts` : '—'} color={color} />
      <Bullet label="Max Loss"  value={output.maxLoss != null ? `$${output.maxLoss.toFixed(2)}` : '—'} />
      {output.rejectionReason && <div style={{ fontSize: 10, color: 'var(--pink)', marginTop: 2 }}>· {output.rejectionReason}</div>}
    </>
  )

  if (agentKey === 'execution') return (
    <>
      <Bullet label="Action"   value={output.action ?? '—'} color={color} />
      <Bullet label="Price"    value={output.limitPrice != null ? `${output.limitPrice}¢` : '—'} />
      <Bullet label="Size"     value={output.contracts != null ? `${output.contracts} contracts` : '—'} />
      <Bullet label="Cost"     value={output.estimatedCost != null ? `$${output.estimatedCost.toFixed(2)}` : '—'} />
      <Bullet label="Payout"   value={output.estimatedPayout != null ? `$${output.estimatedPayout.toFixed(2)}` : '—'} />
    </>
  )

  return null
}

function AgentCard({
  agent,
  result,
  index,
}: {
  agent: typeof AGENTS[0]
  result?: PipelineState['agents'][keyof PipelineState['agents']]
  index: number
}) {
  const status: AgentStatus = result?.status ?? 'idle'
  const done    = status === 'done'
  const skipped = status === 'skipped'
  const active  = !done && !skipped

  return (
    <div style={{
      padding: '18px 18px 16px',
      borderRadius: 12,
      background: (done || skipped) ? agent.bg : 'rgba(255,255,255,0.5)',
      border: `1px solid ${(done || skipped) ? agent.border : 'var(--border)'}`,
      position: 'relative', overflow: 'hidden',
      transition: 'background 0.35s, border-color 0.35s, box-shadow 0.35s',
      boxShadow: done ? `0 2px 16px rgba(${agent.rgb},0.1)` : 'none',
      animation: (done || skipped) ? `cardIn 0.35s ${index * 70}ms cubic-bezier(0.34,1.56,0.64,1) both` : 'none',
    }}>
      {/* Top accent bar */}
      {(done || skipped) && (
        <div style={{
          position: 'absolute', top: 0, left: 0, right: 0, height: 3,
          background: done
            ? `linear-gradient(90deg, ${agent.color}, rgba(${agent.rgb},0.15))`
            : 'var(--amber)',
          borderRadius: '12px 12px 0 0',
        }} />
      )}

      {/* Step number */}
      <div style={{
        position: 'absolute', top: 14, right: 14,
        fontFamily: 'var(--font-geist-mono)', fontSize: 9, fontWeight: 700,
        color: (done || skipped) ? agent.color : 'var(--text-light)',
        opacity: 0.6, letterSpacing: '0.04em',
      }}>
        {String(index + 1).padStart(2, '0')}
      </div>

      {/* Icon + label */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <div style={{
          width: 40, height: 40, borderRadius: 10, flexShrink: 0,
          background: (done || skipped) ? `rgba(${agent.rgb},0.15)` : 'var(--bg-secondary)',
          border: `1.5px solid ${(done || skipped) ? agent.border : 'var(--border)'}`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 18, color: active ? 'var(--text-light)' : agent.color,
          animation: done ? 'iconLand 0.4s cubic-bezier(0.34,1.56,0.64,1) forwards' : 'none',
          transition: 'all 0.3s',
        }}>{agent.icon}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: 15, fontWeight: 800, letterSpacing: '-0.02em',
            color: active ? 'var(--text-muted)' : 'var(--text-primary)',
            lineHeight: 1.2, marginBottom: 3,
          }}>{agent.label}</div>
          <div style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-muted)' }}>
            {/* For roma-dspy agents, show the actual provider from agentName (e.g. "roma-dspy · grok") */}
            {result?.agentName?.includes('roma-dspy')
              ? result.agentName.replace(/^.*?\(/, '').replace(/\)$/, '')
              : agent.desc}
          </div>
        </div>
        {done    && <span style={{ fontSize: 14, color: agent.color, flexShrink: 0, marginRight: 20, animation: 'tickPop 0.3s cubic-bezier(0.34,1.56,0.64,1) forwards' }}>✓</span>}
        {skipped && <span style={{ fontSize: 12, color: 'var(--amber)', flexShrink: 0, marginRight: 20 }}>—</span>}
      </div>

      {/* Output bullets */}
      <div style={{ borderTop: `1px solid rgba(${agent.rgb},0.15)`, paddingTop: 10 }}>
        {result ? (
          <AgentBullets agentKey={agent.key} output={result.output} color={agent.color} />
        ) : (
          <div style={{ fontSize: 11, color: 'var(--text-light)', fontStyle: 'italic' }}>
            Waiting for pipeline run…
          </div>
        )}
      </div>

      {/* Duration */}
      {result?.durationMs != null && (
        <div style={{ marginTop: 8, fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--font-geist-mono)', fontWeight: 600, opacity: 0.7 }}>
          {result.durationMs >= 1000 ? (result.durationMs / 1000).toFixed(1) + 's' : result.durationMs + 'ms'}
        </div>
      )}
    </div>
  )
}

// ── Main export ─────────────────────────────────────────────────────────────
export default function AgentPipeline({ pipeline, isRunning }: { pipeline: PipelineState | null; isRunning: boolean }) {
  const [elapsedMs, setElapsedMs] = useState(0)
  const startRef = useRef<number | null>(null)

  useEffect(() => {
    if (isRunning) {
      startRef.current = Date.now()
      setElapsedMs(0)
      const id = setInterval(() => setElapsedMs(Date.now() - (startRef.current ?? Date.now())), 250)
      return () => clearInterval(id)
    }
  }, [isRunning])

  return (
    <div className="card" style={{ padding: '18px 18px 16px' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.01em' }}>ROMA Agent Pipeline</div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2, letterSpacing: '0.02em' }}>
            Atomizer → Planner → Executors → Aggregator → Extract
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {isRunning && (
            <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--pink)', fontWeight: 600 }}>
              <span className="status-dot running" /> Running
            </span>
          )}
          {pipeline && !isRunning && <span className="pill pill-brown">cycle #{pipeline.cycleId}</span>}
        </div>
      </div>

      {/* Body */}
      {isRunning ? (
        <RomaLoader elapsed={elapsedMs} />
      ) : pipeline ? (
        <>
          <div style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 12,
          }}>
            {AGENTS.map((agent, i) => {
              const result = pipeline.agents[agent.key]
              return <AgentCard key={agent.key} agent={agent} result={result} index={i} />
            })}
          </div>

          {pipeline.cycleCompletedAt && (
            <div style={{ marginTop: 12, fontSize: 9, color: 'var(--text-muted)', fontFamily: 'var(--font-geist-mono)', textAlign: 'right', opacity: 0.6 }}>
              completed {new Date(pipeline.cycleCompletedAt).toLocaleTimeString('en-US', { hour12: false })}
            </div>
          )}
        </>
      ) : (
        <div style={{ padding: '32px 0', textAlign: 'center' }}>
          <div style={{ fontSize: 10, letterSpacing: '0.07em', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: 6 }}>// AWAITING</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Awaiting first ROMA cycle…</div>
        </div>
      )}
    </div>
  )
}
