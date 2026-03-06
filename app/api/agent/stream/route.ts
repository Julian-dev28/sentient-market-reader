/**
 * GET /api/agent/stream
 *
 * SSE stream — pushes real-time agent state + streaming pipeline updates to the browser.
 * Events:
 *   state        — full AgentStateSnapshot (on every meaningful change)
 *   agent        — partial pipeline agent result { key, result }
 *   pipeline_start — pipeline cycle started (clears streamingAgents in browser)
 */

import { serverAgent } from '@/lib/server-agent'
import type { AgentStateSnapshot } from '@/lib/server-agent'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    start(controller) {
      function send(event: string, data: unknown) {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
        } catch { /* client disconnected */ }
      }

      // Send current state immediately on connect
      send('state', serverAgent.getState())

      // Subscribe to agent events
      const onState         = (s: AgentStateSnapshot) => send('state', s)
      const onAgent         = (p: { key: string; result: unknown }) => send('agent', p)
      const onPipelineStart = () => send('pipeline_start', {})

      serverAgent.on('state',          onState)
      serverAgent.on('agent',          onAgent)
      serverAgent.on('pipeline_start', onPipelineStart)

      // Keepalive comment every 20s to prevent proxy timeouts
      const keepalive = setInterval(() => {
        try { controller.enqueue(encoder.encode(': keepalive\n\n')) }
        catch { clearInterval(keepalive) }
      }, 20_000)

      // Cleanup when client disconnects
      return () => {
        clearInterval(keepalive)
        serverAgent.off('state',          onState)
        serverAgent.off('agent',          onAgent)
        serverAgent.off('pipeline_start', onPipelineStart)
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection':    'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
