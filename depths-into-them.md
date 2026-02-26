# ROMA Depths — How They Work, Why We Dropped Depth 2, and Future Trading Uses

## What Is a ROMA Depth?

ROMA (Recursive Orchestration of Multi-Agent) solves a goal by recursively decomposing it.
The `max_depth` parameter controls how many levels of decomposition are allowed.

At each level, the pipeline is:
```
Atomizer → Planner → [parallel Executors] → Aggregator
```

The **Atomizer** decides if the goal is simple enough to answer directly (atomic) or needs
decomposition. If decomposed, the **Planner** breaks it into subtasks, **Executors** run them
in parallel, and the **Aggregator** synthesizes the results into a single answer.

`max_depth` caps how deep that recursion can go.

---

## Depth 1 — Single ROMA Loop

```
Goal
 └─ Atomizer → [atomic? → Executor]
             → [complex? → Planner → Executor₁, Executor₂, ...Executorₙ → Aggregator]
```

- One flat pass through the pipeline
- If the goal is atomic, a single Executor handles it (no planning step)
- If complex, it spawns parallel Executors for each subtask — but those subtasks are answered
  directly by Executors, never recursed into further
- Typical LLM calls: **5–7**
- Typical wall time on Grok: **30–60s**

---

## Depth 2 — Two Levels of ROMA

```
Goal
 └─ Atomizer → Planner → [
      SubGoal₁: Atomizer → Planner → Executor₁a, Executor₁b → Aggregator₁,
      SubGoal₂: Atomizer → Planner → Executor₂a, Executor₂b → Aggregator₂,
      ...
    ] → Top-level Aggregator
```

- Each subtask from the depth-1 decomposition can itself be decomposed into its own full
  ROMA loop before returning its result
- LLM call count multiplies: if depth-1 spawns 4 subtasks and each spawns 4 sub-subtasks,
  you go from ~7 calls to ~35 calls
- The top-level Aggregator is blocked until the **slowest subtask's full ROMA loop** finishes,
  so the critical path is 4 stacked rounds of LLM latency
- Typical LLM calls: **25–42**
- Typical wall time on Grok: **~192s** (sentiment ~120s, probability ~192s)

---

## Why Depth 2 Was Removed From This App

**The goal is too focused.** KXBTC15M is a 15-minute BTC prediction market with a single
binary question: *will BTC close above $X in the next N minutes?*

Depth-1 decomposes that well into parallel analytical angles — technicals, sentiment,
orderbook pressure, momentum — and each of those is simple enough that a single Executor
handles it correctly. There is no second level of complexity that warrants further
decomposition.

**The cost is not worth it.** The pipeline runs on a 5-minute cycle. Spending ~192s on
depth-2 for marginal signal improvement on a short-horizon question consumes the majority
of the cycle window before the result is even usable.

**Depth-1 is already the full ROMA loop.** We are not skipping anything meaningful.
Atomizer, Planner, parallel Executors, and Aggregator all still run. Depth-2 only adds
recursive sub-loops inside each Executor result, which for this specific goal produces
noise rather than insight.

---

## When Depth 2 (or Higher) Would Be Useful for Trading

Depth 2+ makes sense when **subtasks are themselves genuinely complex, multi-dimensional
problems** that benefit from further decomposition — not just retrieval or a single
analytical judgment.

### Macro Thesis Generation
A goal like *"build a comprehensive BTC thesis for the next 30 days"* decomposes into
subtasks like *"analyze macro environment"*, *"analyze on-chain metrics"*, *"analyze
derivatives positioning"* — each of which is complex enough to warrant its own
Planner→Executors→Aggregator cycle.

### Multi-Asset Correlation Analysis
*"Should I be long BTC or ETH options given current regime?"* — the subtask of analyzing
each asset independently is non-trivial and benefits from depth-2 decomposition.

### Event-Driven Pre-Trade Research
Before a major catalyst (FOMC, CPI print, ETF rebalance), a depth-2 solve could research
the event's historical impact, the current positioning, and the expected vol surface — each
subtask deep enough to justify recursion.

### Portfolio-Level Risk Assessment
*"What is my aggregate risk across all open Kalshi positions?"* — subtasks involve
understanding each market's correlation, liquidity, and time-to-expiry, which are each
multi-step analyses.

### Strategy Backtesting Interpretation
Feeding a backtest result and asking ROMA to explain what worked and what didn't —
the subtasks of *"diagnose losing trades"*, *"identify regime changes"*, and *"propose
adjustments"* each benefit from depth-2 decomposition.

---

## Depth Scaling Summary

| Depth | LLM Calls (approx) | Wall Time (Grok) | Best For |
|-------|-------------------|-----------------|---------|
| 1     | 5–7               | 30–60s          | Focused, single-question analysis |
| 2     | 25–42             | 120–200s        | Multi-faceted research where subtasks are themselves complex |
| 3+    | 100+              | 10+ min         | Deep strategic research, not real-time trading |

---

## Key Insight

Depth is not a quality dial — it is a **complexity matching tool**. Using depth-2 on a
simple goal does not make the answer better; it just makes each Executor produce an
over-engineered sub-analysis of a simple question and then re-synthesizes the noise.

Match depth to the genuine complexity of the goal. For 15-minute binary prediction:
depth-1. For multi-day macro positioning: depth-2. For full portfolio strategy construction:
depth-3+.
