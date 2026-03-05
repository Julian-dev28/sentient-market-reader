'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import type { TradeRecord, CalibrationResult, DailyOptParams } from '@/lib/types'

interface Props {
  trades: TradeRecord[]
}

const RISK_COLOR: Record<string, string> = {
  conservative: 'var(--blue)',
  normal:       'var(--green-dark)',
  aggressive:   'var(--amber)',
}

function MetricTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{
      padding: '8px 10px', borderRadius: 9,
      background: 'var(--bg-secondary)', border: '1px solid var(--border)',
    }}>
      <div style={{ fontSize: 8, color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 3 }}>
        {label}
      </div>
      <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 15, fontWeight: 800, color: 'var(--text-primary)' }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 1 }}>{sub}</div>}
    </div>
  )
}

function SignalBar({ feature, accuracy, count }: { feature: string; accuracy: number; count: number }) {
  const pct  = Math.round(accuracy * 100)
  const good = accuracy > 0.6
  const bad  = accuracy < 0.4
  const color = good ? 'var(--green)' : bad ? 'var(--pink)' : 'var(--amber)'

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 10, marginBottom: 4 }}>
      <span style={{ width: 90, color: 'var(--text-secondary)', fontWeight: 600, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {feature}
      </span>
      <div style={{ flex: 1, height: 5, borderRadius: 3, background: 'var(--border)', overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 3, transition: 'width 0.5s ease' }} />
      </div>
      <span style={{ width: 28, textAlign: 'right', fontFamily: 'var(--font-geist-mono)', fontWeight: 700, color, fontSize: 9 }}>
        {pct}%
      </span>
      <span style={{ width: 22, textAlign: 'right', color: 'var(--text-muted)', fontSize: 8 }}>
        n={count}
      </span>
    </div>
  )
}

type DataMode = 'live' | 'combined' | 'backtest'

export default function CalibrationPanel({ trades }: Props) {
  const [calibration, setCalibration]   = useState<CalibrationResult | null>(null)
  const [optParams,   setOptParams]     = useState<DailyOptParams | null>(null)
  const [isCalib,     setIsCalib]       = useState(false)
  const [isOpt,       setIsOpt]         = useState(false)
  const [error,       setError]         = useState<string | null>(null)
  const [expanded,    setExpanded]      = useState(false)

  // Backtest state
  const [btRecords,   setBtRecords]     = useState<TradeRecord[]>([])
  const [btRunning,   setBtRunning]     = useState(false)
  const [btDays,      setBtDays]        = useState(3)
  const [dataMode,    setDataMode]      = useState<DataMode>('combined')
  const [btProvider,  setBtProvider]    = useState<'quant' | 'openrouter'>('quant')

  // Merged trades based on dataMode
  const mergedTrades = useMemo<TradeRecord[]>(() => {
    if (dataMode === 'live')     return trades
    if (dataMode === 'backtest') return btRecords
    // combined: deduplicate by id (live trades take precedence)
    const liveIds = new Set(trades.map(t => t.id))
    return [...trades, ...btRecords.filter(t => !liveIds.has(t.id))]
  }, [trades, btRecords, dataMode])

  const settled = mergedTrades.filter(t => t.outcome !== 'PENDING')
  const wins    = settled.filter(t => t.outcome === 'WIN').length
  const losses  = settled.filter(t => t.outcome === 'LOSS').length

  const runCalibration = useCallback(async (tradeList: TradeRecord[]) => {
    if (tradeList.length < 3) return
    setIsCalib(true)
    setError(null)
    try {
      const res = await fetch('/api/calibration', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trades: tradeList }),
      })
      if (res.ok) setCalibration(await res.json() as CalibrationResult)
    } catch (e) {
      setError(String(e))
    } finally {
      setIsCalib(false)
    }
  }, [])

  // Re-run calibration when merged settled count changes
  useEffect(() => {
    runCalibration(mergedTrades)
  }, [settled.length, btRecords.length, dataMode]) // eslint-disable-line react-hooks/exhaustive-deps

  const runBacktest = async (providerOverride?: 'quant' | 'openrouter') => {
    const useProvider = providerOverride ?? btProvider
    setBtRunning(true)
    setError(null)
    try {
      const params = new URLSearchParams({ days: String(btDays) })
      if (useProvider === 'openrouter') {
        params.set('provider', 'openrouter')
        params.set('romaMode', 'blitz')
        params.set('maxLlm', '20')
      }

      // Read stored API keys (same pattern as usePipeline)
      const headers: Record<string, string> = {}
      if (useProvider === 'openrouter') {
        const storedKeys = localStorage.getItem('sentient-provider-keys')
        if (storedKeys) {
          try {
            const parsed = JSON.parse(storedKeys) as Record<string, string>
            const nonEmpty = Object.fromEntries(Object.entries(parsed).filter(([, v]) => v))
            if (Object.keys(nonEmpty).length > 0) {
              headers['x-provider-keys'] = btoa(JSON.stringify(nonEmpty))
            }
          } catch { /* ignore */ }
        }
      }

      const res = await fetch(`/api/backtest?${params}`, { headers })
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string }
        setError(err.error ?? 'Backtest failed')
        return
      }
      const data = await res.json() as { records: TradeRecord[]; count: number; days: number }
      setBtRecords(data.records ?? [])
      // Auto-run calibration with merged data
      const liveIds = new Set(trades.map(t => t.id))
      const merged = [...trades, ...(data.records ?? []).filter(t => !liveIds.has(t.id))]
      await runCalibration(merged)
    } catch (e) {
      setError(String(e))
    } finally {
      setBtRunning(false)
    }
  }

  // Auto-run quant-only backtest on mount to seed calibration from day one
  useEffect(() => {
    runBacktest('quant')
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const runOptimization = async () => {
    if (!calibration || settled.length < 3) return
    setIsOpt(true)
    setError(null)
    try {
      const res = await fetch('/api/optimize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trades: mergedTrades, calibration }),
      })
      if (res.ok) {
        setOptParams(await res.json() as DailyOptParams)
      } else {
        const err = await res.json().catch(() => ({})) as { error?: string }
        setError(err.error ?? 'Optimization failed')
      }
    } catch (e) {
      setError(String(e))
    } finally {
      setIsOpt(false)
    }
  }

  // Brier quality label
  function brierLabel(b: number) {
    if (b < 0.15) return { text: 'excellent', color: 'var(--green-dark)' }
    if (b < 0.20) return { text: 'good',      color: 'var(--green-dark)' }
    if (b < 0.23) return { text: 'fair',      color: 'var(--amber)' }
    return          { text: 'poor',      color: 'var(--pink)' }
  }

  const noData = settled.length < 3

  // Data source badge label
  const dataBadge = btRecords.length > 0
    ? dataMode === 'live'     ? `${trades.filter(t => t.outcome !== 'PENDING').length} live`
    : dataMode === 'backtest' ? `${btRecords.filter(t => t.outcome !== 'PENDING').length} bt`
    : `${btRecords.filter(t => t.outcome !== 'PENDING').length} bt + ${trades.filter(t => t.outcome !== 'PENDING').length} live`
    : null

  return (
    <div className="card" style={{ padding: '14px 14px' }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: noData || !expanded ? 0 : 12 }}>
        <div style={{
          width: 6, height: 6, borderRadius: '50%',
          background: isCalib || btRunning ? 'var(--amber)' : calibration ? 'var(--green)' : 'var(--border)',
          boxShadow: isCalib || btRunning ? '0 0 6px var(--amber)' : calibration ? '0 0 4px var(--green)' : 'none',
          transition: 'all 0.3s',
        }} />
        <span style={{ fontSize: 10, fontWeight: 800, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.08em', flex: 1 }}>
          Model Calibration
        </span>
        {dataBadge && (
          <span style={{ fontSize: 8, fontWeight: 700, color: 'var(--text-muted)', fontFamily: 'var(--font-geist-mono)' }}>
            {dataBadge}
          </span>
        )}
        {calibration && (
          <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 10, fontWeight: 700, color: brierLabel(calibration.brierScore).color }}>
            Brier {calibration.brierScore.toFixed(3)}
          </span>
        )}
        <button
          onClick={() => setExpanded(v => !v)}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 10, padding: '2px 4px', lineHeight: 1 }}
        >
          {expanded ? '▲' : '▼'}
        </button>
      </div>

      {/* Collapsed state — compact status line */}
      {!expanded && !noData && calibration && (
        <div style={{ display: 'flex', gap: 10, marginTop: 8, flexWrap: 'wrap' }}>
          {[
            { k: 'Brier', v: calibration.brierScore.toFixed(3), good: calibration.brierScore < 0.20 },
            { k: 'AUC',   v: calibration.rocAuc.toFixed(3),     good: calibration.rocAuc > 0.55 },
            { k: 'WR',    v: `${(calibration.overallWinRate * 100).toFixed(0)}%`, good: calibration.overallWinRate > 0.5 },
            { k: 'n',     v: String(calibration.settledTrades),  good: true },
          ].map(({ k, v, good }) => (
            <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ fontSize: 8, color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{k}</span>
              <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 10, fontWeight: 800, color: good ? 'var(--text-primary)' : 'var(--pink)' }}>{v}</span>
            </div>
          ))}
        </div>
      )}

      {!expanded && noData && (
        <div style={{ marginTop: 8, fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.5 }}>
          {settled.length < 3
            ? `${3 - settled.length} more settled trade${3 - settled.length !== 1 ? 's' : ''} needed to calibrate`
            : 'Calibrating…'}
        </div>
      )}

      {/* Expanded content */}
      {expanded && (
        <>
          {noData ? (
            <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6, paddingTop: 4 }}>
              Need at least 3 settled trades to compute calibration metrics.
              <br />
              <span style={{ color: 'var(--text-secondary)' }}>{settled.length} settled so far.</span>
              <br />
              <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                Run backtest below to seed calibration with historical data.
              </span>
            </div>
          ) : !calibration ? (
            <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
              {isCalib ? 'Computing…' : 'No calibration data yet.'}
            </div>
          ) : (
            <>
              {/* Key metrics */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 12 }}>
                <MetricTile
                  label="Brier Score"
                  value={calibration.brierScore.toFixed(3)}
                  sub={`${brierLabel(calibration.brierScore).text} (random=0.25)`}
                />
                <MetricTile
                  label="ROC-AUC"
                  value={calibration.rocAuc.toFixed(3)}
                  sub="random=0.50"
                />
                <MetricTile
                  label="Win Rate"
                  value={`${(calibration.overallWinRate * 100).toFixed(1)}%`}
                  sub={`${wins}W / ${losses}L`}
                />
                <MetricTile
                  label="Avg P(model)"
                  value={`${(calibration.avgPModel * 100).toFixed(1)}%`}
                  sub={`gap ${((calibration.avgPModel - calibration.overallWinRate) * 100).toFixed(1)}pp`}
                />
              </div>

              {/* Platt scaling */}
              {calibration.plattA != null && (
                <div style={{
                  marginBottom: 12, padding: '7px 10px', borderRadius: 8,
                  background: 'rgba(74,127,165,0.07)', border: '1px solid rgba(74,127,165,0.2)',
                }}>
                  <span style={{ fontSize: 8, fontWeight: 700, color: 'var(--blue)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>Platt Scaling</span>
                  <span style={{ marginLeft: 8, fontFamily: 'var(--font-geist-mono)', fontSize: 10, color: 'var(--text-secondary)' }}>
                    a={calibration.plattA.toFixed(3)}  b={calibration.plattB?.toFixed(3)}
                  </span>
                  <span style={{ marginLeft: 8, fontSize: 9, color: 'var(--text-muted)' }}>
                    {Math.abs(calibration.plattA - 1) > 0.15 ? (calibration.plattA > 1 ? '↑ model under-confident' : '↓ model over-confident') : 'well calibrated'}
                  </span>
                </div>
              )}

              {/* Signal importances */}
              {calibration.signals.length > 0 && (
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 7 }}>
                    Signal Accuracy
                  </div>
                  {calibration.signals.slice(0, 6).map(sig => (
                    <SignalBar key={sig.feature} feature={sig.feature} accuracy={sig.accuracy} count={sig.count} />
                  ))}
                </div>
              )}

              {/* Optimization section */}
              <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12, marginTop: 4 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: optParams ? 10 : 0, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', flex: 1 }}>
                    Algo Optimizer
                  </span>
                  <button
                    onClick={runOptimization}
                    disabled={isOpt || settled.length < 5}
                    style={{
                      padding: '4px 10px', borderRadius: 7, fontSize: 9, fontWeight: 700, cursor: isOpt || settled.length < 5 ? 'not-allowed' : 'pointer',
                      background: 'var(--bg-secondary)', border: '1px solid var(--border)',
                      color: isOpt ? 'var(--text-muted)' : 'var(--text-secondary)',
                      opacity: isOpt || settled.length < 5 ? 0.6 : 1,
                    }}
                    title={settled.length < 5 ? 'Need 5+ settled trades' : 'Run Gemini 2.5 Flash meta-optimizer'}
                  >
                    {isOpt
                      ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><span style={{ animation: 'spin-slow 1s linear infinite', display: 'inline-block' }}>◌</span>Optimizing…</span>
                      : '⚡ Optimize'}
                  </button>
                </div>

                {optParams && (
                  <div className="animate-fade-in" style={{ marginTop: 6 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 7 }}>
                      <span style={{
                        fontSize: 8, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.08em',
                        padding: '2px 7px', borderRadius: 4,
                        background: `rgba(${optParams.riskLevel === 'aggressive' ? '212,135,44' : optParams.riskLevel === 'conservative' ? '74,127,165' : '58,158,114'},0.12)`,
                        color: RISK_COLOR[optParams.riskLevel] ?? 'var(--text-secondary)',
                        border: `1px solid ${RISK_COLOR[optParams.riskLevel] ?? 'var(--border)'}40`,
                      }}>
                        {optParams.riskLevel}
                      </span>
                      <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>
                        {new Date(optParams.computedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>

                    {/* Params */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginBottom: 8 }}>
                      {[
                        { k: 'Edge min',        v: `${optParams.edgeMinPct.toFixed(1)}%` },
                        { k: 'Sentiment wt',   v: optParams.sentimentWeight.toFixed(2) },
                        { k: 'Alpha cap',      v: optParams.alphaCap.toFixed(2) },
                        { k: 'Velocity gate',  v: optParams.gateVelocityThreshold.toFixed(2) },
                        ...(optParams.fatTailNu != null ? [{ k: 'Fat tail ν', v: optParams.fatTailNu.toFixed(1) }] : []),
                      ].map(({ k, v }) => (
                        <div key={k} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>{k}</span>
                          <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: 10, fontWeight: 700, color: 'var(--text-primary)' }}>{v}</span>
                        </div>
                      ))}
                    </div>

                    {/* Rationale */}
                    {optParams.rationale && (
                      <div style={{ fontSize: 9, color: 'var(--text-secondary)', lineHeight: 1.6, padding: '7px 9px', borderRadius: 7, background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
                        {optParams.rationale}
                      </div>
                    )}
                  </div>
                )}

                {settled.length < 5 && !optParams && (
                  <div style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.5 }}>
                    Need 5+ settled trades to run Gemini optimizer.
                  </div>
                )}
              </div>
            </>
          )}

          {/* Backtest section */}
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12, marginTop: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', flex: 1 }}>
                Historical Backtest
              </span>

              {/* Provider toggle */}
              <div style={{ display: 'flex', gap: 2 }}>
                {(['quant', 'openrouter'] as const).map(p => (
                  <button
                    key={p}
                    onClick={() => setBtProvider(p)}
                    disabled={btRunning}
                    style={{
                      padding: '2px 7px', borderRadius: 5, fontSize: 8, fontWeight: 700, cursor: btRunning ? 'not-allowed' : 'pointer',
                      background: btProvider === p ? 'var(--blue)' : 'var(--bg-secondary)',
                      border: `1px solid ${btProvider === p ? 'var(--blue)' : 'var(--border)'}`,
                      color: btProvider === p ? '#fff' : 'var(--text-muted)',
                      textTransform: 'uppercase', letterSpacing: '0.05em',
                    }}
                    title={p === 'openrouter' ? 'Run full ROMA analysis for 20 windows (uses OpenRouter key)' : 'Quant math only — fast, no LLM'}
                  >
                    {p === 'openrouter' ? '🤖 OR' : 'σ quant'}
                  </button>
                ))}
              </div>

              {/* Data mode selector — only shown when backtest data is available */}
              {btRecords.length > 0 && (
                <div style={{ display: 'flex', gap: 2 }}>
                  {(['live', 'combined', 'backtest'] as DataMode[]).map(mode => (
                    <button
                      key={mode}
                      onClick={() => setDataMode(mode)}
                      style={{
                        padding: '2px 7px', borderRadius: 5, fontSize: 8, fontWeight: 700, cursor: 'pointer',
                        background: dataMode === mode ? 'var(--brown)' : 'var(--bg-secondary)',
                        border: `1px solid ${dataMode === mode ? 'var(--brown)' : 'var(--border)'}`,
                        color: dataMode === mode ? '#fff' : 'var(--text-muted)',
                        textTransform: 'uppercase', letterSpacing: '0.05em',
                      }}
                    >
                      {mode}
                    </button>
                  ))}
                </div>
              )}

              {/* Days selector */}
              <select
                value={btDays}
                onChange={e => setBtDays(Number(e.target.value))}
                disabled={btRunning}
                style={{
                  padding: '3px 6px', borderRadius: 6, fontSize: 9, fontWeight: 600,
                  background: 'var(--bg-secondary)', border: '1px solid var(--border)',
                  color: 'var(--text-secondary)', cursor: 'pointer',
                }}
              >
                {[1, 2, 3, 5, 7, 14].map(d => (
                  <option key={d} value={d}>{d}d</option>
                ))}
              </select>

              <button
                onClick={runBacktest}
                disabled={btRunning}
                style={{
                  padding: '4px 10px', borderRadius: 7, fontSize: 9, fontWeight: 700,
                  cursor: btRunning ? 'not-allowed' : 'pointer',
                  background: 'var(--bg-secondary)', border: '1px solid var(--border)',
                  color: btRunning ? 'var(--text-muted)' : 'var(--text-secondary)',
                  opacity: btRunning ? 0.6 : 1,
                }}
                title={btProvider === 'openrouter'
                  ? 'Fetch settled markets + run ROMA/OpenRouter for 20 windows (blitz mode)'
                  : 'Fetch settled Kalshi markets + BTC candles and replay quant math'}
              >
                {btRunning
                  ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><span style={{ animation: 'spin-slow 1s linear infinite', display: 'inline-block' }}>◌</span>{btProvider === 'openrouter' ? 'Running LLM…' : 'Running…'}</span>
                  : `📊 Backtest ${btDays}d`}
              </button>
            </div>

            {btRecords.length > 0 && (
              <div style={{ fontSize: 9, color: 'var(--text-muted)', lineHeight: 1.6 }}>
                <span style={{ color: 'var(--green)', fontWeight: 700 }}>{btRecords.length}</span> backtest records loaded
                {' · '}quant-only (no LLM signals)
              </div>
            )}

            {!btRecords.length && !btRunning && (
              <div style={{ fontSize: 9, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                {btProvider === 'openrouter'
                  ? 'Runs full ROMA/OpenRouter analysis for 20 recent windows + quant-only for the rest. Calibrates both LLM and quant signals.'
                  : 'Replays GK vol + Black-Scholes + Student-t math against real settled markets. Seeds calibration with hundreds of records from day one.'}
              </div>
            )}
          </div>

          {error && (
            <div style={{ marginTop: 8, fontSize: 9, color: 'var(--pink)', lineHeight: 1.5 }}>
              {error}
            </div>
          )}
        </>
      )}
    </div>
  )
}
