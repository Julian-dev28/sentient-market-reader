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

export async function callPythonRoma(
  goal: string,
  context: string,
  options?: {
    maxDepth?: number
    romaMode?: string
    provider?: string
    modelOverride?: string
    apiKeys?: Record<string, string>
    signal?: AbortSignal
  },
): Promise<PythonRomaResponse> {
  // max_depth must be >= 1 — passing 0 to roma-dspy means unlimited recursion
  const body: Record<string, unknown> = {
    goal,
    context,
    max_depth: Math.max(1, options?.maxDepth ?? 1),
  }
  if (options?.romaMode)      body.roma_mode      = options.romaMode
  if (options?.provider)      body.provider       = options.provider
  if (options?.modelOverride) body.model_override = options.modelOverride
  if (options?.apiKeys)       body.api_keys       = options.apiKeys

  const res = await fetch(`${PYTHON_ROMA_URL}/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: options?.signal ?? AbortSignal.timeout(90_000),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`roma-dspy service ${res.status}: ${text}`)
  }
  return res.json() as Promise<PythonRomaResponse>
}

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
