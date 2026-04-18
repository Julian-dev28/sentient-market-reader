/**
 * GET /api/agent/stream
 *
 * SSE stream — pushes real-time agent state + streaming pipeline updates to the browser.
 *
 * Two update paths run in parallel:
 *   1. EventEmitter (same Vercel instance) — immediate, real-time
 *   2. KV poll every 5s (any Vercel instance) — cross-instance fallback
 *
 * This ensures that even if the browser reconnects to a different warm instance
 * after a page refresh, it still sees the current agent state within 5 seconds.
 *
 * Events:
 *   state          — full AgentStateSnapshot
 *   agent          — partial pipeline agent result { key, result }
 *   pipeline_start — pipeline cycle started (clears streamingAgents in browser)
 */

import { serverAgent } from '@/lib/server-agent'
import { agentStore } from '@/lib/agent-store'
import type { AgentStateSnapshot } from '@/lib/agent-shared'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const encoder = new TextEncoder()

  // Pre-fetch KV state before opening the stream — works on any cold instance
  const kvState = await agentStore.loadState().catch(() => null)

  const stream = new ReadableStream({
    start(controller) {
      function send(event: string, data: unknown) {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
        } catch { /* client disconnected */ }
      }

      // Send best available state immediately on connect:
      // prefer live in-memory agent (same instance), fall back to KV (cross-instance)
      const liveState = serverAgent.getState()
      send('state', liveState.active ? liveState : (kvState ?? liveState))

      // ── Path 1: EventEmitter (same instance — immediate) ─────────────────
      const onState         = (s: AgentStateSnapshot) => send('state', s)
      const onAgent         = (p: { key: string; result: unknown }) => send('agent', p)
      const onPipelineStart = () => send('pipeline_start', {})

      serverAgent.on('state',          onState)
      serverAgent.on('agent',          onAgent)
      serverAgent.on('pipeline_start', onPipelineStart)

      // ── Path 2: KV poll every 5s (cross-instance fallback) ───────────────
      // Catches state changes made by a different Vercel instance (e.g. start/stop
      // called while this SSE connection is open on a different warm instance).
      let lastKvJson = kvState ? JSON.stringify(kvState) : ''
      const kvPoller = setInterval(async () => {
        try {
          const s = await agentStore.loadState()
          if (!s) return
          const j = JSON.stringify(s)
          if (j === lastKvJson) return
          lastKvJson = j
          // Only push KV state when local agent is inactive on this instance —
          // avoids double-sending when the same instance handles both paths.
          if (!serverAgent.getState().active) send('state', s)
        } catch { /* KV unavailable — ignore */ }
      }, 5_000)

      // ── Keepalive every 20s ───────────────────────────────────────────────
      const keepalive = setInterval(() => {
        try { controller.enqueue(encoder.encode(': keepalive\n\n')) }
        catch { clearInterval(keepalive) }
      }, 20_000)

      return () => {
        clearInterval(kvPoller)
        clearInterval(keepalive)
        serverAgent.off('state',          onState)
        serverAgent.off('agent',          onAgent)
        serverAgent.off('pipeline_start', onPipelineStart)
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type':      'text/event-stream',
      'Cache-Control':     'no-cache, no-transform',
      'Connection':        'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
