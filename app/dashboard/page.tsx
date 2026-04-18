'use client'

import { useState, useEffect, useRef } from 'react'
import { usePipeline } from '@/hooks/usePipeline'
import { useMarketTick } from '@/hooks/useMarketTick'
import Header from '@/components/Header'
import MarketCard from '@/components/MarketCard'
import PriceChart from '@/components/PriceChart'
import AgentPipeline from '@/components/AgentPipeline'
import SignalPanel from '@/components/SignalPanel'
import MarkovPanel from '@/components/MarkovPanel'
import PositionsPanel from '@/components/PositionsPanel'
import PipelineHistory from '@/components/PipelineHistory'

type TradeAlert = {
  action: string
  side: 'yes' | 'no'
  limitPrice: number
  ticker: string
  edge: number
  pModel: number
  windowKey: string
}

export default function Home() {
  const [botActive, setBotActive]           = useState(false)
  const [showBotWarning, setShowBotWarning] = useState(false)
  const [showLateWarning, setShowLateWarning] = useState(false)
  // analysisMode: 'quant' = pure math (no LLM); 'ai' = Grok-enhanced analysis
  const [analysisMode, setAnalysisMode]   = useState<'quant' | 'ai'>('quant')
  const [orModel, setOrModel]             = useState<string>('grok-3')
  const [showSettings, setShowSettings]   = useState(false)
  const [grokMenuOpen, setGrokMenuOpen]   = useState(false)
  const grokMenuRef                       = useRef<HTMLDivElement>(null)

  const aiRisk = analysisMode === 'ai'  // derived — AI mode enables ROMA risk manager

  // Sync from localStorage after hydration
  useEffect(() => {
    const saved = localStorage.getItem('sentient-grok-model')
    if (saved) setOrModel(saved)
    const mode = localStorage.getItem('sentient-analysis-mode')
    if (mode === 'quant' || mode === 'ai') setAnalysisMode(mode)
  }, [])

  function handleGrokModelChange(m: string) {
    setOrModel(m)
    localStorage.setItem('sentient-grok-model', m)
    setGrokMenuOpen(false)
  }

  function handleAnalysisModeChange(mode: 'quant' | 'ai') {
    setAnalysisMode(mode)
    localStorage.setItem('sentient-analysis-mode', mode)
  }

// Close Grok dropdown on outside click
  useEffect(() => {
    if (!grokMenuOpen) return
    function handleClick(e: MouseEvent) {
      if (grokMenuRef.current && !grokMenuRef.current.contains(e.target as Node)) {
        setGrokMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [grokMenuOpen])

  // ── Market tick — runs BEFORE usePipeline so btcPrice/strikePrice are available
  // for strike-flip detection. useMarketTick auto-discovers the active market when
  // ticker is null; switches to the specific ticker once pipeline has run.
  const [marketTicker, setMarketTicker] = useState<string | null>(null)
  const { liveMarket, liveOrderbook, liveBTCPrice, livePriceHistory, refresh: refreshMarket } = useMarketTick(marketTicker)

  const liveStrikePrice = (liveMarket?.yes_sub_title
    ? parseFloat(liveMarket.yes_sub_title.replace(/[^0-9.]/g, ''))
    : 0) || liveMarket?.floor_strike || 0

  const { pipeline, history, streamingAgents, isRunning, serverLocked, nextCycleIn, error, runCycle, stopCycle, monitorDeltaPct } = usePipeline(
    true, botActive, aiRisk, undefined, undefined,
    analysisMode === 'ai' ? (orModel || 'grok-3') : undefined,  // only pass model in AI mode
    liveBTCPrice || undefined, liveStrikePrice || undefined,
    '15m',
  )

  // Keep marketTicker in sync with the pipeline's active market
  const md     = pipeline?.agents.marketDiscovery.output
  const pf     = pipeline?.agents.priceFeed.output
  const prob   = pipeline?.agents.probability.output ?? null
  const sent   = pipeline?.agents.sentiment.output ?? null
  const exec   = pipeline?.agents.execution.output
  const markov = pipeline?.agents.markov?.output ?? null

  useEffect(() => {
    const t = md?.activeMarket?.ticker ?? null
    if (t) setMarketTicker(t)
  }, [md?.activeMarket?.ticker])

  // ── Trade alert pop-up ─────────────────────────────────────────────────────
  const [tradeAlert, setTradeAlert]       = useState<TradeAlert | null>(null)
  const [alertStatus, setAlertStatus]     = useState<'idle' | 'placing' | 'ok' | 'err'>('idle')
  const alertShownWindowRef               = useRef<string | null>(null)   // window key alert was shown for

  function getDismissedKey() { return typeof window !== 'undefined' ? localStorage.getItem('alertDismissedWindow') : null }
  function setDismissedKey(k: string) { localStorage.setItem('alertDismissedWindow', k) }

  useEffect(() => {
    if (!pipeline) return
    const ex   = pipeline.agents.execution.output
    const prob = pipeline.agents.probability.output
    const mdOut = pipeline.agents.marketDiscovery.output
    const windowKey = (mdOut.activeMarket as { event_ticker?: string } | undefined)?.event_ticker
      ?? mdOut.activeMarket?.ticker.split('-').slice(0, 2).join('-')
      ?? null
    if (!windowKey) return
    if (alertShownWindowRef.current === windowKey) return      // already shown this window
    if (getDismissedKey() === windowKey) return                // user dismissed this window (persists across refresh)
    if (ex.action !== 'PASS' && ex.side && ex.limitPrice != null) {
      alertShownWindowRef.current = windowKey
      setTradeAlert({ action: ex.action, side: ex.side as 'yes' | 'no', limitPrice: ex.limitPrice, ticker: ex.marketTicker, edge: prob.edge, pModel: prob.pModel, windowKey })
      setAlertStatus('idle')
    }
  }, [pipeline])

  async function executeAlertTrade() {
    if (!tradeAlert) return
    setAlertStatus('placing')
    const contracts = Math.max(1, Math.floor(40 / (tradeAlert.limitPrice / 100)))
    try {
      const body = { ticker: tradeAlert.ticker, side: tradeAlert.side, count: contracts,
        ...(tradeAlert.side === 'yes' ? { yesPrice: tradeAlert.limitPrice } : { noPrice: tradeAlert.limitPrice }),
        clientOrderId: `alert-${Date.now()}` }
      const res  = await fetch('/api/place-order', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const data = await res.json()
      if (!res.ok || !data.ok) { setAlertStatus('err') }
      else { setAlertStatus('ok'); setTimeout(() => setTradeAlert(null), 2000) }
    } catch { setAlertStatus('err') }
  }

  // Merge: live tick overrides stale pipeline values — filter expired on both sources.
  const mdMarket = md?.activeMarket ?? null
  const mdMarketExpired = mdMarket?.close_time
    ? new Date(mdMarket.close_time).getTime() < Date.now()
    : false
  const liveMarketExpired = liveMarket?.close_time
    ? new Date(liveMarket.close_time).getTime() < Date.now()
    : false
  const activeMarket = (liveMarket && !liveMarketExpired)
    ? liveMarket
    : (mdMarketExpired ? null : mdMarket)

  // Clear ticker when live market expires so auto-discovery picks up the next window.
  useEffect(() => {
    if (liveMarketExpired) setMarketTicker(null)
  }, [liveMarketExpired])
  const currentBTCPrice = liveBTCPrice ?? pf?.currentPrice ?? 0
  const priceHistory    = livePriceHistory

  // Derive strike + expiry directly from live market so they show before pipeline runs.
  // yes_sub_title ("Price to beat: $X") matches Kalshi's displayed value — prefer it over
  // floor_strike which can diverge from the actual displayed strike.
  const liveStrikeFromSubtitle = activeMarket?.yes_sub_title
    ? parseFloat(activeMarket.yes_sub_title.replace(/[^0-9.]/g, ''))
    : 0
  const strikePrice = (liveStrikeFromSubtitle > 0 ? liveStrikeFromSubtitle : null)
    ?? md?.strikePrice
    ?? activeMarket?.floor_strike
    ?? 0
  // Always compute from live close_time so the countdown stays accurate between pipeline cycles.
  // Fall back to pipeline value only when no market is loaded yet.
  const secondsUntilExpiry = activeMarket?.close_time
    ? Math.max(0, Math.floor((new Date(activeMarket.close_time).getTime() - Date.now()) / 1000))
    : (md?.secondsUntilExpiry ?? 0)

  // ── Pipeline hotkey: Shift+R to run / stop ─────────────────────────────────
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!e.shiftKey || e.code !== 'KeyR') return
      if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'TEXTAREA') return
      e.preventDefault()
      if (isRunning) { stopCycle(); return }
      if (serverLocked) return
      if (secondsUntilExpiry > 0 && secondsUntilExpiry < 120) { setShowLateWarning(true); return }
      runCycle()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRunning, serverLocked, secondsUntilExpiry])

  function handleStartBot() {
    setShowBotWarning(true)
  }

  function confirmStartBot() {
    setShowBotWarning(false)
    setBotActive(true)
  }

  function handleStopBot() {
    setBotActive(false)
  }

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-primary)', position: 'relative' }}>
      <div className="noise-overlay" />
      <Header
        cycleId={pipeline?.cycleId ?? 0}
        isRunning={isRunning}
        lastCompletedAt={pipeline?.cycleCompletedAt}
        onRunCycle={isRunning || serverLocked ? undefined : runCycle}
      />

      {/* Bot start confirmation modal */}
      {showBotWarning && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 1000,
          background: 'rgba(0,0,0,0.35)', backdropFilter: 'blur(8px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <div className="card animate-fade-in" style={{ maxWidth: 420, width: '90%', padding: '28px 28px' }}>
            <div style={{ fontSize: 22, marginBottom: 10 }}>🤖</div>
            <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--text-primary)', marginBottom: 8 }}>
              Start Trading Agent?
            </div>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 20 }}>
              The bot will run a pipeline cycle every <strong>5 minutes</strong> and automatically place a <strong>$100 live order</strong> when the agent approves a trade.
              <><br /><br /><span style={{ color: 'var(--pink)', fontWeight: 700 }}>⚠ Live mode — real money will be used.</span></>
              <br /><br />
              Risk guards: 3% min edge · $150 daily loss cap · 15% drawdown limit · 48 trades/day max.
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button
                onClick={() => setShowBotWarning(false)}
                style={{
                  flex: 1, padding: '10px 0', borderRadius: 9, cursor: 'pointer',
                  border: '1px solid var(--border)', background: 'var(--bg-secondary)',
                  fontSize: 13, fontWeight: 700, color: 'var(--text-secondary)',
                }}
              >
                Cancel
              </button>
              <button
                onClick={confirmStartBot}
                style={{
                  flex: 1, padding: '10px 0', borderRadius: 9, cursor: 'pointer',
                  border: '1px solid var(--green-dark)',
                  background: 'var(--green)',
                  fontSize: 13, fontWeight: 700, color: '#fff',
                  boxShadow: '0 2px 10px rgba(78,138,94,0.35)',
                }}
              >
                ▶ Start Agent
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Late-start warning modal */}
      {showLateWarning && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 1000,
          background: 'rgba(0,0,0,0.35)', backdropFilter: 'blur(8px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <div className="card animate-fade-in" style={{ maxWidth: 400, width: '90%', padding: '28px 28px' }}>
            <div style={{ fontSize: 22, marginBottom: 10 }}>⏱</div>
            <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--text-primary)', marginBottom: 8 }}>
              Under 2 Minutes Remaining
            </div>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 20 }}>
              The current 15-minute window closes in <strong>less than 2 minutes</strong>. The pipeline takes ~1–3 min to complete — it will not finish before the market settles.
              <br /><br />
              Any signal generated will likely be <strong>outdated by the time it completes</strong>.
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button
                onClick={() => setShowLateWarning(false)}
                style={{
                  flex: 1, padding: '10px 0', borderRadius: 9, cursor: 'pointer',
                  border: '1px solid var(--border)', background: 'var(--bg-secondary)',
                  fontSize: 13, fontWeight: 700, color: 'var(--text-secondary)',
                }}
              >
                Cancel
              </button>
              <button
                onClick={() => { setShowLateWarning(false); runCycle() }}
                style={{
                  flex: 1, padding: '10px 0', borderRadius: 9, cursor: 'pointer',
                  border: '1px solid var(--amber)',
                  background: 'var(--amber)',
                  fontSize: 13, fontWeight: 700, color: '#fff',
                  boxShadow: '0 2px 10px rgba(212,135,44,0.35)',
                }}
              >
                Run Anyway
              </button>
            </div>
          </div>
        </div>
      )}


      {/* ── Trade alert pop-up ─────────────────────────────────────────────── */}
      {tradeAlert && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 1100,
          background: 'rgba(0,0,0,0.35)', backdropFilter: 'blur(8px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <div className="card animate-fade-in" style={{
            maxWidth: 360, width: '90%', padding: '26px 24px',
            border: tradeAlert.side === 'yes' ? '1.5px solid rgba(45,158,107,0.3)' : '1.5px solid rgba(192,69,62,0.3)',
            boxShadow: '0 12px 48px rgba(0,0,0,0.22)',
          }}>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
              <div style={{
                width: 42, height: 42, borderRadius: '50%', flexShrink: 0,
                background: tradeAlert.side === 'yes' ? 'var(--green-pale)' : 'var(--pink-pale)',
                border: tradeAlert.side === 'yes' ? '1.5px solid rgba(45,158,107,0.3)' : '1.5px solid rgba(192,69,62,0.3)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 22, color: tradeAlert.side === 'yes' ? 'var(--green)' : 'var(--pink)',
                animation: 'iconBeat 2s ease infinite',
              }}>
                {tradeAlert.side === 'yes' ? '↑' : '↓'}
              </div>
              <div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 2 }}>
                  Agent Signal
                </div>
                <div style={{ fontSize: 18, fontWeight: 800, color: tradeAlert.side === 'yes' ? 'var(--green-dark)' : 'var(--pink)', lineHeight: 1 }}>
                  BUY {tradeAlert.side.toUpperCase()} @ {tradeAlert.limitPrice}¢
                </div>
              </div>
            </div>

            {/* Stats row */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 16 }}>
              {[
                ['Edge',     `+${tradeAlert.edge.toFixed(1)}%`],
                ['P(model)', `${(tradeAlert.pModel * 100).toFixed(0)}%`],
              ].map(([k, v]) => (
                <div key={k} style={{ padding: '8px 10px', borderRadius: 9, background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
                  <div style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 3 }}>{k}</div>
                  <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 16, fontWeight: 800, color: 'var(--text-primary)' }}>{v}</div>
                </div>
              ))}
            </div>

            {/* Action buttons */}
            {alertStatus === 'idle' && (
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => { setDismissedKey(tradeAlert.windowKey); setTradeAlert(null) }} style={{
                  flex: 1, padding: '10px 0', borderRadius: 9, cursor: 'pointer',
                  border: '1px solid var(--border)', background: 'var(--bg-secondary)',
                  fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)',
                }}>
                  Dismiss
                </button>
                <button onClick={executeAlertTrade} style={{
                  flex: 2, padding: '10px 0', borderRadius: 9, cursor: 'pointer',
                  border: tradeAlert.side === 'yes' ? '1px solid var(--green-dark)' : '1px solid var(--pink)',
                  background: tradeAlert.side === 'yes'
                    ? 'var(--green)'
                    : 'var(--pink)',
                  fontSize: 14, fontWeight: 800, color: '#fff',
                  boxShadow: tradeAlert.side === 'yes' ? '0 2px 12px rgba(45,158,107,0.35)' : '0 2px 12px rgba(212,85,130,0.35)',
                  letterSpacing: '0.01em',
                }}>
                  Buy $40
                </button>
              </div>
            )}
            {alertStatus === 'placing' && (
              <div style={{ textAlign: 'center', padding: '10px 0', fontSize: 12, color: 'var(--text-muted)' }}>
                <span style={{ animation: 'spin-slow 1s linear infinite', display: 'inline-block', marginRight: 6 }}>◌</span>
                Placing order...
              </div>
            )}
            {alertStatus === 'ok' && (
              <div style={{ textAlign: 'center', padding: '10px 0', fontSize: 13, fontWeight: 700, color: 'var(--green-dark)' }}>
                ✓ Order placed!
              </div>
            )}
            {alertStatus === 'err' && (
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 12, color: 'var(--red)', marginBottom: 8 }}>Order failed</div>
                <button onClick={() => setAlertStatus('idle')} style={{ fontSize: 11, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}>Try again</button>
              </div>
            )}
          </div>
        </div>
      )}

      <main style={{ padding: '20px 24px', maxWidth: 1560, margin: '0 auto', position: 'relative', zIndex: 1 }}>

        {error && (
          <div style={{
            marginBottom: 14, padding: '10px 16px', borderRadius: 12,
            background: 'var(--red-pale)', border: '1px solid rgba(192,69,62,0.3)',
            fontSize: 12, color: 'var(--red)',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          }}>
            <span>Pipeline error: {error}</span>
            <button onClick={runCycle} style={{
              background: 'transparent', border: '1px solid var(--red)',
              borderRadius: 6, padding: '3px 10px', color: 'var(--red)',
              cursor: 'pointer', fontSize: 11, fontWeight: 600,
            }}>Retry</button>
          </div>
        )}



        <div style={{ display: 'grid', gridTemplateColumns: '310px 1fr 290px', gap: 14, alignItems: 'start' }}>

          {/* ─── LEFT ─── */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <MarketCard
              market={activeMarket}
              orderbook={liveOrderbook}
              strikePrice={strikePrice}
              currentBTCPrice={currentBTCPrice}
              secondsUntilExpiry={secondsUntilExpiry}
              liveMode={true}
              onRefresh={refreshMarket}
            />
            <SignalPanel probability={prob} sentiment={sent} strikePrice={strikePrice} />
          </div>

          {/* ─── CENTER ─── */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>

            {/* ── Control bar: mode toggle + model picker (AI only) + gear + run + expiry ── */}
            <div style={{ position: 'relative' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>

                {/* QUANT | AI mode toggle */}
                <div style={{ display: 'flex', borderRadius: 8, border: '1px solid var(--border)', overflow: 'hidden', flexShrink: 0 }}>
                  {(['quant', 'ai'] as const).map(mode => (
                    <button
                      key={mode}
                      onClick={() => handleAnalysisModeChange(mode)}
                      style={{
                        padding: '6px 14px', cursor: 'pointer', border: 'none',
                        fontSize: 11, fontWeight: 800, letterSpacing: '0.05em', textTransform: 'uppercase',
                        background: analysisMode === mode
                          ? (mode === 'ai' ? 'var(--blue)' : 'var(--brown)')
                          : 'var(--bg-secondary)',
                        color: analysisMode === mode ? '#fff' : 'var(--text-muted)',
                        transition: 'all 0.15s',
                      }}
                    >
                      {mode === 'quant' ? '∑ Quant' : '✦ AI'}
                    </button>
                  ))}
                </div>

                {/* Grok model picker — only visible in AI mode */}
                {analysisMode === 'ai' && (() => {
                  const GROK_MODELS = [
                    { id: 'grok-3',           label: 'xAI: Grok 3',           sub: 'Most capable' },
                    { id: 'grok-3-fast',      label: 'xAI: Grok 3 Fast',      sub: 'Faster · good quality' },
                    { id: 'grok-3-mini',      label: 'xAI: Grok 3 Mini',      sub: 'Compact reasoning' },
                    { id: 'grok-3-mini-fast', label: 'xAI: Grok 3 Mini Fast', sub: 'Fastest · lowest cost' },
                  ]
                  const selected = GROK_MODELS.find(m => m.id === orModel) ?? GROK_MODELS[0]
                  return (
                    <div ref={grokMenuRef} style={{ position: 'relative', flex: 1, minWidth: 0 }}>
                      <button
                        onClick={() => setGrokMenuOpen(v => !v)}
                        style={{
                          width: '100%', textAlign: 'left', cursor: 'pointer',
                          padding: '6px 12px', borderRadius: 8,
                          border: '1px solid var(--blue)',
                          background: 'rgba(58,114,168,0.08)',
                          color: 'var(--blue-dark)',
                          display: 'flex', alignItems: 'center', gap: 8,
                        }}
                      >
                        <span style={{ fontSize: 9, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--text-muted)', flexShrink: 0 }}>Model</span>
                        <span style={{ fontSize: 12, fontWeight: 600, flex: 1 }}>{selected.label}</span>
                        <span style={{ fontSize: 10, opacity: 0.4, flexShrink: 0 }}>{grokMenuOpen ? '▲' : '▼'}</span>
                      </button>

                      {grokMenuOpen && (
                        <div className="animate-fade-in" style={{
                          position: 'absolute', top: '100%', left: 0, marginTop: 4, zIndex: 200,
                          background: 'var(--bg-card)', border: '1px solid var(--border)',
                          borderRadius: 10, boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
                          width: '100%', minWidth: 240,
                        }}>
                          <div style={{ padding: '5px 12px 3px', fontSize: 9, fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                            xAI · Grok
                          </div>
                          {GROK_MODELS.map(m => (
                            <div
                              key={m.id}
                              onClick={() => handleGrokModelChange(m.id)}
                              style={{
                                padding: '7px 14px', cursor: 'pointer',
                                background: orModel === m.id ? 'rgba(58,114,168,0.1)' : 'transparent',
                                borderLeft: orModel === m.id ? '2px solid var(--blue)' : '2px solid transparent',
                                transition: 'background 0.1s',
                              }}
                              onMouseEnter={e => { if (orModel !== m.id) (e.currentTarget as HTMLElement).style.background = 'var(--bg-secondary)' }}
                              onMouseLeave={e => { if (orModel !== m.id) (e.currentTarget as HTMLElement).style.background = 'transparent' }}
                            >
                              <div style={{ fontSize: 12, fontWeight: orModel === m.id ? 700 : 500, color: orModel === m.id ? 'var(--blue-dark)' : 'var(--text-primary)' }}>{m.label}</div>
                              <div style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 1 }}>{m.sub}</div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })()}

                {/* Settings gear */}
                <button
                  onClick={() => setShowSettings(v => !v)}
                  title="Advanced settings"
                  style={{
                    width: 32, height: 32, borderRadius: 8, cursor: 'pointer', flexShrink: 0,
                    border: showSettings ? '1px solid var(--brown)' : '1px solid var(--border)',
                    background: showSettings ? 'var(--brown-pale)' : 'var(--bg-secondary)',
                    color: showSettings ? 'var(--brown)' : 'var(--text-muted)',
                    fontSize: 14, display: 'flex', alignItems: 'center', justifyContent: 'center',
                    transition: 'all 0.15s',
                  }}>
                  ⚙
                </button>

                {/* Run / Stop + expiry — pushed right */}
                <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
                  <button
                    onClick={isRunning ? stopCycle : (serverLocked ? undefined : () => {
                      if (secondsUntilExpiry > 0 && secondsUntilExpiry < 120) {
                        setShowLateWarning(true)
                      } else {
                        runCycle()
                      }
                    })}
                    disabled={serverLocked && !isRunning}
                    style={{
                      padding: '7px 20px', borderRadius: 9, background: 'transparent',
                      border: isRunning ? '1.5px solid var(--pink)' : serverLocked ? '1.5px solid var(--border)' : '1.5px solid var(--green)',
                      color: isRunning ? 'var(--pink)' : serverLocked ? 'var(--text-muted)' : 'var(--green-dark)',
                      cursor: isRunning ? 'pointer' : serverLocked ? 'not-allowed' : 'pointer',
                      fontSize: 12, fontWeight: 700,
                      display: 'flex', alignItems: 'center', gap: 6,
                      transition: 'all 0.2s', letterSpacing: '0.02em',
                    }}
                    onMouseEnter={e => { if (!serverLocked) { e.currentTarget.style.background = isRunning ? 'var(--pink-pale)' : 'var(--green-pale)' } }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
                  >
                    {isRunning
                      ? <><span>■</span> Stop <span style={{ fontSize: 9, opacity: 0.5, fontWeight: 400 }}>⇧R</span></>
                      : serverLocked
                      ? <><span style={{ animation: 'spin-slow 1s linear infinite', display: 'inline-block' }}>◌</span> Running...</>
                      : <>▶ Run Cycle <span style={{ fontSize: 9, opacity: 0.5, fontWeight: 400 }}>⇧R</span></>}
                  </button>

                  {secondsUntilExpiry > 0 && (() => {
                    const m = Math.floor(secondsUntilExpiry / 60)
                    const s = secondsUntilExpiry % 60
                    const urgent = secondsUntilExpiry < 120
                    const color  = secondsUntilExpiry < 60 ? 'var(--pink)' : secondsUntilExpiry < 120 ? 'var(--amber)' : 'var(--green-dark)'
                    return (
                      <div style={{
                        display: 'flex', alignItems: 'center', gap: 5,
                        padding: '5px 10px', borderRadius: 8,
                        background: urgent ? 'var(--pink-pale)' : 'var(--bg-secondary)',
                        border: `1px solid ${urgent ? '#3a1020' : 'var(--border)'}`,
                      }}>
                        <span style={{ fontSize: 9, color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Exp</span>
                        <span style={{
                          fontFamily: 'var(--font-geist-mono)', fontSize: 14, fontWeight: 800, color,
                          animation: urgent ? 'urgentPulse 1s ease infinite' : 'none',
                        }}>
                          {m}:{String(s).padStart(2, '0')}
                        </span>
                      </div>
                    )
                  })()}

                  {/* AI monitor badge — shows live Δ from last run vs 0.20% trigger */}
                  {aiRisk && botActive && !isRunning && monitorDeltaPct !== null && (
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: 4,
                      padding: '5px 9px', borderRadius: 8,
                      background: 'rgba(58,114,168,0.07)', border: '1px solid #8ab4cf',
                    }} title="Grok re-runs when BTC moves ≥0.20% from last run">
                      <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--blue)', display: 'inline-block', animation: 'pulse-live 2s ease-in-out infinite', flexShrink: 0 }} />
                      <span style={{ fontSize: 9, color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Δ</span>
                      <span style={{
                        fontFamily: 'var(--font-geist-mono)', fontSize: 12, fontWeight: 700,
                        color: Math.abs(monitorDeltaPct) >= 0.15 ? 'var(--amber)' : 'var(--blue)',
                      }}>
                        {monitorDeltaPct >= 0 ? '+' : ''}{monitorDeltaPct.toFixed(2)}%
                      </span>
                      <span style={{ fontSize: 9, color: 'var(--text-muted)', opacity: 0.6 }}>/0.20%</span>
                    </div>
                  )}
                </div>
              </div>

              {/* Settings dropdown */}
              {showSettings && (
                <div className="animate-fade-in" style={{
                  position: 'absolute', top: '100%', left: 0, marginTop: 6, zIndex: 50,
                  background: 'var(--bg-card)', border: '1px solid var(--border)',
                  borderRadius: 12, padding: '12px 16px',
                  boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
                  minWidth: 200,
                }}>
                  <div style={{ fontSize: 9, fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 8 }}>Analysis Mode</div>
                  <div style={{ fontSize: 11, color: analysisMode === 'quant' ? 'var(--brown)' : 'var(--blue)', fontWeight: 700, marginBottom: 4 }}>
                    {analysisMode === 'quant' ? '∑ Quant — pure Brownian math, no LLM' : '✦ AI — Grok-enhanced analysis'}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                    {analysisMode === 'quant'
                      ? 'd-score · Cornish-Fisher CF-VaR · GK vol · Kelly sizing. Deterministic & fast.'
                      : 'Quant pipeline + Grok AI risk manager (ROMA). Switch model above.'}
                  </div>
                </div>
              )}
            </div>

            <PriceChart priceHistory={priceHistory} strikePrice={strikePrice} currentPrice={currentBTCPrice} />
            <AgentPipeline pipeline={pipeline} isRunning={isRunning} streamingAgents={streamingAgents} aiMode={analysisMode === 'ai'} />
            <PipelineHistory history={history} />

          </div>

          {/* ─── RIGHT ─── */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <PositionsPanel liveMode={true} />
            <MarkovPanel markov={markov} />

            {exec && exec.action !== 'PASS' && (
              <div className="card bracket-card animate-fade-in" style={{
                borderColor: exec.action === 'BUY_YES' ? 'rgba(45,158,107,0.3)' : 'rgba(58,114,168,0.3)',
                background: 'var(--bg-card)',
              }}>
                <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6,
                  color: exec.action === 'BUY_YES' ? 'var(--green-dark)' : 'var(--blue-dark)' }}>
                  <span style={{ fontSize: 16 }}>{exec.action === 'BUY_YES' ? '↑' : '↓'}</span>
                  {exec.action === 'BUY_YES' ? 'BUY YES' : 'BUY NO'} — Latest Signal
                  <span style={{ marginLeft: 'auto', fontSize: 9, fontWeight: 700, color: 'var(--green-dark)', background: 'var(--green-pale)', border: '1px solid rgba(45,158,107,0.25)', borderRadius: 4, padding: '1px 5px' }}>LIVE</span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 7 }}>
                  {[
                    ['Contracts', String(exec.contracts)],
                    ['Limit',     `${exec.limitPrice}¢`],
                    ['Cost',      `$${exec.estimatedCost.toFixed(2)}`],
                    ['Max profit',`$${(exec.estimatedPayout - exec.estimatedCost).toFixed(2)}`],
                  ].map(([k, v]) => (
                    <div key={k} style={{ padding: '8px', background: 'var(--bg-secondary)', borderRadius: 8, border: '1px solid var(--border)' }}>
                      <div style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 2 }}>{k}</div>
                      <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>{v}</div>
                    </div>
                  ))}
                </div>
                <div style={{ marginTop: 8, fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                  {exec.rationale.replace('Paper trade only — no real order placed.', 'Live mode — real order placed via Kalshi API.')}
                </div>
                {md?.activeMarket && (
                  <div style={{ marginTop: 10, padding: '7px 10px', borderRadius: 8, background: 'var(--bg-secondary)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12 }}>
                    <span style={{ fontSize: 8, color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', flexShrink: 0 }}>At run</span>
                    {[
                      ['YES ask', md.activeMarket.yes_ask],
                      ['YES bid', md.activeMarket.yes_bid],
                      ['NO ask',  md.activeMarket.no_ask],
                    ].map(([label, val]) => (
                      <span key={label as string} style={{ fontSize: 10, color: 'var(--text-secondary)' }}>
                        <span style={{ color: 'var(--text-muted)', marginRight: 3 }}>{label}</span>
                        <span style={{ fontFamily: 'var(--font-geist-mono)', fontWeight: 700, color: 'var(--text-primary)' }}>{val}¢</span>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  )
}
