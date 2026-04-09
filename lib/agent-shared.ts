/**
 * Shared agent constants and types — safe to import in both server and browser.
 * Keep this file free of any server-only imports (fs, crypto, etc).
 */

import type { PipelineState, AgentTrade, AgentStats } from './types'

export const CONFIDENCE_THRESHOLD = 1.0  // edge zone begins at d=1.0 (empirical: +5.5pp margin, Z=2.33, p<0.01)
export const KELLY_FRACTION = 0.25

/** What the server-side agent is currently doing */
export type AgentPhase =
  | 'idle'          // not started
  | 'waiting'       // waiting for next valid window (autoTimeout running)
  | 'bootstrap'     // fetching first market data / strike price for this window
  | 'monitoring'    // d-poller running, watching for signal
  | 'pipeline'      // ROMA pipeline running (threshold triggered)
  | 'bet_placed'    // order placed, waiting for window close
  | 'pass_skipped'  // pipeline ran, decided PASS — skipping rest of window
  | 'order_failed'  // order placement failed, retrying

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
  agentPhase:       AgentPhase
  windowCloseAt:    number   // epoch ms of current window close (0 if unknown)
}
