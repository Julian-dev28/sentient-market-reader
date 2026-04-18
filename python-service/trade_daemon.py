"""
trade_daemon.py — Autonomous Kalshi BTC trading daemon

Runs 24/7. Wakes up for each 15-min KXBTC15M window, runs the full
Markov signal stack, places a real order if all gates pass, and logs
every decision to logs/daemon_YYYYMMDD.log.

Usage:
  source ~/.sentient-venv313/bin/activate
  python3 trade_daemon.py              # live trading
  python3 trade_daemon.py --dry-run    # simulate only (no real orders)
  python3 trade_daemon.py --bankroll 500
"""

import argparse, asyncio, base64, json, logging, math, os, sys, time
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional

import httpx

sys.path.insert(0, os.path.dirname(__file__))
from run_backtest import (
    fetch_candles_5m, fetch_candles_15m,
    build_markov_history, build_transition_matrix, predict_from_momentum,
    price_change_to_state, gk_vol, compute_hurst,
    MARKOV_MIN_GAP, MIN_PERSIST, KELLY_FRACTION, MAX_TRADE_PCT,
    MAX_ENTRY_PRICE_RM, MAKER_FEE_RATE, EMPIRICAL_PRICE_BY_D, BLOCKED_UTC_HOURS,
)

# ── Env / config ───────────────────────────────────────────────────────────────
_env_path = Path(__file__).parent.parent / ".env.local"
if _env_path.exists():
    for line in _env_path.read_text().splitlines():
        if line and not line.startswith("#") and "=" in line:
            k, _, v = line.partition("=")
            os.environ.setdefault(k.strip(), v.strip())

KALSHI_BASE    = "https://api.elections.kalshi.com/trade-api/v2"
KALSHI_API_KEY = os.environ.get("KALSHI_API_KEY", "")
KALSHI_PEM     = os.environ.get("KALSHI_PRIVATE_KEY_PATH", "./kalshi_private_julian.pem")

MAX_DAILY_LOSS   = 50.0   # $ hard stop for the day
MAX_GIVEBACK_X   = 1.5    # stop if peak P&L drops by this × MAX_DAILY_LOSS
MAX_DAILY_TRADES = 48

# ── Logging ────────────────────────────────────────────────────────────────────
_log_dir = Path(__file__).parent / "logs"
_log_dir.mkdir(exist_ok=True)

def _make_logger() -> logging.Logger:
    logger = logging.getLogger("daemon")
    logger.setLevel(logging.INFO)
    fmt = logging.Formatter("%(asctime)s  %(levelname)-7s  %(message)s", datefmt="%Y-%m-%d %H:%M:%S UTC")
    sh = logging.StreamHandler(sys.stdout)
    sh.setFormatter(fmt)
    fh = logging.FileHandler(_log_dir / f"daemon_{datetime.now().strftime('%Y%m%d')}.log")
    fh.setFormatter(fmt)
    logger.addHandler(sh)
    logger.addHandler(fh)
    return logger

log = _make_logger()

# ── Kalshi auth ────────────────────────────────────────────────────────────────
def _build_headers(method: str, path: str) -> dict:
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding as _pad
    key_path = Path(KALSHI_PEM)
    if not key_path.is_absolute():
        key_path = Path(__file__).parent.parent / KALSHI_PEM
    pk  = serialization.load_pem_private_key(key_path.read_bytes(), password=None)
    ts  = str(int(time.time() * 1000))
    sig = pk.sign(
        (ts + method.upper() + path).encode(),
        _pad.PSS(mgf=_pad.MGF1(hashes.SHA256()), salt_length=_pad.PSS.DIGEST_LENGTH),
        hashes.SHA256(),
    )
    return {
        "KALSHI-ACCESS-KEY":       KALSHI_API_KEY,
        "KALSHI-ACCESS-TIMESTAMP": ts,
        "KALSHI-ACCESS-SIGNATURE": base64.b64encode(sig).decode(),
        "Content-Type": "application/json",
    }

async def _kget(path: str, params: dict = {}) -> dict:
    hdrs = _build_headers("GET", path)
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.get(f"{KALSHI_BASE}{path}", params=params, headers=hdrs)
        r.raise_for_status()
        return r.json()

async def _kpost(path: str, body: dict) -> dict:
    hdrs = _build_headers("POST", path)
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.post(f"{KALSHI_BASE}{path}", json=body, headers=hdrs)
        r.raise_for_status()
        return r.json()

# ── Timing helpers ─────────────────────────────────────────────────────────────
def _et_offset() -> int:
    now = datetime.now(timezone.utc)
    yr  = now.year
    mar1 = datetime(yr, 3, 1, tzinfo=timezone.utc)
    edt_start = mar1 + timedelta(days=(6 - mar1.weekday()) % 7 + 7)
    nov1 = datetime(yr, 11, 1, tzinfo=timezone.utc)
    est_start = nov1 + timedelta(days=(6 - nov1.weekday()) % 7)
    return -4 if edt_start <= now < est_start else -5

def next_window_close() -> datetime:
    """UTC time of the next KXBTC15M window close (15-min ET boundary)."""
    off = _et_offset()
    now = datetime.now(timezone.utc)
    et  = now + timedelta(hours=off)
    nxt = (et.minute // 15 + 1) * 15
    et  = et.replace(second=0, microsecond=0)
    if nxt >= 60:
        et = et.replace(minute=0) + timedelta(hours=1)
    else:
        et = et.replace(minute=nxt)
    return et - timedelta(hours=off)

def fmt(secs: float) -> str:
    m, s = divmod(int(abs(secs)), 60)
    return f"{m}m{s:02d}s"

# ── Session state ──────────────────────────────────────────────────────────────
class Session:
    def __init__(self, bankroll: float):
        self.bankroll      = bankroll
        self.daily_pnl     = 0.0
        self.daily_trades  = 0
        self.peak_pnl      = 0.0
        self.traded        : set[str] = set()   # window IDs already handled
        self.pending       : dict     = {}       # window_id → trade info (awaiting settlement)
        self._date         = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    def new_day_check(self):
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        if today != self._date:
            log.info(f"── New day {today} — resetting P&L counters ──")
            self.daily_pnl    = 0.0
            self.daily_trades = 0
            self.peak_pnl     = 0.0
            self._date        = today

    def limit_hit(self) -> Optional[str]:
        max_loss = max(50.0, min(150.0, self.bankroll * 0.05))
        if self.daily_pnl <= -max_loss:
            return f"daily loss limit (${self.daily_pnl:.2f} / -${max_loss:.0f})"
        giveback = self.peak_pnl - self.daily_pnl if self.peak_pnl > 0 else 0
        if giveback >= max_loss * MAX_GIVEBACK_X:
            return f"session giveback limit (${giveback:.2f} from peak ${self.peak_pnl:.2f})"
        if self.daily_trades >= MAX_DAILY_TRADES:
            return f"daily trade cap ({MAX_DAILY_TRADES})"
        return None

    def record(self, pnl: float):
        self.daily_pnl   += pnl
        self.daily_trades += 1
        self.bankroll     += pnl
        if self.daily_pnl > self.peak_pnl:
            self.peak_pnl = self.daily_pnl

# ── Market + signal ────────────────────────────────────────────────────────────
async def fetch_market() -> Optional[dict]:
    months = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"]
    off = _et_offset()
    for delta in [0, 15, 30]:
        ts  = time.time() + delta * 60
        dt  = datetime.fromtimestamp(ts, tz=timezone.utc)
        et  = (dt + timedelta(hours=off)).replace(second=0, microsecond=0)
        nxt = (et.minute // 15 + 1) * 15
        if nxt >= 60:
            et = et.replace(minute=0) + timedelta(hours=1)
        else:
            et = et.replace(minute=nxt)
        event = f"KXBTC15M-{et.strftime('%y')}{months[et.month-1]}{et.strftime('%d%H%M')}"
        try:
            data = await _kget("/markets", {"event_ticker": event, "status": "open"})
            for m in data.get("markets", []):
                if m.get("yes_ask", 0) > 0:
                    return m
        except Exception:
            pass

    # Fallback: grab first open market in series
    try:
        data = await _kget("/markets", {"series_ticker": "KXBTC15M", "status": "open", "limit": 5})
        active = [m for m in data.get("markets", []) if m.get("yes_ask", 0) > 0]
        if active:
            return active[0]
    except Exception:
        pass
    return None


async def get_btc_price() -> float:
    try:
        async with httpx.AsyncClient(timeout=5) as c:
            r = await c.get("https://api.exchange.coinbase.com/products/BTC-USD/ticker")
            return float(r.json().get("price", 0))
    except Exception:
        return 0.0


async def run_signal(market: dict, bankroll: float) -> dict:
    strike   = float(market.get("floor_strike") or 0)
    yes_ask  = int(market.get("yes_ask") or 50)
    no_ask   = int(market.get("no_ask")  or 50)
    ticker   = market.get("ticker", "")
    close_ts = 0
    if market.get("close_time"):
        try:
            close_ts = datetime.fromisoformat(
                market["close_time"].replace("Z", "+00:00")
            ).timestamp()
        except Exception:
            pass

    btc_price    = await get_btc_price()
    minutes_left = max(0, (close_ts - time.time()) / 60) if close_ts else 7.5
    dist_pct     = (btc_price - strike) / strike * 100 if strike > 0 else 0.0

    # Candles (sync — run in executor to avoid blocking event loop)
    loop = asyncio.get_event_loop()
    candles_5m, candles_15m = await asyncio.gather(
        loop.run_in_executor(None, fetch_candles_5m,  2),
        loop.run_in_executor(None, fetch_candles_15m, 2),
    )

    check_ts = time.time()

    # GK vol + Hurst
    ctx15   = [c for c in candles_15m if c[0] + 900 <= check_ts]
    last15  = list(reversed(ctx15[-32:])) if len(ctx15) >= 12 else []
    gk      = gk_vol(last15[:16])    if last15 else None
    hurst   = compute_hurst(last15[:24]) if last15 else None

    # d-score
    d_score = None
    if gk and gk > 0 and strike > 0:
        try:
            candles_left = max(minutes_left / 15.0, 1/60)
            d_score = math.log(btc_price / strike) / (gk * math.sqrt(candles_left))
        except Exception:
            pass

    # Markov
    history       = build_markov_history(candles_5m, check_ts)
    c5_by_ts      = {c[0]: c for c in candles_5m}
    c5_ts         = int(check_ts // 300) * 300 - 300
    c5_bar        = c5_by_ts.get(c5_ts) or c5_by_ts.get(c5_ts - 300)
    c5_prev       = c5_by_ts.get(c5_ts - 300)
    current_state = 4
    if c5_bar and c5_prev and c5_prev[4] > 0:
        current_state = price_change_to_state(
            (c5_bar[4] - c5_prev[4]) / c5_prev[4] * 100.0
        )

    full_history = (history + [current_state]) if history else [current_state, current_state]
    P            = build_transition_matrix(full_history)
    forecast     = predict_from_momentum(P, current_state, minutes_left, dist_pct)
    p_yes        = forecast["p_yes"]
    gap          = abs(p_yes - 0.5)
    persist      = forecast["persist"]
    has_history  = len(full_history) >= 20

    # Gates
    utc_hour  = datetime.now(timezone.utc).hour
    blocked   = utc_hour in BLOCKED_UTC_HOURS
    vol_ok    = gk is None or gk <= 0.002 * 1.25
    hurst_ok  = hurst is None or hurst >= 0.50
    markov_ok = has_history and gap >= MARKOV_MIN_GAP and persist >= MIN_PERSIST
    is_golden = 65 <= yes_ask <= 73
    time_ok   = (3 <= minutes_left <= 12) if is_golden else (6 <= minutes_left <= 9)
    limit_price = round(yes_ask if p_yes > 0.5 else no_ask)
    price_ok  = limit_price <= MAX_ENTRY_PRICE_RM
    dist_ok   = abs(dist_pct) >= 0.02

    reasons: list[str] = []
    if not has_history:  reasons.append(f"building history ({len(full_history)}/20 candles)")
    if not markov_ok:    reasons.append(f"Markov gap {gap:.3f}<{MARKOV_MIN_GAP} or persist {persist:.2f}<{MIN_PERSIST}")
    if blocked:          reasons.append(f"blocked UTC hour {utc_hour}:00")
    if not vol_ok:       reasons.append(f"high vol (GK={gk:.5f})")
    if not hurst_ok:     reasons.append(f"mean-reverting (Hurst={hurst:.2f})")
    if not time_ok:      reasons.append(f"timing {minutes_left:.1f}min outside {'3-12' if is_golden else '6-9'}min window")
    if not price_ok:     reasons.append(f"price {limit_price}¢ > {MAX_ENTRY_PRICE_RM}¢ cap")
    if not dist_ok:      reasons.append(f"near-strike noise ({dist_pct:.4f}%)")

    all_ok = markov_ok and not blocked and vol_ok and hurst_ok and time_ok and price_ok and dist_ok
    rec    = ("YES" if p_yes > 0.5 else "NO") if all_ok else "NO_TRADE"

    # Kelly sizing
    p_win     = p_yes if rec == "YES" else (1 - p_yes)
    p_d       = limit_price / 100
    fee_c     = MAKER_FEE_RATE * p_d * (1 - p_d)
    net_win   = (1 - p_d) - fee_c
    cost_c    = p_d + fee_c
    b         = net_win / cost_c if cost_c > 0 else 1.0
    kelly_full = max(0.0, (b * p_win - (1 - p_win)) / b) if rec != "NO_TRADE" else 0.0

    if   65 <= limit_price <= 73: frac = 0.35
    elif 73 < limit_price <= 79:  frac = 0.12
    elif 73 < limit_price <= 85:  frac = 0.08
    else:                         frac = 0.05

    risk_pct  = min(MAX_TRADE_PCT, frac * kelly_full)
    dyn_cap   = max(25, round(bankroll / 200 * 25))
    contracts = min(max(1, round(bankroll * risk_pct / cost_c)), dyn_cap) if rec != "NO_TRADE" else 0
    max_loss  = round(cost_c * contracts, 2)
    ev        = round(contracts * (net_win * p_win - cost_c * (1 - p_win)), 2)

    return {
        "approved":        rec != "NO_TRADE",
        "recommendation":  rec,
        "ticker":          ticker,
        "limit_price":     limit_price,
        "contracts":       contracts,
        "max_loss_usd":    max_loss,
        "expected_value":  ev,
        "rejection_reasons": reasons,
        "signal": {
            "p_yes":        round(p_yes, 4),
            "gap":          round(gap, 4),
            "persist":      round(persist, 3),
            "hurst":        round(hurst, 3) if hurst else None,
            "gk_vol":       round(gk, 6) if gk else None,
            "d_score":      round(d_score, 3) if d_score else None,
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


async def get_live_bankroll() -> Optional[float]:
    try:
        data = await _kget("/portfolio/balance")
        bal  = data.get("balance", {})
        return (bal.get("available_balance_cents", 0) + bal.get("portfolio_value_cents", 0)) / 100
    except Exception as e:
        log.warning(f"Could not fetch live balance: {e}")
        return None


async def check_settlement(ticker: str) -> Optional[str]:
    """Returns 'YES', 'NO', or None if not settled yet."""
    try:
        data = await _kget(f"/markets/{ticker}")
        m = data.get("market", data)
        result = m.get("result")
        if result in ("yes", "no"):
            return result.upper()
    except Exception:
        pass
    return None


# ── Main loop ──────────────────────────────────────────────────────────────────
async def main_loop(dry_run: bool, bankroll: float):
    session = Session(bankroll)
    log.info("=" * 65)
    log.info(f"  Sentient Trading Daemon  |  dry_run={dry_run}  |  bankroll=${bankroll:.0f}")
    log.info("=" * 65)

    # Try fetching live balance at startup
    live_bal = await get_live_bankroll()
    if live_bal and live_bal > 0:
        session.bankroll = live_bal
        log.info(f"Live balance: ${live_bal:.2f}")

    last_balance_refresh = time.time()

    while True:
        session.new_day_check()

        # Check pending settlements first
        settled_windows = []
        for wid, trade in list(session.pending.items()):
            result = await check_settlement(trade["ticker"])
            if result is not None:
                won    = (result == trade["side"].upper())
                pnl    = trade["net_win"] if won else -trade["cost"]
                emoji  = "WIN +" if won else "LOSS -"
                log.info(
                    f"SETTLED {emoji}${abs(pnl):.2f} | {trade['ticker']} | "
                    f"BUY {trade['side']} @ {trade['limit_price']}¢ | "
                    f"Result={result} | Daily P&L: ${session.daily_pnl + pnl:+.2f}"
                )
                session.record(pnl)
                settled_windows.append(wid)
        for wid in settled_windows:
            del session.pending[wid]

        # Refresh bankroll every 30 min
        if time.time() - last_balance_refresh > 1800:
            live_bal = await get_live_bankroll()
            if live_bal and live_bal > 0:
                session.bankroll = live_bal
                log.info(f"Balance refresh: ${live_bal:.2f}")
            last_balance_refresh = time.time()

        # Session limit check
        stop = session.limit_hit()
        if stop:
            log.warning(f"SESSION PAUSED — {stop}  (daily P&L: ${session.daily_pnl:+.2f})")
            await asyncio.sleep(300)
            continue

        # Timing
        close_dt  = next_window_close()
        now       = datetime.now(timezone.utc)
        mins_left = (close_dt - now).total_seconds() / 60
        window_id = close_dt.strftime("%Y%m%d%H%M")

        # Sleep until 12 min before close (entry window opens)
        if mins_left > 12.5:
            sleep_s = (mins_left - 12) * 60
            log.info(
                f"Next window {window_id} closes in {mins_left:.1f} min "
                f"— sleeping {fmt(sleep_s)}"
            )
            await asyncio.sleep(sleep_s)
            continue

        # Window is expiring — skip it
        if mins_left < 2.5:
            skip_s = (mins_left + 1.5) * 60
            if window_id not in session.traded:
                log.info(f"Window {window_id} closing ({mins_left:.1f} min) — skip")
                session.traded.add(window_id)
            await asyncio.sleep(skip_s)
            continue

        # Already traded this window
        if window_id in session.traded:
            await asyncio.sleep(min(30, mins_left * 60 * 0.5))
            continue

        # ── Active window: fetch market + signal ──────────────────────────────
        log.info(f"Window {window_id} | {mins_left:.1f} min to close — running signal...")

        try:
            market = await fetch_market()
        except Exception as e:
            log.error(f"Market fetch error: {e}")
            await asyncio.sleep(30)
            continue

        if not market:
            log.warning("No active market found — retrying in 30s")
            await asyncio.sleep(30)
            continue

        try:
            signal = await run_signal(market, session.bankroll)
        except Exception as e:
            log.error(f"Signal error: {e}", exc_info=True)
            await asyncio.sleep(30)
            continue

        approved    = signal["approved"]
        rec         = signal["recommendation"]
        contracts   = signal["contracts"]
        limit_price = signal["limit_price"]
        ticker      = signal["ticker"]
        reasons     = signal["rejection_reasons"]
        sig         = signal["signal"]
        mkt         = signal["market"]

        # Status line
        log.info(
            f"BTC ${mkt['btc_price']:,.0f} | Strike ${mkt['strike']:,.0f} | "
            f"Δ{mkt['dist_pct']:+.3f}% | {sig['minutes_left']:.1f}min | "
            f"p(YES)={sig['p_yes']:.1%} gap={sig['gap']:.3f} persist={sig['persist']:.2f} "
            f"{'[GOLDEN]' if sig['is_golden'] else ''}"
        )

        if not approved:
            reason_str = " | ".join(reasons) if reasons else "no edge"
            log.info(f"NO TRADE — {reason_str}")

            # Re-check in 30s only if timing is the only blocker and window is still open
            timing_only = reasons and all(
                "timing" in r or "min outside" in r for r in reasons
            )
            if timing_only and mins_left > 3.5:
                await asyncio.sleep(30)
            else:
                session.traded.add(window_id)
                await asyncio.sleep(max(5, (mins_left + 0.5) * 60))
            continue

        # ── TRADE ─────────────────────────────────────────────────────────────
        p_d      = limit_price / 100
        fee_c    = MAKER_FEE_RATE * p_d * (1 - p_d)
        cost_per = p_d + fee_c
        net_win  = (1 - p_d) - fee_c

        log.info(
            f"{'[DRY RUN] ' if dry_run else ''}TRADE  BUY {rec} {contracts}c @ {limit_price}¢  "
            f"max_loss=${signal['max_loss_usd']:.2f}  EV=${signal['expected_value']:+.2f}  "
            f"ticker={ticker}"
        )

        if dry_run:
            order_id = "dry-run"
            log.info(f"[DRY RUN] Order simulated — no real order sent")
        else:
            try:
                body = {
                    "ticker": ticker, "action": "buy", "side": rec.lower(),
                    "type": "limit", "count": contracts,
                    "yes_price": limit_price if rec == "YES" else (100 - limit_price),
                    "no_price":  limit_price if rec == "NO"  else (100 - limit_price),
                }
                result   = await _kpost("/portfolio/orders", {"order": body})
                order    = result.get("order", result)
                order_id = order.get("order_id") or order.get("id") or "unknown"
                log.info(f"ORDER PLACED — id={order_id}")
            except httpx.HTTPStatusError as e:
                log.error(f"Kalshi API error {e.response.status_code}: {e.response.text}")
                session.traded.add(window_id)
                await asyncio.sleep(max(5, (mins_left + 0.5) * 60))
                continue
            except Exception as e:
                log.error(f"Order failed: {e}")
                session.traded.add(window_id)
                await asyncio.sleep(max(5, (mins_left + 0.5) * 60))
                continue

        session.traded.add(window_id)

        # Queue for settlement check
        if not dry_run:
            session.pending[window_id] = {
                "ticker":      ticker,
                "side":        rec,
                "contracts":   contracts,
                "limit_price": limit_price,
                "cost":        round(cost_per * contracts, 2),
                "net_win":     round(net_win  * contracts, 2),
                "order_id":    order_id,
            }

        # Sleep until window closes + 45s buffer for settlement
        wait_s = max(5, (mins_left + 0.75) * 60)
        log.info(f"Waiting {fmt(wait_s)} for window to settle...")
        await asyncio.sleep(wait_s)


# ── Entry ──────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Sentient autonomous trading daemon")
    parser.add_argument("--dry-run",   action="store_true", help="Simulate trades, no real orders")
    parser.add_argument("--bankroll",  type=float, default=200.0, help="Starting bankroll in USD")
    args = parser.parse_args()

    try:
        asyncio.run(main_loop(dry_run=args.dry_run, bankroll=args.bankroll))
    except KeyboardInterrupt:
        log.info("Daemon stopped by user.")
