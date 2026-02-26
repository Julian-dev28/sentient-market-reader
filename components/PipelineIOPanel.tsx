'use client'

import { useState, useEffect, useRef } from 'react'
import type { PipelineState } from '@/lib/types'

// ── Colors ───────────────────────────────────────────────────────────────────
const C = {
  key:     'var(--blue)',
  str:     'var(--green-dark)',
  num:     'var(--amber)',
  bool:    'var(--pink)',
  null_:   'var(--text-light)',
  punct:   'var(--text-light)',
  comment: 'var(--text-light)',
  stage:   'var(--text-secondary)',
  dim:     'var(--border-bright)',
}

// ── JSON renderer ─────────────────────────────────────────────────────────────
type Token = { t: 'k'|'s'|'n'|'b'|'z'|'p'; v: string }

function tokenize(obj: Record<string, unknown>): Token[] {
  const tokens: Token[] = []
  const entries = Object.entries(obj)
  tokens.push({ t: 'p', v: '{' })
  entries.forEach(([k, v], i) => {
    tokens.push({ t: 'k', v: `"${k}"` })
    tokens.push({ t: 'p', v: ':' })
    if (v === null || v === undefined) tokens.push({ t: 'z', v: 'null' })
    else if (typeof v === 'boolean') tokens.push({ t: 'b', v: String(v) })
    else if (typeof v === 'number') tokens.push({ t: 'n', v: String(v) })
    else tokens.push({ t: 's', v: `"${String(v)}"` })
    if (i < entries.length - 1) tokens.push({ t: 'p', v: ',' })
  })
  tokens.push({ t: 'p', v: '}' })
  return tokens
}

function JSONLine({ obj, animate }: { obj: Record<string, unknown>; animate?: boolean }) {
  const tokens = tokenize(obj)
  const colorOf = (t: Token['t']) => {
    if (t === 'k') return C.key
    if (t === 's') return C.str
    if (t === 'n') return C.num
    if (t === 'b') return C.bool
    if (t === 'z') return C.null_
    return C.punct
  }
  return (
    <span style={{
      fontFamily: 'var(--font-geist-mono)', fontSize: 11, lineHeight: 1.7,
      animation: animate ? 'logEntry 0.2s ease forwards' : 'none',
      display: 'inline',
    }}>
      {tokens.map((tok, i) => (
        <span key={i} style={{ color: colorOf(tok.t) }}>
          {tok.t === 'p' && tok.v === ':' ? ': ' : tok.v}
          {tok.t === 'p' && tok.v === ',' ? ' ' : ''}
        </span>
      ))}
    </span>
  )
}

// ── Stage data extractors ─────────────────────────────────────────────────────
function stagePayload(key: string, p: PipelineState): Record<string, unknown> {
  const md  = p.agents.marketDiscovery.output
  const pf  = p.agents.priceFeed.output
  const snt = p.agents.sentiment.output
  const prb = p.agents.probability.output
  const rsk = p.agents.risk.output
  const exc = p.agents.execution.output

  if (key === 'marketDiscovery') return {
    ticker:  md.activeMarket?.ticker?.replace('KXBTC15M-', '') ?? null,
    strike:  md.strikePrice > 0 ? `$${md.strikePrice.toLocaleString('en-US', { maximumFractionDigits: 2 })}` : null,
    ttl_min: md.minutesUntilExpiry > 0 ? +md.minutesUntilExpiry.toFixed(1) : null,
    bid:     md.activeMarket?.yes_bid ?? null,
    ask:     md.activeMarket?.yes_ask ?? null,
  }

  if (key === 'priceFeed') return {
    btc:       pf.currentPrice > 0 ? +pf.currentPrice.toFixed(0) : null,
    vs_strike: `${pf.distanceFromStrikePct >= 0 ? '+' : ''}${pf.distanceFromStrikePct.toFixed(3)}%`,
    pos:       pf.aboveStrike ? 'ABOVE' : 'BELOW',
    d1h:       `${pf.priceChangePct1h >= 0 ? '+' : ''}${pf.priceChangePct1h.toFixed(3)}%`,
  }

  if (key === 'sentiment') return {
    score:    snt.score != null ? +snt.score.toFixed(4) : null,
    label:    snt.label?.replace(/_/g, ' ') ?? null,
    momentum: snt.momentum != null ? +snt.momentum.toFixed(3) : null,
    ob_skew:  snt.orderbookSkew != null ? +snt.orderbookSkew.toFixed(3) : null,
  }

  if (key === 'probability') return {
    p_model:  prb.pModel != null ? +prb.pModel.toFixed(4) : null,
    p_market: prb.pMarket != null ? +prb.pMarket.toFixed(4) : null,
    edge:     prb.edgePct != null ? `${prb.edgePct >= 0 ? '+' : ''}${prb.edgePct.toFixed(2)}%` : null,
    rec:      prb.recommendation ?? null,
    conf:     prb.confidence ?? null,
  }

  if (key === 'risk') return {
    approved: rsk.approved,
    size:     rsk.positionSize,
    max_loss: rsk.maxLoss != null ? `$${rsk.maxLoss.toFixed(2)}` : null,
    reason:   rsk.rejectionReason ?? undefined,
  }

  if (key === 'execution') return {
    action:  exc.action,
    price:   exc.limitPrice != null ? `${exc.limitPrice}¢` : null,
    size:    exc.contracts,
    cost:    exc.estimatedCost > 0 ? `$${exc.estimatedCost.toFixed(2)}` : null,
    payout:  exc.estimatedPayout > 0 ? `$${exc.estimatedPayout.toFixed(2)}` : null,
  }

  return {}
}

// ── Stage config ──────────────────────────────────────────────────────────────
const STAGES = [
  { key: 'marketDiscovery', label: 'MARKET',      color: '#cbc6be', rgb: '125,112,96',  startAt: 0,  endAt: 2   },
  { key: 'priceFeed',       label: 'PRICE',        color: '#9ecfb8', rgb: '74,148,112',  startAt: 2,  endAt: 4   },
  { key: 'sentiment',       label: 'SENTIMENT',    color: '#a8cce0', rgb: '74,127,165',  startAt: 4,  endAt: 22  },
  { key: 'probability',     label: 'PROBABILITY',  color: '#d0b888', rgb: '160,120,64',  startAt: 22, endAt: 40  },
  { key: 'risk',            label: 'RISK',         color: '#cbc6be', rgb: '125,112,96',  startAt: 40, endAt: 42  },
  { key: 'execution',       label: 'EXECUTION',    color: '#9ecfb8', rgb: '74,148,112',  startAt: 42, endAt: 999 },
] as const

// ── Main component ────────────────────────────────────────────────────────────
export default function PipelineIOPanel({ pipeline, isRunning }: { pipeline: PipelineState | null; isRunning: boolean }) {
  const [elapsedMs, setElapsedMs] = useState(0)
  const startRef = useRef<number | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (isRunning) {
      startRef.current = Date.now()
      setElapsedMs(0)
      const id = setInterval(() => setElapsedMs(Date.now() - (startRef.current ?? Date.now())), 200)
      return () => clearInterval(id)
    }
  }, [isRunning])

  // Auto-scroll to bottom as new lines appear
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [elapsedMs, pipeline])

  const elapsedSec = elapsedMs / 1000
  const totalMs = pipeline?.cycleCompletedAt && pipeline.cycleStartedAt
    ? new Date(pipeline.cycleCompletedAt).getTime() - new Date(pipeline.cycleStartedAt).getTime()
    : null

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden', minWidth: 0 }}>

      {/* Title bar */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '9px 14px',
        borderBottom: '1px solid var(--border)',
        background: 'var(--bg-secondary)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ display: 'flex', gap: 5 }}>
            {['#ff5f57','#febc2e','#28c840'].map((c, i) => (
              <div key={i} style={{ width: 8, height: 8, borderRadius: '50%', background: c, opacity: 0.55 }} />
            ))}
          </div>
          <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 10, color: 'var(--text-light)', letterSpacing: '0.06em' }}>
            pipeline · i/o stream
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {isRunning && (
            <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontFamily: 'var(--font-geist-mono)', fontSize: 10, color: 'var(--pink)' }}>
              <span className="status-dot running" style={{ width: 5, height: 5 }} />
              {Math.floor(elapsedSec / 60)}:{String(Math.floor(elapsedSec % 60)).padStart(2, '0')}
            </span>
          )}
          {totalMs != null && !isRunning && (
            <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 10, color: 'var(--text-light)' }}>
              {(totalMs / 1000).toFixed(1)}s
            </span>
          )}
          {pipeline && !isRunning && (
            <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 10, color: 'var(--text-light)', letterSpacing: '0.04em' }}>
              #{pipeline.cycleId}
            </span>
          )}
        </div>
      </div>

      {/* Stream body */}
      <div ref={scrollRef} style={{
        padding: '12px 16px 14px',
        maxHeight: 340,
        overflowY: 'auto',
        scrollbarWidth: 'thin',
        scrollbarColor: 'var(--border) transparent',
        background: 'var(--bg-card)',
      }}>

        {(!pipeline && !isRunning) ? (
          // Empty state
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0' }}>
            <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 11, color: 'var(--text-light)' }}>
              {'// awaiting first cycle'}
            </span>
            <span style={{ color: 'var(--blue)', animation: 'blink 0.9s step-end infinite', fontFamily: 'var(--font-geist-mono)' }}>▌</span>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
            {STAGES.map((stage) => {
              const result    = pipeline?.agents[stage.key]
              const stageDone = !isRunning && result?.status === 'done'
              const stageSk   = !isRunning && result?.status === 'skipped'
              const liveActive  = isRunning && elapsedSec >= stage.startAt && elapsedSec < stage.endAt
              const liveDone    = isRunning && elapsedSec >= stage.endAt
              const liveQueued  = isRunning && elapsedSec < stage.startAt

              const showOutput = stageDone || stageSk
              const ms = result?.durationMs

              return (
                <div key={stage.key} style={{ marginBottom: 10 }}>
                  {/* Stage comment header */}
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 0,
                    marginBottom: 3,
                    opacity: (liveQueued) ? 0.3 : 1,
                    transition: 'opacity 0.4s',
                  }}>
                    <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 10, color: C.comment, userSelect: 'none' }}>
                      {'// ── '}
                    </span>
                    <span style={{
                      fontFamily: 'var(--font-geist-mono)', fontSize: 10, fontWeight: 700,
                      color: (liveActive || showOutput || liveDone) ? stage.color : C.comment,
                      letterSpacing: '0.08em',
                      transition: 'color 0.3s',
                    }}>
                      {stage.label}
                    </span>
                    {ms != null && !isRunning && (
                      <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 9, color: C.comment, marginLeft: 6 }}>
                        · {ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : ms + 'ms'}
                      </span>
                    )}
                    <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 10, color: C.comment, userSelect: 'none', flex: 1 }}>
                      {' ─'.repeat(6)}
                    </span>
                  </div>

                  {/* JSON output line */}
                  <div style={{
                    paddingLeft: 16,
                    opacity: liveQueued ? 0.2 : 1,
                    transition: 'opacity 0.4s',
                  }}>
                    {showOutput && pipeline ? (
                      <JSONLine obj={stagePayload(stage.key, pipeline)} animate />
                    ) : liveActive ? (
                      <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 11, color: stage.color }}>
                        {'{ '}
                        <span style={{ animation: 'blink 0.7s step-end infinite', color: 'var(--blue)' }}>▌</span>
                        {' }'}
                      </span>
                    ) : liveDone && pipeline ? (
                      <JSONLine obj={stagePayload(stage.key, pipeline)} />
                    ) : stageSk ? (
                      <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 11, color: C.null_ }}>{'{ }'}</span>
                    ) : (
                      <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 11, color: C.dim }}>{'...'}</span>
                    )}
                  </div>
                </div>
              )
            })}

            {/* Cursor / completion line */}
            {!isRunning && pipeline && (
              <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 10, color: C.comment }}>
                  {'// ── done'}
                </span>
                <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 10, color: 'var(--green)' }}>✓</span>
              </div>
            )}
            {isRunning && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 4 }}>
                <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 10, color: 'var(--text-light)' }}>$</span>
                <span style={{ color: 'var(--blue)', animation: 'blink 0.9s step-end infinite', fontFamily: 'var(--font-geist-mono)' }}>▌</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
