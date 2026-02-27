# Sentient Market Reader

> **Live Kalshi prediction market algotrader powered by the Sentient ROMA multi-agent framework — swap between Grok, Claude, GPT-4o, HuggingFace, or OpenRouter with a single env var. Multi-provider parallel ensemble and split-stage routing for maximum speed.**

![Next.js](https://img.shields.io/badge/Next.js_16-black?style=flat-square&logo=next.js)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)
![xAI Grok](https://img.shields.io/badge/xAI_Grok--3-000000?style=flat-square&logo=x&logoColor=white)
![Anthropic](https://img.shields.io/badge/Claude_Sonnet_4.6-D97706?style=flat-square&logo=anthropic&logoColor=white)
![OpenAI](https://img.shields.io/badge/GPT--4o-412991?style=flat-square&logo=openai&logoColor=white)
![HuggingFace](https://img.shields.io/badge/HuggingFace-FFD21E?style=flat-square&logo=huggingface&logoColor=black)
![OpenRouter](https://img.shields.io/badge/OpenRouter-6366F1?style=flat-square)
![Kalshi](https://img.shields.io/badge/Kalshi_API-1a1a2e?style=flat-square)
![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)

---

## What It Does

Sentient Market Reader connects to [Kalshi](https://kalshi.com)'s live KXBTC15M prediction markets — binary contracts that resolve YES/NO based on whether BTC's price is higher at the end of each 15-minute window — and runs a **Sentient ROMA (Recursive Open Meta-Agent)** pipeline to autonomously analyze the market and decide whether to trade.

Every 5 minutes the system runs a full 6-agent reasoning loop:

1. **MarketDiscovery** — scans Kalshi for the active KXBTC15M window, extracts strike price and time to expiry
2. **PriceFeed** — pulls live BTC/USD from Coinbase (CoinGecko / Jupiter fallback), builds rolling price history
3. **SentimentAgent** — ROMA solve via the roma-dspy Python service; supports multi-provider parallel ensemble
4. **ProbabilityModelAgent** — ROMA recursive solve: decomposes the trading question into parallel sub-analyses, executes them concurrently, aggregates a calibrated P(YES) estimate; supports split-provider routing
5. **RiskManager** — deterministic Kelly-based position sizing with optional ROMA AI risk assessment
6. **Execution** — generates a BUY YES / BUY NO / PASS signal, optionally places a live Kalshi order

Between pipeline cycles, bid/ask prices and BTC price refresh **every 2 seconds** via an independent polling hook so the dashboard always shows fresh market data.

The entire LLM layer is **provider-agnostic** — one env var to switch between Grok, Claude, GPT-4o, HuggingFace, or any OpenRouter model. The **Provider Split Config** panel lets you run different providers per pipeline stage for maximum throughput.

---

## What is ROMA?

**ROMA (Recursive Open Meta-Agent)** is an open-source multi-agent reasoning framework built by [Sentient Foundation](https://github.com/sentient-agi/ROMA). Instead of sending one big prompt to an LLM and hoping for a good answer, ROMA breaks a complex goal into smaller sub-problems, solves them in parallel, and synthesizes the results — like a research team rather than a single analyst.

Every ROMA solve runs the same four-agent loop:

```
Goal
 └─ ◎ Atomizer  — is this simple enough to answer directly, or does it need decomposing?
      ├─ [atomic]  → Executor answers the goal directly
      └─ [complex] → Planner generates 3–5 subtasks
                       → Executors run all subtasks in parallel
                       → Aggregator synthesizes into a unified answer
```

**Why it matters for trading:**

- The question *"will BTC close above $X in 12 minutes?"* is not a single-answer question — it requires combining price momentum, orderbook pressure, time-decay probability, and sentiment. A single LLM call conflates these dimensions and produces overconfident outputs.
- ROMA forces each dimension into its own Executor, each of which reasons independently without anchoring on what the other Executors are concluding. The Aggregator then weighs these independent signals.
- The Atomizer/Planner use a fast, cheap model (blitz-tier). The Executors and Aggregator use the full quality model. This means the reasoning cost is paid only where it matters.

**This project uses the official `roma-dspy` Python SDK** — a real ROMA runtime, not a prompt that mimics one. The Next.js pipeline calls a FastAPI microservice that runs genuine ROMA solves and returns structured results. Two stages run in parallel (Sentiment + Probability hit separate API pools simultaneously), cutting wall time roughly in half vs sequential.

---

## Architecture

```
┌───────────────────────────────────────────────────────────────────┐
│                    SENTIENT ROMA PIPELINE                         │
├───────────────────────────────────────────────────────────────────┤
│                                                                   │
│  ┌─────────────┐   ┌──────────────┐                              │
│  │   Kalshi    │   │   Coinbase   │   External data sources       │
│  │  KXBTC15M   │   │   BTC/USD    │                              │
│  └──────┬──────┘   └──────┬───────┘                              │
│         └────────┬─────────┘                                     │
│                  │                                                │
│  ┌───────────────▼──────────────────────────────────────────┐    │
│  │  Stage 1 · MarketDiscoveryAgent   (no LLM)               │    │
│  │  Finds active KXBTC15M market, extracts strike, TTL      │    │
│  └───────────────┬──────────────────────────────────────────┘    │
│  ┌───────────────▼──────────────────────────────────────────┐    │
│  │  Stage 2 · PriceFeedAgent         (no LLM)               │    │
│  │  Live BTC price, 1h/24h change, rolling history          │    │
│  └───────────────┬──────────────────────────────────────────┘    │
│                  │                                                │
│  ┌───────────────▼──────────────────────────────────────────┐    │
│  │  Stage 3 · SentimentAgent         (ROMA — roma-dspy)     │    │
│  │  Multi-provider ensemble: parallel solve across N models  │    │
│  │  Answers merged and passed to Probability stage           │    │
│  └───────────────┬──────────────────────────────────────────┘    │
│                  │                                                │
│  ┌───────────────▼──────────────────────────────────────────┐    │
│  │  Stage 4 · ProbabilityModelAgent  (ROMA recursive solve) │    │
│  │  Optional split provider (different from Sentiment)       │    │
│  │                                                           │    │
│  │   solve(goal, context, provider)                         │    │
│  │     ├─ ◎ ATOMIZER  ── atomic or decompose?  (fast LLM)  │    │
│  │     ├─ ◉ PLANNER   ── generate 3–5 subtasks (fast LLM)  │    │
│  │     ├─ ▶ EXECUTORS ── Promise.all(subtasks) (quality LLM)│   │
│  │     │     ├─ "What does 1h momentum signal?"             │    │
│  │     │     ├─ "What does the Kalshi orderbook reveal?"    │    │
│  │     │     ├─ "P(BTC above strike) given time decay?"     │    │
│  │     │     └─ "Is there edge vs market-implied prob?"     │    │
│  │     └─ ⬟ AGGREGATOR ── unified market thesis (quality)   │    │
│  │                                                           │    │
│  └───────────────┬──────────────────────────────────────────┘    │
│                  │                                                │
│  ┌───────────────▼──────────────────────────────────────────┐    │
│  │  Stage 5 · RiskManagerAgent                              │    │
│  │  Deterministic Kelly sizing · optional ROMA AI risk      │    │
│  │  $150 daily cap · 15% drawdown limit · 48 trades/day     │    │
│  └───────────────┬──────────────────────────────────────────┘    │
│  ┌───────────────▼──────────────────────────────────────────┐    │
│  │  Stage 6 · ExecutionAgent         (deterministic)        │    │
│  │  BUY YES / BUY NO / PASS → paper trade or live order     │    │
│  └──────────────────────────────────────────────────────────┘    │
└───────────────────────────────────────────────────────────────────┘
```

---

## ROMA Mode & Speed

Every pipeline cycle runs at the speed you choose. The mode selector sits in the center panel and persists across sessions.

| Mode | Model (Grok default) | Pipeline speed |
|---|---|---|
| **blitz** | `grok-4-1-fast-non-reasoning` | ~30–60s |
| **sharp** | `grok-3-mini-fast` | ~1–2 min |
| **keen** | `grok-3` | ~1–3 min |
| **smart** | `grok-4-0709` | ~1–3 min — highest quality |

Default is **blitz**. Set `ROMA_MODE` in `.env.local` to change the server-side default.

Set `ROMA_MAX_DEPTH` to control how many decomposition levels ROMA uses (default `1`). Higher depth = richer reasoning but proportionally slower. Keep at `1` for live 15-min windows. **Never set to `0`** — ROMA interprets `0` as unlimited recursion.

### Tiered ROMA Agents

Within each solve, orchestration tasks (Atomizer + Planner) use the model one tier below the selected mode — they're lightweight decomposition calls. Executor + Aggregator use the full selected model for quality reasoning. This cuts 30–50% off wall time vs using a single model tier for all agents.

---

## ROMA Depth Guide

### What `max_depth` Does

ROMA solves a goal by recursively decomposing it. At each level the same pipeline runs:

```
Atomizer → Planner → [parallel Executors] → Aggregator
```

The **Atomizer** decides whether the goal is simple enough to answer directly, or needs breaking into subtasks. If it decomposes, the **Planner** generates subtasks, **Executors** run them in parallel, and the **Aggregator** synthesizes the results. `max_depth` caps how many times that loop can recurse.

---

### Depth 1 — Single Loop (default)

```
Goal
 └─ Atomizer → [atomic? → Executor]
             → [complex? → Planner → Executor₁, Executor₂, ...Executorₙ → Aggregator]
```

- One flat pass through the full pipeline — Atomizer, Planner, parallel Executors, Aggregator all run
- Subtasks are answered directly by Executors and never recursed into further
- **~5–7 LLM calls · 10–90s wall time depending on mode**
- Correct choice for focused, single-question analysis like a 15-minute BTC prediction

---

### Depth 2 — Two Levels

```
Goal
 └─ Atomizer → Planner → [
      SubGoal₁: Atomizer → Planner → Executor₁a, Executor₁b → Aggregator₁
      SubGoal₂: Atomizer → Planner → Executor₂a, Executor₂b → Aggregator₂
      ...
    ] → Top-level Aggregator
```

- Each subtask from depth-1 can itself run a full ROMA loop before returning its result
- LLM call count multiplies: 4 subtasks × 4 sub-subtasks = ~35 calls vs ~7
- The top-level Aggregator is blocked until the **slowest subtask's full sub-loop finishes** — latency stacks
- **~25–42 LLM calls · 120–200s wall time on Grok**
- Hits the 220s fetch timeout on slow models (grok-3, grok-4-0709) — not safe for live trading windows

---

### The `max_depth=0` Bug (and why it matters)

When this app originally used blitz mode it sent `max_depth=0`, intending "force atomic — shortest possible solve." The actual behavior was the opposite.

**`max_depth=0` in roma-dspy means unlimited recursion.** The value `0` is falsy, and the ROMA runtime interprets it as "no depth limit." A blitz pipeline that was supposed to make 5–7 calls instead recursed to depth 5, making ~40+ calls. Wall time went from an expected ~15s to **3 minutes 40 seconds**. Circuit breakers tripped mid-solve and cascaded failures across the run.

The fix is a `Math.max(1, ...)` guard in both agent callers so the value can never reach zero regardless of what the env var says:

```typescript
const maxDepth = Math.max(1, parseInt(process.env.ROMA_MAX_DEPTH ?? '1'))
```

Set `ROMA_MAX_DEPTH` in `.env.local`. **Never set it to `0`.**

---

### Depth Scaling Summary

| Depth | LLM Calls | Wall Time (Grok) | Best For |
|---|---|---|---|
| 1 | 5–7 | 30s–3 min | Live trading — focused single-question analysis |
| 2 | 25–42 | 3–7 min | Multi-faceted research where subtasks are themselves complex |
| 3+ | 100+ | 10+ min | Deep strategic research, not real-time trading |

---

### When Depth 2+ Is Worth It

Depth is not a quality dial — it is a **complexity-matching tool**. Using depth-2 on a simple goal does not produce a better answer; it just causes each Executor to generate an over-engineered sub-analysis of a simple question, which the Aggregator then re-synthesizes as noise.

Depth 2+ makes sense when subtasks are themselves genuinely multi-dimensional problems that benefit from further decomposition:

- **Macro thesis generation** — *"Build a comprehensive BTC outlook for the next 30 days"* decomposes into macro environment, on-chain metrics, derivatives positioning — each complex enough to warrant its own sub-loop
- **Multi-asset correlation** — *"Should I be long BTC or ETH options given current regime?"* — each asset analysis is non-trivial
- **Event-driven pre-trade research** — before FOMC, CPI, or ETF rebalances: historical impact, current positioning, vol surface — each a multi-step analysis
- **Portfolio risk assessment** — *"What is my aggregate risk across all open Kalshi positions?"* — per-market correlation, liquidity, and TTL analysis stacks well at depth 2
- **Backtest interpretation** — diagnosing losing trades, identifying regime changes, proposing adjustments

For the KXBTC15M 15-minute binary: **always depth-1.** The question (*will BTC close above $X in N minutes?*) decomposes cleanly at one level into technicals, sentiment, orderbook pressure, and momentum — and each of those is simple enough that a single Executor handles it correctly. Depth-2 adds recursion where there is no second level of complexity.

---

## Provider Split Config

The **Provider Split Config** card (center column, top) lets you route different pipeline stages to different LLM providers simultaneously — eliminating inter-stage rate-limit pauses and maximizing throughput.

### Sentiment Ensemble
Run multiple providers in parallel for the Sentiment stage. Each provider runs its full ROMA solve concurrently; answers are merged before passing to Probability. Default: **grok + huggingface**.

### Probability Split
Run the Probability stage on a different provider than Sentiment. Since different providers have independent rate-limit buckets, the 4–8s inter-stage pause is eliminated. Default: **huggingface**.

**Configuration is persisted to localStorage and survives page reloads.**

| Config | Behavior |
|---|---|
| Single provider, same for both | 4–8s pause between Sentiment → Probability |
| Split provider (Probability ≠ Sentiment) | No pause — different rate-limit buckets |
| Ensemble (multiple Sentiment providers) | Parallel solve, merged answer, richer context |
| Blitz + grok ensemble + hf split | ~15–20s wall-clock target (default) |

---

## Provider Support

Switch the entire pipeline with one env var. All tiers remap automatically:

| Tier | Grok | Claude | GPT | HuggingFace |
|---|---|---|---|---|
| blitz | `grok-4-1-fast-non-reasoning` | `claude-haiku-4-5-20251001` | `gpt-4o-mini` | `Qwen2.5-1.5B` |
| sharp | `grok-3-mini-fast` | `claude-haiku-4-5-20251001` | `gpt-4o-mini` | `Llama-3.2-3B` |
| keen | `grok-3` | `claude-haiku-4-5-20251001` | `gpt-4o-mini` | `Llama-3.1-8B` |
| smart | `grok-4-0709` | `claude-sonnet-4-6` | `gpt-4o` | `Llama-3.3-70B` |

All model IDs are overridable via env vars. HuggingFace uses the serverless Inference API router at `https://router.huggingface.co/v1` by default; set `HF_BASE_URL` to point at a dedicated Inference Endpoint.

---

## Trading Bot

The **BotPanel** (right column) runs the pipeline autonomously every 5 minutes and places $100 paper or live orders when the execution agent approves a trade.

- **Paper mode** (default) — simulates trades, tracks P&L, no real money
- **Live mode** — places real Kalshi orders using your API key (requires Live Trading toggle in header)
- **Start / Stop** — explicit confirmation required before the bot activates
- **Safety gate** — manual "Run Cycle" clicks never place real orders, regardless of live mode; only the bot does

Risk controls enforced on every bot trade: 3% minimum edge · $150 daily loss cap · 15% max drawdown · 48 trades/day max.

---

## ROMA: How the AI Pipeline Works

ROMA (Recursive Open Meta-Agent) is a multi-agent framework by [Sentient Foundation](https://github.com/sentient-agi/ROMA) that breaks complex goals into parallelizable subtasks, executes them independently, and aggregates results.

This project uses the official **`roma-dspy` Python SDK** via a FastAPI microservice (`python-service/`). The Next.js pipeline calls `/analyze` with the trading goal + market context, receiving a structured answer from the real ROMA solve loop.

```
solve(goal, context):
  if atomizer.isAtomic(goal):
    return executor.run(goal, context)
  else:
    subtasks = planner.decompose(goal, context)
    results  = await Promise.all(subtasks.map(t => solve(t, context)))
    return aggregator.synthesize(results)
```

Risk Manager and Execution Agent are intentionally **deterministic** — safety-critical rules should be auditable. An optional **AI Risk** checkbox routes the risk stage through ROMA for qualitative assessment layered on top of the hard circuit breakers.

---

## Tech Stack

| Layer | Tech |
|---|---|
| **Framework** | Next.js 16 App Router (React 19) |
| **Language** | TypeScript (strict) |
| **AI — Grok** | xAI Grok-3 family via `openai` SDK (custom baseURL) |
| **AI — Claude** | Anthropic claude-sonnet-4-6 / claude-haiku-4-5 via `@anthropic-ai/sdk` |
| **AI — GPT** | OpenAI gpt-4o / gpt-4o-mini via `openai` SDK |
| **AI — HuggingFace** | Llama / Qwen via HF serverless Inference API (OpenAI-compatible) |
| **AI — OpenRouter** | Any model via OpenRouter API |
| **Multi-Agent** | Official Sentient `roma-dspy` Python SDK via FastAPI microservice |
| **Prediction Markets** | Kalshi Trade API v2 (KXBTC15M series) |
| **Price Data** | Coinbase spot API (CoinGecko / Jupiter DEX fallback) |
| **Auth** | RSA-PSS request signing (`crypto.createSign`) for Kalshi |
| **Charts** | Recharts |
| **Styling** | CSS design tokens (Sentient Foundation palette) |

---

## Features

- **Full ROMA pipeline via roma-dspy** — genuine multi-agent AI reasoning on every cycle via the official Python SDK
- **4-mode speed selector** — blitz / sharp / keen / smart buttons; each maps to a different model tier across all providers
- **Stop button** — abort any in-flight pipeline run mid-cycle; button turns red ■ Stop while running
- **Provider Split Config** — route Sentiment and Probability stages to different providers; ensemble multiple providers in parallel for Sentiment
- **Tiered ROMA agents** — Atomizer + Planner use fast model; Executor + Aggregator use quality model; cuts 30–50% overhead
- **HuggingFace provider** — Llama and Qwen models via the serverless Inference API router
- **Trading bot** — autonomous $100/trade agent, 5-min cycle, paper or live, explicit start/stop with confirmation
- **AI Risk Manager** — optional ROMA-powered risk assessment in addition to deterministic Kelly limits
- **2-second live refresh** — `useMarketTick` hook polls bid/ask, BTC price, and orderbook every 2 seconds
- **Live orderbook depth** — visualized bid/ask ladder with toggle
- **Live + Paper mode** — toggle between real Kalshi order placement and simulated paper trading
- **Real-time 3-column dashboard** — market card + signal panel | provider config + BTC chart + ROMA pipeline | bot + positions + performance
- **Kalshi live account panel** — balance, open positions, resting orders, cancel buttons (15s refresh)
- **RSA-PSS authentication** — proper Kalshi API signing with millisecond timestamps
- **Kelly position sizing** — half-Kelly contract sizing derived from model edge and contract odds
- **Risk controls** — $150 daily loss limit · 15% max drawdown · 48 trades/day cap · 3% minimum edge threshold

---

## Getting Started

### Prerequisites

- Node.js 18+
- Python 3.10+ (for the roma-dspy microservice)
- A [Kalshi](https://kalshi.com) account with API access and RSA key pair from account settings
- API key for at least one LLM provider: [xAI](https://console.x.ai) · [Anthropic](https://console.anthropic.com) · [OpenAI](https://platform.openai.com) · [HuggingFace](https://huggingface.co/settings/tokens) · [OpenRouter](https://openrouter.ai)

### Install

```bash
git clone https://github.com/Julian-dev28/sentient-market-reader.git
cd sentient-market-reader
npm install

# Set up the Python roma-dspy service
cd python-service
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### Configure

```env
# .env.local

# ── LLM Provider ────────────────────────────────────────────────────
AI_PROVIDER=grok          # anthropic | grok | openai | huggingface | openrouter
ROMA_MODE=blitz           # blitz | sharp | keen | smart  (default: blitz)
ROMA_MAX_DEPTH=1          # ROMA decomposition depth — never set 0 (unlimited recursion)

XAI_API_KEY=xai-...
# ANTHROPIC_API_KEY=sk-ant-...
# OPENAI_API_KEY=sk-...
# HUGGINGFACE_API_KEY=hf_...
# OPENROUTER_API_KEY=sk-or-...
# OPENROUTER_MODEL=x-ai/grok-3

# ── Model overrides (optional) ──────────────────────────────────────
GROK_BLITZ_MODEL=grok-4-1-fast-non-reasoning
GROK_FAST_MODEL=grok-3-mini-fast
GROK_MID_MODEL=grok-3
GROK_SMART_MODEL=grok-4-0709

HF_BLITZ_MODEL=Qwen/Qwen2.5-1.5B-Instruct
HF_FAST_MODEL=meta-llama/Llama-3.2-3B-Instruct
HF_MID_MODEL=meta-llama/Llama-3.1-8B-Instruct
HF_SMART_MODEL=meta-llama/Llama-3.3-70B-Instruct
# HF_BASE_URL=https://router.huggingface.co/v1  # default

# ── Kalshi ──────────────────────────────────────────────────────────
KALSHI_API_KEY=your-kalshi-api-key-id
KALSHI_PRIVATE_KEY_PATH=./kalshi_private_key.pem

# ── Python Service ───────────────────────────────────────────────────
PYTHON_ROMA_URL=http://localhost:8001
```

Place your Kalshi RSA private key at `./kalshi_private_key.pem` (already `.gitignore`d).

### Run

```bash
# Terminal 1 — Python roma-dspy service
cd python-service && source .venv/bin/activate
python3 -m uvicorn main:app --port 8001 --host 0.0.0.0

# Terminal 2 — Next.js
npm run dev
# → http://localhost:3000
```

The pipeline fires automatically on page load. Hit **▶ Run Cycle** to trigger a manual analysis — the button turns red as **■ Stop** while running so you can abort mid-flight. Use the mode buttons to control speed. Configure provider routing in the **Provider Split Config** card. Bid/ask and BTC price refresh every 2 seconds. Paper mode is the default — no real orders are placed unless you toggle Live Trading and confirm.

---

## Project Structure

```
├── app/
│   ├── api/
│   │   ├── pipeline/route.ts       # ROMA pipeline endpoint (maxDuration: 180s)
│   │   ├── btc-price/              # BTC price proxy (Coinbase → CoinGecko → Jupiter)
│   │   ├── markets/                # Kalshi market list proxy
│   │   ├── orderbook/[ticker]/     # Kalshi orderbook depth proxy
│   │   ├── place-order/            # Kalshi order placement
│   │   ├── balance/                # Kalshi account balance
│   │   ├── positions/              # Open positions + fills
│   │   └── cancel-order/[id]/      # Order cancellation
│   ├── globals.css                 # Design tokens + keyframe animations
│   └── page.tsx                    # 3-column dashboard + provider split config
│
├── lib/
│   ├── llm-client.ts               # Unified LLM interface — blitz/sharp/keen/smart tiers
│   ├── roma/
│   │   └── python-client.ts        # roma-dspy service client (callPythonRoma)
│   ├── agents/
│   │   ├── market-discovery.ts     # Kalshi KXBTC15M market scanner
│   │   ├── price-feed.ts           # BTC price + history
│   │   ├── sentiment.ts            # ROMA sentiment agent (multi-provider ensemble)
│   │   ├── probability-model.ts    # ROMA probability agent (split-provider support)
│   │   ├── risk-manager.ts         # Kelly sizing + deterministic rules + ROMA AI risk
│   │   ├── execution.ts            # Order generation
│   │   └── index.ts                # 6-stage pipeline orchestrator
│   ├── kalshi-auth.ts              # RSA-PSS request signing
│   ├── kalshi-trade.ts             # Order placement / portfolio reads
│   └── types.ts                    # Shared TypeScript interfaces
│
├── components/
│   ├── AgentPipeline.tsx           # ROMA pipeline grid + loading animation
│   ├── BotPanel.tsx                # Autonomous trading bot — start/stop, status, stats
│   ├── MarketCard.tsx              # Live market data + orderbook depth
│   ├── PriceChart.tsx              # BTC/USD area chart with strike price line
│   ├── SignalPanel.tsx             # Edge %, probability bars, sentiment meter
│   ├── PositionsPanel.tsx          # Live Kalshi account (live mode, 15s refresh)
│   ├── TradeLog.tsx                # Trade history with P&L rows
│   ├── PerformancePanel.tsx        # Paper trade stats — win rate, equity curve
│   ├── Header.tsx                  # Live/Paper toggle, cycle ring, UTC clock
│   └── FloatingBackground.tsx      # CSS blobs + dot grid
│
├── hooks/
│   ├── usePipeline.ts              # 5-min polling, bot auto-cycle, trade recording
│   ├── useMarketTick.ts            # 2-second bid/ask + BTC price + orderbook refresh
│   └── useCountUp.ts               # RAF ease-out number animation
│
└── python-service/
    ├── main.py                     # FastAPI wrapper for roma-dspy solve()
    │                               # Tiered agents, multi-provider parallel solve
    ├── requirements.txt
    └── .env                        # Mirrors root .env.local (model vars)
```

---

## Kalshi API Notes

- **Base URL:** `https://api.elections.kalshi.com/trade-api/v2/`
- **Auth headers:** `KALSHI-ACCESS-KEY` · `KALSHI-ACCESS-TIMESTAMP` (milliseconds) · `KALSHI-ACCESS-SIGNATURE`
- **Signature payload:** `{timestampMs}{METHOD}{path}` — direct concat, no separators, no query params in path
- **RSA padding:** `RSA_PKCS1_PSS_PADDING` with `RSA_PSS_SALTLEN_DIGEST`
- **Market discovery:** `?event_ticker=KXBTC15M-{YY}{MON}{DD}{HHMM}` in US Eastern Time
- **Active markets:** `yes_ask > 0`; `floor_strike` = BTC price to beat; use `close_time` for countdown (not `expiration_time`)
- **Trading hours:** ~11:30 AM – midnight ET weekdays

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `AI_PROVIDER` | Yes | `grok` \| `anthropic` \| `openai` \| `huggingface` \| `openrouter` |
| `ROMA_MODE` | No | `blitz` \| `sharp` \| `keen` \| `smart` — default `blitz` |
| `ROMA_MAX_DEPTH` | No | ROMA decomposition depth — default `1`; never set `0` (unlimited) |
| `XAI_API_KEY` | If Grok | xAI API key |
| `ANTHROPIC_API_KEY` | If Claude | Anthropic API key |
| `OPENAI_API_KEY` | If OpenAI | OpenAI API key |
| `HUGGINGFACE_API_KEY` | If HuggingFace | HuggingFace access token |
| `HF_BASE_URL` | No | HF Inference API base URL (default: serverless router) |
| `OPENROUTER_API_KEY` | If OpenRouter | OpenRouter API key |
| `OPENROUTER_MODEL` | If OpenRouter | Smart-tier model slug |
| `GROK_BLITZ_MODEL` | No | Override blitz-tier Grok model |
| `GROK_FAST_MODEL` | No | Override sharp-tier Grok model |
| `GROK_MID_MODEL` | No | Override keen-tier Grok model |
| `GROK_SMART_MODEL` | No | Override smart-tier Grok model |
| `HF_BLITZ_MODEL` | No | Override blitz-tier HF model |
| `HF_FAST_MODEL` | No | Override sharp-tier HF model |
| `HF_MID_MODEL` | No | Override keen-tier HF model |
| `HF_SMART_MODEL` | No | Override smart-tier HF model |
| `KALSHI_API_KEY` | Yes | Kalshi API key ID (UUID) |
| `KALSHI_PRIVATE_KEY_PATH` | Yes | Path to RSA private key PEM |
| `PYTHON_ROMA_URL` | No | roma-dspy service URL (default `http://localhost:8001`) |

---

## Disclaimer

This project is for educational and research purposes. Paper trading is the default. Live trading places real orders with real money on a regulated prediction market exchange. Use live mode at your own risk. Nothing here is financial advice.

---

## License

MIT
