"""
sentient-trader-mcp — Autonomous Kalshi BTC trading engine for Claude Code

Exposes 7 tools: get_market, analyze_signal, place_trade,
get_balance, get_positions, cancel_order, kelly_size.

Set credentials before running:
  export KALSHI_API_KEY=your-key-id
  export KALSHI_PRIVATE_KEY_PATH=~/.kalshi/private_key.pem

Or put them in ~/.sentient-trader/config.env
"""

import asyncio, base64, json, math, os, time
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any, Optional

import httpx
from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import Tool, TextContent

# ── Credential loading ─────────────────────────────────────────────────────────
def _load_env():
    for p in [
        Path.home() / ".sentient-trader" / "config.env",
        Path.cwd() / ".env.local",
        Path.cwd() / ".env",
    ]:
        if p.exists():
            for line in p.read_text().splitlines():
                if line and not line.startswith("#") and "=" in line:
                    k, _, v = line.partition("=")
                    os.environ.setdefault(k.strip(), v.strip())

_load_env()

KALSHI_BASE   = "https://api.elections.kalshi.com/trade-api/v2"
COINBASE_BASE = "https://api.exchange.coinbase.com"

def _kalshi_key() -> str:
    _load_env()
    return os.environ.get("KALSHI_API_KEY", "")

def _kalshi_pem() -> str:
    _load_env()
    return os.environ.get("KALSHI_PRIVATE_KEY_PATH", "")

# ── Strategy constants (overridable via env) ───────────────────────────────────
MARKOV_MIN_GAP  = float(os.environ.get("MARKOV_MIN_GAP",  "0.11"))
MIN_PERSIST     = float(os.environ.get("MIN_PERSIST",     "0.82"))
MAX_ENTRY_PRICE = int(  os.environ.get("MAX_ENTRY_PRICE", "72"))
MAX_VOL_MULT    = float(os.environ.get("MAX_VOL_MULT",    "1.25"))
MIN_HURST       = float(os.environ.get("MIN_HURST",       "0.50"))
MAKER_FEE_RATE  = 0.0175
MAX_TRADE_PCT   = 0.20
KELLY_FRACTION  = 0.18
BLOCKED_HOURS   = {11, 18}
REF_VOL_15M     = 0.002

# ── Markov chain internals ─────────────────────────────────────────────────────
NUM_STATES    = 9
MARKOV_CANDLE = 5
MARKOV_WINDOW = 480
MIN_HISTORY   = 20
STATE_BOUNDS  = [-3.35, -2.24, -1.12, -0.45, 0.45, 1.12, 2.24, 3.35]
STATE_RETURNS = [-2.0, -1.25, -0.75, -0.35, 0.0,  0.35, 0.75, 1.25, 2.0]
STATE_VOL     = [ 1.0,  0.35,  0.25,  0.15, 0.10, 0.15, 0.25, 0.35, 1.0]

EMPIRICAL_PRICE_BY_D = [
    (0.0, 0.5,  62.3), (0.5, 0.8, 72.7), (0.8, 1.0, 79.1),
    (1.0, 1.2,  80.8), (1.2, 1.5, 84.6), (1.5, 2.0, 83.6),
    (2.0, 99.0, 71.0),
]

# ── Math ───────────────────────────────────────────────────────────────────────
def _norm_cdf(z: float) -> float:
    s = 1 if z >= 0 else -1
    x = abs(z)
    t = 1.0 / (1.0 + 0.2316419 * x)
    p = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))))
    return 0.5 + s * (0.5 - math.exp(-0.5 * x * x) / math.sqrt(2 * math.pi) * p)

def _state(pct: float) -> int:
    for i, b in enumerate(STATE_BOUNDS):
        if pct < b: return i
    return NUM_STATES - 1

def _transition_matrix(history: list) -> list:
    counts = [[0.0] * NUM_STATES for _ in range(NUM_STATES)]
    for i in range(len(history) - 1):
        s, t = history[i], history[i + 1]
        if 0 <= s < NUM_STATES and 0 <= t < NUM_STATES:
            counts[s][t] += 1.0
    return [
        ([v / sum(row) for v in row] if sum(row) > 0 else [1 / NUM_STATES] * NUM_STATES)
        for row in counts
    ]

def _predict(P: list, state: int, minutes_left: float, dist_pct: float) -> dict:
    T = max(1, round(minutes_left / MARKOV_CANDLE))
    req = -dist_pct
    dist = [0.0] * NUM_STATES
    dist[state] = 1.0
    exp_drift = var_sum = 0.0
    for _ in range(T):
        sm = sum(dist[i] * STATE_RETURNS[i] for i in range(NUM_STATES))
        se = sum(dist[i] * (STATE_VOL[i] ** 2 + STATE_RETURNS[i] ** 2) for i in range(NUM_STATES))
        exp_drift += sm
        var_sum   += max(0.0, se - sm ** 2)
        nxt = [0.0] * NUM_STATES
        for i in range(NUM_STATES):
            for j in range(NUM_STATES):
                nxt[j] += dist[i] * P[i][j]
        dist = nxt
    sigma = math.sqrt(max(var_sum, 0.01))
    p_yes = _norm_cdf((exp_drift - req) / sigma)
    return {"p_yes": p_yes, "persist": P[state][state], "sigma": sigma,
            "exp_drift": exp_drift}

def _gk_vol(candles: list) -> Optional[float]:
    K = 2 * math.log(2) - 1
    terms = []
    for c in candles:
        lo, hi, op, cl = c[1], c[2], c[3], c[4]
        if op > 0 and lo > 0 and hi > 0:
            terms.append(0.5 * math.log(hi / lo) ** 2 - K * math.log(cl / op) ** 2)
    return math.sqrt(max(0.0, sum(terms) / len(terms))) if len(terms) >= 2 else None

def _hurst(candles: list) -> Optional[float]:
    closes = [c[4] for c in reversed(candles)]
    if len(closes) < 12: return None
    lr = [math.log(closes[i] / closes[i-1]) for i in range(1, len(closes)) if closes[i-1] > 0]
    if len(lr) < 6: return None
    v1 = sum(r * r for r in lr) / len(lr)
    pairs = [lr[i] + lr[i+1] for i in range(0, len(lr) - 1, 2)]
    v2 = sum(r * r for r in pairs) / max(len(pairs), 1) if pairs else 0
    if v1 <= 0: return None
    return max(0.0, min(1.0, 0.5 + math.log(max(v2 / (2 * v1), 1e-12)) / (2 * math.log(2))))

def _markov_history(candles_5m: list, up_to_ts: float) -> list:
    relevant = [c for c in candles_5m if c[0] + MARKOV_CANDLE * 60 <= up_to_ts]
    if len(relevant) < 2: return []
    states = []
    for i in range(1, len(relevant)):
        prev, curr = relevant[i-1][4], relevant[i][4]
        if prev > 0:
            states.append(_state((curr - prev) / prev * 100.0))
    return states[-MARKOV_WINDOW:]

# ── Candle fetching (Coinbase Exchange — same feed Kalshi settles against) ─────
async def _fetch_candles(granularity: int, days: int = 2) -> list:
    end   = int(time.time())
    start = end - days * 86400
    chunk = 300 * granularity
    candles: list = []
    t = start
    async with httpx.AsyncClient(timeout=20) as client:
        while t < end:
            t_end = min(t + chunk, end)
            try:
                r = await client.get(
                    f"{COINBASE_BASE}/products/BTC-USD/candles",
                    params={"granularity": granularity, "start": t, "end": t_end},
                )
                r.raise_for_status()
                for c in r.json():
                    # [time, low, high, open, close, volume]
                    candles.append([int(c[0]), float(c[1]), float(c[2]),
                                    float(c[3]), float(c[4]), float(c[5])])
            except Exception:
                pass
            t = t_end
            await asyncio.sleep(0.1)
    candles.sort(key=lambda c: c[0])
    return candles

async def _btc_spot() -> float:
    try:
        async with httpx.AsyncClient(timeout=5) as c:
            r = await c.get(f"{COINBASE_BASE}/products/BTC-USD/ticker")
            return float(r.json().get("price", 0))
    except Exception:
        return 0.0

# ── Kalshi auth ────────────────────────────────────────────────────────────────
def _headers(method: str, path: str) -> dict:
    api_key = _kalshi_key()
    pem_path = _kalshi_pem()
    if not api_key:
        raise RuntimeError(
            "KALSHI_API_KEY not set. "
            "Add it to ~/.sentient-trader/config.env or set as an environment variable."
        )
    if not pem_path:
        raise RuntimeError(
            "KALSHI_PRIVATE_KEY_PATH not set. "
            "Add it to ~/.sentient-trader/config.env pointing to your RSA .pem key."
        )
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding as _pad
    key_path = Path(pem_path).expanduser()
    pk  = serialization.load_pem_private_key(key_path.read_bytes(), password=None)
    ts  = str(int(time.time() * 1000))
    sig = pk.sign(
        (ts + method.upper() + path).encode(),
        _pad.PSS(mgf=_pad.MGF1(hashes.SHA256()), salt_length=_pad.PSS.DIGEST_LENGTH),
        hashes.SHA256(),
    )
    return {
        "KALSHI-ACCESS-KEY":       api_key,
        "KALSHI-ACCESS-TIMESTAMP": ts,
        "KALSHI-ACCESS-SIGNATURE": base64.b64encode(sig).decode(),
        "Content-Type": "application/json",
    }

async def _kget(path: str, params: dict = {}) -> dict:
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.get(f"{KALSHI_BASE}{path}", params=params, headers=_headers("GET", path))
        r.raise_for_status()
        return r.json()

async def _kpost(path: str, body: dict) -> dict:
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.post(f"{KALSHI_BASE}{path}", json=body, headers=_headers("POST", path))
        r.raise_for_status()
        return r.json()

# ── Market normalization ───────────────────────────────────────────────────────
def _norm_market(m: dict) -> dict:
    """Kalshi API now returns prices as yes_ask_dollars (string USD). Convert to
    integer cents in the legacy yes_ask / no_ask fields so downstream code is consistent."""
    for field, dollar_field in [
        ("yes_ask", "yes_ask_dollars"), ("yes_bid", "yes_bid_dollars"),
        ("no_ask",  "no_ask_dollars"),  ("no_bid",  "no_bid_dollars"),
    ]:
        if not m.get(field) and m.get(dollar_field):
            try:
                m[field] = round(float(m[dollar_field]) * 100)
            except (ValueError, TypeError):
                pass
    return m

# ── Market discovery ───────────────────────────────────────────────────────────
def _et_offset() -> int:
    """DST-aware Eastern Time offset from UTC (returns -4 or -5)."""
    now = datetime.now(timezone.utc)
    # EDT: 2nd Sunday March → 1st Sunday November
    year = now.year
    # 2nd Sunday in March
    mar = datetime(year, 3, 8, 2, tzinfo=timezone.utc)
    mar += timedelta(days=(6 - mar.weekday()) % 7)
    # 1st Sunday in November
    nov = datetime(year, 11, 1, 2, tzinfo=timezone.utc)
    nov += timedelta(days=(6 - nov.weekday()) % 7)
    return -4 if mar <= now < nov else -5

async def _active_market() -> Optional[dict]:
    months = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"]
    now = datetime.now(timezone.utc)
    off = _et_offset()

    # Build candidate event tickers: current window close + next two
    candidates = []
    for delta_min in [0, 15, 30]:
        ts = now.timestamp() + delta_min * 60
        dt = datetime.fromtimestamp(ts, tz=timezone.utc)
        et = (dt + timedelta(hours=off)).replace(second=0, microsecond=0)
        nxt = (et.minute // 15 + 1) * 15
        if nxt >= 60:
            et = et.replace(minute=0) + timedelta(hours=1)
        else:
            et = et.replace(minute=nxt)
        candidates.append(f"KXBTC15M-{et.strftime('%y')}{months[et.month-1]}{et.strftime('%d%H%M')}")

    for event in candidates:
        try:
            data = await _kget("/markets", {"event_ticker": event, "status": "open"})
            markets = [_norm_market(m) for m in data.get("markets", [])]
            tradeable = [m for m in markets if (m.get("yes_ask") or 0) > 0]
            if tradeable:
                return tradeable[0]
            if markets:
                return markets[0]
        except Exception:
            pass

    # Fallback: list all open KXBTC15M markets
    try:
        data = await _kget("/markets", {"series_ticker": "KXBTC15M", "status": "open", "limit": 10})
        markets = [_norm_market(m) for m in data.get("markets", [])]
        tradeable = [m for m in markets if (m.get("yes_ask") or 0) > 0]
        if tradeable:
            return tradeable[0]
        if markets:
            return markets[0]
    except Exception:
        pass
    return None

# ── Signal analysis ────────────────────────────────────────────────────────────
async def _analyze(market: dict, bankroll: float) -> dict:
    strike   = float(market.get("floor_strike") or 0)
    yes_ask  = int(market.get("yes_ask") or 50)
    no_ask   = int(market.get("no_ask")  or 50)
    ticker   = market.get("ticker", "")
    close_ts = 0.0
    if market.get("close_time"):
        try:
            close_ts = datetime.fromisoformat(
                market["close_time"].replace("Z", "+00:00")
            ).timestamp()
        except Exception:
            pass

    btc_price    = await _btc_spot()
    minutes_left = max(0.0, (close_ts - time.time()) / 60) if close_ts else 7.5
    dist_pct     = (btc_price - strike) / strike * 100 if strike > 0 else 0.0

    # Fetch candles in parallel
    c5, c15 = await asyncio.gather(
        _fetch_candles(300, days=2),    # 5-min
        _fetch_candles(900, days=2),    # 15-min
    )

    check_ts = time.time()

    # Indicators
    ctx15 = [c for c in c15 if c[0] + 900 <= check_ts]
    last15 = list(reversed(ctx15[-32:])) if len(ctx15) >= 12 else []
    gk    = _gk_vol(last15[:16]) if last15 else None
    hurst = _hurst(last15[:24])  if last15 else None

    # d-score
    d_score = None
    if gk and gk > 0 and strike > 0:
        try:
            d_score = math.log(btc_price / strike) / (gk * math.sqrt(max(minutes_left / 15.0, 1/60)))
        except Exception:
            pass

    # Markov
    history = _markov_history(c5, check_ts)
    c5_by_ts = {c[0]: c for c in c5}
    c5_ts    = int(check_ts // 300) * 300 - 300
    c5_bar   = c5_by_ts.get(c5_ts) or c5_by_ts.get(c5_ts - 300)
    c5_prev  = c5_by_ts.get(c5_ts - 300)
    cur_state = 4
    if c5_bar and c5_prev and c5_prev[4] > 0:
        cur_state = _state((c5_bar[4] - c5_prev[4]) / c5_prev[4] * 100.0)

    full_history = (history + [cur_state]) if history else [cur_state, cur_state]
    P            = _transition_matrix(full_history)
    forecast     = _predict(P, cur_state, minutes_left, dist_pct)
    p_yes        = forecast["p_yes"]
    gap          = abs(p_yes - 0.5)
    persist      = forecast["persist"]
    has_history  = len(full_history) >= MIN_HISTORY

    # Gates
    utc_hour  = datetime.now(timezone.utc).hour
    blocked   = utc_hour in BLOCKED_HOURS
    vol_ok    = gk is None or gk <= REF_VOL_15M * MAX_VOL_MULT
    hurst_ok  = hurst is None or hurst >= MIN_HURST
    markov_ok = has_history and gap >= MARKOV_MIN_GAP and persist >= MIN_PERSIST
    is_golden = 65 <= yes_ask <= 73
    time_ok   = (3 <= minutes_left <= 12) if is_golden else (6 <= minutes_left <= 9)
    limit_price = round(yes_ask if p_yes > 0.5 else no_ask)
    price_ok  = limit_price <= MAX_ENTRY_PRICE
    dist_ok   = abs(dist_pct) >= 0.02

    reasons: list[str] = []
    if not has_history:  reasons.append(f"building Markov history ({len(full_history)}/20)")
    if not markov_ok:    reasons.append(f"gap {gap:.3f} < {MARKOV_MIN_GAP} or persist {persist:.2f} < {MIN_PERSIST}")
    if blocked:          reasons.append(f"blocked UTC hour {utc_hour}:00")
    if not vol_ok:       reasons.append(f"high vol GK={gk:.5f}" if gk else "vol unavailable")
    if not hurst_ok:     reasons.append(f"mean-reverting Hurst={hurst:.2f}" if hurst else "hurst unavailable")
    if not time_ok:      reasons.append(f"{minutes_left:.1f}min outside {'3-12' if is_golden else '6-9'}min window")
    if not price_ok:     reasons.append(f"price {limit_price}¢ > {MAX_ENTRY_PRICE}¢ cap")
    if not dist_ok:      reasons.append(f"near-strike noise dist={dist_pct:.4f}%")

    all_ok = markov_ok and not blocked and vol_ok and hurst_ok and time_ok and price_ok and dist_ok
    rec    = ("YES" if p_yes > 0.5 else "NO") if all_ok else "NO_TRADE"

    # Kelly sizing (tiered by price zone)
    p_d     = limit_price / 100
    fee_c   = MAKER_FEE_RATE * p_d * (1 - p_d)
    net_win = (1 - p_d) - fee_c
    cost_c  = p_d + fee_c
    b       = net_win / cost_c if cost_c > 0 else 1.0
    p_win   = p_yes if rec == "YES" else (1 - p_yes)
    kf      = max(0.0, (b * p_win - (1 - p_win)) / b) if rec != "NO_TRADE" else 0.0
    frac    = 0.35 if 65 <= limit_price <= 73 else \
              0.12 if limit_price <= 79 else \
              0.08 if limit_price <= 85 else 0.05
    risk_pct   = min(MAX_TRADE_PCT, frac * kf)
    dyn_cap    = max(25, round(bankroll / 200 * 25))
    contracts  = min(max(1, round(bankroll * risk_pct / cost_c)), dyn_cap) if rec != "NO_TRADE" else 0
    max_loss   = round(cost_c * contracts, 2)
    ev         = round(contracts * (net_win * p_win - cost_c * (1 - p_win)), 2)

    return {
        "approved":          rec != "NO_TRADE",
        "recommendation":    rec,
        "ticker":            ticker,
        "limit_price":       limit_price,
        "contracts":         contracts,
        "max_loss_usd":      max_loss,
        "expected_value":    ev,
        "rejection_reasons": reasons,
        "signal": {
            "p_yes":        round(p_yes, 4),
            "gap":          round(gap, 4),
            "persist":      round(persist, 3),
            "hurst":        round(hurst, 3) if hurst else None,
            "gk_vol":       round(gk, 6)   if gk    else None,
            "d_score":      round(d_score, 3) if d_score is not None else None,
            "minutes_left": round(minutes_left, 1),
            "history_len":  len(full_history),
            "utc_hour":     utc_hour,
            "is_golden":    is_golden,
        },
        "market": {
            "btc_price": round(btc_price, 2),
            "strike":    strike,
            "dist_pct":  round(dist_pct, 4),
            "yes_ask":   yes_ask,
            "no_ask":    no_ask,
        },
    }

# ── MCP server ─────────────────────────────────────────────────────────────────
server = Server("sentient-trader")

@server.list_tools()
async def list_tools() -> list[Tool]:
    return [
        Tool(name="get_market",
             description="Get the current active KXBTC15M Kalshi market: strike price, BTC spot, yes/no prices, minutes until close.",
             inputSchema={"type": "object", "properties": {}, "required": []}),
        Tool(name="analyze_signal",
             description="Run the full Markov chain signal. Returns recommendation (YES/NO/NO_TRADE), position size, and all gate results. This is the core decision engine.",
             inputSchema={"type": "object", "properties": {
                 "bankroll": {"type": "number", "description": "Current bankroll USD (default 200)"}
             }, "required": []}),
        Tool(name="place_trade",
             description="Place a real Kalshi limit order. Only call after analyze_signal returns approved=true. ⚠ Places a REAL order.",
             inputSchema={"type": "object", "required": ["ticker", "side", "contracts", "limit_price"],
                 "properties": {
                     "ticker":      {"type": "string"},
                     "side":        {"type": "string", "enum": ["yes", "no"]},
                     "contracts":   {"type": "integer"},
                     "limit_price": {"type": "integer", "description": "Cents (e.g. 71)"},
                 }}),
        Tool(name="get_balance",
             description="Get current Kalshi account balance.",
             inputSchema={"type": "object", "properties": {}, "required": []}),
        Tool(name="get_positions",
             description="Get open Kalshi positions and resting orders.",
             inputSchema={"type": "object", "properties": {}, "required": []}),
        Tool(name="cancel_order",
             description="Cancel a resting Kalshi limit order by order ID.",
             inputSchema={"type": "object", "required": ["order_id"],
                 "properties": {"order_id": {"type": "string"}}}),
        Tool(name="kelly_size",
             description="Calculate Kelly-optimal position size for a given trade.",
             inputSchema={"type": "object", "required": ["p_win", "price_cents", "bankroll"],
                 "properties": {
                     "p_win":       {"type": "number"},
                     "price_cents": {"type": "integer"},
                     "bankroll":    {"type": "number"},
                 }}),
    ]

@server.call_tool()
async def call_tool(name: str, arguments: dict) -> list[TextContent]:
    try:
        result = await _dispatch(name, arguments)
    except Exception as e:
        result = {"error": str(e)}
    return [TextContent(type="text", text=json.dumps(result, indent=2))]

async def _dispatch(name: str, args: dict) -> Any:

    if name == "get_market":
        market = await _active_market()
        if not market:
            return {"error": "No active KXBTC15M market found"}
        close_ts = 0.0
        if market.get("close_time"):
            try:
                close_ts = datetime.fromisoformat(
                    market["close_time"].replace("Z", "+00:00")
                ).timestamp()
            except Exception:
                pass
        mins_left = max(0.0, (close_ts - time.time()) / 60) if close_ts else None
        btc = await _btc_spot()
        strike = float(market.get("floor_strike") or 0)
        return {
            "ticker":       market.get("ticker"),
            "strike_price": strike,
            "btc_price":    round(btc, 2),
            "above_strike": btc > strike if btc and strike else None,
            "dist_pct":     round((btc - strike) / strike * 100, 4) if strike > 0 else None,
            "yes_ask":      market.get("yes_ask"),
            "no_ask":       market.get("no_ask"),
            "minutes_left": round(mins_left, 1) if mins_left is not None else None,
            "close_time":   market.get("close_time"),
            "status":       market.get("status"),
        }

    elif name == "analyze_signal":
        bankroll = float(args.get("bankroll", 200))
        market = await _active_market()
        if not market:
            return {"error": "No active market found"}
        return await _analyze(market, bankroll)

    elif name == "place_trade":
        ticker      = args["ticker"]
        side        = args["side"]
        contracts   = int(args["contracts"])
        limit_price = int(args["limit_price"])
        if contracts <= 0:
            return {"error": "contracts must be > 0"}
        if not (1 <= limit_price <= 99):
            return {"error": "limit_price must be 1–99 cents"}
        body = {
            "ticker": ticker, "action": "buy", "side": side, "type": "limit",
            "count": contracts,
            "yes_price": limit_price if side == "yes" else (100 - limit_price),
            "no_price":  limit_price if side == "no"  else (100 - limit_price),
        }
        try:
            result = await _kpost("/portfolio/orders", {"order": body})
            order  = result.get("order", result)
            return {
                "status":     "placed",
                "order_id":   order.get("order_id") or order.get("id"),
                "ticker":     ticker,
                "side":       side,
                "contracts":  contracts,
                "limit_price": limit_price,
            }
        except httpx.HTTPStatusError as e:
            return {"error": f"Kalshi {e.response.status_code}: {e.response.text}"}

    elif name == "get_balance":
        data = await _kget("/portfolio/balance")
        bal  = data.get("balance", {})
        return {
            "available_cash":  bal.get("available_balance_cents", 0) / 100,
            "portfolio_value": bal.get("portfolio_value_cents", 0)   / 100,
            "total":           (bal.get("available_balance_cents", 0) + bal.get("portfolio_value_cents", 0)) / 100,
        }

    elif name == "get_positions":
        pos = await _kget("/portfolio/positions", {"settlement_status": "unsettled"})
        ord_ = await _kget("/portfolio/orders", {"status": "resting"})
        return {
            "open_positions": [
                {"ticker": p.get("ticker"), "contracts": p.get("position"),
                 "value": round(p.get("market_exposure_cents", 0) / 100, 2)}
                for p in pos.get("market_positions", []) if p.get("position", 0) != 0
            ],
            "resting_orders": [
                {"order_id": o.get("order_id"), "ticker": o.get("ticker"),
                 "side": o.get("side"), "contracts": o.get("remaining_count"),
                 "price": o.get("yes_price")}
                for o in ord_.get("orders", [])
            ],
        }

    elif name == "cancel_order":
        order_id = args["order_id"]
        path = f"/portfolio/orders/{order_id}"
        hdrs = _headers("DELETE", path)
        async with httpx.AsyncClient(timeout=10) as c:
            r = await c.delete(f"{KALSHI_BASE}{path}", headers=hdrs)
            r.raise_for_status()
        return {"status": "cancelled", "order_id": order_id}

    elif name == "kelly_size":
        p_win = float(args["p_win"])
        price = int(args["price_cents"])
        br    = float(args["bankroll"])
        p_d   = price / 100
        fee   = MAKER_FEE_RATE * p_d * (1 - p_d)
        nw    = (1 - p_d) - fee
        tc    = p_d + fee
        b     = nw / tc if tc > 0 else 1.0
        kf    = max(0.0, (b * p_win - (1 - p_win)) / b)
        frac  = 0.35 if 65 <= price <= 73 else 0.12 if price <= 79 else 0.08 if price <= 85 else 0.05
        rp    = min(MAX_TRADE_PCT, frac * kf)
        cap   = max(25, round(br / 200 * 25))
        c_    = min(max(1, round(br * rp / tc)), cap)
        return {
            "kelly_full": round(kf, 4), "kelly_fraction": frac,
            "risk_pct": round(rp * 100, 2), "contracts": c_,
            "max_loss": round(tc * c_, 2),
            "ev_total": round(c_ * (nw * p_win - tc * (1 - p_win)), 2),
        }

    return {"error": f"Unknown tool: {name}"}

# ── Entry point ────────────────────────────────────────────────────────────────
async def main():
    async with stdio_server() as (read, write):
        await server.run(read, write, server.create_initialization_options())

def run():
    asyncio.run(main())
