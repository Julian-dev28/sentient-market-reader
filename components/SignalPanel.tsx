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

/**
 * Bi-directional bar centered at 0, fills left (negative) or right (positive).
 * value range: -1 to +1
 */
function BiDirectionalBar({ label, value, leftLabel, rightLabel }: {
  label: string; value: number; leftLabel: string; rightLabel: string
}) {
  const [ready, setReady] = useState(false)
  useEffect(() => { setTimeout(() => setReady(true), 150) }, [])

  const pct       = Math.abs(value) * 50  // max 50% from center
  const isPos     = value >= 0
  const color     = value > 0.15 ? 'var(--green)' : value < -0.15 ? 'var(--pink)' : 'var(--amber)'
  const gradient  = isPos
    ? `linear-gradient(90deg, ${color}, ${color}44)`   // solid at center, fades right
    : `linear-gradient(90deg, ${color}44, ${color})`   // fades left, solid at center

  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3, alignItems: 'center' }}>
        <span style={{ fontSize: 10, color: 'var(--text-secondary)', fontWeight: 500 }}>{label}</span>
        <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 10, fontWeight: 700, color }}>
          {value >= 0 ? '+' : ''}{value.toFixed(2)}
        </span>
      </div>
      <div style={{ position: 'relative', height: 5, borderRadius: 3, background: 'var(--bg-secondary)', overflow: 'hidden' }}>
        {/* Center tick */}
        <div style={{ position: 'absolute', left: '50%', top: 0, width: 1, height: '100%', background: 'var(--border)', zIndex: 2 }} />
        {/* Fill: shoots out from center */}
        <div style={{
          position: 'absolute', height: '100%', borderRadius: 3,
          background: gradient,
          left:  isPos ? '50%' : `calc(50% - ${ready ? pct : 0}%)`,
          width: `${ready ? pct : 0}%`,
          transition: 'all 0.7s cubic-bezier(0.34,1.56,0.64,1)',
        }} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 2 }}>
        <span style={{ fontSize: 8, color: 'var(--text-muted)' }}>{leftLabel}</span>
        <span style={{ fontSize: 8, color: 'var(--text-muted)' }}>{rightLabel}</span>
      </div>
    </div>
  )
}

/** Auto-detect bullish/bearish tone from signal text for pill coloring */
function getSignalTone(signal: string): 'bull' | 'bear' | 'neutral' {
  if (/bull|upward|above|breakout|support|momentum|higher|strength|recover|bounce|rally|buy|positive|oversold|reversal up/i.test(signal)) return 'bull'
  if (/bear|downward|below|breakdown|resistance|lower|weak|drop|fall|sell|caution|warn|pressure|overbought|reversal down/i.test(signal)) return 'bear'
  return 'neutral'
}

/** Conviction = |edge| × confidence weight × sentiment alignment factor */
function getConviction(edgePct: number, confidence: string, sentScore: number, rec: string) {
  if (rec === 'NO_TRADE') return { label: 'no edge', color: 'var(--text-muted)', bg: 'var(--bg-secondary)' }
  const confW   = confidence === 'high' ? 1 : confidence === 'medium' ? 0.65 : 0.35
  const aligned = (rec === 'YES' && sentScore > 0) || (rec === 'NO' && sentScore < 0)
  const score   = Math.abs(edgePct) * confW * (aligned ? 1.2 : 0.7)
  if (score >= 6)   return { label: 'strong',   color: 'var(--green-dark)', bg: 'var(--green-pale)' }
  if (score >= 3)   return { label: 'moderate',  color: 'var(--amber)',      bg: 'var(--amber-pale)' }
  if (score >= 1.2) return { label: 'weak',      color: 'var(--pink)',       bg: 'var(--pink-pale)' }
  return                  { label: 'minimal',   color: 'var(--text-muted)', bg: 'var(--bg-secondary)' }
}

export default function SignalPanel({ probability, sentiment }: SignalPanelProps) {
  const rec      = probability?.recommendation ?? 'NO_TRADE'
  const recColor = rec === 'YES' ? 'var(--green)' : rec === 'NO' ? 'var(--blue)' : 'var(--text-muted)'
  const recBg    = rec === 'YES' ? 'var(--green-pale)'  : rec === 'NO' ? 'var(--blue-pale)' : 'var(--cream)'
  const recBdr   = rec === 'YES' ? '#9ecfb8'             : rec === 'NO' ? '#a8cce0'          : 'var(--border)'
  const recIcon  = rec === 'YES' ? '↑' : rec === 'NO' ? '↓' : '—'

  const sentScore = sentiment?.score ?? 0
  const sentimentContradictsRec =
    (rec === 'YES' && sentScore < -0.4) ||
    (rec === 'NO'  && sentScore >  0.4)

  const conviction = probability
    ? getConviction(probability.edgePct, probability.confidence, sentScore, rec)
    : null

  const confColor = probability?.confidence === 'high'   ? 'var(--green-dark)'
                  : probability?.confidence === 'medium' ? 'var(--amber)'
                  : 'var(--text-muted)'
  const confBg    = probability?.confidence === 'high'   ? 'var(--green-pale)'
                  : probability?.confidence === 'medium' ? 'var(--amber-pale)'
                  : 'var(--bg-secondary)'

  return (
    <div className="card">
      <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 14, display: 'flex', alignItems: 'center', gap: 6 }}>
        Signal Analysis
        {probability && (
          <span style={{
            marginLeft: 'auto', fontSize: 9, fontWeight: 700,
            fontFamily: 'var(--font-geist-mono)',
            color: confColor, background: confBg,
            padding: '2px 7px', borderRadius: 4,
          }}>
            {probability.confidence}
          </span>
        )}
      </div>

      {probability ? (
        <>
          {/* Hero recommendation block */}
          <div style={{
            padding: '14px 16px', borderRadius: 14, marginBottom: 14,
            background: recBg, border: `1px solid ${recBdr}`,
            animation: 'scaleIn 0.35s cubic-bezier(0.34,1.56,0.64,1)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <div style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 2 }}>Edge</div>
                <div style={{
                  fontFamily: 'var(--font-geist-mono)', fontSize: 30, fontWeight: 800,
                  color: recColor, letterSpacing: '-0.03em', lineHeight: 1,
                  animation: 'scaleIn 0.4s cubic-bezier(0.34,1.56,0.64,1)',
                }}>
                  {probability.edge >= 0 ? '+' : ''}{probability.edgePct.toFixed(1)}%
                </div>
                {conviction && (
                  <div style={{
                    marginTop: 6, display: 'inline-block',
                    fontSize: 9, fontWeight: 700,
                    color: conviction.color, background: conviction.bg,
                    padding: '2px 6px', borderRadius: 4,
                    textTransform: 'uppercase', letterSpacing: '0.06em',
                  }}>
                    {conviction.label} conviction
                  </div>
                )}
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

          {/* Delta gap */}
          {(() => {
            const delta = Math.round((probability.pModel - probability.pMarket) * 100)
            const pos = delta > 0
            return (
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: -6, marginBottom: 14 }}>
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

          {/* Signal sub-components: momentum + crowd lean */}
          {sentiment && (
            <div style={{
              padding: '10px 12px', borderRadius: 10,
              background: 'var(--bg-secondary)',
              marginBottom: 4,
            }}>
              <div style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 8 }}>
                Signal Components
              </div>
              <BiDirectionalBar
                label="Momentum"
                value={sentiment.momentum}
                leftLabel="bearish"
                rightLabel="bullish"
              />
              <BiDirectionalBar
                label="Crowd Lean"
                value={sentiment.orderbookSkew}
                leftLabel="NO bias"
                rightLabel="YES bias"
              />
            </div>
          )}
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

          {/* Auto-colored signal pills */}
          <div style={{ marginTop: 12, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {sentiment.signals.map((sig, i) => {
              const tone = getSignalTone(sig)
              return (
                <span
                  key={i}
                  className={`pill ${tone === 'bull' ? 'pill-green' : tone === 'bear' ? 'pill-pink' : 'pill-cream'}`}
                  style={{
                    fontSize: 9,
                    animation: `slideUpFade 0.35s ${i * 50}ms ease both`,
                  }}
                >{sig}</span>
              )
            })}
          </div>

          {/* Provider attribution */}
          {probability && (
            <div style={{ marginTop: 10, display: 'flex', gap: 10 }}>
              <span style={{ fontSize: 8, color: 'var(--text-muted)', fontFamily: 'var(--font-geist-mono)' }}>
                prob · {probability.provider.split('/').pop()}
              </span>
              <span style={{ fontSize: 8, color: 'var(--text-muted)', fontFamily: 'var(--font-geist-mono)' }}>
                sent · {sentiment.provider.split('/').pop()}
              </span>
            </div>
          )}
        </>
      )}
    </div>
  )
}
