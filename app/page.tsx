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
import FloatingBackground from '@/components/FloatingBackground'

export default function Home() {
  const [liveMode, setLiveMode]           = useState(false)  // always false on SSR
  const [showLiveWarning, setShowLiveWarning] = useState(false)
  const [romaMode, setRomaMode]           = useState<'blitz' | 'sharp' | 'keen' | 'smart'>('blitz')
  const [botActive, setBotActive]         = useState(false)
  const [showBotWarning, setShowBotWarning] = useState(false)
  const [aiRisk, setAiRisk]               = useState(false)

  // Sync from localStorage after hydration (client-only)
  useEffect(() => {
    if (localStorage.getItem('sentient-live-mode') === 'true') setLiveMode(true)
    const m = localStorage.getItem('sentient-roma-mode')
    if (m === 'blitz' || m === 'sharp' || m === 'keen' || m === 'smart') setRomaMode(m)
  }, [])

  function handleModeChange(m: 'blitz' | 'sharp' | 'keen' | 'smart') {
    setRomaMode(m)
    localStorage.setItem('sentient-roma-mode', m)
  }

  const { pipeline, trades, isRunning, serverLocked, nextCycleIn, error, stats, runCycle, stopCycle } = usePipeline(
    liveMode, romaMode, botActive, aiRisk,
  )

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

  const md   = pipeline?.agents.marketDiscovery.output
  const pf   = pipeline?.agents.priceFeed.output
  const prob = pipeline?.agents.probability.output ?? null
  const sent = pipeline?.agents.sentiment.output ?? null
  const exec = pipeline?.agents.execution.output

  // Live 5-second tick — keeps bid/ask and BTC price fresh between pipeline cycles
  const { liveMarket, liveOrderbook, liveBTCPrice, livePriceHistory, refresh: refreshMarket } = useMarketTick(
    md?.activeMarket?.ticker ?? null,
  )

  // Merge: live tick overrides stale pipeline values.
  // Don't fall back to pipeline market if its close_time is already in the past.
  const mdMarket = md?.activeMarket ?? null
  const mdMarketExpired = mdMarket?.close_time
    ? new Date(mdMarket.close_time).getTime() < Date.now()
    : false
  const activeMarket = liveMarket ?? (mdMarketExpired ? null : mdMarket)
  const currentBTCPrice = liveBTCPrice ?? pf?.currentPrice   ?? 0
  const priceHistory    = livePriceHistory

  // Derive strike + expiry directly from live market so they show before pipeline runs
  const strikePrice = md?.strikePrice
    ?? activeMarket?.floor_strike
    ?? (activeMarket?.yes_sub_title ? parseFloat(activeMarket.yes_sub_title.replace(/[^0-9.]/g, '')) : 0)
    ?? 0
  // Always compute from live close_time so the countdown stays accurate between pipeline cycles.
  // Fall back to pipeline value only when no market is loaded yet.
  const secondsUntilExpiry = activeMarket?.close_time
    ? Math.max(0, Math.floor((new Date(activeMarket.close_time).getTime() - Date.now()) / 1000))
    : (md?.secondsUntilExpiry ?? 0)

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
      <FloatingBackground />
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
          background: 'rgba(61,46,30,0.45)', backdropFilter: 'blur(6px)',
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
                  border: '1px solid var(--border-bright)', background: 'var(--cream)',
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
          background: 'rgba(61,46,30,0.45)', backdropFilter: 'blur(6px)',
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
                  border: '1px solid var(--border-bright)', background: 'var(--cream)',
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

      {/* ── Trade alert pop-up ─────────────────────────────────────────────── */}
      {tradeAlert && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 1100,
          background: 'rgba(30,20,10,0.5)', backdropFilter: 'blur(8px)',
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
                  border: '1px solid var(--border)', background: 'var(--cream)',
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
                borderColor: exec.action === 'BUY_YES' ? '#9ecfb8' : '#a8cce0',
                background: 'white',
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
                    <div key={k} style={{ padding: '8px', background: 'rgba(255,255,255,0.65)', borderRadius: 8, border: '1px solid var(--border)' }}>
                      <div style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 2 }}>{k}</div>
                      <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>{v}</div>
                    </div>
                  ))}
                </div>
                <div style={{ marginTop: 8, fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.5 }}>{exec.rationale}</div>
              </div>
            )}
          </div>

          {/* ─── CENTER ─── */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                5-min cycles · 3 signals per 15-min window · CF Benchmarks settlement
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {/* AI Risk checkbox */}
                <label style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer', fontSize: 11, fontWeight: 700, color: aiRisk ? 'var(--brown)' : 'var(--text-muted)', userSelect: 'none' }}
                  title="Use ROMA AI risk manager instead of deterministic Kelly + limits">
                  <input
                    type="checkbox"
                    checked={aiRisk}
                    onChange={e => setAiRisk(e.target.checked)}
                    style={{ accentColor: 'var(--brown)', width: 13, height: 13, cursor: 'pointer' }}
                  />
                  AI Risk
                </label>

                {/* ROMA mode selector */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, background: 'var(--bg-secondary)', borderRadius: 10, padding: '4px 5px', border: '1px solid var(--border)' }}>
                  {(['blitz', 'sharp', 'keen', 'smart'] as const).map(m => (
                    <button key={m} onClick={() => handleModeChange(m)}
                      title={m === 'blitz' ? 'grok-3-mini-fast — faster inference infra (~5–15s)' : m === 'sharp' ? 'grok-3-mini (~10–20s)' : m === 'keen' ? 'grok-3-fast (~20–40s)' : 'grok-3 (~40–70s)'}
                      style={{
                        padding: '6px 16px', borderRadius: 7, fontSize: 13, fontWeight: 700, cursor: 'pointer',
                        border: romaMode === m ? '1px solid var(--brown)' : '1px solid transparent',
                        background: romaMode === m ? 'var(--brown)' : 'transparent',
                        color: romaMode === m ? '#fff' : 'var(--text-muted)',
                        transition: 'all 0.15s', textTransform: 'capitalize',
                      }}>
                      {m}
                    </button>
                  ))}
                </div>
                <button
                  onClick={isRunning ? stopCycle : (serverLocked ? undefined : runCycle)}
                  disabled={serverLocked && !isRunning}
                  title={serverLocked && !isRunning ? 'Pipeline already running on server' : undefined}
                  style={{
                    padding: '7px 18px', borderRadius: 9,
                    background: isRunning
                      ? 'linear-gradient(135deg, #c0392b 0%, #e74c3c 100%)'
                      : (serverLocked ? 'var(--cream-dark)' : 'linear-gradient(135deg, var(--green-dark) 0%, var(--green) 100%)'),
                    border: isRunning ? '1px solid #c0392b' : (serverLocked ? '1px solid var(--border)' : '1px solid var(--green-dark)'),
                    color: serverLocked && !isRunning ? 'var(--text-muted)' : '#fff',
                    cursor: isRunning ? 'pointer' : (serverLocked ? 'not-allowed' : 'pointer'),
                    fontSize: 12, fontWeight: 700,
                    display: 'flex', alignItems: 'center', gap: 6,
                    boxShadow: isRunning ? '0 2px 10px rgba(192,57,43,0.3)' : (serverLocked ? 'none' : '0 2px 10px rgba(74,148,112,0.3)'),
                    transition: 'all 0.2s',
                    letterSpacing: '0.02em',
                  }}
                >
                  {isRunning
                    ? <><span style={{ display: 'inline-block' }}>■</span> Stop</>
                    : serverLocked ? <><span style={{ animation: 'spin-slow 1s linear infinite', display: 'inline-block' }}>◌</span> Pipeline running...</>
                    : '▶ Run Cycle'}
                </button>
              </div>
            </div>

            <PriceChart priceHistory={priceHistory} strikePrice={strikePrice} currentPrice={currentBTCPrice} />
            <AgentPipeline pipeline={pipeline} isRunning={isRunning} />
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
