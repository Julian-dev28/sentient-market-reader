# Sentient — Autonomous BTC Prediction Market Trader

> **Live Kalshi algotrader with three fully independent execution paths: a Markov-gated quant pipeline, an autonomous Grok AI agent, and a 24/7 Python trading daemon with a self-evolving research loop. All price data sourced exclusively from Coinbase Exchange — the same feed Kalshi settles against.**

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

Sentient connects to [Kalshi](https://kalshi.com)'s live **KXBTC15M** binary prediction markets — YES/NO contracts that resolve based on whether BTC's price is above or below a strike at each 15-minute window close — and runs an autonomous agent pipeline to analyze the market and place trades.

Three fully independent execution paths:

### 1. Trading Daemon (24/7 autonomous)

The core production execution engine. A standalone Python daemon that runs continuously, wakes up for every 15-minute Kalshi window, executes the full Markov signal stack, places real orders when the gates pass, and logs every decision to a daily file.

```bash
python3 python-service/trade_daemon.py
```

- Sleeps precisely until 12 min before each `:00/:15/:30/:45` ET window close
- Runs the full signal: Markov chain → Hurst → GK vol → timing → price cap → UTC block
- Golden zone logic: 65–73¢ windows (93%+ WR) get a wider 3–12 min entry window
- Tracks daily P&L, session giveback, and trade count in-memory; resets at midnight ET
- Checks settlement after each window closes and updates P&L
- `--dry-run` flag for simulation without real orders

### 2. Self-Evolving Research Loop

A nightly analysis engine that reads its own trade logs, runs a parameter ablation study, and calls Claude to write a research report with proposed improvements. If any variation beats the baseline by >5%, it creates a ready-to-merge git branch.

```bash
python3 python-service/research_loop.py
```

- Fetches 30 days of historical data once, then runs all backtest variations against the cache
- Ablation study: varies `MARKOV_MIN_GAP`, `MIN_PERSIST`, `MAX_ENTRY_PRICE_RM`, timing gates, vol/Hurst thresholds one at a time
- Parses `logs/daemon_*.log` for live settled trade performance
- Calls Claude Sonnet to analyze results, diagnose patterns, propose new signal ideas
- Writes a Markdown report to `python-service/research/YYYY-MM-DD.md`
- Creates a `research/proposed-*` git branch with param changes if improvement is significant

**The self-evolution loop:**
```
trade_daemon (always running)
      ↓  produces trade logs
research_loop (nightly)
      ↓  ablation + Claude analysis + proposed branch
you review & merge
      ↓
trade_daemon restarts with improved params
```

### 3. Claude Code MCP Integration

The full trading engine is exposed as an MCP server that Claude Code can call directly. Type `/trade` in any Claude Code session and Claude autonomously checks the market, runs the signal, and places a real order if gates pass.

```bash
# MCP server auto-starts when Claude Code loads
# In Claude Code terminal:
/trade
```

Seven tools available to Claude: `get_market`, `analyze_signal`, `place_trade`, `get_balance`, `get_positions`, `cancel_order`, `run_backtest`.

---

## Web Dashboard (Next.js)

The Next.js app provides a live monitoring UI and a second execution path via the ROMA multi-agent pipeline.

### Quant Mode

A Markov chain momentum model acts as a hard regime gate — if momentum isn't locked-in and directionally decisive, no LLM calls are made and no trade is placed. When the gate passes:

1. **MarketDiscovery** — scans Kalshi for the active KXBTC15M window
2. **PriceFeed** — live BTC/USD from Coinbase Exchange
3. **Markov Gate** — 9-state 1-min momentum model; requires ≥82% persistence and ≥61% directional confidence
4. **SentimentAgent** — ROMA multi-agent solve via the roma-dspy Python service
5. **ProbabilityModelAgent** — ROMA recursive solve with Cornish-Fisher skew-adjusted binary model
6. **ExecutionAgent** — fires only when Markov and Probability agree on direction

### AI Mode (Grok)

Stages 3–6 are replaced by a **single Grok AI agent** that receives the full market picture — candles across 1m/15m/1h/4h timeframes, Markov momentum signal, live session state — and makes ALL decisions autonomously: direction, probability, position size, optional hedge.

### KXBTCD Hourly Mode

A separate dashboard for Kalshi's **KXBTCD** hourly BTC prediction markets. Multi-timeframe trend (4h → 1h → 15m) drives the prediction; Markov provides supporting momentum context.

---

## Markov Chain Engine

The core momentum signal. 9-state model of 1-min BTC % price changes (large down → flat → large up). Chapman-Kolmogorov propagation over T steps gives a probability distribution over cumulative drift, converted to P(YES) and P(NO) via a Gaussian approximation.

**Gate thresholds (production):**
- Persistence ≥ 82% — dominant state must self-reinforce
- Gap ≥ 11pp from 50% — model must be ≥61% directionally confident
- Minimum 20 transitions before trusting the matrix

**Timing gate (empirical):**
- 65–73¢ golden zone: 3–12 min entry window (93%+ WR across this range)
- All other prices: 6–9 min entry window (6–9 min = 98.3% WR on live fills)

**Kelly sizing (tiered by price zone):**
| Zone | Kelly fraction | WR observed |
|------|---------------|-------------|
| 65–73¢ | 35% Kelly | 93%+ |
| 73–79¢ | 12% Kelly | ~82% |
| 79–85¢ | 8% Kelly | ~76% |
| 85¢+ | 5% Kelly | skip (losing) |

**Blocked UTC hours:** 11:00 and 18:00 (empirically catastrophic even within edge zones: −40pp to −57pp margin)

---

## Price Feed

All BTC price and candle data comes exclusively from **Coinbase Exchange** (`api.exchange.coinbase.com`) — the same source Kalshi uses to settle KXBTC15M contracts.

| Granularity | Used For |
|---|---|
| Spot ticker | Live BTC price, distance from strike |
| 5-min candles | Markov momentum states (daemon + backtest) |
| 15-min candles | GK vol, d-score, Hurst exponent |

---

## Risk Management

| Parameter | Value |
|---|---|
| Daily loss limit | max(5% portfolio, $50), capped at $150 |
| Session giveback limit | 1.5× daily loss cap from session peak |
| Max trades/day | 48 |
| Max trade size | 20% of portfolio |
| Entry price cap | 72¢ (above = market efficiency lost) |
| Blocked UTC hours | 11:00, 18:00 |
| Min distance from strike | 0.02% (near-strike = ~50/50 noise) |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     EXECUTION PATHS                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌── DAEMON (24/7) ────────────────────────────────────────┐    │
│  │  trade_daemon.py                                         │    │
│  │  Sleep → wake 12min before close → Markov signal         │    │
│  │  → place order → await settlement → log P&L             │    │
│  │  → loop forever                                          │    │
│  └──────────────────────────────────────────────────────────┘    │
│                                                                  │
│  ┌── MCP SERVER (Claude Code) ─────────────────────────────┐    │
│  │  mcp_server.py   →   /trade skill in Claude Code        │    │
│  │  get_market · analyze_signal · place_trade              │    │
│  │  get_balance · get_positions · run_backtest             │    │
│  └──────────────────────────────────────────────────────────┘    │
│                                                                  │
│  ┌── RESEARCH LOOP (nightly) ──────────────────────────────┐    │
│  │  research_loop.py                                        │    │
│  │  Parse logs → ablation study → Claude analysis           │    │
│  │  → research/YYYY-MM-DD.md + proposed git branch         │    │
│  └──────────────────────────────────────────────────────────┘    │
│                                                                  │
│  ┌── WEB DASHBOARD (Next.js) ──────────────────────────────┐    │
│  │  Coinbase ──► BTC spot + 5m/15m candles                 │    │
│  │  Kalshi API ──► KXBTC15M market + orderbook             │    │
│  │                                                          │    │
│  │  Stage 1 · MarketDiscovery  (rule-based)                │    │
│  │  Stage 2 · PriceFeed        (rule-based)                │    │
│  │  Stage 2.5 · Markov Gate    (Chapman-Kolmogorov)        │    │
│  │                │                                         │    │
│  │      ┌─────────┴─────────┐                              │    │
│  │  QUANT MODE           AI MODE                           │    │
│  │  ROMA pipeline        Grok unified                      │    │
│  │  (Sentiment +         (direction +                      │    │
│  │   Probability +        size + hedge                     │    │
│  │   Execution)           all in one call)                 │    │
│  └──────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

---

## What is ROMA?

**ROMA (Recursive Open Meta-Agent)** is an open-source multi-agent reasoning framework by [Sentient Foundation](https://github.com/sentient-agi/ROMA). It breaks a complex goal into sub-problems, solves them in parallel across independent Executor agents, and synthesizes the results.

```
Goal
 └─ Atomizer — atomic or needs decomposing?
      ├─ [atomic]  → Executor answers directly
      └─ [complex] → Planner generates 3–5 subtasks
                       → Executors run all in parallel
                       → Aggregator synthesizes result
```

Used in the web dashboard's Quant pipeline for Sentiment and Probability stages. In AI mode, Grok replaces ROMA entirely.

> **Critical:** `max_depth=0` in roma-dspy is **not "atomic"** — it means unlimited recursion. Always use `ROMA_MAX_DEPTH=1`. A `Math.max(1, ...)` guard prevents zero from reaching the SDK.

---

## Tech Stack

| Layer | Tech |
|---|---|
| **Framework** | Next.js 16 App Router (React 19) |
| **Language** | TypeScript + Python 3.13 |
| **AI — Claude** | Anthropic claude-sonnet-4-6 / claude-haiku-4-5 |
| **AI — Grok** | xAI Grok-3 / Grok-4 family |
| **AI — GPT** | OpenAI gpt-4o / gpt-4o-mini |
| **AI — OpenRouter** | Any model via OpenRouter |
| **Multi-Agent** | Sentient `roma-dspy` Python SDK via FastAPI |
| **Momentum Model** | Markov chain — 9-state 5-min price change bins, Chapman-Kolmogorov |
| **Daemon** | asyncio + httpx Python daemon — RSA-PSS Kalshi auth |
| **MCP Server** | `mcp` Python SDK — stdio transport — 7 trading tools |
| **Prediction Markets** | Kalshi Trade API v2 (KXBTC15M series) |
| **Price Data** | Coinbase Exchange exclusively |
| **Auth** | RSA-PSS request signing for Kalshi (Python + Node.js) |
| **Charts** | Canvas + requestAnimationFrame (60fps, Catmull-Rom spline) |
| **Styling** | CSS design tokens, warm neutral palette |

---

## Getting Started

### Prerequisites

- Node.js 18+
- Python 3.13 (venv **outside** the Next.js project dir to avoid Turbopack symlink issues)
- A [Kalshi](https://kalshi.com) account with API access and RSA key pair
- Anthropic API key (required for daemon + research loop)
- Optional: xAI / OpenAI / OpenRouter keys for web dashboard AI mode

### Install

```bash
git clone https://github.com/Julian-dev28/sentient-market-reader.git
cd sentient-market-reader
npm install

# Python venv — must be OUTSIDE the project directory
python3 -m venv ~/.sentient-venv313
source ~/.sentient-venv313/bin/activate
pip install -r python-service/requirements.txt
```

### Configure

```env
# .env.local

# ── LLM Providers ─────────────────────────────────────────────
ANTHROPIC_API_KEY=sk-ant-...    # required for daemon + research loop
XAI_API_KEY=xai-...             # optional: Grok AI mode
OPENAI_API_KEY=sk-...           # optional
OPENROUTER_API_KEY=sk-or-...    # optional

# ── ROMA / Web Dashboard ───────────────────────────────────────
AI_PROVIDER=grok                # anthropic | grok | openai | openrouter
ROMA_MODE=keen                  # blitz | sharp | keen | smart
ROMA_MAX_DEPTH=1                # NEVER set 0 — means unlimited recursion

# ── Kalshi ────────────────────────────────────────────────────
KALSHI_API_KEY=your-kalshi-api-key-id
KALSHI_PRIVATE_KEY_PATH=./kalshi_private_key.pem

# ── Python Service ────────────────────────────────────────────
PYTHON_ROMA_URL=http://localhost:8001
```

Place your Kalshi RSA private key at `./kalshi_private_key.pem` (already `.gitignore`d).

### Run

**Option 1 — Autonomous daemon (recommended for live trading):**
```bash
source ~/.sentient-venv313/bin/activate
cd python-service

# Dry run first (no real orders)
python3 trade_daemon.py --dry-run

# Live trading
python3 trade_daemon.py

# Background (survives terminal close)
nohup python3 trade_daemon.py > /dev/null 2>&1 &
echo $! > daemon.pid
```

**Option 2 — Web dashboard:**
```bash
# Terminal 1 — Python roma-dspy service
source ~/.sentient-venv313/bin/activate
cd python-service && python3 -m uvicorn main:app --port 8001 --host 0.0.0.0

# Terminal 2 — Next.js
npm run dev
# → http://localhost:3000
```

> `python3 main.py` does nothing (no `__main__` block). Always use `uvicorn`.

**Option 3 — Claude Code MCP (autonomous via Claude):**
```bash
# MCP server is pre-registered — just open Claude Code
claude

# Then type:
/trade
```

### Run the Research Loop

```bash
source ~/.sentient-venv313/bin/activate
python3 python-service/research_loop.py

# Options:
# --no-claude   skip Claude API call, just run backtest grid
# --days 14     shorter backtest window
# --no-branch   don't create proposed git branch
```

**Schedule nightly at 2am:**
```bash
(crontab -l; echo "0 2 * * * cd '/path/to/sentient-app' && source ~/.sentient-venv313/bin/activate && python3 python-service/research_loop.py >> python-service/logs/research_cron.log 2>&1") | crontab -
```

---

## Project Structure

```
├── app/
│   ├── api/
│   │   ├── pipeline/route.ts         # Main pipeline endpoint
│   │   ├── place-order/              # Kalshi order placement
│   │   ├── balance/                  # Account balance
│   │   └── positions/                # Open positions
│   ├── dashboard/page.tsx            # 15-min KXBTC15M dashboard
│   └── dashboard/hourly/page.tsx     # 1h KXBTCD dashboard
│
├── lib/
│   ├── agents/
│   │   ├── markov.ts                 # Markov chain — momentum gate
│   │   ├── grok-trading-agent.ts     # AI mode — unified Grok agent
│   │   ├── risk-manager.ts           # Risk gates + Kelly sizing
│   │   ├── market-discovery.ts       # Kalshi market scanner
│   │   ├── price-feed.ts             # BTC price + distance from strike
│   │   ├── sentiment.ts              # ROMA sentiment
│   │   ├── probability-model.ts      # ROMA probability + trend alignment
│   │   └── execution.ts              # Order generation
│   ├── kalshi-auth.ts                # RSA-PSS request signing
│   ├── kalshi-trade.ts               # placeOrder, getBalance, getPositions
│   └── types.ts                      # Shared TypeScript interfaces
│
├── components/
│   ├── AgentPipeline.tsx             # Live pipeline grid
│   ├── AgentAllowancePanel.tsx       # Agent start/stop, Kelly config
│   ├── MarketCard.tsx                # Live Kalshi market + orderbook
│   ├── PriceChart.tsx                # 60fps Canvas BTC chart (Catmull-Rom spline)
│   └── TradeLog.tsx                  # Trade history with P&L
│
└── python-service/
    ├── trade_daemon.py               # ★ 24/7 autonomous trading daemon
    ├── research_loop.py              # ★ Nightly self-evolution engine
    ├── mcp_server.py                 # ★ MCP server for Claude Code integration
    ├── run_backtest.py               # 30-day historical backtest
    ├── main.py                       # FastAPI — roma-dspy solve() wrapper
    ├── logs/                         # Daily daemon trade logs
    ├── research/                     # Nightly research reports (Markdown)
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
- **NO orders:** Send `no_price` directly — do not complement to `yes_price`

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes (daemon) | Claude for research loop analysis |
| `KALSHI_API_KEY` | Yes | Kalshi API key ID (UUID) |
| `KALSHI_PRIVATE_KEY_PATH` | Yes | Path to RSA private key PEM |
| `AI_PROVIDER` | Dashboard | `grok` \| `anthropic` \| `openai` \| `openrouter` |
| `ROMA_MODE` | Dashboard | `blitz` \| `sharp` \| `keen` \| `smart` |
| `ROMA_MAX_DEPTH` | Dashboard | ROMA depth — default `1`; **never `0`** |
| `XAI_API_KEY` | If Grok | xAI API key |
| `OPENAI_API_KEY` | If OpenAI | OpenAI API key |
| `OPENROUTER_API_KEY` | If OpenRouter | OpenRouter API key |
| `PYTHON_ROMA_URL` | Dashboard | roma-dspy URL (default `http://localhost:8001`) |

---

## Disclaimer

This project is for educational and research purposes. Paper trading (`--dry-run`) is always available. Live trading places real orders with real money on a regulated prediction market exchange. Use at your own risk. Nothing here is financial advice.

---

## License

MIT
