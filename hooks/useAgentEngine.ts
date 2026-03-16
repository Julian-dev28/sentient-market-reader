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
  bankroll:         400,
  kellyMode:        false,
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

  // ── Subscribe to SSE stream ──────────────────────────────────────────────
  useEffect(() => {
    function connect() {
      const es = new EventSource('/api/agent/stream')
      esRef.current = es

      es.addEventListener('state', (e: MessageEvent) => {
        try { setServerState(JSON.parse(e.data)) } catch {}
      })

      es.addEventListener('agent', (e: MessageEvent) => {
        try {
          const { key, result } = JSON.parse(e.data)
          setStreamingAgents(prev => ({ ...prev, [key]: result }))
        } catch {}
      })

      es.addEventListener('pipeline_start', () => {
        setStreamingAgents({})
      })

      es.onerror = () => {
        es.close()
        // Reconnect after 3s if connection drops
        setTimeout(connect, 3_000)
      }
    }

    connect()
    return () => {
      esRef.current?.close()
      esRef.current = null
    }
  }, [])

  // ── Actions (call server API routes) ────────────────────────────────────

  const startAgent = useCallback(async (allowance: number, kellyMode?: boolean, bankroll?: number, kellyPct?: number) => {
    await fetch('/api/agent/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ allowance, orModel, kellyMode, bankroll, kellyPct }),
    })
  }, [orModel])

  const stopAgent = useCallback(async () => {
    await fetch('/api/agent/stop', { method: 'POST' })
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
