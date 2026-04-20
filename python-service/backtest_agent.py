"""
Agent Backtest — exact replay of sentient-trader-mcp gates
──────────────────────────────────────────────────────────
Replays the MCP server's _analyze() logic on historical settled Kalshi
KXBTC15M markets using the same 7 gates:

  1. Markov gap >= 0.11 AND persist >= 0.82 AND >= 20 history candles
  2. Not blocked UTC hour (11, 18)
  3. GK vol <= REF_VOL_15M * MAX_VOL_MULT (0.0025)
  4. Hurst >= 0.50
  5. Time-of-entry: 6-9 min before close (3-12 for golden-zone 65-73¢)
  6. Limit price <= MAX_ENTRY_PRICE (72¢)
  7. dist_pct >= 0.02% (not at-the-money noise)

Entry is simulated at 7.5 min before close (mid of golden 6-9 window).
5-min candles feed the Markov chain; 15-min candles feed GK vol + Hurst.
"""

import math, time, logging
from datetime import datetime, timezone, timedelta
from typing import Optional

import requests

logger = logging.getLogger(__name__)

COINBASE_BASE = "https://api.exchange.coinbase.com"
KALSHI_BASE   = "https://api.elections.kalshi.com/trade-api/v2"

_SESSION = requests.Session()
_SESSION.headers.update({"User-Agent": "sentient-agent-backtest/1.0"})

# ── Agent constants (must mirror server.py exactly) ───────────────────────────
MARKOV_MIN_GAP  = 0.11
MIN_PERSIST     = 0.82
MAX_ENTRY_PRICE = 72
MAX_VOL_MULT    = 1.25
MIN_HURST       = 0.50
MAKER_FEE_RATE  = 0.0175
MAX_TRADE_PCT   = 0.20
BLOCKED_HOURS   = {11, 18}
REF_VOL_15M     = 0.002
KELLY_FRACTION  = 0.18

NUM_STATES    = 9
MARKOV_CANDLE = 5       # minutes
MARKOV_WINDOW = 480
MIN_HISTORY   = 20
STATE_BOUNDS  = [-3.35, -2.24, -1.12, -0.45, 0.45, 1.12, 2.24, 3.35]
STATE_RETURNS = [-2.0, -1.25, -0.75, -0.35, 0.0,  0.35, 0.75, 1.25, 2.0]
STATE_VOL     = [ 1.0,  0.35,  0.25,  0.15, 0.10, 0.15, 0.25, 0.35, 1.0]

# Maps |d_score| → estimated yes_ask (cents) — same table as server.py
EMPIRICAL_PRICE_BY_D = [
    (0.0, 0.5,  62.3),
    (0.5, 0.8,  72.7),
    (0.8, 1.0,  79.1),
    (1.0, 1.2,  80.8),
    (1.2, 1.5,  84.6),
    (1.5, 2.0,  83.6),
    (2.0, 99.0, 71.0),
]

ENTRY_MINUTES_LEFT = 7.5   # simulate entry at 7.5 min before close


# ── Math (exact copies from server.py) ───────────────────────────────────────

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
        s, t_ = history[i], history[i + 1]
        if 0 <= s < NUM_STATES and 0 <= t_ < NUM_STATES:
            counts[s][t_] += 1.0
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
        sm  = sum(dist[i] * STATE_RETURNS[i] for i in range(NUM_STATES))
        se  = sum(dist[i] * (STATE_VOL[i] ** 2 + STATE_RETURNS[i] ** 2) for i in range(NUM_STATES))
        exp_drift += sm
        var_sum   += max(0.0, se - sm ** 2)
        nxt = [0.0] * NUM_STATES
        for i in range(NUM_STATES):
            for j in range(NUM_STATES):
                nxt[j] += dist[i] * P[i][j]
        dist = nxt
    sigma = math.sqrt(max(var_sum, 0.01))
    p_yes = _norm_cdf((exp_drift - req) / sigma)
    return {"p_yes": p_yes, "persist": P[state][state], "sigma": sigma}

def _gk_vol_list(candles: list) -> Optional[float]:
    """GK vol from list of [ts, low, high, open, close, vol] (server.py format)."""
    K = 2 * math.log(2) - 1
    terms = []
    for c in candles:
        lo, hi, op, cl = c[1], c[2], c[3], c[4]
        if op > 0 and lo > 0 and hi > 0:
            terms.append(0.5 * math.log(hi / lo) ** 2 - K * math.log(cl / op) ** 2)
    return math.sqrt(max(0.0, sum(terms) / len(terms))) if len(terms) >= 2 else None

def _hurst(candles: list) -> Optional[float]:
    """Hurst exponent from [ts, low, high, open, close, vol] list, newest-first."""
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
    """Build Markov state history from 5-min candles up to up_to_ts."""
    relevant = [c for c in candles_5m if c[0] + MARKOV_CANDLE * 60 <= up_to_ts]
    if len(relevant) < 2: return []
    states = []
    for i in range(1, len(relevant)):
        prev, curr = relevant[i-1][4], relevant[i][4]
        if prev > 0:
            states.append(_state((curr - prev) / prev * 100.0))
    return states[-MARKOV_WINDOW:]

def _estimated_yes_ask(abs_d: float) -> int:
    for lo, hi, price in EMPIRICAL_PRICE_BY_D:
        if lo <= abs_d < hi:
            return round(price)
    return 71


# ── HTTP helpers ──────────────────────────────────────────────────────────────

def _get_json(url: str, retries: int = 3):
    for attempt in range(retries):
        try:
            resp = _SESSION.get(url, timeout=20)
            if resp.status_code == 429:
                time.sleep(2 ** attempt)
                continue
            resp.raise_for_status()
            return resp.json()
        except Exception:
            if attempt < retries - 1:
                time.sleep(1)
                continue
            raise


# ── Data fetching ─────────────────────────────────────────────────────────────

def _fetch_candles_bulk(granularity: int, start_dt: datetime, end_dt: datetime) -> list:
    """Fetch candles in [ts, low, high, open, close, vol] format, oldest-first."""
    chunk_secs = 280 * granularity
    all_candles: list = []
    t = start_dt.astimezone(timezone.utc)
    end_utc = end_dt.astimezone(timezone.utc)

    while t < end_utc:
        t_end = min(t + timedelta(seconds=chunk_secs), end_utc)
        url = (
            f"{COINBASE_BASE}/products/BTC-USD/candles"
            f"?granularity={granularity}"
            f"&start={t.strftime('%Y-%m-%dT%H:%M:%SZ')}"
            f"&end={t_end.strftime('%Y-%m-%dT%H:%M:%SZ')}"
        )
        try:
            raw = _get_json(url)
            if isinstance(raw, list):
                for c in raw:
                    all_candles.append([int(c[0]), float(c[1]), float(c[2]),
                                        float(c[3]), float(c[4]), float(c[5])])
        except Exception as e:
            logger.warning(f"Candle fetch failed {t}: {e}")
        t = t_end
        if t < end_utc:
            time.sleep(0.2)

    seen: set = set()
    unique = []
    for c in all_candles:
        if c[0] not in seen:
            seen.add(c[0])
            unique.append(c)
    unique.sort(key=lambda c: c[0])
    return unique


def fetch_settled_markets(days_back: int) -> list:
    cutoff  = datetime.now(timezone.utc) - timedelta(days=days_back)
    markets = []
    cursor  = None
    reached_cutoff = False

    while not reached_cutoff:
        params = {"series_ticker": "KXBTC15M", "status": "settled", "limit": 200}
        if cursor:
            params["cursor"] = cursor
        try:
            data = _get_json(f"{KALSHI_BASE}/markets?" + "&".join(f"{k}={v}" for k, v in params.items()))
        except Exception as e:
            logger.warning(f"Kalshi fetch failed: {e}")
            break

        for m in data.get("markets", []):
            close_time_str = m.get("close_time") or m.get("expiration_time", "")
            if not close_time_str:
                continue
            try:
                close_dt = datetime.fromisoformat(close_time_str.replace("Z", "+00:00"))
            except ValueError:
                continue
            if close_dt < cutoff:
                reached_cutoff = True
                break
            fs = m.get("floor_strike")
            result = m.get("result")
            ticker = m.get("ticker", "")
            if fs is not None and result in ("yes", "no") and ticker:
                try:
                    markets.append({
                        "ticker":       ticker,
                        "floor_strike": float(fs),
                        "result":       result,
                        "close_time":   close_time_str,
                    })
                except (TypeError, ValueError):
                    continue

        if reached_cutoff:
            break
        cursor = data.get("cursor")
        if not cursor:
            break
        time.sleep(0.15)

    logger.info(f"Fetched {len(markets)} settled markets ({days_back}d)")
    return markets


# ── Per-market agent replay ───────────────────────────────────────────────────

def _process_market_agent(mkt: dict, candles_5m: list, candles_15m: list) -> Optional[dict]:
    """
    Replay _analyze() gates for one settled market using historical candles.
    Entry simulated at ENTRY_MINUTES_LEFT before close_time.
    Returns a trade record dict or None if any gate rejects.
    """
    ticker       = mkt["ticker"]
    floor_strike = mkt["floor_strike"]
    result       = mkt["result"]

    try:
        close_dt = datetime.fromisoformat(mkt["close_time"].replace("Z", "+00:00"))
    except ValueError:
        return None

    entry_dt = close_dt - timedelta(minutes=ENTRY_MINUTES_LEFT)
    entry_ts = entry_dt.timestamp()
    minutes_left = ENTRY_MINUTES_LEFT
    utc_hour = entry_dt.hour

    # ── BTC price at entry (last 5-min candle close before entry_ts) ──────────
    price_candles = [c for c in candles_5m if c[0] + 300 <= entry_ts]
    if not price_candles:
        return None
    btc_price = price_candles[-1][4]
    if btc_price <= 0 or floor_strike <= 0:
        return None

    dist_pct = (btc_price - floor_strike) / floor_strike * 100.0

    # ── 15-min candles for GK vol + Hurst ────────────────────────────────────
    ctx_15m = [c for c in candles_15m if c[0] + 900 <= entry_ts]
    if len(ctx_15m) < 12:
        return None
    last_15m = list(reversed(ctx_15m[-32:]))   # newest-first, ≤32 candles

    gk   = _gk_vol_list(last_15m[:16])
    hurst = _hurst(last_15m[:24])

    # ── Markov chain from 5-min candles ──────────────────────────────────────
    history   = _markov_history(candles_5m, entry_ts)
    c5_by_ts  = {c[0]: c for c in candles_5m}
    c5_ts     = int(entry_ts // 300) * 300 - 300
    c5_bar    = c5_by_ts.get(c5_ts) or c5_by_ts.get(c5_ts - 300)
    c5_prev   = c5_by_ts.get(c5_ts - 300)
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

    # ── Estimate limit_price from d-score (no historical order book) ──────────
    if gk and gk > 0:
        abs_d = abs(math.log(btc_price / floor_strike) / (gk * math.sqrt(max(minutes_left / 15.0, 1/60))))
    else:
        abs_d = abs(dist_pct) / 0.2   # rough fallback
    est_yes_ask = _estimated_yes_ask(abs_d)
    limit_price = est_yes_ask if p_yes > 0.5 else (100 - est_yes_ask)

    # ── Apply all 7 gates ─────────────────────────────────────────────────────
    blocked   = utc_hour in BLOCKED_HOURS
    vol_ok    = gk is None or gk <= REF_VOL_15M * MAX_VOL_MULT
    hurst_ok  = hurst is None or hurst >= MIN_HURST
    markov_ok = has_history and gap >= MARKOV_MIN_GAP and persist >= MIN_PERSIST
    is_golden = 65 <= limit_price <= 73
    time_ok   = (3 <= minutes_left <= 12) if is_golden else (6 <= minutes_left <= 9)
    price_ok  = limit_price <= MAX_ENTRY_PRICE
    dist_ok   = abs(dist_pct) >= 0.10

    reasons = []
    if not has_history:  reasons.append(f"history {len(full_history)}/{MIN_HISTORY}")
    if not markov_ok:    reasons.append(f"gap={gap:.3f} persist={persist:.2f}")
    if blocked:          reasons.append(f"blocked hour {utc_hour}")
    if not vol_ok:       reasons.append(f"gk_vol={gk:.5f}" if gk else "no vol")
    if not hurst_ok:     reasons.append(f"Hurst={hurst:.2f}" if hurst else "no hurst")
    if not time_ok:      reasons.append(f"time={minutes_left:.1f}min")
    if not price_ok:     reasons.append(f"price={limit_price}¢>{MAX_ENTRY_PRICE}¢")
    if not dist_ok:      reasons.append(f"dist={dist_pct:.4f}%")

    all_ok = markov_ok and not blocked and vol_ok and hurst_ok and time_ok and price_ok and dist_ok
    if not all_ok:
        return None   # rejected

    side = "yes" if p_yes > 0.5 else "no"
    won  = (side == result)

    # Kelly sizing (tiered, same as server.py)
    p_d    = limit_price / 100
    fee_c  = MAKER_FEE_RATE * p_d * (1 - p_d)
    net_win = (1 - p_d) - fee_c
    cost_c  = p_d + fee_c
    b      = net_win / cost_c if cost_c > 0 else 1.0
    p_win  = p_yes if side == "yes" else (1 - p_yes)
    kf     = max(0.0, (b * p_win - (1 - p_win)) / b)
    frac   = 0.35 if 65 <= limit_price <= 73 else 0.12 if limit_price <= 79 else 0.08 if limit_price <= 85 else 0.05
    half_k = kf * KELLY_FRACTION  # flat 18% of full Kelly

    return {
        "ticker":      ticker,
        "side":        side,
        "limitPrice":  limit_price,
        "outcome":     "WIN" if won else "LOSS",
        "pYes":        round(p_yes, 4),
        "gap":         round(gap, 4),
        "persist":     round(persist, 4),
        "hurst":       round(hurst, 3) if hurst else None,
        "gkVol":       round(gk, 6) if gk else None,
        "distPct":     round(dist_pct, 4),
        "halfKelly":   round(half_k, 6),
        "enteredAt":   entry_dt.isoformat(),
        "btcPrice":    btc_price,
        "strike":      floor_strike,
    }


# ── Simulation ────────────────────────────────────────────────────────────────

def _simulate(records: list, starting_cash: float) -> dict:
    cash = starting_cash
    # Fixed contract cap based on starting capital — reflects Kalshi market depth.
    # At $450, mirrors live agent's dyn_cap(200 bankroll ref) = ~56 contracts.
    # Does NOT grow with running bankroll — prevents unrealistic compounding.
    contract_cap = max(25, round(starting_cash / 200 * 25))

    for r in records:
        lp        = r["limitPrice"] / 100.0
        half_k    = r["halfKelly"]
        bet       = min(cash * half_k, cash * 0.10)
        contracts = max(1, int(bet / lp)) if lp > 0 else 1
        contracts = min(contracts, contract_cap)
        cost      = contracts * lp
        if cost > cash:
            contracts = max(1, int(cash / lp))
            contracts = min(contracts, contract_cap)
            cost = contracts * lp
        pnl = contracts * (1.0 - lp) if r["outcome"] == "WIN" else -cost
        cash = max(0.0, cash + pnl)
        r["contracts"] = contracts
        r["cost"]      = round(cost, 2)
        r["pnl"]       = round(pnl, 2)

    wins   = [r for r in records if r["outcome"] == "WIN"]
    losses = [r for r in records if r["outcome"] == "LOSS"]
    return {
        "records":  records,
        "starting": starting_cash,
        "final":    round(cash, 2),
        "pnl":      round(sum(r["pnl"] for r in records), 2),
        "return_pct": round((cash - starting_cash) / starting_cash * 100, 2),
        "trades":   len(records),
        "wins":     len(wins),
        "losses":   len(losses),
        "win_rate": round(len(wins) / len(records) * 100, 1) if records else 0,
    }


# ── Entry point ───────────────────────────────────────────────────────────────

def run_agent_backtest(days_back: int = 30, starting_cash: float = 450.0) -> dict:
    logger.info(f"[AGENT-BT] Starting {days_back}d agent backtest | ${starting_cash:.0f} | {KELLY_FRACTION*100:.0f}% Kelly")

    markets = fetch_settled_markets(days_back)
    if not markets:
        return {}

    close_times = []
    for m in markets:
        try:
            close_times.append(datetime.fromisoformat(m["close_time"].replace("Z", "+00:00")))
        except ValueError:
            pass

    earliest = min(close_times) - timedelta(hours=12)
    latest   = max(close_times) + timedelta(minutes=30)

    logger.info("Fetching 5-min candles…")
    c5m  = _fetch_candles_bulk(300,  earliest, latest)
    logger.info("Fetching 15-min candles…")
    c15m = _fetch_candles_bulk(900,  earliest, latest)
    logger.info(f"Candles: {len(c5m)} × 5-min, {len(c15m)} × 15-min")

    records, skipped = [], 0
    for mkt in markets:
        try:
            rec = _process_market_agent(mkt, c5m, c15m)
            if rec:
                records.append(rec)
            else:
                skipped += 1
        except Exception as e:
            logger.warning(f"[AGENT-BT] {mkt.get('ticker','?')}: {e}")
            skipped += 1

    logger.info(f"[AGENT-BT] {len(records)} trades, {skipped} rejected (of {len(markets)} total)")
    return _simulate(records, starting_cash)


if __name__ == "__main__":
    import sys
    logging.basicConfig(level=logging.INFO, format="%(message)s")

    days  = int(sys.argv[1]) if len(sys.argv) > 1 else 30
    cash  = float(sys.argv[2]) if len(sys.argv) > 2 else 450.0

    r = run_agent_backtest(days_back=days, starting_cash=cash)
    if not r:
        print("No data.")
        sys.exit(1)

    print(f"\n{'='*60}")
    print(f"  AGENT BACKTEST — {days}d | 18% Kelly | ${cash:.0f} starting")
    print(f"{'='*60}")
    print(f"  Trades:   {r['trades']} ({r['wins']}W / {r['losses']}L)")
    print(f"  Win rate: {r['win_rate']}%")
    print(f"  Starting: ${r['starting']:.2f}")
    print(f"  Final:    ${r['final']:.2f}")
    print(f"  P&L:      ${r['pnl']:+.2f}")
    print(f"  Return:   {r['return_pct']:+.2f}%")
    print(f"{'='*60}")

    if r['records']:
        print(f"\n{'Ticker':<32} {'Side':<4} {'P':<4} {'LP':>3} {'Hurst':>5} {'Gap':>5} {'Ctrs':>4} {'P&L':>8}  Result")
        print(f"{'-'*32} {'-'*4} {'-'*4} {'-'*3} {'-'*5} {'-'*5} {'-'*4} {'-'*8}  {'-'*6}")
        for rec in r['records']:
            h = f"{rec['hurst']:.2f}" if rec['hurst'] is not None else "  n/a"
            print(
                f"{rec['ticker']:<32} {rec['side']:<4} {rec['pYes']:.2f} {rec['limitPrice']:>3}¢ "
                f"{h:>5} {rec['gap']:.3f} {rec['contracts']:>4} {rec['pnl']:>+8.2f}  {rec['outcome']}"
            )
