/**
 * Pipeline singleton lock — prevents concurrent ROMA runs from clogging the Python service.
 * Lives in a stable singleton module; survives Next.js hot-reloads of route files.
 * Each ROMA blitz solve makes ~6 LLM calls (~90-150s); running them concurrently
 * causes API rate-limit queuing and cascading timeouts in the Python service.
 */

export interface LastAnalysis {
  pModel: number
  pMarket: number
  edge: number
  recommendation: string
  sentimentScore: number
  sentimentLabel: string
  btcPrice: number
  strikePrice: number
  completedAt: string
}

// globalThis persists across Next.js hot-reloads (unlike module-level vars in route files)
const g = globalThis as typeof globalThis & {
  _pipelineLocked?: boolean
  _pipelineLockedAt?: number
  _lastAnalysis?: LastAnalysis
}

export function tryLockPipeline(): boolean {
  // Auto-release stale locks (pipeline crashed without releasing)
  if (g._pipelineLocked && g._pipelineLockedAt && Date.now() - g._pipelineLockedAt > 360_000) {
    g._pipelineLocked = false
  }
  if (g._pipelineLocked) return false
  g._pipelineLocked = true
  g._pipelineLockedAt = Date.now()
  return true
}

export function releasePipelineLock(): void {
  g._pipelineLocked = false
  g._pipelineLockedAt = undefined
}

export function isPipelineLocked(): boolean {
  return !!g._pipelineLocked
}

export function setLastAnalysis(a: LastAnalysis): void {
  g._lastAnalysis = a
}

export function getLastAnalysis(): LastAnalysis | undefined {
  return g._lastAnalysis
}
