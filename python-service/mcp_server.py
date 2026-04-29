"""
Sentient Trading MCP Server

Exposes the Markov chain trading engine as tools Claude Code can call directly.
Claude can analyze markets, run the full signal stack, size positions with Kelly,
and place real Kalshi orders — acting as a fully autonomous trading agent.

Run with:
  source ~/.sentient-venv313/bin/activate
  python3 mcp_server.py

Register in ~/.claude/settings.json:
  "mcpServers": {
    "sentient-trader": {
      "type": "stdio",
      "command": "/bin/zsh",
      "args": ["-c", "source ~/.sentient-venv313/bin/activate && python3 /path/to/mcp_server.py"]
    }
  }
"""

import asyncio, json, math, os, sys, time, base64, hashlib, logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx
from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import Tool, TextContent, ImageContent, EmbeddedResource

# ── Import shared algo from run_backtest ──────────────────────────────────────
sys.path.insert(0, os.path.dirname(__file__))
from run_backtest import (
    fetch_candles_5m, fetch_candles_15m, fetch_settled_markets,
    build_markov_history, build_transition_matrix, predict_from_momentum,
    price_change_to_state, gk_vol, compute_hurst, simulate, process_market,
    MARKOV_MIN_GAP, MIN_PERSIST, KELLY_FRACTION, MAX_TRADE_PCT,
    MAX_ENTRY_PRICE_RM, MAX_ENTRY_PRICE_YES, MAX_ENTRY_PRICE_NO,
    MAKER_FEE_RATE, STARTING_CASH, DAYS_BACK,
    EMPIRICAL_PRICE_BY_D, BLOCKED_UTC_HOURS,
)

logging.basicConfig(level=logging.WARNING)

# ── Config ────────────────────────────────────────────────────────────────────
KALSHI_BASE  = "https://api.elections.kalshi.com/trade-api/v2"
NEXT_BASE    = os.environ.get("NEXT_BASE_URL", "http://localhost:3000")

# Load .env.local for Kalshi creds if not already in env
_env_path = Path(__file__).parent.parent / ".env.local"
if _env_path.exists():
    for line in _env_path.read_text().splitlines():
        if line and not line.startswith("#") and "=" in line:
            k, _, v = line.partition("=")
            os.environ.setdefault(k.strip(), v.strip())

KALSHI_API_KEY   = os.environ.get("KALSHI_API_KEY", "")
KALSHI_KEY_PATH  = os.environ.get("KALSHI_PRIVATE_KEY_PATH", "./kalshi_private.pem")

# ── Kalshi RSA-PSS auth ───────────────────────────────────────────────────────
def _build_kalshi_headers(method: str, path: str) -> dict:
    try:
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import padding
        import time as _time

        key_path = Path(KALSHI_KEY_PATH)
        if not key_path.is_absolute():
            key_path = Path(__file__).parent.parent / KALSHI_KEY_PATH
        private_key = serialization.load_pem_private_key(key_path.read_bytes(), password=None)

        ts  = str(int(_time.time() * 1000))
        msg = (ts + method.upper() + path).encode()
        sig = private_key.sign(msg, padding.PSS(
            mgf=padding.MGF1(hashes.SHA256()),
            salt_length=padding.PSS.DIGEST_LENGTH,
        ), hashes.SHA256())

        return {
            "KALSHI-ACCESS-KEY":       KALSHI_API_KEY,
            "KALSHI-ACCESS-TIMESTAMP": ts,
            "KALSHI-ACCESS-SIGNATURE": base64.b64encode(sig).decode(),
            "Content-Type": "application/json",
        }
    except Exception as e:
        return {"Content-Type": "application/json", "_auth_error": str(e)}


async def _kalshi_get(path: str, params: dict = {}) -> dict:
    headers = _build_kalshi_headers("GET", path)
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.get(f"{KALSHI_BASE}{path}", params=params, headers=headers)
        r.raise_for_status()
        return r.json()


async def _kalshi_post(path: str, body: dict) -> dict:
    headers = _build_kalshi_headers("POST", path)
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.post(f"{KALSHI_BASE}{path}", json=body, headers=headers)
        r.raise_for_status()
        return r.json()


async def _next_get(path: str) -> dict:
    """Call a Next.js API route (fallback if Kalshi direct auth fails)."""
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.get(f"{NEXT_BASE}{path}")
        r.raise_for_status()
        return r.json()


# ── Server ────────────────────────────────────────────────────────────────────
server = Server("sentient-trader")


@server.list_tools()
async def list_tools() -> list[Tool]:
    return [
        Tool(
            name="get_market",
            description=(
                "Get the current active KXBTC15M Kalshi market: strike price, "
                "BTC spot, yes/no ask prices, minutes until close. "
                "Call this first to understand the current betting opportunity."
            ),
            inputSchema={"type": "object", "properties": {}, "required": []},
        ),
        Tool(
            name="analyze_signal",
            description=(
                "Run the full Markov chain signal analysis on the current market. "
                "Returns: pYes, recommendation (YES/NO/NO_TRADE), Kelly position size, "
                "persist score, Hurst exponent, vol regime, and a full reasoning string. "
                "This is the core trading intelligence — use this to decide whether to trade."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "bankroll": {"type": "number", "description": "Current bankroll in USD (default 200)"},
                },
                "required": [],
            },
        ),
        Tool(
            name="place_trade",
            description=(
                "Place a real Kalshi limit order. Use ONLY after analyze_signal returns "
                "an approved recommendation with a clear edge. "
                "side: 'yes' or 'no'. ticker: market ticker from get_market. "
                "contracts: number of contracts (from analyze_signal positionSize). "
                "limit_price: cents (from analyze_signal). "
                "⚠ This places a REAL order with real money."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "ticker":      {"type": "string",  "description": "Market ticker e.g. KXBTC15M-26APR181545-T74999.99"},
                    "side":        {"type": "string",  "enum": ["yes", "no"]},
                    "contracts":   {"type": "integer", "description": "Number of contracts to buy"},
                    "limit_price": {"type": "integer", "description": "Limit price in cents (e.g. 71)"},
                },
                "required": ["ticker", "side", "contracts", "limit_price"],
            },
        ),
        Tool(
            name="get_balance",
            description="Get current Kalshi account balance (available cash in USD).",
            inputSchema={"type": "object", "properties": {}, "required": []},
        ),
        Tool(
            name="get_positions",
            description="Get current open Kalshi positions and resting orders.",
            inputSchema={"type": "object", "properties": {}, "required": []},
        ),
        Tool(
            name="cancel_order",
            description="Cancel a resting Kalshi limit order by order ID.",
            inputSchema={
                "type": "object",
                "properties": {
                    "order_id": {"type": "string", "description": "Kalshi order ID to cancel"},
                },
                "required": ["order_id"],
            },
        ),
        Tool(
            name="run_backtest",
            description=(
                "Run the 30-day historical backtest of the Markov trading strategy. "
                "Returns full stats: return %, win rate, profit factor, max drawdown, "
                "trade count, and price bucket breakdown. Takes ~30 seconds."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "days_back":     {"type": "integer", "description": "Days of history to test (default 30)"},
                    "starting_cash": {"type": "number",  "description": "Starting bankroll USD (default 200)"},
                },
                "required": [],
            },
        ),
        Tool(
            name="kelly_size",
            description=(
                "Calculate optimal Kelly position size for a given trade. "
                "Returns: full Kelly fraction, fractional Kelly (18%), contracts to buy, "
                "max loss, expected value."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "p_win":       {"type": "number", "description": "Estimated win probability (0-1)"},
                    "price_cents": {"type": "integer","description": "Entry price in cents"},
                    "bankroll":    {"type": "number", "description": "Current bankroll USD"},
                },
                "required": ["p_win", "price_cents", "bankroll"],
            },
        ),
    ]


@server.call_tool()
async def call_tool(name: str, arguments: dict) -> list[TextContent]:
    try:
        result = await _dispatch(name, arguments)
        return [TextContent(type="text", text=json.dumps(result, indent=2))]
    except Exception as e:
        return [TextContent(type="text", text=json.dumps({"error": str(e)}, indent=2))]


async def _dispatch(name: str, args: dict) -> Any:

    # ── get_market ────────────────────────────────────────────────────────────
    if name == "get_market":
        # Find active KXBTC15M market
        now = datetime.now(timezone.utc)
        # Build current event ticker
        months = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"]
        # Try current + next two 15-min windows
        markets_found = []
        for delta_min in [0, 15, 30]:
            import math as _math
            ts = now.timestamp() + delta_min * 60
            dt = datetime.fromtimestamp(ts, tz=timezone.utc)
            # Round up to next 15-min boundary
            mins_ceil = _math.ceil(dt.minute / 15) * 15
            if mins_ceil == 60:
                dt = dt.replace(minute=0, second=0)
                dt = dt.replace(hour=dt.hour + 1)
            else:
                dt = dt.replace(minute=mins_ceil, second=0)
            # Convert to ET (EDT = UTC-4)
            et_offset = -4
            et = dt.timestamp() + et_offset * 3600
            et_dt = datetime.fromtimestamp(et, tz=timezone.utc)
            event = f"KXBTC15M-{et_dt.strftime('%y')}{months[et_dt.month-1]}{et_dt.strftime('%d%H%M')}"
            try:
                data = await _kalshi_get("/markets", {"event_ticker": event, "status": "open"})
                for m in data.get("markets", []):
                    if m.get("yes_ask", 0) > 0:
                        markets_found.append(m)
            except Exception:
                pass

        if not markets_found:
            # Fallback: list series
            data = await _kalshi_get("/markets", {"series_ticker": "KXBTC15M", "status": "open", "limit": 5})
            markets_found = [m for m in data.get("markets", []) if m.get("yes_ask", 0) > 0]

        if not markets_found:
            return {"error": "No active KXBTC15M markets found"}

        m = markets_found[0]
        close_ms = 0
        if m.get("close_time"):
            try: close_ms = int(datetime.fromisoformat(m["close_time"].replace("Z","+00:00")).timestamp() * 1000)
            except: pass
        minutes_left = max(0, (close_ms - time.time() * 1000) / 60000) if close_ms else None

        # Get BTC price
        btc_price = 0.0
        try:
            async with httpx.AsyncClient(timeout=5) as client:
                r = await client.get("https://api.exchange.coinbase.com/products/BTC-USD/ticker")
                btc_price = float(r.json().get("price", 0))
        except: pass

        strike = float(m.get("floor_strike") or 0)
        above  = btc_price > strike if (btc_price and strike) else None

        return {
            "ticker":        m.get("ticker"),
            "event_ticker":  m.get("event_ticker"),
            "strike_price":  strike,
            "btc_price":     round(btc_price, 2),
            "above_strike":  above,
            "dist_pct":      round((btc_price - strike) / strike * 100, 4) if strike > 0 else None,
            "yes_ask":       m.get("yes_ask"),
            "no_ask":        m.get("no_ask"),
            "yes_bid":       m.get("yes_bid"),
            "no_bid":        m.get("no_bid"),
            "minutes_left":  round(minutes_left, 1) if minutes_left is not None else None,
            "close_time":    m.get("close_time"),
            "status":        m.get("status"),
        }

    # ── analyze_signal ────────────────────────────────────────────────────────
    elif name == "analyze_signal":
        bankroll = float(args.get("bankroll", 200))

        # Get market + BTC price (reuse get_market logic)
        market_info = await _dispatch("get_market", {})
        if "error" in market_info:
            return market_info

        strike       = market_info["strike_price"]
        btc_price    = market_info["btc_price"]
        dist_pct     = market_info["dist_pct"] or 0.0
        minutes_left = market_info["minutes_left"] or 7.5
        yes_ask      = market_info["yes_ask"] or 50
        no_ask       = market_info["no_ask"]  or 50
        ticker       = market_info["ticker"]

        if strike <= 0 or btc_price <= 0:
            return {"error": "Cannot analyze — missing strike or BTC price"}

        # Fetch candles for Markov + indicators
        candles_5m  = fetch_candles_5m(days_back=2)
        candles_15m = fetch_candles_15m(days_back=2)

        check_ts = time.time()
        above_strike = btc_price >= strike

        # GK vol
        ctx15 = [c for c in candles_15m if c[0] + 900 <= check_ts]
        last_15m = list(reversed(ctx15[-32:])) if len(ctx15) >= 12 else []
        gk = gk_vol(last_15m[:16]) if last_15m else None
        hurst = compute_hurst(last_15m[:24]) if last_15m else None

        # d-score
        d_score = None
        if gk and gk > 0:
            try:
                candles_left = max(minutes_left / 15.0, 1/60)
                d_score = math.log(btc_price / strike) / (gk * math.sqrt(candles_left))
            except: pass

        # Markov signal
        history = build_markov_history(candles_5m, check_ts)
        c5_by_ts = {c[0]: c for c in candles_5m}
        c5_ts  = int(check_ts // 300) * 300 - 300
        c5_bar  = c5_by_ts.get(c5_ts) or c5_by_ts.get(c5_ts - 300)
        c5_prev = c5_by_ts.get(c5_ts - 300)

        current_state = 4
        if c5_bar and c5_prev and c5_prev[4] > 0:
            current_state = price_change_to_state((c5_bar[4] - c5_prev[4]) / c5_prev[4] * 100.0)

        full_history = (history + [current_state]) if history else [current_state, current_state]
        P            = build_transition_matrix(full_history)
        forecast     = predict_from_momentum(P, current_state, minutes_left, dist_pct)
        p_yes        = forecast["p_yes"]
        gap          = abs(p_yes - 0.5)
        persist      = forecast["persist"]
        has_history  = len(full_history) >= 20

        # Gates
        utc_hour = datetime.now(timezone.utc).hour
        blocked  = utc_hour in BLOCKED_UTC_HOURS
        vol_ok   = gk is None or gk <= 0.002 * 1.25
        hurst_ok = hurst is None or hurst >= 0.50
        markov_ok = has_history and gap >= MARKOV_MIN_GAP and persist >= MIN_PERSIST
        time_ok  = 3 <= minutes_left <= 12 if (65 <= yes_ask <= 73) else 6 <= minutes_left <= 9

        # Entry price
        d_abs = abs(d_score) if d_score is not None else 0
        in_money_price = 80.0
        for d_lo, d_hi, emp_p in EMPIRICAL_PRICE_BY_D:
            if d_lo <= d_abs < d_hi:
                in_money_price = emp_p; break
        side_is_yes = p_yes > 0.5
        limit_price = round(yes_ask if side_is_yes else no_ask)
        price_cap   = MAX_ENTRY_PRICE_YES if side_is_yes else MAX_ENTRY_PRICE_NO
        price_ok    = limit_price <= price_cap

        rec = "NO_TRADE"
        if markov_ok and not blocked and vol_ok and hurst_ok and time_ok and price_ok:
            rec = "YES" if side_is_yes else "NO"

        # Kelly sizing
        p_win        = p_yes if rec == "YES" else (1 - p_yes)
        p_dollars    = limit_price / 100
        fee_per_c    = MAKER_FEE_RATE * p_dollars * (1 - p_dollars)
        net_win      = (1 - p_dollars) - fee_per_c
        total_cost   = p_dollars + fee_per_c
        b_odds       = net_win / total_cost if total_cost > 0 else 1.0
        kelly_full   = max(0.0, (b_odds * p_win - (1 - p_win)) / b_odds) if rec != "NO_TRADE" else 0
        risk_pct     = min(MAX_TRADE_PCT, KELLY_FRACTION * kelly_full)
        # Tiered Kelly for golden zone
        if 65 <= limit_price <= 73:   risk_pct = min(0.35 * kelly_full, MAX_TRADE_PCT)
        elif 73 < limit_price <= 79:  risk_pct = min(0.12 * kelly_full, MAX_TRADE_PCT)
        dyn_cap      = max(25, round(bankroll / 200 * 25))
        contracts    = min(max(1, round(bankroll * risk_pct / total_cost)), dyn_cap) if rec != "NO_TRADE" else 0
        max_loss     = round(total_cost * contracts, 2) if contracts > 0 else 0
        ev           = round(contracts * (net_win * p_win - total_cost * (1 - p_win)), 2)

        reasons = []
        if not has_history:    reasons.append(f"building Markov history ({len(full_history)}/20)")
        if not markov_ok:      reasons.append(f"Markov gap {gap:.3f} < {MARKOV_MIN_GAP} or persist {persist:.2f} < {MIN_PERSIST}")
        if blocked:            reasons.append(f"blocked UTC hour {utc_hour}")
        if not vol_ok:         reasons.append(f"high vol regime (GK={gk:.4f})")
        if not hurst_ok:       reasons.append(f"mean-reverting (Hurst={hurst:.2f})")
        if not time_ok:        reasons.append(f"timing: {minutes_left:.1f}min outside window")
        if not price_ok:       reasons.append(f"price {limit_price}¢ > {'YES' if side_is_yes else 'NO'} cap {price_cap}¢")

        return {
            "recommendation":   rec,
            "approved":         rec != "NO_TRADE",
            "ticker":           ticker,
            "side":             rec.lower() if rec != "NO_TRADE" else None,
            "limit_price":      limit_price,
            "contracts":        contracts,
            "max_loss_usd":     max_loss,
            "expected_value":   ev,
            "signal": {
                "p_yes":          round(p_yes, 4),
                "gap":            round(gap, 4),
                "persist":        round(persist, 3),
                "current_state":  current_state,
                "history_len":    len(full_history),
                "hurst":          round(hurst, 3) if hurst else None,
                "gk_vol":         round(gk, 6) if gk else None,
                "d_score":        round(d_score, 3) if d_score is not None else None,
                "minutes_left":   round(minutes_left, 1),
                "utc_hour":       utc_hour,
            },
            "gates": {
                "markov":    markov_ok,
                "timing":    time_ok,
                "vol":       vol_ok,
                "hurst":     hurst_ok,
                "price_cap": price_ok,
                "not_blocked": not blocked,
            },
            "rejection_reasons": reasons,
            "market": market_info,
        }

    # ── place_trade ───────────────────────────────────────────────────────────
    elif name == "place_trade":
        ticker      = args["ticker"]
        side        = args["side"]
        contracts   = int(args["contracts"])
        limit_price = int(args["limit_price"])

        if contracts <= 0:
            return {"error": "contracts must be > 0"}
        if limit_price <= 0 or limit_price >= 100:
            return {"error": "limit_price must be 1–99 cents"}

        path = "/portfolio/orders"
        body = {
            "ticker":      ticker,
            "action":      "buy",
            "side":        side,
            "type":        "limit",
            "count":       contracts,
            "yes_price":   limit_price if side == "yes" else (100 - limit_price),
            "no_price":    limit_price if side == "no"  else (100 - limit_price),
        }

        try:
            result = await _kalshi_post(path, {"order": body})
            order  = result.get("order", result)
            return {
                "status":     "placed",
                "order_id":   order.get("order_id") or order.get("id"),
                "ticker":     ticker,
                "side":       side,
                "contracts":  contracts,
                "limit_price": limit_price,
                "estimated_cost": round(contracts * (limit_price / 100 + MAKER_FEE_RATE * (limit_price/100) * (1 - limit_price/100)), 2),
                "raw":        order,
            }
        except httpx.HTTPStatusError as e:
            return {"error": f"Kalshi API error {e.response.status_code}: {e.response.text}"}

    # ── get_balance ───────────────────────────────────────────────────────────
    elif name == "get_balance":
        try:
            data = await _kalshi_get("/portfolio/balance")
            bal  = data.get("balance", {})
            return {
                "available_cash":   bal.get("available_balance_cents", 0) / 100,
                "portfolio_value":  bal.get("portfolio_value_cents",  0) / 100,
                "total_value":      (bal.get("available_balance_cents", 0) + bal.get("portfolio_value_cents", 0)) / 100,
                "raw": bal,
            }
        except Exception as e:
            # Fallback to Next.js API
            try:
                data = await _next_get("/api/balance")
                return data
            except:
                return {"error": str(e)}

    # ── get_positions ─────────────────────────────────────────────────────────
    elif name == "get_positions":
        try:
            pos_data = await _kalshi_get("/portfolio/positions", {"settlement_status": "unsettled"})
            ord_data = await _kalshi_get("/portfolio/orders",   {"status": "resting"})
            positions = pos_data.get("market_positions", [])
            orders    = ord_data.get("orders", [])
            return {
                "open_positions": [
                    {
                        "ticker":         p.get("ticker"),
                        "yes_contracts":  p.get("position"),
                        "market_value":   round(p.get("market_exposure_cents", 0) / 100, 2),
                    }
                    for p in positions if p.get("position", 0) != 0
                ],
                "resting_orders": [
                    {
                        "order_id":   o.get("order_id") or o.get("id"),
                        "ticker":     o.get("ticker"),
                        "side":       o.get("side"),
                        "contracts":  o.get("remaining_count"),
                        "price":      o.get("yes_price"),
                    }
                    for o in orders
                ],
            }
        except Exception as e:
            return {"error": str(e)}

    # ── cancel_order ──────────────────────────────────────────────────────────
    elif name == "cancel_order":
        order_id = args["order_id"]
        try:
            headers = _build_kalshi_headers("DELETE", f"/portfolio/orders/{order_id}")
            async with httpx.AsyncClient(timeout=10) as client:
                r = await client.delete(f"{KALSHI_BASE}/portfolio/orders/{order_id}", headers=headers)
                r.raise_for_status()
            return {"status": "cancelled", "order_id": order_id}
        except Exception as e:
            return {"error": str(e)}

    # ── run_backtest ──────────────────────────────────────────────────────────
    elif name == "run_backtest":
        import subprocess, sys as _sys
        days         = int(args.get("days_back", 30))
        starting     = float(args.get("starting_cash", 200))

        # Patch constants and run
        import run_backtest as _bt
        _orig_days = _bt.DAYS_BACK
        _orig_cash = _bt.STARTING_CASH
        _bt.DAYS_BACK      = days
        _bt.STARTING_CASH  = starting
        try:
            markets     = _bt.fetch_settled_markets(days)
            candles_15m = _bt.fetch_candles_15m(days + 5)
            candles_5m  = _bt.fetch_candles_5m(days + 5)
            records = []
            for mkt in markets:
                r = _bt.process_market(mkt, candles_15m, candles_5m)
                if r: records.append(r)
            records.sort(key=lambda r: r["entry_dt"])
            final_cash = _bt.simulate(records)
            executed   = [r for r in records if r.get("contracts", 0) > 0]
            wins       = [r for r in executed if r.get("outcome_sim", r["outcome"]) == "WIN"]
            losses     = [r for r in executed if r.get("outcome_sim", r["outcome"]) == "LOSS"]
            gw = sum(r["pnl"] for r in wins)
            gl = abs(sum(r["pnl"] for r in losses))
            # Max drawdown
            peak = starting; max_dd = 0.0
            for r in executed:
                peak   = max(peak, r["cash_after"])
                max_dd = max(max_dd, (peak - r["cash_after"]) / peak * 100)
            # Bucket breakdown
            buckets = {}
            for lo, hi, label in [(0,65,"<65¢"),(65,73,"65-73¢"),(73,79,"73-79¢"),(79,85,"79-85¢")]:
                bt = [r for r in executed if lo <= r["limit_price_cents"] < hi]
                bw = [r for r in bt if r.get("outcome_sim", r["outcome"]) == "WIN"]
                if bt: buckets[label] = {"trades": len(bt), "wr": round(len(bw)/len(bt)*100, 1), "pnl": round(sum(r["pnl"] for r in bt), 2)}
            return {
                "days_back":       days,
                "starting_cash":   starting,
                "final_cash":      round(final_cash, 2),
                "total_return_pct": round((final_cash / starting - 1) * 100, 1),
                "win_rate_pct":    round(len(wins) / max(len(executed), 1) * 100, 1),
                "profit_factor":   round(gw / max(gl, 0.01), 2),
                "max_drawdown_pct": round(max_dd, 1),
                "total_trades":    len(executed),
                "total_wins":      len(wins),
                "total_losses":    len(losses),
                "price_buckets":   buckets,
            }
        finally:
            _bt.DAYS_BACK     = _orig_days
            _bt.STARTING_CASH = _orig_cash

    # ── kelly_size ────────────────────────────────────────────────────────────
    elif name == "kelly_size":
        p_win       = float(args["p_win"])
        price_cents = int(args["price_cents"])
        bankroll    = float(args["bankroll"])
        p           = price_cents / 100
        fee         = MAKER_FEE_RATE * p * (1 - p)
        net_win     = (1 - p) - fee
        total_cost  = p + fee
        b           = net_win / total_cost if total_cost > 0 else 1.0
        kelly_full  = max(0.0, (b * p_win - (1 - p_win)) / b)
        # Tiered
        if 65 <= price_cents <= 73: frac = 0.35
        elif price_cents <= 79:     frac = 0.12
        elif price_cents <= 85:     frac = 0.08
        else:                       frac = 0.05
        risk_pct    = min(MAX_TRADE_PCT, frac * kelly_full)
        dyn_cap     = max(25, round(bankroll / 200 * 25))
        contracts   = min(max(1, round(bankroll * risk_pct / total_cost)), dyn_cap)
        max_loss    = round(total_cost * contracts, 2)
        ev_per_c    = net_win * p_win - total_cost * (1 - p_win)
        return {
            "kelly_full":      round(kelly_full, 4),
            "kelly_fraction":  frac,
            "risk_pct":        round(risk_pct * 100, 2),
            "contracts":       contracts,
            "dynamic_cap":     dyn_cap,
            "cost_per_c":      round(total_cost, 4),
            "max_loss":        max_loss,
            "ev_per_contract": round(ev_per_c, 4),
            "total_ev":        round(ev_per_c * contracts, 2),
        }

    return {"error": f"Unknown tool: {name}"}


# ── Entry point ───────────────────────────────────────────────────────────────
async def main():
    async with stdio_server() as (read, write):
        await server.run(read, write, server.create_initialization_options())

if __name__ == "__main__":
    asyncio.run(main())
