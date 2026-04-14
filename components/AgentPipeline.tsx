'use client'

import { useState, useEffect, useRef } from 'react'
import type { PipelineState, PartialPipelineAgents, AgentStatus } from '@/lib/types'

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

// ── Shared mini-components ───────────────────────────────────────────────────

/** Animated fill bar */
function MiniBar({
  value, color, bg, height = 5, delay = 120,
}: {
  value: number   // 0–1
  color: string
  bg?: string
  height?: number
  delay?: number
}) {
  const pct = Math.min(100, Math.max(0, value * 100))
  const [w, setW] = useState(0)
  useEffect(() => {
    const id = setTimeout(() => setW(pct), delay)
    return () => clearTimeout(id)
  }, [pct, delay])
  return (
    <div style={{ height, borderRadius: height / 2, background: bg ?? 'rgba(0,0,0,0.07)', overflow: 'hidden' }}>
      <div style={{
        height: '100%', width: `${w}%`, borderRadius: height / 2,
        background: color, transition: 'width 1s cubic-bezier(0.34,1.56,0.64,1)',
      }} />
    </div>
  )
}

/** Key-value row for simple bullet facts */
function Fact({ label, value, color, mono = true }: { label: string; value: string; color?: string; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 3 }}>
      <span style={{ fontSize: 9, color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        {label}
      </span>
      <span style={{
        fontFamily: mono ? 'var(--font-geist-mono)' : 'inherit',
        fontSize: 11, fontWeight: 700,
        color: color ?? 'var(--text-primary)',
      }}>
        {value}
      </span>
    </div>
  )
}

// ── Running indicator (minimal scan bar) ────────────────────────────────────
function ScanLoader({ elapsed, aiMode }: { elapsed: number; aiMode?: boolean }) {
  const sec = (elapsed / 1000).toFixed(1)
  const scanColor = aiMode ? 'var(--blue)' : 'var(--green)'
  const label     = aiMode ? 'GROK ANALYZING' : 'SCANNING MARKET'
  return (
    <div style={{ padding: '24px 0 20px' }}>
      <div style={{ position: 'relative', height: 2, borderRadius: 1, background: 'var(--border)', overflow: 'hidden', marginBottom: 20 }}>
        <div style={{
          position: 'absolute', top: 0, left: 0, height: '100%', width: '40%',
          background: scanColor,
          animation: 'scanLine 1.2s ease-in-out infinite',
          opacity: 0.7,
        }} />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="status-dot running" style={{ width: 6, height: 6, background: scanColor }} />
          <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 10, color: 'var(--text-muted)', letterSpacing: '0.06em' }}>
            {label}
          </span>
        </div>
        <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 10, color: 'var(--text-muted)', opacity: 0.5 }}>{sec}s</span>
      </div>
    </div>
  )
}

// ── Agent cards (post-run results) ──────────────────────────────────────────
const AGENTS_QUANT = [
  { key: 'marketDiscovery' as const, label: 'Market Discovery', short: 'MARKET',    icon: '◎', desc: 'KXBTC15M scan',     color: 'var(--brown)',  rgb: '74,124,142',  bg: 'var(--brown-pale)', border: 'rgba(74,124,142,0.22)' },
  { key: 'priceFeed'       as const, label: 'Price Feed',       short: 'PRICE',     icon: '◈', desc: 'Coinbase BTC feed', color: 'var(--green)',  rgb: '45,158,107',     bg: 'var(--green-pale)', border: 'rgba(45,158,107,0.22)'    },
  { key: 'sentiment'       as const, label: 'Sentiment',        short: 'SENTIMENT', icon: '◉', desc: 'quant signals',     color: 'var(--blue)',   rgb: '58,114,168',   bg: 'var(--blue-pale)',  border: 'rgba(58,114,168,0.22)'  },
  { key: 'probability'     as const, label: 'Probability',      short: 'PROB',      icon: '⬟', desc: 'Brownian + d-gate', color: 'var(--amber)',  rgb: '184,121,10',   bg: 'var(--amber-pale)', border: 'rgba(184,121,10,0.22)'  },
  { key: 'risk'            as const, label: 'Risk Manager',     short: 'RISK',      icon: '⬡', desc: 'Kelly + limits',    color: 'var(--brown)',  rgb: '74,124,142',  bg: 'var(--brown-pale)', border: 'rgba(74,124,142,0.22)' },
  { key: 'execution'       as const, label: 'Execution',        short: 'EXEC',      icon: '▶', desc: 'paper order',       color: 'var(--green)',  rgb: '45,158,107',     bg: 'var(--green-pale)', border: 'rgba(45,158,107,0.22)'    },
]

const AGENTS_AI = [
  { key: 'marketDiscovery' as const, label: 'Market Discovery', short: 'MARKET',    icon: '◎', desc: 'KXBTC15M scan',     color: 'var(--brown)',  rgb: '74,124,142',  bg: 'var(--brown-pale)', border: 'rgba(74,124,142,0.22)' },
  { key: 'priceFeed'       as const, label: 'Price Feed',       short: 'PRICE',     icon: '◈', desc: 'Coinbase BTC feed', color: 'var(--green)',  rgb: '45,158,107',     bg: 'var(--green-pale)', border: 'rgba(45,158,107,0.22)'    },
  { key: 'sentiment'       as const, label: 'Sentiment',        short: 'SENTIMENT', icon: '◉', desc: 'Grok AI',           color: 'var(--blue)',   rgb: '58,114,168',   bg: 'var(--blue-pale)',  border: 'rgba(58,114,168,0.22)'  },
  { key: 'probability'     as const, label: 'Probability',      short: 'PROB',      icon: '⬟', desc: 'Grok AI',           color: 'var(--amber)',  rgb: '184,121,10',   bg: 'var(--amber-pale)', border: 'rgba(184,121,10,0.22)'  },
  { key: 'risk'            as const, label: 'Risk Manager',     short: 'RISK',      icon: '⬡', desc: 'Grok sizing',       color: 'var(--brown)',  rgb: '74,124,142',  bg: 'var(--brown-pale)', border: 'rgba(74,124,142,0.22)' },
  { key: 'execution'       as const, label: 'Execution',        short: 'EXEC',      icon: '▶', desc: 'Grok order',        color: 'var(--green)',  rgb: '45,158,107',     bg: 'var(--green-pale)', border: 'rgba(45,158,107,0.22)'    },
]

function shortenProvider(raw: string): string {
  return raw.split('+').map(p => {
    p = p.trim()
    if (p.startsWith('huggingface/')) {
      const model = p.replace('huggingface/', '').split('/').pop() ?? p
      return 'hf/' + model.replace(/-Instruct$/i, '').replace(/-\d{8,}$/, '')
    }
    if (p.startsWith('grok/'))       return p.replace('grok/', '')
    if (p.startsWith('anthropic/'))  return p.replace('anthropic/', 'claude-').replace('claude-claude-', 'claude-').replace(/-\d{8,}$/, '')
    if (p.startsWith('openai/'))     return p.replace('openai/', '')
    if (p.startsWith('openrouter/')) return p.replace('openrouter/', '').split('/').pop() ?? p
    return p
  }).join(' + ')
}

// ── Premium card body renderers ──────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function MarketDiscoveryBody({ output, color }: { output: any; color: string }) {
  const mins  = output.minutesUntilExpiry ?? 0
  const urgency = mins < 3 ? 'var(--pink)' : mins < 7 ? 'var(--amber)' : color
  const fillPct = Math.min(1, mins / 15)  // 15-min window

  return (
    <div>
      {/* Ticker */}
      <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 10, fontWeight: 700, color, letterSpacing: '0.04em', marginBottom: 10 }}>
        {output.activeMarket?.ticker ?? '—'}
      </div>

      {/* Strike hero */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 9, color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 3 }}>Strike price</div>
        <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 22, fontWeight: 900, color: 'var(--text-primary)', letterSpacing: '-0.02em', lineHeight: 1 }}>
          {output.strikePrice ? `$${output.strikePrice.toLocaleString('en-US', { maximumFractionDigits: 2 })}` : '—'}
        </div>
      </div>

      {/* Expiry countdown bar */}
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
          <span style={{ fontSize: 9, color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Time remaining</span>
          <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 11, fontWeight: 800, color: urgency }}>
            {mins > 0 ? `${mins.toFixed(1)} min` : '—'}
          </span>
        </div>
        <MiniBar value={fillPct} color={urgency} bg="rgba(0,0,0,0.07)" height={6} />
      </div>
    </div>
  )
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function PriceFeedBody({ output, color }: { output: any; color: string }) {
  const dist  = output.distanceFromStrikePct ?? 0
  const above = dist >= 0
  const dir1h = (output.priceChangePct1h ?? 0) >= 0

  return (
    <div>
      {/* BTC price hero */}
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 9, color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 3 }}>BTC / USD</div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 22, fontWeight: 900, color: 'var(--text-primary)', letterSpacing: '-0.02em', lineHeight: 1 }}>
            {output.currentPrice ? `$${output.currentPrice.toLocaleString('en-US', { maximumFractionDigits: 2 })}` : '—'}
          </span>
          <span style={{ fontSize: 14, color: dir1h ? 'var(--green)' : 'var(--pink)' }}>{dir1h ? '▲' : '▼'}</span>
        </div>
      </div>

      {/* vs Strike */}
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8 }}>
        <span style={{ fontSize: 9, color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>vs strike</span>
        <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 14, fontWeight: 800, color: above ? 'var(--green-dark)' : 'var(--pink)' }}>
          {dist >= 0 ? '+' : ''}{dist.toFixed(3)}%
        </span>
      </div>

      <Fact
        label="1h change"
        value={`${(output.priceChangePct1h ?? 0) >= 0 ? '+' : ''}${(output.priceChangePct1h ?? 0).toFixed(3)}%`}
        color={(output.priceChangePct1h ?? 0) >= 0 ? 'var(--green-dark)' : 'var(--pink)'}
      />
    </div>
  )
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function SentimentBody({ output, color }: { output: any; color: string }) {
  const score   = output.score ?? 0
  const bullish = score > 0.1
  const bearish = score < -0.1
  const scoreColor = bullish ? 'var(--green)' : bearish ? 'var(--pink)' : 'var(--text-muted)'
  const label = (output.label ?? '').replace(/_/g, ' ')
  // Map score -1→+1 to 0→1 fill
  const barFill = (score + 1) / 2

  const labelBg    = bullish ? 'rgba(45,158,107,0.12)'  : bearish ? 'rgba(192,69,62,0.12)'  : 'rgba(0,0,0,0.06)'
  const labelBdr   = bullish ? 'rgba(45,158,107,0.25)'  : bearish ? 'rgba(192,69,62,0.25)'  : 'transparent'
  const labelColor = bullish ? 'var(--green-dark)'       : bearish ? 'var(--pink)'             : 'var(--text-muted)'

  return (
    <div>
      {/* Score hero */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <div>
          <div style={{ fontSize: 9, color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 3 }}>Conviction score</div>
          <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 28, fontWeight: 900, color: scoreColor, letterSpacing: '-0.03em', lineHeight: 1 }}>
            {score >= 0 ? '+' : ''}{score.toFixed(3)}
          </div>
        </div>
        <span style={{ fontSize: 10, fontWeight: 800, color: labelColor, textTransform: 'uppercase', letterSpacing: '0.07em' }}>
          {label || '—'}
        </span>
      </div>

      {/* Sentiment bar: bear → bull */}
      <div style={{ marginBottom: 10 }}>
        <div style={{
          position: 'relative', height: 8, borderRadius: 4,
          background: 'var(--bg-secondary)',
          marginBottom: 4,
        }}>
          {/* Needle */}
          <div style={{
            position: 'absolute', top: '50%', transform: 'translate(-50%,-50%)',
            left: `${barFill * 100}%`,
            width: 14, height: 14, borderRadius: '50%',
            background: scoreColor, border: '2.5px solid white',
            boxShadow: `0 0 8px ${scoreColor}80`,
            transition: 'left 0.9s cubic-bezier(0.34,1.56,0.64,1)',
          }} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 8, color: 'var(--text-muted)' }}>Bearish</span>
          <span style={{ fontSize: 8, color: 'var(--text-muted)' }}>Bullish</span>
        </div>
      </div>

      {/* Sub-signals */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 8, color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 3 }}>Momentum</div>
          <MiniBar value={(output.momentum + 1) / 2} color={output.momentum > 0 ? 'var(--green)' : 'var(--pink)'} height={4} delay={200} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 8, color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 3 }}>Order flow</div>
          <MiniBar value={(output.orderbookSkew + 1) / 2} color={output.orderbookSkew > 0 ? 'var(--green)' : 'var(--pink)'} height={4} delay={260} />
        </div>
      </div>

      {/* Top signals */}
      {(output.signals ?? []).slice(0, 2).map((s: string, i: number) => (
        <div key={i} style={{
          fontSize: 10, color: 'var(--text-secondary)', lineHeight: 1.45,
          borderLeft: `2px solid ${color}55`, paddingLeft: 7, marginBottom: 3,
        }}>
          {s.length > 52 ? s.slice(0, 52) + '…' : s}
        </div>
      ))}

      {/* Model */}
      {output.provider && (
        <div style={{ marginTop: 6, fontFamily: 'var(--font-geist-mono)', fontSize: 9, color: 'var(--text-muted)', opacity: 0.7 }}>
          {shortenProvider(output.provider)}
        </div>
      )}
    </div>
  )
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ProbabilityBody({ output, color, aiMode }: { output: any; color: string; aiMode?: boolean }) {
  const pModel  = output.pModel  ?? 0
  const pMarket = output.pMarket ?? 0
  const edgePct = output.edgePct ?? 0
  const rec     = output.recommendation ?? 'NO_TRADE'
  const conf    = output.confidence ?? 'low'

  const recColor  = rec === 'YES' ? 'var(--green)' : rec === 'NO' ? 'var(--blue)' : 'var(--text-muted)'
  const edgeColor = edgePct >= 0 ? 'var(--green-dark)' : 'var(--pink)'
  const edgeBg    = edgePct >= 0 ? 'rgba(45,158,107,0.1)' : 'rgba(192,69,62,0.1)'
  const edgeBdr   = edgePct >= 0 ? 'rgba(45,158,107,0.22)' : 'rgba(192,69,62,0.22)'

  const confColor = conf === 'high' ? 'var(--green-dark)' : conf === 'medium' ? 'var(--amber)' : 'var(--text-muted)'
  const confBg    = conf === 'high' ? 'rgba(45,158,107,0.1)' : conf === 'medium' ? 'rgba(184,121,10,0.1)' : 'rgba(0,0,0,0.05)'

  return (
    <div>
      {/* Recommendation + pModel hero */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 9, color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 3 }}>P(YES) — model</div>
          <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 28, fontWeight: 900, color: recColor, letterSpacing: '-0.03em', lineHeight: 1 }}>
            {(pModel * 100).toFixed(1)}%
          </div>
        </div>

        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 8, color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 }}>Edge</div>
          <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 18, fontWeight: 900, color: edgeColor, lineHeight: 1 }}>
            {edgePct >= 0 ? '+' : ''}{edgePct.toFixed(1)}%
          </div>
        </div>
      </div>

      {/* Model vs Market bars */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
        {/* Model */}
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
            <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              {aiMode ? 'Grok' : 'Model'}
            </span>
            <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 10, fontWeight: 800, color: recColor }}>{(pModel * 100).toFixed(1)}%</span>
          </div>
          <MiniBar value={pModel} color={recColor} bg="rgba(0,0,0,0.07)" height={7} delay={120} />
        </div>

        {/* Market */}
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
            <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Market</span>
            <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 10, fontWeight: 800, color: 'var(--text-secondary)' }}>{(pMarket * 100).toFixed(1)}%</span>
          </div>
          <MiniBar value={pMarket} color="var(--text-muted)" bg="rgba(0,0,0,0.07)" height={7} delay={200} />
        </div>
      </div>

      {/* Rec + Conf */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <span style={{ fontSize: 10, fontWeight: 900, color: recColor, letterSpacing: '0.04em' }}>
          {rec === 'YES' ? 'BUY YES' : rec === 'NO' ? 'BUY NO' : 'PASS'}
        </span>
        <span style={{ fontSize: 9, fontWeight: 700, color: confColor, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{conf}</span>
        {output.gkVol15m != null && (
          <span style={{ fontSize: 9, color: 'var(--text-muted)', fontFamily: 'var(--font-geist-mono)', marginLeft: 'auto' }}>
            σ={((output.gkVol15m ?? 0) * 100).toFixed(2)}%
          </span>
        )}
      </div>

      {/* Model */}
      {output.provider && (
        <div style={{ marginTop: 6, fontFamily: 'var(--font-geist-mono)', fontSize: 9, color: 'var(--text-muted)', opacity: 0.7 }}>
          {shortenProvider(output.provider)}
        </div>
      )}
    </div>
  )
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function RiskBody({ output, color, aiMode }: { output: any; color: string; aiMode?: boolean }) {
  const approved = output.approved
  const approvedColor = approved ? 'var(--green)' : 'var(--pink)'
  const approvedBg    = approved ? 'rgba(45,158,107,0.1)' : 'rgba(192,69,62,0.1)'
  const approvedBdr   = approved ? 'rgba(45,158,107,0.25)' : 'rgba(192,69,62,0.25)'

  return (
    <div>
      {/* Approved / Rejected hero */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <span style={{ fontSize: 15, color: approvedColor }}>{approved ? '✓' : '✕'}</span>
        <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 15, fontWeight: 900, color: approvedColor, letterSpacing: '0.03em' }}>
          {approved ? 'APPROVED' : 'BLOCKED'}
        </span>
        {approved && (
          <span style={{ fontSize: 9, color: 'var(--text-muted)', fontWeight: 600 }}>
            {aiMode ? 'Grok AI sizing' : 'Kelly sizing applied'}
          </span>
        )}
      </div>

      {approved && (
        <>
          {/* Size */}
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 9, color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 3 }}>Position size</div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 5 }}>
              <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 22, fontWeight: 900, color, lineHeight: 1 }}>
                {output.positionSize ?? '—'}
              </span>
              <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600 }}>contracts</span>
            </div>
          </div>

          <Fact label="Max loss" value={output.maxLoss != null ? `$${output.maxLoss.toFixed(2)}` : '—'} color="var(--pink)" />
        </>
      )}

      {!approved && output.rejectionReason && (
        <div style={{
          fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', lineHeight: 1.65,
          borderLeft: '2px solid var(--border-bright)', paddingLeft: 8,
          whiteSpace: 'pre-wrap',
        }}>
          {output.rejectionReason}
        </div>
      )}
    </div>
  )
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ExecutionBody({ output, color }: { output: any; color: string }) {
  const action  = output.action ?? 'PASS'
  const cost    = output.estimatedCost ?? 0
  const payout  = output.estimatedPayout ?? 0
  const roi     = cost > 0 ? ((payout - cost) / cost) * 100 : 0
  const isPass  = action === 'PASS'

  const actionColor = action === 'BUY_YES' ? 'var(--green)' : action === 'BUY_NO' ? 'var(--blue)' : 'var(--text-muted)'
  const actionBg    = action === 'BUY_YES' ? 'rgba(45,158,107,0.12)' : action === 'BUY_NO' ? 'rgba(58,114,168,0.12)' : 'rgba(0,0,0,0.05)'
  const actionBdr   = action === 'BUY_YES' ? 'rgba(45,158,107,0.28)' : action === 'BUY_NO' ? 'rgba(58,114,168,0.28)' : 'transparent'

  // Cost bar: cost as fraction of payout
  const costFill  = payout > 0 ? Math.min(1, cost / payout) : 0

  return (
    <div>
      {/* Action hero */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 9, color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 5 }}>Order</div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 16, fontWeight: 900, color: actionColor, letterSpacing: '0.02em' }}>
              {action.replace('_', ' ')}
            </span>
            {output.limitPrice != null && (
              <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)' }}>
                {output.limitPrice}¢
              </span>
            )}
          </div>
        </div>

        {/* ROI badge */}
        {!isPass && cost > 0 && (
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 8, color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 }}>ROI if win</div>
            <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 18, fontWeight: 900, color, lineHeight: 1 }}>
              +{roi.toFixed(1)}%
            </div>
          </div>
        )}
      </div>

      {!isPass && (
        <>
          {/* Cost vs Payout */}
          <div style={{ display: 'flex', gap: 12, marginBottom: 10 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 9, color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 }}>Cost</div>
              <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 16, fontWeight: 800, color: 'var(--text-primary)' }}>${cost.toFixed(2)}</div>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 9, color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 }}>Payout</div>
              <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 16, fontWeight: 800, color }}>
                ${payout.toFixed(2)}
              </div>
            </div>
          </div>

          {/* Cost vs Payout bar */}
          <div style={{ marginBottom: 8 }}>
            <div style={{ position: 'relative', height: 8, borderRadius: 4, background: `rgba(${color === 'var(--green)' ? '74,148,112' : '74,127,165'},0.15)`, overflow: 'hidden' }}>
              {/* Cost fill */}
              <MiniBar value={costFill} color="rgba(0,0,0,0.2)" height={8} delay={160} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 3 }}>
              <span style={{ fontSize: 8, color: 'var(--text-muted)' }}>cost</span>
              <span style={{ fontSize: 8, color: 'var(--text-muted)' }}>payout</span>
            </div>
          </div>

          <Fact label="Contracts" value={`${output.contracts ?? '—'}`} color={color} />
        </>
      )}

      {isPass && (
        <div style={{ fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic', lineHeight: 1.5 }}>
          No trade this cycle — insufficient edge or risk limit reached.
        </div>
      )}
    </div>
  )
}

// ── AgentCard ─────────────────────────────────────────────────────────────────
function AgentCard({
  agent,
  result,
  index,
  pipelineRunning,
  aiMode,
}: {
  agent: typeof AGENTS_QUANT[0]
  result?: PipelineState['agents'][keyof PipelineState['agents']]
  index: number
  pipelineRunning?: boolean
  aiMode?: boolean
}) {
  const status: AgentStatus = result?.status ?? 'idle'
  const done    = status === 'done'
  const skipped = status === 'skipped'
  const pending = pipelineRunning && !done && !skipped

  return (
    <div style={{
      padding: '16px 16px 14px',
      borderRadius: 14,
      background: (done || skipped) ? agent.bg : pending ? 'var(--bg-secondary)' : 'rgba(255,255,255,0.5)',
      border: `1px solid ${(done || skipped) ? agent.border : pending ? 'var(--border-bright)' : 'var(--border)'}`,
      position: 'relative', overflow: 'hidden',
      transition: 'background 0.35s, border-color 0.35s, box-shadow 0.35s',
      boxShadow: done ? `0 3px 20px rgba(${agent.rgb},0.13)` : 'none',
      animation: 'none',
    }}>
      {/* Top accent bar */}
      {(done || skipped) && (
        <div style={{
          position: 'absolute', top: 0, left: 0, right: 0, height: 3,
          background: done ? agent.color : 'var(--amber)',
          borderRadius: '14px 14px 0 0',
        }} />
      )}

      {/* Step number */}
      <div style={{
        position: 'absolute', top: 13, right: 13,
        fontFamily: 'var(--font-geist-mono)', fontSize: 9, fontWeight: 700,
        color: (done || skipped) ? agent.color : 'var(--text-light)',
        opacity: 0.55, letterSpacing: '0.04em',
      }}>
        {String(index + 1).padStart(2, '0')}
      </div>

      {/* Icon + label row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <div style={{
          width: 36, height: 36, borderRadius: 9, flexShrink: 0,
          background: (done || skipped) ? `rgba(${agent.rgb},0.15)` : 'var(--bg-secondary)',
          border: `1.5px solid ${(done || skipped) ? agent.border : 'var(--border)'}`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 16, color: done ? agent.color : 'var(--text-light)',
          animation: 'none',
          transition: 'all 0.3s',
        }}>{agent.icon}</div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: 13, fontWeight: 800, letterSpacing: '-0.02em',
            color: (done || skipped) ? 'var(--text-primary)' : 'var(--text-muted)',
            lineHeight: 1.2,
          }}>{agent.label}</div>
          {done && (
            <div style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 2, fontFamily: 'var(--font-geist-mono)', opacity: 0.7 }}>
              {agent.desc}
            </div>
          )}
        </div>

        {done    && <span style={{ fontSize: 14, color: agent.color, flexShrink: 0, marginRight: 18 }}>✓</span>}
        {skipped && <span style={{ fontSize: 12, color: 'var(--amber)', flexShrink: 0, marginRight: 18 }}>—</span>}
      </div>

      {/* Card body */}
      <div style={{ borderTop: `1px solid rgba(${agent.rgb},0.14)`, paddingTop: 12 }}>
        {result ? (() => {
          const o = result.output
          if (agent.key === 'marketDiscovery') return <MarketDiscoveryBody output={o} color={agent.color} />
          if (agent.key === 'priceFeed')       return <PriceFeedBody       output={o} color={agent.color} />
          if (agent.key === 'sentiment')       return <SentimentBody       output={o} color={agent.color} />
          if (agent.key === 'probability')     return <ProbabilityBody     output={o} color={agent.color} aiMode={aiMode} />
          if (agent.key === 'risk')            return <RiskBody            output={o} color={agent.color} aiMode={aiMode} />
          if (agent.key === 'execution')       return <ExecutionBody       output={o} color={agent.color} />
          return null
        })() : pending ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11, color: 'var(--text-muted)', padding: '6px 0' }}>
            <span style={{ animation: 'spin-slow 1s linear infinite', display: 'inline-block', fontSize: 13 }}>◌</span>
            Computing…
          </div>
        ) : (
          <div style={{ fontSize: 11, color: 'var(--text-light)', fontStyle: 'italic', padding: '4px 0' }}>
            Awaiting pipeline run…
          </div>
        )}
      </div>

      {/* Duration */}
      {result?.durationMs != null && (
        <div style={{ marginTop: 10, fontSize: 9, color: 'var(--text-muted)', fontFamily: 'var(--font-geist-mono)', opacity: 0.55 }}>
          {result.durationMs >= 1000 ? (result.durationMs / 1000).toFixed(1) + 's' : result.durationMs + 'ms'}
        </div>
      )}
    </div>
  )
}

// ── Main export ──────────────────────────────────────────────────────────────
export default function AgentPipeline({
  pipeline,
  isRunning,
  streamingAgents,
  aiMode,
}: {
  pipeline: PipelineState | null
  isRunning: boolean
  streamingAgents?: PartialPipelineAgents
  aiMode?: boolean
}) {
  const [elapsedMs, setElapsedMs]   = useState(0)
  const [dataAgeSec, setDataAgeSec] = useState(0)
  const startRef = useRef<number | null>(null)

  useEffect(() => {
    if (isRunning) {
      startRef.current = Date.now()
      setElapsedMs(0)
      const id = setInterval(() => setElapsedMs(Date.now() - (startRef.current ?? Date.now())), 250)
      return () => clearInterval(id)
    }
  }, [isRunning])

  useEffect(() => {
    if (!pipeline?.cycleCompletedAt) return
    const completedAt = new Date(pipeline.cycleCompletedAt).getTime()
    const tick = () => setDataAgeSec(Math.floor((Date.now() - completedAt) / 1000))
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [pipeline?.cycleCompletedAt])

  return (
    <div className="card" style={{ padding: '18px 18px 16px' }}>
      {/* Header */}
      <div style={{ marginBottom: isRunning ? 10 : 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: isRunning ? 8 : 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.01em' }}>
            {aiMode
              ? <><span style={{ color: 'var(--blue)', fontSize: 12 }}>✦</span> Grok AI Agent</>
              : <><span style={{ color: 'var(--brown)', fontSize: 11 }}>∑</span> Quant Pipeline</>}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {pipeline && <span style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--font-geist-mono)' }}>cycle #{pipeline.cycleId}</span>}
          </div>
        </div>
        {/* Scan bar — visible whenever pipeline is running */}
        {isRunning && (
          <div style={{ position: 'relative', height: 2, borderRadius: 1, background: 'var(--border)', overflow: 'hidden' }}>
            <div style={{
              position: 'absolute', top: 0, left: 0, height: '100%', width: '40%',
              background: 'var(--green)',
              animation: 'scanLine 1.2s ease-in-out infinite',
              opacity: 0.7,
            }} />
          </div>
        )}
      </div>

      {/* Body */}
      {isRunning && !Object.keys(streamingAgents ?? {}).length ? (
        <ScanLoader elapsed={elapsedMs} aiMode={aiMode} />
      ) : (isRunning || pipeline) ? (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            {(aiMode ? AGENTS_AI : AGENTS_QUANT).map((agent, i) => {
              const result = isRunning
                ? streamingAgents?.[agent.key]
                : pipeline?.agents[agent.key]
              return <AgentCard key={agent.key} agent={agent} result={result} index={i} pipelineRunning={isRunning} aiMode={aiMode} />
            })}
          </div>

          {pipeline?.cycleCompletedAt && pipeline?.cycleStartedAt && (() => {
            const ms   = new Date(pipeline.cycleCompletedAt!).getTime() - new Date(pipeline.cycleStartedAt).getTime()
            const mins = Math.floor(ms / 60000)
            const secs = Math.floor((ms % 60000) / 1000)
            const ds   = Math.floor((ms % 1000) / 100)
            const runStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}.${ds}s`

            const ageMins  = Math.floor(dataAgeSec / 60)
            const ageSecs  = dataAgeSec % 60
            const ageStr   = ageMins > 0 ? `${ageMins}m ${ageSecs}s ago` : `${ageSecs}s ago`
            const stale    = dataAgeSec >= 300
            const aging    = dataAgeSec >= 150
            const ageColor = stale ? 'var(--pink)' : aging ? 'var(--amber)' : 'var(--text-muted)'
            const ageBg    = stale ? 'rgba(212,85,130,0.07)' : aging ? 'rgba(212,135,44,0.07)' : 'transparent'
            const ageBdr   = stale ? 'rgba(212,85,130,0.3)'  : aging ? 'rgba(212,135,44,0.3)'  : 'transparent'

            return (
              <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                {isRunning ? (
                  <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 10, color: 'var(--text-muted)', opacity: 0.5 }}>updating…</span>
                ) : (
                  <div style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    padding: '4px 10px', borderRadius: 7,
                    background: ageBg, border: `1px solid ${ageBdr}`,
                    transition: 'all 0.4s ease',
                  }}>
                    <span style={{ fontSize: 9, color: ageColor, opacity: stale || aging ? 1 : 0.55 }}>
                      {stale ? '⚠' : '◷'}
                    </span>
                    <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 10, color: ageColor }}>{ageStr}</span>
                  </div>
                )}

                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    padding: '4px 10px', borderRadius: 7,
                    background: 'rgba(45,158,107,0.07)',
                    border: '1px solid rgba(45,158,107,0.18)',
                  }}>
                    <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 10, color: 'var(--green-dark)' }}>
                      › {runStr}
                    </span>
                  </div>
                  <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 9, color: 'var(--text-muted)', opacity: 0.45 }}>
                    {new Date(pipeline.cycleCompletedAt!).toLocaleTimeString('en-US', { hour12: false })}
                  </span>
                </div>
              </div>
            )
          })()}
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
