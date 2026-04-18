# Agent Pipeline

## Overview

The trading pipeline runs 6 agents in sequence. The first two (MarketDiscovery, PriceFeed) are deterministic data fetchers. Agents 3–4 are either pure math (Quant mode) or ROMA multi-agent LLM calls (AI mode). Agents 5–6 are always deterministic.

```
MarketDiscovery → PriceFeed → [Markov|Sentiment] → [Probability|ROMA] → RiskManager → Execution
```

## Agent Definitions

### 1. MarketDiscovery (`lib/agents/market-discovery.ts`)
**Input**: none  
**Output**: `{ activeMarket, strikePrice, secondsUntilExpiry, marketOpen }`

Fetches the active KXBTC15M market from Kalshi. Auto-discovers current window. Filters expired markets (compares `close_time` to `Date.now()`). Sets `floor_strike` as `strikePrice`.

### 2. PriceFeed (`lib/agents/price-feed.ts`)
**Input**: none  
**Output**: `{ currentPrice, priceHistory, timestamp }`

Fetches BTC spot price from `/api/btc-price` (Coinbase → CoinGecko fallback). Also returns recent price history for the chart.

### 3. Markov / Sentiment
In **Quant mode**: `lib/agents/markov.ts`  
In **AI mode**: `lib/agents/sentiment.ts` (runs ROMA Grok pipeline)

**Markov output**: `{ pYes, pNo, expectedDrift, gap, persist, hurst, gkVol, dScore, signal, currentState, historyLength, recommendation }`

**Sentiment output** (ROMA): `{ sentiment, confidence, reasoning, sources }`
- `sentiment`: "bullish" | "bearish" | "neutral"
- `confidence`: 0–1
- `sources`: array of analyzed sources (from ROMA sub-tasks)

### 4. Probability / ROMA
In **Quant mode**: `lib/agents/probability-model.ts`  
In **AI mode**: ROMA aggregator produces this alongside sentiment

**Output**: `{ pModel, edge, recommendation, confidence, reasoning }`
- `pModel`: final probability estimate (combines Markov + optional AI)
- `edge`: `(pModel - marketPrice) * 100` in percentage points

### 5. RiskManager (`lib/agents/risk-manager.ts`)
Always deterministic.

**Input**: probability output, market data, options  
**Output**: `{ approved, reason, adjustedSize, riskLevel }`

Checks:
- Min edge ≥ 3%
- Daily loss cap: $150
- Drawdown limit: 15%
- Max 48 trades/day
- Not within 2 min of expiry in live mode

### 6. Execution (`lib/agents/execution.ts`)
**Input**: risk approval, market, probability  
**Output**: `{ action, side, contracts, limitPrice, estimatedCost, estimatedPayout, marketTicker, rationale }`

- `action`: `"BUY_YES"` | `"BUY_NO"` | `"PASS"`
- `limitPrice`: integer cents (from `yes_ask` or `no_ask`)
- `contracts`: Kelly-sized position
- In live mode with bot active: auto-calls `/api/place-order`

## Generic Agent Type

```typescript
// lib/types.ts
interface AgentResult<TOutput> {
  agentName:   string
  status:      'pending' | 'running' | 'done' | 'error'
  output:      TOutput
  error?:      string
  durationMs?: number
  model?:      string
}

interface PipelineResult {
  cycleId:          number
  cycleCompletedAt: string
  agents: {
    marketDiscovery: AgentResult<MarketDiscoveryOutput>
    priceFeed:       AgentResult<PriceFeedOutput>
    markov:          AgentResult<MarkovOutput> | null
    sentiment:       AgentResult<SentimentOutput> | null
    probability:     AgentResult<ProbabilityOutput>
    riskManager:     AgentResult<RiskManagerOutput>
    execution:       AgentResult<ExecutionOutput>
  }
}
```

## ROMA Multi-Agent Loop

When `analysisMode === 'ai'`, agents 3–4 use the ROMA framework (`lib/roma/`).

### ROMA Components

```
Atomizer → Planner → parallel Executors → Aggregator → Extractor
```

- **Atomizer** (`lib/roma/atomizer.ts`): Decomposes the trading question into atomic sub-tasks. Uses `claude-haiku-4-5`.
- **Planner** (`lib/roma/planner.ts`): Orders sub-tasks, identifies dependencies, assigns models. Uses `claude-sonnet-4-6`.
- **Executors** (`lib/roma/executor.ts`): Run sub-tasks in parallel via `Promise.all`. Each calls Grok with its specific task. Uses the user-selected Grok model.
- **Aggregator** (`lib/roma/aggregator.ts`): Synthesizes all executor results into a final recommendation. Uses `claude-sonnet-4-6`.
- **Extractor** (`lib/roma/index.ts`): Maps aggregated result to typed `SentimentOutput` + `ProbabilityOutput`.

### ROMA Depth

`ROMA_MAX_DEPTH` env var (default: 1). Controls how deeply ROMA decomposes tasks.

**Critical**: `max_depth=0` means **unlimited recursion** (0 is falsy in the DSPy check). Always set ≥1. The guard in the agent callers:

```typescript
const depth = Math.max(1, parseInt(process.env.ROMA_MAX_DEPTH || '1'))
```

Depth=1: ~30–60s, 7–9 Claude/Grok calls  
Depth=2: ~120–220s, hits fetch timeout on slow models — not recommended for live trading

### Per-Cycle LLM Call Count (AI mode, depth=1)
- 1 Atomizer call (haiku)
- 1 Planner call (sonnet)
- 3–5 Executor calls (grok)
- 1 Aggregator call (sonnet)
- 1 Extractor call (sonnet)
- **Total: 7–9 calls per pipeline run**

### Token Budgets (Blitz mode)
```typescript
aggregatorTokens = 800   // was 4000 before blitz fix
executorTokens   = 600   // was 2000 before blitz fix
```
Cutting these ~3x reduced per-call generation time significantly.

## Pipeline API Route

`app/api/pipeline/route.ts` — POST endpoint that runs the full pipeline.

```typescript
// Body:
{
  liveMode:      boolean
  aiRisk:        boolean
  orModel?:      string       // Grok model ID (AI mode only)
  liveBTCPrice?: number
  liveStrike?:   number
  interval?:     string       // "15m"
}

// Response: PipelineResult (full agent output)
```

Uses `lib/pipeline-lock.ts` to prevent concurrent runs (server-side mutex with 5-min timeout).

## Pipeline Lock

`lib/pipeline-lock.ts` — prevents two pipeline cycles running simultaneously.

```typescript
let locked = false
let lockedAt: number | null = null
const LOCK_TIMEOUT_MS = 5 * 60 * 1000  // auto-release after 5 min

export function acquireLock(): boolean {
  if (locked && lockedAt && Date.now() - lockedAt > LOCK_TIMEOUT_MS) {
    locked = false  // stale lock, release
  }
  if (locked) return false
  locked = true
  lockedAt = Date.now()
  return true
}
```

`serverLocked` in the UI means the lock is held (another client or previous run). The spinner shows and Run Cycle is disabled.

## Streaming (AI Mode)

In AI mode, the pipeline sends SSE (Server-Sent Events) to update the UI with each agent's completion in real time. `streamingAgents` in `usePipeline` is a `Set<string>` of currently-running agent names for animation.

## Adding a New Agent

1. Create `lib/agents/my-agent.ts` with `runMyAgent(input): Promise<AgentResult<MyOutput>>`
2. Add `MyOutput` to `lib/types.ts`
3. Add `myAgent: AgentResult<MyOutput>` to the `PipelineResult.agents` object
4. Call `runMyAgent()` in the pipeline route, passing previous agent outputs as needed
5. Add `MyAgentCard` rendering in `components/AgentPipeline.tsx`
