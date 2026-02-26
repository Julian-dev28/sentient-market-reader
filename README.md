# Sentient Market Reader

> **Live Kalshi prediction market algotrader powered by the Sentient ROMA multi-agent framework — swap between Grok, Claude, GPT-4o, or OpenRouter with a single env var.**

![Next.js](https://img.shields.io/badge/Next.js_16-black?style=flat-square&logo=next.js)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)
![xAI Grok](https://img.shields.io/badge/xAI_Grok--3-000000?style=flat-square&logo=x&logoColor=white)
![Anthropic](https://img.shields.io/badge/Claude_Sonnet_4.6-D97706?style=flat-square&logo=anthropic&logoColor=white)
![OpenAI](https://img.shields.io/badge/GPT--4o-412991?style=flat-square&logo=openai&logoColor=white)
![OpenRouter](https://img.shields.io/badge/OpenRouter-6366F1?style=flat-square)
![Kalshi](https://img.shields.io/badge/Kalshi_API-1a1a2e?style=flat-square)
![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)

---

## What It Does

Sentient Market Reader connects to [Kalshi](https://kalshi.com)'s live KXBTC15M prediction markets — binary contracts that resolve YES/NO based on whether BTC's price is higher at the end of each 15-minute window — and runs a **Sentient ROMA (Recursive Open Meta-Agent)** pipeline to autonomously analyze the market and decide whether to trade.

Every 5 minutes the system runs a full 6-agent reasoning loop:

1. **MarketDiscovery** — scans Kalshi for the active KXBTC15M window, extracts strike price and time to expiry
2. **PriceFeed** — pulls live BTC/USD from CoinMarketCap, builds rolling price history
3. **SentimentAgent** — LLM-powered directional sentiment analysis (fast model)
4. **ProbabilityModelAgent** — ROMA recursive solve: decomposes the trading question into parallel sub-analyses, executes them concurrently, aggregates a calibrated P(YES) estimate (smart model)
5. **RiskManager** — deterministic Kelly-based position sizing, daily loss cap, drawdown limits
6. **Execution** — generates a BUY YES / BUY NO / PASS signal, optionally places a live Kalshi order

Between pipeline cycles, bid/ask prices and BTC price refresh **every 2 seconds** via an independent polling hook so the dashboard always shows fresh market data.

The entire LLM layer is **provider-agnostic** — one env var to switch between Grok, Claude, GPT-4o, or any OpenRouter model.

---

## Architecture

```
┌───────────────────────────────────────────────────────────────────┐
│                    SENTIENT ROMA PIPELINE                         │
├───────────────────────────────────────────────────────────────────┤
│                                                                   │
│  ┌─────────────┐   ┌──────────────┐                              │
│  │   Kalshi    │   │CoinMarketCap │   External data sources       │
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
│  │  Stage 3 · SentimentAgent         (LLM — fast tier)      │    │
│  │  llmToolCall → score [-1,+1], label, momentum, signals   │    │
│  └───────────────┬──────────────────────────────────────────┘    │
│                  │                                                │
│  ┌───────────────▼──────────────────────────────────────────┐    │
│  │  Stage 4 · ProbabilityModelAgent  (ROMA recursive solve) │    │
│  │                                                           │    │
│  │   solve(goal, context, provider)                         │    │
│  │     ├─ ◎ ATOMIZER  [fast]  ── atomic or decompose?       │    │
│  │     ├─ ◉ PLANNER   [smart] ── generate 3–5 subtasks      │    │
│  │     ├─ ▶ EXECUTORS [fast]  ── Promise.all(subtasks)      │    │
│  │     │     ├─ "What does 1h momentum signal?"             │    │
│  │     │     ├─ "What does the Kalshi orderbook reveal?"    │    │
│  │     │     ├─ "P(BTC above strike) given time decay?"     │    │
│  │     │     └─ "Is there edge vs market-implied prob?"     │    │
│  │     └─ ⬟ AGGREGATOR [smart] ── unified market thesis     │    │
│  │                                                           │    │
│  │   llmToolCall [smart] ── extract pModel + recommendation │    │
│  └───────────────┬──────────────────────────────────────────┘    │
│                  │                                                │
│  ┌───────────────▼──────────────────────────────────────────┐    │
│  │  Stage 5 · RiskManagerAgent       (deterministic)        │    │
│  │  Kelly sizing · $150 daily cap · 15% drawdown limit      │    │
│  └───────────────┬──────────────────────────────────────────┘    │
│  ┌───────────────▼──────────────────────────────────────────┐    │
│  │  Stage 6 · ExecutionAgent         (deterministic)        │    │
│  │  BUY YES / BUY NO / PASS → paper trade or live order     │    │
│  └──────────────────────────────────────────────────────────┘    │
└───────────────────────────────────────────────────────────────────┘
```

---

## Provider-Agnostic LLM Layer

Every LLM call in the pipeline flows through a single unified client (`lib/llm-client.ts`). The provider is resolved at runtime from the `AI_PROVIDER` env var — no code changes needed to switch models.

```env
AI_PROVIDER=grok        # → grok-3 (smart) / grok-3-mini (fast)
AI_PROVIDER=anthropic   # → claude-sonnet-4-6 (smart) / claude-haiku-4-5 (fast)
AI_PROVIDER=openai      # → gpt-4o (smart) / gpt-4o-mini (fast)
AI_PROVIDER=openrouter  # → any OpenRouter model via OPENROUTER_MODEL / OPENROUTER_FAST_MODEL
```

**Model routing by tier:**

| Tier | Grok | Claude | GPT | OpenRouter |
|---|---|---|---|---|
| `fast` — Atomizer, Executors, Sentiment | `grok-3-mini` | `claude-haiku-4-5-20251001` | `gpt-4o-mini` | `OPENROUTER_FAST_MODEL` |
| `smart` — Planner, Aggregator, Probability | `grok-3` | `claude-sonnet-4-6` | `gpt-4o` | `OPENROUTER_MODEL` |

**Why two tiers?**
- `fast` — binary classification and focused single-question tasks; speed matters more than depth
- `smart` — complex decomposition, synthesis, and calibrated probability extraction; quality matters

---

## ROMA: How the AI Pipeline Works

ROMA (Recursive Open Meta-Agent) is a multi-agent framework by [Sentient Foundation](https://github.com/sentient-agi/ROMA) that breaks complex goals into parallelizable subtasks, executes them independently, and aggregates results. This project implements ROMA's core architecture in TypeScript, provider-agnostic:

```
solve(goal, context, provider):
  if atomizer.isAtomic(goal):
    return executor.run(goal, context, provider)
  else:
    subtasks = planner.decompose(goal, context, provider)
    results  = await Promise.all(subtasks.map(t => solve(t, context, provider)))
    return aggregator.synthesize(results, provider)
```

**What each module does in the trading context:**

- **Atomizer** — fast binary gate: is the trading question simple enough to answer directly, or does it need decomposition? Full market analysis always decomposes.
- **Planner** — dynamically generates 3–5 independent analytical subtasks from the live market snapshot: momentum signal, orderbook sentiment, probability estimate, edge vs market, time decay, etc.
- **Executors** — each subtask runs in parallel via `Promise.all`. Every executor uses the fast model to answer one focused question using the full market context.
- **Aggregator** — synthesizes all executor answers into a unified market thesis with a directional view and calibrated confidence.
- **Extractor** — a final structured tool call maps the qualitative ROMA analysis to typed `ProbabilityOutput` JSON (pModel, recommendation, confidence).

Risk Manager and Execution Agent are intentionally **not LLM-powered** — safety-critical rules should be deterministic and auditable.

---

## Tech Stack

| Layer | Tech |
|---|---|
| **Framework** | Next.js 16 App Router (React 19) |
| **Language** | TypeScript (strict) |
| **AI — Grok** | xAI Grok-3 / Grok-3-mini via `openai` SDK (custom baseURL) |
| **AI — Claude** | Anthropic claude-sonnet-4-6 / claude-haiku-4-5 via `@anthropic-ai/sdk` |
| **AI — GPT** | OpenAI gpt-4o / gpt-4o-mini via `openai` SDK |
| **AI — OpenRouter** | Any model via OpenRouter API with configurable smart/fast model env vars |
| **Multi-Agent** | Custom ROMA engine (`lib/roma/`) — Atomizer → Planner → Executors → Aggregator |
| **Prediction Markets** | Kalshi Trade API v2 (KXBTC15M series) |
| **Price Data** | CoinMarketCap Pro API |
| **Auth** | RSA-PSS request signing (`crypto.createSign`) for Kalshi |
| **Charts** | Recharts |
| **Styling** | CSS design tokens (Sentient Foundation palette) |

---

## Features

- **Full 6-agent ROMA pipeline** — genuine multi-agent AI reasoning on every cycle, not hardcoded heuristics
- **Provider-agnostic** — one env var to switch the entire pipeline between Grok, Claude, GPT-4o, or OpenRouter
- **2-second live refresh** — `useMarketTick` hook polls bid/ask prices and BTC price every 2 seconds between pipeline cycles, keeping the dashboard current without waiting 5 minutes
- **Auto-run on load** — pipeline fires immediately on page load so signals appear without a manual trigger
- **Live + Paper mode** — toggle between real Kalshi order placement and simulated paper trading
- **Real-time 3-column dashboard** — market card + signal panel | BTC chart + ROMA pipeline visualizer | performance + trade log
- **ROMA pipeline grid** — 2-column × 3-row agent card layout with step numbers, status indicators, per-agent reasoning, and elapsed timers
- **Animated UI** — number count-up animations (`useCountUp`), shimmer bars, SVG countdown rings for expiry and cycle timer, `slideUpFade` trade log rows
- **RSA-PSS authentication** — proper Kalshi API signing with millisecond timestamps, correct padding and salt length
- **Kelly position sizing** — half-Kelly contract sizing derived from model edge and contract odds
- **Risk controls** — $150 daily loss limit · 15% max drawdown · 48 trades/day cap · 3% minimum edge threshold
- **Live Kalshi account panel** — balance, open positions, resting orders, recent fills, cancel buttons
- **Rule-based fallbacks** — all LLM stages fall back to deterministic logic if the API is unavailable

---

## Getting Started

### Prerequisites

- Node.js 18+
- A [Kalshi](https://kalshi.com) account with API access and RSA key pair from account settings
- API key for at least one LLM provider: [xAI](https://console.x.ai) · [Anthropic](https://console.anthropic.com) · [OpenAI](https://platform.openai.com) · [OpenRouter](https://openrouter.ai)
- A [CoinMarketCap Pro API key](https://pro.coinmarketcap.com)

### Install

```bash
git clone https://github.com/Julian-dev28/sentient-market-reader.git
cd sentient-market-reader
npm install
```

### Configure

```env
# .env.local

# ── LLM Provider ────────────────────────────────────────────────────
AI_PROVIDER=grok          # anthropic | grok | openai | openrouter

XAI_API_KEY=xai-...       # required if AI_PROVIDER=grok
# ANTHROPIC_API_KEY=sk-ant-...      # required if AI_PROVIDER=anthropic
# OPENAI_API_KEY=sk-...             # required if AI_PROVIDER=openai
# OPENROUTER_API_KEY=sk-or-...      # required if AI_PROVIDER=openrouter
# OPENROUTER_MODEL=anthropic/claude-sonnet-4-6    # smart tier
# OPENROUTER_FAST_MODEL=anthropic/claude-haiku-4-5  # fast tier

# ── Market Data ─────────────────────────────────────────────────────
CMC_API_KEY=your-coinmarketcap-key

# ── Kalshi ──────────────────────────────────────────────────────────
KALSHI_API_KEY=your-kalshi-api-key-id
KALSHI_PRIVATE_KEY_PATH=./kalshi_private_key.pem
```

Place your Kalshi RSA private key at `./kalshi_private_key.pem` (already `.gitignore`d).

### Run

```bash
npm run dev
# → http://localhost:3000
```

The pipeline fires automatically on page load. Hit **Run Cycle** to trigger a manual analysis. Subsequent cycles run every 5 minutes. Bid/ask and BTC price refresh every 2 seconds. Paper mode is the default — no real orders are placed unless you toggle Live Trading and confirm.

---

## Project Structure

```
├── app/
│   ├── api/
│   │   ├── pipeline/route.ts       # ROMA pipeline endpoint (maxDuration: 300s)
│   │   ├── btc-price/              # CoinMarketCap BTC price proxy
│   │   ├── markets/                # Kalshi market list proxy
│   │   ├── place-order/            # Kalshi order placement
│   │   ├── balance/                # Kalshi account balance
│   │   ├── positions/              # Open positions + fills
│   │   └── cancel-order/[id]/      # Order cancellation
│   ├── globals.css                 # Design tokens + keyframe animations
│   └── page.tsx                    # 3-column dashboard layout
│
├── lib/
│   ├── llm-client.ts               # Unified LLM interface (Grok / Claude / OpenAI / OpenRouter)
│   ├── roma/                       # ROMA multi-agent engine
│   │   ├── atomizer.ts             # [fast] atomic or decompose?
│   │   ├── planner.ts              # [smart] generate subtasks
│   │   ├── executor.ts             # [fast] execute one atomic task
│   │   ├── aggregator.ts           # [smart] synthesize results
│   │   ├── solve.ts                # Recursive solve loop w/ Promise.all
│   │   └── index.ts                # Trading wrapper + structured extraction
│   ├── agents/
│   │   ├── market-discovery.ts     # Kalshi KXBTC15M market scanner
│   │   ├── price-feed.ts           # CoinMarketCap BTC price + history
│   │   ├── sentiment.ts            # LLM sentiment agent (fast tier)
│   │   ├── probability-model.ts    # ROMA probability agent (smart tier)
│   │   ├── risk-manager.ts         # Kelly sizing + deterministic risk rules
│   │   ├── execution.ts            # Order generation
│   │   └── index.ts                # 6-stage pipeline orchestrator
│   ├── kalshi-auth.ts              # RSA-PSS request signing
│   ├── kalshi-trade.ts             # Order placement / portfolio reads
│   └── types.ts                    # Shared TypeScript interfaces
│
├── components/
│   ├── AgentPipeline.tsx           # 2-col × 3-row ROMA pipeline grid + loading animation
│   ├── MarketCard.tsx              # Live market data + SVG countdown ring
│   ├── PriceChart.tsx              # BTC/USD area chart with strike price line
│   ├── SignalPanel.tsx             # Edge %, probability bars, sentiment meter
│   ├── PositionsPanel.tsx          # Live Kalshi account (live mode)
│   ├── TradeLog.tsx                # Trade history with animated P&L rows
│   ├── PerformancePanel.tsx        # Win rate, avg edge, equity curve
│   ├── Header.tsx                  # Live/Paper toggle, SVG cycle ring, UTC clock
│   └── FloatingBackground.tsx      # Minimal CSS blobs + dot grid
│
└── hooks/
    ├── usePipeline.ts              # 5-min polling, trade recording, settlement sim
    ├── useMarketTick.ts            # 2-second bid/ask + BTC price refresh
    └── useCountUp.ts               # RAF ease-out number animation
```

---

## Kalshi API Notes

- **Base URL:** `https://api.elections.kalshi.com/trade-api/v2/`
- **Auth headers:** `KALSHI-ACCESS-KEY` · `KALSHI-ACCESS-TIMESTAMP` (milliseconds) · `KALSHI-ACCESS-SIGNATURE`
- **Signature payload:** `{timestampMs}{METHOD}{path}` — direct concat, no separators, no query params in path
- **RSA padding:** `RSA_PKCS1_PSS_PADDING` with `RSA_PSS_SALTLEN_DIGEST`
- **Market discovery:** `?event_ticker=KXBTC15M-{YY}{MON}{DD}{HHMM}` in US Eastern Time
- **Active markets:** `yes_ask > 0`; `floor_strike` = BTC price to beat; use `close_time` for countdown (not `expiration_time`)

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `AI_PROVIDER` | Yes | `grok` \| `anthropic` \| `openai` \| `openrouter` |
| `XAI_API_KEY` | If Grok | xAI API key |
| `ANTHROPIC_API_KEY` | If Claude | Anthropic API key |
| `OPENAI_API_KEY` | If OpenAI | OpenAI API key |
| `OPENROUTER_API_KEY` | If OpenRouter | OpenRouter API key |
| `OPENROUTER_MODEL` | If OpenRouter | Smart-tier model slug (e.g. `anthropic/claude-sonnet-4-6`) |
| `OPENROUTER_FAST_MODEL` | If OpenRouter | Fast-tier model slug (e.g. `anthropic/claude-haiku-4-5`) |
| `CMC_API_KEY` | Yes | CoinMarketCap Pro API key |
| `KALSHI_API_KEY` | Yes | Kalshi API key ID (UUID) |
| `KALSHI_PRIVATE_KEY_PATH` | Yes | Path to RSA private key PEM |

---

## Disclaimer

This project is for educational and research purposes. Paper trading is the default. Live trading places real orders with real money on a regulated prediction market exchange. Use live mode at your own risk. Nothing here is financial advice.

---

## License

MIT
