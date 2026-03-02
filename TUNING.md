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
| Atomizer | orchestration | openrouter | `gemini-2.5-flash-lite` |
| Planner | orchestration | openrouter | `gemini-2.5-flash-lite` |
| Executor ×2 (parallel) | reasoning | openrouter | `gemini-2.5-flash-lite` |
| Aggregator | reasoning | openrouter | `gemini-2.5-flash-lite` |
| Sentiment extraction | JSON parse | grok | `grok-3-mini-fast` |
| Probability extraction | JSON parse | grok | `grok-3-mini-fast` |

> Sentiment and probability ROMA solves run in parallel (wall time = max of the two).

---

### `sharp` — balanced quality/speed (~60-90s)

| Stage | Role | Provider | Model |
|-------|------|----------|-------|
| Atomizer | orchestration | openrouter | `gemini-2.5-flash-lite` ← blitz orch |
| Planner | orchestration | openrouter | `gemini-2.5-flash-lite` ← blitz orch |
| Executor ×2 (parallel) | reasoning | openrouter | `claude-haiku-4-5` |
| Aggregator | reasoning | openrouter | `claude-haiku-4-5` |
| Sentiment extraction | JSON parse | grok | `grok-3-mini-fast` |
| Probability extraction | JSON parse | grok | `grok-3-mini-fast` |

> Sentiment runs at `sharp` tier; probability runs at `sharp` tier (same here).

---

### `keen` — analysis quality (~90-150s)

| Stage | Role | Provider | Model |
|-------|------|----------|-------|
| Atomizer | orchestration | openrouter | `claude-haiku-4-5` ← sharp orch |
| Planner | orchestration | openrouter | `claude-haiku-4-5` ← sharp orch |
| Executor ×2 (parallel) | reasoning | openrouter | `claude-sonnet-4-6` |
| Aggregator | reasoning | openrouter | `claude-sonnet-4-6` |
| Sentiment extraction | JSON parse | grok | `grok-3-mini-fast` |
| Probability extraction | JSON parse | grok | `grok-3-mini-fast` |

> Sentiment runs at `sharp` tier (haiku); probability at `keen` (sonnet).

---

### `smart` — deep analysis, off live-window (~150-240s)

| Stage | Role | Provider | Model |
|-------|------|----------|-------|
| Atomizer | orchestration | openrouter | `claude-sonnet-4-6` ← keen orch |
| Planner | orchestration | openrouter | `claude-sonnet-4-6` ← keen orch |
| Executor ×2 (parallel) | reasoning | openrouter | `claude-sonnet-4-6` |
| Aggregator | reasoning | openrouter | `claude-sonnet-4-6` |
| Sentiment extraction | JSON parse | grok | `grok-3-mini-fast` |
| Probability extraction | JSON parse | grok | `grok-3-mini-fast` |

> Sentiment runs at `keen` tier (sonnet); probability at `smart` (sonnet).
> All-Sonnet stack — maximum reasoning depth.

---

## Tiering rules (hardcoded)

```
Orchestration tier (atomizer/planner):
  blitz→blitz | sharp→blitz | keen→sharp | smart→keen

Sentiment vs Probability tier:
  blitz→blitz/blitz | sharp→sharp/sharp | keen→sharp/keen | smart→keen/smart
```

So `keen` mode runs sentiment at `sharp` (haiku) for speed, probability at `keen`
(sonnet) for quality — the decision-critical stage gets the better model.

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
OPENROUTER_BLITZ_MODEL=google/gemini-2.5-flash-lite
OPENROUTER_FAST_MODEL=anthropic/claude-haiku-4-5
OPENROUTER_MID_MODEL=anthropic/claude-sonnet-4-6
OPENROUTER_MODEL=anthropic/claude-sonnet-4-6

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
