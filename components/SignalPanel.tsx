'use client'

import type { ProbabilityOutput, SentimentOutput } from '@/lib/types'

interface SignalPanelProps {
  probability: ProbabilityOutput | null
  sentiment: SentimentOutput | null
}

function ProbBar({ label, value, color, bg }: { label: string; value: number; color: string; bg: string }) {
  const pct = Math.round(value * 100)
  return (
    <div style={{ marginBottom: 11 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
        <span style={{ fontSize: 11, color: 'var(--text-secondary)', fontWeight: 500 }}>{label}</span>
        <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 12, fontWeight: 800, color }}>{pct}%</span>
      </div>
      <div style={{ height: 7, borderRadius: 4, background: 'var(--bg-secondary)', overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, borderRadius: 4, background: `linear-gradient(90deg, ${color}, ${bg})`, transition: 'width 0.7s cubic-bezier(0.34,1.56,0.64,1)' }} />
      </div>
    </div>
  )
}

function SentimentMeter({ score }: { score: number }) {
  const pct   = ((score + 1) / 2) * 100
  const color = score > 0.2 ? 'var(--green)' : score < -0.2 ? 'var(--pink)' : 'var(--amber)'
  const label = score > 0.4 ? 'Strongly Bullish' : score > 0.1 ? 'Bullish' : score < -0.4 ? 'Strongly Bearish' : score < -0.1 ? 'Bearish' : 'Neutral'
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 7 }}>
        <span style={{ fontSize: 11, color: 'var(--text-secondary)', fontWeight: 500 }}>Sentiment</span>
        <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 11, fontWeight: 700, color }}>
          {label} ({score >= 0 ? '+' : ''}{score.toFixed(3)})
        </span>
      </div>
      <div style={{ position: 'relative', height: 10, borderRadius: 5, background: 'linear-gradient(90deg, var(--pink) 0%, var(--amber) 50%, var(--green) 100%)' }}>
        <div style={{
          position: 'absolute', top: -3, width: 16, height: 16, borderRadius: '50%',
          background: color, border: '3px solid var(--bg-card)',
          left: `calc(${pct}% - 8px)`,
          transition: 'left 0.6s cubic-bezier(0.34,1.56,0.64,1)',
          boxShadow: `0 1px 6px ${color}88`, zIndex: 2,
        }} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6 }}>
        <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>Bearish</span>
        <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>Bullish</span>
      </div>
    </div>
  )
}

export default function SignalPanel({ probability, sentiment }: SignalPanelProps) {
  const rec    = probability?.recommendation ?? 'NO_TRADE'
  const recColor = rec === 'YES' ? 'var(--green)' : rec === 'NO' ? 'var(--pink)' : 'var(--text-muted)'
  const recBg    = rec === 'YES' ? 'var(--green-pale)'  : rec === 'NO' ? 'var(--pink-pale)' : 'var(--cream)'
  const recBdr   = rec === 'YES' ? '#b8dfc3'             : rec === 'NO' ? '#e0b0bf'          : 'var(--border)'

  return (
    <div className="card">
      <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 14 }}>Signal Analysis</div>

      {probability ? (
        <>
          {/* Edge + recommendation */}
          <div style={{ padding: '14px 16px', borderRadius: 12, marginBottom: 14, background: recBg, border: `1px solid ${recBdr}` }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <div style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 2 }}>Edge</div>
                <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 28, fontWeight: 800, color: recColor, letterSpacing: '-0.03em' }}>
                  {probability.edge >= 0 ? '+' : ''}{probability.edgePct.toFixed(1)}%
                </div>
                <div style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 2 }}>{probability.confidence} confidence</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>Signal</div>
                <div style={{ padding: '6px 14px', borderRadius: 8, background: recColor + '22', border: `1px solid ${recColor}55`, fontSize: 14, fontWeight: 800, fontFamily: 'var(--font-geist-mono)', color: recColor }}>
                  {rec === 'YES' ? '↑ YES' : rec === 'NO' ? '↓ NO' : '— PASS'}
                </div>
              </div>
            </div>
          </div>

          <ProbBar label="Model P(YES)"  value={probability.pModel}  color="var(--brown)"   bg="var(--amber-pale)" />
          <ProbBar label="Market P(YES)" value={probability.pMarket} color="var(--pink)"    bg="var(--pink-pale)" />
        </>
      ) : (
        <div style={{ padding: '16px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
          Awaiting first cycle...
        </div>
      )}

      {sentiment && (
        <>
          <div style={{ borderTop: '1px solid var(--border)', margin: '14px 0' }} />
          <SentimentMeter score={sentiment.score} />

          <div style={{ marginTop: 12, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {sentiment.signals.map((sig, i) => (
              <span key={i} className="pill pill-cream" style={{ fontSize: 9 }}>{sig}</span>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
