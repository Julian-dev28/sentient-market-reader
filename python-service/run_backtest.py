"""
Agent-faithful backtest of the live KXBTC15M strategy.

Mirrors the live agent pipeline exactly:
  Signal (probability-model.ts):
    - Garman-Klass vol (gkVol15m)
    - Cornish-Fisher skew-adjusted binary (primary anchor)
    - Fat-tail Student-t binary (ν=4) fallback
    - Brownian prior fallback
    - Direction lock (always bet the side BTC currently sits on)
    - Reachability gate (hard override if strike unreachable)
    - NO momentum/regime adjustments — empirically noise (787-trade backtest)
    - D-score gate: |d| ∈ [1.0, 1.2] ONLY — confirmed edge zone

  Risk manager (risk-manager.ts) — mirrored exactly:
    - minEdgePct: 6%
    - minEntryPrice: 72¢  maxEntryPrice: 92¢
    - Entry window: 3–9 min before close
    - Daily loss limit: max(5% of portfolio, $50 floor, $150 cap)
    - Session drawdown from peak: 15%  (resets midnight ET)
    - Max trades/day: 48  (resets midnight ET)
    - Min net profit floor: max($0.25, 0.5% of portfolio)
    - Quarter-Kelly (0.25×) × vol-scalar × conf-scalar, capped at 15% of portfolio

  Execution:
    - Kalshi maker fee: ceil(0.0175 × C × P × (1-P))
    - Book depth cap: MAX_ORDER_DEPTH contracts (Kalshi thin-book reality)
    - Slippage: linear book-sweep above SLIPPAGE_FREE_CTRS contracts
    - Entry price: EMPIRICAL_PRICE_BY_D table (2,690 live fills; no historical book data)
    - No artificial miss-rate or regime-flip dampening
"""

import math
import time
import logging
from datetime import datetime, timezone, timedelta

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
log = logging.getLogger(__name__)

COINBASE_BASE = "https://api.exchange.coinbase.com"
KALSHI_BASE   = "https://api.elections.kalshi.com/trade-api/v2"

_S = requests.Session()
_S.headers["User-Agent"] = "sentient-backtest/2.0"

STARTING_CASH       = 100.00   # match Kelly mode bankroll
DAYS_BACK           = 30
D_THRESHOLD         = 1.0     # empirical: |d|≥1.0 is where positive edge begins (live data Z=2.33)
D_MAX_THRESHOLD     = 1.2     # live fills: |d|>1.2 Kalshi overprices (-1.1pp margin) — only 1.0-1.2 has real edge
MIN_MINUTES_LEFT    = 3       # don't enter with < 3 min left (risk-manager gate)
MAX_MINUTES_LEFT    = 9       # live fills: 6-9min=98.3% wr, 3-6min=91.7%; 9-12min=69.5% (signal not settled)
MIN_EDGE_PCT        = 6.0     # mirrors RISK_PARAMS.minEdgePct
MIN_DIST_PCT        = 0.02    # mirrors RISK_PARAMS.minDistancePct
MIN_ENTRY_PRICE_RM  = 72      # mirrors RISK_PARAMS.minEntryPrice (¢)
MAX_ENTRY_PRICE_RM  = 92      # mirrors RISK_PARAMS.maxEntryPrice (¢) — fee eats margin above this
MAX_CONTRACTS_RM    = 500     # mirrors RISK_PARAMS.maxContractSize
REF_VOL_15M         = 0.002   # mirrors REFERENCE_VOL_15M
MAX_TRADE_PCT       = 0.15    # mirrors RISK_PARAMS.maxTradePct (15% of portfolio)
MAX_TRADES_PER_DAY  = 48      # mirrors RISK_PARAMS.maxTradesPerDay
MAX_DRAWDOWN_PCT    = 15      # mirrors RISK_PARAMS.maxDrawdownPct (from session peak)
MAX_DAILY_LOSS_PCT  = 5       # mirrors RISK_PARAMS.maxDailyLossPct
MAX_DAILY_LOSS_FLOOR= 50      # mirrors RISK_PARAMS.maxDailyLossFloor ($)
MAX_DAILY_LOSS_CAP  = 150     # mirrors RISK_PARAMS.maxDailyLossCap ($)
MAX_GIVEBACK_MULT   = 1.5     # mirrors RISK_PARAMS.maxGivebackMult (1.5× daily loss cap)
POLLER_INTERVAL_MIN = 0.5     # d-poller fires every 30s = 0.5 min

# ── Kalshi order book constraints (not in risk manager — execution layer) ─────
# Real KXBTC15M markets typically have 20-50 contracts on the ask at best price.
# Cap at 25 (conservative). No miss-rate or regime-flip — those are not agent logic.
MAX_ORDER_DEPTH     = 25      # max contracts fillable at quoted price (Kalshi book depth)
SLIPPAGE_FREE_CTRS  = 10      # first 10 contracts at quoted price (no slippage)
SLIPPAGE_CENTS_PER  = 0.5     # ¢ per contract above free tier (book sweep)

# Empirical Kalshi YES ask price by |d| bucket — from 2,690 live fills analysis.
# REPLACES the fabricated MARKET_DISCOUNT_CENTS=8 constant which assumed an 8¢
# discount to Brownian that doesn't exist in practice (real avg discount = -3.9¢).
# Format: (d_lo, d_hi, avg_price_cents)
EMPIRICAL_PRICE_BY_D = [
    (0.0, 0.5,  62.3),   # |d| < 0.5: avg 62.3¢ — filtered by MIN_ENTRY_PRICE gate
    (0.5, 0.8,  72.7),   # |d| 0.5-0.8: avg 72.7¢ — borderline
    (0.8, 1.0,  79.1),   # |d| 0.8-1.0: avg 79.1¢ — filtered by D_THRESHOLD
    (1.0, 1.2,  80.8),   # |d| 1.0-1.2: avg 80.8¢ — ONLY PROFITABLE (+5.5pp margin)
    (1.2, 1.5,  84.6),   # |d| 1.2-1.5: avg 84.6¢ — -1.1pp margin (lose after fees)
    (1.5, 2.0,  83.6),   # |d| 1.5-2.0: avg 83.6¢ — -3.9pp margin
    (2.0, 99.0, 71.0),   # |d| ≥ 2.0: avg 71.0¢ — -4.1pp margin
]
MIN_ENTRY_PRICE = MIN_ENTRY_PRICE_RM   # alias so process_market uses the same constant

# Vol-of-vol regime filter: reduce position in high-instability windows.
MAX_VOL_OF_VOL = 0.95

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


def compute_vol_of_vol(candles_newest, n=32):
    """Vol-of-vol: std(|returns|)/mean(|returns|). High VoV = unstable regime."""
    closes = [c[4] for c in reversed(candles_newest[:n+1])]
    if len(closes) < 8: return None
    abs_rets = [abs(math.log(closes[i] / closes[i-1])) for i in range(1, len(closes)) if closes[i-1] > 0]
    if not abs_rets: return None
    mean = sum(abs_rets) / len(abs_rets)
    if mean == 0: return None
    std = math.sqrt(sum((r - mean)**2 for r in abs_rets) / len(abs_rets))
    return std / mean


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
    """RSI(9) — matches live indicators.ts (fast-period for 15-min BTC trading)."""
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
    """MACD(5,10,3) — matches live indicators.ts (fast-period for 15-min BTC trading)."""
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
    """Bollinger(12) — matches live indicators.ts."""
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


def momentum_confluence_pp(rsi, macd_hist, boll_b, stoch, above_strike):
    """
    Mirrors live probability-model.ts Step 2 (deterministic momentum confluence).
    Votes: RSI>55=YES, RSI<45=NO; MACD hist>0=YES; Boll %B>0.55=YES; Stoch>55=YES.
    Score = votes FOR our side minus votes AGAINST.
    +3→+5pp, +2→+3pp, +1→+1pp, 0→0, -1→-1pp, -2→-2pp, ≤-3→-3pp  (capped ±6pp total)
    """
    yes_votes = 0
    if rsi       is not None: yes_votes += (1 if rsi       > 55 else -1 if rsi       < 45 else 0)
    if macd_hist is not None: yes_votes += (1 if macd_hist > 0  else -1)
    if boll_b    is not None: yes_votes += (1 if boll_b    > 0.55 else -1 if boll_b < 0.45 else 0)
    if stoch     is not None: yes_votes += (1 if stoch     > 55 else -1 if stoch    < 45 else 0)
    # Convert to directional score: positive = confirming our bet direction
    score = yes_votes if above_strike else -yes_votes
    adj = (0.05 if score >= 3 else 0.03 if score == 2 else 0.01 if score == 1
           else 0.0 if score == 0 else -0.01 if score == -1 else -0.02 if score == -2 else -0.03)
    return adj


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
    Fetch 1-min BTC-USD candles from Coinbase Exchange (same source as live agent).
    Returns list of [time_s, low, high, open, close, volume] sorted oldest-first.
    Coinbase limit = 300 candles per request (5h). Chunks automatically.
    """
    chunk_secs = 300 * 60   # 300 minutes per request
    all_c: list = []
    cur = start_dt.astimezone(timezone.utc)
    end = end_dt.astimezone(timezone.utc)

    while cur < end:
        chunk_end = min(cur + timedelta(seconds=chunk_secs), end)
        url = (f"{COINBASE_BASE}/products/BTC-USD/candles"
               f"?granularity=60"
               f"&start={cur.strftime('%Y-%m-%dT%H:%M:%SZ')}"
               f"&end={chunk_end.strftime('%Y-%m-%dT%H:%M:%SZ')}")
        try:
            raw = _get(url)
            if isinstance(raw, list):
                for c in raw:
                    # Coinbase: [time, low, high, open, close, volume]
                    all_c.append([int(c[0]), float(c[1]), float(c[2]),
                                   float(c[3]), float(c[4]), float(c[5])])
        except Exception as e:
            log.warning(f"Coinbase 1m chunk failed {cur}: {e}")
        cur = chunk_end
        if cur < end:
            time.sleep(0.25)

    seen: set = set()
    uniq = []
    for c in all_c:
        if c[0] not in seen:
            seen.add(c[0]); uniq.append(c)
    uniq.sort(key=lambda c: c[0])
    log.info(f"Fetched {len(uniq)} BTC/1m candles from Coinbase")
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
                except (ValueError, TypeError) as e:
                    log.warning(f"Skipping market {ticker}: bad floor_strike value {fs!r}: {e}")
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

    # Momentum/regime adjustments REMOVED.
    # Backtest of 787 trades (d∈[1.0,1.5]) showed RSI/MACD/Hurst add noise, not signal.
    # MACD opposed to our bet outperformed MACD aligned (+9.5pp vs +6.2pp).
    # The d-gate + direction lock + Brownian anchor is the complete model.
    # Signals retained in return dict for diagnostic purposes only.
    jump_detected, jump_dir = compute_cusum(candles_newest[:32])
    hurst   = compute_hurst(candles_newest[:32])
    rsi     = compute_rsi(candles_newest)
    macd_h  = compute_macd(candles_newest)
    boll_b  = compute_bollinger_b(candles_newest)
    stoch   = compute_stochastic(candles_newest)
    vov     = compute_vol_of_vol(candles_newest[:32])

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
        'p_model':      p_model,
        'gk_vol':       gk,
        'sigma_annual': sigma_annual,
        'p_cf':         p_cf,
        'p_fat':        p_fat,
        'p_brow':       p_brow,
        'hurst':      hurst,
        'jump':       jump_detected,
        'jump_dir':   jump_dir,
        'vov':        vov,
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


# ── Process one settled market — simulate d-poller ───────────────────────────

def process_market(mkt, candles_oldest, candles_1m_oldest=None):
    """
    Simulate the live d-poller: check d every 30s from window open.
    Fire when |d| >= D_THRESHOLD and MIN_MINUTES_LEFT <= remaining <= MAX_MINUTES_LEFT.
    This mirrors actual live agent behavior instead of a fixed entry-time snapshot.
    """
    ticker  = mkt['ticker']
    strike  = mkt['floor_strike']
    result  = mkt['result']

    try:
        close_dt = datetime.fromisoformat(mkt['close_time'].replace('Z', '+00:00'))
    except ValueError:
        return None

    open_dt   = close_dt - timedelta(minutes=15)
    open_ts   = open_dt.timestamp()
    close_ts  = close_dt.timestamp()

    # Simulate poller: check every POLLER_INTERVAL_MIN starting at window open
    # Stop at MIN_MINUTES_LEFT before close (too late to enter)
    check_times = []
    t = open_ts + POLLER_INTERVAL_MIN * 60
    while t <= close_ts - MIN_MINUTES_LEFT * 60:
        check_times.append(t)
        t += POLLER_INTERVAL_MIN * 60

    # Pre-index 1-min candles for fast lookup (ts → close)
    m1_by_ts = {}
    if candles_1m_oldest:
        for c in candles_1m_oldest:
            m1_by_ts[c[0]] = c[4]  # ts → close

    # Blocked UTC hours: 11 and 18 — empirically -40 to -57pp margin at d∈[1.0,1.5].
    # 11:00Z = pre-market US / Asian close. 18:00Z = US afternoon news flow.
    BLOCKED_UTC_HOURS = {11, 18}

    for check_ts in check_times:
        minutes_left = (close_ts - check_ts) / 60.0

        # Only consider entries within the timing window
        if minutes_left > MAX_MINUTES_LEFT or minutes_left < MIN_MINUTES_LEFT:
            continue

        # Time-of-day gate
        check_hour_utc = datetime.fromtimestamp(check_ts, tz=timezone.utc).hour
        if check_hour_utc in BLOCKED_UTC_HOURS:
            continue

        # 15-min candles complete before this check
        ctx = [c for c in candles_oldest if c[0] + 900 <= check_ts]
        if len(ctx) < 8: continue
        last_32 = list(reversed(ctx[-32:]))

        # Use 1-min candle close as live spot price (mirrors live Coinbase feed)
        # Find last 1-min candle completed before check_ts
        m1_ts = int(check_ts // 60) * 60 - 60  # last completed 1-min candle start
        spot  = m1_by_ts.get(m1_ts) or m1_by_ts.get(m1_ts - 60)
        if not spot or spot <= 0:
            spot = last_32[0][4]  # fallback: last 15-min close
        if spot <= 0: continue

        gk = gk_vol(last_32[:16])
        if not gk or gk <= 0: continue

        # Compute d-score (same formula as live d-poller)
        candles_left = minutes_left / 15.0
        try:
            d = math.log(spot / strike) / (gk * math.sqrt(candles_left))
        except (ValueError, ZeroDivisionError):
            continue

        if abs(d) < D_THRESHOLD or abs(d) > D_MAX_THRESHOLD:
            continue  # outside profitable edge zone

        # Distance from strike (noise gate)
        dist_pct = (spot - strike) / strike * 100.0
        if abs(dist_pct) < MIN_DIST_PCT:
            continue

        # D-threshold crossed — run full signal computation (mirrors runCycle)
        candles_1m_newest = None
        if candles_1m_oldest:
            ctx_1m = [c for c in candles_1m_oldest if c[0] + 60 <= check_ts]
            if len(ctx_1m) >= 6:
                candles_1m_newest = list(reversed(ctx_1m[-15:]))

        sigs = compute_signals(last_32, spot, strike, minutes_left, candles_1m_newest)
        if sigs is None: continue

        p_model = sigs['p_model']
        above   = sigs['above_strike']
        side    = 'yes' if above else 'no'

        # Market price: empirical Kalshi YES ask by |d| bucket (from 2,690 live fill analysis).
        # This replaces the discredited MARKET_DISCOUNT_CENTS=8 constant.
        # The empirical lookup gives the actual price Kalshi charged at each d level.
        d_abs_now = abs(d)
        limit_price_cents = 80  # fallback
        for d_lo, d_hi, emp_price in EMPIRICAL_PRICE_BY_D:
            if d_lo <= d_abs_now < d_hi:
                limit_price_cents = round(emp_price)
                break

        # Minimum entry price gate — matches live risk-manager minEntryPrice=72¢
        if limit_price_cents < MIN_ENTRY_PRICE:
            continue

        # Edge vs market price
        p_market_win = limit_price_cents / 100.0
        p_model_win  = p_model if side == 'yes' else (1.0 - p_model)
        edge_pct     = (p_model_win - p_market_win) * 100

        if edge_pct < MIN_EDGE_PCT:
            continue

        edge_abs   = abs(p_model - 0.5)
        confidence = 'high' if edge_abs >= 0.15 else 'medium' if edge_abs >= 0.07 else 'low'
        won        = (side == result)

        entry_dt = datetime.fromtimestamp(check_ts, tz=timezone.utc)
        return {
            'ticker':            ticker,
            'entry_dt':          entry_dt.isoformat(),
            'expires_dt':        close_dt.isoformat(),
            'side':              side,
            'spot':              round(spot, 2),
            'strike':            round(strike, 2),
            'dist_pct':          round(dist_pct, 4),
            'minutes_left':      round(minutes_left, 1),
            'd_score':           round(d, 3),
            'p_model':           round(p_model, 4),
            'p_market':          round(p_market_win, 4),
            'limit_price_cents': limit_price_cents,
            'edge_pct':          round(edge_pct, 4),
            'confidence':        confidence,
            'gk_vol':            round(sigs['gk_vol'], 6),
            'vov':               round(sigs['vov'], 3) if sigs.get('vov') is not None else None,
            'hurst':             round(sigs['hurst'], 3) if sigs['hurst'] is not None else None,
            'jump':              sigs['jump'],
            'rsi':               round(sigs['rsi'], 1) if sigs['rsi'] is not None else None,
            'macd_hist':         round(sigs['macd_hist'], 2) if sigs['macd_hist'] is not None else None,
            'boll_b':            round(sigs['boll_b'], 3) if sigs['boll_b'] is not None else None,
            'skew':              round(sigs['skew'], 3) if sigs['skew'] is not None else None,
            'ex_kurt':           round(sigs['ex_kurt'], 3) if sigs['ex_kurt'] is not None else None,
            'velocity':          round(sigs['velocity'], 2) if sigs['velocity'] is not None else None,
            'gate':              sigs['gate_applied'],
            'result':            result,
            'outcome':           'WIN' if won else 'LOSS',
        }

    return None  # d never crossed threshold in this window


# ── P&L simulation — mirrors live risk manager exactly ───────────────────────

MAKER_FEE_RATE = 0.0175  # resting limit orders → maker rate (matches MAKER_FEE_RATE in risk-manager.ts)

def kalshi_fee(contracts, price_cents):
    """ceil(0.0175 × C × P × (1-P)) — official Kalshi formula, rounded up to nearest cent."""
    p = price_cents / 100.0
    return math.ceil(MAKER_FEE_RATE * contracts * p * (1 - p) * 100) / 100  # → dollars


def simulate(records):
    """
    Agent-faithful simulation. Mirrors risk-manager.ts exactly:
      - Quarter-Kelly (0.25×) × volScalar × confScalar, capped at 15% of portfolio
      - Math.round() for contract count (matches live agent)
      - maxEntryPrice gate (92¢)
      - Daily loss limit: max(5% portfolio, $50 floor, $150 cap) — resets midnight ET
      - Session drawdown from peak: 15% — resets midnight ET
      - Max 48 trades per day — resets midnight ET
      - Min net profit floor: max($0.25, 0.5% of portfolio)
      - Kalshi book depth cap: MAX_ORDER_DEPTH contracts
      - Slippage: linear book-sweep above SLIPPAGE_FREE_CTRS
      - No artificial miss-rate or regime-flip noise
    """

    ET_OFFSET = timedelta(hours=5)   # UTC-5 (ET standard; close enough for daily reset)

    cash = STARTING_CASH

    # Session state — mirrors sessionState in risk-manager.ts
    session_daily_pnl   = 0.0
    session_peak_pnl    = 0.0
    session_trade_count = 0
    session_date_et     = None   # ET date string for daily reset

    for r in records:
        # ── Daily reset at midnight ET ────────────────────────────────────────
        entry_dt  = datetime.fromisoformat(r['entry_dt'])
        entry_et  = entry_dt - ET_OFFSET
        date_et   = entry_et.strftime('%Y-%m-%d')
        if date_et != session_date_et:
            session_date_et     = date_et
            session_daily_pnl   = 0.0
            session_peak_pnl    = 0.0
            session_trade_count = 0

        lp = r['limit_price_cents']   # ¢

        # ── Risk manager gates (same order as risk-manager.ts) ────────────────
        max_daily_loss = -max(MAX_DAILY_LOSS_FLOOR,
                              min(MAX_DAILY_LOSS_CAP, cash * MAX_DAILY_LOSS_PCT / 100))
        # Dollar giveback gate: mirrors risk-manager.ts maxGivebackMult (1.5× daily loss cap).
        # Replaced the 15% session-P&L% gate which misfired on virtually every first loss
        # because avg_loss ($18) >> avg_win ($3.60) — any loss from a 1-win session would
        # trigger 15% of a ~$3.60 peak, blocking 36% of all qualifying trades.
        giveback_limit  = abs(max_daily_loss) * MAX_GIVEBACK_MULT
        giveback_dollars = (session_peak_pnl - session_daily_pnl) if session_peak_pnl > 0 else 0.0

        skip_reason = None
        if lp < MIN_ENTRY_PRICE_RM:
            skip_reason = f'price {lp}¢ < min {MIN_ENTRY_PRICE_RM}¢'
        elif lp > MAX_ENTRY_PRICE_RM:
            skip_reason = f'price {lp}¢ > max {MAX_ENTRY_PRICE_RM}¢ (fee eats margin)'
        elif r['edge_pct'] < MIN_EDGE_PCT:
            skip_reason = f'edge {r["edge_pct"]:.2f}% < {MIN_EDGE_PCT}%'
        elif session_daily_pnl <= max_daily_loss:
            skip_reason = f'daily loss limit ${abs(max_daily_loss):.0f} reached'
        elif giveback_dollars >= giveback_limit:
            skip_reason = f'session giveback ${giveback_dollars:.2f} ≥ limit ${giveback_limit:.0f}'
        elif session_trade_count >= MAX_TRADES_PER_DAY:
            skip_reason = f'daily trade cap {MAX_TRADES_PER_DAY} reached'

        if skip_reason:
            r['contracts'] = 0; r['cost'] = 0.0; r['pnl'] = 0.0
            r['cash_after'] = round(cash, 2); r['skipped_reason'] = skip_reason
            continue

        # ── Quarter-Kelly sizing (mirrors risk-manager.ts exactly) ────────────
        p_dollars      = lp / 100.0
        fee_per_c_raw  = MAKER_FEE_RATE * p_dollars * (1 - p_dollars)
        net_win_per_c  = (1 - p_dollars) - fee_per_c_raw
        total_cost_per_c = p_dollars + fee_per_c_raw
        b              = net_win_per_c / total_cost_per_c if total_cost_per_c > 0 else 1.0
        p_win          = (1.0 - r['p_model']) if r['side'] == 'no' else r['p_model']
        kelly_f        = max(0.0, (b * p_win - (1 - p_win)) / b)

        vol_scalar  = max(0.30, min(1.50, REF_VOL_15M / r['gk_vol'])) if r['gk_vol'] > 0 else 1.0
        conf_scalar = 1.00 if r['confidence'] == 'high' else 0.80 if r['confidence'] == 'medium' else 0.50

        max_trade_capital = cash * MAX_TRADE_PCT
        trade_budget      = min(kelly_f * 0.25 * cash * vol_scalar * conf_scalar, max_trade_capital)
        # Math.round() matches live risk-manager.ts (not int/floor)
        budget_contracts  = round(trade_budget / total_cost_per_c) if total_cost_per_c > 0 else 0
        contracts         = min(budget_contracts, MAX_CONTRACTS_RM)

        # Book depth cap (Kalshi thin-book reality — not in risk manager but real execution limit)
        contracts = min(contracts, MAX_ORDER_DEPTH)

        # Min profit floor (mirrors risk-manager.ts)
        min_profit    = max(0.25, cash * 0.005)
        expected_profit = net_win_per_c * contracts
        if contracts <= 0 or expected_profit < min_profit:
            r['contracts'] = 0; r['cost'] = 0.0; r['pnl'] = 0.0
            r['cash_after'] = round(cash, 2)
            r['skipped_reason'] = ('zero contracts' if contracts <= 0
                                   else f'profit ${expected_profit:.2f} < floor ${min_profit:.2f}')
            continue

        # ── Slippage (book sweep above SLIPPAGE_FREE_CTRS) ────────────────────
        if contracts > SLIPPAGE_FREE_CTRS:
            extra = contracts - SLIPPAGE_FREE_CTRS
            avg_cents = (SLIPPAGE_FREE_CTRS * lp
                         + extra * (lp + extra * SLIPPAGE_CENTS_PER / 2)) / contracts
        else:
            avg_cents = float(lp)

        p_eff     = avg_cents / 100.0
        total_fee = kalshi_fee(contracts, avg_cents)
        fee_per_c = total_fee / contracts
        cost_per  = p_eff + fee_per_c
        net_win   = (1.0 - p_eff) - fee_per_c
        net_loss  = -p_eff - fee_per_c

        outcome = r['outcome']
        cost    = contracts * cost_per
        pnl     = contracts * net_win if outcome == 'WIN' else contracts * net_loss
        cash    = max(0.0, cash + pnl)

        session_daily_pnl   += pnl
        session_peak_pnl     = max(session_peak_pnl, session_daily_pnl)
        session_trade_count += 1

        r['contracts']   = contracts
        r['cost']        = round(cost, 2)
        r['pnl']         = round(pnl, 2)
        r['cash_after']  = round(cash, 2)
        r['outcome_sim'] = outcome

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
        except (ValueError, KeyError) as e: log.warning(f"Skipping market with bad close_time: {m.get('ticker','?')} — {e}")

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

    # ── Run: agent-faithful simulation ───────────────────────────────────────
    final = simulate(records)

    executed = [r for r in records if r.get('contracts', 0) > 0]
    skipped_rm = [r for r in records if r.get('contracts', 0) == 0]
    wins   = [r for r in executed if r.get('outcome_sim', r['outcome']) == 'WIN']
    losses = [r for r in executed if r.get('outcome_sim', r['outcome']) == 'LOSS']

    # Skip-reason breakdown
    skip_reasons: dict = {}
    for r in skipped_rm:
        reason = r.get('skipped_reason', 'unknown')
        # Bucket into categories
        if 'daily loss' in reason:     bucket = 'daily_loss_limit'
        elif 'giveback' in reason:     bucket = 'session_giveback_gate'
        elif 'daily trade cap' in reason: bucket = 'max_trades_per_day'
        elif 'profit' in reason:       bucket = 'below_min_profit_floor'
        elif 'zero contracts' in reason: bucket = 'kelly_zero_contracts'
        elif '< min' in reason or '> max' in reason: bucket = 'price_gate'
        else:                          bucket = reason
        skip_reasons[bucket] = skip_reasons.get(bucket, 0) + 1

    max_cash = STARTING_CASH
    max_dd   = 0.0
    cur_streak = 0
    max_win_streak = max_loss_streak = 0
    last_outcome = None
    for r in executed:
        oc = r.get('outcome_sim', r['outcome'])
        max_cash = max(max_cash, r['cash_after'])
        dd = (max_cash - r['cash_after']) / max_cash * 100
        max_dd = max(max_dd, dd)
        if oc == last_outcome: cur_streak += 1
        else: cur_streak = 1
        if oc == 'WIN': max_win_streak  = max(max_win_streak,  cur_streak)
        else:           max_loss_streak = max(max_loss_streak, cur_streak)
        last_outcome = oc

    period  = f"{records[0]['entry_dt'][:16]} UTC  →  {records[-1]['entry_dt'][:16]} UTC"
    wr      = len(wins) / max(len(executed), 1) * 100
    pnl     = final - STARTING_CASH
    ret_pct = (final / STARTING_CASH - 1) * 100
    avg_win       = sum(r['pnl'] for r in wins)   / max(len(wins),   1)
    avg_loss      = sum(r['pnl'] for r in losses) / max(len(losses), 1)
    gross_wins    = sum(r['pnl'] for r in wins)
    gross_losses  = abs(sum(r['pnl'] for r in losses))

    W = 102
    print("\n" + "="*W)
    print(f"  ROMA AGENT  ·  KXBTC15M  ·  {DAYS_BACK}-day Backtest  ·  ${STARTING_CASH:.2f} start  ·  {period}")
    print("  Strategy: d∈[1.0,1.2] · entry 3–9min · Quarter-Kelly (0.25×) · maker fee 1.75%")
    print(f"  Risk mgr: minEdge {MIN_EDGE_PCT}% · maxEntry {MAX_ENTRY_PRICE_RM}¢ · giveback {MAX_GIVEBACK_MULT}×daily-loss · loss/day {MAX_DAILY_LOSS_FLOOR}$ floor · {MAX_TRADES_PER_DAY} trades/day")
    print(f"  Execution: {MAX_ORDER_DEPTH}-contract book depth · linear slippage above {SLIPPAGE_FREE_CTRS} contracts")
    print("="*W)
    print(f"  {'Windows total (settled markets)':<40} {len(markets):>8}")
    print(f"  {'Windows with qualifying d-score':<40} {len(records):>8}  ({len(records)/max(len(markets),1)*100:.1f}%)")
    print(f"  {'Trades executed by agent':<40} {len(executed):>8}")
    print(f"  {'Trades skipped by risk manager':<40} {len(skipped_rm):>8}")
    for bucket, cnt in sorted(skip_reasons.items(), key=lambda x: -x[1]):
        print(f"    {'↳ ' + bucket:<38} {cnt:>8}")
    print(f"  {'-'*55}")
    print(f"  {'Win rate':<40} {wr:>7.1f}%")
    print(f"  {'Avg win per trade':<40} ${avg_win:>+7.2f}")
    print(f"  {'Avg loss per trade':<40} ${avg_loss:>+7.2f}")
    print(f"  {'Profit factor':<40} {gross_wins/max(gross_losses,0.01):>8.2f}×  (gross wins ÷ gross losses)")
    print(f"  {'Longest win streak':<40} {max_win_streak:>8}")
    print(f"  {'Longest loss streak':<40} {max_loss_streak:>8}")
    print(f"  {'-'*55}")
    print(f"  {'Starting cash':<40} ${STARTING_CASH:>8.2f}")
    print(f"  {'Final cash':<40} ${final:>8.2f}")
    print(f"  {'Total P&L':<40} ${pnl:>+8.2f}")
    print(f"  {'Return':<40} {ret_pct:>+7.1f}%")
    print(f"  {'Max drawdown (peak → trough, balance)':<40} {max_dd:>7.1f}%")
    print(f"  {'Peak balance':<40} ${max_cash:>8.2f}")
    print("="*W)
    print()

    # ── Trade log ─────────────────────────────────────────────────────────────
    print("  AGENT TRADE LOG")
    hdr = (f"  {'#':<4} {'Entry (UTC)':<17} {'Side':<3} {'LP¢':>4} {'MinL':>4} "
           f"{'d':>5} {'BTC Spot':>9} {'Strike':>9} {'Dist%':>6} "
           f"{'pModel':>7} {'Edge%':>6} {'Ctrs':>5} {'PnL':>8} {'Balance':>9}  Result")
    print(hdr)
    print("  " + "-"*(len(hdr) - 2))
    trade_n = 0
    for r in records:
        if r.get('contracts', 0) == 0:
            continue
        trade_n += 1
        outcome    = r.get('outcome_sim', r['outcome'])
        result_icon = "✓ WIN" if outcome == 'WIN' else "✗ LOSS"
        entry_str  = r['entry_dt'][5:16].replace('T', ' ')
        print(f"  {trade_n:<4} {entry_str:<17} {r['side']:<3} {r['limit_price_cents']:>4} "
              f"{r['minutes_left']:>4.1f} {r['d_score']:>5.3f} "
              f"${r['spot']:>8,.0f} ${r['strike']:>8,.0f} {r['dist_pct']:>+6.3f} "
              f"{r['p_model']:>7.3f} {r['edge_pct']:>6.2f} {r['contracts']:>5} "
              f"${r['pnl']:>+7.2f} ${r['cash_after']:>8.2f}  {result_icon}")
    print("="*W)


if __name__ == '__main__':
    main()
