# Sentient — Autonomous BTC Prediction Market Trader

> **Live Kalshi algotrader with two fully independent execution paths: a deterministic quant pipeline (ROMA multi-agent) and an autonomous Grok AI agent with full capital authority. All price data sourced exclusively from Coinbase Exchange — the same feed Kalshi settles against.**

![Next.js](https://img.shields.io/badge/Next.js_16-black?style=flat-square&logo=next.js)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)
![xAI Grok](https://img.shields.io/badge/xAI_Grok-000000?style=flat-square&logo=x&logoColor=white)
![Anthropic](https://img.shields.io/badge/Claude_Sonnet_4.6-D97706?style=flat-square&logo=anthropic&logoColor=white)
![OpenAI](https://img.shields.io/badge/GPT--4o-412991?style=flat-square&logo=openai&logoColor=white)
![HuggingFace](https://img.shields.io/badge/HuggingFace-FFD21E?style=flat-square&logo=huggingface&logoColor=black)
![OpenRouter](https://img.shields.io/badge/OpenRouter-6366F1?style=flat-square)
![Kalshi](https://img.shields.io/badge/Kalshi_API-1a1a2e?style=flat-square)
![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)

---

## What It Does

Sentient connects to [Kalshi](https://kalshi.com)'s live **KXBTC15M** prediction markets — binary YES/NO contracts that resolve based on whether BTC's price is higher at the end of each 15-minute window — and runs an autonomous agent pipeline to analyze the market and place trades.

Two fully independent execution modes:

### Quant Mode (default)
Fixed 5-minute clock. Deterministic pipeline runs every cycle:
1. **MarketDiscovery** — scans Kalshi for the active KXBTC15M window, extracts strike price and time to expiry
2. **PriceFeed** — live BTC/USD from Coinbase Exchange, 1h momentum computed from candle history
3. **SentimentAgent** — ROMA multi-agent solve via the roma-dspy Python service; supports multi-provider ensemble
4. **ProbabilityModelAgent** — ROMA recursive solve with Cornish-Fisher skew-adjusted binary model, fat-tail Student-t fallback, Garman-Klass vol, d-score gate, multi-timeframe trend alignment (1h + 4h)
5. **RiskManagerAgent** — deterministic Kelly-based position sizing: quarter-Kelly × vol-scalar × confidence-scalar, capped at 15% of portfolio
6. **ExecutionAgent** — BUY YES / BUY NO / PASS signal; places live Kalshi IOC order when bot is active

### AI Mode (Grok)
Event-driven, triggered on significant BTC price moves. Stages 3–6 are replaced by a **single Grok AI agent** that receives the full market picture — candles across 1m/15m/1h/4h timeframes, orderbook, derivatives, live session state — and makes ALL decisions autonomously:
- Direction (YES or NO)
- Probability estimate
- Position size (full capital authority — no Kelly cap, no d-gate)
- Optional hedge leg

Hard session circuit breakers (daily loss limit, trade count cap) are enforced before the Grok call regardless.

The AI mode watcher fires every 15 seconds, triggers a cycle when:
- BTC moves ≥ 0.20% from the last cycle price
- BTC crosses the strike price (flip)
- 5 minutes have elapsed since the last run (stale fallback)

---

## Price Feed

All BTC price and candle data comes exclusively from **Coinbase Exchange** (`api.exchange.coinbase.com`) — the same source Kalshi uses to settle KXBTC15M contracts. No Binance, no aggregated consumer APIs.

| Granularity | Endpoint | Used For |
|---|---|---|
| Spot ticker | `/products/BTC-USD/ticker` | Live BTC price |
| 1-min candles | `/candles?granularity=60` | Velocity + reachability gate |
| 15-min candles | `/candles?granularity=900` | GK vol, d-score, indicators |
| 1h candles | `/candles?granularity=3600` | Intraday trend (trend1h) |
| 4h candles | `/candles?granularity=14400` | Macro trend (trend4h) |

---

## Quant Signal Model

The quant probability model mirrors the live Kalshi market microstructure:

- **Garman-Klass vol** — intrabar vol estimator; scales position size inversely (high vol → smaller size)
- **Cornish-Fisher skew-adjusted binary** — primary anchor; adjusts Black-Scholes d2 for realized skew and excess kurtosis
- **Student-t fat-tail fallback** (ν=4) — when skew/kurt unavailable
- **Brownian prior fallback** — final fallback
- **D-score gate** — only trades when |d| ∈ [1.0, 1.2], the confirmed positive-expectation zone from 2,690 live fills analysis
- **Trend alignment override** — when 1h and 4h trends both agree with BTC's position relative to strike, bypasses the d-gate and boosts pModel by +7pp
- **Direction lock** — always bets the side BTC currently sits on (above strike → YES, below → NO)
- **Reachability gate** — hard override when velocity and distance make strike unreachable in time remaining

---

## Risk Management

All parameters validated against a 787-trade live backtest.

| Parameter | Value | Source |
|---|---|---|
| Sizing | Quarter-Kelly (0.25×) | Backtest: MaxDD 13.3%, WR 92.2% |
| Vol scalar | Inverse GK vol, clamped [0.3, 1.5] | High vol → smaller size |
| Confidence scalar | high=1.0, medium=0.8, low=0.5 | ROMA confidence output |
| Max trade size | 15% of portfolio | Hard cap |
| Max contracts | 500 | Hard cap |
| Entry price range | 72¢–92¢ | Below 72¢: near-50/50. Above 92¢: fee eats >12% margin |
| Min edge | 5% after fees | Maker fee: 1.75% × P × (1-P) |
| Daily loss limit | max(5% portfolio, $50, capped $150) | Hard stop |
| Session giveback | 1.5× daily loss limit from peak | Drawdown from session peak |
| Max trades/day | 48 | ~1 per 15-min window |
| Blocked UTC hours | 11:00, 18:00 | Empirically -40 to -57pp margin |
| Entry window | 3–9 min before close | Outside this: signal not settled or too late |

**Order execution:** All orders are placed as **IOC (immediate-or-cancel)**. Fills at the current best-ask or cancels instantly — no resting GTC orders accumulating in the book.

**Staleness gate:** If the fresh market quote has moved more than 20¢ from the analyzed price during the pipeline run (~90s for AI mode), the order is skipped.

---

## Architecture

```
┌───────────────────────────────────────────────────────────────────┐
│                      SENTIENT PIPELINE                            │
├───────────────────────────────────────────────────────────────────┤
│                                                                   │
│  Coinbase Exchange ──► BTC spot + 1m/15m/1h/4h candles           │
│  Kalshi API ─────────► KXBTC15M market + orderbook               │
│  Bybit ──────────────► BTC perp funding rate + basis             │
│                                                                   │
│  Stage 1 · MarketDiscoveryAgent   (rule-based)                   │
│  Stage 2 · PriceFeedAgent         (rule-based)                   │
│                                                                   │
│  ┌─── QUANT MODE ──────────────────────────────────────────────┐  │
│  │  Stage 3 · SentimentAgent      (ROMA — roma-dspy)           │  │
│  │  Stage 4 · ProbabilityModel    (ROMA — Cornish-Fisher +     │  │
│  │                                  d-gate + trend override)   │  │
│  │  Stage 5 · RiskManager         (deterministic Kelly)        │  │
│  │  Stage 6 · ExecutionAgent      (IOC order or PASS)          │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                          ── or ──                                 │
│  ┌─── AI MODE ─────────────────────────────────────────────────┐  │
│  │  Grok Agent (stages 3-6 unified)                            │  │
│  │    Full candle context: 1m · 15m · 1h · 4h                  │  │
│  │    Orderbook depth · derivatives · session state            │  │
│  │    Full capital authority — direction + size + hedge         │  │
│  │    Hard circuit breakers enforced before call               │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                   │
│  Triggered by:                                                    │
│    Quant — fixed 5-min clock                                      │
│    AI — BTC move ≥0.20% · strike cross · 5-min stale fallback    │
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

Used in the Quant pipeline for Sentiment and Probability stages. The Python FastAPI microservice (`python-service/`) runs genuine ROMA solves via the official `roma-dspy` SDK and returns structured results to Next.js.

> **Note:** In AI mode, Grok replaces ROMA entirely. ROMA is still used in Quant mode.

### Key Lesson: `max_depth=0` = Unlimited Recursion

`max_depth=0` in roma-dspy is **not "atomic"** — it is interpreted as "no depth limit." A pipeline that was supposed to make 5–7 LLM calls instead recursed to depth 5 and made 40+ calls (wall time: 3m40s instead of ~15s). Always use `ROMA_MAX_DEPTH=1` for live trading. A `Math.max(1, ...)` guard prevents zero from ever reaching the SDK.

---

## Provider Support

Switch the entire pipeline with one env var. All model tiers remap automatically:

| Tier | Grok | Claude | GPT | HuggingFace |
|---|---|---|---|---|
| blitz | `grok-4-1-fast-non-reasoning` | `claude-haiku-4-5-20251001` | `gpt-4o-mini` | `Qwen2.5-1.5B` |
| sharp | `grok-3-mini-fast` | `claude-haiku-4-5-20251001` | `gpt-4o-mini` | `Llama-3.2-3B` |
| keen | `grok-3` | `claude-haiku-4-5-20251001` | `gpt-4o-mini` | `Llama-3.1-8B` |
| smart | `grok-4-0709` | `claude-sonnet-4-6` | `gpt-4o` | `Llama-3.3-70B` |

The **Provider Split Config** lets you route different pipeline stages to different providers simultaneously — eliminating inter-stage rate-limit pauses. Multi-provider ensemble for Sentiment runs parallel ROMA solves across N providers; answers are merged before passing to Probability.

---

## Trading Bot

The **BotPanel** runs the pipeline autonomously and places live Kalshi orders when the agent approves a trade.

- **Paper mode** (default) — simulates trades, tracks P&L, no real money
- **Live mode** — places real Kalshi IOC orders using your RSA API key
- **Mode toggle** — Quant (5-min clock) or AI (event-driven delta monitor)
- **Safety gate** — manual "Run Cycle" clicks never place real orders; only the active bot does
- **IOC execution** — orders fill immediately at best-ask or cancel; no resting GTC accumulation
- **Staleness gate** — orders skipped if market moved >20¢ during the pipeline run

---

## Tech Stack

| Layer | Tech |
|---|---|
| **Framework** | Next.js 16 App Router (React 19) |
| **Language** | TypeScript (strict) |
| **AI — Grok** | xAI Grok-3 / Grok-4 family via `openai` SDK (custom baseURL) |
| **AI — Claude** | Anthropic claude-sonnet-4-6 / claude-haiku-4-5 via `@anthropic-ai/sdk` |
| **AI — GPT** | OpenAI gpt-4o / gpt-4o-mini via `openai` SDK |
| **AI — HuggingFace** | Llama / Qwen via HF serverless Inference API (OpenAI-compatible) |
| **AI — OpenRouter** | Any model via OpenRouter API |
| **Multi-Agent** | Official Sentient `roma-dspy` Python SDK via FastAPI microservice |
| **Prediction Markets** | Kalshi Trade API v2 (KXBTC15M series) |
| **Price Data** | Coinbase Exchange exclusively (`api.exchange.coinbase.com`) |
| **Derivatives** | Bybit perp funding rate + basis (DerivativesSignal) |
| **Auth** | RSA-PSS request signing (`crypto.createSign`) for Kalshi |
| **Session State** | Vercel KV — daily P&L, trade count, drawdown persist across cold starts |
| **Charts** | Recharts |
| **Styling** | CSS design tokens |

---

## Getting Started

### Prerequisites

- Node.js 18+
- Python 3.10+ (for the roma-dspy microservice — use a venv **outside** the Next.js project dir to avoid Turbopack symlink issues)
- A [Kalshi](https://kalshi.com) account with API access and RSA key pair
- API key for at least one LLM provider: [xAI](https://console.x.ai) · [Anthropic](https://console.anthropic.com) · [OpenAI](https://platform.openai.com) · [HuggingFace](https://huggingface.co/settings/tokens) · [OpenRouter](https://openrouter.ai)

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
AI_PROVIDER=grok          # anthropic | grok | openai | huggingface | openrouter
ROMA_MODE=keen            # blitz | sharp | keen | smart
ROMA_MAX_DEPTH=1          # NEVER set 0 — means unlimited recursion in roma-dspy

XAI_API_KEY=xai-...
# ANTHROPIC_API_KEY=sk-ant-...
# OPENAI_API_KEY=sk-...
# HUGGINGFACE_API_KEY=hf_...
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

The pipeline fires on page load. Hit **▶ Run Cycle** for a manual analysis. Toggle **AI Mode** in the bot panel to switch from the 5-minute quant clock to the event-driven Grok agent. Paper mode is the default — no real orders are placed until you toggle Live Trading and start the bot.

---

## Project Structure

```
├── app/
│   ├── api/
│   │   ├── pipeline/route.ts         # Main pipeline endpoint — data fetch + SSE stream
│   │   ├── place-order/              # Kalshi IOC order placement
│   │   ├── market-quote/[ticker]/    # Fresh quote fetch (staleness gate)
│   │   ├── balance/                  # Kalshi account balance
│   │   ├── positions/                # Open positions + fills
│   │   ├── cancel-order/[id]/        # Order cancellation
│   │   ├── orders/                   # Order history
│   │   └── backtest/                 # Quant backtest endpoint
│   └── dashboard/page.tsx            # 3-column live dashboard
│
├── lib/
│   ├── agents/
│   │   ├── grok-trading-agent.ts     # AI mode — unified Grok agent (stages 3-6)
│   │   ├── market-discovery.ts       # Kalshi KXBTC15M scanner
│   │   ├── price-feed.ts             # BTC price + distance from strike
│   │   ├── sentiment.ts              # ROMA sentiment (multi-provider ensemble)
│   │   ├── probability-model.ts      # ROMA probability — d-gate + trend override
│   │   ├── risk-manager.ts           # Kelly sizing + session state + circuit breakers
│   │   ├── execution.ts              # Order generation
│   │   └── index.ts                  # Pipeline orchestrator — quant or AI mode
│   ├── indicators.ts                 # GK vol, Cornish-Fisher, RSI, MACD, trend, d-score
│   ├── llm-client.ts                 # Unified LLM interface — all providers + tiers
│   ├── kalshi-auth.ts                # RSA-PSS request signing
│   ├── kalshi-trade.ts               # placeOrder, getBalance, getPositions
│   ├── pipeline-lock.ts              # Concurrent run prevention + last-analysis context
│   └── types.ts                      # Shared TypeScript interfaces
│
├── components/
│   ├── AgentPipeline.tsx             # Live pipeline grid with streaming agent results
│   ├── BotPanel.tsx                  # Bot start/stop, mode toggle, session stats
│   ├── MarketCard.tsx                # Live Kalshi market + orderbook
│   ├── SignalPanel.tsx               # Edge %, probability bars, sentiment meter
│   ├── PriceChart.tsx                # BTC/USD area chart with strike line
│   ├── PositionsPanel.tsx            # Live Kalshi account (15s refresh)
│   └── TradeLog.tsx                  # Trade history with P&L
│
├── hooks/
│   ├── usePipeline.ts                # Pipeline runner — quant clock or AI delta monitor
│   └── useMarketTick.ts              # 2-second bid/ask + BTC price refresh
│
└── python-service/
    ├── main.py                       # FastAPI — roma-dspy solve() wrapper
    ├── run_backtest.py               # Agent-faithful quant backtest (30-day, live Kalshi data)
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
- **Order type:** Always use `time_in_force: immediate_or_cancel` — GTC orders sit in the book indefinitely and will fill at stale prices
- **NO orders:** Send `no_price` directly — do not complement to `yes_price`

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `AI_PROVIDER` | Yes | `grok` \| `anthropic` \| `openai` \| `huggingface` \| `openrouter` |
| `ROMA_MODE` | No | `blitz` \| `sharp` \| `keen` \| `smart` — default `keen` |
| `ROMA_MAX_DEPTH` | No | ROMA decomposition depth — default `1`; **never set `0`** |
| `XAI_API_KEY` | If Grok | xAI API key |
| `ANTHROPIC_API_KEY` | If Claude | Anthropic API key |
| `OPENAI_API_KEY` | If OpenAI | OpenAI API key |
| `HUGGINGFACE_API_KEY` | If HuggingFace | HuggingFace access token |
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
