"""
Live Trade Analysis — KXBTC15M
================================
Cross-references actual Kalshi fills (from live_fills.json) with:
  - Settled market outcomes (from Kalshi API)
  - BTC spot price at fill time (from Coinbase 1m candles)
  - Brownian model price at fill time (computed from GK vol + d-score)

This gives us the REAL answers to:
  1. What is the actual live win rate?
  2. What is the actual Kalshi price vs Brownian model? (real discount)
  3. Does win rate vary by d-score bucket, price paid, time of day?
  4. What is the actual P&L (with real fees)?

No fabricated prices. No circular logic.
"""

import json
import math
import time
import logging
import os
from datetime import datetime, timezone, timedelta
from typing import Optional

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

COINBASE_BASE = "https://api.exchange.coinbase.com"
KALSHI_BASE   = "https://api.elections.kalshi.com/trade-api/v2"

_S = requests.Session()
_S.headers["User-Agent"] = "sentient-analysis/1.0"

FILLS_FILE  = os.path.join(os.path.dirname(__file__), "live_fills.json")
CACHE_FILE  = os.path.join(os.path.dirname(__file__), "live_analysis_cache.json")
MAKER_FEE_RATE = 0.0175   # resting limit orders → maker rate
TAKER_FEE_RATE = 0.07    # immediately matched → taker rate

def kalshi_fee(contracts, price_cents, maker=True):
    """ceil(rate × C × P × (1-P)) — official Kalshi formula, rounded up to nearest cent."""
    rate = MAKER_FEE_RATE if maker else TAKER_FEE_RATE
    p = price_cents / 100.0
    return math.ceil(rate * contracts * p * (1 - p) * 100) / 100


# ─── Math helpers ──────────────────────────────────────────────────────────────

def norm_cdf(z: float) -> float:
    sign = 1 if z >= 0 else -1
    x = abs(z)
    t = 1.0 / (1.0 + 0.2316419 * x)
    poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))))
    pdf = math.exp(-0.5 * x * x) / math.sqrt(2 * math.pi)
    return 0.5 + sign * (0.5 - pdf * poly)


def gk_vol(candles_newest: list, n: int = 16) -> Optional[float]:
    K = 2 * math.log(2) - 1
    terms = []
    for c in candles_newest[:n]:
        lo, hi, op, cl = c['low'], c['high'], c['open'], c['close']
        if op <= 0 or lo <= 0 or hi <= 0:
            continue
        terms.append(0.5 * math.log(hi / lo) ** 2 - K * math.log(cl / op) ** 2)
    if len(terms) < 4:
        return None
    return math.sqrt(max(sum(terms) / len(terms), 0.0))


# ─── Data fetchers ─────────────────────────────────────────────────────────────

def _get(url: str, retries: int = 4) -> dict:
    for attempt in range(retries):
        try:
            r = _S.get(url, timeout=20)
            if r.status_code == 429:
                time.sleep(2 ** attempt); continue
            r.raise_for_status()
            return r.json()
        except Exception:
            if attempt < retries - 1:
                time.sleep(1.5)
                continue
            raise


def fetch_candles_1m_range(start_dt: datetime, end_dt: datetime) -> list:
    """Fetch 1-min candles as list of {time, open, high, low, close, volume} oldest-first."""
    chunk_secs = 300 * 60
    all_c = []
    cur = start_dt.astimezone(timezone.utc)
    end = end_dt.astimezone(timezone.utc)
    while cur < end:
        chunk_end = min(cur + timedelta(seconds=chunk_secs), end)
        url = (f"{COINBASE_BASE}/products/BTC-USD/candles?granularity=60"
               f"&start={cur.strftime('%Y-%m-%dT%H:%M:%SZ')}"
               f"&end={chunk_end.strftime('%Y-%m-%dT%H:%M:%SZ')}")
        try:
            raw = _get(url)
            if isinstance(raw, list):
                for c in raw:
                    all_c.append({'time': int(c[0]), 'low': float(c[1]), 'high': float(c[2]),
                                  'open': float(c[3]), 'close': float(c[4]), 'volume': float(c[5])})
        except Exception as e:
            log.warning(f"1m chunk failed {cur}: {e}")
        cur = chunk_end
        if cur < end:
            time.sleep(0.2)
    seen = set()
    uniq = [c for c in all_c if c['time'] not in seen and not seen.add(c['time'])]
    uniq.sort(key=lambda c: c['time'])
    return uniq


def fetch_candles_15m_range(start_dt: datetime, end_dt: datetime) -> list:
    """Fetch 15-min candles oldest-first."""
    chunk_secs = 280 * 900
    all_c = []
    cur = start_dt.astimezone(timezone.utc)
    end = end_dt.astimezone(timezone.utc)
    while cur < end:
        chunk_end = min(cur + timedelta(seconds=chunk_secs), end)
        url = (f"{COINBASE_BASE}/products/BTC-USD/candles?granularity=900"
               f"&start={cur.strftime('%Y-%m-%dT%H:%M:%SZ')}"
               f"&end={chunk_end.strftime('%Y-%m-%dT%H:%M:%SZ')}")
        try:
            raw = _get(url)
            if isinstance(raw, list):
                for c in raw:
                    all_c.append({'time': int(c[0]), 'low': float(c[1]), 'high': float(c[2]),
                                  'open': float(c[3]), 'close': float(c[4]), 'volume': float(c[5])})
        except Exception as e:
            log.warning(f"15m chunk failed {cur}: {e}")
        cur = chunk_end
        if cur < end:
            time.sleep(0.25)
    seen = set()
    uniq = [c for c in all_c if c['time'] not in seen and not seen.add(c['time'])]
    uniq.sort(key=lambda c: c['time'])
    return uniq


def fetch_settled_outcomes(tickers: list) -> dict:
    """
    Fetch settled market results for given tickers from Kalshi.
    Returns {ticker: {'result': 'yes'/'no', 'floor_strike': float, 'close_time': str}}.
    Uses the public settled markets API — no auth required.
    """
    log.info(f"Fetching settled outcomes for {len(tickers)} tickers...")
    outcomes = {}
    cursor = None
    pages = 0
    while len(outcomes) < len(tickers):
        url = f"{KALSHI_BASE}/markets?series_ticker=KXBTC15M&status=settled&limit=200"
        if cursor:
            url += f"&cursor={cursor}"
        try:
            data = _get(url)
        except Exception as e:
            log.error(f"Kalshi fetch error: {e}"); break
        batch = data.get('markets', [])
        if not batch:
            break
        for m in batch:
            t = m.get('ticker', '')
            if t in tickers:
                try:
                    outcomes[t] = {
                        'result': m.get('result'),
                        'floor_strike': float(m.get('floor_strike', 0)),
                        'close_time': m.get('close_time') or m.get('expiration_time'),
                    }
                except Exception:
                    pass
        cursor = data.get('cursor')
        pages += 1
        if not cursor or pages > 50:
            break
        time.sleep(0.15)
    log.info(f"Retrieved {len(outcomes)} settled outcomes")
    return outcomes


# ─── Analysis functions ─────────────────────────────────────────────────────────

def parse_fill_time(fill: dict) -> Optional[datetime]:
    ct = fill.get('created_time', '')
    if not ct:
        return None
    try:
        return datetime.fromisoformat(ct.replace('Z', '+00:00'))
    except ValueError:
        return None


def get_spot_at_fill(fill_ts: float, candles_1m_by_ts: dict) -> Optional[float]:
    """Get BTC spot price from 1-min candle closest to fill timestamp."""
    ts = int(fill_ts // 60) * 60  # floor to minute
    for offset in [0, -60, 60, -120, 120]:
        price = candles_1m_by_ts.get(ts + offset)
        if price:
            return price
    return None


def compute_brownian_price(spot: float, strike: float, gk: float, minutes_left: float, side: str) -> Optional[float]:
    """
    Compute the Brownian model's fair price for this contract.
    Returns cents (0-100).
    side = 'yes' or 'no'
    """
    if not spot or not strike or not gk or minutes_left <= 0:
        return None
    candles_left = minutes_left / 15.0
    try:
        d = math.log(spot / strike) / (gk * math.sqrt(candles_left))
    except (ValueError, ZeroDivisionError):
        return None
    p_yes = norm_cdf(d)
    return (p_yes * 100) if side == 'yes' else ((1 - p_yes) * 100)


def get_minutes_left(fill_time: datetime, market_ticker: str, outcomes: dict) -> Optional[float]:
    """Compute minutes from fill time to market close."""
    outcome = outcomes.get(market_ticker)
    if not outcome or not outcome.get('close_time'):
        return None
    try:
        close_dt = datetime.fromisoformat(outcome['close_time'].replace('Z', '+00:00'))
        delta = (close_dt - fill_time).total_seconds() / 60.0
        return delta if delta > 0 else None
    except ValueError:
        return None


def analyze_live_trades(fills: list, outcomes: dict, candles_15m: list, candles_1m: list) -> list:
    """
    For each BUY fill: compute d-score, Brownian model price, actual price paid, outcome.
    Returns list of analyzed trade dicts.
    """
    # Index candles
    c1_by_ts  = {c['time']: c['close'] for c in candles_1m}
    c15_sorted = sorted(candles_15m, key=lambda c: c['time'])

    analyzed = []
    skipped = 0

    for fill in fills:
        ticker = fill.get('ticker', '')
        if 'KXBTC15M' not in ticker:
            continue
        if fill.get('action') != 'buy':
            continue

        outcome = outcomes.get(ticker)
        if not outcome or outcome.get('result') not in ('yes', 'no'):
            skipped += 1; continue

        fill_time = parse_fill_time(fill)
        if not fill_time:
            skipped += 1; continue

        floor_strike = outcome.get('floor_strike', 0)
        if not floor_strike:
            skipped += 1; continue

        fill_ts = fill_time.timestamp()
        side = fill.get('side', '')
        if side not in ('yes', 'no'):
            skipped += 1; continue

        # Actual fill price in cents
        yes_p = float(fill.get('yes_price_dollars', 0))
        no_p  = float(fill.get('no_price_dollars', 0))
        actual_price_cents = round((yes_p if side == 'yes' else no_p) * 100)
        count = float(fill.get('count_fp', 1))

        if actual_price_cents <= 0:
            skipped += 1; continue

        # BTC spot at fill time
        spot = get_spot_at_fill(fill_ts, c1_by_ts)
        if not spot or spot <= 0:
            # fallback: last 15m candle close
            prior_15m = [c for c in c15_sorted if c['time'] + 900 <= fill_ts]
            if prior_15m:
                spot = prior_15m[-1]['close']
        if not spot or spot <= 0:
            skipped += 1; continue

        # Minutes left in window
        minutes_left = get_minutes_left(fill_time, ticker, outcomes)
        if minutes_left is None or minutes_left <= 0:
            skipped += 1; continue

        # GK vol from last 16 complete 15m candles before fill
        prior_15m = [c for c in c15_sorted if c['time'] + 900 <= fill_ts]
        if len(prior_15m) < 4:
            skipped += 1; continue
        newest_32 = list(reversed(prior_15m[-32:]))
        gk = gk_vol(newest_32)
        if not gk or gk <= 0:
            skipped += 1; continue

        # d-score
        candles_left = minutes_left / 15.0
        try:
            d_raw = math.log(spot / floor_strike) / (gk * math.sqrt(candles_left))
        except (ValueError, ZeroDivisionError):
            skipped += 1; continue

        above_strike = spot > floor_strike
        d_abs = abs(d_raw)

        # Brownian model price for THIS side
        brownian_cents = compute_brownian_price(spot, floor_strike, gk, minutes_left, side)
        if brownian_cents is None:
            skipped += 1; continue

        # Did we win?
        won = (side == outcome['result'])

        # P&L — fee is paid at entry on every trade (win or loss)
        fee_total   = kalshi_fee(int(count), actual_price_cents)   # $ for whole order
        fee_per_c   = fee_total / count
        net_win_per = (100 - actual_price_cents) / 100.0 - fee_per_c
        net_los_per = -(actual_price_cents / 100.0) - fee_per_c
        pnl         = count * net_win_per if won else count * net_los_per
        fee_paid    = fee_total   # always paid regardless of outcome

        # Actual discount vs Brownian
        discount_cents = brownian_cents - actual_price_cents  # positive = we paid LESS than Brownian (edge)

        analyzed.append({
            'ticker': ticker,
            'fill_time': fill_time.isoformat(),
            'side': side,
            'actual_price_cents': actual_price_cents,
            'brownian_cents': round(brownian_cents, 1),
            'discount_cents': round(discount_cents, 1),  # actual edge per contract
            'count': count,
            'spot': round(spot, 1),
            'strike': floor_strike,
            'dist_pct': round((spot - floor_strike) / floor_strike * 100, 4),
            'd': round(d_raw, 3),
            'd_abs': round(d_abs, 3),
            'above_strike': above_strike,
            'minutes_left': round(minutes_left, 1),
            'gk_vol': round(gk, 6),
            'result': outcome['result'],
            'won': won,
            'pnl': round(pnl, 4),
            'fee_paid': round(fee_paid, 4),
            'hour_utc': fill_time.hour,
        })

    log.info(f"Analyzed {len(analyzed)} live trades (skipped {skipped})")
    return analyzed


def print_bucket_table(records: list, field: str, buckets: list, label: str) -> None:
    print(f"\n  {label}")
    print(f"  {'Bucket':<28} {'N':>5} {'WinRate':>8} {'AvgPrice':>9} {'BrownE':>7} {'Discount':>9} {'AvgPnL':>8}")
    for lo, hi, name in buckets:
        subset = [r for r in records if lo <= r.get(field, float('inf')) < hi]
        if len(subset) < 3:
            continue
        wr = sum(1 for r in subset if r['won']) / len(subset)
        avg_price = sum(r['actual_price_cents'] for r in subset) / len(subset)
        avg_brown = sum(r['brownian_cents'] for r in subset) / len(subset)
        avg_disc  = sum(r['discount_cents'] for r in subset) / len(subset)
        avg_pnl   = sum(r['pnl'] for r in subset) / len(subset)
        print(f"  {name:<28} {len(subset):>5} {wr:>7.1%} {avg_price:>8.1f}¢ {avg_brown:>6.1f}¢ {avg_disc:>+8.1f}¢ {avg_pnl:>+7.3f}")


def main():
    # Load fills
    if not os.path.exists(FILLS_FILE):
        print("ERROR: live_fills.json not found. Run the auth script first."); return

    with open(FILLS_FILE) as f:
        data = json.load(f)
    buy_fills = data.get('buy_fills', [])
    log.info(f"Loaded {len(buy_fills)} live buy fills from Kalshi")

    # Get unique tickers
    tickers = list({f['ticker'] for f in buy_fills if 'KXBTC15M' in f.get('ticker', '')})
    log.info(f"Unique KXBTC15M tickers: {len(tickers)}")

    # Load or build analysis cache
    if os.path.exists(CACHE_FILE):
        log.info("Loading cached analysis data...")
        with open(CACHE_FILE) as f:
            cache = json.load(f)
        outcomes = cache['outcomes']
        candles_15m = cache['candles_15m']
        candles_1m  = cache['candles_1m']
    else:
        # Fetch outcomes
        outcomes = fetch_settled_outcomes(set(tickers))

        # Date range for candles
        fill_times = []
        for f in buy_fills:
            ft = parse_fill_time(f)
            if ft:
                fill_times.append(ft)

        if not fill_times:
            print("No valid fill times"); return

        earliest = min(fill_times) - timedelta(hours=12)  # context buffer
        latest   = max(fill_times) + timedelta(hours=1)

        log.info(f"Fetching candles from {earliest.date()} to {latest.date()}...")
        candles_15m = fetch_candles_15m_range(earliest, latest)
        candles_1m  = fetch_candles_1m_range(earliest, latest)

        with open(CACHE_FILE, 'w') as f:
            json.dump({'outcomes': outcomes, 'candles_15m': candles_15m, 'candles_1m': candles_1m}, f)
        log.info(f"Cached to {CACHE_FILE}")

    log.info(f"Outcomes: {len(outcomes)}  |  15m candles: {len(candles_15m)}  |  1m candles: {len(candles_1m)}")

    # Analyze
    trades = analyze_live_trades(buy_fills, outcomes, candles_15m, candles_1m)

    if not trades:
        print("No trades could be analyzed"); return

    # ── Report ───────────────────────────────────────────────────────────────────
    wins   = [t for t in trades if t['won']]
    losses = [t for t in trades if not t['won']]
    total_pnl      = sum(t['pnl'] for t in trades)
    total_fees     = sum(t['fee_paid'] for t in trades)
    total_vol      = sum(t['count'] * t['actual_price_cents'] / 100 for t in trades)
    avg_price      = sum(t['actual_price_cents'] for t in trades) / len(trades)
    avg_brownian   = sum(t['brownian_cents'] for t in trades) / len(trades)
    avg_discount   = sum(t['discount_cents'] for t in trades) / len(trades)
    avg_d          = sum(t['d_abs'] for t in trades) / len(trades)

    print("\n" + "=" * 80)
    print("  LIVE TRADE ANALYSIS — Real fills from Kalshi portfolio")
    print("=" * 80)
    print(f"  Total BUY fills analyzed : {len(trades)}")
    print(f"  Win / Loss               : {len(wins)} / {len(losses)}")
    print(f"  Win rate                 : {len(wins)/len(trades):.1%}")
    print(f"  Total volume traded      : ${total_vol:.2f}")
    print(f"  Total P&L (net of fees)  : ${total_pnl:+.2f}")
    print(f"  Total Kalshi fees paid   : ${total_fees:.2f}")
    print()
    print(f"  Avg actual price paid    : {avg_price:.1f}¢")
    print(f"  Avg Brownian model price : {avg_brownian:.1f}¢")
    print(f"  Avg discount vs Brownian : {avg_discount:+.1f}¢  {'(paid LESS → genuine edge)' if avg_discount > 0 else '(paid MORE → overpaying)'}")
    print(f"  Avg |d|-score at entry   : {avg_d:.3f}")
    print(f"  Date range               : {trades[-1]['fill_time'][:10]} → {trades[0]['fill_time'][:10]}")

    if losses:
        avg_win  = sum(t['pnl'] for t in wins) / len(wins) if wins else 0
        avg_loss = sum(t['pnl'] for t in losses) / len(losses)
        pf = abs(sum(t['pnl'] for t in wins) / sum(t['pnl'] for t in losses)) if losses else float('inf')
        print()
        print(f"  Avg win P&L  : ${avg_win:+.4f}/trade")
        print(f"  Avg loss P&L : ${avg_loss:+.4f}/trade")
        print(f"  Profit factor: {pf:.2f}x")

    # ── Win rate by d-bucket ─────────────────────────────────────────────────────
    print("\n" + "=" * 80)
    print("  EMPIRICAL WIN RATE BY d-BUCKET (REAL LIVE TRADES)")
    print("  Win rate = actual Kalshi settlement / N live fills at that d level")
    print("=" * 80)
    d_buckets = [
        (0.0, 0.5,  "|d| 0.0–0.5  (near strike)  "),
        (0.5, 0.8,  "|d| 0.5–0.8  (mild edge)     "),
        (0.8, 1.0,  "|d| 0.8–1.0  (moderate)      "),
        (1.0, 1.2,  "|d| 1.0–1.2  (current gate)  "),
        (1.2, 1.5,  "|d| 1.2–1.5  (above gate)    "),
        (1.5, 2.0,  "|d| 1.5–2.0  (high conf)     "),
        (2.0, 10.0, "|d| 2.0+     (extreme)        "),
    ]
    print_bucket_table(trades, 'd_abs', d_buckets, "Win rate / price / discount by |d|")

    # ── Discount distribution ─────────────────────────────────────────────────────
    print("\n" + "=" * 80)
    print("  ACTUAL KALSHI PRICE vs BROWNIAN MODEL — Discount Distribution")
    print("  (Discount = Brownian price - actual price paid. Positive = edge.)")
    print("=" * 80)
    disc_buckets = [
        (-30, -10, "Paid >10¢ ABOVE Brownian      "),
        (-10, -5,  "Paid 5–10¢ above Brownian     "),
        (-5,  -1,  "Paid 1–5¢ above Brownian      "),
        (-1,   1,  "Roughly at Brownian (±1¢)     "),
        (1,    5,  "Paid 1–5¢ below Brownian ✓   "),
        (5,   10,  "Paid 5–10¢ below Brownian ✓  "),
        (10,  20,  "Paid 10–20¢ below Brownian ✓ "),
        (20,  40,  "Paid 20–40¢ below Brownian ✓ "),
    ]
    print_bucket_table(trades, 'discount_cents', disc_buckets, "Discount vs Brownian model")

    # ── Price paid distribution ───────────────────────────────────────────────────
    print("\n" + "=" * 80)
    print("  ACTUAL PRICE DISTRIBUTION — what did Kalshi charge?")
    print("=" * 80)
    price_buckets = [
        (50, 60, "50–59¢ (near 50/50)  "),
        (60, 70, "60–69¢               "),
        (70, 75, "70–74¢               "),
        (75, 80, "75–79¢               "),
        (80, 85, "80–84¢               "),
        (85, 90, "85–89¢               "),
        (90, 95, "90–94¢               "),
        (95, 100,"95–99¢ (very high)   "),
    ]
    print_bucket_table(trades, 'actual_price_cents', price_buckets, "Win rate / discount by price bucket")

    # ── Time-of-day ───────────────────────────────────────────────────────────────
    hour_buckets = [
        (0, 4,   "00–04 UTC (Asia)    "),
        (4, 8,   "04–08 UTC (Asia/EU) "),
        (8, 12,  "08–12 UTC (EU open) "),
        (12, 16, "12–16 UTC (NY open) "),
        (16, 20, "16–20 UTC (NY)      "),
        (20, 24, "20–24 UTC (NY close)"),
    ]
    print_bucket_table(trades, 'hour_utc', hour_buckets, "Win rate / price / discount by UTC hour")

    # ── Honest backtest: using ACTUAL observed prices ─────────────────────────────
    print("\n" + "=" * 80)
    print("  HONEST P&L SIMULATION (real fills, real outcomes, real fees)")
    print("=" * 80)
    total_cost     = sum(t['count'] * t['actual_price_cents'] / 100 for t in trades)
    total_gross_win = sum(t['count'] * (100 - t['actual_price_cents']) / 100 for t in wins)
    total_fees_paid = sum(t['fee_paid'] for t in trades)
    net_pnl        = total_pnl
    print(f"  Total invested (cost of contracts) : ${total_cost:.2f}")
    print(f"  Total gross winnings               : ${total_gross_win:.2f}")
    print(f"  Total Kalshi fees                  : ${total_fees_paid:.2f}")
    print(f"  Total net P&L                      : ${net_pnl:+.2f}")
    print(f"  Return on capital deployed         : {net_pnl/total_cost*100:+.1f}%")

    # ── Key question: is Kalshi underpriced? ─────────────────────────────────────
    print("\n" + "=" * 80)
    print("  KEY FINDING: Is Kalshi underpricing vs Brownian model?")
    print("=" * 80)
    positive_disc = [t for t in trades if t['discount_cents'] > 0]
    negative_disc = [t for t in trades if t['discount_cents'] <= 0]
    print(f"  Trades where we paid LESS than Brownian (genuine edge) : {len(positive_disc)} ({len(positive_disc)/len(trades):.1%})")
    print(f"  Trades where we paid MORE than Brownian (overpaying)   : {len(negative_disc)} ({len(negative_disc)/len(trades):.1%})")
    print(f"  Average discount across all trades: {avg_discount:+.1f}¢")
    print()
    print("  Win rate at discount > 5¢: ", end='')
    hi_disc = [t for t in trades if t['discount_cents'] > 5]
    if hi_disc:
        print(f"{sum(1 for t in hi_disc if t['won'])/len(hi_disc):.1%} ({len(hi_disc)} trades)")
    else:
        print("no trades")
    print("  Win rate at discount < 0¢: ", end='')
    lo_disc = [t for t in trades if t['discount_cents'] < 0]
    if lo_disc:
        print(f"{sum(1 for t in lo_disc if t['won'])/len(lo_disc):.1%} ({len(lo_disc)} trades)")
    else:
        print("no trades")

    # Save results
    with open('live_analysis_results.json', 'w') as f:
        json.dump({'trades': trades, 'summary': {
            'total': len(trades), 'wins': len(wins), 'losses': len(losses),
            'win_rate': len(wins)/len(trades),
            'total_pnl': total_pnl, 'avg_discount_cents': avg_discount,
            'avg_price_cents': avg_price, 'avg_brownian_cents': avg_brownian,
        }}, f, indent=2)
    log.info("Results saved to live_analysis_results.json")


if __name__ == '__main__':
    main()
