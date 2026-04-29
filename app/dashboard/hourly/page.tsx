'use client'

import { useState, useEffect, useRef } from 'react'
import { usePipeline } from '@/hooks/usePipeline'
import { useMarketTick } from '@/hooks/useMarketTick'
import HourlyHeader from '@/components/HourlyHeader'
import MarketCard from '@/components/MarketCard'
import PriceChart from '@/components/PriceChart'
import AgentPipeline from '@/components/AgentPipeline'
import SignalPanel from '@/components/SignalPanel'
import PositionsPanel from '@/components/PositionsPanel'
import PipelineHistory from '@/components/PipelineHistory'

// Hourly (KXBTCD) dashboard — completely separate from the 15m app.
// - Always uses Grok (price prediction). No QUANT option.
// - Polls KXBTCD markets only — never touches KXBTC15M.
// - Late-start warning at 10 min remaining (not 2 min).

export default function HourlyDashboard() {
  const [showLateWarning, setShowLateWarning] = useState(false)
  const [analysisMode, setAnalysisMode]       = useState<'ai' | 'quant'>('ai')
  const [orModel, setOrModel]                 = useState<string>('grok-3')
  const [grokMenuOpen, setGrokMenuOpen]       = useState(false)
  const grokMenuRef                           = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const saved = localStorage.getItem('sentient-grok-model-hourly')
    if (saved) setOrModel(saved)
    const savedMode = localStorage.getItem('sentient-analysis-mode-hourly')
    if (savedMode === 'quant' || savedMode === 'ai') setAnalysisMode(savedMode)
  }, [])

  function handleAnalysisModeChange(mode: 'ai' | 'quant') {
    setAnalysisMode(mode)
    localStorage.setItem('sentient-analysis-mode-hourly', mode)
  }

  function handleGrokModelChange(m: string) {
    setOrModel(m)
    localStorage.setItem('sentient-grok-model-hourly', m)
    setGrokMenuOpen(false)
  }

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

  // Market tick — KXBTCD only. Starts null, set from pipeline after first run.
  const [marketTicker, setMarketTicker] = useState<string | null>(null)
  const { liveMarket, liveOrderbook, liveBTCPrice, livePriceHistory, refresh: refreshMarket } = useMarketTick(marketTicker, 'hourly')

  const liveStrikePrice = (liveMarket?.yes_sub_title
    ? parseFloat(liveMarket.yes_sub_title.replace(/[^0-9.]/g, ''))
    : 0) || liveMarket?.floor_strike || 0

  // Pipeline — always hourly + AI (Grok price prediction)
  const aiMode = analysisMode === 'ai'
  const { pipeline, history, streamingAgents, isRunning, serverLocked, error, runCycle, stopCycle } = usePipeline(
    true, false, aiMode, undefined, undefined,
    aiMode ? (orModel || 'grok-3') : undefined,
    liveBTCPrice || undefined, liveStrikePrice || undefined,
    'hourly',
  )

  const md   = pipeline?.agents.marketDiscovery.output
  const pf   = pipeline?.agents.priceFeed.output
  const prob = pipeline?.agents.probability.output ?? null
  const sent = pipeline?.agents.sentiment.output ?? null
  const exec = pipeline?.agents.execution.output
  const predictedPrice: number | undefined = prob?.predictedPrice ?? undefined

  // Sync market ticker from pipeline
  useEffect(() => {
    const t = md?.activeMarket?.ticker ?? null
    if (t && t !== marketTicker) setMarketTicker(t)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [md?.activeMarket?.ticker])

  // Merge live market with pipeline data — filter expired on both sources
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

  // When the live market has expired, clear marketTicker so useMarketTick
  // auto-discovers the next active KXBTCD market instead of polling the dead one.
  useEffect(() => {
    if (liveMarketExpired) setMarketTicker(null)
  }, [liveMarketExpired])
  const currentBTCPrice = liveBTCPrice ?? pf?.currentPrice ?? 0
  const priceHistory    = livePriceHistory

  const liveStrikeFromSubtitle = activeMarket?.yes_sub_title
    ? parseFloat(activeMarket.yes_sub_title.replace(/[^0-9.]/g, ''))
    : 0
  const strikePrice = (liveStrikeFromSubtitle > 0 ? liveStrikeFromSubtitle : null)
    ?? md?.strikePrice ?? activeMarket?.floor_strike ?? 0

  const secondsUntilExpiry = activeMarket?.close_time
    ? Math.max(0, Math.floor((new Date(activeMarket.close_time).getTime() - Date.now()) / 1000))
    : (md?.secondsUntilExpiry ?? 0)

  // Keyboard shortcut: Shift+R
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!e.shiftKey || e.code !== 'KeyR') return
      if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'TEXTAREA') return
      e.preventDefault()
      if (isRunning) { stopCycle(); return }
      if (serverLocked) return
      if (secondsUntilExpiry > 0 && secondsUntilExpiry < 600) { setShowLateWarning(true); return }
      runCycle()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRunning, serverLocked, secondsUntilExpiry])

  // Trade alert
  type TradeAlert = { action: string; side: 'yes' | 'no'; limitPrice: number; ticker: string; edge: number; pModel: number; windowKey: string }
  const [tradeAlert, setTradeAlert] = useState<TradeAlert | null>(null)
  const [alertStatus, setAlertStatus] = useState<'idle' | 'placing' | 'ok' | 'err'>('idle')
  const alertShownWindowRef = useRef<string | null>(null)

  function getDismissedKey() { return typeof window !== 'undefined' ? localStorage.getItem('alertDismissedWindowHourly') : null }
  function setDismissedKey(k: string) { localStorage.setItem('alertDismissedWindowHourly', k) }

  useEffect(() => {
    if (!pipeline) return
    const ex   = pipeline.agents.execution.output
    const prob = pipeline.agents.probability.output
    const mdOut = pipeline.agents.marketDiscovery.output
    const windowKey = (mdOut.activeMarket as { event_ticker?: string } | undefined)?.event_ticker
      ?? mdOut.activeMarket?.ticker.split('-').slice(0, 2).join('-') ?? null
    if (!windowKey) return
    if (alertShownWindowRef.current === windowKey) return
    if (getDismissedKey() === windowKey) return
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
        clientOrderId: `alert-hourly-${Date.now()}` }
      const res  = await fetch('/api/place-order', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const data = await res.json()
      if (!res.ok || !data.ok) { setAlertStatus('err') }
      else { setAlertStatus('ok'); setTimeout(() => setTradeAlert(null), 2000) }
    } catch { setAlertStatus('err') }
  }

  const GROK_MODELS = [
    { id: 'grok-3',           label: 'Grok 3',           sub: 'Most capable' },
    { id: 'grok-3-fast',      label: 'Grok 3 Fast',      sub: 'Faster · good quality' },
    { id: 'grok-3-mini',      label: 'Grok 3 Mini',      sub: 'Compact reasoning' },
    { id: 'grok-3-mini-fast', label: 'Grok 3 Mini Fast', sub: 'Fastest · lowest cost' },
  ]
  const selectedModel = GROK_MODELS.find(m => m.id === orModel) ?? GROK_MODELS[0]

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-primary)', position: 'relative' }}>
      <div className="noise-overlay" />
      <HourlyHeader
        cycleId={pipeline?.cycleId ?? 0}
        isRunning={isRunning}
        lastCompletedAt={pipeline?.cycleCompletedAt}
        onRunCycle={isRunning || serverLocked ? undefined : runCycle}
      />

      {/* Late-start warning */}
      {showLateWarning && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.35)', backdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div className="card animate-fade-in" style={{ maxWidth: 400, width: '90%', padding: '28px 28px' }}>
            <div style={{ fontSize: 22, marginBottom: 10 }}>⏱</div>
            <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--text-primary)', marginBottom: 8 }}>Under 10 Minutes Remaining</div>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 20 }}>
              The current 1-hour window closes in <strong>less than 10 minutes</strong>. The pipeline takes ~1–3 min — there will be very little time to act on the signal.
              <br /><br />
              Any signal will likely be <strong>near expiry when it completes</strong>.
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => setShowLateWarning(false)} style={{ flex: 1, padding: '10px 0', borderRadius: 9, cursor: 'pointer', border: '1px solid var(--border)', background: 'var(--bg-secondary)', fontSize: 13, fontWeight: 700, color: 'var(--text-secondary)' }}>Cancel</button>
              <button onClick={() => { setShowLateWarning(false); runCycle() }} style={{ flex: 1, padding: '10px 0', borderRadius: 9, cursor: 'pointer', border: '1px solid var(--amber)', background: 'var(--amber)', fontSize: 13, fontWeight: 700, color: '#fff' }}>Run Anyway</button>
            </div>
          </div>
        </div>
      )}

      {/* Trade alert */}
      {tradeAlert && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 1100, background: 'rgba(0,0,0,0.35)', backdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div className="card animate-fade-in" style={{ maxWidth: 360, width: '90%', padding: '26px 24px', border: tradeAlert.side === 'yes' ? '1.5px solid rgba(45,158,107,0.3)' : '1.5px solid rgba(192,69,62,0.3)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
              <div style={{ width: 42, height: 42, borderRadius: '50%', background: tradeAlert.side === 'yes' ? 'var(--green-pale)' : 'var(--pink-pale)', border: tradeAlert.side === 'yes' ? '1.5px solid rgba(45,158,107,0.3)' : '1.5px solid rgba(192,69,62,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22, color: tradeAlert.side === 'yes' ? 'var(--green)' : 'var(--pink)', animation: 'iconBeat 2s ease infinite' }}>
                {tradeAlert.side === 'yes' ? '↑' : '↓'}
              </div>
              <div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 2 }}>Grok Hourly Signal</div>
                <div style={{ fontSize: 18, fontWeight: 800, color: tradeAlert.side === 'yes' ? 'var(--green-dark)' : 'var(--pink)', lineHeight: 1 }}>
                  BUY {tradeAlert.side.toUpperCase()} @ {tradeAlert.limitPrice}¢
                </div>
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 16 }}>
              {[['Edge', `+${(tradeAlert.edge ?? 0).toFixed(1)}%`], ['P(model)', `${((tradeAlert.pModel ?? 0) * 100).toFixed(0)}%`]].map(([k, v]) => (
                <div key={k} style={{ padding: '8px 10px', borderRadius: 9, background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
                  <div style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 3 }}>{k}</div>
                  <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 16, fontWeight: 800, color: 'var(--text-primary)' }}>{v}</div>
                </div>
              ))}
            </div>
            {alertStatus === 'idle' && (
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => { setDismissedKey(tradeAlert.windowKey); setTradeAlert(null) }} style={{ flex: 1, padding: '10px 0', borderRadius: 9, cursor: 'pointer', border: '1px solid var(--border)', background: 'var(--bg-secondary)', fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)' }}>Dismiss</button>
                <button onClick={executeAlertTrade} style={{ flex: 2, padding: '10px 0', borderRadius: 9, cursor: 'pointer', background: tradeAlert.side === 'yes' ? 'var(--green)' : 'var(--pink)', border: 'none', fontSize: 14, fontWeight: 800, color: '#fff' }}>Buy $40</button>
              </div>
            )}
            {alertStatus === 'placing' && <div style={{ textAlign: 'center', padding: '10px 0', fontSize: 12, color: 'var(--text-muted)' }}>Placing order...</div>}
            {alertStatus === 'ok' && <div style={{ textAlign: 'center', padding: '10px 0', fontSize: 13, fontWeight: 700, color: 'var(--green-dark)' }}>✓ Order placed!</div>}
            {alertStatus === 'err' && <div style={{ textAlign: 'center' }}><div style={{ fontSize: 12, color: 'var(--red)', marginBottom: 8 }}>Order failed</div><button onClick={() => setAlertStatus('idle')} style={{ fontSize: 11, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}>Try again</button></div>}
          </div>
        </div>
      )}

      <main style={{ padding: '20px 24px', maxWidth: 1560, margin: '0 auto', position: 'relative', zIndex: 1 }}>

        {error && error !== 'KXBTCD_NO_MARKET' && (
          <div style={{ marginBottom: 14, padding: '10px 16px', borderRadius: 12, background: 'var(--red-pale)', border: '1px solid rgba(192,69,62,0.3)', fontSize: 12, color: 'var(--red)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>Pipeline error: {error}</span>
            <button onClick={runCycle} style={{ background: 'transparent', border: '1px solid var(--red)', borderRadius: 6, padding: '3px 10px', color: 'var(--red)', cursor: 'pointer', fontSize: 11, fontWeight: 600 }}>Retry</button>
          </div>
        )}
        {error === 'KXBTCD_NO_MARKET' && (
          <div style={{ marginBottom: 14, padding: '12px 18px', borderRadius: 12, background: 'rgba(224,111,160,0.06)', border: '1px solid rgba(224,111,160,0.2)', fontSize: 12, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 16 }}>◷</span>
            <span><strong style={{ color: 'var(--text-primary)' }}>No KXBTCD market open right now.</strong> Kalshi hourly BTC markets run during active trading hours. Check back later or <button onClick={runCycle} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--pink)', fontWeight: 700, fontSize: 12, padding: 0 }}>retry</button>.</span>
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '310px 1fr 290px', gap: 14, alignItems: 'start' }}>

          {/* ── LEFT ── */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <MarketCard
              market={activeMarket}
              orderbook={liveOrderbook}
              strikePrice={strikePrice}
              currentBTCPrice={currentBTCPrice}
              secondsUntilExpiry={secondsUntilExpiry}
              liveMode={true}
              onRefresh={refreshMarket}
              marketMode="hourly"
              predictedPrice={predictedPrice}
            />
            <SignalPanel probability={prob} sentiment={sent} strikePrice={strikePrice} />

            {exec && exec.action !== 'PASS' && (
              <div className="card bracket-card animate-fade-in" style={{ borderColor: exec.action === 'BUY_YES' ? 'rgba(45,158,107,0.3)' : 'rgba(58,114,168,0.3)', background: 'var(--bg-card)' }}>
                <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6, color: exec.action === 'BUY_YES' ? 'var(--green-dark)' : 'var(--blue-dark)' }}>
                  <span style={{ fontSize: 16 }}>{exec.action === 'BUY_YES' ? '↑' : '↓'}</span>
                  {exec.action === 'BUY_YES' ? 'BUY YES' : 'BUY NO'} — Latest Signal
                  <span style={{ marginLeft: 'auto', fontSize: 9, fontWeight: 700, color: 'var(--pink)', background: 'var(--pink-pale)', border: '1px solid rgba(224,111,160,0.25)', borderRadius: 4, padding: '1px 5px' }}>1H</span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 7 }}>
                  {[
                    ['Contracts', String(exec.contracts)],
                    ['Limit',     `${exec.limitPrice}¢`],
                    ['Cost',      `$${(exec.estimatedCost ?? 0).toFixed(2)}`],
                    ['Max profit',`$${((exec.estimatedPayout ?? 0) - (exec.estimatedCost ?? 0)).toFixed(2)}`],
                  ].map(([k, v]) => (
                    <div key={k} style={{ padding: '8px', background: 'var(--bg-secondary)', borderRadius: 8, border: '1px solid var(--border)' }}>
                      <div style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 2 }}>{k}</div>
                      <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>{v}</div>
                    </div>
                  ))}
                </div>
                {predictedPrice && predictedPrice > 0 && (
                  <div style={{ marginTop: 8, padding: '6px 10px', borderRadius: 8, background: 'var(--bg-secondary)', border: '1px solid var(--border)', fontSize: 10 }}>
                    <span style={{ color: 'var(--text-muted)' }}>Grok predicts </span>
                    <span style={{ fontFamily: 'var(--font-geist-mono)', fontWeight: 700, color: 'var(--text-primary)' }}>
                      ${predictedPrice.toLocaleString('en-US', { maximumFractionDigits: 0 })}
                    </span>
                    <span style={{ color: 'var(--text-muted)' }}> vs strike </span>
                    <span style={{ fontFamily: 'var(--font-geist-mono)', fontWeight: 700, color: 'var(--text-primary)' }}>
                      ${strikePrice > 0 ? strikePrice.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—'}
                    </span>
                  </div>
                )}
                <div style={{ marginTop: 8, fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.5 }}>{exec.rationale}</div>
              </div>
            )}
          </div>

          {/* ── CENTER ── */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>

            {/* Control bar */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>

              {/* Mode badge */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 8, background: 'rgba(224,111,160,0.12)', border: '1px solid rgba(224,111,160,0.3)', flexShrink: 0 }}>
                <span style={{ fontSize: 11, color: 'var(--pink)', fontWeight: 800 }}>◷ 1H</span>
                <span style={{ fontSize: 9, color: 'var(--text-muted)', fontWeight: 600 }}>KXBTCD · {aiMode ? 'Grok Forecast' : 'Quant'}</span>
              </div>

              {/* Quant | AI toggle */}
              <div style={{ display: 'flex', borderRadius: 8, overflow: 'hidden', border: '1px solid rgba(224,111,160,0.3)', flexShrink: 0 }}>
                {(['quant', 'ai'] as const).map(mode => (
                  <button key={mode} onClick={() => handleAnalysisModeChange(mode)} style={{
                    padding: '5px 12px', cursor: 'pointer', border: 'none', fontSize: 11, fontWeight: 700,
                    background: analysisMode === mode
                      ? (mode === 'ai' ? 'var(--pink)' : 'var(--brown)')
                      : 'transparent',
                    color: analysisMode === mode ? '#fff' : 'var(--text-muted)',
                    transition: 'all 0.15s',
                  }}>
                    {mode === 'quant' ? '∑ Quant' : '◷ AI'}
                  </button>
                ))}
              </div>

              {/* Grok model picker — only in AI mode */}
              {aiMode && <div ref={grokMenuRef} style={{ position: 'relative', flex: 1, minWidth: 0 }}>
                <button onClick={() => setGrokMenuOpen(v => !v)} style={{ width: '100%', textAlign: 'left', cursor: 'pointer', padding: '6px 12px', borderRadius: 8, border: '1px solid var(--pink)', background: 'rgba(224,111,160,0.07)', color: 'var(--pink)', display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 9, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--text-muted)', flexShrink: 0 }}>Model</span>
                  <span style={{ fontSize: 12, fontWeight: 600, flex: 1 }}>{selectedModel.label}</span>
                  <span style={{ fontSize: 10, opacity: 0.4, flexShrink: 0 }}>{grokMenuOpen ? '▲' : '▼'}</span>
                </button>
                {grokMenuOpen && (
                  <div className="animate-fade-in" style={{ position: 'absolute', top: '100%', left: 0, marginTop: 4, zIndex: 200, background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10, boxShadow: '0 8px 32px rgba(0,0,0,0.18)', width: '100%', minWidth: 240 }}>
                    <div style={{ padding: '5px 12px 3px', fontSize: 9, fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>xAI · Grok</div>
                    {GROK_MODELS.map(m => (
                      <div key={m.id} onClick={() => handleGrokModelChange(m.id)} style={{ padding: '7px 14px', cursor: 'pointer', background: orModel === m.id ? 'rgba(224,111,160,0.1)' : 'transparent', borderLeft: orModel === m.id ? '2px solid var(--pink)' : '2px solid transparent', transition: 'background 0.1s' }} onMouseEnter={e => { if (orModel !== m.id) (e.currentTarget as HTMLElement).style.background = 'var(--bg-secondary)' }} onMouseLeave={e => { if (orModel !== m.id) (e.currentTarget as HTMLElement).style.background = 'transparent' }}>
                        <div style={{ fontSize: 12, fontWeight: orModel === m.id ? 700 : 500, color: orModel === m.id ? 'var(--pink)' : 'var(--text-primary)' }}>{m.label}</div>
                        <div style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 1 }}>{m.sub}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>}

              {/* Run / Stop + expiry */}
              <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
                <button
                  onClick={isRunning ? stopCycle : (serverLocked ? undefined : () => {
                    if (secondsUntilExpiry > 0 && secondsUntilExpiry < 600) {
                      setShowLateWarning(true)
                    } else {
                      runCycle()
                    }
                  })}
                  disabled={serverLocked && !isRunning}
                  style={{ padding: '7px 20px', borderRadius: 9, background: 'transparent', border: isRunning ? '1.5px solid var(--pink)' : serverLocked ? '1.5px solid var(--border)' : '1.5px solid var(--pink)', color: isRunning ? 'var(--pink)' : serverLocked ? 'var(--text-muted)' : 'var(--pink)', cursor: isRunning ? 'pointer' : serverLocked ? 'not-allowed' : 'pointer', fontSize: 12, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6, transition: 'all 0.2s', letterSpacing: '0.02em' }}
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
                  const urgent = secondsUntilExpiry < 600
                  const color  = secondsUntilExpiry < 300 ? 'var(--pink)' : secondsUntilExpiry < 600 ? 'var(--amber)' : 'var(--green-dark)'
                  return (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 10px', borderRadius: 8, background: urgent ? 'var(--pink-pale)' : 'var(--bg-secondary)', border: `1px solid ${urgent ? 'rgba(224,111,160,0.3)' : 'var(--border)'}` }}>
                      <span style={{ fontSize: 9, color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Closes</span>
                      <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 14, fontWeight: 800, color, animation: urgent ? 'urgentPulse 1s ease infinite' : 'none' }}>
                        {m}:{String(s).padStart(2, '0')}
                      </span>
                    </div>
                  )
                })()}

              </div>
            </div>

            <PriceChart priceHistory={priceHistory} strikePrice={strikePrice} currentPrice={currentBTCPrice} />
            <AgentPipeline pipeline={pipeline} isRunning={isRunning} streamingAgents={streamingAgents} aiMode={aiMode} marketMode="hourly" />
            <PipelineHistory history={history} />
          </div>

          {/* ── RIGHT ── */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <PositionsPanel liveMode={true} />
          </div>

        </div>
      </main>
    </div>
  )
}
