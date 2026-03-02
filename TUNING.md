# ROMA Pipeline Tuning Guide

Four knobs control the speed/quality tradeoff of every pipeline run.
They interact — understanding all four lets you dial in exactly the
behaviour you want.

---

## 1. ROMA_MODE — Analysis quality tier

```
ROMA_MODE=blitz | sharp | keen | smart
```

Sets which model tier the **executor** and **aggregator** agents use
(the stages that actually reason about the market). The orchestration
agents (atomizer, planner) automatically run one tier lighter.

| Mode  | Wall time (est.) | Use when |
|-------|-----------------|----------|
| blitz | 20–45s          | Live trading window — speed over depth |
| sharp | 30–60s          | Good balance; reliable intra-window signal |
| keen  | 45–90s          | Pre-window prep or post-window review |
| smart | 60–120s         | Deep analysis; model uses most capable models at every stage |

The comment next to each model in `.env` shows estimated per-stage
time. Wall time = max(sentiment, probability) since both run in
parallel.

---

## 2. ROMA_MAX_DEPTH — Decomposition depth

```
ROMA_MAX_DEPTH=1   # recommended
ROMA_MAX_DEPTH=2   # more subtasks, slower, rarely worth it
```

Controls how many times ROMA can recursively split a task into
subtasks. **0 means unlimited — never use 0.**

- **Depth 1**: Atomizer decides atomic vs. one decomposition level.
  One set of executor calls. Recommended for all live trading.
- **Depth 2**: Each subtask can itself be split again. Roughly doubles
  the number of LLM calls and wall time. Only useful for thorough
  post-session analysis where time doesn't matter.

Depth has compound effects: depth 2 with beam_width 2 = up to 4
executor calls instead of 2.

---

## 3. ROMA_BEAM_WIDTH — Parallel executor subtasks

```
ROMA_BEAM_WIDTH=2   # default — 2 executor subtasks run in parallel
ROMA_BEAM_WIDTH=3   # more coverage, ~1.5× cost, same wall time (parallel)
ROMA_BEAM_WIDTH=1   # fewest tokens; useful when rate-limit constrained
```

When ROMA decomposes a task, beam_width is the number of subtask
executor calls it runs simultaneously. Because they're parallel, going
from 1→2→3 beams barely changes wall time but increases coverage and
token cost proportionally.

Beam 3 is useful for smart/keen modes where you want the aggregator
to synthesize more independent analytical threads. For blitz it
adds cost without much quality gain.

---

## 4. Model stack — Per-tier provider and model selection

```
AI_PROVIDER=grok          # primary: used for extraction (fast, reliable tool-call JSON)
AI_PROVIDER2=openrouter   # split: both Sentiment + Probability ROMA solves go here
```

The **model stack** is the set of models assigned to each tier across
both providers. It's independent from ROMA_MODE — the mode selects
*which row* of the stack to use; the stack defines *what's in each row*.

### Current stack (OpenRouter, via AI_PROVIDER2)

| Tier  | Model                          | Why |
|-------|-------------------------------|-----|
| blitz | `google/gemini-2.5-flash-lite` | Fastest; handles complex financial context with ChatAdapter; proven ~20-30s/stage |
| sharp | `anthropic/claude-haiku-4-5`   | Claude quality at low latency; excellent instruction-following |
| keen  | `anthropic/claude-sonnet-4-6`  | Sonnet reasoning; best quality/speed balance for serious analysis |
| smart | `anthropic/claude-sonnet-4-6`  | Best available; use for deep review outside live windows |

### Swapping the stack

You can mix providers per-tier. Examples:

```
# All-Gemini stack (fastest overall, good quality)
OPENROUTER_BLITZ_MODEL=google/gemini-2.5-flash-lite
OPENROUTER_FAST_MODEL=google/gemini-2.5-flash
OPENROUTER_MID_MODEL=google/gemini-2.5-pro-preview
OPENROUTER_MODEL=google/gemini-2.5-pro-preview

# All-Grok stack via direct xAI (no OpenRouter overhead)
# Set AI_PROVIDER2= (empty) and AI_PROVIDER=grok
GROK_BLITZ_MODEL=grok-3-mini-fast
GROK_FAST_MODEL=grok-3-mini-fast
GROK_MID_MODEL=grok-3
GROK_SMART_MODEL=grok-4-0709
```

### When to think about the stack vs the mode

- **Change the mode** when you want a consistent speed/quality shift
  across all calls (blitz for fast live trading, smart for review).
- **Change the stack** when a specific model is underperforming on a
  particular analysis type, or when a new model releases that's
  meaningfully faster or better at financial reasoning.
- **Mix stacks** when your blitz-tier model is good enough for
  orchestration (atomizer/planner) but you want a stronger model for
  the executor/aggregator — that's the tiered config pattern already
  implemented (analysis_llm vs orchestration_llm in main.py).

---

## How the knobs combine

A pipeline call in `blitz` mode with `ROMA_MAX_DEPTH=1` and
`ROMA_BEAM_WIDTH=2` using the default OpenRouter stack:

```
Atomizer  [gemini-flash-lite, 900 tok]   →  is it atomic?
                                              ↓ no
Planner   [gemini-flash-lite, 1200 tok]  →  split into 2 subtasks
                                              ↓
Executor  [gemini-flash-lite, 3000 tok]  ×2 in parallel
                                              ↓
Aggregator[gemini-flash-lite, 1500 tok]  →  synthesize
```

Estimated wall time per solve: ~30-45s.
Two solves (Sentiment + Probability) run in parallel → total ~45s.

Switching to `keen` mode uses `claude-sonnet-4-6` for the executor
and aggregator, with `claude-haiku-4-5` for atomizer/planner:

```
Atomizer  [haiku-4-5,     1000 tok]
Planner   [haiku-4-5,     1400 tok]
Executor  [sonnet-4-6,    4000 tok] ×2 parallel
Aggregator[sonnet-4-6,    2000 tok]
```

Estimated wall time per solve: ~45-75s. Total ~75s.
