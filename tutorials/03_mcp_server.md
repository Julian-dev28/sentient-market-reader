# sentient-trader-mcp: MCP Server

## What It Is

A standalone Python package that exposes the Markov signal engine as MCP (Model Context Protocol) tools. Claude Code can call these tools directly in any session.

PyPI: `pip install sentient-trader-mcp`  
Source: `sentient-trader-mcp/sentient_trader_mcp/server.py`

## Installation

```bash
pip install sentient-trader-mcp
```

## Credentials Setup

Create `~/.sentient-trader/config.env`:

```env
KALSHI_API_KEY=<YOUR_KALSHI_API_KEY_UUID>
KALSHI_PRIVATE_KEY_PATH=/absolute/path/to/kalshi_private.pem
```

Must be an **absolute path** — the MCP server runs from an unknown CWD, relative paths fail.

The loader checks in order:
1. `~/.sentient-trader/config.env` (preferred)
2. `$CWD/.env.local`
3. `$CWD/.env`

Credentials are loaded **lazily** at the first API call (not at import time), so the config file is always read fresh.

## Registering with Claude Code

```bash
claude mcp add -s user sentient-trader -- python3 -m sentient_trader_mcp
```

This writes to `~/.claude.json` (not `settings.json`). Verify:

```bash
claude mcp list
```

**Important**: Only register ONE sentient-trader server. If you see both `sentient-trader` and `sentient-trader-pypi`, remove both and re-register once:

```bash
claude mcp remove sentient-trader -s user
claude mcp remove sentient-trader-pypi -s user
claude mcp add -s user sentient-trader -- python3 -m sentient_trader_mcp
```

After any registration change, **restart Claude Code** so the new server process loads.

## Available Tools

### `get_market`
Returns the current active KXBTC15M market.

```json
{
  "ticker": "KXBTC15M-26APR181415-15",
  "strike_price": 76070.49,
  "btc_price": 76215.03,
  "above_strike": true,
  "dist_pct": 0.19,
  "yes_ask": 72,
  "no_ask": 30,
  "minutes_left": 7.4,
  "close_time": "2026-04-18T12:15:00Z",
  "status": "active"
}
```

No arguments required. Public endpoint — no auth needed.

---

### `analyze_signal`
Runs the full Markov chain signal. Takes ~3s (fetches candles in parallel).

Arguments:
- `bankroll` (number, optional, default 200): current account balance in USD

```json
{
  "approved": false,
  "recommendation": "NO_TRADE",
  "ticker": "KXBTC15M-26APR181415-15",
  "limit_price": 99,
  "contracts": 0,
  "max_loss_usd": 0.0,
  "expected_value": -0.0,
  "rejection_reasons": [
    "mean-reverting Hurst=0.36",
    "3.4min outside 6-9min window",
    "price 99¢ > 72¢ cap"
  ],
  "signal": {
    "p_yes": 0.9713,
    "gap": 0.4713,
    "persist": 0.992,
    "hurst": 0.362,
    "gk_vol": 0.001872,
    "d_score": 2.141,
    "minutes_left": 3.4,
    "history_len": 481,
    "utc_hour": 12,
    "is_golden": false
  },
  "market": {
    "btc_price": 76215.04,
    "strike": 76070.49,
    "dist_pct": 0.19,
    "yes_ask": 99,
    "no_ask": 1
  }
}
```

When `approved: true`, `recommendation` is `"YES"` or `"NO"`, and `contracts`/`limit_price`/`max_loss_usd` are populated.

---

### `place_trade`
Places a real Kalshi limit order. **Only call when `analyze_signal` returns `approved: true`.**

Arguments:
- `ticker` (string, required)
- `side` (string, required): `"yes"` or `"no"`
- `contracts` (integer, required): from `analyze_signal.contracts`
- `limit_price` (integer, required): cents (1–99), from `analyze_signal.limit_price`

```json
{
  "status": "placed",
  "order_id": "01234567-abcd-...",
  "ticker": "KXBTC15M-26APR181415-15",
  "side": "yes",
  "contracts": 3,
  "limit_price": 72
}
```

---

### `get_balance`
Returns Kalshi account balance.

```json
{
  "available_cash": 187.50,
  "portfolio_value": 42.00,
  "total": 229.50
}
```

---

### `get_positions`
Returns open positions and resting orders.

```json
{
  "open_positions": [
    {"ticker": "KXBTC15M-26APR181415-15", "contracts": 3, "value": 2.16}
  ],
  "resting_orders": [
    {"order_id": "...", "ticker": "...", "side": "yes", "contracts": 3, "price": 72}
  ]
}
```

---

### `cancel_order`
Cancels a resting order.

Arguments:
- `order_id` (string, required): from `get_positions.resting_orders`

```json
{"status": "cancelled", "order_id": "01234567-abcd-..."}
```

---

### `kelly_size`
Calculates Kelly-optimal contracts for a given trade without running the full signal.

Arguments:
- `p_win` (number): probability of winning (0–1)
- `price_cents` (integer): entry price in cents
- `bankroll` (number): account size in USD

```json
{
  "kelly_full": 0.312,
  "kelly_fraction": 0.35,
  "risk_pct": 10.92,
  "contracts": 4,
  "max_loss": 2.92,
  "ev_total": 1.84
}
```

## The `/trade` Skill

Register `~/.claude/commands/trade.md` to get a `/trade` slash command in Claude Code that runs the full autonomous trading loop:

```markdown
# Trade

Run a full Kalshi BTC trading cycle using the sentient-trader MCP tools:

1. Call `get_market` — check the active KXBTC15M window
2. Call `analyze_signal` with your current bankroll — run the full Markov signal
3. If `approved: true`, call `place_trade` using the exact `contracts`, `side`, and `limit_price` from step 2
4. Call `get_balance` and `get_positions` — report final state

Safety rules:
- Never trade if `approved` is false
- Never exceed the `contracts` value from `analyze_signal`
- Only trade in the 3–12 min window (or 6–9 for standard entries)
- Report all gate results even when no trade is placed
```

## Package Structure

```
sentient-trader-mcp/
├── pyproject.toml                      # setuptools build config, version, deps
├── README.md
├── .gitignore
├── .claude-plugin/marketplace.json     # Claude Code marketplace manifest
└── sentient_trader_mcp/
    ├── __init__.py                     # wraps async main() with asyncio.run()
    ├── __main__.py                     # entry point for python -m
    └── server.py                       # all logic (self-contained, ~600 lines)
```

`server.py` is fully standalone — it embeds the entire Markov math inline and has no dependency on `run_backtest.py`. It imports only: `asyncio`, `base64`, `json`, `math`, `os`, `time`, `datetime`, `pathlib`, `httpx`, `mcp`, `cryptography`.

## Entry Point Fix (Important)

The CLI entry point in `pyproject.toml` calls `sentient_trader_mcp:main` synchronously. `main()` is async. The `__init__.py` wraps it:

```python
import asyncio as _asyncio
from .server import main as _async_main

def main():
    _asyncio.run(_async_main())
```

Without this wrapper, running `sentient-trader` from the command line would print `<coroutine object main at 0x...>` and exit silently.

## Version History

| Version | Fix |
|---------|-----|
| 0.1.0 | Initial release |
| 0.1.1 | Fix asyncio.run() wrapper — entry point was silently no-op |
| 0.1.2 | Fix Kalshi API price fields (`yes_ask_dollars` normalization), DST-aware ET offset, lazy credential loading |
| 0.1.3 | Bump version (0.1.2 artifact already on PyPI from earlier build) |

## Testing Locally Before Upload

```bash
cd sentient-trader-mcp
python3 -c "
import asyncio, sys, json
sys.path.insert(0, '.')
from sentient_trader_mcp.server import _dispatch

async def test():
    r = await _dispatch('get_market', {})
    print(json.dumps(r, indent=2))

asyncio.run(test())
"
```

## Releasing to PyPI

```bash
cd sentient-trader-mcp

# Bump version in pyproject.toml AND sentient_trader_mcp/__init__.py
sed -i '' 's/0\.1\.3/0.1.4/g' pyproject.toml sentient_trader_mcp/__init__.py

# Rebuild
rm -rf dist && python3 -m build

# Validate
python3 -m twine check dist/*

# Upload (prompts for PyPI token)
python3 -m twine upload dist/*
```

PyPI will reject with `400 File already exists` if you try to upload the same version twice. Always bump the version.
