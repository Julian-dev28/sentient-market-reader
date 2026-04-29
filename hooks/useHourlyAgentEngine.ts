'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import type { PipelineState, PartialPipelineAgents, AgentTrade, AgentStats } from '@/lib/types'
import type { AgentStateSnapshot } from '@/lib/agent-shared'
import { CONFIDENCE_THRESHOLD } from '@/lib/agent-shared'

const DEFAULT_STATE: AgentStateSnapshot = {
  active: false, allowance: 100, initialAllowance: 100, bankroll: 0,
  kellyMode: false, aiMode: false, isRunning: false, windowKey: null,
  windowBetPlaced: false, currentD: 0, lastPollAt: null, nextCycleIn: 0,
  error: null, orderError: null, trades: [],
  stats: { windowsTraded: 0, totalSlices: 0, totalDeployed: 0, totalPnl: 0, wins: 0, losses: 0, winRate: 0, bestWindow: 0, worstWindow: 0 },
  pipeline: null, strikePrice: 0, gkVol: 0.002, agentPhase: 'idle', windowCloseAt: 0,
}

export function useHourlyAgentEngine() {
  const [serverState, setServerState]         = useState<AgentStateSnapshot>(DEFAULT_STATE)
  const [streamingAgents, setStreamingAgents] = useState<PartialPipelineAgents>({})
  const esRef = useRef<EventSource | null>(null)

  useEffect(() => {
    fetch('/api/agent-hourly/state').then(r => r.json()).then(s => setServerState(s)).catch(() => {})
  }, [])

  useEffect(() => {
    let destroyed = false
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null

    function connect() {
      if (destroyed) return
      const es = new EventSource('/api/agent-hourly/stream')
      esRef.current = es
      es.addEventListener('state', (e: MessageEvent) => {
        if (!destroyed) try { setServerState(JSON.parse(e.data)) } catch { /* ignore */ }
      })
      es.addEventListener('agent', (e: MessageEvent) => {
        if (!destroyed) try {
          const { key, result } = JSON.parse(e.data)
          setStreamingAgents(prev => ({ ...prev, [key]: result }))
        } catch { /* ignore */ }
      })
      es.addEventListener('pipeline_start', () => { if (!destroyed) setStreamingAgents({}) })
      es.onerror = () => { es.close(); if (!destroyed) reconnectTimer = setTimeout(connect, 3_000) }
    }

    connect()
    return () => {
      destroyed = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      esRef.current?.close()
      esRef.current = null
    }
  }, [])

  const startAgent = useCallback(async (allowance: number, kellyMode?: boolean, bankroll?: number, kellyPct?: number): Promise<{ ok: boolean; error?: string }> => {
    try {
      const res = await fetch('/api/agent-hourly/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allowance, kellyMode, bankroll, kellyPct }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        return { ok: false, error: data.error ?? `HTTP ${res.status}` }
      }
      const data = await res.json().catch(() => null)
      if (data?.state) setServerState(data.state)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: String(e) }
    }
  }, [])

  const stopAgent = useCallback(async () => {
    const res  = await fetch('/api/agent-hourly/stop', { method: 'POST' })
    const data = await res.json().catch(() => null)
    if (data?.state) setServerState(data.state)
  }, [])

  const setAllowanceAmount = useCallback(async (amount: number, kellyMode?: boolean, bankroll?: number) => {
    await fetch('/api/agent-hourly/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ allowance: amount, kellyMode, bankroll }),
    })
  }, [])

  const clearHistory = useCallback(async () => {
    await fetch('/api/agent-hourly/clear-history', { method: 'POST' })
  }, [])

  return {
    active:              serverState.active,
    allowance:           serverState.allowance,
    initialAllowance:    serverState.initialAllowance,
    trades:              serverState.trades as AgentTrade[],
    pipeline:            serverState.pipeline as PipelineState | null,
    streamingAgents,
    isRunning:           serverState.isRunning,
    nextCycleIn:         serverState.nextCycleIn,
    error:               serverState.error,
    orderError:          serverState.orderError,
    stats:               serverState.stats as AgentStats,
    windowKey:           serverState.windowKey,
    windowBetPlaced:     serverState.windowBetPlaced,
    currentD:            serverState.currentD,
    confidenceThreshold: CONFIDENCE_THRESHOLD,
    lastPollAt:          serverState.lastPollAt,
    strikePrice:         serverState.strikePrice,
    gkVol:               serverState.gkVol,
    bankroll:            serverState.bankroll,
    kellyMode:           serverState.kellyMode,
    aiMode:              false,
    agentPhase:          serverState.agentPhase,
    windowCloseAt:       serverState.windowCloseAt,
    startAgent,
    stopAgent,
    setAllowanceAmount,
    runCycle:            useCallback(async () => {}, []),  // no manual run on hourly
    clearHistory,
    giveAllowance:       useCallback(async () => {}, []),
  }
}
