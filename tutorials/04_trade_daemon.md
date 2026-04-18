# Trade Daemon

## What It Is

`python-service/trade_daemon.py` — a 24/7 autonomous trading loop. It wakes up for each 15-minute KXBTC15M window, runs the full Markov signal, places a real order if all gates pass, and logs every decision.

No human intervention required. No Claude Code session needed. Pure Python.

## Setup

```bash
source ~/.sentient-venv313/bin/activate
cd "<project-root>"
```

Credentials are loaded from `.env.local` in the project root:
```env
KALSHI_API_KEY=<YOUR_KALSHI_API_KEY_UUID>
KALSHI_PRIVATE_KEY_PATH=./kalshi_private.pem
```

## Running

```bash
# Live trading
python3 python-service/trade_daemon.py

# Dry run (no real orders, full signal logging)
python3 python-service/trade_daemon.py --dry-run

# Custom bankroll
python3 python-service/trade_daemon.py --bankroll 500
```

## How It Works

### Timing Loop

The daemon wakes up 12 minutes before each 15-minute window close:

```
12:00 ET — window opens
12:03 ET — daemon wakes (12 min before 12:15 close)
12:03 ET — fetch candles + run signal (~2-3s)
12:04 ET — if approved, place order
12:15 ET — window closes, market settles
12:15 ET — daemon records settlement
12:18 ET — wakes for next window (12:30 close)
```

DST-aware next-window-close calculation:

```python
def next_window_close() -> datetime:
    off = _et_offset()  # -4 (EDT) or -5 (EST)
    now = datetime.now(timezone.utc)
    et  = now + timedelta(hours=off)
    nxt = (et.minute // 15 + 1) * 15
    et  = et.replace(second=0, microsecond=0)
    if nxt >= 60:
        et = et.replace(minute=0) + timedelta(hours=1)
    else:
        et = et.replace(minute=nxt)
    return et - timedelta(hours=off)  # convert back to UTC
```

### Risk Guards (Session-Level)

The daemon tracks a `Session` object across all windows in a day:

| Guard | Value | Behavior |
|-------|-------|----------|
| Daily loss cap | $50 | Stop trading for the day |
| Peak giveback | 1.5× loss cap | Stop if peak P&L drops > $75 |
| Daily trade max | 48 | Stop after 48 trades |

These reset at UTC midnight.

### Signal Pipeline

For each window, the daemon:
1. Fetches 5-min and 15-min candles in parallel (2 days each)
2. Builds Markov history from 5-min candles
3. Gets BTC spot price
4. Fetches the active Kalshi market
5. Runs gate stack (gap, persist, vol, Hurst, timing, price cap, blocker)
6. If approved, calculates Kelly size and places order

### Logging

Logs to `python-service/logs/daemon_YYYYMMDD.log`:

```
2026-04-18 12:03:15 UTC  INFO     Window: KXBTC15M-26APR181415-15 | close=12:15 ET | 11.7 min left
2026-04-18 12:03:17 UTC  INFO     Signal: p_yes=0.734 gap=0.234 persist=0.891 hurst=0.523 gk_vol=0.00189
2026-04-18 12:03:17 UTC  INFO     Gates: gap=PASS persist=PASS vol=PASS hurst=PASS time=PASS price=PASS
2026-04-18 12:03:17 UTC  INFO     TRADE: BUY YES 3 @ 71¢ | max_loss=$2.16 | ev=+$0.84
2026-04-18 12:03:18 UTC  INFO     Order placed: order_id=01234567-abcd
2026-04-18 12:15:22 UTC  INFO     WIN | P&L: +$0.87 | daily: +$2.43
```

The research loop parses these WIN/LOSS lines to compute live performance statistics.

### Settlement Tracking

The daemon stores `pending_settlements` — orders placed in the current run. After each window closes, it checks if the market settled YES or NO and records the P&L.

## Pending Settlement Format

```python
pending_settlements = [
    {
        'ticker':      'KXBTC15M-26APR181415-15',
        'side':        'yes',
        'contracts':   3,
        'limit_price': 71,
        'close_ts':    1745979300.0,  # UTC unix
        'order_id':    '01234567-abcd',
    }
]
```

## Dependencies

The daemon imports from `run_backtest.py` (same directory):
```python
from run_backtest import (
    fetch_candles_5m, fetch_candles_15m,
    build_markov_history, build_transition_matrix, predict_from_momentum,
    price_change_to_state, gk_vol, compute_hurst,
    MARKOV_MIN_GAP, MIN_PERSIST, KELLY_FRACTION, MAX_TRADE_PCT,
    MAX_ENTRY_PRICE_RM, MAKER_FEE_RATE, EMPIRICAL_PRICE_BY_D, BLOCKED_UTC_HOURS,
)
```

`run_backtest.py` uses Yahoo Finance for candle data with a 1-hour local JSON cache. The MCP server (`sentient-trader-mcp`) uses Coinbase instead — either works.

## Running as a Background Service

```bash
# Run in background, redirect logs
nohup python3 python-service/trade_daemon.py >> python-service/logs/daemon_stdout.log 2>&1 &
echo $! > python-service/logs/daemon.pid

# Stop
kill $(cat python-service/logs/daemon.pid)
```

## TUI Monitoring

`tui.py` provides a real-time terminal dashboard for the running daemon:

```bash
python3 tui.py
```

Displays: current window, BTC price, last signal result, today's P&L, win rate, recent log lines.

## Differences from MCP Server

| Feature | trade_daemon.py | sentient-trader-mcp |
|---------|----------------|---------------------|
| Runs | Standalone, always on | On-demand, per Claude session |
| Candle source | Yahoo Finance (cached) | Coinbase Exchange API |
| Auth credentials | From `.env.local` | From `~/.sentient-trader/config.env` |
| Order placement | Automatic, no confirmation | Called explicitly by Claude |
| Risk guards | Session-level daily caps | Per-trade gate stack only |
| Human needed | No | Yes (Claude Code session) |
