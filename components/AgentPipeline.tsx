'use client'

import { useState, useEffect, useRef } from 'react'
import type { PipelineState, AgentStatus } from '@/lib/types'

// ── ROMA stage definitions ─────────────────────────────────────────────────
// Timing based on observed ~94s ROMA run (approximate, cascades visually)
const ROMA_STAGES = [
  { id: 'atomize',   label: 'ATOMIZE',    icon: '◎', color: 'var(--brown)',  glow: 'nodeGlowBrown',  startAt: 0,  endAt: 7  },
  { id: 'plan',      label: 'PLAN',       icon: '◉', color: 'var(--pink)',   glow: 'nodeGlowPink',   startAt: 7,  endAt: 20 },
  { id: 'execute',   label: 'EXECUTE ×N', icon: '▶', color: 'var(--green)',  glow: 'nodeGlowGreen',  startAt: 20, endAt: 76 },
  { id: 'aggregate', label: 'AGGREGATE',  icon: '⬟', color: 'var(--amber)',  glow: 'nodeGlowAmber',  startAt: 76, endAt: 93 },
  { id: 'extract',   label: 'EXTRACT',    icon: '◈', color: '#4a7fa5',       glow: 'nodeGlowBlue',   startAt: 93, endAt: 999},
]

const MESSAGES: [number, string][] = [
  [0,  'Sending market context to Atomizer...'],
  [4,  'ROMA: task is complex — decomposing into subtasks...'],
  [8,  'Planner analyzing market structure...'],
  [14, 'Generating 3–5 parallel analysis subtasks...'],
  [20, 'Dispatching Executors in parallel...'],
  [28, 'Analyzing BTC 1h price momentum signal...'],
  [38, 'Analyzing Kalshi orderbook crowd sentiment...'],
  [48, 'Estimating P(YES) given price position + time decay...'],
  [58, 'Evaluating edge vs market-implied probability...'],
  [67, 'Assessing risk-adjusted trade decision...'],
  [76, 'Aggregator synthesizing all subtask results...'],
  [83, 'Building unified market thesis...'],
  [90, 'Aggregation complete — extracting structured signals...'],
  [95, 'Mapping ROMA output to trading parameters...'],
]

function RomaLoader({ elapsed }: { elapsed: number }) {
  const sec = elapsed / 1000
  const mins = Math.floor(sec / 60)
  const secs = Math.floor(sec % 60)
  const timeStr = `${mins}:${String(secs).padStart(2, '0')}`
  const message = [...MESSAGES].reverse().find(([t]) => sec >= t)?.[1] ?? MESSAGES[0][1]

  return (
    <div style={{ padding: '4px 0 2px' }}>
      {/* Stage pipeline */}
      <div style={{ display: 'flex', alignItems: 'flex-start', marginBottom: 14 }}>
        {ROMA_STAGES.map((stage, i) => {
          const active = sec >= stage.startAt && sec < stage.endAt
          const done   = sec >= stage.endAt

          return (
            <div key={stage.id} style={{ display: 'flex', alignItems: 'center', flex: 1, minWidth: 0 }}>
              {/* Node + label */}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5, flex: 'none' }}>
                <div style={{
                  width: 34, height: 34, borderRadius: '50%',
                  border: `2px solid ${(active || done) ? stage.color : 'var(--border)'}`,
                  background: done ? stage.color + '28' : active ? stage.color + '12' : 'rgba(255,255,255,0.6)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: done ? 12 : 14,
                  color: (active || done) ? stage.color : 'var(--text-light)',
                  transition: 'all 0.5s ease',
                  animation: active ? `${stage.glow} 1s ease-in-out infinite` : 'none',
                  position: 'relative',
                }}>
                  {done ? '✓' : stage.icon}
                  {active && (
                    <div style={{
                      position: 'absolute', inset: -4, borderRadius: '50%',
                      border: `1.5px solid ${stage.color}`,
                      opacity: 0.4,
                      animation: 'pulse-dot 1.2s ease-in-out infinite',
                    }} />
                  )}
                </div>
                <span style={{
                  fontSize: 7, fontWeight: 700, letterSpacing: '0.07em',
                  color: active ? stage.color : done ? stage.color : 'var(--text-light)',
                  textTransform: 'uppercase', textAlign: 'center', lineHeight: 1.2,
                  transition: 'color 0.4s',
                  maxWidth: 46, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>{stage.label}</span>
              </div>

              {/* Connector */}
              {i < ROMA_STAGES.length - 1 && (
                <div style={{
                  flex: 1, height: 2, margin: '0 3px', marginBottom: 18,
                  background: done ? stage.color : 'var(--border)',
                  position: 'relative', overflow: 'hidden',
                  borderRadius: 1, transition: 'background 0.5s',
                }}>
                  {(active || (sec >= stage.startAt && sec < ROMA_STAGES[i + 1].endAt)) && (
                    <div style={{
                      position: 'absolute', top: 0, left: '-100%', width: '100%', height: '100%',
                      background: `linear-gradient(90deg, transparent, ${stage.color}cc, transparent)`,
                      animation: 'flowRight 0.8s linear infinite',
                    }} />
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Status message + timer */}
      <div style={{
        padding: '9px 12px', borderRadius: 9,
        background: 'var(--bg-secondary)', border: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
          <span className="status-dot running" style={{ width: 5, height: 5, flexShrink: 0 }} />
          <span style={{
            fontSize: 9.5, color: 'var(--text-secondary)', lineHeight: 1.3,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            animation: 'romaTyping 2s ease-in-out infinite',
          }}>{message}</span>
        </div>
        <span style={{
          fontFamily: 'var(--font-geist-mono)', fontSize: 10.5, fontWeight: 700,
          color: 'var(--text-muted)', flexShrink: 0,
        }}>{timeStr}</span>
      </div>
    </div>
  )
}

// ── Agent cards (post-run results) ─────────────────────────────────────────
const AGENTS = [
  { key: 'marketDiscovery' as const, short: 'MARKET', icon: '◎', desc: 'KXBTC15M scan',     color: 'var(--brown)',  bg: 'var(--brown-pale)', border: '#d4bfad' },
  { key: 'priceFeed'       as const, short: 'PRICE',  icon: '◈', desc: 'CMC BTC feed',      color: 'var(--green)',  bg: 'var(--green-pale)', border: '#aed5b8' },
  { key: 'sentiment'       as const, short: 'ROMA·S', icon: '◉', desc: 'ROMA sentiment',    color: 'var(--pink)',   bg: 'var(--pink-pale)',  border: '#e0b0bf' },
  { key: 'probability'     as const, short: 'ROMA·P', icon: '⬟', desc: 'ROMA probability',  color: 'var(--amber)',  bg: 'var(--amber-pale)', border: '#dfbf98' },
  { key: 'risk'            as const, short: 'RISK',   icon: '⬡', desc: 'Kelly + limits',    color: 'var(--brown)',  bg: 'var(--brown-pale)', border: '#d4bfad' },
  { key: 'execution'       as const, short: 'EXEC',   icon: '▶', desc: 'Paper order',       color: 'var(--green)',  bg: 'var(--green-pale)', border: '#aed5b8' },
]

function agentColor(s: AgentStatus, base: string) {
  if (s === 'running') return 'var(--pink)'
  if (s === 'done')    return base
  if (s === 'error')   return 'var(--red)'
  if (s === 'skipped') return 'var(--amber)'
  return 'var(--text-light)'
}

function AgentCard({ agent, result }: { agent: typeof AGENTS[0]; result?: PipelineState['agents'][keyof PipelineState['agents']] }) {
  const status: AgentStatus = result?.status ?? 'idle'
  const color   = agentColor(status, agent.color)
  const done    = status === 'done'
  const skipped = status === 'skipped'

  return (
    <div style={{
      flex: 1, minWidth: 0, padding: '10px 11px', borderRadius: 10,
      background: (done || skipped) ? agent.bg : 'rgba(255,255,255,0.7)',
      border: `1px solid ${(done || skipped) ? agent.border : 'var(--border)'}`,
      position: 'relative', overflow: 'hidden',
      transition: 'background 0.3s, border-color 0.3s',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 4 }}>
        <span style={{ fontSize: 11, color }}>{agent.icon}</span>
        <span style={{ fontSize: 8, fontWeight: 800, letterSpacing: '0.08em', color, fontFamily: 'var(--font-geist-mono)', textTransform: 'uppercase' }}>{agent.short}</span>
        {done    && <span style={{ fontSize: 9, color: agent.color, marginLeft: 'auto' }}>✓</span>}
        {skipped && <span style={{ fontSize: 9, color: 'var(--amber)', marginLeft: 'auto' }}>—</span>}
      </div>
      <div style={{ fontSize: 8.5, color: 'var(--text-muted)', marginBottom: result ? 4 : 0, lineHeight: 1.3 }}>{agent.desc}</div>
      {result && (
        <div style={{ fontSize: 7.5, color: 'var(--text-secondary)', lineHeight: 1.4, borderTop: '1px solid var(--border)', paddingTop: 4 }}>
          {result.reasoning.length > 72 ? result.reasoning.slice(0, 72) + '…' : result.reasoning}
        </div>
      )}
      {result?.durationMs ? (
        <div style={{ marginTop: 2, fontSize: 7, color: 'var(--text-muted)', fontFamily: 'var(--font-geist-mono)' }}>{result.durationMs}ms</div>
      ) : null}
    </div>
  )
}

function Connector({ done }: { done: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', flexShrink: 0, width: 14, margin: '0 -1px' }}>
      <div style={{ width: '100%', height: 2, background: done ? 'var(--green)' : 'var(--border)', borderRadius: 1, transition: 'background 0.3s' }} />
    </div>
  )
}

// ── Main export ────────────────────────────────────────────────────────────
export default function AgentPipeline({ pipeline, isRunning }: { pipeline: PipelineState | null; isRunning: boolean }) {
  const [elapsedMs, setElapsedMs] = useState(0)
  const startRef = useRef<number | null>(null)

  useEffect(() => {
    if (isRunning) {
      startRef.current = Date.now()
      setElapsedMs(0)
      const id = setInterval(() => setElapsedMs(Date.now() - (startRef.current ?? Date.now())), 500)
      return () => clearInterval(id)
    }
  }, [isRunning])

  return (
    <div className="card" style={{ padding: '14px 16px' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)' }}>ROMA Agent Pipeline</div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 1 }}>Sentient GRID · Atomizer → Planner → Executors → Aggregator</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {isRunning && (
            <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, color: 'var(--pink)' }}>
              <span className="status-dot running" /> Running
            </span>
          )}
          {pipeline && !isRunning && <span className="pill pill-brown">cycle #{pipeline.cycleId}</span>}
        </div>
      </div>

      {/* Body: loader while running, agent cards when done */}
      {isRunning ? (
        <RomaLoader elapsed={elapsedMs} />
      ) : pipeline ? (
        <>
          <div style={{ display: 'flex', alignItems: 'stretch' }}>
            {AGENTS.map((agent, i) => {
              const result = pipeline.agents[agent.key]
              const done   = result?.status === 'done' || result?.status === 'skipped'
              return (
                <div key={agent.key} style={{ display: 'flex', alignItems: 'stretch', flex: 1, minWidth: 0 }}>
                  <AgentCard agent={agent} result={result} />
                  {i < AGENTS.length - 1 && <Connector done={done} />}
                </div>
              )
            })}
          </div>
          {pipeline.cycleCompletedAt && (
            <div style={{ marginTop: 8, fontSize: 8, color: 'var(--text-muted)', fontFamily: 'var(--font-geist-mono)', textAlign: 'right' }}>
              Completed {new Date(pipeline.cycleCompletedAt).toLocaleTimeString('en-US', { hour12: false })} UTC
            </div>
          )}
        </>
      ) : (
        <div style={{ padding: '20px 0', textAlign: 'center' }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Awaiting first ROMA cycle...</div>
        </div>
      )}
    </div>
  )
}
