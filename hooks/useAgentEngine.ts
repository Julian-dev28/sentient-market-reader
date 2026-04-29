'use client'

/**
 * useAgentEngine — thin browser hook.
 *
 * All agent logic (timing, polling, pipeline, order placement) runs server-side
 * in lib/server-agent.ts via Node.js. This hook:
 *   1. Subscribes to /api/agent/stream (SSE) for real-time state updates
 *   2. Calls POST endpoints to start/stop/configure the agent
 *   3. Exposes the same interface as before so AgentPage needs no changes
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import type { PipelineState, PartialPipelineAgents, AgentTrade, AgentStats } from '@/lib/types'
import type { AgentStateSnapshot } from '@/lib/agent-shared'
import { CONFIDENCE_THRESHOLD } from '@/lib/agent-shared'

const DEFAULT_STATE: AgentStateSnapshot = {
  active:           false,
  allowance:        100,
  initialAllowance: 100,
  bankroll:         0,
  kellyMode:        false,
  aiMode:           false,
  isRunning:        false,
  windowKey:        null,
  windowBetPlaced:  false,
  currentD:         0,
  lastPollAt:       null,
  nextCycleIn:      0,
  error:            null,
  orderError:       null,
  trades:           [],
  stats: {
    windowsTraded: 0, totalSlices: 0, totalDeployed: 0, totalPnl: 0,
    wins: 0, losses: 0, winRate: 0, bestWindow: 0, worstWindow: 0,
  },
  pipeline: null,
  strikePrice: 0,
  gkVol: 0.002,
  agentPhase: 'idle',
  windowCloseAt: 0,
}

export function useAgentEngine(orModel?: string) {
  const [serverState, setServerState]       = useState<AgentStateSnapshot>(DEFAULT_STATE)
  const [streamingAgents, setStreamingAgents] = useState<PartialPipelineAgents>({})
  const esRef = useRef<EventSource | null>(null)
  // Track the last applied state JSON so we can bail out on identical snapshots
  // (the server pushes a fresh object every tick; without this guard every
  // countdown tick schedules a re-render and React will eventually trip its
  // "Maximum update depth exceeded" guard under bursty emits).
  const lastStateJsonRef = useRef<string>('')

  const applyServerState = useCallback((s: AgentStateSnapshot) => {
    let j: string
    try { j = JSON.stringify(s) } catch { j = '' }
    if (j && j === lastStateJsonRef.current) return
    lastStateJsonRef.current = j
    setServerState(s)
  }, [])

  // ── Hydrate state immediately on mount (no SSE delay) ───────────────────
  useEffect(() => {
    fetch('/api/agent/state')
      .then(r => r.json())
      .then(s => applyServerState(s))
      .catch(() => {})
  }, [applyServerState])

  // ── Subscribe to SSE stream ──────────────────────────────────────────────
  useEffect(() => {
    let destroyed = false
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null

    function connect() {
      if (destroyed) return
      const es = new EventSource('/api/agent/stream')
      esRef.current = es

      es.addEventListener('state', (e: MessageEvent) => {
        if (destroyed) return
        try { applyServerState(JSON.parse(e.data)) } catch (err) { console.warn('[SSE] Malformed state frame:', err) }
      })

      es.addEventListener('agent', (e: MessageEvent) => {
        if (destroyed) return
        try {
          const { key, result } = JSON.parse(e.data) as { key: keyof PartialPipelineAgents; result: PartialPipelineAgents[keyof PartialPipelineAgents] }
          setStreamingAgents(prev => (prev[key] === result ? prev : { ...prev, [key]: result }))
        } catch (err) { console.warn('[SSE] Malformed agent frame:', err) }
      })

      es.addEventListener('pipeline_start', () => {
        if (destroyed) return
        // Preserve reference when already empty to avoid a no-op re-render.
        setStreamingAgents(prev => (Object.keys(prev).length === 0 ? prev : {}))
      })

      es.onerror = () => {
        es.close()
        if (!destroyed) {
          reconnectTimer = setTimeout(connect, 3_000)
        }
      }
    }

    connect()
    return () => {
      destroyed = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      esRef.current?.close()
      esRef.current = null
    }
  }, [])

  // ── Actions (call server API routes) ────────────────────────────────────

  const startAgent = useCallback(async (allowance: number, kellyMode?: boolean, bankroll?: number, kellyPct?: number, aiMode?: boolean): Promise<{ ok: boolean; error?: string }> => {
    try {
      const res = await fetch('/api/agent/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allowance, orModel, kellyMode, bankroll, kellyPct, aiMode }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        return { ok: false, error: data.error ?? `HTTP ${res.status}` }
      }
      // Apply state directly from response — don't wait for SSE which may be mid-reconnect
      const data = await res.json().catch(() => null)
      if (data?.state) setServerState(data.state)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: String(e) }
    }
  }, [orModel])

  const stopAgent = useCallback(async () => {
    const res = await fetch('/api/agent/stop', { method: 'POST' })
    const data = await res.json().catch(() => null)
    if (data?.state) setServerState(data.state)
  }, [])

  const setAllowanceAmount = useCallback(async (amount: number, kellyMode?: boolean, bankroll?: number) => {
    await fetch('/api/agent/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ allowance: amount, kellyMode, bankroll }),
    })
  }, [])

  const runCycle = useCallback(async () => {
    await fetch('/api/agent/run', { method: 'POST' })
  }, [])

  const clearHistory = useCallback(async () => {
    await fetch('/api/agent/clear-history', { method: 'POST' })
  }, [])

  // ── Expose same interface as old hook ────────────────────────────────────
  return {
    active:           serverState.active,
    allowance:        serverState.allowance,
    initialAllowance: serverState.initialAllowance,
    trades:           serverState.trades as AgentTrade[],
    pipeline:         serverState.pipeline as PipelineState | null,
    streamingAgents,
    isRunning:        serverState.isRunning,
    nextCycleIn:      serverState.nextCycleIn,
    error:            serverState.error,
    orderError:       serverState.orderError,
    stats:            serverState.stats as AgentStats,
    windowKey:        serverState.windowKey,
    windowBetPlaced:  serverState.windowBetPlaced,
    currentD:         serverState.currentD,
    confidenceThreshold: CONFIDENCE_THRESHOLD,
    lastPollAt:       serverState.lastPollAt,
    strikePrice:      serverState.strikePrice,
    gkVol:            serverState.gkVol,
    bankroll:         serverState.bankroll,
    kellyMode:        serverState.kellyMode,
    aiMode:           serverState.aiMode,
    agentPhase:       serverState.agentPhase,
    windowCloseAt:    serverState.windowCloseAt,
    startAgent,
    stopAgent,
    setAllowanceAmount,
    runCycle,
    clearHistory,
    // giveAllowance kept for API compat
    giveAllowance: useCallback(async (delta: number) => {
      await fetch('/api/agent/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allowance: serverState.allowance + delta }),
      })
    }, [serverState.allowance]),
  }
}
