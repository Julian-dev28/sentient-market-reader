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
3. **SentimentAgent** — ROMA solve via the roma-dspy Python service, directional sentiment analysis
4. **ProbabilityModelAgent** — ROMA recursive solve: decomposes the trading question into parallel sub-analyses, executes them concurrently, aggregates a calibrated P(YES) estimate
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
│  │  Stage 3 · SentimentAgent         (ROMA — roma-dspy)     │    │
│  │  Python service solve → score [-1,+1], label, signals    │    │
│  └───────────────┬──────────────────────────────────────────┘    │
│                  │                                                │
│  ┌───────────────▼──────────────────────────────────────────┐    │
│  │  Stage 4 · ProbabilityModelAgent  (ROMA recursive solve) │    │
│  │                                                           │    │
│  │   solve(goal, context, provider)                         │    │
│  │     ├─ ◎ ATOMIZER  ── atomic or decompose?               │    │
│  │     ├─ ◉ PLANNER   ── generate 3–5 subtasks              │    │
│  │     ├─ ▶ EXECUTORS ── Promise.all(subtasks)              │    │
│  │     │     ├─ "What does 1h momentum signal?"             │    │
│  │     │     ├─ "What does the Kalshi orderbook reveal?"    │    │
│  │     │     ├─ "P(BTC above strike) given time decay?"     │    │
│  │     │     └─ "Is there edge vs market-implied prob?"     │    │
│  │     └─ ⬟ AGGREGATOR ── unified market thesis             │    │
│  │                                                           │    │
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

## ROMA Mode Selector

Every pipeline cycle runs at the speed you choose. The mode selector sits next to the **Run Cycle** button and persists across sessions.

| Mode | Model (Grok default) | Pipeline speed |
|---|---|---|
| **sharp** | `grok-3-mini` | ~10–20s — fastest, lowest cost |
| **keen** | `grok-3-fast` | ~20–40s — balanced (default) |
| **smart** | `grok-3` | ~40–70s — highest quality |

Switch provider and all three tiers remap automatically:

| Tier | Grok | Claude | GPT |
|---|---|---|---|
| sharp (fast) | `grok-3-mini` | `claude-haiku-4-5-20251001` | `gpt-4o-mini` |
| keen (mid) | `grok-3-fast` | `claude-haiku-4-5-20251001` | `gpt-4o-mini` |
| smart | `grok-3` | `claude-sonnet-4-6` | `gpt-4o` |

Set `ROMA_MODE` in `.env.local` to change the server-side default. The UI mode selector overrides it per-cycle.

---

## Provider-Agnostic LLM Layer

Every LLM call flows through `lib/llm-client.ts` and `python-service/main.py`. Switch the entire pipeline with one env var:

```env
AI_PROVIDER=grok        # → Grok 3 family
AI_PROVIDER=anthropic   # → Claude Sonnet / Haiku
AI_PROVIDER=openai      # → GPT-4o / GPT-4o-mini
AI_PROVIDER=openrouter  # → any model via OPENROUTER_MODEL
```

All model IDs are overridable per tier:

```env
GROK_FAST_MODEL=grok-3-mini
GROK_MID_MODEL=grok-3-fast
GROK_SMART_MODEL=grok-3
```

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

**What each module does in the trading context:**

- **Atomizer** — fast binary gate: is the trading question simple enough to answer directly, or does it need decomposition?
- **Planner** — dynamically generates 3–5 independent analytical subtasks from the live market snapshot
- **Executors** — each subtask runs in parallel. Every executor answers one focused question using the full market context
- **Aggregator** — synthesizes all executor answers into a unified market thesis with a directional view and calibrated confidence

Risk Manager and Execution Agent are intentionally **not LLM-powered** — safety-critical rules should be deterministic and auditable.

---

## Tech Stack

| Layer | Tech |
|---|---|
| **Framework** | Next.js 16 App Router (React 19) |
| **Language** | TypeScript (strict) |
| **AI — Grok** | xAI Grok-3 family via `openai` SDK (custom baseURL) |
| **AI — Claude** | Anthropic claude-sonnet-4-6 / claude-haiku-4-5 via `@anthropic-ai/sdk` |
| **AI — GPT** | OpenAI gpt-4o / gpt-4o-mini via `openai` SDK |
| **AI — OpenRouter** | Any model via OpenRouter API |
| **Multi-Agent** | Official Sentient `roma-dspy` Python SDK via FastAPI microservice |
| **Prediction Markets** | Kalshi Trade API v2 (KXBTC15M series) |
| **Price Data** | CoinMarketCap Pro API |
| **Auth** | RSA-PSS request signing (`crypto.createSign`) for Kalshi |
| **Charts** | Recharts |
| **Styling** | CSS design tokens (Sentient Foundation palette) |

---

## Features

- **Full ROMA pipeline via roma-dspy** — genuine multi-agent AI reasoning on every cycle via the official Python SDK
- **3-mode speed selector** — sharp / keen / smart buttons in the UI; each maps to a different model tier across all providers
- **Provider-agnostic** — one env var to switch the entire pipeline between Grok, Claude, GPT-4o, or OpenRouter
- **2-second live refresh** — `useMarketTick` hook polls bid/ask, BTC price, and portfolio every 2 seconds
- **Kalshi-style unified trade box** — single YES/NO card with live ask prices in the pill tabs, typeable quantity input, inline cost display
- **500-contract paper trades** — risk manager sizes paper positions at 500 contracts (Kelly floor)
- **Auto-run on load** — pipeline fires immediately on page load so signals appear without a manual trigger
- **Live + Paper mode** — toggle between real Kalshi order placement and simulated paper trading
- **Real-time 3-column dashboard** — market card + signal panel | BTC chart + ROMA pipeline visualizer | paper trade performance + trade log
- **Animated UI** — number count-up animations, shimmer bars, SVG countdown rings for expiry and cycle timer
- **RSA-PSS authentication** — proper Kalshi API signing with millisecond timestamps, correct padding and salt length
- **Kelly position sizing** — half-Kelly contract sizing derived from model edge and contract odds
- **Risk controls** — $150 daily loss limit · 15% max drawdown · 48 trades/day cap · 3% minimum edge threshold
- **Live Kalshi account panel** — balance, open positions, resting orders, recent fills, cancel buttons

---

## Getting Started

### Prerequisites

- Node.js 18+
- Python 3.10+ (for the roma-dspy microservice)
- A [Kalshi](https://kalshi.com) account with API access and RSA key pair from account settings
- API key for at least one LLM provider: [xAI](https://console.x.ai) · [Anthropic](https://console.anthropic.com) · [OpenAI](https://platform.openai.com) · [OpenRouter](https://openrouter.ai)
- A [CoinMarketCap Pro API key](https://pro.coinmarketcap.com)

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
AI_PROVIDER=grok          # anthropic | grok | openai | openrouter
ROMA_MODE=keen            # sharp | keen | smart  (default: keen)

XAI_API_KEY=xai-...       # required if AI_PROVIDER=grok
# ANTHROPIC_API_KEY=sk-ant-...      # required if AI_PROVIDER=anthropic
# OPENAI_API_KEY=sk-...             # required if AI_PROVIDER=openai
# OPENROUTER_API_KEY=sk-or-...      # required if AI_PROVIDER=openrouter
# OPENROUTER_MODEL=anthropic/claude-sonnet-4-6

# ── Model overrides (optional) ──────────────────────────────────────
GROK_FAST_MODEL=grok-3-mini
GROK_MID_MODEL=grok-3-fast
GROK_SMART_MODEL=grok-3

# ── Market Data ─────────────────────────────────────────────────────
CMC_API_KEY=your-coinmarketcap-key

# ── Kalshi ──────────────────────────────────────────────────────────
KALSHI_API_KEY=your-kalshi-api-key-id
KALSHI_PRIVATE_KEY_PATH=./kalshi_private_key.pem

# ── Python Service ───────────────────────────────────────────────────
PYTHON_ROMA_URL=http://localhost:8001
```

Place your Kalshi RSA private key at `./kalshi_private_key.pem` (already `.gitignore`d).

### Run

```bash
# Start both servers at once
./restart.sh

# Or manually:
# Terminal 1 — Python roma-dspy service
cd python-service && source .venv/bin/activate
python3 -m uvicorn main:app --port 8001 --host 0.0.0.0

# Terminal 2 — Next.js
npm run dev
# → http://localhost:3000
```

The pipeline fires automatically on page load. Hit **Run Cycle** to trigger a manual analysis. Use the **sharp / keen / smart** buttons to control model speed. Bid/ask and BTC price refresh every 2 seconds. Paper mode is the default — no real orders are placed unless you toggle Live Trading and confirm.

---

## Project Structure

```
├── app/
│   ├── api/
│   │   ├── pipeline/route.ts       # ROMA pipeline endpoint (maxDuration: 180s)
│   │   ├── btc-price/              # CoinMarketCap BTC price proxy
│   │   ├── markets/                # Kalshi market list proxy
│   │   ├── orderbook/[ticker]/     # Kalshi orderbook depth proxy
│   │   ├── place-order/            # Kalshi order placement
│   │   ├── balance/                # Kalshi account balance
│   │   ├── positions/              # Open positions + fills
│   │   └── cancel-order/[id]/      # Order cancellation
│   ├── globals.css                 # Design tokens + keyframe animations
│   └── page.tsx                    # 3-column dashboard + mode selector
│
├── lib/
│   ├── llm-client.ts               # Unified LLM interface — sharp/keen/smart tiers
│   ├── roma/
│   │   └── python-client.ts        # roma-dspy service client (callPythonRoma)
│   ├── agents/
│   │   ├── market-discovery.ts     # Kalshi KXBTC15M market scanner
│   │   ├── price-feed.ts           # CoinMarketCap BTC price + history
│   │   ├── sentiment.ts            # ROMA sentiment agent
│   │   ├── probability-model.ts    # ROMA probability agent
│   │   ├── risk-manager.ts         # Kelly sizing + deterministic risk rules
│   │   ├── execution.ts            # Order generation
│   │   └── index.ts                # 6-stage pipeline orchestrator
│   ├── kalshi-auth.ts              # RSA-PSS request signing
│   ├── kalshi-trade.ts             # Order placement / portfolio reads
│   └── types.ts                    # Shared TypeScript interfaces
│
├── components/
│   ├── AgentPipeline.tsx           # ROMA pipeline grid + loading animation
│   ├── MarketCard.tsx              # Live market data + unified TradeBox
│   ├── PriceChart.tsx              # BTC/USD area chart with strike price line
│   ├── SignalPanel.tsx             # Edge %, probability bars, sentiment meter
│   ├── PositionsPanel.tsx          # Live Kalshi account (live mode, 2s refresh)
│   ├── TradeLog.tsx                # Trade history with animated P&L rows
│   ├── PerformancePanel.tsx        # Paper trade performance — win rate, equity curve
│   ├── Header.tsx                  # Live/Paper toggle, SVG cycle ring, UTC clock
│   └── FloatingBackground.tsx      # CSS blobs + dot grid
│
├── hooks/
│   ├── usePipeline.ts              # 5-min polling, trade recording, settlement sim
│   ├── useMarketTick.ts            # 2-second bid/ask + BTC price + orderbook refresh
│   └── useCountUp.ts               # RAF ease-out number animation
│
└── python-service/
    ├── main.py                     # FastAPI wrapper for roma-dspy solve()
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

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `AI_PROVIDER` | Yes | `grok` \| `anthropic` \| `openai` \| `openrouter` |
| `ROMA_MODE` | No | `sharp` \| `keen` \| `smart` — default `keen` |
| `XAI_API_KEY` | If Grok | xAI API key |
| `ANTHROPIC_API_KEY` | If Claude | Anthropic API key |
| `OPENAI_API_KEY` | If OpenAI | OpenAI API key |
| `OPENROUTER_API_KEY` | If OpenRouter | OpenRouter API key |
| `OPENROUTER_MODEL` | If OpenRouter | Smart-tier model slug |
| `GROK_FAST_MODEL` | No | Override sharp-tier Grok model |
| `GROK_MID_MODEL` | No | Override keen-tier Grok model |
| `GROK_SMART_MODEL` | No | Override smart-tier Grok model |
| `CMC_API_KEY` | Yes | CoinMarketCap Pro API key |
| `KALSHI_API_KEY` | Yes | Kalshi API key ID (UUID) |
| `KALSHI_PRIVATE_KEY_PATH` | Yes | Path to RSA private key PEM |
| `PYTHON_ROMA_URL` | No | roma-dspy service URL (default `http://localhost:8001`) |

---

## Disclaimer

This project is for educational and research purposes. Paper trading is the default. Live trading places real orders with real money on a regulated prediction market exchange. Use live mode at your own risk. Nothing here is financial advice.

---

## License

MIT
