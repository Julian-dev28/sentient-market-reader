# Sentient — Autonomous BTC Prediction Market Trader

> **Live Kalshi algotrader with three fully independent execution paths: a 24/7 Python trading daemon, a Claude Code MCP server, and a Next.js web dashboard with a unified agent panel for both 15-min and 1-hour markets. All price data sourced exclusively from Coinbase Exchange — the same feed Kalshi settles against.**

![Next.js](https://img.shields.io/badge/Next.js_16-black?style=flat-square&logo=next.js)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)
![xAI Grok](https://img.shields.io/badge/xAI_Grok-000000?style=flat-square&logo=x&logoColor=white)
![Anthropic](https://img.shields.io/badge/Claude_Sonnet_4.6-D97706?style=flat-square&logo=anthropic&logoColor=white)
![Kalshi](https://img.shields.io/badge/Kalshi_API-1a1a2e?style=flat-square)
![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)

---

## What It Does

Sentient connects to [Kalshi](https://kalshi.com)'s live BTC binary prediction markets and runs an autonomous agent pipeline to analyze momentum and place trades. Two market types are supported:

- **KXBTC15M** — 15-minute BTC YES/NO contracts, 96 windows per day
- **KXBTCD** — Hourly BTC YES/NO contracts with ~200 strikes per window

The core signal is a **Markov chain momentum model** — 9 states of 1-min BTC price change, Chapman-Kolmogorov propagation, converted to P(YES). Trades are only placed when momentum is locked-in, directionally decisive, and the risk gates pass.

---

## Three Execution Paths

### 1. Trading Daemon (24/7 autonomous)

The production execution engine. A standalone Python daemon that runs continuously, wakes for every 15-min Kalshi window, runs the full signal stack, places real orders when all gates pass, and logs every decision.

```bash
cd python-service
python3 trade_daemon.py           # live trading
python3 trade_daemon.py --dry-run # simulation, no real orders
```

- Sleeps precisely until 12 min before each `:00/:15/:30/:45` ET close
- Signal stack: Markov chain → Hurst exponent → GK vol → timing → price cap → UTC block
- Timing: 6–9 min entry window (golden zone 65–73¢ YES: 3–12 min)
- Tracks daily P&L, session giveback, and trade count in-memory; resets at midnight ET
- Checks settlement after each window closes and updates P&L
- Logs decisions to `python-service/logs/daemon_YYYYMMDD.log`

### 2. Claude Code MCP Integration

The full trading engine exposed as an MCP server. Type `/trade` in Claude Code and Claude autonomously checks the market, runs the signal, and places a live order if all gates pass.

```bash
# Pre-registered in ~/.claude/settings.json — just open Claude Code
claude

# Then type:
/trade
```

Seven tools available: `get_market`, `analyze_signal`, `place_trade`, `get_balance`, `get_positions`, `cancel_order`, `run_backtest`.

### 3. Web Dashboard (Next.js)

A live monitoring UI with an autonomous agent at `http://localhost:3000/agent`. The agent panel has a **15m / 1h market toggle** — one interface controls both KXBTC15M and KXBTCD.

```bash
npm run dev
# → http://localhost:3000
```

**Quant mode (default):**
1. **MarketDiscovery** — scans Kalshi for the active window
2. **PriceFeed** — live BTC/USD from Coinbase Exchange + distance from strike
3. **Markov Gate** — 9-state 1-min momentum model; requires ≥82% persistence, ≥11pp gap from 50%
4. **SentimentAgent** — ROMA multi-agent solve (roma-dspy Python service)
5. **ProbabilityModelAgent** — ROMA recursive solve with Cornish-Fisher skew adjustment
6. **RiskManager** — deterministic gates: price cap, timing, UTC hour, daily loss, giveback
7. **ExecutionAgent** — fires only when Markov and Probability agree and all gates pass

**AI mode (Grok):** Stages 3–7 replaced by a single Grok agent that receives the full market picture across all timeframes and makes all decisions autonomously.

### 4. Self-Evolving Research Loop

A nightly analysis engine that reads trade logs, runs a parameter ablation study, and calls Claude to write a research report with proposed improvements.

```bash
python3 python-service/research_loop.py

# Options:
# --no-claude   skip Claude API call, just run backtest grid
# --days 14     shorter backtest window
# --no-branch   don't create proposed git branch
```

- Fetches 30 days of historical data once, runs all backtest variations against the cache
- Ablation study: varies `MARKOV_MIN_GAP`, `MIN_PERSIST`, timing gates, vol/Hurst thresholds one at a time
- Calls Claude Sonnet to analyze, diagnose patterns, propose new signal ideas
- Writes a Markdown report to `python-service/research/YYYY-MM-DD.md`
- Creates a `research/proposed-*` git branch if any variation beats baseline by >5%

**The self-evolution loop:**
```
trade_daemon (always running)
      ↓  produces daily trade logs
research_loop (nightly)
      ↓  ablation + Claude analysis + proposed branch
you review & merge
      ↓
trade_daemon restarts with improved params
```

---

## Markov Chain Engine

The core momentum signal. 9-state model of 1-min BTC % price changes (large down → flat → large up). Chapman-Kolmogorov propagation over T steps gives a probability distribution over cumulative drift, converted to P(YES) and P(NO) via a Gaussian approximation.

**Gate thresholds (production):**
- Persistence ≥ 82% — dominant state must self-reinforce across recent transitions
- Gap ≥ 11pp from 50% — model must be ≥61% directionally confident
- Minimum 20 transitions before trusting the matrix

**Timing gate (empirical, 15-min markets):**
- 6–9 min before close: core entry window (98.3% WR on live fills vs 91.7% at 3–6 min)
- 65–73¢ YES golden zone: wider 3–12 min window (93%+ WR, market underprices signal)
- Web app enforces strict 6–9 min for all entries

**Hourly markets (KXBTCD):** 10–45 min before close.

---

## Risk Management

All five execution paths enforce the same rules.

| Parameter | Value |
|---|---|
| Entry price cap — YES | ≤ 72¢ |
| Entry price cap — NO | ≤ 65¢ |
| Blocked UTC hours | 8, 11, 16, 18, 21 |
| Timing window (15m) | 6–9 min before close |
| Timing window (1h) | 10–45 min before close |
| Min distance from strike | 0.02% (near-strike = ~50/50 noise) |
| Daily loss limit | max(5% portfolio, $50), capped at $150 |
| Session giveback limit | 1.5× daily loss cap from session peak |
| Max trades / day | 48 (15m) · 24 (1h) |
| Max position size | 20% of portfolio per trade |

**Why the split price cap matters:**  
Live data analysis (147 trades, Apr 2026):
- YES ≤ 72¢: +EV across all buckets (76.3% WR on compliant trades)
- NO 65–72¢: −$7.71/trade (53% WR vs 69% break-even needed) — consensus-following with terrible payout
- YES > 72¢: −$9.34/trade (67% WR vs 76% needed) — market efficiency zone lost

**Why the blocked hours:**
- Hours 11, 18 UTC: −40 to −57pp margin even within edge zones (2,690-fill empirical dataset)
- Hours 8, 16, 21 UTC: 36–44% WR in live data (EU open noise / US pre-close turbulence / thin liquidity)

**Position sizing (web app):** Tiered flat risk by Markov gap (1–5% of portfolio), vol-scaled by GK vol vs 0.002 baseline.  
**Position sizing (daemon):** Tiered Kelly (35% Kelly at 65–73¢, 12% at 73–79¢, 8% at 79–85¢).

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        EXECUTION PATHS                               │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌── DAEMON (24/7) ──────────────────────────────────────────────┐  │
│  │  trade_daemon.py                                               │  │
│  │  Sleep → wake 12 min before close → full signal stack         │  │
│  │  → place order → await settlement → log P&L → loop            │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  ┌── MCP SERVER (Claude Code /trade) ────────────────────────────┐  │
│  │  mcp_server.py  →  7 tools: get_market · analyze_signal       │  │
│  │  place_trade · get_balance · get_positions · cancel_order      │  │
│  │  run_backtest                                                  │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  ┌── WEB DASHBOARD (Next.js :3000) ──────────────────────────────┐  │
│  │                                                                │  │
│  │  /agent ─── market toggle ──┬── KXBTC15M (15-min)            │  │
│  │                              └── KXBTCD   (1-hour)            │  │
│  │                                                                │  │
│  │  Coinbase ──► BTC spot + 1m/5m/15m/1h/4h candles             │  │
│  │  Kalshi ──► active market + orderbook                         │  │
│  │                                                                │  │
│  │  MarketDiscovery → PriceFeed → Markov Gate                    │  │
│  │                                    │                           │  │
│  │                         ┌──────────┴──────────┐               │  │
│  │                     QUANT MODE            AI MODE             │  │
│  │                     ROMA pipeline         Grok unified        │  │
│  │                     (Sentiment +          (direction +        │  │
│  │                      Probability)          size + hedge)      │  │
│  │                                    │                           │  │
│  │                         RiskManager → ExecutionAgent          │  │
│  │                                                                │  │
│  │  /dashboard     — 15-min market monitor                       │  │
│  │  /dashboard/hourly — 1-hour market monitor                    │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  ┌── RESEARCH LOOP (nightly) ────────────────────────────────────┐  │
│  │  research_loop.py                                              │  │
│  │  Parse logs → ablation study → Claude analysis                 │  │
│  │  → research/YYYY-MM-DD.md + proposed git branch               │  │
│  └────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
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

> **Critical:** `max_depth=0` in roma-dspy is **not "atomic"** — it means unlimited recursion. Always set `ROMA_MAX_DEPTH=1`. A `Math.max(1, ...)` guard in the codebase prevents zero from reaching the SDK.

---

## Project Structure

```
├── app/
│   ├── agent/page.tsx                    # ★ Unified agent panel — 15m/1h toggle
│   ├── dashboard/page.tsx                # 15-min KXBTC15M market monitor
│   ├── dashboard/hourly/page.tsx         # 1-hour KXBTCD market monitor
│   ├── login/page.tsx                    # Appwrite auth
│   ├── settings/page.tsx                 # Kalshi credentials connect
│   └── api/
│       ├── agent/{start,stop,state,stream,run,config,clear-history}/
│       ├── agent-hourly/{start,stop,state,stream,clear-history}/
│       ├── pipeline/route.ts             # Legacy ROMA pipeline endpoint
│       ├── place-order/route.ts          # Kalshi order placement
│       ├── balance/route.ts              # Account balance
│       ├── positions/route.ts            # Open positions
│       ├── cancel-order/[orderId]/       # Cancel a resting order
│       ├── btc-price/route.ts            # Coinbase spot price
│       ├── markets/route.ts              # Kalshi market list
│       ├── orderbook/[ticker]/           # Live orderbook
│       └── auth/{login,logout,me,signup}/
│
├── lib/
│   ├── server-agent.ts                   # ★ 15-min ServerAgent class + SSE loop
│   ├── server-agent-hourly.ts            # ★ 1-hour HourlyServerAgent class + SSE loop
│   ├── agent-store.ts                    # KV state store — 15m agent
│   ├── agent-store-hourly.ts             # KV state store — 1h agent
│   ├── agent-shared.ts                   # Shared AgentPhase type + constants
│   ├── agents/
│   │   ├── index.ts                      # ★ runAgentPipeline() — orchestrator
│   │   ├── markov.ts                     # Markov agent wrapper
│   │   ├── risk-manager.ts               # ★ Deterministic risk gates + position sizing
│   │   ├── grok-trading-agent.ts         # AI mode — unified Grok agent
│   │   ├── market-discovery.ts           # Kalshi market scanner
│   │   ├── price-feed.ts                 # BTC price + GK vol + Hurst
│   │   ├── sentiment.ts                  # ROMA sentiment agent
│   │   ├── probability-model.ts          # ROMA probability model
│   │   └── execution.ts                  # Order generation
│   ├── markov/
│   │   ├── chain.ts                      # Chapman-Kolmogorov propagation
│   │   └── history.ts                    # Candle → state history builder
│   ├── indicators.ts                     # GK vol, Hurst, d-score
│   ├── kalshi.ts                         # Kalshi API client + KXBTCD ticker parser
│   ├── kalshi-auth.ts                    # RSA-PSS request signing (Node.js)
│   ├── kalshi-trade.ts                   # placeOrder, cancelOrder, getBalance, getPositions
│   ├── trade-log.ts                      # Trade log read/write
│   ├── pipeline-lock.ts                  # Prevents concurrent pipeline runs
│   ├── llm-client.ts                     # Multi-provider LLM client
│   ├── encryption.ts                     # AES-256-GCM for stored credentials
│   ├── appwrite-server.ts                # Appwrite server-side client
│   └── types.ts                          # Shared TypeScript interfaces
│
├── hooks/
│   ├── useAgentEngine.ts                 # 15m agent state + SSE subscription
│   ├── useHourlyAgentEngine.ts           # 1h agent state + SSE subscription
│   ├── useMarketTick.ts                  # Live market price polling
│   └── usePipeline.ts                    # Legacy pipeline hook
│
├── components/
│   ├── AgentAllowancePanel.tsx           # Agent start/stop, Kelly config, phase display
│   ├── AgentPipeline.tsx                 # Live pipeline stage grid
│   ├── AgentStatsPanel.tsx               # Win rate, P&L, trade stats
│   ├── AgentTradeLog.tsx                 # Agent trade history
│   ├── MarketCard.tsx                    # Live Kalshi market + orderbook
│   ├── MarkovPanel.tsx                   # Markov chain state visualizer
│   ├── PositionsPanel.tsx                # Kalshi balance + open positions
│   ├── PriceChart.tsx                    # 60fps Canvas BTC chart (Catmull-Rom spline)
│   ├── SignalPanel.tsx                   # Current signal summary
│   └── TradeLog.tsx                      # Dashboard trade history
│
└── python-service/
    ├── trade_daemon.py                   # ★ 24/7 autonomous trading daemon
    ├── mcp_server.py                     # ★ MCP server — 7 tools for Claude Code
    ├── research_loop.py                  # ★ Nightly self-evolution engine
    ├── run_backtest.py                   # ★ 30-day historical backtest + shared constants
    ├── main.py                           # FastAPI — roma-dspy solve() wrapper
    ├── backtest_agent.py                 # Backtest with agent-style logging
    ├── analyze_live_trades.py            # Live trade CSV diagnostic tool
    ├── timesfm/                          # TimesFM fine-tuning experiments
    ├── logs/                             # Daily daemon trade logs (daemon_YYYYMMDD.log)
    ├── research/                         # Nightly research reports (Markdown)
    └── requirements.txt
```

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
| **Momentum Model** | Markov chain — 9-state 1-min price change bins, Chapman-Kolmogorov |
| **Daemon** | asyncio + httpx — RSA-PSS Kalshi auth, persistent in-memory session state |
| **MCP Server** | `mcp` Python SDK — stdio transport — 7 trading tools |
| **Prediction Markets** | Kalshi Trade API v2 (KXBTC15M · KXBTCD series) |
| **Price Data** | Coinbase Exchange exclusively (spot + 1m/5m/15m/1h/4h candles) |
| **Auth** | RSA-PSS request signing (Python + Node.js); Appwrite for multi-user |
| **Charts** | Canvas + requestAnimationFrame (60fps, Catmull-Rom spline) |
| **Styling** | CSS design tokens, warm cream palette |

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

# ── Appwrite (optional — multi-user credential storage) ───────
NEXT_PUBLIC_APPWRITE_ENDPOINT=https://cloud.appwrite.io/v1
NEXT_PUBLIC_APPWRITE_PROJECT_ID=your-project-id
ENCRYPTION_KEY=64-char-hex-string
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
# Terminal 1 — Python roma-dspy service (only needed for Quant/ROMA mode)
source ~/.sentient-venv313/bin/activate
cd python-service && uvicorn main:app --port 8001 --host 0.0.0.0

# Terminal 2 — Next.js
npm run dev
# → http://localhost:3000/agent
```

> `python3 main.py` does nothing (no `__main__` block). Always use `uvicorn`.

**Option 3 — Claude Code MCP:**
```bash
# MCP server is pre-registered in ~/.claude/settings.json
claude

# In Claude Code, type:
/trade
```

### Run the Research Loop

```bash
source ~/.sentient-venv313/bin/activate
python3 python-service/research_loop.py

# --no-claude   skip Claude API, just run backtest grid
# --days 14     shorter backtest window
# --no-branch   don't create proposed git branch
```

**Schedule nightly at 2am ET:**
```bash
(crontab -l; echo "0 2 * * * cd '/path/to/sentient-app' && source ~/.sentient-venv313/bin/activate && python3 python-service/research_loop.py >> python-service/logs/research_cron.log 2>&1") | crontab -
```

---

## Kalshi API Notes

- **Base URL:** `https://api.elections.kalshi.com/trade-api/v2/`
- **Auth headers:** `KALSHI-ACCESS-KEY` · `KALSHI-ACCESS-TIMESTAMP` (milliseconds) · `KALSHI-ACCESS-SIGNATURE`
- **Signature payload:** `{timestampMs}{METHOD}{path}` — direct concat, no separators, no query params in path
- **RSA padding:** `RSA_PKCS1_PSS_PADDING` with `RSA_PSS_SALTLEN_DIGEST`
- **KXBTC15M discovery:** `?event_ticker=KXBTC15M-{YY}{MON}{DD}{HHMM}` in US Eastern Time
- **KXBTCD discovery:** event ticker `KXBTCD-{YY}{MON}{DD}{HH}` (ET hour); ~200 strikes per window
- **Active markets:** `yes_ask > 0`; `floor_strike` = BTC price to beat; use `close_time` for countdown
- **NO orders:** Send `no_price` directly — do not complement to `yes_price`

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes (daemon) | Claude for research loop |
| `KALSHI_API_KEY` | Yes | Kalshi API key ID (UUID) |
| `KALSHI_PRIVATE_KEY_PATH` | Yes | Path to RSA private key PEM |
| `AI_PROVIDER` | Dashboard | `grok` \| `anthropic` \| `openai` \| `openrouter` |
| `ROMA_MODE` | Dashboard | `blitz` \| `sharp` \| `keen` \| `smart` |
| `ROMA_MAX_DEPTH` | Dashboard | ROMA depth — default `1`; **never `0`** |
| `XAI_API_KEY` | If Grok | xAI API key |
| `OPENAI_API_KEY` | If OpenAI | OpenAI API key |
| `OPENROUTER_API_KEY` | If OpenRouter | OpenRouter API key |
| `PYTHON_ROMA_URL` | Dashboard | roma-dspy URL (default `http://localhost:8001`) |
| `NEXT_PUBLIC_APPWRITE_ENDPOINT` | Multi-user | Appwrite endpoint |
| `NEXT_PUBLIC_APPWRITE_PROJECT_ID` | Multi-user | Appwrite project ID |
| `ENCRYPTION_KEY` | Multi-user | AES-256-GCM key (64-char hex) |

---

## Disclaimer

This project is for educational and research purposes. Paper trading (`--dry-run`) is always available. Live trading places real orders with real money on a regulated prediction market exchange. Use at your own risk. Nothing here is financial advice.

---

## License

MIT
