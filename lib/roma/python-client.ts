/**
 * Sentient roma-dspy Python service client
 * ─────────────────────────────────────────
 * Shared helper used by all LLM-powered agents in the pipeline.
 * Every AI reasoning call routes through the official Sentient SDK.
 */

const PYTHON_ROMA_URL = process.env.PYTHON_ROMA_URL ?? 'http://localhost:8001'

export interface PythonRomaResponse {
  answer: string
  was_atomic: boolean
  subtasks: { id: string; goal: string; result: string }[]
  duration_ms: number
  provider: string
}

/** Reset the circuit breakers in the Python service after a transient failure. */
async function resetCircuitBreakers(): Promise<void> {
  await fetch(`${PYTHON_ROMA_URL}/reset`, { method: 'POST' }).catch(() => {/* best-effort */})
}

/**
 * Call the official Sentient roma-dspy service.
 * Retries up to `maxRetries` times with exponential backoff before throwing.
 * If a "Circuit breaker is open" error is detected, resets the breaker first.
 * Callers decide the fallback after all retries are exhausted.
 */
export async function callPythonRoma(
  goal: string,
  context: string,
  maxDepth = 1,
  maxRetries = 2,
  modeOverride?: string,
  provider?: string,  // overrides AI_PROVIDER in the Python service for this request
): Promise<PythonRomaResponse> {
  const romaMode = modeOverride ?? process.env.ROMA_MODE ?? 'smart'
  let lastErr: unknown
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const body: Record<string, unknown> = { goal, context, max_depth: maxDepth, roma_mode: romaMode }
      if (provider) body.provider = provider
      const res = await fetch(`${PYTHON_ROMA_URL}/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),  // 120s — depth=1 on Grok typically completes in ~30-60s
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        const err = new Error(`roma-dspy service ${res.status}: ${text}`)
        // Circuit breaker tripped — reset it so the next attempt goes through
        if (text.includes('Circuit breaker is open')) {
          await resetCircuitBreakers()
        }
        throw err
      }
      return await res.json()
    } catch (err) {
      lastErr = err
      if (attempt < maxRetries) {
        // Exponential backoff: 2s, 4s between retries
        await new Promise(r => setTimeout(r, 2_000 * attempt))
      }
    }
  }
  throw lastErr
}

/** Format a roma-dspy response as a human-readable trace string */
export function formatRomaTrace(result: PythonRomaResponse): string {
  if (result.was_atomic) {
    return `[roma-dspy · ${result.provider}: solved atomically — ${result.duration_ms}ms]\n\n${result.answer}`
  }
  return (
    `[roma-dspy · ${result.provider}: ${result.subtasks.length} subtasks — ${result.duration_ms}ms]\n` +
    result.subtasks.map(t => `• ${t.id}: ${t.goal}\n  → ${t.result}`).join('\n') +
    `\n\n[Aggregated Answer]\n${result.answer}`
  )
}
