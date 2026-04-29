import { hourlyServerAgent } from '@/lib/server-agent-hourly'
import { hourlyAgentStore } from '@/lib/agent-store-hourly'
import type { AgentStateSnapshot } from '@/lib/agent-shared'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const encoder  = new TextEncoder()
  const kvState  = await hourlyAgentStore.loadState().catch(() => null)

  const stream = new ReadableStream({
    start(controller) {
      function send(event: string, data: unknown) {
        try { controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)) }
        catch { /* client disconnected */ }
      }

      const liveState = hourlyServerAgent.getState()
      send('state', liveState.active ? liveState : (kvState ?? liveState))

      const onState         = (s: AgentStateSnapshot) => send('state', s)
      const onAgent         = (p: { key: string; result: unknown }) => send('agent', p)
      const onPipelineStart = () => send('pipeline_start', {})

      hourlyServerAgent.on('state',          onState)
      hourlyServerAgent.on('agent',          onAgent)
      hourlyServerAgent.on('pipeline_start', onPipelineStart)

      let lastKvJson = kvState ? JSON.stringify(kvState) : ''
      const kvPoller = setInterval(async () => {
        try {
          const s = await hourlyAgentStore.loadState()
          if (!s) return
          const j = JSON.stringify(s)
          if (j === lastKvJson) return
          lastKvJson = j
          if (!hourlyServerAgent.getState().active) send('state', s)
        } catch { /* KV unavailable */ }
      }, 5_000)

      const keepalive = setInterval(() => {
        try { controller.enqueue(encoder.encode(': keepalive\n\n')) }
        catch { clearInterval(keepalive) }
      }, 20_000)

      return () => {
        clearInterval(kvPoller)
        clearInterval(keepalive)
        hourlyServerAgent.off('state',          onState)
        hourlyServerAgent.off('agent',          onAgent)
        hourlyServerAgent.off('pipeline_start', onPipelineStart)
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
