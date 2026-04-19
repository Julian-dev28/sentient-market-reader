'use client'

import { useState, useEffect, useRef } from 'react'
import type {
  PipelineState,
  PartialPipelineAgents,
  AgentStatus,
  MarketDiscoveryOutput,
  PriceFeedOutput,
  SentimentOutput,
  ProbabilityOutput,
  MarkovOutput,
  ExecutionOutput,
  RiskOutput,
} from '@/lib/types'

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

// ── Agent card config ────────────────────────────────────────────────────────
type AgentCardConfig = {
  key: keyof PipelineState['agents']
  label: string
  short: string
  icon: string
  desc: string
  color: string
  rgb: string
  bg: string
  border: string
}

// ── Agent cards (post-run results) ──────────────────────────────────────────
const AGENTS_QUANT: AgentCardConfig[] = [
  { key: 'marketDiscovery' as const, label: 'Market Discovery', short: 'MARKET',    icon: '◎', desc: 'KXBTC15M scan',        color: 'var(--brown)',  rgb: '74,124,142',  bg: 'var(--brown-pale)', border: 'rgba(74,124,142,0.22)' },
  { key: 'priceFeed'       as const, label: 'Price Feed',       short: 'PRICE',     icon: '◈', desc: 'Coinbase BTC feed',    color: 'var(--green)',  rgb: '45,158,107',  bg: 'var(--green-pale)', border: 'rgba(45,158,107,0.22)' },
  { key: 'markov'          as const, label: 'Markov Gate',      short: 'GATE',      icon: '⬙', desc: 'momentum regime gate', color: 'var(--pink)',   rgb: '212,85,130',  bg: 'var(--pink-pale)',  border: 'rgba(212,85,130,0.22)' },
  { key: 'sentiment'       as const, label: 'Risk Manager',     short: 'RISK',      icon: '◉', desc: 'tiered Kelly sizing',   color: 'var(--blue)',   rgb: '58,114,168',  bg: 'var(--blue-pale)',  border: 'rgba(58,114,168,0.22)' },
  { key: 'probability'     as const, label: 'Probability',      short: 'PROB',      icon: '⬟', desc: 'Brownian + d-gate',   color: 'var(--amber)',  rgb: '184,121,10',  bg: 'var(--amber-pale)', border: 'rgba(184,121,10,0.22)' },
  { key: 'execution'       as const, label: 'Execution',        short: 'EXEC',      icon: '▶', desc: 'paper order',          color: 'var(--green)',  rgb: '45,158,107',  bg: 'var(--green-pale)', border: 'rgba(45,158,107,0.22)' },
]

const AGENTS_AI: AgentCardConfig[] = [
  { key: 'marketDiscovery' as const, label: 'Market Discovery', short: 'MARKET',    icon: '◎', desc: 'KXBTC15M scan',        color: 'var(--brown)',  rgb: '74,124,142',  bg: 'var(--brown-pale)', border: 'rgba(74,124,142,0.22)' },
  { key: 'priceFeed'       as const, label: 'Price Feed',       short: 'PRICE',     icon: '◈', desc: 'Coinbase BTC feed',    color: 'var(--green)',  rgb: '45,158,107',  bg: 'var(--green-pale)', border: 'rgba(45,158,107,0.22)' },
  { key: 'markov'          as const, label: 'Markov Gate',      short: 'GATE',      icon: '⬙', desc: 'momentum regime gate', color: 'var(--pink)',   rgb: '212,85,130',  bg: 'var(--pink-pale)',  border: 'rgba(212,85,130,0.22)' },
  { key: 'sentiment'       as const, label: 'Risk Manager',     short: 'RISK',      icon: '◉', desc: 'tiered Kelly sizing',   color: 'var(--blue)',   rgb: '58,114,168',  bg: 'var(--blue-pale)',  border: 'rgba(58,114,168,0.22)' },
  { key: 'probability'     as const, label: 'Probability',      short: 'PROB',      icon: '⬟', desc: 'Grok AI',              color: 'var(--amber)',  rgb: '184,121,10',  bg: 'var(--amber-pale)', border: 'rgba(184,121,10,0.22)' },
  { key: 'execution'       as const, label: 'Execution',        short: 'EXEC',      icon: '▶', desc: 'Grok order',           color: 'var(--green)',  rgb: '45,158,107',  bg: 'var(--green-pale)', border: 'rgba(45,158,107,0.22)' },
]

// Hourly KXBTCD + quant pipeline
const AGENTS_QUANT_HOURLY: AgentCardConfig[] = [
  { key: 'marketDiscovery' as const, label: 'Market Discovery', short: 'MARKET',   icon: '◎', desc: 'KXBTCD hourly scan',   color: 'var(--brown)',  rgb: '74,124,142',  bg: 'var(--brown-pale)', border: 'rgba(74,124,142,0.22)' },
  { key: 'priceFeed'       as const, label: 'Price Feed',       short: 'PRICE',    icon: '◈', desc: 'Coinbase BTC feed',    color: 'var(--green)',  rgb: '45,158,107',  bg: 'var(--green-pale)', border: 'rgba(45,158,107,0.22)' },
  { key: 'markov'          as const, label: 'Markov Gate',      short: 'GATE',     icon: '⬙', desc: 'momentum regime gate', color: 'var(--pink)',   rgb: '212,85,130',  bg: 'var(--pink-pale)',  border: 'rgba(212,85,130,0.22)' },
  { key: 'sentiment'       as const, label: 'Sentiment',        short: 'SENTIMENT',icon: '◉', desc: 'ROMA quant signals',   color: 'var(--blue)',   rgb: '58,114,168',  bg: 'var(--blue-pale)',  border: 'rgba(58,114,168,0.22)' },
  { key: 'probability'     as const, label: 'Probability',      short: 'PROB',     icon: '⬟', desc: 'Hourly P(YES) model',  color: 'var(--amber)',  rgb: '184,121,10',  bg: 'var(--amber-pale)', border: 'rgba(184,121,10,0.22)' },
  { key: 'execution'       as const, label: 'Execution',        short: 'EXEC',     icon: '▶', desc: 'KXBTCD order',         color: 'var(--green)',  rgb: '45,158,107',  bg: 'var(--green-pale)', border: 'rgba(45,158,107,0.22)' },
]

// Hourly KXBTCD mode — Grok price-prediction pipeline, different semantics
const AGENTS_HOURLY: AgentCardConfig[] = [
  { key: 'marketDiscovery' as const, label: 'Market Discovery', short: 'MARKET',   icon: '◎', desc: 'KXBTCD hourly scan',   color: 'var(--brown)',  rgb: '74,124,142',  bg: 'var(--brown-pale)', border: 'rgba(74,124,142,0.22)' },
  { key: 'priceFeed'       as const, label: 'Price Feed',       short: 'PRICE',    icon: '◈', desc: 'Coinbase BTC feed',    color: 'var(--green)',  rgb: '45,158,107',  bg: 'var(--green-pale)', border: 'rgba(45,158,107,0.22)' },
  { key: 'markov'          as const, label: 'Markov Gate',      short: 'GATE',     icon: '⬙', desc: 'momentum regime gate', color: 'var(--pink)',   rgb: '212,85,130',  bg: 'var(--pink-pale)',  border: 'rgba(212,85,130,0.22)' },
  { key: 'sentiment'       as const, label: 'Grok Forecast',    short: 'FORECAST', icon: '◉', desc: 'Price prediction',     color: 'var(--blue)',   rgb: '58,114,168',  bg: 'var(--blue-pale)',  border: 'rgba(58,114,168,0.22)' },
  { key: 'probability'     as const, label: 'Price Model',      short: 'MODEL',    icon: '⬟', desc: 'Predicted vs strike',  color: 'var(--amber)',  rgb: '184,121,10',  bg: 'var(--amber-pale)', border: 'rgba(184,121,10,0.22)' },
  { key: 'execution'       as const, label: 'Execution',        short: 'EXEC',     icon: '▶', desc: 'Grok order',           color: 'var(--green)',  rgb: '45,158,107',  bg: 'var(--green-pale)', border: 'rgba(45,158,107,0.22)' },
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

function MarketDiscoveryBody({ output, color, isHourly }: { output: MarketDiscoveryOutput; color: string; isHourly?: boolean }) {
  const mins  = output.minutesUntilExpiry ?? 0
  const windowMins = isHourly ? 60 : 15
  const urgency = mins < (isHourly ? 10 : 3) ? 'var(--pink)' : mins < (isHourly ? 20 : 7) ? 'var(--amber)' : color
  const fillPct = Math.min(1, mins / windowMins)

  return (
    <div>
      <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 10, fontWeight: 700, color, letterSpacing: '0.04em', marginBottom: 10 }}>
        {output.activeMarket?.ticker ?? '—'}
      </div>

      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 8, color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 2 }}>Strike price</div>
        <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 20, fontWeight: 900, color: 'var(--text-primary)', letterSpacing: '-0.03em', lineHeight: 1 }}>
          {output.strikePrice ? `$${output.strikePrice.toLocaleString('en-US', { maximumFractionDigits: 2 })}` : '—'}
        </div>
      </div>

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

function PriceFeedBody({ output, color }: { output: PriceFeedOutput; color: string }) {
  const dist  = output.distanceFromStrikePct ?? 0
  const above = dist >= 0
  const dir1h = (output.priceChangePct1h ?? 0) >= 0

  return (
    <div>
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 8, color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 2 }}>BTC / USD</div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
          <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 20, fontWeight: 900, color: 'var(--text-primary)', letterSpacing: '-0.03em', lineHeight: 1 }}>
            {output.currentPrice ? `$${output.currentPrice.toLocaleString('en-US', { maximumFractionDigits: 2 })}` : '—'}
          </span>
          <span style={{ fontSize: 12, color: dir1h ? 'var(--green)' : 'var(--pink)' }}>{dir1h ? '▲' : '▼'}</span>
        </div>
      </div>

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

function SentimentBody({ output, color }: { output: SentimentOutput; color: string }) {
  const score   = output.score ?? 0
  const bullish = score > 0.1
  const bearish = score < -0.1
  const scoreColor = bullish ? 'var(--green)' : bearish ? 'var(--pink)' : 'var(--text-muted)'
  const label = (output.label ?? '').replace(/_/g, ' ')
  // Map score -1→+1 to 0→1 fill
  const barFill = (score + 1) / 2

  const labelColor = bullish ? 'var(--green-dark)' : bearish ? 'var(--pink)' : 'var(--text-muted)'

  return (
    <div>
      <div style={{ marginBottom: 8 }}>
        <div style={{ fontSize: 8, color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 3 }}>Conviction score</div>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
          <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 28, fontWeight: 900, color: scoreColor, letterSpacing: '-0.04em', lineHeight: 1 }}>
            {score >= 0 ? '+' : ''}{score.toFixed(3)}
          </div>
          <span style={{ fontSize: 11, fontWeight: 800, color: labelColor, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            {label || '—'}
          </span>
        </div>
      </div>

      <div style={{ marginBottom: 10 }}>
        <div style={{
          position: 'relative', height: 8, borderRadius: 4,
          background: 'var(--bg-secondary)',
          marginBottom: 4,
        }}>
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

      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 8, color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 3 }}>Momentum</div>
          <MiniBar value={(output.momentum + 1) / 2} color={output.momentum > 0 ? 'var(--green)' : 'var(--pink)'} height={5} delay={200} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 8, color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 3 }}>Order flow</div>
          <MiniBar value={(output.orderbookSkew + 1) / 2} color={output.orderbookSkew > 0 ? 'var(--green)' : 'var(--pink)'} height={5} delay={260} />
        </div>
      </div>

      {output.signals.slice(0, 2).map((s, i) => (
        <div key={i} style={{
          fontSize: 10, color: 'var(--text-secondary)', lineHeight: 1.45,
          borderLeft: `2px solid ${color}55`, paddingLeft: 7, marginBottom: 3,
        }}>
          {s.length > 52 ? s.slice(0, 52) + '…' : s}
        </div>
      ))}

      {output.provider && (
        <div style={{ marginTop: 6, fontFamily: 'var(--font-geist-mono)', fontSize: 9, color: 'var(--text-muted)', opacity: 0.7 }}>
          {shortenProvider(output.provider)}
        </div>
      )}
    </div>
  )
}

function ProbabilityBody({ output, color, aiMode }: { output: ProbabilityOutput; color: string; aiMode?: boolean }) {
  const pModel  = output.pModel  ?? 0
  const pMarket = output.pMarket ?? 0
  const edgePct = output.edgePct ?? 0
  const rec     = output.recommendation ?? 'NO_TRADE'
  const conf    = output.confidence ?? 'low'

  const recColor  = rec === 'YES' ? 'var(--green)' : rec === 'NO' ? 'var(--blue)' : 'var(--text-muted)'
  const edgeColor = edgePct >= 0 ? 'var(--green-dark)' : 'var(--pink)'
  const confColor = conf === 'high' ? 'var(--green-dark)' : conf === 'medium' ? 'var(--amber)' : 'var(--text-muted)'

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 10 }}>
        <div>
          <div style={{ fontSize: 8, color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 2 }}>P(YES) — model</div>
          <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 28, fontWeight: 900, color: recColor, letterSpacing: '-0.04em', lineHeight: 1 }}>
            {(pModel * 100).toFixed(1)}%
          </div>
        </div>

        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 8, color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 2 }}>Edge</div>
          <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 18, fontWeight: 900, color: edgeColor, lineHeight: 1 }}>
            {edgePct >= 0 ? '+' : ''}{edgePct.toFixed(1)}%
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
            <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              {aiMode ? 'Grok' : 'Model'}
            </span>
            <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 10, fontWeight: 800, color: recColor }}>{(pModel * 100).toFixed(1)}%</span>
          </div>
          <MiniBar value={pModel} color={recColor} bg="rgba(0,0,0,0.07)" height={7} delay={120} />
        </div>

        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
            <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Market</span>
            <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 10, fontWeight: 800, color: 'var(--text-secondary)' }}>{(pMarket * 100).toFixed(1)}%</span>
          </div>
          <MiniBar value={pMarket} color="var(--text-muted)" bg="rgba(0,0,0,0.07)" height={7} delay={200} />
        </div>
      </div>

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

      {output.provider && (
        <div style={{ marginTop: 6, fontFamily: 'var(--font-geist-mono)', fontSize: 9, color: 'var(--text-muted)', opacity: 0.7 }}>
          {shortenProvider(output.provider)}
        </div>
      )}
    </div>
  )
}

function MarkovBody({ output, color }: { output: MarkovOutput; color: string }) {
  const approved  = output.approved  ?? false
  const enterYes  = output.enterYes  ?? false
  const enterNo   = output.enterNo   ?? false
  const persist   = output.persist   ?? 0
  const tau       = output.tau       ?? 0.80
  const pYes      = output.pHatYes   ?? 0
  const pNo       = output.pHatNo    ?? 0
  const histLen   = output.historyLength ?? 0
  const stateLbl  = output.stateLabel   ?? `S${output.currentState ?? '?'}`
  const rec       = output.recommendation ?? 'NO_TRADE'
  const expDrift  = output.expectedDriftPct ?? 0
  const reqDrift  = output.requiredDriftPct ?? 0
  const sigma     = output.sigma    ?? 0
  const zScore    = output.zScore   ?? 0

  const dirColor  = rec === 'YES' ? 'var(--green)' : rec === 'NO' ? 'var(--blue)' : 'var(--text-muted)'
  const strong    = enterYes || enterNo
  const strongLbl = enterYes ? 'strong YES' : enterNo ? 'strong NO' : null

  // Signal strength bar: how far p is from 50/50 (0% = coin flip, 100% = certain)
  const signalPct = Math.min(100, Math.abs(pYes - 0.5) * 200)

  // Human-readable momentum label
  const trendLabel = stateLbl.includes('flat') || stateLbl.includes('±')
    ? 'flat'
    : (stateLbl.includes('−') || stateLbl.startsWith('<'))
    ? 'falling'
    : 'rising'

  // How far BTC needs to move to cross the strike
  const gapAbs = Math.abs(reqDrift)
  const gapLabel = gapAbs < 0.01
    ? 'already past strike'
    : `needs ${reqDrift >= 0 ? '+' : '−'}${gapAbs.toFixed(3)}% to cross`

  return (
    <div>
      {/* Direction */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <div>
          <div style={{ fontSize: 8, color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 2 }}>Momentum predicts</div>
          <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 22, fontWeight: 900, color: dirColor, letterSpacing: '0.02em', lineHeight: 1 }}>
            {approved ? (rec === 'YES' ? 'ABOVE' : 'BELOW') : histLen < 20 ? 'BUILDING…' : 'BLOCKED'}
          </div>
          {approved && (
            <div style={{ fontSize: 10, color: 'var(--text-secondary)', fontWeight: 700, marginTop: 3 }}>
              {rec === 'YES'
                ? `${(pYes * 100).toFixed(1)}% chance BTC finishes above strike`
                : `${(pNo  * 100).toFixed(1)}% chance BTC finishes below strike`}
            </div>
          )}
        </div>
        <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
          <div style={{ fontSize: 8, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 1 }}>BTC trend</div>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', fontFamily: 'var(--font-geist-mono)', textTransform: 'capitalize' }}>{trendLabel}</div>
        </div>
      </div>

      {/* Signal strength bar */}
      {approved && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
            <span style={{ fontSize: 8, color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Signal strength</span>
            {strong && <span style={{ fontSize: 9, color: dirColor, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em' }}>★ {strongLbl}</span>}
          </div>
          <div style={{ height: 4, background: 'var(--border-color)', borderRadius: 2, overflow: 'hidden' }}>
            <div style={{ width: `${signalPct}%`, height: '100%', background: dirColor, borderRadius: 2, transition: 'width 0.4s ease' }} />
          </div>
        </div>
      )}

      {/* Building history notice */}
      {!approved && output.rejectionReason && (
        <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5, marginBottom: 8 }}>
          {output.rejectionReason}
        </div>
      )}

      {approved && <Fact label="Strike gap"   value={gapLabel} color="var(--text-secondary)" />}
      {approved && <Fact label="Trend locked" value={`Yes (${(persist * 100).toFixed(0)}%)`} color="var(--green-dark)" />}
      <div style={{ marginTop: 4, fontSize: 8, color: 'var(--text-muted)' }}>{histLen} price observations</div>
    </div>
  )
}


function ExecutionBody({ output, color, riskRejectionReason }: { output: ExecutionOutput; color: string; riskRejectionReason?: string }) {
  const action  = output.action ?? 'PASS'
  const cost    = output.estimatedCost ?? 0
  const payout  = output.estimatedPayout ?? 0
  const roi     = cost > 0 ? ((payout - cost) / cost) * 100 : 0
  const isPass  = action === 'PASS'

  const actionColor = action === 'BUY_YES' ? 'var(--green)' : action === 'BUY_NO' ? 'var(--blue)' : 'var(--text-muted)'

  // Cost bar: cost as fraction of payout
  const costFill  = payout > 0 ? Math.min(1, cost / payout) : 0

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 10 }}>
        <div>
          <div style={{ fontSize: 8, color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 3 }}>Order</div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 7 }}>
            <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 20, fontWeight: 900, color: actionColor, letterSpacing: '-0.01em' }}>
              {action.replace('_', ' ')}
            </span>
            {output.limitPrice != null && (
              <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 13, fontWeight: 700, color: 'var(--text-secondary)' }}>
                {output.limitPrice}¢
              </span>
            )}
          </div>
        </div>

        {!isPass && cost > 0 && (
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 8, color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 2 }}>ROI if win</div>
            <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 18, fontWeight: 900, color, lineHeight: 1 }}>
              +{roi.toFixed(1)}%
            </div>
          </div>
        )}
      </div>

      {!isPass && (
        <>
          <div style={{ display: 'flex', gap: 12, marginBottom: 8 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 8, color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 2 }}>Cost</div>
              <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 17, fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.02em' }}>${cost.toFixed(2)}</div>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 8, color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 2 }}>Payout</div>
              <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 17, fontWeight: 800, color, letterSpacing: '-0.02em' }}>
                ${payout.toFixed(2)}
              </div>
            </div>
          </div>

          <div style={{ marginBottom: 8 }}>
            <div style={{ position: 'relative', height: 8, borderRadius: 4, background: `rgba(${color === 'var(--green)' ? '74,148,112' : '74,127,165'},0.15)`, overflow: 'hidden' }}>
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
          {riskRejectionReason ?? 'No trade this cycle — insufficient edge or risk limit reached.'}
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
  isHourly,
  riskRejectionReason,
}: {
  agent: AgentCardConfig
  result?: PipelineState['agents'][keyof PipelineState['agents']]
  index: number
  pipelineRunning?: boolean
  aiMode?: boolean
  isHourly?: boolean
  riskRejectionReason?: string
}) {
  const status: AgentStatus = result?.status ?? 'idle'
  const done    = status === 'done'
  const skipped = status === 'skipped'
  const pending = pipelineRunning && !done && !skipped

  return (
    <div style={{
      padding: '14px 14px 12px',
      borderRadius: 16,
      background: (done || skipped) ? agent.bg : pending ? 'var(--bg-secondary)' : 'var(--bg-card)',
      border: `1px solid ${(done || skipped) ? agent.border : pending ? 'var(--border-bright)' : 'var(--border)'}`,
      position: 'relative', overflow: 'hidden',
      transition: 'background 0.35s, border-color 0.35s, box-shadow 0.35s',
      boxShadow: done ? `0 2px 16px rgba(${agent.rgb},0.10)` : 'none',
    }}>
      {(done || skipped) && (
        <div style={{
          position: 'absolute', top: 0, left: 0, right: 0, height: 2,
          background: done ? agent.color : 'var(--amber)',
          borderRadius: '16px 16px 0 0',
        }} />
      )}

      <div style={{
        position: 'absolute', bottom: -4, right: 10,
        fontFamily: 'var(--font-geist-mono)', fontSize: 60, fontWeight: 900, lineHeight: 1,
        color: 'var(--text-primary)', opacity: (done || skipped) ? 0.04 : 0.025,
        letterSpacing: '-0.04em', pointerEvents: 'none', userSelect: 'none',
      }}>
        {index + 1}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 10 }}>
        <div style={{
          width: 28, height: 28, borderRadius: '50%', flexShrink: 0,
          background: (done || skipped) ? `rgba(${agent.rgb},0.18)` : 'rgba(0,0,0,0.05)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 13, color: done ? agent.color : 'var(--text-light)',
          transition: 'all 0.3s',
        }}>{agent.icon}</div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: 12, fontWeight: 800, letterSpacing: '-0.02em',
            color: (done || skipped) ? 'var(--text-primary)' : 'var(--text-muted)',
            lineHeight: 1.2,
          }}>{agent.label}</div>
          {done && (
            <div style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 1, fontFamily: 'var(--font-geist-mono)', opacity: 0.65 }}>
              {agent.desc}
            </div>
          )}
        </div>

        {done    && <span style={{ fontSize: 11, color: agent.color, flexShrink: 0, opacity: 0.9 }}>✓</span>}
        {skipped && <span style={{ fontSize: 11, color: 'var(--amber)', flexShrink: 0 }}>—</span>}
        {result?.durationMs != null && (
          <span style={{ fontSize: 8, color: 'var(--text-muted)', fontFamily: 'var(--font-geist-mono)', opacity: 0.5, flexShrink: 0 }}>
            {result.durationMs >= 1000 ? (result.durationMs / 1000).toFixed(1) + 's' : result.durationMs + 'ms'}
          </span>
        )}
      </div>

      <div style={{ borderTop: `1px solid rgba(${agent.rgb},0.12)`, paddingTop: 10 }}>
        {result ? (() => {
          if (agent.key === 'marketDiscovery') return <MarketDiscoveryBody output={result.output as MarketDiscoveryOutput} color={agent.color} isHourly={isHourly} />
          if (agent.key === 'priceFeed')       return <PriceFeedBody       output={result.output as PriceFeedOutput}       color={agent.color} />
          if (agent.key === 'sentiment')       return <SentimentBody       output={result.output as SentimentOutput}       color={agent.color} />
          if (agent.key === 'probability')     return <ProbabilityBody     output={result.output as ProbabilityOutput}     color={agent.color} aiMode={aiMode} />
          if (agent.key === 'markov')          return <MarkovBody          output={result.output as MarkovOutput}          color={agent.color} />
          if (agent.key === 'execution')       return <ExecutionBody       output={result.output as ExecutionOutput}       color={agent.color} riskRejectionReason={riskRejectionReason} />
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
    </div>
  )
}

// ── Main export ──────────────────────────────────────────────────────────────
export default function AgentPipeline({
  pipeline,
  isRunning,
  streamingAgents,
  aiMode,
  marketMode,
}: {
  pipeline: PipelineState | null
  isRunning: boolean
  streamingAgents?: PartialPipelineAgents
  aiMode?: boolean
  marketMode?: '15m' | 'hourly'
}) {
  const isHourly = marketMode === 'hourly'
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
      <div style={{ marginBottom: isRunning ? 10 : 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: isRunning ? 8 : 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.01em' }}>
            {isHourly && aiMode
              ? <><span style={{ color: 'var(--pink)', fontSize: 12 }}>◷</span> Grok Hourly Agent</>
              : isHourly && !aiMode
              ? <><span style={{ color: 'var(--brown)', fontSize: 11 }}>∑</span> Quant Hourly</>
              : aiMode
              ? <><span style={{ color: 'var(--blue)', fontSize: 12 }}>✦</span> Grok AI Agent</>
              : <><span style={{ color: 'var(--brown)', fontSize: 11 }}>∑</span> Markov + RiskManager</>}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {pipeline && <span style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--font-geist-mono)' }}>cycle #{pipeline.cycleId}</span>}
          </div>
        </div>
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

      {isRunning && !Object.keys(streamingAgents ?? {}).length ? (
        <ScanLoader elapsed={elapsedMs} aiMode={aiMode} />
      ) : (isRunning || pipeline) ? (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            {(isHourly && aiMode ? AGENTS_HOURLY : isHourly ? AGENTS_QUANT_HOURLY : aiMode ? AGENTS_AI : AGENTS_QUANT).map((agent, i) => {
              const result = isRunning
                ? streamingAgents?.[agent.key]
                : pipeline?.agents[agent.key]
              const riskRejectionReason = agent.key === 'execution'
                ? (pipeline?.agents.risk?.output as RiskOutput | undefined)?.rejectionReason
                : undefined
              return <AgentCard key={agent.key} agent={agent} result={result} index={i} pipelineRunning={isRunning} aiMode={aiMode} isHourly={isHourly} riskRejectionReason={riskRejectionReason} />
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
