# Sentient — Autonomous BTC Prediction Market Trader

> **Live Kalshi algotrader with two fully independent execution paths: a Markov-gated quant pipeline and an autonomous Grok AI agent with full capital authority. All price data sourced exclusively from Coinbase Exchange — the same feed Kalshi settles against.**

![Next.js](https://img.shields.io/badge/Next.js_16-black?style=flat-square&logo=next.js)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)
![xAI Grok](https://img.shields.io/badge/xAI_Grok-000000?style=flat-square&logo=x&logoColor=white)
![Anthropic](https://img.shields.io/badge/Claude_Sonnet_4.6-D97706?style=flat-square&logo=anthropic&logoColor=white)
![OpenAI](https://img.shields.io/badge/GPT--4o-412991?style=flat-square&logo=openai&logoColor=white)
![OpenRouter](https://img.shields.io/badge/OpenRouter-6366F1?style=flat-square)
![Kalshi](https://img.shields.io/badge/Kalshi_API-1a1a2e?style=flat-square)
![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)

---

## What It Does

Sentient connects to [Kalshi](https://kalshi.com)'s live **KXBTC15M** and **KXBTCD** prediction markets — binary YES/NO contracts that resolve based on whether BTC's price is higher at the end of each 15-minute or 1-hour window — and runs an autonomous agent pipeline to analyze the market and place trades.

Two fully independent execution modes:

### Quant Mode (default)

Continuous scanning. A Markov chain momentum model acts as a hard regime gate — if momentum isn't locked-in and directionally decisive, no LLM calls are made and no trade is placed. When the gate passes, the full multi-agent pipeline runs:

1. **MarketDiscovery** — scans Kalshi for the active KXBTC15M window, extracts strike price and time to expiry
2. **PriceFeed** — live BTC/USD from Coinbase Exchange, 1h momentum computed from candle history
3. **Markov Gate** — 9-state 1-min momentum model; Chapman-Kolmogorov propagation; requires ≥80% momentum persistence and ≥65% directional confidence to proceed
4. **SentimentAgent** — ROMA multi-agent solve via the roma-dspy Python service; supports multi-provider ensemble
5. **ProbabilityModelAgent** — ROMA recursive solve with Cornish-Fisher skew-adjusted binary model, fat-tail Student-t fallback, Garman-Klass vol, multi-timeframe trend alignment (1h + 4h)
6. **ExecutionAgent** — BUY YES / BUY NO / PASS signal; fires only when Markov and Probability agree on direction

### AI Mode (Grok)

Stages 3–6 are replaced by a **single Grok AI agent** that receives the full market picture — candles across 1m/15m/1h/4h timeframes, orderbook, derivatives, Markov momentum signal, live session state — and makes ALL decisions autonomously:

- Direction (YES or NO)
- Probability estimate
- Position size (full capital authority, quarter-Kelly suggested)
- Optional hedge leg

In AI mode, Markov is **advisory context** passed to Grok — not a hard gate. Grok weighs it alongside all other signals and has final decision authority.

Hard session circuit breakers (daily loss limit, trade count cap) are enforced before the Grok call regardless.

### KXBTCD Hourly Mode

A separate dashboard for Kalshi's **KXBTCD** hourly BTC prediction markets. Grok must first predict where BTC will trade at the end of the hour, then bet the correct side. Multi-timeframe trend (4h → 1h → 15m) drives the prediction; Markov provides supporting momentum context.

---

## Markov Chain Engine

The Markov agent is the core momentum signal. It is genuinely predictive: "given current 1-min momentum, will BTC close above or below the strike?"

**State space:** 9 bins of 1-min BTC % price changes (large down → large up).

**Prediction method:** Chapman-Kolmogorov propagation over T minutes, then Gaussian approximation of cumulative drift to compute P(YES) and P(NO).

**Gate thresholds (quant mode):**
- Momentum persistence (`τ`) ≥ 80% — the dominant momentum state must self-reinforce
- Directional gap ≥ 15pp from 50% — model must be ≥65% confident

**Sizing:** Quarter-Kelly using Markov's P(win), scaled inversely by Garman-Klass vol. Sizing is owned by the server agent (not Markov output) and is computed from the configured Kelly bankroll.

**History:** Minimum 20 transitions before trusting the matrix. Seeded from 1-min live candles; falls back to 15-min candles.

---

## Price Feed

All BTC price and candle data comes exclusively from **Coinbase Exchange** (`api.exchange.coinbase.com`) — the same source Kalshi uses to settle KXBTC15M contracts.

| Granularity | Endpoint | Used For |
|---|---|---|
| Spot ticker | `/products/BTC-USD/ticker` | Live BTC price |
| 1-min candles | `/candles?granularity=60` | Markov momentum states |
| 15-min candles | `/candles?granularity=900` | GK vol, d-score, indicators |
| 1h candles | `/candles?granularity=3600` | Intraday trend (trend1h) |
| 4h candles | `/candles?granularity=14400` | Macro trend (trend4h) |

---

## Quant Signal Model

| Signal | Role |
|---|---|
| **Markov momentum** | Primary regime gate — must pass before any LLM calls |
| **Garman-Klass vol** | Intrabar vol estimator; scales position size inversely |
| **Cornish-Fisher skew-adjusted binary** | LLM-stage probability anchor; adjusts d2 for realized skew/kurtosis |
| **Student-t fat-tail fallback** (ν=4) | When skew/kurt unavailable |
| **Brownian prior fallback** | Final probability fallback |
| **Trend alignment** | When 1h and 4h both agree with BTC's position, boosts pModel +7pp |
| **Direction agreement gate** | Execution fires only when Markov and Probability agree on YES/NO |

---

## Risk Management

| Parameter | Value |
|---|---|
| Sizing | Quarter-Kelly (0.25×) from configured bankroll |
| Vol scalar | Inverse GK vol, clamped [0.3, 1.5] |
| Max trade size | 15% of portfolio |
| Max contracts | 500 |
| Maker fee | 1.75% × P × (1-P) per contract |
| Daily loss limit | max(5% portfolio, $50), capped $150 |
| Max trades/day | 48 |
| Min time before close | 2 min (stale pipeline guard) |
| Scan start | 14 min before close (~1 min into each 15-min window) |
| Scan interval | Every 5s (Markov pipeline) |

**Order execution:** All orders are placed as **IOC (immediate-or-cancel)**. Two attempts: ask+3¢ then ask+5¢. Fills at best available or cancels.

**Error recovery:** Pipeline errors retry in 5 seconds (not minutes) to avoid missing windows. Displayed as "Pipeline error — retrying" not "Next window in X:XX".

---

## Architecture

```
┌───────────────────────────────────────────────────────────────────┐
│                      SENTIENT PIPELINE                            │
├───────────────────────────────────────────────────────────────────┤
│                                                                   │
│  Coinbase Exchange ──► BTC spot + 1m/15m/1h/4h candles           │
│  Kalshi API ─────────► KXBTC15M/KXBTCD market + orderbook        │
│  Bybit ──────────────► BTC perp funding rate + basis             │
│                                                                   │
│  Stage 1 · MarketDiscovery     (rule-based)                      │
│  Stage 2 · PriceFeed           (rule-based)                      │
│  Stage 2.5 · Markov Gate       (Chapman-Kolmogorov momentum)     │
│                    │                                              │
│                    ├─ [quant: blocked] ─► NO_TRADE (no LLM calls)│
│                    │                                              │
│  ┌─── QUANT MODE (gate passed) ────────────────────────────────┐  │
│  │  Stage 3 · SentimentAgent      (ROMA — roma-dspy)           │  │
│  │  Stage 4 · ProbabilityModel    (ROMA — Cornish-Fisher)      │  │
│  │  Stage 5 · ExecutionAgent      (fires if Markov + Prob      │  │
│  │                                  agree on direction)        │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                          ── or ──                                 │
│  ┌─── AI MODE ─────────────────────────────────────────────────┐  │
│  │  Grok Agent (stages 3-5 unified)                            │  │
│  │    Full candle context: 1m · 15m · 1h · 4h                  │  │
│  │    Markov signal (advisory) · orderbook · derivatives        │  │
│  │    Full capital authority — direction + size + hedge         │  │
│  │    Hard circuit breakers enforced before call               │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                   │
│  Server Agent: scans every 5s · starts 14 min before close       │
│  Error retry: 5s · gap between windows: ~1 min                   │
└───────────────────────────────────────────────────────────────────┘
```

---

## What is ROMA?

**ROMA (Recursive Open Meta-Agent)** is an open-source multi-agent reasoning framework by [Sentient Foundation](https://github.com/sentient-agi/ROMA). Instead of sending one prompt and hoping for a coherent answer, ROMA breaks a complex goal into sub-problems, solves them in parallel across independent Executor agents, and synthesizes the results.

```
Goal
 └─ Atomizer — atomic or needs decomposing?
      ├─ [atomic]  → Executor answers directly
      └─ [complex] → Planner generates 3–5 subtasks
                       → Executors run all in parallel
                       → Aggregator synthesizes result
```

Used in the Quant pipeline for Sentiment and Probability stages when the Markov gate passes. In AI mode, Grok replaces ROMA entirely.

### Key Lesson: `max_depth=0` = Unlimited Recursion

`max_depth=0` in roma-dspy is **not "atomic"** — it is interpreted as "no depth limit." A pipeline that was supposed to make 5–7 LLM calls instead recursed to depth 5 and made 40+ calls (wall time: 3m40s). Always use `ROMA_MAX_DEPTH=1`. A `Math.max(1, ...)` guard prevents zero from ever reaching the SDK.

---

## Provider Support

Switch the entire pipeline with one env var:

| Tier | Grok | Claude | GPT | OpenRouter |
|---|---|---|---|---|
| blitz | `grok-4-1-fast-non-reasoning` | `claude-haiku-4-5-20251001` | `gpt-4o-mini` | any model |
| sharp | `grok-3-mini-fast` | `claude-haiku-4-5-20251001` | `gpt-4o-mini` | any model |
| keen | `grok-3` | `claude-haiku-4-5-20251001` | `gpt-4o-mini` | any model |
| smart | `grok-4-0709` | `claude-sonnet-4-6` | `gpt-4o` | any model |

The **Provider Split Config** lets you route different pipeline stages to different providers simultaneously. Multi-provider ensemble for Sentiment runs parallel ROMA solves; answers are merged before passing to Probability.

---

## Autonomous Agent

The server-side agent (`lib/server-agent.ts`) runs entirely in Node.js — immune to browser tab throttling.

- **Scans continuously** — Markov pipeline every 5s starting 14 min before each window's close
- **Fast-path IOC entry** — `fastEntry()` places an order in ~5s when momentum triggers, before the full pipeline completes
- **Kelly auto-compounding** — bankroll updates after each settled trade; allowance = bankroll × kellyPct
- **Error recovery** — pipeline errors retry in 5s; phase shows "Pipeline error — retrying" not a fake countdown
- **Phases:** idle → waiting → bootstrap → monitoring → pipeline → bet_placed / pass_skipped / order_failed / error
- **Persistence** — state and trade log survive HMR and cold starts via Vercel KV (with local file fallback)

---

## Tech Stack

| Layer | Tech |
|---|---|
| **Framework** | Next.js 16 App Router (React 19) |
| **Language** | TypeScript (strict) |
| **AI — Grok** | xAI Grok-3 / Grok-4 family via `openai` SDK (custom baseURL) |
| **AI — Claude** | Anthropic claude-sonnet-4-6 / claude-haiku-4-5 via `@anthropic-ai/sdk` |
| **AI — GPT** | OpenAI gpt-4o / gpt-4o-mini via `openai` SDK |
| **AI — OpenRouter** | Any model via OpenRouter API |
| **Multi-Agent** | Official Sentient `roma-dspy` Python SDK via FastAPI microservice |
| **Momentum Model** | Markov chain — 9-state 1-min price change bins, Chapman-Kolmogorov propagation |
| **Prediction Markets** | Kalshi Trade API v2 (KXBTC15M · KXBTCD series) |
| **Price Data** | Coinbase Exchange exclusively (`api.exchange.coinbase.com`) |
| **Derivatives** | Bybit perp funding rate + basis |
| **Auth** | RSA-PSS request signing (`crypto.createSign`) for Kalshi |
| **Session State** | Vercel KV — daily P&L, trade count, bankroll persist across cold starts |
| **Charts** | Recharts |
| **Styling** | CSS design tokens |

---

## Getting Started

### Prerequisites

- Node.js 18+
- Python 3.10+ (for the roma-dspy microservice — use a venv **outside** the Next.js project dir to avoid Turbopack symlink issues)
- A [Kalshi](https://kalshi.com) account with API access and RSA key pair
- API key for at least one LLM provider: [xAI](https://console.x.ai) · [Anthropic](https://console.anthropic.com) · [OpenAI](https://platform.openai.com) · [OpenRouter](https://openrouter.ai)

### Install

```bash
git clone https://github.com/Julian-dev28/sentient-market-reader.git
cd sentient-market-reader
npm install

# Set up the Python roma-dspy service (venv outside project root)
python3 -m venv ~/.sentient-venv
source ~/.sentient-venv/bin/activate
pip install -r python-service/requirements.txt
```

### Configure

```env
# .env.local

# ── LLM Provider ─────────────────────────────────────────────────
AI_PROVIDER=grok          # anthropic | grok | openai | openrouter
ROMA_MODE=keen            # blitz | sharp | keen | smart
ROMA_MAX_DEPTH=1          # NEVER set 0 — means unlimited recursion in roma-dspy

XAI_API_KEY=xai-...
# ANTHROPIC_API_KEY=sk-ant-...
# OPENAI_API_KEY=sk-...
# OPENROUTER_API_KEY=sk-or-...

# ── Kalshi ───────────────────────────────────────────────────────
KALSHI_API_KEY=your-kalshi-api-key-id
KALSHI_PRIVATE_KEY_PATH=./kalshi_private_key.pem

# ── Python Service ───────────────────────────────────────────────
PYTHON_ROMA_URL=http://localhost:8001
```

Place your Kalshi RSA private key at `./kalshi_private_key.pem` (already `.gitignore`d).

### Run

```bash
# Terminal 1 — Python roma-dspy service
source ~/.sentient-venv/bin/activate
cd python-service && python3 -m uvicorn main:app --port 8001 --host 0.0.0.0

# Terminal 2 — Next.js
npm run dev
# → http://localhost:3000
```

> **Important:** `python3 main.py` does nothing (no `__main__` block). Always use `uvicorn`.

Open `/dashboard` for the 15-min pipeline, `/dashboard/hourly` for the KXBTCD 1h market, or `/agent` for the autonomous agent. Paper mode is the default — no real orders until you toggle Live Trading and start the agent.

---

## Project Structure

```
├── app/
│   ├── api/
│   │   ├── pipeline/route.ts         # Main pipeline endpoint + SSE stream
│   │   ├── agent/                    # Agent start/stop/state/stream
│   │   ├── place-order/              # Kalshi IOC order placement
│   │   ├── market-quote/[ticker]/    # Fresh quote fetch (staleness gate)
│   │   ├── balance/                  # Kalshi account balance
│   │   └── orders/                   # Order history
│   ├── dashboard/page.tsx            # 15-min KXBTC15M dashboard
│   ├── dashboard/hourly/page.tsx     # 1h KXBTCD dashboard
│   └── agent/page.tsx                # Autonomous agent panel
│
├── lib/
│   ├── agents/
│   │   ├── markov.ts                 # Markov chain agent — momentum gate + sizing
│   │   ├── grok-trading-agent.ts     # AI mode — unified Grok agent (stages 3-5)
│   │   ├── market-discovery.ts       # Kalshi KXBTC15M/KXBTCD scanner
│   │   ├── price-feed.ts             # BTC price + distance from strike
│   │   ├── sentiment.ts              # ROMA sentiment (multi-provider ensemble)
│   │   ├── probability-model.ts      # ROMA probability + trend alignment
│   │   ├── execution.ts              # Order generation
│   │   └── index.ts                  # Pipeline orchestrator — Markov gate + quant/AI branch
│   ├── markov/
│   │   ├── chain.ts                  # Transition matrix, Chapman-Kolmogorov, Gaussian forecast
│   │   └── history.ts                # Per-market momentum history (15m / 1h keys)
│   ├── server-agent.ts               # Autonomous server-side agent (singleton)
│   ├── agent-shared.ts               # AgentPhase type + shared constants
│   ├── indicators.ts                 # GK vol, Cornish-Fisher, RSI, MACD, d-score, quant signals
│   ├── llm-client.ts                 # Unified LLM interface — all providers + tiers
│   ├── kalshi-auth.ts                # RSA-PSS request signing
│   ├── kalshi-trade.ts               # placeOrder, getBalance, getPositions
│   └── types.ts                      # Shared TypeScript interfaces
│
├── components/
│   ├── AgentPipeline.tsx             # Live pipeline grid with streaming agent results
│   ├── AgentAllowancePanel.tsx       # Agent start/stop, Kelly config, Momentum Monitor
│   ├── MarkovPanel.tsx               # Markov state + transition matrix visualizer
│   ├── MarketCard.tsx                # Live Kalshi market + orderbook
│   ├── SignalPanel.tsx               # Edge %, probability bars, sentiment meter
│   ├── PriceChart.tsx                # BTC/USD area chart with strike line
│   └── TradeLog.tsx                  # Trade history with P&L
│
└── python-service/
    ├── main.py                       # FastAPI — roma-dspy solve() wrapper
    ├── run_backtest.py               # Quant backtest (30-day, live Kalshi data)
    └── requirements.txt
```

---

## Kalshi API Notes

- **Base URL:** `https://api.elections.kalshi.com/trade-api/v2/`
- **Auth headers:** `KALSHI-ACCESS-KEY` · `KALSHI-ACCESS-TIMESTAMP` (milliseconds) · `KALSHI-ACCESS-SIGNATURE`
- **Signature payload:** `{timestampMs}{METHOD}{path}` — direct concat, no separators, no query params in path
- **RSA padding:** `RSA_PKCS1_PSS_PADDING` with `RSA_PSS_SALTLEN_DIGEST`
- **Market discovery:** `?event_ticker=KXBTC15M-{YY}{MON}{DD}{HHMM}` in US Eastern Time
- **Active markets:** `yes_ask > 0`; `floor_strike` = BTC price to beat; use `close_time` for countdown
- **Trading hours:** ~11:30 AM – midnight ET weekdays
- **Order type:** Always `time_in_force: immediate_or_cancel` — GTC orders fill at stale prices
- **NO orders:** Send `no_price` directly — do not complement to `yes_price`

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `AI_PROVIDER` | Yes | `grok` \| `anthropic` \| `openai` \| `openrouter` |
| `ROMA_MODE` | No | `blitz` \| `sharp` \| `keen` \| `smart` — default `keen` |
| `ROMA_MAX_DEPTH` | No | ROMA decomposition depth — default `1`; **never set `0`** |
| `XAI_API_KEY` | If Grok | xAI API key |
| `ANTHROPIC_API_KEY` | If Claude | Anthropic API key |
| `OPENAI_API_KEY` | If OpenAI | OpenAI API key |
| `OPENROUTER_API_KEY` | If OpenRouter | OpenRouter API key |
| `KALSHI_API_KEY` | Yes | Kalshi API key ID (UUID) |
| `KALSHI_PRIVATE_KEY_PATH` | Yes | Path to RSA private key PEM |
| `PYTHON_ROMA_URL` | No | roma-dspy service URL (default `http://localhost:8001`) |
| `KV_REST_API_URL` | If Vercel | Vercel KV URL for session state persistence |
| `KV_REST_API_TOKEN` | If Vercel | Vercel KV token |

---

## Disclaimer

This project is for educational and research purposes. Paper trading is the default. Live trading places real orders with real money on a regulated prediction market exchange. Use live mode at your own risk. Nothing here is financial advice.

---

## License

MIT
