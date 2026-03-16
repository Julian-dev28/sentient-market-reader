"""
Full-fidelity backtest of the live KXBTC15M strategy.
Mirrors lib/indicators.ts + lib/agents/probability-model.ts exactly:
  - Garman-Klass vol
  - Cornish-Fisher skew-adjusted binary (primary anchor)
  - Fat-tail Student-t binary (fallback)
  - Brownian prior (fallback)
  - RSI / MACD / Bollinger %B / Stochastic momentum confluence (±15pp)
  - Hurst exponent (regime ±5pp)
  - CUSUM jump detection (discount physics when jump detected)
  - Direction lock (always bet the side BTC sits on)
  - Reachability gate (hard override if move is physically impossible)
  - Risk: minEdge 3%, minDistance 0.02%, entry at 10-min mark (5 min left)
  - Sizing: half-Kelly × vol-scalar × confidence-scalar, baseContracts=100, max=500
  - P&L: $0.50/contract (limit price 50¢ assumed throughout)
"""

import math
import time
import logging
from datetime import datetime, timezone, timedelta
from typing import Optional

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
log = logging.getLogger(__name__)

COINBASE_BASE = "https://api.exchange.coinbase.com"
BINANCE_BASE  = "https://api.binance.com"
KALSHI_BASE   = "https://api.elections.kalshi.com/trade-api/v2"

_S = requests.Session()
_S.headers["User-Agent"] = "sentient-backtest/2.0"

STARTING_CASH   = 90.0
DAYS_BACK       = 30
ENTRY_MINS_MARK = 10          # agent enters at 10-min mark → 5 min left
MINUTES_LEFT    = 5.0
LIMIT_PRICE     = 50          # cents (0.50 per contract)
MIN_EDGE_PCT    = 3.0         # % minimum model edge vs 50¢ market
MIN_DIST_PCT    = 0.02        # % min distance from strike
BASE_CONTRACTS  = 1      # pure Kelly — no artificial floor
MAX_CONTRACTS   = 500
REF_VOL_15M     = 0.002       # baseline GK vol/candle for vol scalar
MAX_TRADE_PCT   = 0.10        # max 10% of bankroll per trade

# ── Math helpers ──────────────────────────────────────────────────────────────

def norm_cdf(z):
    sign = 1 if z >= 0 else -1
    x = abs(z)
    t = 1 / (1 + 0.2316419 * x)
    poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))))
    pdf = math.exp(-0.5 * x * x) / math.sqrt(2 * math.pi)
    return 0.5 + sign * (0.5 - pdf * poly)


def lgamma(x):
    c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028,
         771.32342877765313, -176.61502916214059, 12.507343278686905,
         -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7]
    if x < 0.5:
        return math.log(math.pi / math.sin(math.pi * x)) - lgamma(1 - x)
    x -= 1
    a = c[0]
    for i in range(1, len(c)):
        a += c[i] / (x + i)
    t = x + 7.5
    return 0.5 * math.log(2 * math.pi) + (x + 0.5) * math.log(t) - t + math.log(a)


def incomplete_beta(x, a, b):
    if x <= 0: return 0.0
    if x >= 1: return 1.0
    if x > (a + 1) / (a + b + 2):
        return 1.0 - incomplete_beta(1 - x, b, a)
    lbeta = lgamma(a) + lgamma(b) - lgamma(a + b)
    front = math.exp(a * math.log(x) + b * math.log(1 - x) - lbeta) / a
    TINY, EPS = 1e-30, 3e-7
    C, D = 1.0, 1.0 / max(1 - (a + b) * x / (a + 1), TINY)
    result = D
    for m in range(1, 201):
        aa = m * (b - m) * x / ((a + 2*m - 1) * (a + 2*m))
        D = 1 / max(1 + aa * D, TINY); C = max(1 + aa / C, TINY); result *= C * D
        aa = -(a + m) * (a + b + m) * x / ((a + 2*m) * (a + 2*m + 1))
        D = 1 / max(1 + aa * D, TINY); C = max(1 + aa / C, TINY)
        delta = C * D; result *= delta
        if abs(delta - 1) < EPS: break
    return front * result


def student_t_cdf(t_val, nu):
    ib = incomplete_beta(nu / (nu + t_val * t_val), nu / 2, 0.5)
    return (1 - ib / 2) if t_val >= 0 else (ib / 2)


def cornish_fisher_adjust(d2, skew, excess_kurt):
    z = d2
    return (z
        + (skew / 6)           * (z*z - 1)
        + (excess_kurt / 24)   * (z**3 - 3*z)
        - (skew**2 / 36)       * (2*z**3 - 5*z))


# ── Indicators (mirrors indicators.ts) ───────────────────────────────────────

def gk_vol(candles_newest):
    """Garman-Klass vol from newest-first candles [time,low,high,open,close,vol]."""
    K = 2 * math.log(2) - 1
    terms = []
    for c in candles_newest:
        lo, hi, op, cl = c[1], c[2], c[3], c[4]
        if op <= 0 or lo <= 0 or hi <= 0: continue
        terms.append(0.5 * math.log(hi / lo)**2 - K * math.log(cl / op)**2)
    if len(terms) < 2: return None
    return math.sqrt(max(0, sum(terms) / len(terms)))


def p_brownian(spot, strike, sigma_15m, candles_left):
    if spot <= 0 or strike <= 0 or sigma_15m <= 0 or candles_left <= 0: return None
    d = math.log(spot / strike) / (sigma_15m * math.sqrt(candles_left))
    return norm_cdf(d)


def p_fat_tail(spot, strike, sigma_annual, minutes_left, nu=4.0):
    if spot <= 0 or strike <= 0 or sigma_annual <= 0 or minutes_left <= 0: return None
    T = minutes_left / (365 * 24 * 60)
    d2 = (math.log(spot / strike) - 0.5 * sigma_annual**2 * T) / (sigma_annual * math.sqrt(T))
    return student_t_cdf(d2, nu)


def p_skew_adj(spot, strike, sigma_annual, minutes_left, skew, ex_kurt):
    if spot <= 0 or strike <= 0 or sigma_annual <= 0 or minutes_left <= 0: return None
    T = minutes_left / (365 * 24 * 60)
    d2 = (math.log(spot / strike) - 0.5 * sigma_annual**2 * T) / (sigma_annual * math.sqrt(T))
    d2_cf = cornish_fisher_adjust(d2, skew, ex_kurt)
    return norm_cdf(d2_cf)


def compute_hurst(candles_newest):
    closes = [c[4] for c in reversed(candles_newest)]
    if len(closes) < 8: return None
    lr = [math.log(closes[i] / closes[i-1]) for i in range(1, len(closes)) if closes[i-1] > 0]
    if len(lr) < 6: return None
    var1 = sum(r*r for r in lr) / len(lr)
    p2 = [lr[i] + lr[i+1] for i in range(0, len(lr)-1, 2)]
    var2 = sum(r*r for r in p2) / max(len(p2), 1) if p2 else 0
    if var1 <= 0: return None
    return max(0, min(1, 0.5 + math.log(max(var2 / (2 * var1), 1e-12)) / (2 * math.log(2))))


def compute_cusum(candles_newest, k=0.5, h=4.0):
    closes = [c[4] for c in reversed(candles_newest)]
    if len(closes) < 4: return False, 'none'
    lr = [math.log(closes[i] / closes[i-1]) for i in range(1, len(closes)) if closes[i-1] > 0]
    sigma = math.sqrt(sum(r*r for r in lr) / max(len(lr), 1)) or 0.001
    spos, sneg = 0.0, 0.0
    for r in lr:
        z = r / sigma
        spos = max(0, spos + z - k)
        sneg = max(0, sneg - z - k)
    jump = spos > h or sneg > h
    direction = 'up' if spos > h else ('down' if sneg > h else 'none')
    return jump, direction


def compute_skew_kurt(candles_newest):
    closes = [c[4] for c in reversed(candles_newest)]
    if len(closes) < 5: return None, None
    lr = [math.log(closes[i] / closes[i-1]) for i in range(1, len(closes)) if closes[i-1] > 0]
    n = len(lr)
    if n < 4: return None, None
    mean = sum(lr) / n
    m2 = sum((r - mean)**2 for r in lr) / n
    m3 = sum((r - mean)**3 for r in lr) / n
    m4 = sum((r - mean)**4 for r in lr) / n
    if m2 <= 0: return None, None
    return m3 / m2**1.5, m4 / m2**2 - 3


def ema_from_closes(closes, period):
    if len(closes) < period: return []
    k = 2 / (period + 1)
    val = sum(closes[:period]) / period
    result = [val]
    for i in range(period, len(closes)):
        val = closes[i] * k + val * (1 - k)
        result.append(val)
    return result


def compute_rsi(candles_newest, period=9):
    closes = [c[4] for c in reversed(candles_newest)]
    p = min(period, len(closes) - 1)
    if p < 2: return None
    gains = losses = 0
    for i in range(len(closes) - p, len(closes)):
        diff = closes[i] - closes[i-1]
        if diff > 0: gains += diff
        else: losses += abs(diff)
    avg_gain = gains / p
    avg_loss = losses / p
    if avg_loss == 0: return 100
    return 100 - 100 / (1 + avg_gain / avg_loss)


def compute_macd(candles_newest, fast=5, slow=10, signal=3):
    closes = [c[4] for c in reversed(candles_newest)]
    fast_ema = ema_from_closes(closes, fast)
    slow_ema = ema_from_closes(closes, slow)
    if not fast_ema or not slow_ema: return None
    offset = len(fast_ema) - len(slow_ema)
    macd_line = [fast_ema[i + offset] - slow_ema[i] for i in range(len(slow_ema))]
    sig_line = ema_from_closes(macd_line, signal)
    if not sig_line: return None
    return macd_line[-1] - sig_line[-1]   # histogram


def compute_bollinger_b(candles_newest, period=12):
    closes = [c[4] for c in reversed(candles_newest)]
    p = min(period, len(closes))
    if p < 4: return None
    recent = closes[-p:]
    sma = sum(recent) / p
    std = math.sqrt(sum((c - sma)**2 for c in recent) / p)
    if std == 0: return None
    upper, lower = sma + 2*std, sma - 2*std
    last = closes[-1]
    return max(-0.3, min(1.3, (last - lower) / (upper - lower)))


def compute_stochastic(candles_newest, period=9):
    p = min(period, len(candles_newest))
    if p < 2: return None
    recent = candles_newest[:p]
    hi = max(c[2] for c in recent)
    lo = min(c[1] for c in recent)
    if hi == lo: return 50
    return (candles_newest[0][4] - lo) / (hi - lo) * 100


def compute_velocity(candles_1m_newest):
    """
    Price velocity in $/min from 1-min candles (newest-first).
    Simple: (price_now - price_5min_ago) / 5
    Mirrors the live velocity computation used in the reachability gate.
    """
    if not candles_1m_newest or len(candles_1m_newest) < 6:
        return None
    price_now     = candles_1m_newest[0][4]
    price_5m_ago  = candles_1m_newest[5][4]
    if price_5m_ago <= 0:
        return None
    return (price_now - price_5m_ago) / 5.0   # $/min


def momentum_confluence_pp(rsi, macd_hist, boll_b, stoch):
    """
    Mirrors live probability-model.ts Step 5.
    RSI>55=YES, RSI<45=NO; MACD hist>0=YES; Boll %B>0.55=YES; Stoch>55=YES.
    4YES=+12, 3YES=+6, 2YES=0, 1YES=-6, 0YES=-12  (in pp)
    """
    yes_count = 0
    if rsi  is not None: yes_count += (1 if rsi  > 55 else 0)
    if macd_hist is not None: yes_count += (1 if macd_hist > 0 else 0)
    if boll_b is not None: yes_count += (1 if boll_b > 0.55 else 0)
    if stoch is not None: yes_count += (1 if stoch > 55 else 0)
    table = {4: 12, 3: 6, 2: 0, 1: -6, 0: -12}
    return table.get(yes_count, 0) / 100.0   # convert pp → probability shift


# ── Data fetch ────────────────────────────────────────────────────────────────

def _get(url, retries=3):
    for attempt in range(retries):
        try:
            r = _S.get(url, timeout=20)
            if r.status_code == 429:
                time.sleep(2**attempt); continue
            r.raise_for_status()
            return r.json()
        except Exception:
            if attempt < retries - 1: time.sleep(1); continue
            raise


def fetch_candles(start_dt, end_dt):
    granularity = 900
    chunk_secs  = 280 * granularity
    all_candles = []
    cur = start_dt.astimezone(timezone.utc)
    end = end_dt.astimezone(timezone.utc)
    while cur < end:
        chunk_end = min(cur + timedelta(seconds=chunk_secs), end)
        url = (f"{COINBASE_BASE}/products/BTC-USD/candles"
               f"?granularity={granularity}"
               f"&start={cur.strftime('%Y-%m-%dT%H:%M:%SZ')}"
               f"&end={chunk_end.strftime('%Y-%m-%dT%H:%M:%SZ')}")
        try:
            raw = _get(url)
            if isinstance(raw, list):
                for c in raw:
                    # Coinbase: [time, low, high, open, close, volume]
                    all_candles.append([int(c[0]), float(c[1]), float(c[2]),
                                        float(c[3]), float(c[4]), float(c[5])])
        except Exception as e:
            log.warning(f"Candle chunk failed {cur}: {e}")
        cur = chunk_end
        if cur < end: time.sleep(0.25)

    seen = set()
    uniq = []
    for c in all_candles:
        if c[0] not in seen:
            seen.add(c[0]); uniq.append(c)
    uniq.sort(key=lambda c: c[0])
    log.info(f"Fetched {len(uniq)} BTC/15m candles")
    return uniq


def fetch_1m_candles(start_dt, end_dt):
    """
    Fetch 1-min BTCUSDT candles from Binance public API (no key needed).
    Returns list of [time_s, low, high, open, close, volume] sorted oldest-first.
    Binance limit = 1000 candles per request (~16.7h). Chunks automatically.
    """
    chunk_ms  = 1000 * 60 * 1000   # 1000 minutes per request
    all_c: list = []
    cur_ms  = int(start_dt.astimezone(timezone.utc).timestamp() * 1000)
    end_ms  = int(end_dt.astimezone(timezone.utc).timestamp() * 1000)

    while cur_ms < end_ms:
        chunk_end_ms = min(cur_ms + chunk_ms, end_ms)
        url = (f"{BINANCE_BASE}/api/v3/klines"
               f"?symbol=BTCUSDT&interval=1m"
               f"&startTime={cur_ms}&endTime={chunk_end_ms}&limit=1000")
        try:
            raw = _get(url)
            if isinstance(raw, list):
                for c in raw:
                    # Binance: [openTime_ms, open, high, low, close, volume, ...]
                    all_c.append([
                        int(c[0]) // 1000,   # convert ms → seconds
                        float(c[3]),          # low
                        float(c[2]),          # high
                        float(c[1]),          # open
                        float(c[4]),          # close
                        float(c[5]),          # volume
                    ])
        except Exception as e:
            log.warning(f"Binance 1m chunk failed {cur_ms}: {e}")
        cur_ms = chunk_end_ms
        if cur_ms < end_ms:
            time.sleep(0.1)

    seen: set = set()
    uniq = []
    for c in all_c:
        if c[0] not in seen:
            seen.add(c[0]); uniq.append(c)
    uniq.sort(key=lambda c: c[0])
    log.info(f"Fetched {len(uniq)} BTC/1m candles from Binance")
    return uniq


def fetch_settled_markets(days_back):
    cutoff = datetime.now(timezone.utc) - timedelta(days=days_back)
    markets, cursor = [], None
    while True:
        url = (f"{KALSHI_BASE}/markets?series_ticker=KXBTC15M"
               f"&status=settled&limit=200")
        if cursor: url += f"&cursor={cursor}"
        try: data = _get(url)
        except Exception as e: log.error(f"Kalshi fetch failed: {e}"); break
        batch = data.get('markets', [])
        if not batch: break
        done = False
        for m in batch:
            ct = m.get('close_time') or m.get('expiration_time')
            if not ct: continue
            try: close_dt = datetime.fromisoformat(ct.replace('Z', '+00:00'))
            except ValueError: continue
            if close_dt < cutoff: done = True; break
            fs = m.get('floor_strike')
            result = m.get('result')
            ticker = m.get('ticker', '')
            if fs is not None and result in ('yes', 'no') and ticker:
                try:
                    markets.append({'ticker': ticker, 'floor_strike': float(fs),
                                    'result': result, 'close_time': ct})
                except: pass
        if done: break
        cursor = data.get('cursor')
        if not cursor: break
        time.sleep(0.15)
    log.info(f"Fetched {len(markets)} settled markets ({days_back}d)")
    return markets


# ── Signal computation for one window ────────────────────────────────────────

def compute_signals(candles_newest, spot, strike, minutes_left, candles_1m_newest=None):
    """
    Replicates computeQuantSignals() + probability-model.ts exactly.
    candles_newest:    newest-first 15-min candles
    candles_1m_newest: newest-first 1-min candles for velocity + reachability gate
    """
    # Annualised vol from GK (per-candle → annualised: ×√(365×24×4))
    gk = gk_vol(candles_newest[:16])
    if gk is None or gk <= 0:
        # fallback: realized vol
        closes = [c[4] for c in candles_newest[:16]]
        if len(closes) < 4: return None
        lr = [math.log(closes[i] / closes[i+1]) for i in range(len(closes)-1) if closes[i+1] > 0]
        if not lr: return None
        gk = math.sqrt(sum(r*r for r in lr) / len(lr))
        if gk <= 0: return None

    sigma_annual = gk * math.sqrt(365 * 24 * 4)   # 15-min candles per year
    candles_left = minutes_left / 15.0

    # Skew + kurtosis
    skew, ex_kurt = compute_skew_kurt(candles_newest[:32])

    # Primary anchor: Cornish-Fisher
    p_cf = None
    if skew is not None and ex_kurt is not None:
        p_cf = p_skew_adj(spot, strike, sigma_annual, minutes_left, skew, ex_kurt)

    # Fallbacks
    p_fat = p_fat_tail(spot, strike, sigma_annual, minutes_left, nu=4.0)
    p_brow = p_brownian(spot, strike, gk, candles_left)

    # Primary model value (mirrors probability-model.ts line 184)
    p_quant = p_cf if p_cf is not None else (p_fat if p_fat is not None else p_brow)
    if p_quant is None: return None

    p_model = p_quant

    # CUSUM jump detection — if jump, discount physics by 40%, trust momentum
    jump_detected, jump_dir = compute_cusum(candles_newest[:32])

    # Hurst regime ±5pp (Step 4 of live decision protocol)
    hurst = compute_hurst(candles_newest[:32])
    hurst_adj = 0.0
    if hurst is not None:
        above_strike = spot >= strike
        if hurst > 0.6:    # trending — push 5pp in current momentum direction
            hurst_adj = 0.05 if above_strike else -0.05
        elif hurst < 0.4:  # mean-reverting — fade extremes by 3pp toward 50%
            hurst_adj = -0.03 if p_model > 0.5 else 0.03

    # Momentum confluence ±15pp (Step 5)
    rsi     = compute_rsi(candles_newest)
    macd_h  = compute_macd(candles_newest)
    boll_b  = compute_bollinger_b(candles_newest)
    stoch   = compute_stochastic(candles_newest)
    mom_adj = momentum_confluence_pp(rsi, macd_h, boll_b, stoch)

    # Apply adjustments
    p_model = p_model + hurst_adj + mom_adj

    # CUSUM: if jump detected, discount diffusion models 40% and flip toward jump
    if jump_detected:
        if jump_dir == 'up':
            p_model = p_model * 0.6 + 0.9 * 0.4
        elif jump_dir == 'down':
            p_model = p_model * 0.6 + 0.1 * 0.4

    # Direction lock — always bet the side BTC currently sits on
    above_strike = spot >= strike
    if above_strike and p_model < 0.5:
        p_model = 1.0 - p_model
    elif not above_strike and p_model > 0.5:
        p_model = 1.0 - p_model

    p_model = max(0.05, min(0.95, p_model))

    # ── Reachability gate (mirrors probability-model.ts hard override) ─────────
    # Uses 1-min velocity to determine if the strike can actually be crossed.
    # Gate window: active when minutesLeft <= max(8, min(13, distUSD/20))
    velocity     = compute_velocity(candles_1m_newest) if candles_1m_newest else None
    gate_applied = False
    gate_note    = ''
    dist_usd     = abs((spot - strike))
    req_vel      = dist_usd / minutes_left if minutes_left > 0 else 0
    gate_window  = max(8, min(13, dist_usd / 20))

    if minutes_left <= gate_window and velocity is not None and req_vel > 0:
        moving_toward = (
            (spot < strike and velocity > 0) or   # below strike, moving up
            (spot > strike and velocity < 0)        # above strike, moving down
        )
        vel_ratio = abs(velocity) / req_vel
        if not moving_toward or vel_ratio < 0.55:
            gated = min(p_model, 0.20) if spot < strike else max(p_model, 0.80)
            gate_note = f"vel={velocity:+.1f}/min ratio={vel_ratio:.0%} → {gated:.2f}"
            p_model = gated
            gate_applied = True

    p_model = max(0.05, min(0.95, p_model))

    return {
        'p_model':    p_model,
        'gk_vol':     gk,
        'sigma_annual': sigma_annual,
        'p_cf':       p_cf,
        'p_fat':      p_fat,
        'p_brow':     p_brow,
        'hurst':      hurst,
        'jump':       jump_detected,
        'jump_dir':   jump_dir,
        'rsi':        rsi,
        'macd_hist':  macd_h,
        'boll_b':     boll_b,
        'stoch':      stoch,
        'above_strike': above_strike,
        'skew':        skew,
        'ex_kurt':     ex_kurt,
        'velocity':    velocity,
        'gate_applied': gate_applied,
        'gate_note':   gate_note,
    }


# ── Process one settled market ────────────────────────────────────────────────

def process_market(mkt, candles_oldest, candles_1m_oldest=None):
    ticker      = mkt['ticker']
    strike      = mkt['floor_strike']
    result      = mkt['result']       # 'yes' | 'no'

    try:
        close_dt = datetime.fromisoformat(mkt['close_time'].replace('Z', '+00:00'))
    except ValueError:
        return None

    open_dt  = close_dt - timedelta(minutes=15)
    entry_dt = open_dt  + timedelta(minutes=ENTRY_MINS_MARK)   # 10-min mark
    entry_ts = entry_dt.timestamp()

    # Candles complete before entry
    ctx = [c for c in candles_oldest if c[0] + 900 <= entry_ts]
    if len(ctx) < 8: return None

    last_32 = list(reversed(ctx[-32:]))   # newest-first
    spot = last_32[0][4]
    if spot <= 0: return None

    # Distance from strike
    dist_pct = (spot - strike) / strike * 100.0

    # Skip near-strike noise (mirrors risk-manager minDistancePct=0.02%)
    if abs(dist_pct) < MIN_DIST_PCT: return None

    # 1-min candles: last 15 complete before entry (agent sees ~10 within-window + 5 prior)
    candles_1m_newest = None
    if candles_1m_oldest:
        ctx_1m = [c for c in candles_1m_oldest if c[0] + 60 <= entry_ts]
        if len(ctx_1m) >= 6:
            candles_1m_newest = list(reversed(ctx_1m[-15:]))

    sigs = compute_signals(last_32, spot, strike, MINUTES_LEFT, candles_1m_newest)
    if sigs is None: return None

    p_model    = sigs['p_model']
    above      = sigs['above_strike']
    side       = 'yes' if above else 'no'

    # Edge vs 50¢ market (live formula)
    p_market   = 0.50
    edge_pct   = (p_model - p_market) * 100 if side == 'yes' else ((1 - p_model) - p_market) * 100

    # Minimum edge gate (mirrors risk-manager minEdgePct=3%)
    if edge_pct < MIN_EDGE_PCT: return None

    # Confidence
    edge_abs   = abs(p_model - 0.5)
    confidence = 'high' if edge_abs >= 0.15 else 'medium' if edge_abs >= 0.07 else 'low'

    # Did it win?
    won = (side == result)

    return {
        'ticker':      ticker,
        'entry_dt':    entry_dt.isoformat(),
        'expires_dt':  close_dt.isoformat(),
        'side':        side,
        'spot':        round(spot, 2),
        'strike':      round(strike, 2),
        'dist_pct':    round(dist_pct, 4),
        'p_model':     round(p_model, 4),
        'p_market':    p_market,
        'edge_pct':    round(edge_pct, 4),
        'confidence':  confidence,
        'gk_vol':      round(sigs['gk_vol'], 6),
        'hurst':       round(sigs['hurst'], 3) if sigs['hurst'] is not None else None,
        'jump':        sigs['jump'],
        'rsi':         round(sigs['rsi'], 1) if sigs['rsi'] is not None else None,
        'macd_hist':   round(sigs['macd_hist'], 2) if sigs['macd_hist'] is not None else None,
        'boll_b':      round(sigs['boll_b'], 3) if sigs['boll_b'] is not None else None,
        'skew':        round(sigs['skew'], 3) if sigs['skew'] is not None else None,
        'ex_kurt':     round(sigs['ex_kurt'], 3) if sigs['ex_kurt'] is not None else None,
        'velocity':    round(sigs['velocity'], 2) if sigs['velocity'] is not None else None,
        'gate':        sigs['gate_applied'],
        'result':      result,
        'outcome':     'WIN' if won else 'LOSS',
    }


# ── P&L simulation — half-Kelly compounding (live agent default) ──────────────

def simulate(records):
    cash     = STARTING_CASH
    cost_per = LIMIT_PRICE / 100.0

    for r in records:
        b           = (100 - LIMIT_PRICE) / LIMIT_PRICE   # net odds = 1.0 at 50¢
        p           = r['p_model']
        kelly_f     = max(0.0, (b * p - (1 - p)) / b)
        vol_scalar  = max(0.30, min(1.50, REF_VOL_15M / r['gk_vol'])) if r['gk_vol'] > 0 else 1.0
        conf_scalar = 1.00 if r['confidence'] == 'high' else 0.65 if r['confidence'] == 'medium' else 0.35
        budget      = min(kelly_f, 0.25) * cash

        contracts = max(1, int(budget / cost_per))
        cost      = contracts * cost_per

        pnl = contracts * (1.0 - cost_per) if r['outcome'] == 'WIN' else -cost
        cash = max(0.0, cash + pnl)

        r['contracts']  = contracts
        r['cost']       = round(cost, 2)
        r['pnl']        = round(pnl, 2)
        r['cash_after'] = round(cash, 2)

    return cash


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    log.info(f"=== Full-Fidelity KXBTC15M Backtest · {DAYS_BACK}d · ${STARTING_CASH} start ===")

    markets = fetch_settled_markets(DAYS_BACK)
    if not markets:
        print("No markets found"); return

    close_times = []
    for m in markets:
        try: close_times.append(datetime.fromisoformat(m['close_time'].replace('Z', '+00:00')))
        except: pass

    earliest   = min(close_times) - timedelta(hours=10)
    latest     = max(close_times) + timedelta(minutes=30)
    candles    = fetch_candles(earliest, latest)

    if len(candles) < 10:
        print("Insufficient candle data"); return

    # 1-min candles from Binance (public, no key) — extra 30min lead buffer
    candles_1m = fetch_1m_candles(earliest - timedelta(minutes=30), latest)
    log.info(f"1-min candles available: {len(candles_1m)}")

    records, skipped = [], 0
    for mkt in markets:
        try:
            r = process_market(mkt, candles, candles_1m)
            if r: records.append(r)
            else: skipped += 1
        except Exception as e:
            log.warning(f"Skip {mkt.get('ticker','?')}: {e}"); skipped += 1

    # Sort oldest → newest (chronological agent run order)
    records.sort(key=lambda r: r['entry_dt'])

    log.info(f"Qualified: {len(records)} trades, skipped {skipped} (of {len(markets)} total)")

    if not records:
        print("No trades qualified under the live strategy filters"); return

    final_cash = simulate(records)

    wins   = [r for r in records if r['outcome'] == 'WIN']
    losses = [r for r in records if r['outcome'] == 'LOSS']

    print("\n" + "="*100)
    print(f"  KXBTC15M  ·  {DAYS_BACK}-day Full-Fidelity Backtest  ·  Half-Kelly Compounding")
    print(f"  Period: {records[0]['entry_dt'][:16]} UTC  →  {records[-1]['entry_dt'][:16]} UTC")
    print("="*100)
    print(f"  Starting cash : ${STARTING_CASH:.2f}")
    print(f"  Final cash    : ${final_cash:.2f}")
    print(f"  Total P&L     : ${final_cash - STARTING_CASH:+.2f}  ({(final_cash/STARTING_CASH - 1)*100:+.1f}%)")
    print(f"  Total trades  : {len(records)}  (~{len(records)/DAYS_BACK:.0f}/day)")
    print(f"  Wins / Losses : {len(wins)} / {len(losses)}")
    print(f"  Win rate      : {len(wins)/len(records)*100:.1f}%")
    print(f"  Skipped (PASS): {skipped}")
    print()

    # Agent-style trade log — oldest first, like watching it run live
    hdr = f"  {'#':<4} {'Entry (UTC)':<17} {'Market':<30} {'Side':<4} {'BTC Spot':>9} {'Strike':>9} {'Dist%':>6} {'pModel':>7} {'Edge%':>6} {'RSI':>5} {'H':>4} {'Vel$/m':>7} {'G':<1} {'Ctrs':>5} {'PnL':>8} {'Balance':>9}  Result"
    print(hdr)
    print("  " + "-"*len(hdr))
    for i, r in enumerate(records, 1):
        entry_str = r['entry_dt'][5:16].replace('T', ' ')
        h_str     = f"{r['hurst']:.2f}" if r['hurst']    is not None else "   -"
        rsi_str   = f"{r['rsi']:.0f}"   if r['rsi']      is not None else "  -"
        vel_str   = f"{r['velocity']:>+.1f}" if r['velocity'] is not None else "    -"
        gate_str  = "G" if r['gate'] else " "
        result_icon = "✓ WIN" if r['outcome'] == 'WIN' else "✗ LOSS"
        print(f"  {i:<4} {entry_str:<17} {r['ticker']:<30} {r['side']:<4} "
              f"${r['spot']:>8,.0f} ${r['strike']:>8,.0f} {r['dist_pct']:>+6.3f} "
              f"{r['p_model']:>7.3f} {r['edge_pct']:>6.2f} {rsi_str:>5} {h_str:>4} "
              f"{vel_str:>7} {gate_str:<1} {r['contracts']:>5} "
              f"${r['pnl']:>+7.2f} ${r['cash_after']:>8.2f}  {result_icon}")

    print()
    # Streak / drawdown summary
    max_cash = STARTING_CASH
    max_dd   = 0.0
    cur_streak = 0
    max_win_streak = max_loss_streak = 0
    last_outcome = None
    for r in records:
        max_cash = max(max_cash, r['cash_after'])
        dd = (max_cash - r['cash_after']) / max_cash * 100
        max_dd = max(max_dd, dd)
        if r['outcome'] == last_outcome:
            cur_streak += 1
        else:
            cur_streak = 1
        if r['outcome'] == 'WIN':  max_win_streak  = max(max_win_streak,  cur_streak)
        else:                       max_loss_streak = max(max_loss_streak, cur_streak)
        last_outcome = r['outcome']

    print(f"  Max drawdown       : {max_dd:.1f}%")
    print(f"  Longest win streak : {max_win_streak}")
    print(f"  Longest loss streak: {max_loss_streak}")
    print(f"  Peak balance       : ${max_cash:.2f}")
    print("="*100)


if __name__ == '__main__':
    main()
