# ROMA Pipeline — Mode & Engine Spec

## Current active config

```
AI_PROVIDER=grok          → extraction only (fast JSON tool-call, ~1-2s)
AI_PROVIDER2=openrouter   → ROMA reasoning solves (sentiment + probability, in parallel)
ROMA_MODE=blitz
ROMA_MAX_DEPTH=1
ROMA_BEAM_WIDTH=2
```

---

## Mode spec — what runs at each ROMA_MODE

Each mode uses a **tiered engine**: executor/aggregator (the reasoning stages) get
a heavier model; atomizer/planner (orchestration stages) get one tier lighter.
Sentiment also runs one tier lighter than probability by default.

### `blitz` — live trading, speed priority (~45-70s wall time)

| Stage | Role | Provider | Model |
|-------|------|----------|-------|
| Atomizer | orchestration | openrouter | `qwen3.5-flash-02-23` |
| Planner | orchestration | openrouter | `qwen3.5-flash-02-23` |
| Executor ×2 (parallel) | reasoning | openrouter | `qwen3.5-flash-02-23` |
| Aggregator | reasoning | openrouter | `qwen3.5-flash-02-23` |
| Sentiment extraction | JSON parse | grok | `grok-3-mini-fast` |
| Probability extraction | JSON parse | grok | `grok-3-mini-fast` |

> Sentiment and probability ROMA solves run in parallel (wall time = max of the two).

---

### `sharp` — balanced quality/speed (~60-90s)

| Stage | Role | Provider | Model |
|-------|------|----------|-------|
| Atomizer | orchestration | openrouter | `qwen3.5-flash-02-23` ← blitz orch |
| Planner | orchestration | openrouter | `qwen3.5-flash-02-23` ← blitz orch |
| Executor ×2 (parallel) | reasoning | openrouter | `qwen3.5-flash-02-23` |
| Aggregator | reasoning | openrouter | `qwen3.5-flash-02-23` |
| Sentiment extraction | JSON parse | grok | `grok-3-mini-fast` |
| Probability extraction | JSON parse | grok | `grok-3-mini-fast` |

> Sentiment runs at `sharp` tier; probability runs at `sharp` tier (same here).

---

### `keen` — analysis quality (~90-150s)

| Stage | Role | Provider | Model |
|-------|------|----------|-------|
| Atomizer | orchestration | openrouter | `qwen3-14b` ← sharp orch |
| Planner | orchestration | openrouter | `qwen3-14b` ← sharp orch |
| Executor ×2 (parallel) | reasoning | openrouter | `qwen3-30b-a3b` |
| Aggregator | reasoning | openrouter | `qwen3-30b-a3b` |
| Sentiment extraction | JSON parse | grok | `grok-3-mini-fast` |
| Probability extraction | JSON parse | grok | `grok-3-mini-fast` |

> Sentiment runs at `sharp` tier (qwen3-14b); probability at `keen` (qwen3-30b-a3b).

---

### `smart` — deep analysis, off live-window (~150-240s)

| Stage | Role | Provider | Model |
|-------|------|----------|-------|
| Atomizer | orchestration | openrouter | `qwen3-30b-a3b` ← keen orch |
| Planner | orchestration | openrouter | `qwen3-30b-a3b` ← keen orch |
| Executor ×2 (parallel) | reasoning | openrouter | `qwen3-max` |
| Aggregator | reasoning | openrouter | `qwen3-max` |
| Sentiment extraction | JSON parse | grok | `grok-3-mini-fast` |
| Probability extraction | JSON parse | grok | `grok-3-mini-fast` |

> Sentiment runs at `keen` tier (qwen3-30b-a3b); probability at `smart` (qwen3-max).
> All-Qwen stack — maximum reasoning depth.

---

## Tiering rules (hardcoded)

```
Orchestration tier (atomizer/planner):
  blitz→blitz | sharp→blitz | keen→sharp | smart→keen

Sentiment vs Probability tier:
  blitz→blitz/blitz | sharp→sharp/sharp | keen→sharp/keen | smart→keen/smart
```

So `keen` mode runs sentiment at `sharp` (qwen3.5-flash) for speed, probability at `keen`
(qwen3-30b-a3b) for quality — the decision-critical stage gets the better model.

---

## Knobs

### ROMA_MODE
Sets which row of the model stack all stages use. Changing this is the primary
speed/quality dial.

### ROMA_MAX_DEPTH
How many recursive decomposition levels ROMA can apply.
- `1` — one split (recommended for live trading). Atomizer decides atomic vs. 1 level of subtasks.
- `2` — subtasks can themselves be split again. ~2× LLM calls, ~2× wall time.
- Never `0` — treated as unlimited recursion by the SDK.

### ROMA_BEAM_WIDTH
Number of executor subtasks run in parallel when ROMA decomposes a task.
- `2` (default) — 2 executor calls run simultaneously, aggregator synthesizes both.
- `3` — more analytical threads, ~1.5× token cost, same wall time (parallel).
- `1` — single executor path; useful when rate-limit constrained.

### Model stack
Which model sits at each tier for each provider. Change the env vars to swap
a model without changing mode logic:

```
# OpenRouter (current — AI_PROVIDER2=openrouter)
OPENROUTER_BLITZ_MODEL=qwen/qwen3.5-flash-02-23  # $0.10/$0.40/M  — linear-attn MoE, fastest
OPENROUTER_FAST_MODEL=qwen/qwen3.5-flash-02-23  # $0.10/$0.40/M  — sharp tier
OPENROUTER_MID_MODEL=qwen/qwen3-30b-a3b         # $0.08/$0.28/M  — keen tier (30B MoE)
OPENROUTER_MODEL=qwen/qwen3-max                 # $1.20/$6.00/M  — smart tier

# Grok direct (AI_PROVIDER=grok — extraction only currently)
GROK_BLITZ_MODEL=grok-3-mini-fast
GROK_FAST_MODEL=grok-3-mini-fast
GROK_MID_MODEL=grok-3
GROK_SMART_MODEL=grok-4-0709
```

**When to swap the stack vs change the mode:**
- Swap the stack when a specific model releases or degrades at a given tier.
- Change the mode when you want a uniform speed/quality shift across the whole pipeline.
- Mix them: run `keen` mode but swap the keen executor to a faster model to get keen-quality
  orchestration with faster execution.
