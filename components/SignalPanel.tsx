'use client'

import { useEffect, useState } from 'react'
import type { ProbabilityOutput, SentimentOutput } from '@/lib/types'

interface SignalPanelProps {
  probability: ProbabilityOutput | null
  sentiment: SentimentOutput | null
}

/** Animated fill bar */
function Bar({ value, color }: { value: number; color: string }) {
  const pct = Math.round(value * 100)
  const [width, setWidth] = useState(0)
  useEffect(() => { const id = setTimeout(() => setWidth(pct), 80); return () => clearTimeout(id) }, [pct])
  return (
    <div style={{ height: 6, borderRadius: 3, background: 'var(--bg-secondary)', overflow: 'hidden', flex: 1 }}>
      <div style={{
        height: '100%', width: `${width}%`, borderRadius: 3,
        background: color, transition: 'width 0.8s cubic-bezier(0.34,1.56,0.64,1)',
      }} />
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
  if (score >= 6)   return { label: 'strong',  color: 'var(--green-dark)', bg: 'var(--green-pale)' }
  if (score >= 3)   return { label: 'moderate', color: 'var(--amber)',     bg: 'var(--amber-pale)' }
  if (score >= 1.2) return { label: 'weak',     color: 'var(--pink)',      bg: 'var(--pink-pale)'  }
  return               { label: 'minimal', color: 'var(--text-muted)', bg: 'var(--bg-secondary)' }
}

/** Plain-English label for a probability */
function probLabel(p: number): { side: 'YES' | 'NO'; pct: number } {
  return { side: p >= 0.5 ? 'YES' : 'NO', pct: Math.round(p * 100) }
}

/** Plain-English momentum direction */
function momentumLabel(m: number): { text: string; color: string } {
  if (m >  0.35) return { text: 'Rising fast',    color: 'var(--green)'      }
  if (m >  0.1)  return { text: 'Rising slightly', color: 'var(--green-dark)' }
  if (m < -0.35) return { text: 'Falling fast',   color: 'var(--pink)'       }
  if (m < -0.1)  return { text: 'Falling slightly',color: 'var(--pink)'      }
  return               { text: 'Flat / sideways', color: 'var(--text-muted)' }
}

/** Plain-English order book lean */
function orderbookLabel(skew: number): { text: string; color: string } {
  if (skew >  0.3) return { text: 'Heavily buying YES', color: 'var(--green)'      }
  if (skew >  0.1) return { text: 'Leaning YES',        color: 'var(--green-dark)' }
  if (skew < -0.3) return { text: 'Heavily buying NO',  color: 'var(--pink)'       }
  if (skew < -0.1) return { text: 'Leaning NO',         color: 'var(--pink)'       }
  return                  { text: 'Balanced',            color: 'var(--text-muted)' }
}

/** Plain-English overall sentiment */
function sentimentLabel(score: number): { text: string; color: string } {
  if (score >  0.4) return { text: 'Strongly bullish',  color: 'var(--green)'      }
  if (score >  0.1) return { text: 'Mildly bullish',    color: 'var(--green-dark)' }
  if (score < -0.4) return { text: 'Strongly bearish',  color: 'var(--pink)'       }
  if (score < -0.1) return { text: 'Mildly bearish',    color: 'var(--pink)'       }
  return                   { text: 'Neutral',            color: 'var(--text-muted)' }
}

export default function SignalPanel({ probability, sentiment }: SignalPanelProps) {
  const [sentimentReady, setSentimentReady] = useState(false)
  useEffect(() => {
    if (!sentiment) return
    const id = setTimeout(() => setSentimentReady(true), 120)
    return () => clearTimeout(id)
  }, [sentiment])

  const rec      = probability?.recommendation ?? 'NO_TRADE'
  const recColor = rec === 'YES' ? 'var(--green)' : rec === 'NO' ? 'var(--blue)' : 'var(--text-muted)'
  const recBg    = rec === 'YES' ? 'var(--green-pale)' : rec === 'NO' ? 'var(--blue-pale)' : 'var(--cream)'
  const recBdr   = rec === 'YES' ? '#9ecfb8' : rec === 'NO' ? '#a8cce0' : 'var(--border)'

  const sentScore  = sentiment?.score ?? 0
  const conviction = probability
    ? getConviction(probability.edgePct, probability.confidence, sentScore, rec)
    : null

  const confColor = probability?.confidence === 'high'   ? 'var(--green-dark)'
                  : probability?.confidence === 'medium' ? 'var(--amber)'
                  : 'var(--text-muted)'
  const confBg    = probability?.confidence === 'high'   ? 'var(--green-pale)'
                  : probability?.confidence === 'medium' ? 'var(--amber-pale)'
                  : 'var(--bg-secondary)'

  const sentimentContradictsRec =
    (rec === 'YES' && sentScore < -0.4) ||
    (rec === 'NO'  && sentScore >  0.4)

  return (
    <div className="card">
      <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 14, display: 'flex', alignItems: 'center', gap: 6 }}>
        Signal Analysis
        {probability && (
          <span style={{ marginLeft: 'auto', fontSize: 9, fontWeight: 700, color: confColor, background: confBg, padding: '2px 7px', borderRadius: 4 }}>
            {probability.confidence} confidence
          </span>
        )}
      </div>

      {probability ? (
        <>
          {/* ── Verdict card ── */}
          <div style={{
            padding: '14px 16px', borderRadius: 14, marginBottom: 14,
            background: recBg, border: `1px solid ${recBdr}`,
            animation: 'scaleIn 0.35s cubic-bezier(0.34,1.56,0.64,1)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
              {/* Action */}
              <div>
                <div style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 3 }}>
                  ROMA Recommendation
                </div>
                <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 26, fontWeight: 900, color: recColor, lineHeight: 1 }}>
                  {rec === 'YES' ? 'BUY YES' : rec === 'NO' ? 'BUY NO' : 'PASS'}
                </div>
              </div>
              {/* Edge */}
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 9, color: 'var(--text-muted)', marginBottom: 3 }}>Edge over market</div>
                <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 22, fontWeight: 800, color: recColor }}>
                  {probability.edge >= 0 ? '+' : ''}{probability.edgePct.toFixed(1)}%
                </div>
              </div>
            </div>

            {/* Plain-English explanation */}
            <div style={{
              fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5,
              marginTop: 2,
            }}>
              {rec === 'YES' && probability.pModel >= 0.5 && <>ROMA thinks YES wins at <strong style={{ color: recColor }}>{Math.round(probability.pModel * 100)}%</strong> — and the market is underpricing that outcome at {Math.round(probability.pMarket * 100)}¢.</>}
              {rec === 'YES' && probability.pModel < 0.5  && <>ROMA values YES at <strong style={{ color: recColor }}>{Math.round(probability.pModel * 100)}%</strong> — the market is underpricing it at {Math.round(probability.pMarket * 100)}¢.</>}
              {rec === 'NO'  && probability.pModel >= 0.5 && <>ROMA still thinks YES wins at <strong style={{ color: recColor }}>{Math.round(probability.pModel * 100)}%</strong>, but the market prices it at {Math.round(probability.pMarket * 100)}¢ — YES is overpriced. Buying NO captures that gap.</>}
              {rec === 'NO'  && probability.pModel < 0.5  && <>ROMA thinks BTC will end <strong style={{ color: recColor }}>below the strike</strong> ({Math.round(probability.pModel * 100)}% YES) — and the market is overpricing YES at {Math.round(probability.pMarket * 100)}¢.</>}
              {rec === 'NO_TRADE' && <>ROMA and market agree closely — no exploitable edge found. Sitting this one out.</>}
            </div>

            {conviction && conviction.label !== 'no edge' && (
              <div style={{
                marginTop: 8, display: 'inline-block',
                fontSize: 9, fontWeight: 700,
                color: conviction.color, background: conviction.bg,
                padding: '2px 6px', borderRadius: 4,
                textTransform: 'uppercase', letterSpacing: '0.06em',
              }}>
                {conviction.label} conviction
              </div>
            )}
          </div>

          {sentimentContradictsRec && (
            <div style={{
              padding: '7px 10px', borderRadius: 8, marginBottom: 12,
              background: 'var(--pink-pale)', border: '1px solid #f0a0b8',
              fontSize: 11, color: 'var(--pink)', fontWeight: 600,
              display: 'flex', alignItems: 'center', gap: 6,
            }}>
              <span>⚠</span>
              <span>Price momentum contradicts the signal — risk manager will block this trade</span>
            </div>
          )}

          {/* ── AI vs Market comparison ── */}
          {(() => {
            const ai  = probLabel(probability.pModel)
            const mkt = probLabel(probability.pMarket)
            const delta = Math.round((probability.pModel - probability.pMarket) * 100)
            const aiColor  = ai.side  === 'YES' ? 'var(--green)' : 'var(--blue)'
            const mktColor = mkt.side === 'YES' ? 'var(--green)' : 'var(--blue)'
            const gapText = Math.abs(delta) <= 1
              ? 'ROMA and market agree — no edge'
              : delta > 0
                ? `ROMA is ${delta}pp more bullish than the market`
                : `ROMA is ${Math.abs(delta)}pp more bearish than the market`
            const gapColor = Math.abs(delta) <= 1 ? 'var(--text-muted)' : delta > 0 ? 'var(--green-dark)' : 'var(--pink)'

            return (
              <div style={{ marginBottom: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>

                {/* AI row */}
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                    <div>
                      <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)' }}>ROMA thinks </span>
                      <span style={{ fontSize: 11, fontWeight: 800, color: aiColor }}>{ai.side} wins</span>
                    </div>
                    <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 12, fontWeight: 800, color: aiColor }}>
                      {ai.pct}% YES
                    </span>
                  </div>
                  <Bar value={probability.pModel} color={aiColor} />
                </div>

                {/* Market row */}
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                    <div>
                      <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)' }}>Market prices </span>
                      <span style={{ fontSize: 11, fontWeight: 800, color: mktColor }}>{mkt.side} at</span>
                    </div>
                    <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 12, fontWeight: 800, color: mktColor }}>
                      {mkt.pct}¢ / YES
                    </span>
                  </div>
                  <Bar value={probability.pMarket} color={mktColor} />
                </div>

                {/* Gap explanation */}
                <div style={{
                  fontSize: 10, fontWeight: 700, color: gapColor,
                  padding: '4px 8px', borderRadius: 5,
                  background: Math.abs(delta) <= 1 ? 'transparent' : gapColor + '11',
                }}>
                  {gapText}
                </div>
              </div>
            )
          })()}

          {/* ── Why this signal ── */}
          {sentiment && (() => {
            const mom = momentumLabel(sentiment.momentum)
            const ob  = orderbookLabel(sentiment.orderbookSkew)
            const sent = sentimentLabel(sentiment.score)

            return (
              <div style={{
                padding: '10px 12px', borderRadius: 10,
                background: 'var(--bg-secondary)',
                marginBottom: 4,
              }}>
                <div style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 10 }}>
                  Why this signal
                </div>
                {[
                  { label: 'BTC price momentum', value: mom.text, color: mom.color },
                  { label: 'Order book activity', value: ob.text,  color: ob.color  },
                  { label: 'Overall market mood', value: sent.text, color: sent.color },
                ].map(({ label, value, color }) => (
                  <div key={label} style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    padding: '5px 0', borderBottom: '1px solid var(--border)',
                  }}>
                    <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{label}</span>
                    <span style={{ fontSize: 11, fontWeight: 700, color }}>{value}</span>
                  </div>
                ))}
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

      {/* ── Sentiment + signal pills ── */}
      {sentiment && (
        <>
          <div style={{ borderTop: '1px solid var(--border)', margin: '14px 0' }} />

          {/* Simplified sentiment display */}
          {(() => {
            const sent = sentimentLabel(sentiment.score)
            const pct  = Math.round(((sentiment.score + 1) / 2) * 100)
            return (
              <div style={{ marginBottom: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, alignItems: 'center' }}>
                  <span style={{ fontSize: 11, color: 'var(--text-secondary)', fontWeight: 600 }}>Market sentiment</span>
                  <span style={{ fontSize: 12, fontWeight: 800, color: sent.color }}>{sent.text}</span>
                </div>
                <div style={{ position: 'relative', height: 8, borderRadius: 4, background: 'linear-gradient(90deg, var(--pink) 0%, var(--amber) 50%, var(--green) 100%)' }}>
                  <div style={{
                    position: 'absolute', top: -4, width: 16, height: 16, borderRadius: '50%',
                    background: sent.color, border: '3px solid var(--bg-card)',
                    left: `calc(${sentimentReady ? pct : 50}% - 8px)`,
                    transition: 'left 0.7s cubic-bezier(0.34,1.56,0.64,1)',
                    boxShadow: `0 0 8px ${sent.color}80`,
                  }} />
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 5 }}>
                  <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>Bearish (price going down)</span>
                  <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>Bullish (price going up)</span>
                </div>
              </div>
            )
          })()}

          {/* Signal pills */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {sentiment.signals.map((sig, i) => {
              const tone = getSignalTone(sig)
              return (
                <span
                  key={i}
                  className={`pill ${tone === 'bull' ? 'pill-green' : tone === 'bear' ? 'pill-pink' : 'pill-cream'}`}
                  style={{ fontSize: 9, animation: `slideUpFade 0.35s ${i * 50}ms ease both` }}
                >{sig}</span>
              )
            })}
          </div>

          {/* Provider attribution */}
          {probability && (
            <div style={{ marginTop: 10, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              {[
                { label: 'prob', provider: probability.provider },
                { label: 'sent', provider: sentiment.provider },
              ].map(({ label, provider }) => {
                const isOR  = provider.startsWith('openrouter')
                const model = provider.split('/').pop()
                return (
                  <span key={label} style={{
                    fontSize: 8, fontFamily: 'var(--font-geist-mono)', fontWeight: isOR ? 700 : 400,
                    color:      isOR ? 'var(--blue-dark)'  : 'var(--text-muted)',
                    background: isOR ? 'var(--blue-pale)'  : 'transparent',
                    border:     isOR ? '1px solid #a8cce0' : 'none',
                    padding:    isOR ? '1px 5px' : '0',
                    borderRadius: 3,
                  }}>
                    {label} · {isOR ? `OR/${model}` : model}
                  </span>
                )
              })}
            </div>
          )}
        </>
      )}
    </div>
  )
}
