'use client'

import { useState, useEffect } from 'react'
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
  const [liveMode, setLiveMode] = useState(false)  // always false on SSR
  const [showLiveWarning, setShowLiveWarning] = useState(false)
  const [romaMode, setRomaMode] = useState<'sharp' | 'keen' | 'smart'>('keen')
  // Sync from localStorage after hydration (client-only)
  useEffect(() => {
    if (localStorage.getItem('sentient-live-mode') === 'true') setLiveMode(true)
    const m = localStorage.getItem('sentient-roma-mode')
    if (m === 'sharp' || m === 'keen' || m === 'smart') setRomaMode(m)
  }, [])

  function handleModeChange(m: 'sharp' | 'keen' | 'smart') {
    setRomaMode(m)
    localStorage.setItem('sentient-roma-mode', m)
  }

  const { pipeline, trades, isRunning, nextCycleIn, error, stats, runCycle } = usePipeline(liveMode, romaMode)

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
                background: exec.action === 'BUY_YES' ? 'var(--green-pale)' : 'var(--blue-pale)',
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
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                5-min cycles · 3 signals per 15-min window · CF Benchmarks settlement
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {/* ROMA mode selector */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 3, background: 'var(--bg-secondary)', borderRadius: 8, padding: '3px 4px', border: '1px solid var(--border)' }}>
                  {(['sharp', 'keen', 'smart'] as const).map(m => (
                    <button key={m} onClick={() => handleModeChange(m)}
                      title={m === 'sharp' ? 'Fastest model everywhere — grok-3-mini (~10–20s)' : m === 'keen' ? 'Mid model everywhere — grok-3-fast (~20–40s)' : 'Smart model everywhere — grok-3 (~40–70s)'}
                      style={{
                        padding: '3px 10px', borderRadius: 6, fontSize: 11, fontWeight: 700, cursor: 'pointer',
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
                  onClick={runCycle}
                  disabled={isRunning}
                  style={{
                    padding: '7px 18px', borderRadius: 9,
                    background: isRunning
                      ? 'var(--cream-dark)'
                      : 'linear-gradient(135deg, var(--green-dark) 0%, var(--green) 100%)',
                    border: isRunning ? '1px solid var(--border)' : '1px solid var(--green-dark)',
                    color: isRunning ? 'var(--text-muted)' : '#fff',
                    cursor: isRunning ? 'not-allowed' : 'pointer',
                    fontSize: 12, fontWeight: 700,
                    display: 'flex', alignItems: 'center', gap: 6,
                    boxShadow: isRunning ? 'none' : '0 2px 10px rgba(74,148,112,0.3)',
                    transition: 'all 0.2s',
                    letterSpacing: '0.02em',
                  }}
                >
                  {isRunning
                    ? <><span style={{ animation: 'spin-slow 1s linear infinite', display: 'inline-block' }}>◌</span> Running...</>
                    : '▶ Run Cycle'}
                </button>
              </div>
            </div>

            <PriceChart priceHistory={priceHistory} strikePrice={strikePrice} currentPrice={currentBTCPrice} />
            <AgentPipeline pipeline={pipeline} isRunning={isRunning} />

            {/* Architecture note */}
            <div className="card" style={{ padding: '11px 15px', background: 'rgba(255,255,255,0.6)', backdropFilter: 'blur(8px)' }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--brown)', marginBottom: 5, letterSpacing: '0.05em', textTransform: 'uppercase' }}>
                ROMA DAG — Multi-Agent Pipeline
              </div>
              <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 9, color: 'var(--text-muted)', lineHeight: 1.9 }}>
                MarketDiscovery → PriceFeed ──┬──▶ Sentiment → ProbabilityModel → RiskManager → Execution<br />
                &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└──▶ Orderbook&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;↑ KXBTC15M · CF Benchmarks
              </div>
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
