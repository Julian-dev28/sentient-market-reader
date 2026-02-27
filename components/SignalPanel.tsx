'use client'

import { useEffect, useState } from 'react'
import type { ProbabilityOutput, SentimentOutput } from '@/lib/types'

interface SignalPanelProps {
  probability: ProbabilityOutput | null
  sentiment: SentimentOutput | null
}

/** Bar that animates from 0 → target on mount / value change */
function AnimatedBar({ label, sublabel, value, color, bg }: { label: string; sublabel: string; value: number; color: string; bg: string }) {
  const pct = Math.round(value * 100)
  const [width, setWidth] = useState(0)

  useEffect(() => {
    const id = setTimeout(() => setWidth(pct), 80)
    return () => clearTimeout(id)
  }, [pct])

  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, alignItems: 'baseline' }}>
        <div>
          <span style={{ fontSize: 11, color: 'var(--text-secondary)', fontWeight: 600 }}>{label}</span>
          <span style={{ fontSize: 9, color: 'var(--text-light)', marginLeft: 5 }}>{sublabel}</span>
        </div>
        <span style={{
          fontFamily: 'var(--font-geist-mono)', fontSize: 12, fontWeight: 800, color,
          animation: width > 0 ? 'numberPop 0.4s cubic-bezier(0.34,1.56,0.64,1)' : 'none',
        }}>{pct}%</span>
      </div>
      <div style={{ height: 8, borderRadius: 4, background: 'var(--bg-secondary)', overflow: 'hidden', position: 'relative' }}>
        <div style={{
          height: '100%',
          width: `${width}%`,
          borderRadius: 4,
          background: `linear-gradient(90deg, ${color}, ${bg})`,
          transition: 'width 0.8s cubic-bezier(0.34,1.56,0.64,1)',
          position: 'relative',
        }}>
          <div style={{
            position: 'absolute', inset: 0,
            background: 'linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.4) 50%, transparent 100%)',
            backgroundSize: '200% 100%',
            animation: 'shimmer 2.5s ease infinite',
            borderRadius: 4,
          }} />
        </div>
      </div>
    </div>
  )
}

function SentimentMeter({ score }: { score: number }) {
  const [ready, setReady] = useState(false)
  useEffect(() => { setTimeout(() => setReady(true), 120) }, [])

  const pct   = ((score + 1) / 2) * 100
  const color = score > 0.2 ? 'var(--green)' : score < -0.2 ? 'var(--pink)' : 'var(--amber)'
  const label = score > 0.4 ? 'Strongly Bullish' : score > 0.1 ? 'Bullish' : score < -0.4 ? 'Strongly Bearish' : score < -0.1 ? 'Bearish' : 'Neutral'

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, alignItems: 'center' }}>
        <span style={{ fontSize: 11, color: 'var(--text-secondary)', fontWeight: 500 }}>Sentiment</span>
        <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 11, fontWeight: 700, color }}>
          {label} ({score >= 0 ? '+' : ''}{score.toFixed(3)})
        </span>
      </div>
      <div style={{ position: 'relative', height: 10, borderRadius: 5, background: 'linear-gradient(90deg, var(--pink) 0%, var(--amber) 50%, var(--green) 100%)' }}>
        <div style={{
          position: 'absolute', top: -4, width: 18, height: 18, borderRadius: '50%',
          background: color, border: '3px solid var(--bg-card)',
          left: `calc(${ready ? pct : 50}% - 9px)`,
          transition: 'left 0.7s cubic-bezier(0.34,1.56,0.64,1)',
          boxShadow: `0 0 8px ${color}80`,
          zIndex: 2,
        }} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 7 }}>
        <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>Bearish</span>
        <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>Bullish</span>
      </div>
    </div>
  )
}

export default function SignalPanel({ probability, sentiment }: SignalPanelProps) {
  const rec      = probability?.recommendation ?? 'NO_TRADE'
  const recColor = rec === 'YES' ? 'var(--green)' : rec === 'NO' ? 'var(--blue)' : 'var(--text-muted)'
  const recBg    = rec === 'YES' ? 'var(--green-pale)'  : rec === 'NO' ? 'var(--blue-pale)' : 'var(--cream)'
  const recBdr   = rec === 'YES' ? '#9ecfb8'             : rec === 'NO' ? '#a8cce0'          : 'var(--border)'
  const recIcon  = rec === 'YES' ? '↑' : rec === 'NO' ? '↓' : '—'

  const score = sentiment?.score ?? 0
  const sentimentContradictsRec =
    (rec === 'YES' && score < -0.4) ||
    (rec === 'NO'  && score >  0.4)

  return (
    <div className="card">
      <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 14, display: 'flex', alignItems: 'center', gap: 6 }}>
        Signal Analysis
        {probability && (
          <span style={{ marginLeft: 'auto', fontSize: 9, color: 'var(--text-muted)', fontFamily: 'var(--font-geist-mono)' }}>
            {probability.confidence}
          </span>
        )}
      </div>

      {probability ? (
        <>
          {/* Hero recommendation block */}
          <div style={{
            padding: '16px', borderRadius: 14, marginBottom: 14,
            background: recBg, border: `1px solid ${recBdr}`,
            animation: 'scaleIn 0.35s cubic-bezier(0.34,1.56,0.64,1)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <div style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 4 }}>Edge</div>
                <div style={{
                  fontFamily: 'var(--font-geist-mono)', fontSize: 30, fontWeight: 800,
                  color: recColor, letterSpacing: '-0.03em', lineHeight: 1,
                  animation: 'scaleIn 0.4s cubic-bezier(0.34,1.56,0.64,1)',
                }}>
                  {probability.edge >= 0 ? '+' : ''}{probability.edgePct.toFixed(1)}%
                </div>
              </div>

              {/* Signal badge */}
              <div style={{
                padding: '10px 16px', borderRadius: 10,
                background: recColor + '18',
                border: `1px solid ${recColor}44`,
                textAlign: 'center',
                animation: 'scaleIn 0.4s 0.05s cubic-bezier(0.34,1.56,0.64,1) both',
              }}>
                <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 22, fontWeight: 900, color: recColor, lineHeight: 1 }}>
                  {recIcon}
                </div>
                <div style={{ fontSize: 10, fontWeight: 800, color: recColor, marginTop: 3, letterSpacing: '0.06em' }}>
                  {rec === 'YES' ? 'BUY YES' : rec === 'NO' ? 'BUY NO' : 'PASS'}
                </div>
              </div>
            </div>
          </div>

          {sentimentContradictsRec && (
            <div style={{
              padding: '7px 10px', borderRadius: 8, marginBottom: 12,
              background: 'var(--pink-pale)', border: '1px solid #f0a0b8',
              fontSize: 10, color: 'var(--pink)', fontWeight: 600,
              display: 'flex', alignItems: 'center', gap: 6,
            }}>
              <span>⚠</span>
              <span>Sentiment contradicts signal — risk manager will block this trade</span>
            </div>
          )}

          <AnimatedBar
            label="ROMA Forecast"
            sublabel="AI win probability"
            value={probability.pModel}
            color="var(--brown)"
            bg="var(--amber-pale)"
          />
          <AnimatedBar
            label="Kalshi Implied"
            sublabel="crowd odds · YES ask"
            value={probability.pMarket}
            color="var(--pink)"
            bg="var(--pink-pale)"
          />
          {/* Delta row */}
          {(() => {
            const delta = Math.round((probability.pModel - probability.pMarket) * 100)
            const pos = delta > 0
            return (
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: -6, marginBottom: 10 }}>
                <span style={{
                  fontSize: 9, fontFamily: 'var(--font-geist-mono)', fontWeight: 700,
                  color: pos ? 'var(--green-dark)' : 'var(--pink)',
                  background: pos ? 'var(--green-pale)' : 'var(--pink-pale)',
                  padding: '1px 6px', borderRadius: 4,
                }}>
                  {pos ? '+' : ''}{delta}pp gap
                </span>
              </div>
            )
          })()}
        </>
      ) : (
        <div style={{ padding: '20px 0', textAlign: 'center' }}>
          <div style={{ fontSize: 10, letterSpacing: '0.07em', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: 6 }}>// AWAITING</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Run first cycle to generate signals</div>
        </div>
      )}

      {sentiment && (
        <>
          <div style={{ borderTop: '1px solid var(--border)', margin: '14px 0' }} />
          <SentimentMeter score={sentiment.score} />

          <div style={{ marginTop: 12, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {sentiment.signals.map((sig, i) => (
              <span key={i} className="pill pill-cream" style={{
                fontSize: 9,
                animation: `slideUpFade 0.35s ${i * 50}ms ease both`,
              }}>{sig}</span>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
