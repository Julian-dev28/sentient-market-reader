/**
 * Shared agent constants and types — safe to import in both server and browser.
 * Keep this file free of any server-only imports (fs, crypto, etc).
 */

import type { PipelineState, AgentTrade, AgentStats } from './types'

export const CONFIDENCE_THRESHOLD = 1.0
export const KELLY_FRACTION = 0.25

export interface AgentStateSnapshot {
  active:           boolean
  allowance:        number
  initialAllowance: number
  bankroll:         number
  kellyMode:        boolean
  isRunning:        boolean
  windowKey:        string | null
  windowBetPlaced:  boolean
  currentD:         number
  lastPollAt:       number | null
  nextCycleIn:      number
  error:            string | null
  orderError:       string | null
  trades:           AgentTrade[]
  stats:            AgentStats
  pipeline:         PipelineState | null
  strikePrice:      number
  gkVol:            number
}
