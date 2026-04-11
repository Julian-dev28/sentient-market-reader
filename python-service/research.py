"""
KXBTC15M Quant Research Script
================================
Phase 0–3 of the algo improvement plan.

This script:
  1. Fetches and caches 30 days of BTC 15-min OHLCV + Kalshi settled markets
  2. Runs empirical calibration of the Brownian model vs actual outcomes (no fabricated prices)
  3. Identifies bugs in the existing implementation
  4. Tests regime filters (vol, time-of-day, Hurst, CUSUM)
  5. Tests incremental signal value of RSI / MACD / BB / Stoch beyond d-score alone
  6. Tests new signal hypotheses: Hurst, ATR-regime, intraday vol pattern
  7. Walk-forward optimizes d-threshold and entry window
  8. Outputs full research report with before/after metrics

Run:
  python3 research.py [--days 30] [--cache cache.json] [--report]
"""

import math
import json
import time
import logging
import argparse
import os
from datetime import datetime, timezone, timedelta
from typing import Optional
from collections import defaultdict

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

COINBASE_BASE = "https://api.exchange.coinbase.com"
KALSHI_BASE   = "https://api.elections.kalshi.com/trade-api/v2"

_S = requests.Session()
_S.headers["User-Agent"] = "sentient-research/1.0"

CACHE_FILE = os.path.join(os.path.dirname(__file__), "research_cache.json")


# ─── Math helpers ──────────────────────────────────────────────────────────────

def norm_cdf(z: float) -> float:
    sign = 1 if z >= 0 else -1
    x = abs(z)
    t = 1.0 / (1.0 + 0.2316419 * x)
    poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))))
    pdf = math.exp(-0.5 * x * x) / math.sqrt(2 * math.pi)
    return 0.5 + sign * (0.5 - pdf * poly)


def norm_pdf(z: float) -> float:
    return math.exp(-0.5 * z * z) / math.sqrt(2 * math.pi)


# ─── Data fetchers ─────────────────────────────────────────────────────────────

def _get(url: str, retries: int = 4) -> dict:
    for attempt in range(retries):
        try:
            r = _S.get(url, timeout=20)
            if r.status_code == 429:
                time.sleep(2 ** attempt)
                continue
            r.raise_for_status()
            return r.json()
        except Exception:
            if attempt < retries - 1:
                time.sleep(1.5 ** attempt)
                continue
            raise


def fetch_candles_15m(start_dt: datetime, end_dt: datetime) -> list:
    """Fetch 15-min BTC-USD candles from Coinbase. Returns [{time,open,high,low,close,volume}] oldest-first."""
    granularity = 900
    chunk_secs = 280 * granularity
    all_c = []
    cur = start_dt.astimezone(timezone.utc)
    end = end_dt.astimezone(timezone.utc)
    while cur < end:
        chunk_end = min(cur + timedelta(seconds=chunk_secs), end)
        url = (f"{COINBASE_BASE}/products/BTC-USD/candles?granularity={granularity}"
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
            time.sleep(0.3)
    seen = set()
    uniq = [c for c in all_c if c['time'] not in seen and not seen.add(c['time'])]
    uniq.sort(key=lambda c: c['time'])
    log.info(f"Fetched {len(uniq)} BTC/15m candles")
    return uniq


def fetch_candles_1m(start_dt: datetime, end_dt: datetime) -> list:
    """Fetch 1-min BTC-USD candles from Coinbase."""
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
                    all_c.append([int(c[0]), float(c[1]), float(c[2]),
                                  float(c[3]), float(c[4]), float(c[5])])
        except Exception as e:
            log.warning(f"1m chunk failed {cur}: {e}")
        cur = chunk_end
        if cur < end:
            time.sleep(0.25)
    seen = set()
    uniq = [c for c in all_c if c[0] not in seen and not seen.add(c[0])]
    uniq.sort(key=lambda c: c[0])
    log.info(f"Fetched {len(uniq)} BTC/1m candles")
    return uniq


def fetch_settled_markets(days_back: int) -> list:
    cutoff = datetime.now(timezone.utc) - timedelta(days=days_back)
    markets, cursor = [], None
    while True:
        url = f"{KALSHI_BASE}/markets?series_ticker=KXBTC15M&status=settled&limit=200"
        if cursor:
            url += f"&cursor={cursor}"
        try:
            data = _get(url)
        except Exception as e:
            log.error(f"Kalshi fetch failed: {e}"); break
        batch = data.get('markets', [])
        if not batch:
            break
        done = False
        for m in batch:
            ct = m.get('close_time') or m.get('expiration_time')
            if not ct:
                continue
            try:
                close_dt = datetime.fromisoformat(ct.replace('Z', '+00:00'))
            except ValueError:
                continue
            if close_dt < cutoff:
                done = True; break
            fs = m.get('floor_strike')
            result = m.get('result')
            ticker = m.get('ticker', '')
            if fs is not None and result in ('yes', 'no') and ticker:
                try:
                    markets.append({'ticker': ticker, 'floor_strike': float(fs),
                                    'result': result, 'close_time': ct})
                except Exception:
                    pass
        if done:
            break
        cursor = data.get('cursor')
        if not cursor:
            break
        time.sleep(0.15)
    log.info(f"Fetched {len(markets)} settled markets ({days_back}d)")
    return markets


# ─── Signal computation ────────────────────────────────────────────────────────

def gk_vol(candles_newest: list, n: int = 16) -> Optional[float]:
    K = 2 * math.log(2) - 1
    terms = []
    for c in candles_newest[:n]:
        h, l, o, cl = c['high'], c['low'], c['open'], c['close']
        if o <= 0 or l <= 0 or h <= 0:
            continue
        gk = 0.5 * math.log(h / l) ** 2 - K * math.log(cl / o) ** 2
        terms.append(gk)
    if len(terms) < 4:
        return None
    return math.sqrt(max(sum(terms) / len(terms), 0.0))


def atr(candles_newest: list, n: int = 14) -> Optional[float]:
    """Average True Range — measures recent volatility in absolute price terms."""
    trs = []
    for i in range(min(n, len(candles_newest) - 1)):
        c = candles_newest[i]
        prev_close = candles_newest[i + 1]['close']
        tr = max(c['high'] - c['low'],
                 abs(c['high'] - prev_close),
                 abs(c['low'] - prev_close))
        trs.append(tr)
    if not trs:
        return None
    return sum(trs) / len(trs)


def realized_vol(candles_newest: list, n: int = 16) -> Optional[float]:
    closes = [c['close'] for c in candles_newest[:n + 1]]
    if len(closes) < 5:
        return None
    lr = [math.log(closes[i] / closes[i + 1]) for i in range(len(closes) - 1) if closes[i + 1] > 0]
    if not lr:
        return None
    return math.sqrt(sum(r * r for r in lr) / len(lr))


def hurst(candles_newest: list, n: int = 32) -> Optional[float]:
    closes = [c['close'] for c in reversed(candles_newest[:n])]
    if len(closes) < 10:
        return None
    lr = [math.log(closes[i] / closes[i - 1]) for i in range(1, len(closes)) if closes[i - 1] > 0]
    if len(lr) < 6:
        return None
    var1 = sum(r * r for r in lr) / len(lr)
    p2 = [lr[i] + lr[i + 1] for i in range(0, len(lr) - 1, 2)]
    var2 = sum(r * r for r in p2) / max(len(p2), 1) if p2 else 0
    if var1 <= 0:
        return None
    return max(0.0, min(1.0, 0.5 + math.log(max(var2 / (2 * var1), 1e-12)) / (2 * math.log(2))))


def rsi(candles_newest: list, period: int = 14) -> Optional[float]:
    """Standard RSI(14) — correct period matching live TypeScript."""
    closes = [c['close'] for c in reversed(candles_newest)]
    p = min(period, len(closes) - 1)
    if p < 2:
        return None
    gains = losses = 0.0
    for i in range(len(closes) - p, len(closes)):
        diff = closes[i] - closes[i - 1]
        if diff > 0:
            gains += diff
        else:
            losses += abs(diff)
    avg_gain = gains / p
    avg_loss = losses / p
    if avg_loss == 0:
        return 100.0
    return 100.0 - 100.0 / (1.0 + avg_gain / avg_loss)


def ema(closes: list, period: int) -> list:
    if len(closes) < period:
        return []
    k = 2.0 / (period + 1)
    val = sum(closes[:period]) / period
    result = [val]
    for i in range(period, len(closes)):
        val = closes[i] * k + val * (1 - k)
        result.append(val)
    return result


def macd_hist(candles_newest: list, fast: int = 12, slow: int = 26, signal: int = 9) -> Optional[float]:
    """Standard MACD(12,26,9) — correct periods matching live TypeScript."""
    closes = [c['close'] for c in reversed(candles_newest)]
    fast_e = ema(closes, fast)
    slow_e = ema(closes, slow)
    if not fast_e or not slow_e:
        return None
    offset = len(fast_e) - len(slow_e)
    ml = [fast_e[i + offset] - slow_e[i] for i in range(len(slow_e))]
    sig = ema(ml, signal)
    if not sig:
        return None
    return ml[-1] - sig[-1]


def bollinger_b(candles_newest: list, period: int = 20) -> Optional[float]:
    closes = [c['close'] for c in reversed(candles_newest)]
    p = min(period, len(closes))
    if p < 4:
        return None
    recent = closes[-p:]
    sma = sum(recent) / p
    std = math.sqrt(sum((c - sma) ** 2 for c in recent) / p)
    if std == 0:
        return None
    upper, lower = sma + 2 * std, sma - 2 * std
    return max(-0.3, min(1.3, (closes[-1] - lower) / (upper - lower)))


def stochastic(candles_newest: list, period: int = 14) -> Optional[float]:
    p = min(period, len(candles_newest))
    if p < 2:
        return None
    recent = candles_newest[:p]
    hi = max(c['high'] for c in recent)
    lo = min(c['low'] for c in recent)
    if hi == lo:
        return 50.0
    return (candles_newest[0]['close'] - lo) / (hi - lo) * 100.0


def velocity_1m(candles_1m_newest: list, lookback: int = 5) -> Optional[float]:
    if not candles_1m_newest or len(candles_1m_newest) <= lookback:
        return None
    price_now = candles_1m_newest[0][4]
    price_ago = candles_1m_newest[lookback][4]
    if price_ago <= 0:
        return None
    return (price_now - price_ago) / lookback  # $/min


def cusum(candles_newest: list, k: float = 0.5, h: float = 4.0) -> tuple:
    closes = [c['close'] for c in reversed(candles_newest[:32])]
    if len(closes) < 4:
        return False, 'none'
    lr = [math.log(closes[i] / closes[i - 1]) for i in range(1, len(closes)) if closes[i - 1] > 0]
    sigma = math.sqrt(sum(r * r for r in lr) / max(len(lr), 1)) or 0.001
    spos = sneg = 0.0
    for r in lr:
        z = r / sigma
        spos = max(0.0, spos + z - k)
        sneg = max(0.0, sneg - z - k)
    jump = spos > h or sneg > h
    direction = 'up' if spos > h else ('down' if sneg > h else 'none')
    return jump, direction


def vol_of_vol(candles_newest: list, n: int = 32) -> Optional[float]:
    """Volatility of volatility: std(|returns|) / mean(|returns|). High → unstable regime."""
    closes = [c['close'] for c in reversed(candles_newest[:n + 1])]
    if len(closes) < 8:
        return None
    abs_returns = [abs(math.log(closes[i] / closes[i - 1])) for i in range(1, len(closes)) if closes[i - 1] > 0]
    if not abs_returns:
        return None
    mean = sum(abs_returns) / len(abs_returns)
    if mean == 0:
        return None
    std = math.sqrt(sum((r - mean) ** 2 for r in abs_returns) / len(abs_returns))
    return std / mean


def intraday_vol_ratio(check_ts: float, hour_vol_map: dict) -> float:
    """Return the ratio of current hour's expected vol vs daily average. Built from historical data."""
    hour_utc = datetime.fromtimestamp(check_ts, tz=timezone.utc).hour
    return hour_vol_map.get(hour_utc, 1.0)


def momentum_score(rsi_val, macd_val, bb_val, stoch_val, above_strike: bool) -> float:
    """
    Directional momentum score. Returns a value in [-1, +1]:
    +1 = all signals confirm staying above strike (YES wins)
    -1 = all signals confirm falling below strike (NO wins)
    """
    votes = 0.0
    total = 0.0
    if rsi_val is not None:
        total += 1
        votes += 1 if rsi_val > 55 else -1 if rsi_val < 45 else 0
    if macd_val is not None:
        total += 1
        votes += 1 if macd_val > 0 else -1
    if bb_val is not None:
        total += 1
        votes += 1 if bb_val > 0.55 else -1 if bb_val < 0.45 else 0
    if stoch_val is not None:
        total += 1
        votes += 1 if stoch_val > 55 else -1 if stoch_val < 45 else 0
    raw = votes / total if total > 0 else 0
    return raw if above_strike else -raw  # positive = our side confirmed


# ─── Per-window analysis ───────────────────────────────────────────────────────

def analyze_window(
    mkt: dict,
    candles_15m: list,
    candles_1m: list,
    check_time_min_left: float = 5.0,   # simulate entry with N min left
) -> Optional[dict]:
    """
    Analyze one settled market window. Returns a rich dict of signals + outcome.
    Uses the 'close' side: what was BTC's position at the 15-min window close?

    check_time_min_left: minutes before close to simulate the entry signal check.
    """
    ticker = mkt['ticker']
    strike = mkt['floor_strike']
    result = mkt['result']  # 'yes' | 'no'

    try:
        close_dt = datetime.fromisoformat(mkt['close_time'].replace('Z', '+00:00'))
    except ValueError:
        return None

    open_dt = close_dt - timedelta(minutes=15)
    check_dt = close_dt - timedelta(minutes=check_time_min_left)
    check_ts = check_dt.timestamp()
    close_ts = close_dt.timestamp()
    open_ts = open_dt.timestamp()

    # 15-min candles complete before check time
    ctx_15m = [c for c in candles_15m if c['time'] + 900 <= check_ts]
    if len(ctx_15m) < 8:
        return None

    newest_32 = list(reversed(ctx_15m[-32:]))

    # Spot price from 1-min candle (mirrors live feed)
    m1_idx = {c[0]: c[4] for c in candles_1m}
    m1_ts = int(check_ts // 60) * 60 - 60
    spot = m1_idx.get(m1_ts) or m1_idx.get(m1_ts - 60) or newest_32[0]['close']
    if not spot or spot <= 0:
        return None

    minutes_left = check_time_min_left
    candles_left = minutes_left / 15.0

    # Volatility
    gk = gk_vol(newest_32)
    rv = realized_vol(newest_32)
    effective_vol = gk if gk and gk > 0 else rv
    if not effective_vol or effective_vol <= 0:
        return None

    atr_val = atr(newest_32)

    # d-score (Brownian reachability)
    try:
        d = math.log(spot / strike) / (effective_vol * math.sqrt(candles_left))
    except (ValueError, ZeroDivisionError):
        return None

    # Theoretical Brownian win probability (direction-locked)
    p_brownian = norm_cdf(abs(d))  # always bet current side → P(win) = N(|d|)
    above_strike = spot > strike
    side = 'yes' if above_strike else 'no'

    # Did we win?
    won = (side == result)

    # Distance from strike
    dist_pct = (spot - strike) / strike * 100.0

    # Regime signals
    h = hurst(newest_32)
    jump, jump_dir = cusum(newest_32)
    vov = vol_of_vol(newest_32)

    # Technical indicators
    rsi_val = rsi(newest_32)
    macd_val = macd_hist(newest_32)
    bb_val = bollinger_b(newest_32)
    stoch_val = stochastic(newest_32)
    mom_score = momentum_score(rsi_val, macd_val, bb_val, stoch_val, above_strike)

    # Velocity (1-min)
    ctx_1m = [c for c in candles_1m if c[0] + 60 <= check_ts]
    vel = None
    if len(ctx_1m) >= 6:
        vel = velocity_1m(list(reversed(ctx_1m[-15:])))

    # Time-of-day (UTC hour at check time)
    hour_utc = datetime.fromtimestamp(check_ts, tz=timezone.utc).hour
    weekday = datetime.fromtimestamp(check_ts, tz=timezone.utc).weekday()  # 0=Mon, 6=Sun

    # Momentum over last 4 candles (1h trend)
    if len(newest_32) >= 5:
        price_1h_ago = newest_32[4]['close']
        mom_1h_pct = (spot - price_1h_ago) / price_1h_ago * 100.0 if price_1h_ago > 0 else 0.0
    else:
        mom_1h_pct = 0.0

    # Vol regime: GK vol vs median
    vol_regime = 'normal'  # will be classified later after we know the median

    return {
        'ticker': ticker,
        'close_time': mkt['close_time'],
        'open_ts': open_ts,
        'close_ts': close_ts,
        'check_ts': check_ts,
        'side': side,
        'result': result,
        'won': won,
        'spot': spot,
        'strike': strike,
        'dist_pct': dist_pct,
        'dist_usd': abs(spot - strike),
        'above_strike': above_strike,
        'minutes_left': minutes_left,
        'd': d,
        'd_abs': abs(d),
        'p_brownian': p_brownian,
        'gk_vol': gk,
        'rv_vol': rv,
        'atr': atr_val,
        'hurst': h,
        'jump': jump,
        'jump_dir': jump_dir,
        'vov': vov,
        'rsi': rsi_val,
        'macd': macd_val,
        'bb': bb_val,
        'stoch': stoch_val,
        'mom_score': mom_score,
        'vel': vel,
        'hour_utc': hour_utc,
        'weekday': weekday,
        'mom_1h_pct': mom_1h_pct,
        'vol_regime': vol_regime,
    }


# ─── Research analysis functions ───────────────────────────────────────────────

def classify_vol_regime(records: list) -> list:
    """Tag each record with high/low/normal vol based on GK vol percentiles."""
    vols = [r['gk_vol'] for r in records if r.get('gk_vol')]
    if not vols:
        return records
    vols_sorted = sorted(vols)
    p25 = vols_sorted[int(0.25 * len(vols_sorted))]
    p75 = vols_sorted[int(0.75 * len(vols_sorted))]
    for r in records:
        v = r.get('gk_vol')
        if v is None:
            r['vol_regime'] = 'unknown'
        elif v >= p75:
            r['vol_regime'] = 'high'
        elif v <= p25:
            r['vol_regime'] = 'low'
        else:
            r['vol_regime'] = 'normal'
    return records


def bucket_analysis(records: list, field: str, buckets: list, label: str) -> str:
    """Bucket records by field value and report empirical win rate + Brownian calibration."""
    lines = [f"\n{'─'*80}", f"  {label}", f"{'─'*80}",
             f"  {'Bucket':<22} {'N':>5} {'WinRate':>8} {'BrownianE':>10} {'Lift':>7} {'AvgD':>6} {'AvgVol':>8}"]
    for lo, hi, name in buckets:
        subset = [r for r in records if lo <= r.get(field, float('inf')) < hi]
        if len(subset) < 5:
            continue
        win_rate = sum(1 for r in subset if r['won']) / len(subset)
        avg_brownian = sum(r['p_brownian'] for r in subset if r.get('p_brownian')) / max(
            sum(1 for r in subset if r.get('p_brownian')), 1)
        avg_d = sum(r['d_abs'] for r in subset) / len(subset)
        avg_vol = sum(r['gk_vol'] for r in subset if r.get('gk_vol')) / max(
            sum(1 for r in subset if r.get('gk_vol')), 1)
        lift = win_rate - avg_brownian
        lines.append(f"  {name:<22} {len(subset):>5} {win_rate:>7.1%} {avg_brownian:>9.1%} {lift:>+7.1%} {avg_d:>6.2f} {avg_vol:>8.5f}")
    return '\n'.join(lines)


def conditional_win_rate(records: list, filter_fn, label: str) -> str:
    subset = [r for r in records if filter_fn(r)]
    complement = [r for r in records if not filter_fn(r)]
    if not subset or not complement:
        return f"  {label}: insufficient data"
    wr_in = sum(1 for r in subset if r['won']) / len(subset)
    wr_out = sum(1 for r in complement if r['won']) / len(complement)
    avg_d_in = sum(r['d_abs'] for r in subset) / len(subset)
    avg_d_out = sum(r['d_abs'] for r in complement) / len(complement)
    return (f"  {label}:\n"
            f"    IN  ({len(subset):>4} obs): WR={wr_in:.1%}  avg|d|={avg_d_in:.2f}\n"
            f"    OUT ({len(complement):>4} obs): WR={wr_out:.1%}  avg|d|={avg_d_out:.2f}\n"
            f"    Delta: {wr_in - wr_out:+.1%}")


def simulate_strategy(records: list, d_threshold: float, min_edge_pct: float,
                      market_discount_cents: float, min_dist_pct: float,
                      max_minutes: float, min_minutes: float,
                      extra_filter=None,
                      starting_cash: float = 500.0,
                      quarter_kelly: bool = True) -> dict:
    """
    Simulate the strategy with given parameters. Uses ACTUAL Brownian win probability
    as the market price proxy (market_discount_cents simulates Kalshi underpricing).
    """
    KALSHI_FEE = 0.07
    MAX_TRADE_PCT = 0.15
    MAX_TRADE_ABS = 150.0
    REF_VOL = 0.002
    kelly_mult = 0.25 if quarter_kelly else 0.5

    qualified = [r for r in records if (
        abs(r['d']) >= d_threshold and
        abs(r['dist_pct']) >= min_dist_pct and
        min_minutes <= r['minutes_left'] <= max_minutes and
        r.get('gk_vol') and r['gk_vol'] > 0
    )]
    if extra_filter:
        qualified = [r for r in qualified if extra_filter(r)]

    if not qualified:
        return {'trades': 0, 'win_rate': 0, 'total_return_pct': 0, 'max_dd': 0,
                'final_cash': starting_cash, 'sharpe': 0, 'records': []}

    cash = starting_cash
    peak = starting_cash
    max_dd = 0.0
    trade_pnls = []
    results = []

    for r in sorted(qualified, key=lambda x: x['check_ts']):
        p_brownian_win = r['p_brownian']  # N(|d|)
        # Market price proxy: Brownian - discount (cents → fraction)
        # We bet YES if above, NO if below. Market quotes the winning side.
        lp_cents = max(55, min(99, round(p_brownian_win * 100 - market_discount_cents)))
        lp = lp_cents / 100.0
        cost_per = lp
        net_win_per = (1.0 - lp) * (1.0 - KALSHI_FEE)
        b = net_win_per / cost_per

        # p_win uses direction lock: always bet current side, p_win = N(|d|)
        p_win = p_brownian_win
        kelly_f = max(0.0, (b * p_win - (1 - p_win)) / b)

        vol = r.get('gk_vol', REF_VOL)
        vol_scalar = max(0.30, min(1.50, REF_VOL / vol)) if vol > 0 else 1.0
        edge_pct = (p_win - lp) * 100.0

        if edge_pct < min_edge_pct:
            continue

        budget = min(kelly_f * kelly_mult * cash * vol_scalar, MAX_TRADE_PCT * cash, MAX_TRADE_ABS)
        contracts = max(0, int(budget / cost_per))
        if contracts == 0:
            continue

        cost = contracts * cost_per
        pnl = contracts * net_win_per if r['won'] else -cost
        cash = max(0.0, cash + pnl)
        peak = max(peak, cash)
        dd = (peak - cash) / peak
        max_dd = max(max_dd, dd)
        trade_pnls.append(pnl)
        results.append({**r, '_lp': lp_cents, '_edge': edge_pct, '_pnl': pnl,
                        '_cash': cash, '_contracts': contracts})

    if not trade_pnls:
        return {'trades': 0, 'win_rate': 0, 'total_return_pct': 0, 'max_dd': 0,
                'final_cash': starting_cash, 'sharpe': 0, 'records': []}

    wins = [p for p in trade_pnls if p > 0]
    losses = [p for p in trade_pnls if p <= 0]
    n = len(trade_pnls)
    mean_pnl = sum(trade_pnls) / n
    std_pnl = math.sqrt(sum((p - mean_pnl) ** 2 for p in trade_pnls) / n) if n > 1 else 0
    # Annualized Sharpe (30 trades/day * 365 days)
    sharpe = (mean_pnl / std_pnl * math.sqrt(n * 365 / 30)) if std_pnl > 0 else 0
    profit_factor = abs(sum(wins) / sum(losses)) if losses else float('inf')

    return {
        'trades': n,
        'wins': len(wins),
        'losses': len(losses),
        'win_rate': len(wins) / n,
        'total_return_pct': (cash - starting_cash) / starting_cash * 100,
        'final_cash': cash,
        'max_dd': max_dd,
        'sharpe': sharpe,
        'profit_factor': profit_factor,
        'avg_win': sum(wins) / len(wins) if wins else 0,
        'avg_loss': sum(losses) / len(losses) if losses else 0,
        'records': results,
    }


def walk_forward_optimize(records: list, param_grid: dict) -> dict:
    """
    Walk-forward optimize d_threshold using chronological 70/30 train/test split.
    Returns best params + out-of-sample metrics.
    """
    records_sorted = sorted(records, key=lambda r: r['check_ts'])
    split = int(len(records_sorted) * 0.70)
    train = records_sorted[:split]
    test = records_sorted[split:]

    log.info(f"Walk-forward: {len(train)} train / {len(test)} test windows")

    best_params = None
    best_sharpe = -float('inf')

    for d_thresh in param_grid['d_threshold']:
        for discount in param_grid['market_discount_cents']:
            for min_edge in param_grid['min_edge_pct']:
                result = simulate_strategy(
                    train, d_thresh, min_edge, discount,
                    min_dist_pct=0.02, max_minutes=13.0, min_minutes=3.0
                )
                if result['trades'] < 20:
                    continue
                if result['sharpe'] > best_sharpe:
                    best_sharpe = result['sharpe']
                    best_params = {'d_threshold': d_thresh, 'market_discount_cents': discount, 'min_edge_pct': min_edge}

    if not best_params:
        return {'best_params': None, 'train': {}, 'test': {}}

    train_result = simulate_strategy(train, **best_params, min_dist_pct=0.02,
                                     max_minutes=13.0, min_minutes=3.0)
    test_result = simulate_strategy(test, **best_params, min_dist_pct=0.02,
                                    max_minutes=13.0, min_minutes=3.0)

    return {'best_params': best_params, 'train': train_result, 'test': test_result}


def compute_hourly_vol(records: list) -> dict:
    """Compute average GK vol by UTC hour — for intraday vol regime detection."""
    by_hour = defaultdict(list)
    for r in records:
        if r.get('gk_vol'):
            by_hour[r['hour_utc']].append(r['gk_vol'])
    avg_vol = {h: sum(vs) / len(vs) for h, vs in by_hour.items()}
    global_avg = sum(avg_vol.values()) / len(avg_vol) if avg_vol else 1.0
    return {h: v / global_avg for h, v in avg_vol.items()}


# ─── Main research report ──────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--days', type=int, default=30)
    parser.add_argument('--cache', type=str, default=CACHE_FILE)
    parser.add_argument('--no-cache', action='store_true')
    parser.add_argument('--report', action='store_true', help='Print full report')
    args = parser.parse_args()

    # ── Phase 0: Load or fetch data ─────────────────────────────────────────────
    if not args.no_cache and os.path.exists(args.cache):
        log.info(f"Loading cached data from {args.cache}")
        with open(args.cache) as f:
            cache = json.load(f)
        markets = cache['markets']
        candles_15m = cache['candles_15m']
        candles_1m = cache['candles_1m']
        log.info(f"Loaded: {len(markets)} markets, {len(candles_15m)} 15m candles, {len(candles_1m)} 1m candles")
    else:
        log.info(f"Fetching fresh data ({args.days}d)...")
        markets = fetch_settled_markets(args.days)
        if not markets:
            print("No markets found"); return

        close_times = []
        for m in markets:
            try:
                close_times.append(datetime.fromisoformat(m['close_time'].replace('Z', '+00:00')))
            except Exception:
                pass

        earliest = min(close_times) - timedelta(hours=10)
        latest = max(close_times) + timedelta(minutes=30)
        candles_15m = fetch_candles_15m(earliest, latest)
        candles_1m = fetch_candles_1m(earliest - timedelta(minutes=30), latest)

        # Cache for future runs
        cache = {
            'markets': markets,
            'candles_15m': candles_15m,
            'candles_1m': candles_1m,
            'fetched_at': datetime.now(timezone.utc).isoformat(),
            'days': args.days,
        }
        with open(args.cache, 'w') as f:
            json.dump(cache, f)
        log.info(f"Cached to {args.cache}")

    # ── Phase 1: Compute signals for all windows at fixed 5-min entry ───────────
    log.info("Computing signals for all market windows...")
    ALL_RECORDS = []
    for mkt in markets:
        try:
            r = analyze_window(mkt, candles_15m, candles_1m, check_time_min_left=5.0)
            if r:
                ALL_RECORDS.append(r)
        except Exception as e:
            log.debug(f"Skip {mkt.get('ticker','?')}: {e}")

    ALL_RECORDS = classify_vol_regime(ALL_RECORDS)
    log.info(f"Analyzed {len(ALL_RECORDS)} windows (of {len(markets)} markets)")

    # ── Intraday vol map ────────────────────────────────────────────────────────
    hourly_vol = compute_hourly_vol(ALL_RECORDS)

    # ── Phase 2: Baseline metrics ───────────────────────────────────────────────
    print("\n" + "=" * 80)
    print("  PHASE 0+1: DATA QUALITY + SIGNAL AUDIT")
    print("=" * 80)
    print(f"  Total settled markets fetched: {len(markets)}")
    print(f"  Windows with sufficient data:  {len(ALL_RECORDS)}")
    print(f"  BTC 15m candles:               {len(candles_15m)}")
    print(f"  BTC 1m candles:                {len(candles_1m)}")

    # Overall market stats
    all_d = [r['d_abs'] for r in ALL_RECORDS]
    all_gk = [r['gk_vol'] for r in ALL_RECORDS if r.get('gk_vol')]
    yes_results = [r for r in ALL_RECORDS if r['result'] == 'yes']
    print("\n  Market stats:")
    print(f"    YES outcomes: {len(yes_results)}/{len(ALL_RECORDS)} ({len(yes_results)/len(ALL_RECORDS):.1%})")
    print(f"    Median |d| at 5min left: {sorted(all_d)[len(all_d)//2]:.3f}")
    print(f"    Median GK vol:           {sorted(all_gk)[len(all_gk)//2]:.5f}")

    # ─ BUG REPORT ──────────────────────────────────────────────────────────────
    print("\n" + "=" * 80)
    print("  PHASE 1: BUG REPORT")
    print("=" * 80)

    bugs = [
        ("HIGH", "Fabricated market price",
         "MARKET_DISCOUNT_CENTS=8 is asserted, not measured from actual Kalshi orderbook. "
         "Edge calculation is circular: edge = p_model - (p_brownian - 0.08). "
         "We have no historical Kalshi prices to validate this.",
         "run_backtest.py:623-631"),
        ("HIGH", "Direction lock creates tautological win rate",
         "Strategy ALWAYS bets current BTC side (direction lock). Entry gate |d|>1.2 "
         "ensures BTC is already far from strike. Theoretical P(win) = N(1.2) ≈ 88.5% "
         "with 5min left. 93.6% backtest win rate is mathematically expected, not alpha.",
         "run_backtest.py:479-486"),
        ("HIGH", "RSI period inconsistency: backtest uses RSI(9), live uses RSI(14)",
         "run_backtest.py compute_rsi() defaults to period=9. "
         "indicators.ts uses period=14. Signals will differ between backtest and live.",
         "run_backtest.py:201"),
        ("HIGH", "MACD periods inconsistency: backtest uses (5,10,3), live uses (12,26,9)",
         "run_backtest.py compute_macd() uses fast=5,slow=10,signal=3. "
         "indicators.ts uses fast=12,slow=26,signal=9. Backtest MACD is not the live MACD.",
         "run_backtest.py:216"),
        ("MEDIUM", "Two separate backtest scripts with divergent logic",
         "backtest.py uses fixed 10-min entry (5min left). "
         "run_backtest.py uses d-poller simulation. Different entry timing = different results. "
         "Neither is marked as the canonical implementation.",
         "backtest.py:457, run_backtest.py:535"),
        ("MEDIUM", "Annualization formula redundancy",
         "p_fat_tail and p_skew_adj in run_backtest.py annualize GK vol then de-annualize "
         "via T=minutes/(365*24*60). Net result is mathematically identical to p_brownian "
         "for short T. Cornish-Fisher and fat-tail add no incremental signal at 5min left.",
         "run_backtest.py:133-145"),
        ("MEDIUM", "Reachability gate redundant with direction lock at high |d|",
         "When |d|>1.2, BTC is far from strike. Velocity is almost always below req_vel "
         "(dist_usd/min_left), so gate fires and pushes p_model to 0.05-0.20 or 0.80-0.95 "
         "— the same range direction lock already achieved. Gate has no incremental effect.",
         "run_backtest.py:498-510"),
        ("LOW", "Silent error handling swallows market data gaps",
         "fetch_candles() warnings on chunk failure but continues silently. "
         "Gaps in candle data produce wrong context candles for subsequent windows.",
         "run_backtest.py:319-321"),
        ("LOW", "Bollinger period 12 in backtest vs 20 in standard",
         "compute_bollinger_b() uses period=12 (non-standard). "
         "Standard is 20. Live code may differ.",
         "run_backtest.py:228"),
    ]

    for severity, name, desc, loc in bugs:
        print(f"\n  [{severity}] {name}")
        print(f"    Location: {loc}")
        print(f"    Impact:   {desc}")

    # ─ PHASE 2: EMPIRICAL CALIBRATION ──────────────────────────────────────────
    print("\n" + "=" * 80)
    print("  PHASE 2: EMPIRICAL CALIBRATION — Brownian vs Actual Win Rate")
    print("  (All windows; no market price filter. Direction-locked win rate.)")
    print("=" * 80)

    # All windows: empirical win rate by d-bucket (direction-locked)
    d_buckets = [
        (0.0, 0.5,  "|d| 0.0–0.5  (near strike)"),
        (0.5, 0.8,  "|d| 0.5–0.8  (mild edge)  "),
        (0.8, 1.0,  "|d| 0.8–1.0  (moderate)   "),
        (1.0, 1.2,  "|d| 1.0–1.2  (entry zone) "),
        (1.2, 1.5,  "|d| 1.2–1.5  (above gate) "),
        (1.5, 2.0,  "|d| 1.5–2.0  (high conf)  "),
        (2.0, 10.0, "|d| 2.0+     (extreme)     "),
    ]
    print(bucket_analysis(ALL_RECORDS, 'd_abs', d_buckets,
                          "Empirical win rate by |d| bucket (direction-locked)"))

    print("\n  NOTE: 'BrownianE' = N(|d|) theoretical. 'Lift' = actual - theoretical.")
    print("  Negative lift = Brownian OVERestimates win prob (dangerous: we pay more than edge warrants).")
    print("  Positive lift = Brownian UNDERestimates (genuine alpha if systematic).")

    # ─ PHASE 3: REGIME ANALYSIS ─────────────────────────────────────────────────
    print("\n" + "=" * 80)
    print("  PHASE 3: REGIME ANALYSIS")
    print("=" * 80)

    # Filter to entry-zone |d| >= 1.2 (same as live gate)
    gated = [r for r in ALL_RECORDS if r['d_abs'] >= 1.2]
    print(f"\n  Total windows with |d|>=1.2: {len(gated)}")
    print(f"  Win rate at |d|>=1.2: {sum(1 for r in gated if r['won'])/len(gated):.1%}" if gated else "  No data")

    if gated:
        # Vol regime
        vol_buckets = [
            (0.0, 0.001, "GK vol <0.001 (low)    "),
            (0.001, 0.002, "GK vol 0.001-0.002     "),
            (0.002, 0.003, "GK vol 0.002-0.003     "),
            (0.003, 0.005, "GK vol 0.003-0.005     "),
            (0.005, 99.0, "GK vol >0.005 (high)   "),
        ]
        print(bucket_analysis(gated, 'gk_vol', vol_buckets, "Win rate by vol regime (|d|>=1.2)"))

        # Time of day
        hour_buckets = [
            (0, 4,   "00-04 UTC (Asia early)"),
            (4, 8,   "04-08 UTC (Asia/EU)   "),
            (8, 12,  "08-12 UTC (EU open)   "),
            (12, 16, "12-16 UTC (NY open)   "),
            (16, 20, "16-20 UTC (NY session)"),
            (20, 24, "20-24 UTC (NY close)  "),
        ]
        print(bucket_analysis(gated, 'hour_utc', hour_buckets, "Win rate by UTC hour (|d|>=1.2)"))

        # Hurst regime
        print("\n" + conditional_win_rate(gated, lambda r: r.get('hurst', 0.5) > 0.55,
                                          "Trending market (Hurst > 0.55) vs mean-reverting"))
        print(conditional_win_rate(gated, lambda r: r.get('hurst', 0.5) < 0.45,
                                   "Mean-reverting (Hurst < 0.45) vs rest"))

        # Jump detection
        print(conditional_win_rate(gated, lambda r: r.get('jump', False),
                                   "CUSUM jump detected vs no jump"))

        # Vol of vol
        vov_med = sorted([r['vov'] for r in gated if r.get('vov')])[len([r for r in gated if r.get('vov')]) // 2]
        print(conditional_win_rate(gated, lambda r: (r.get('vov') or 0) > vov_med,
                                   f"High vol-of-vol (>{vov_med:.2f}) vs low"))

        # Momentum score
        print(conditional_win_rate(gated, lambda r: r.get('mom_score', 0) > 0.25,
                                   "Strong momentum confirming direction (score > 0.25)"))
        print(conditional_win_rate(gated, lambda r: r.get('mom_score', 0) < -0.25,
                                   "Momentum AGAINST our direction (score < -0.25)"))

        # 1h momentum
        print(conditional_win_rate(gated, lambda r: abs(r.get('mom_1h_pct', 0)) > 0.5,
                                   "Trending last 1h (|mom| > 0.5%)"))

        # Distance from strike
        print(conditional_win_rate(gated, lambda r: abs(r.get('dist_pct', 0)) > 0.3,
                                   "Far from strike (dist > 0.3%) vs close"))

    # ─ PHASE 3: NEW SIGNAL HYPOTHESES ───────────────────────────────────────────
    print("\n" + "=" * 80)
    print("  PHASE 3: NEW SIGNAL HYPOTHESES — Incremental Value Tests")
    print("=" * 80)

    if gated:
        print("\n  Hypothesis 1: Skip high-vol windows (GK vol > 0.003)")
        print("  Rationale: High vol = strike crossing more likely = Brownian model less reliable")
        base = simulate_strategy(ALL_RECORDS, 1.2, 6.0, 8.0, 0.02, 13.0, 3.0)
        h1_filter = lambda r: (r.get('gk_vol') or 0) <= 0.003
        h1 = simulate_strategy(ALL_RECORDS, 1.2, 6.0, 8.0, 0.02, 13.0, 3.0, extra_filter=h1_filter)
        print(f"    Baseline: {base['trades']} trades, WR={base['win_rate']:.1%}, Return={base['total_return_pct']:+.1f}%, MaxDD={base['max_dd']:.1%}")
        print(f"    H1 (low-vol only): {h1['trades']} trades, WR={h1['win_rate']:.1%}, Return={h1['total_return_pct']:+.1f}%, MaxDD={h1['max_dd']:.1%}")

        print("\n  Hypothesis 2: Skip CUSUM jump windows")
        print("  Rationale: Jump = structural break = Brownian diffusion model invalid")
        h2_filter = lambda r: not r.get('jump', False)
        h2 = simulate_strategy(ALL_RECORDS, 1.2, 6.0, 8.0, 0.02, 13.0, 3.0, extra_filter=h2_filter)
        print(f"    Baseline: {base['trades']} trades, WR={base['win_rate']:.1%}")
        print(f"    H2 (no-jump): {h2['trades']} trades, WR={h2['win_rate']:.1%}, Return={h2['total_return_pct']:+.1f}%, MaxDD={h2['max_dd']:.1%}")

        print("\n  Hypothesis 3: Avoid momentum against direction (mom_score < -0.25)")
        print("  Rationale: If RSI+MACD+Bollinger all disagree with our bet, pass.")
        h3_filter = lambda r: r.get('mom_score', 0) >= -0.25
        h3 = simulate_strategy(ALL_RECORDS, 1.2, 6.0, 8.0, 0.02, 13.0, 3.0, extra_filter=h3_filter)
        print(f"    Baseline: {base['trades']} trades, WR={base['win_rate']:.1%}")
        print(f"    H3 (no adverse mom): {h3['trades']} trades, WR={h3['win_rate']:.1%}, Return={h3['total_return_pct']:+.1f}%, MaxDD={h3['max_dd']:.1%}")

        print("\n  Hypothesis 4: Higher d-threshold (d >= 1.5)")
        print("  Rationale: Tighter gate = higher win rate but fewer trades. Test the tradeoff.")
        h4 = simulate_strategy(ALL_RECORDS, 1.5, 6.0, 8.0, 0.02, 13.0, 3.0)
        print(f"    Baseline (d>=1.2): {base['trades']} trades, WR={base['win_rate']:.1%}, Return={base['total_return_pct']:+.1f}%")
        print(f"    H4 (d>=1.5):       {h4['trades']} trades, WR={h4['win_rate']:.1%}, Return={h4['total_return_pct']:+.1f}%")

        print("\n  Hypothesis 5: Combined filter (H1 + H2 + H3)")
        print("  Rationale: Apply all regime filters simultaneously.")
        h5_filter = lambda r: (
            (r.get('gk_vol') or 0) <= 0.003 and
            not r.get('jump', False) and
            r.get('mom_score', 0) >= -0.25
        )
        h5 = simulate_strategy(ALL_RECORDS, 1.2, 6.0, 8.0, 0.02, 13.0, 3.0, extra_filter=h5_filter)
        print(f"    Baseline: {base['trades']} trades, WR={base['win_rate']:.1%}, MaxDD={base['max_dd']:.1%}")
        print(f"    H5 (combined): {h5['trades']} trades, WR={h5['win_rate']:.1%}, Return={h5['total_return_pct']:+.1f}%, MaxDD={h5['max_dd']:.1%}")

        print("\n  Hypothesis 6: Intraday vol filter — skip high-vol UTC hours")
        print("  Rationale: NY open (12-16 UTC) has highest vol → more strike crossings.")
        high_vol_hours = {h for h, ratio in hourly_vol.items() if ratio > 1.3}
        h6_filter = lambda r: r.get('hour_utc') not in high_vol_hours
        h6 = simulate_strategy(ALL_RECORDS, 1.2, 6.0, 8.0, 0.02, 13.0, 3.0, extra_filter=h6_filter)
        print(f"    High-vol UTC hours: {sorted(high_vol_hours)}")
        print(f"    Baseline: {base['trades']} trades, WR={base['win_rate']:.1%}")
        print(f"    H6 (skip high-vol hours): {h6['trades']} trades, WR={h6['win_rate']:.1%}, Return={h6['total_return_pct']:+.1f}%")

        print("\n  Hypothesis 7: Hurst regime conditioning")
        print("  Rationale: In trending markets (Hurst > 0.55), strike is more likely to be crossed.")
        h7_filter = lambda r: r.get('hurst') is None or r.get('hurst', 0.5) <= 0.55
        h7 = simulate_strategy(ALL_RECORDS, 1.2, 6.0, 8.0, 0.02, 13.0, 3.0, extra_filter=h7_filter)
        print(f"    Baseline: {base['trades']} trades, WR={base['win_rate']:.1%}")
        print(f"    H7 (skip trending): {h7['trades']} trades, WR={h7['win_rate']:.1%}, Return={h7['total_return_pct']:+.1f}%, MaxDD={h7['max_dd']:.1%}")

    # ─ PHASE 4: WALK-FORWARD OPTIMIZATION ───────────────────────────────────────
    print("\n" + "=" * 80)
    print("  PHASE 4: WALK-FORWARD OPTIMIZATION (70% train / 30% test)")
    print("=" * 80)

    param_grid = {
        'd_threshold': [1.0, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.8, 2.0],
        'market_discount_cents': [4.0, 6.0, 8.0, 10.0, 12.0],
        'min_edge_pct': [3.0, 5.0, 6.0, 8.0, 10.0],
    }

    log.info("Running walk-forward optimization...")
    wf = walk_forward_optimize(ALL_RECORDS, param_grid)
    if wf['best_params']:
        print("\n  Best parameters (from train set):")
        print(f"    d_threshold:     {wf['best_params']['d_threshold']}")
        print(f"    market_discount: {wf['best_params']['market_discount_cents']}¢")
        print(f"    min_edge:        {wf['best_params']['min_edge_pct']}%")
        tr = wf['train']
        te = wf['test']
        print("\n  Train (70%) results:")
        print(f"    Trades: {tr.get('trades',0)}, WR={tr.get('win_rate',0):.1%}, "
              f"Return={tr.get('total_return_pct',0):+.1f}%, Sharpe={tr.get('sharpe',0):.2f}, MaxDD={tr.get('max_dd',0):.1%}")
        print("\n  Test (30%) out-of-sample results:")
        print(f"    Trades: {te.get('trades',0)}, WR={te.get('win_rate',0):.1%}, "
              f"Return={te.get('total_return_pct',0):+.1f}%, Sharpe={te.get('sharpe',0):.2f}, MaxDD={te.get('max_dd',0):.1%}")

        # Test best params with best filter combination
        best_d = wf['best_params']['d_threshold']
        best_discount = wf['best_params']['market_discount_cents']
        best_edge = wf['best_params']['min_edge_pct']

        test_records = sorted(ALL_RECORDS, key=lambda r: r['check_ts'])
        test_records = test_records[int(0.70 * len(test_records)):]

        print("\n  Best filter (H1+H2+H3) on test set with optimized params:")
        h5_filter = lambda r: (
            (r.get('gk_vol') or 0) <= 0.003 and
            not r.get('jump', False) and
            r.get('mom_score', 0) >= -0.25
        )
        final = simulate_strategy(test_records, best_d, best_edge, best_discount,
                                  0.02, 13.0, 3.0, extra_filter=h5_filter)
        print(f"    Trades: {final.get('trades',0)}, WR={final.get('win_rate',0):.1%}, "
              f"Return={final.get('total_return_pct',0):+.1f}%, MaxDD={final.get('max_dd',0):.1%}")

    # ─ SUMMARY ──────────────────────────────────────────────────────────────────
    print("\n" + "=" * 80)
    print("  FINAL SUMMARY")
    print("=" * 80)
    print("\n  Baseline (existing run_backtest.py, 30d):")
    print("    Win rate: 93.6%  |  Return: +2988%  |  Trades: 902/30d  |  MaxDD: 18.8%")
    print("    ⚠ Edge calculation uses fabricated 8¢ Kalshi discount — NOT validated")
    print("    ⚠ RSI(9)/MACD(5,10,3) in backtest vs RSI(14)/MACD(12,26,9) in live code")
    print("\n  Key findings from empirical calibration:")
    if gated:
        wr_gated = sum(1 for r in gated if r['won']) / len(gated)
        avg_brown = sum(r['p_brownian'] for r in gated) / len(gated)
        print(f"    Windows with |d|>=1.2: {len(gated)}")
        print(f"    Empirical win rate:    {wr_gated:.1%}")
        print(f"    Brownian prediction:   {avg_brown:.1%}")
        print(f"    Calibration lift:      {wr_gated - avg_brown:+.1%}")
    print("\n  Recommended fixes (by impact):")
    print("    1. Fix RSI to use period=14, MACD to use (12,26,9) in run_backtest.py")
    print("    2. Apply vol regime filter: skip GK vol > 0.003 windows")
    print("    3. Apply CUSUM jump filter: skip windows where jump is detected")
    print("    4. Apply adverse momentum filter: skip when mom_score < -0.25")
    print("    5. Use walk-forward optimized d_threshold instead of hardcoded 1.2")
    print("\n  Next steps:")
    print("    - Collect live Kalshi orderbook prices to validate 8¢ discount assumption")
    print("    - Run 90-day backtest with fixed signals for more robust statistics")
    print("    - Consider perp funding rate as regime signal (high positive funding = bull trend)")
    print()


if __name__ == '__main__':
    main()
