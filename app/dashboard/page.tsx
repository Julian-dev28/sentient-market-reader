'use client'

import { useState, useEffect, useRef } from 'react'
import { usePipeline } from '@/hooks/usePipeline'
import { useMarketTick } from '@/hooks/useMarketTick'
import Header from '@/components/Header'
import MarketCard from '@/components/MarketCard'
import PriceChart from '@/components/PriceChart'
import AgentPipeline from '@/components/AgentPipeline'
import SignalPanel from '@/components/SignalPanel'
import TradeLog from '@/components/TradeLog'
import PerformancePanel from '@/components/PerformancePanel'
import PositionsPanel from '@/components/PositionsPanel'
import PipelineHistory from '@/components/PipelineHistory'
import ChallengePanel from '@/components/ChallengePanel'
import StrategyPanel from '@/components/StrategyPanel'

export default function Home() {
  const [liveMode, setLiveMode]           = useState(false)
  const [showLiveWarning, setShowLiveWarning] = useState(false)
  const [botActive, setBotActive]           = useState(false)
  const [showBotWarning, setShowBotWarning] = useState(false)
  const [showLateWarning, setShowLateWarning] = useState(false)
  const [aiRisk, setAiRisk]                 = useState(false)
  const [sentMode, setSentMode]             = useState<string | undefined>(undefined)
  const [probMode, setProbMode]             = useState<string | undefined>(undefined)
  const [orModel, setOrModel]               = useState<string>('')
  const [showSettings, setShowSettings]     = useState(false)
  const [orModels, setOrModels]             = useState<{ id: string; name: string }[]>([])
  const [orModelsLoading, setOrModelsLoading] = useState(false)
  const [orModelSearch, setOrModelSearch]   = useState('')
  const [orModelOpen, setOrModelOpen]       = useState(false)
  const [orModelCat, setOrModelCat]         = useState<'all'|'fast'|'balanced'|'reasoning'|'large'|'favorites'>('all')
  const [orFavorites, setOrFavorites]       = useState<string[]>([])
  const orModelRef                          = useRef<HTMLDivElement>(null)

  // Sync from localStorage after hydration
  useEffect(() => {
    if (localStorage.getItem('sentient-live-mode') === 'true') setLiveMode(true)
    const om = localStorage.getItem('sentient-or-model')
    if (om) setOrModel(om)
    const fav = localStorage.getItem('sentient-or-favorites')
    if (fav) try { setOrFavorites(JSON.parse(fav)) } catch {}
  }, [])

  function toggleFavorite(id: string) {
    setOrFavorites(prev => {
      const next = prev.includes(id) ? prev.filter(f => f !== id) : [...prev, id]
      localStorage.setItem('sentient-or-favorites', JSON.stringify(next))
      return next
    })
  }

  function handleOrModelChange(m: string) {
    setOrModel(m)
    if (m) localStorage.setItem('sentient-or-model', m)
    else localStorage.removeItem('sentient-or-model')
  }

  // Fetch OpenRouter model list on mount (non-blocking)
  useEffect(() => {
    if (orModels.length > 0 || orModelsLoading) return
    setOrModelsLoading(true)
    fetch('/api/openrouter-models')
      .then(r => r.json())
      .then(d => { if (d.models?.length) setOrModels(d.models) })
      .catch(() => {})
      .finally(() => setOrModelsLoading(false))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Close model dropdown on outside click
  useEffect(() => {
    if (!orModelOpen) return
    function handleClick(e: MouseEvent) {
      if (orModelRef.current && !orModelRef.current.contains(e.target as Node)) {
        setOrModelOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [orModelOpen])

  const romaMode: string = 'keen'

  // ── Market tick — runs BEFORE usePipeline so btcPrice/strikePrice are available
  // for strike-flip detection. useMarketTick auto-discovers the active market when
  // ticker is null; switches to the specific ticker once pipeline has run.
  const [marketTicker, setMarketTicker] = useState<string | null>(null)
  const { liveMarket, liveOrderbook, liveBTCPrice, livePriceHistory, refresh: refreshMarket } = useMarketTick(marketTicker)

  const liveStrikePrice = (liveMarket?.yes_sub_title
    ? parseFloat(liveMarket.yes_sub_title.replace(/[^0-9.]/g, ''))
    : 0) || liveMarket?.floor_strike || 0

  const { pipeline, history, streamingAgents, trades, isRunning, serverLocked, nextCycleIn, error, stats, strikeFlipped, dismissStrikeFlip, runCycle, stopCycle } = usePipeline(
    liveMode, romaMode, botActive, aiRisk, undefined, undefined, sentMode, probMode, orModel || undefined,
    liveBTCPrice || undefined, liveStrikePrice || undefined,
  )

  // Keep marketTicker in sync with the pipeline's active market
  const md   = pipeline?.agents.marketDiscovery.output
  const pf   = pipeline?.agents.priceFeed.output
  const prob = pipeline?.agents.probability.output ?? null
  const sent = pipeline?.agents.sentiment.output ?? null
  const exec = pipeline?.agents.execution.output

  useEffect(() => {
    const t = md?.activeMarket?.ticker ?? null
    if (t) setMarketTicker(t)
  }, [md?.activeMarket?.ticker])

  // ── Trade alert pop-up ─────────────────────────────────────────────────────
  type TradeAlert = { action: string; side: 'yes' | 'no'; limitPrice: number; ticker: string; edge: number; pModel: number }
  const [tradeAlert, setTradeAlert]       = useState<TradeAlert | null>(null)
  const [alertStatus, setAlertStatus]     = useState<'idle' | 'placing' | 'ok' | 'err'>('idle')
  const lastAlertCycleRef                 = useRef<number>(0)

  useEffect(() => {
    if (!pipeline) return
    const { cycleId } = pipeline
    const ex   = pipeline.agents.execution.output
    const prob = pipeline.agents.probability.output
    if (ex.action !== 'PASS' && ex.side && ex.limitPrice != null && cycleId > lastAlertCycleRef.current) {
      lastAlertCycleRef.current = cycleId
      setTradeAlert({ action: ex.action, side: ex.side as 'yes' | 'no', limitPrice: ex.limitPrice, ticker: ex.marketTicker, edge: prob.edge, pModel: prob.pModel })
      setAlertStatus('idle')
    }
  }, [pipeline])

  async function executeAlertTrade() {
    if (!tradeAlert || !liveMode) return
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

  // Merge: live tick overrides stale pipeline values.
  // Don't fall back to pipeline market if its close_time is already in the past.
  const mdMarket = md?.activeMarket ?? null
  const mdMarketExpired = mdMarket?.close_time
    ? new Date(mdMarket.close_time).getTime() < Date.now()
    : false
  const activeMarket    = liveMarket ?? (mdMarketExpired ? null : mdMarket)
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

  function handleToggleLive() {
    if (!liveMode) {
      setShowLiveWarning(true)
    } else {
      setLiveMode(false)
      localStorage.setItem('sentient-live-mode', 'false')
    }
  }

  function confirmLive() {
    setShowLiveWarning(false)
    setLiveMode(true)
    localStorage.setItem('sentient-live-mode', 'true')
  }

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
        nextCycleIn={nextCycleIn}
        liveMode={liveMode}
        onToggleLive={handleToggleLive}
      />

      {/* Live mode warning modal */}
      {showLiveWarning && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 1000,
          background: 'rgba(5,5,7,0.80)', backdropFilter: 'blur(12px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <div className="card animate-fade-in" style={{ maxWidth: 420, width: '90%', padding: '28px 28px' }}>
            <div style={{ fontSize: 22, marginBottom: 10 }}>⚠️</div>
            <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--text-primary)', marginBottom: 8 }}>
              Enable Live Trading?
            </div>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 20 }}>
              In live mode the pipeline will place <strong>real orders on Kalshi</strong> using your API key. Real money will be at risk on each trade the execution agent approves.
              <br /><br />
              Risk parameters (3% min edge, $150 daily loss cap, 15% drawdown limit) are enforced by the agent, but no system is foolproof.
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button
                onClick={() => setShowLiveWarning(false)}
                style={{
                  flex: 1, padding: '10px 0', borderRadius: 9, cursor: 'pointer',
                  border: '1px solid var(--border)', background: 'var(--bg-secondary)',
                  fontSize: 13, fontWeight: 700, color: 'var(--text-secondary)',
                }}
              >
                Cancel
              </button>
              <button
                onClick={confirmLive}
                style={{
                  flex: 1, padding: '10px 0', borderRadius: 9, cursor: 'pointer',
                  border: '1px solid var(--green-dark)',
                  background: 'linear-gradient(135deg, var(--green-dark) 0%, var(--green) 100%)',
                  fontSize: 13, fontWeight: 700, color: '#fff',
                  boxShadow: '0 2px 10px rgba(78,138,94,0.35)',
                }}
              >
                Enable Live Trading
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bot start confirmation modal */}
      {showBotWarning && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 1000,
          background: 'rgba(5,5,7,0.80)', backdropFilter: 'blur(12px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <div className="card animate-fade-in" style={{ maxWidth: 420, width: '90%', padding: '28px 28px' }}>
            <div style={{ fontSize: 22, marginBottom: 10 }}>🤖</div>
            <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--text-primary)', marginBottom: 8 }}>
              Start Trading Agent?
            </div>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 20 }}>
              The bot will run a pipeline cycle every <strong>5 minutes</strong> and automatically place a <strong>$100 {liveMode ? 'live' : 'paper'} order</strong> when the agent approves a trade.
              {liveMode && (
                <><br /><br /><span style={{ color: 'var(--pink)', fontWeight: 700 }}>⚠ Live mode is on — real money will be used.</span></>
              )}
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
                  border: liveMode ? '1px solid var(--green-dark)' : '1px solid var(--brown)',
                  background: liveMode
                    ? 'linear-gradient(135deg, var(--green-dark) 0%, var(--green) 100%)'
                    : 'linear-gradient(135deg, #7a5c32 0%, var(--brown) 100%)',
                  fontSize: 13, fontWeight: 700, color: '#fff',
                  boxShadow: liveMode ? '0 2px 10px rgba(78,138,94,0.35)' : '0 2px 8px rgba(139,111,71,0.3)',
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
          background: 'rgba(5,5,7,0.80)', backdropFilter: 'blur(12px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <div className="card animate-fade-in" style={{ maxWidth: 400, width: '90%', padding: '28px 28px' }}>
            <div style={{ fontSize: 22, marginBottom: 10 }}>⏱</div>
            <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--text-primary)', marginBottom: 8 }}>
              Under 2 Minutes Remaining
            </div>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 20 }}>
              The current 15-minute window closes in <strong>less than 2 minutes</strong>. The pipeline takes {romaMode === 'blitz' ? '~30–60s' : romaMode === 'sharp' ? '~1–2 min' : '~1–3 min'} to complete — it will not finish before the market settles.
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
                  background: 'linear-gradient(135deg, #b8720f 0%, var(--amber) 100%)',
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

      {/* Strike-flip popup */}
      {strikeFlipped && (
        <div className="animate-fade-in" style={{
          position: 'fixed', bottom: 24, right: 24, zIndex: 1050,
          maxWidth: 320, width: 'calc(100vw - 48px)',
          background: 'var(--bg-card)', borderRadius: 14,
          border: '1.5px solid rgba(212,135,44,0.55)',
          boxShadow: '0 8px 32px rgba(0,0,0,0.28), 0 0 0 1px rgba(212,135,44,0.10)',
          padding: '16px 18px',
        }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
            <div style={{
              width: 36, height: 36, borderRadius: '50%', flexShrink: 0,
              background: 'rgba(212,135,44,0.12)', border: '1.5px solid rgba(212,135,44,0.4)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 16,
            }}>⚡</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--text-primary)', marginBottom: 3 }}>
                BTC crossed ${strikePrice > 0 ? strikePrice.toLocaleString(undefined, { maximumFractionDigits: 0 }) : 'strike'}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                Price flipped sides. Re-run the pipeline to update the analysis?
              </div>
            </div>
            <button
              onClick={dismissStrikeFlip}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 14, lineHeight: 1, padding: 2, flexShrink: 0 }}
            >✕</button>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
            <button
              onClick={() => { dismissStrikeFlip(); runCycle() }}
              disabled={isRunning || serverLocked}
              style={{
                flex: 2, padding: '8px 0', borderRadius: 8, cursor: isRunning || serverLocked ? 'not-allowed' : 'pointer',
                border: '1px solid rgba(212,135,44,0.6)',
                background: 'linear-gradient(135deg, #b8720f 0%, var(--amber) 100%)',
                fontSize: 12, fontWeight: 800, color: '#fff',
                opacity: isRunning || serverLocked ? 0.5 : 1,
                boxShadow: '0 2px 10px rgba(212,135,44,0.3)',
              }}
            >
              {isRunning ? 'Running…' : 'Re-run now'}
            </button>
            <button
              onClick={dismissStrikeFlip}
              style={{
                flex: 1, padding: '8px 0', borderRadius: 8, cursor: 'pointer',
                border: '1px solid var(--border)', background: 'var(--bg-secondary)',
                fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)',
              }}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* ── Trade alert pop-up ─────────────────────────────────────────────── */}
      {tradeAlert && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 1100,
          background: 'rgba(5,5,7,0.82)', backdropFilter: 'blur(12px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <div className="card animate-fade-in" style={{
            maxWidth: 360, width: '90%', padding: '26px 24px',
            border: tradeAlert.side === 'yes' ? '1.5px solid #9ecfb8' : '1.5px solid #e0b0bf',
            boxShadow: '0 12px 48px rgba(0,0,0,0.22)',
          }}>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
              <div style={{
                width: 42, height: 42, borderRadius: '50%', flexShrink: 0,
                background: tradeAlert.side === 'yes' ? 'var(--green-pale)' : 'var(--pink-pale)',
                border: tradeAlert.side === 'yes' ? '1.5px solid #9ecfb8' : '1.5px solid #e0b0bf',
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
                <button onClick={() => setTradeAlert(null)} style={{
                  flex: 1, padding: '10px 0', borderRadius: 9, cursor: 'pointer',
                  border: '1px solid var(--border)', background: 'var(--bg-secondary)',
                  fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)',
                }}>
                  Dismiss
                </button>
                <button onClick={liveMode ? executeAlertTrade : () => setTradeAlert(null)} style={{
                  flex: 2, padding: '10px 0', borderRadius: 9, cursor: 'pointer',
                  border: tradeAlert.side === 'yes' ? '1px solid var(--green-dark)' : '1px solid var(--pink)',
                  background: tradeAlert.side === 'yes'
                    ? 'linear-gradient(135deg, var(--green-dark) 0%, var(--green) 100%)'
                    : 'linear-gradient(135deg, #c24f78 0%, var(--pink) 100%)',
                  fontSize: 14, fontWeight: 800, color: '#fff',
                  boxShadow: tradeAlert.side === 'yes' ? '0 2px 12px rgba(74,148,112,0.35)' : '0 2px 12px rgba(212,85,130,0.35)',
                  letterSpacing: '0.01em',
                }}>
                  {liveMode ? 'Buy $40' : 'Got it (paper)'}
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
            background: 'var(--red-pale)', border: '1px solid #e0b0b0',
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

        {/* Live mode banner */}
        {liveMode && (
          <div className="animate-fade-in" style={{
            marginBottom: 14, padding: '10px 16px', borderRadius: 12,
            background: 'var(--green-pale)', border: '1px solid #a8d8b5',
            fontSize: 12, color: 'var(--green-dark)',
            display: 'flex', alignItems: 'center', gap: 8,
          }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--green)', display: 'inline-block', boxShadow: '0 0 6px var(--green)', animation: 'pulse-live 1.5s ease-in-out infinite', flexShrink: 0 }} />
            <span><strong>Live trading active</strong> — real Kalshi orders will be placed when the pipeline approves a trade. Risk controls: 3% min edge · $150 daily cap · 15% max drawdown.</span>
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
              liveMode={liveMode}
              onRefresh={refreshMarket}
            />
            <SignalPanel probability={prob} sentiment={sent} />

            {exec && exec.action !== 'PASS' && (
              <div className="card bracket-card animate-fade-in" style={{
                borderColor: exec.action === 'BUY_YES' ? '#1a4030' : '#1a2e40',
                background: 'var(--bg-card)',
              }}>
                <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6,
                  color: exec.action === 'BUY_YES' ? 'var(--green-dark)' : 'var(--blue-dark)' }}>
                  <span style={{ fontSize: 16 }}>{exec.action === 'BUY_YES' ? '↑' : '↓'}</span>
                  {exec.action === 'BUY_YES' ? 'BUY YES' : 'BUY NO'} — Latest Signal
                  {liveMode && <span style={{ marginLeft: 'auto', fontSize: 9, fontWeight: 700, color: 'var(--green-dark)', background: 'var(--green-pale)', border: '1px solid #a8d8b5', borderRadius: 4, padding: '1px 5px' }}>LIVE</span>}
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
                  {liveMode
                    ? exec.rationale.replace('Paper trade only — no real order placed.', 'Live mode — real order placed via Kalshi API.')
                    : exec.rationale}
                </div>

                {/* Prices at pipeline run */}
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

          {/* ─── CENTER ─── */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>

            {/* ── Control bar: model picker + gear + run + expiry ── */}
            <div style={{ position: 'relative' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>

                {/* Model picker — searchable OpenRouter model dropdown */}
                <div ref={orModelRef} style={{ position: 'relative', flex: 1, minWidth: 0 }}>
                  <button
                    onClick={() => { setOrModelOpen(v => !v); setOrModelSearch('') }}
                    style={{
                      width: '100%', textAlign: 'left', cursor: 'pointer',
                      padding: '6px 12px', borderRadius: 8,
                      border: orModel ? '1px solid var(--blue)' : '1px solid var(--border)',
                      background: orModel ? 'rgba(74,127,165,0.08)' : 'var(--bg-secondary)',
                      color: orModel ? 'var(--blue-dark)' : 'var(--text-muted)',
                      display: 'flex', alignItems: 'center', gap: 8,
                    }}
                  >
                    <span style={{ fontSize: 9, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--text-muted)', flexShrink: 0 }}>Model</span>
                    <span style={{ fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                      {orModelsLoading && !orModel
                        ? 'Loading…'
                        : orModel
                          ? (orModels.find(m => m.id === orModel)?.name ?? orModel)
                          : 'Select model (OpenRouter)'}
                    </span>
                    {orModel && (
                      <span
                        onClick={e => { e.stopPropagation(); handleOrModelChange('') }}
                        title="Clear model"
                        style={{ fontSize: 11, color: 'var(--text-muted)', flexShrink: 0, lineHeight: 1, cursor: 'pointer' }}
                      >✕</span>
                    )}
                    <span style={{ fontSize: 10, opacity: 0.4, flexShrink: 0 }}>{orModelOpen ? '▲' : '▼'}</span>
                  </button>

                  {orModelOpen && (
                    <div className="animate-fade-in" style={{
                      position: 'absolute', top: '100%', left: 0, marginTop: 4, zIndex: 200,
                      background: 'var(--bg-card)', border: '1px solid var(--border)',
                      borderRadius: 10, boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
                      width: '100%', minWidth: 300, display: 'flex', flexDirection: 'column',
                    }}>
                      {/* Search */}
                      <div style={{ padding: '8px 10px 6px', borderBottom: '1px solid var(--border)' }}>
                        <input
                          autoFocus
                          placeholder={orModelsLoading ? 'Loading models…' : `Search ${orModels.length} models…`}
                          value={orModelSearch}
                          onChange={e => setOrModelSearch(e.target.value)}
                          style={{
                            width: '100%', boxSizing: 'border-box',
                            padding: '5px 8px', borderRadius: 6, fontSize: 11,
                            border: '1px solid var(--border)', background: 'var(--bg-secondary)',
                            color: 'var(--text-primary)', outline: 'none',
                          }}
                        />
                        {/* Category chips */}
                        <div style={{ display: 'flex', gap: 5, marginTop: 7, flexWrap: 'wrap' }}>
                          {([
                            { id: 'all',       label: 'All' },
                            { id: 'favorites', label: '★ Favs' },
                            { id: 'fast',      label: 'Fast' },
                            { id: 'balanced',  label: 'Balanced' },
                            { id: 'reasoning', label: 'Reasoning' },
                            { id: 'large',     label: 'Large' },
                          ] as const).map(cat => (
                            <button key={cat.id} onClick={() => setOrModelCat(cat.id)}
                              style={{
                                padding: '3px 9px', borderRadius: 20, fontSize: 10, fontWeight: 700,
                                cursor: 'pointer', border: 'none',
                                background: orModelCat === cat.id ? (cat.id === 'favorites' ? 'var(--amber)' : 'var(--blue)') : 'var(--bg-secondary)',
                                color: orModelCat === cat.id ? '#fff' : 'var(--text-muted)',
                                transition: 'all 0.12s',
                              }}>
                              {cat.label}
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* Results */}
                      <div style={{ maxHeight: 280, overflowY: 'auto' }}>
                        {orModelCat === 'all' && orModelSearch === '' && (
                          <div
                            onClick={() => { handleOrModelChange(''); setOrModelOpen(false) }}
                            style={{
                              padding: '7px 12px', fontSize: 11, cursor: 'pointer',
                              color: !orModel ? 'var(--blue-dark)' : 'var(--text-muted)',
                              background: !orModel ? 'rgba(74,127,165,0.1)' : 'transparent',
                              fontWeight: !orModel ? 700 : 400,
                            }}
                          >
                            auto (env default)
                          </div>
                        )}
                        {(() => {
                          const q = orModelSearch.toLowerCase()

                          function catMatch(id: string, name: string): boolean {
                            if (orModelCat === 'favorites') return orFavorites.includes(id)
                            if (orModelCat === 'all') return true
                            const s = (id + ' ' + name).toLowerCase()
                            if (orModelCat === 'fast')
                              return /flash|mini|haiku|scout|fast|lite|small|1\.5b|3b|7b|8b/.test(s)
                            if (orModelCat === 'reasoning')
                              return /\br1\b|o3|o4|thinking|qwq|\breasonin|\bdeepseek-r/.test(s)
                            if (orModelCat === 'large')
                              return /opus|gpt-4o[^-m]|gpt-4\.5|qwen3-max|\bmax\b|mistral-large|maverick|70b|72b|90b|123b|180b|671b|405b/.test(s)
                            if (orModelCat === 'balanced')
                              return !/flash|mini|haiku|scout|fast|lite|small|1\.5b|3b|7b|8b|\br1\b|o3|o4|thinking|qwq|opus|gpt-4o[^-m]|gpt-4\.5|qwen3-max|\bmax\b|mistral-large|maverick|70b|72b|90b|123b|180b|671b|405b/.test(s)
                            return true
                          }

                          const filtered = orModels.filter(m =>
                            catMatch(m.id, m.name) &&
                            (q === '' || m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q))
                          )
                          if (!filtered.length && !orModelsLoading) {
                            return <div style={{ padding: '10px 12px', fontSize: 11, color: 'var(--text-muted)' }}>
                              {orModelCat === 'favorites' ? 'No favorites yet — click ★ on any model' : 'No models found'}
                            </div>
                          }
                          const groups: Record<string, typeof filtered> = {}
                          for (const m of filtered) {
                            const p = m.id.split('/')[0]
                            if (!groups[p]) groups[p] = []
                            groups[p].push(m)
                          }
                          return Object.entries(groups).sort(([a], [b]) => a.localeCompare(b)).map(([provider, models]) => (
                            <div key={provider}>
                              <div style={{ padding: '5px 12px 2px', fontSize: 9, fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                                {provider}
                              </div>
                              {models.map(m => (
                                <div
                                  key={m.id}
                                  onClick={() => { handleOrModelChange(m.id); setOrModelOpen(false) }}
                                  style={{
                                    padding: '6px 12px 6px 18px', fontSize: 11, cursor: 'pointer',
                                    color: orModel === m.id ? 'var(--blue-dark)' : 'var(--text-secondary)',
                                    background: orModel === m.id ? 'rgba(74,127,165,0.1)' : 'transparent',
                                    fontWeight: orModel === m.id ? 700 : 400,
                                    display: 'flex', alignItems: 'center', gap: 6,
                                  }}
                                  onMouseEnter={e => { if (orModel !== m.id) (e.currentTarget as HTMLElement).style.background = 'var(--bg-secondary)' }}
                                  onMouseLeave={e => { if (orModel !== m.id) (e.currentTarget as HTMLElement).style.background = orModel === m.id ? 'rgba(74,127,165,0.1)' : 'transparent' }}
                                >
                                  <span style={{ flex: 1 }}>{m.name}</span>
                                  <span
                                    onClick={e => { e.stopPropagation(); toggleFavorite(m.id) }}
                                    title={orFavorites.includes(m.id) ? 'Remove from favorites' : 'Add to favorites'}
                                    style={{
                                      fontSize: 13, lineHeight: 1, flexShrink: 0,
                                      color: orFavorites.includes(m.id) ? 'var(--amber)' : 'var(--border)',
                                      cursor: 'pointer', transition: 'color 0.12s',
                                      padding: '0 2px',
                                    }}
                                    onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = 'var(--amber)' }}
                                    onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = orFavorites.includes(m.id) ? 'var(--amber)' : 'var(--border)' }}
                                  >★</span>
                                </div>
                              ))}
                            </div>
                          ))
                        })()}
                      </div>
                    </div>
                  )}
                </div>

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
                </div>
              </div>

              {/* Settings dropdown — AI Risk + stage token-budget overrides */}
              {showSettings && (
                <div className="animate-fade-in" style={{
                  position: 'absolute', top: '100%', left: 0, marginTop: 6, zIndex: 50,
                  background: 'var(--bg-card)', border: '1px solid var(--border)',
                  borderRadius: 12, padding: '14px 16px',
                  display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap',
                  boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
                }}>
                  {/* AI Risk */}
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 11, fontWeight: 700, color: aiRisk ? 'var(--brown)' : 'var(--text-muted)', userSelect: 'none' }}
                    title="Use ROMA AI risk manager instead of deterministic Kelly + limits">
                    <input type="checkbox" checked={aiRisk} onChange={e => setAiRisk(e.target.checked)}
                      style={{ accentColor: 'var(--brown)', width: 13, height: 13, cursor: 'pointer' }} />
                    AI Risk
                  </label>

                  <div style={{ width: 1, height: 20, background: 'var(--border)' }} />

                  {/* Stage token-budget tier overrides */}
                  {(['sent', 'prob'] as const).map(stage => {
                    const val    = stage === 'sent' ? sentMode : probMode
                    const setVal = stage === 'sent' ? setSentMode : setProbMode
                    return (
                      <div key={stage} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                        <span style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em' }}
                          title={stage === 'sent' ? 'Token budget tier for Sentiment stage' : 'Token budget tier for Probability stage'}>
                          {stage === 'sent' ? 'Sent' : 'Prob'}
                        </span>
                        <select value={val ?? ''} onChange={e => setVal(e.target.value || undefined)}
                          style={{
                            fontSize: 11, fontWeight: 600, cursor: 'pointer',
                            padding: '4px 6px', borderRadius: 6,
                            border: val ? '1px solid var(--brown)' : '1px solid var(--border)',
                            background: 'var(--bg-secondary)',
                            color: val ? 'var(--brown)' : 'var(--text-muted)',
                            outline: 'none',
                          }}>
                          <option value="">auto</option>
                          <option value="blitz">blitz</option>
                          <option value="sharp">sharp</option>
                          <option value="keen">keen</option>
                          <option value="smart">smart</option>
                        </select>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            <PriceChart priceHistory={priceHistory} strikePrice={strikePrice} currentPrice={currentBTCPrice} />
            <AgentPipeline pipeline={pipeline} isRunning={isRunning} streamingAgents={streamingAgents} />
            <PipelineHistory history={history} />

            {/* ── Challenge + Strategy — beneath pipeline ── */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <ChallengePanel stats={stats} trades={trades} />
              <StrategyPanel stats={stats} trades={trades} market={activeMarket} />
            </div>
          </div>

          {/* ─── RIGHT ─── */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <PositionsPanel liveMode={liveMode} />
            <PerformancePanel stats={stats} trades={trades} />
            <TradeLog trades={trades} />
          </div>
        </div>
      </main>
    </div>
  )
}
