# Sentient Market Reader

> **Live Kalshi prediction market algotrader powered by the Sentient GRID ROMA multi-agent framework and Claude AI.**

![Next.js](https://img.shields.io/badge/Next.js_16-black?style=flat-square&logo=next.js)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)
![Anthropic](https://img.shields.io/badge/Claude_Sonnet_4.6-D97706?style=flat-square&logo=anthropic&logoColor=white)
![Kalshi](https://img.shields.io/badge/Kalshi_API-1a1a2e?style=flat-square)
![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)

---

## What It Does

Sentient Market Reader connects to [Kalshi](https://kalshi.com)'s live KXBTC15M prediction markets — binary contracts that resolve YES/NO based on whether BTC's price is higher at the end of each 15-minute window — and uses a **Sentient GRID ROMA (Recursive Open Meta-Agent)** pipeline powered by Anthropic's Claude to autonomously analyze the market and decide whether to trade.

Every 5 minutes the system runs a full multi-agent reasoning loop:

1. Discovers the nearest open KXBTC15M market from Kalshi's API
2. Pulls live BTC/USD price data from CoinMarketCap
3. Hands everything to ROMA — which decomposes the trading question into parallel sub-analyses, executes them with Claude, and aggregates a unified market thesis
4. Applies deterministic Kelly-based risk controls
5. Optionally places a real Kalshi order (live mode) or logs a paper trade

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                  SENTIENT GRID · ROMA PIPELINE               │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌─────────────┐   ┌─────────────┐                          │
│  │   Kalshi    │   │CoinMarketCap│   External data sources  │
│  │  KXBTC15M   │   │  BTC/USD    │                          │
│  └──────┬──────┘   └──────┬──────┘                          │
│         └────────┬─────────┘                                │
│                  │                                           │
│  ┌───────────────▼───────────────────────────────────────┐  │
│  │              ROMA Recursive Solve Loop                │  │
│  │                                                       │  │
│  │  ◎ ATOMIZER (haiku) ──► "not atomic, decompose"       │  │
│  │         │                                             │  │
│  │  ◉ PLANNER (sonnet) ──► generates N subtasks          │  │
│  │         │                                             │  │
│  │  ▶ EXECUTORS (haiku) ── Promise.all ──►               │  │
│  │    ├─ "What does 1h BTC momentum signal?"             │  │
│  │    ├─ "What does Kalshi orderbook reveal?"            │  │
│  │    ├─ "P(BTC above strike) given time decay?"         │  │
│  │    └─ "Is there edge vs market-implied probability?"  │  │
│  │         │                                             │  │
│  │  ⬟ AGGREGATOR (sonnet) ──► unified market thesis      │  │
│  │         │                                             │  │
│  │  ◈ EXTRACTOR (sonnet) ──► structured JSON via tools   │  │
│  └───────────────┬───────────────────────────────────────┘  │
│                  │                                           │
│  ┌───────────────▼──────────────┐                           │
│  │       Risk Manager           │  Kelly sizing, daily      │
│  │  (deterministic, no LLM)     │  loss cap, drawdown limit │
│  └───────────────┬──────────────┘                           │
│                  │                                           │
│  ┌───────────────▼──────────────┐                           │
│  │       Execution Agent        │  Paper trade or live      │
│  │  (deterministic, no LLM)     │  Kalshi order via RSA-PSS │
│  └──────────────────────────────┘                           │
└──────────────────────────────────────────────────────────────┘
```

**Model routing by stage:**

| Stage | Model | Reason |
|---|---|---|
| Atomizer | `claude-haiku-4-5` | Fast binary decision gate |
| Planner | `claude-sonnet-4-6` | Domain reasoning for subtask design |
| Executors | `claude-haiku-4-5` | Parallel focused tasks, cost efficient |
| Aggregator | `claude-sonnet-4-6` | High-quality cross-signal synthesis |
| Extractor | `claude-sonnet-4-6` | Reliable structured output via tool use |

---

## Tech Stack

| Layer | Tech |
|---|---|
| **Framework** | Next.js 16 App Router (React 19) |
| **Language** | TypeScript (strict) |
| **AI** | Anthropic Claude — Sonnet 4.6 + Haiku 4.5 via `@anthropic-ai/sdk` |
| **Multi-Agent** | Custom ROMA engine (`lib/roma/`) — Atomizer → Planner → Executors → Aggregator |
| **Prediction Markets** | Kalshi Trade API v2 (KXBTC15M series) |
| **Price Data** | CoinMarketCap Pro API |
| **Auth** | RSA-PSS request signing (`crypto.createSign`) for Kalshi |
| **Charts** | Recharts |
| **Styling** | Tailwind CSS v4 + custom design tokens |

---

## ROMA: How the AI Pipeline Works

ROMA (Recursive Open Meta-Agent) is a multi-agent framework by [Sentient Foundation](https://github.com/sentient-agi/ROMA) that breaks complex goals into parallelizable subtasks, executes them independently, and aggregates results upward through the tree. This project implements ROMA's core architecture in TypeScript with Claude:

```
solve(goal, context):
  if atomizer.isAtomic(goal)  →  executor.run(goal)
  else:
    subtasks = planner.decompose(goal)
    results  = await Promise.all(subtasks.map(t => solve(t)))  // parallel
    return aggregator.synthesize(results)
```

**What each module does in the trading context:**

- **Atomizer** — classifies the trading goal as atomic or complex. Full market analysis always decomposes.
- **Planner** — Claude dynamically generates 3–5 independent analytical subtasks based on the live market snapshot (momentum signal, orderbook sentiment, probability estimate, edge assessment, etc.)
- **Executors** — each subtask runs in parallel via `Promise.all`. Haiku answers each focused question using the market context.
- **Aggregator** — Sonnet synthesizes all subtask answers into a unified market thesis with a calibrated P(YES) estimate and a YES/NO/NO\_TRADE recommendation.
- **Extractor** — a final structured output pass maps the qualitative ROMA analysis to typed `SentimentOutput` and `ProbabilityOutput` objects using forced tool use.

The Risk Manager and Execution Agent are intentionally **not LLM-powered** — safety-critical rules (Kelly sizing, daily loss cap, drawdown limits) should be deterministic and auditable.

---

## Features

- **Live ROMA pipeline** — genuine multi-agent AI reasoning on every cycle, not hardcoded heuristics or a sigmoid with magic constants
- **Live + Paper mode** — toggle between real Kalshi order placement and simulated paper trading, with confirmation modal
- **Real-time dashboard** — 3-column layout: market card + signal panel | BTC chart + ROMA pipeline | performance + trade log
- **ROMA loading animation** — staged pipeline visualizer (Atomize → Plan → Execute → Aggregate → Extract) with per-stage glow, flowing connector animations, elapsed timer, and rotating status messages
- **RSA-PSS authentication** — proper Kalshi API signing with millisecond timestamps, correct padding and salt length
- **Kelly position sizing** — half-Kelly contract sizing derived from model edge and contract odds
- **Risk controls** — $150 daily loss limit · 15% max drawdown · 48 trades/day cap · 3% minimum edge threshold
- **Live Kalshi account panel** — balance, open positions, resting orders, recent fills, cancel buttons
- **Manual trading** — BUY YES/NO with typeable contract quantity (1–500 contracts)

---

## Getting Started

### Prerequisites

- Node.js 18+
- A [Kalshi](https://kalshi.com) account with API access and an RSA key pair generated in your account settings
- An [Anthropic API key](https://console.anthropic.com)
- A [CoinMarketCap Pro API key](https://pro.coinmarketcap.com)

### Install

```bash
git clone https://github.com/yourusername/sentient-market-reader.git
cd sentient-market-reader
npm install
```

### Configure

```bash
cp .env.local.example .env.local
```

```env
ANTHROPIC_API_KEY=sk-ant-...
CMC_API_KEY=your-coinmarketcap-key
KALSHI_API_KEY=your-kalshi-api-key-id
KALSHI_PRIVATE_KEY_PATH=./kalshi_private_key.pem
```

Place your Kalshi RSA private key at `./kalshi_private_key.pem` (already `.gitignore`d).

### Run

```bash
npm run dev
# → http://localhost:3000
```

The pipeline runs its first ROMA cycle immediately on load. Subsequent cycles run every 5 minutes. Switch to **Paper** mode (default) to explore without placing real orders.

---

## Project Structure

```
├── app/
│   ├── api/
│   │   ├── pipeline/route.ts     # ROMA pipeline endpoint (maxDuration: 300s)
│   │   ├── place-order/          # Kalshi order placement
│   │   ├── balance/              # Kalshi account balance
│   │   ├── positions/            # Open positions + fills
│   │   └── cancel-order/[id]/    # Order cancellation
│   ├── globals.css               # Design system + keyframe animations
│   └── page.tsx                  # 3-column dashboard layout
│
├── lib/
│   ├── roma/                     # ROMA multi-agent engine
│   │   ├── atomizer.ts           # Claude (haiku): atomic or decompose?
│   │   ├── planner.ts            # Claude (sonnet): generate subtasks
│   │   ├── executor.ts           # Claude (haiku): execute atomic task
│   │   ├── aggregator.ts         # Claude (sonnet): synthesize results
│   │   ├── solve.ts              # Recursive solve loop w/ Promise.all
│   │   └── index.ts              # Trading wrapper + structured extraction
│   ├── agents/
│   │   ├── market-discovery.ts   # Kalshi KXBTC15M market scanner
│   │   ├── price-feed.ts         # CoinMarketCap BTC price + history
│   │   ├── risk-manager.ts       # Kelly sizing + deterministic risk rules
│   │   ├── execution.ts          # Order generation
│   │   └── index.ts              # 6-stage pipeline orchestrator
│   ├── kalshi-auth.ts            # RSA-PSS request signing
│   ├── kalshi-trade.ts           # Order placement / portfolio reads
│   ├── claude-client.ts          # Anthropic SDK singleton
│   └── types.ts                  # Shared TypeScript interfaces
│
├── components/
│   ├── AgentPipeline.tsx         # ROMA visualizer + staged loading animation
│   ├── MarketCard.tsx            # Live market data + BUY YES/NO
│   ├── PriceChart.tsx            # BTC/USD area chart w/ strike line
│   ├── SignalPanel.tsx           # Edge %, probability bars, sentiment meter
│   ├── PositionsPanel.tsx        # Live Kalshi account (live mode only)
│   ├── TradeLog.tsx              # Trade history w/ P&L
│   ├── PerformancePanel.tsx      # Win rate, equity curve
│   ├── Header.tsx                # Live/Paper toggle, cycle countdown
│   └── FloatingBackground.tsx   # CSS-only animated background
│
└── hooks/
    └── usePipeline.ts            # 5-min polling, trade recording, settlement
```

---

## Kalshi API Reference Notes

- **Base URL:** `https://api.elections.kalshi.com/trade-api/v2/`
- **Auth headers:** `KALSHI-ACCESS-KEY` · `KALSHI-ACCESS-TIMESTAMP` (milliseconds) · `KALSHI-ACCESS-SIGNATURE`
- **Signature payload:** `{timestampMs}{METHOD}{path}` — direct concat, no separators, no query params in path
- **RSA padding:** `RSA_PKCS1_PSS_PADDING` with `RSA_PSS_SALTLEN_DIGEST`
- **Market discovery:** query `?event_ticker=KXBTC15M-{YY}{MON}{DD}{HHMM}` in US Eastern time
- **Active markets:** `yes_ask > 0`; `floor_strike` = BTC price to beat; use `close_time` for countdown (not `expiration_time`)

---

## Environment Variables

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `CMC_API_KEY` | CoinMarketCap Pro API key |
| `KALSHI_API_KEY` | Kalshi API key ID (UUID from account settings) |
| `KALSHI_PRIVATE_KEY_PATH` | Relative path to RSA private key PEM |

---

## Disclaimer

This project is for educational and research purposes. Paper trading mode is the default. Live trading places real orders with real money on a regulated prediction market exchange. Use live mode at your own risk. Nothing here is financial advice.

---

## License

MIT
