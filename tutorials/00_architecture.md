# System Architecture

## What This Is

Sentient Market Reader is an autonomous BTC prediction market trading system built around Kalshi's KXBTC15M markets. It has three independent execution paths that can run simultaneously:

1. **Next.js web app** — real-time dashboard with ROMA multi-agent analysis pipeline
2. **Python trade daemon** — 24/7 autonomous trading loop, no human in the loop
3. **MCP server** — Claude Code tool integration for AI-driven trading sessions

## Directory Layout

```
sentient app/
├── app/                        # Next.js App Router pages
│   ├── dashboard/page.tsx      # main trading dashboard
│   └── agent/page.tsx          # agent-only view
├── components/                 # React UI components
├── hooks/                      # usePipeline, useMarketTick
├── lib/
│   ├── agents/                 # 6 pipeline agents (TS)
│   ├── markov/                 # Markov chain math (TS)
│   ├── roma/                   # ROMA multi-agent loop
│   ├── kalshi-auth.ts          # RSA-PSS signing
│   ├── kalshi-trade.ts         # order placement
│   └── kalshi.ts               # market data fetch
├── python-service/
│   ├── run_backtest.py         # core Markov engine + backtester
│   ├── trade_daemon.py         # autonomous 24/7 daemon
│   ├── research_loop.py        # nightly ablation + Claude analysis
│   ├── mcp_server.py           # local MCP server (dev)
│   └── main.py                 # FastAPI service (uvicorn)
└── sentient-trader-mcp/        # standalone PyPI package
    └── sentient_trader_mcp/
        └── server.py           # self-contained MCP server
```

## Data Flow

```
Coinbase Exchange API ──► 5-min + 15-min BTC candles
Kalshi API            ──► KXBTC15M market (strike, ask, close_time)

                          ┌─────────────────────────────┐
                          │  Markov Signal Engine        │
                          │  9-state momentum model      │
                          │  Chapman-Kolmogorov P^T      │
                          │  P(YES) via Gaussian approx  │
                          └──────────┬──────────────────┘
                                     │
                          ┌──────────▼──────────────────┐
                          │  Gate Stack                  │
                          │  gap ≥ 0.11 (61% conf)       │
                          │  persist ≥ 0.82              │
                          │  GK vol ≤ 1.25× ref          │
                          │  Hurst ≥ 0.50                │
                          │  timing: 6–9 min (std)       │
                          │         3–12 min (golden)    │
                          │  price ≤ 72¢                 │
                          └──────────┬──────────────────┘
                                     │
                          ┌──────────▼──────────────────┐
                          │  Kelly Sizing (tiered)       │
                          │  65–73¢: 35% Kelly           │
                          │  73–79¢: 12% Kelly           │
                          │  79–85¢:  8% Kelly           │
                          └──────────┬──────────────────┘
                                     │
                    ┌────────────────┼─────────────────────┐
                    ▼                ▼                      ▼
             Next.js UI        trade_daemon.py       MCP tool
             (human review)    (auto-place)          (Claude Code)
```

## The Three Execution Paths

### Path 1: Next.js Dashboard
- Run: `npm run dev` from project root
- Pipeline triggered by `usePipeline` hook every 5 min (or manually)
- Two modes: **Quant** (pure math) and **AI** (Grok via ROMA)
- Live tick via `useMarketTick` polling every 2s
- Trade execution via `/api/place-order` → `lib/kalshi-trade.ts`

### Path 2: Trade Daemon
- Run: `source ~/.sentient-venv313/bin/activate && python3 python-service/trade_daemon.py`
- Sleeps until 12 min before each 15-min window close, wakes up, runs signal
- Places real orders if gates pass; logs every decision
- Session risk guards: $50/day loss cap, 48 trades/day max, 1.5× peak giveback

### Path 3: MCP Server (sentient-trader-mcp)
- Install: `pip install sentient-trader-mcp`
- Register: `claude mcp add -s user sentient-trader -- python3 -m sentient_trader_mcp`
- Credentials from `~/.sentient-trader/config.env`
- 7 tools: `get_market`, `analyze_signal`, `place_trade`, `get_balance`, `get_positions`, `cancel_order`, `kelly_size`

## Key API Endpoints

| Service | Base URL |
|---------|----------|
| Kalshi markets (public) | `https://api.elections.kalshi.com/trade-api/v2/markets` |
| Kalshi trading (auth) | `https://api.elections.kalshi.com/trade-api/v2/portfolio/...` |
| Coinbase candles (public) | `https://api.exchange.coinbase.com/products/BTC-USD/candles` |

## Environment Variables

```env
# Required for trading
KALSHI_API_KEY=<UUID from Kalshi settings>
KALSHI_PRIVATE_KEY_PATH=./kalshi_private.pem

# Required for AI mode
ANTHROPIC_API_KEY=<key>
XAI_API_KEY=<key>           # for Grok models

# Optional
MARKOV_MIN_GAP=0.11
MIN_PERSIST=0.82
MAX_ENTRY_PRICE=72
MAX_VOL_MULT=1.25
MIN_HURST=0.50
ROMA_MAX_DEPTH=1
```

## Backtested Performance (30 days, $200 start)

- Return: +397%
- Win rate: 82%
- Max drawdown: 5%
- Best zone: 65–73¢ YES (golden zone) → 93%+ WR

## Critical Facts for AI Agents

- Kalshi API returns prices as `yes_ask_dollars` (string USD), not integer `yes_ask` cents — normalize before use: `round(float(yes_ask_dollars) * 100)`
- Market `status` field is `"active"` not `"open"` even when queried with `status=open`
- `close_time` is the 15-min window end; `expiration_time` is days later — always use `close_time` for countdowns
- BTC price source: Coinbase Exchange (`/products/BTC-USD/ticker`) — same feed Kalshi settles against
- Blocked UTC hours: 11 and 18 (empirically -40pp to -57pp margin, never trade these windows)
- Eastern Time offset: EDT (UTC-4) Mar–Nov, EST (UTC-5) Nov–Mar — must be DST-aware
