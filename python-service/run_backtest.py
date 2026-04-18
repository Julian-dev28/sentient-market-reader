"""
KXBTC15M Backtest — directional momentum stack, around-the-clock

Goal: predict BTC up/down correctly for every window. Make the RIGHT BETS.
Signals:
  1. Markov gap ≥ 0.15    — 5-min chain, 65%+ directional confidence
  2. Markov persist ≥ 0.82— chain locked in state (not noise)
  3. Hurst > 0.50         — trending regime; mean-reversion = skip
  4. Velocity gate        — price not rushing toward strike >40% of crossing speed
  5. Vol ≤ 1.25×ref       — skip chaotic high-vol windows
  6. Entry 6–9 min left   — 6-9min = 98.3% WR on live fills
Sizing: confidence-tiered flat risk (no Kelly) — 1% at gap=0.15, scales to 5% at gap≥0.65
Daily loss cap 3%. No price gates — ANY profit after fees is acceptable.
"""

import math
import time
import logging
import json
import os
from datetime import datetime, timezone, timedelta

import requests
import urllib3

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
log = logging.getLogger(__name__)

KALSHI_BASE = "https://api.elections.kalshi.com/trade-api/v2"
YAHOO_BASE  = "https://query2.finance.yahoo.com/v8/finance/chart"

_S = requests.Session()
_S.headers["User-Agent"] = "Mozilla/5.0"
_S.verify = False   # local backtest — macOS cert chain issue

# ── Strategy parameters ───────────────────────────────────────────────────────
STARTING_CASH        = 200.00
DAYS_BACK            = 30

# No d-gate
D_THRESHOLD          = 0.0
D_MAX_THRESHOLD      = 99.0

# Timing
MIN_MINUTES_LEFT     = 6
MAX_MINUTES_LEFT     = 9

# Hurst
MIN_HURST            = 0.50

# Velocity gate
VEL_SAFETY_RATIO     = 0.40

# Markov: 65%+ conviction + state must be locked in (not noise)
MARKOV_MIN_GAP       = 0.15
MIN_PERSIST          = 0.82

# Vol regime
MAX_VOL_MULT         = 1.25

# Confidence-tiered flat risk (replaces Kelly)
# risk_pct = min(5%, 1% + 8% × max(0, gap − 0.15))
# gap=0.15 → 1%,  gap=0.40 → 3%,  gap=0.65+ → 5%

# Risk / sizing — MAX_ENTRY_PRICE_RM targets the market efficiency zone:
# 65-73¢ windows are where Markov gets 93.8% WR but market only prices ~71¢.
# 79-85¢ windows need 82% WR to profit — Markov only delivers 76% there.
MIN_ENTRY_PRICE_RM   = 0     # no floor — let any price through
MAX_ENTRY_PRICE_RM   = 72    # cap: only bet where market underprices our signal
                             # 71¢ zone (d>2.0): 91.5% WR, market prices ~71¢ → massive edge
                             # 73¢ zone (d∈[0.5,0.8]): 66% WR, market prices 73¢ → losing
MIN_DIST_PCT         = 0.02
MAX_CONTRACTS_RM     = 500
REF_VOL_15M          = 0.002
MAX_TRADE_PCT        = 0.15
MAX_TRADES_PER_DAY   = 48
MAX_DAILY_LOSS_PCT   = 3
MAX_DAILY_LOSS_FLOOR = 50
MAX_DAILY_LOSS_CAP   = 150
MAX_GIVEBACK_MULT    = 1.5
POLLER_INTERVAL_MIN  = 0.5
BLOCKED_UTC_HOURS    = {11, 18}

MAKER_FEE_RATE     = 0.0175
MAX_ORDER_DEPTH    = 25
SLIPPAGE_FREE_CTRS = 10
SLIPPAGE_CENTS_PER = 0.5

EMPIRICAL_PRICE_BY_D = [
    (0.0, 0.5,  62.3),
    (0.5, 0.8,  72.7),
    (0.8, 1.0,  79.1),
    (1.0, 1.2,  80.8),
    (1.2, 1.5,  84.6),
    (1.5, 2.0,  83.6),
    (2.0, 99.0, 71.0),
]

# ── Markov chain ──────────────────────────────────────────────────────────────
NUM_STATES    = 9
MARKOV_CANDLE = 5
MIN_HISTORY   = 20
MARKOV_WINDOW = 480

STATE_BOUNDS  = [-3.35, -2.24, -1.12, -0.45, 0.45, 1.12, 2.24, 3.35]
STATE_RETURNS = [-2.0, -1.25, -0.75, -0.35, 0.0,  0.35, 0.75, 1.25, 2.0]
STATE_VOL     = [ 1.0,  0.35,  0.25,  0.15, 0.10, 0.15, 0.25, 0.35, 1.0]


# ── Math helpers ──────────────────────────────────────────────────────────────

def norm_cdf(z: float) -> float:
    sign = 1 if z >= 0 else -1
    x    = abs(z)
    t    = 1.0 / (1.0 + 0.2316419 * x)
    poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))))
    pdf  = math.exp(-0.5 * x * x) / math.sqrt(2 * math.pi)
    return 0.5 + sign * (0.5 - pdf * poly)


def compute_hurst(candles_newest: list) -> float | None:
    """
    Hurst exponent via variance-ratio method on 15-min log-returns.
    > 0.5 = trending (momentum persists). < 0.5 = mean-reverting.
    """
    closes = [c[4] for c in reversed(candles_newest)]
    if len(closes) < 12:
        return None
    lr = [math.log(closes[i] / closes[i - 1]) for i in range(1, len(closes)) if closes[i - 1] > 0]
    if len(lr) < 6:
        return None
    var1 = sum(r * r for r in lr) / len(lr)
    pairs = [lr[i] + lr[i + 1] for i in range(0, len(lr) - 1, 2)]
    var2  = sum(r * r for r in pairs) / max(len(pairs), 1) if pairs else 0.0
    if var1 <= 0:
        return None
    return max(0.0, min(1.0, 0.5 + math.log(max(var2 / (2 * var1), 1e-12)) / (2 * math.log(2))))


def compute_rsi(closes: list, period: int = 14) -> float | None:
    if len(closes) < period + 1:
        return None
    changes = [closes[i] - closes[i - 1] for i in range(1, len(closes))]
    gains   = [max(c, 0.0) for c in changes]
    losses  = [max(-c, 0.0) for c in changes]
    avg_g   = sum(gains[:period])  / period
    avg_l   = sum(losses[:period]) / period
    for i in range(period, len(changes)):
        avg_g = (avg_g * (period - 1) + gains[i])  / period
        avg_l = (avg_l * (period - 1) + losses[i]) / period
    return 100.0 if avg_l == 0 else 100.0 - 100.0 / (1.0 + avg_g / avg_l)


def compute_ema(closes: list, period: int) -> float | None:
    if len(closes) < period:
        return None
    k   = 2.0 / (period + 1)
    ema = sum(closes[:period]) / period
    for p in closes[period:]:
        ema = p * k + ema * (1.0 - k)
    return ema


# ── Markov chain ──────────────────────────────────────────────────────────────

def price_change_to_state(pct: float) -> int:
    for i, b in enumerate(STATE_BOUNDS):
        if pct < b:
            return i
    return NUM_STATES - 1


def build_transition_matrix(history: list) -> list:
    counts = [[0.0] * NUM_STATES for _ in range(NUM_STATES)]
    for i in range(len(history) - 1):
        s_from, s_to = history[i], history[i + 1]
        if 0 <= s_from < NUM_STATES and 0 <= s_to < NUM_STATES:
            counts[s_from][s_to] += 1.0
    P = []
    for row in counts:
        total = sum(row)
        P.append([v / total for v in row] if total > 0 else [1.0 / NUM_STATES] * NUM_STATES)
    return P


def predict_from_momentum(P: list, current_state: int,
                          minutes_left: float, dist_pct: float) -> dict:
    T              = max(1, round(minutes_left / MARKOV_CANDLE))
    required_drift = -dist_pct
    dist      = [0.0] * NUM_STATES
    dist[current_state] = 1.0
    exp_drift = 0.0
    var_sum   = 0.0
    for _ in range(T):
        step_mean = sum(dist[i] * STATE_RETURNS[i] for i in range(NUM_STATES))
        step_e2   = sum(dist[i] * (STATE_VOL[i] ** 2 + STATE_RETURNS[i] ** 2) for i in range(NUM_STATES))
        exp_drift += step_mean
        var_sum   += max(0.0, step_e2 - step_mean ** 2)
        nxt = [0.0] * NUM_STATES
        for i in range(NUM_STATES):
            for j in range(NUM_STATES):
                nxt[j] += dist[i] * P[i][j]
        dist = nxt
    sigma   = math.sqrt(max(var_sum, 0.01))
    z_score = (exp_drift - required_drift) / sigma
    p_yes   = norm_cdf(z_score)
    row     = P[current_state]
    j_star  = max(range(NUM_STATES), key=lambda j: row[j])
    persist = row[current_state]
    return {
        'p_yes': p_yes, 'p_no': 1.0 - p_yes,
        'expected_drift_pct': exp_drift, 'required_drift_pct': required_drift,
        'sigma': sigma, 'z_score': z_score, 'persist': persist, 'j_star': j_star,
        'enter_yes': p_yes >= 0.65 and persist >= 0.80,
        'enter_no':  p_yes <= 0.35 and persist >= 0.80,
    }


def build_markov_history(candles_5m_oldest: list, up_to_ts: float) -> list:
    relevant = [c for c in candles_5m_oldest if c[0] + MARKOV_CANDLE * 60 <= up_to_ts]
    if len(relevant) < 2:
        return []
    states = []
    for i in range(1, len(relevant)):
        prev, curr = relevant[i - 1][4], relevant[i][4]
        if prev > 0:
            states.append(price_change_to_state((curr - prev) / prev * 100.0))
    return states[-MARKOV_WINDOW:]


def gk_vol(candles_newest: list):
    K     = 2 * math.log(2) - 1
    terms = []
    for c in candles_newest:
        lo, hi, op, cl = c[1], c[2], c[3], c[4]
        if op <= 0 or lo <= 0 or hi <= 0:
            continue
        terms.append(0.5 * math.log(hi / lo) ** 2 - K * math.log(cl / op) ** 2)
    if len(terms) < 2:
        return None
    return math.sqrt(max(0.0, sum(terms) / len(terms)))


# ── Data fetch ────────────────────────────────────────────────────────────────

def _get(url: str, retries: int = 3):
    for attempt in range(retries):
        try:
            r = _S.get(url, timeout=30)
            if r.status_code == 429:
                time.sleep(2 ** attempt); continue
            r.raise_for_status()
            return r.json()
        except Exception:
            if attempt < retries - 1:
                time.sleep(1); continue
            raise


def _parse_yahoo(data: dict) -> list:
    result     = data['chart']['result'][0]
    timestamps = result['timestamp']
    quote      = result['indicators']['quote'][0]
    candles    = []
    for i, ts in enumerate(timestamps):
        o = quote['open'][i]; h = quote['high'][i]
        l = quote['low'][i];  c = quote['close'][i]
        v = (quote.get('volume') or [None])[i] or 0
        if o is None or h is None or l is None or c is None:
            continue
        candles.append([int(ts), float(l), float(h), float(o), float(c), float(v)])
    candles.sort(key=lambda c: c[0])
    return candles


def _cache(name: str) -> str:
    return os.path.join(os.path.dirname(__file__), f'_backtest_cache_{name}.json')


def fetch_candles_15m(days_back: int = 60) -> list:
    p = _cache('15m')
    if os.path.exists(p) and time.time() - os.path.getmtime(p) < 3600:
        with open(p) as f: data = json.load(f)
        log.info(f"Loaded {len(data)} BTC/15m candles (cache)"); return data
    data = _parse_yahoo(_get(f"{YAHOO_BASE}/BTC-USD?interval=15m&range={days_back}d"))
    with open(p, 'w') as f: json.dump(data, f)
    log.info(f"Fetched {len(data)} BTC/15m candles"); return data


def fetch_candles_5m(days_back: int = 60) -> list:
    p = _cache('5m')
    if os.path.exists(p) and time.time() - os.path.getmtime(p) < 3600:
        with open(p) as f: data = json.load(f)
        log.info(f"Loaded {len(data)} BTC/5m candles (cache)"); return data
    data = _parse_yahoo(_get(f"{YAHOO_BASE}/BTC-USD?interval=5m&range={days_back}d"))
    with open(p, 'w') as f: json.dump(data, f)
    log.info(f"Fetched {len(data)} BTC/5m candles"); return data


def fetch_settled_markets(days_back: int) -> list:
    cutoff = datetime.now(timezone.utc) - timedelta(days=days_back)
    markets, cursor = [], None
    while True:
        url = f"{KALSHI_BASE}/markets?series_ticker=KXBTC15M&status=settled&limit=200"
        if cursor: url += f"&cursor={cursor}"
        try:
            data = _get(url)
        except Exception as e:
            log.error(f"Kalshi fetch failed: {e}"); break
        batch = data.get('markets', [])
        if not batch: break
        done = False
        for m in batch:
            ct = m.get('close_time') or m.get('expiration_time')
            if not ct: continue
            try:
                close_dt = datetime.fromisoformat(ct.replace('Z', '+00:00'))
            except ValueError:
                continue
            if close_dt < cutoff: done = True; break
            fs     = m.get('floor_strike')
            result = m.get('result')
            ticker = m.get('ticker', '')
            if fs is not None and result in ('yes', 'no') and ticker:
                try:
                    markets.append({'ticker': ticker, 'floor_strike': float(fs),
                                    'result': result, 'close_time': ct})
                except (ValueError, TypeError): pass
        if done: break
        cursor = data.get('cursor')
        if not cursor: break
        time.sleep(0.15)
    log.info(f"Fetched {len(markets)} settled markets ({days_back}d)")
    return markets


# ── Process one market window ─────────────────────────────────────────────────

def process_market(mkt: dict, candles_15m: list, candles_5m: list) -> dict | None:
    ticker  = mkt['ticker']
    strike  = mkt['floor_strike']
    result  = mkt['result']

    try:
        close_dt = datetime.fromisoformat(mkt['close_time'].replace('Z', '+00:00'))
    except ValueError:
        return None

    open_ts  = (close_dt - timedelta(minutes=15)).timestamp()
    close_ts = close_dt.timestamp()

    check_times = []
    t = open_ts + POLLER_INTERVAL_MIN * 60
    while t <= close_ts - MIN_MINUTES_LEFT * 60:
        check_times.append(t)
        t += POLLER_INTERVAL_MIN * 60

    c5_by_ts: dict[int, list] = {c[0]: c for c in candles_5m}

    for check_ts in check_times:
        minutes_left = (close_ts - check_ts) / 60.0
        if minutes_left > MAX_MINUTES_LEFT or minutes_left < MIN_MINUTES_LEFT:
            continue

        # UTC hour gate
        if datetime.fromtimestamp(check_ts, tz=timezone.utc).hour in BLOCKED_UTC_HOURS:
            continue

        # 15-min context for GK vol + Hurst
        ctx15 = [c for c in candles_15m if c[0] + 900 <= check_ts]
        if len(ctx15) < 12:
            continue
        last_32_15m = list(reversed(ctx15[-32:]))

        # Gate 6 — vol regime (check before spot lookup to fail fast)
        gk = gk_vol(last_32_15m[:16])
        if not gk or gk <= 0:
            continue
        if gk > REF_VOL_15M * MAX_VOL_MULT:
            continue   # high-vol regime: unpredictable

        # Gate 3 — Hurst trending regime
        hurst = compute_hurst(last_32_15m[:24])
        if hurst is not None and hurst < MIN_HURST:
            continue   # mean-reverting: direction lock unreliable

        # Spot price from last completed 5-min candle
        c5_ts  = int(check_ts // (MARKOV_CANDLE * 60)) * MARKOV_CANDLE * 60 - MARKOV_CANDLE * 60
        c5_bar = c5_by_ts.get(c5_ts) or c5_by_ts.get(c5_ts - MARKOV_CANDLE * 60)
        spot   = c5_bar[4] if c5_bar else last_32_15m[0][4]
        if spot <= 0:
            continue

        dist_pct     = (spot - strike) / strike * 100.0
        above_strike = spot >= strike

        if abs(dist_pct) < MIN_DIST_PCT:
            continue

        # Gate 4 — velocity: price not rushing toward strike
        c5_prev3 = c5_by_ts.get(c5_ts - 3 * MARKOV_CANDLE * 60)   # 15 min ago
        if c5_bar and c5_prev3 and c5_prev3[4] > 0:
            vel_per_min  = (c5_bar[4] - c5_prev3[4]) / 15.0   # $/min over last 15 min
            dist_usd     = abs(spot - strike)
            crossing_vel = dist_usd / minutes_left if minutes_left > 0 else 1e9
            toward_strike = (above_strike and vel_per_min < 0) or (not above_strike and vel_per_min > 0)
            if toward_strike and crossing_vel > 0 and abs(vel_per_min) > VEL_SAFETY_RATIO * crossing_vel:
                continue   # price heading toward strike too fast

        # Gate 1 — d-score edge zone
        candles_left = minutes_left / 15.0
        try:
            d = math.log(spot / strike) / (gk * math.sqrt(candles_left))
        except (ValueError, ZeroDivisionError):
            continue
        d_abs = abs(d)
        if D_THRESHOLD > 0 and (d_abs < D_THRESHOLD or d_abs > D_MAX_THRESHOLD):
            continue

        # Markov chain signal
        history = build_markov_history(candles_5m, check_ts)
        if len(history) < MIN_HISTORY:
            continue

        c5_prev = c5_by_ts.get(c5_ts - MARKOV_CANDLE * 60)
        if c5_bar and c5_prev and c5_prev[4] > 0:
            current_state = price_change_to_state((c5_bar[4] - c5_prev[4]) / c5_prev[4] * 100.0)
        else:
            current_state = 4

        full_history = history + [current_state]
        P            = build_transition_matrix(full_history)
        forecast     = predict_from_momentum(P, current_state, minutes_left, dist_pct)
        p_yes        = forecast['p_yes']

        # Gate 5 — Markov confidence
        if abs(p_yes - 0.5) < MARKOV_MIN_GAP:
            continue

        # Gate 6 — Markov persistence: chain locked in state (not noise)
        if forecast['persist'] < MIN_PERSIST:
            continue

        rec = 'yes' if p_yes > 0.5 else 'no'

        # Build 5-min close window (25 bars, oldest-first)
        c5_closes: list[float] = []
        for i in range(24, -1, -1):
            bar = c5_by_ts.get(c5_ts - i * MARKOV_CANDLE * 60)
            if bar:
                c5_closes.append(float(bar[4]))

        rsi = compute_rsi(c5_closes) if len(c5_closes) >= 15 else None

        # (no RSI gate — tested, hurts WR; Kelly already screens bad-EV trades)
        # (no state-alignment gate — tested, counterproductive at gap=0.15)

        # Entry price from empirical table
        in_money_price = 80.0
        for d_lo, d_hi, emp_p in EMPIRICAL_PRICE_BY_D:
            if d_lo <= d_abs < d_hi:
                in_money_price = emp_p; break

        if above_strike:
            yes_ask, no_ask = in_money_price, 100.0 - in_money_price
        else:
            no_ask, yes_ask = in_money_price, 100.0 - in_money_price

        limit_price_cents = round(yes_ask if rec == 'yes' else no_ask)
        if MAX_ENTRY_PRICE_RM > 0 and limit_price_cents > MAX_ENTRY_PRICE_RM:
            continue

        p_gap      = abs(p_yes - 0.5)
        confidence = 'high' if p_gap >= 0.15 else 'medium' if p_gap >= 0.07 else 'low'
        won        = (rec == result)

        return {
            'ticker':             ticker,
            'entry_dt':           datetime.fromtimestamp(check_ts, tz=timezone.utc).isoformat(),
            'expires_dt':         close_dt.isoformat(),
            'side':               rec,
            'spot':               round(spot, 2),
            'strike':             round(strike, 2),
            'dist_pct':           round(dist_pct, 4),
            'minutes_left':       round(minutes_left, 1),
            'd_score':            round(d, 3),
            'p_yes':              round(p_yes, 4),
            'p_no':               round(1.0 - p_yes, 4),
            'z_score':            round(forecast['z_score'], 3),
            'persist':            round(forecast['persist'], 3),
            'expected_drift_pct': round(forecast['expected_drift_pct'], 4),
            'required_drift_pct': round(forecast['required_drift_pct'], 4),
            'sigma':              round(forecast['sigma'], 4),
            'enter_signal':       forecast['enter_yes'] if rec == 'yes' else forecast['enter_no'],
            'limit_price_cents':  limit_price_cents,
            'gk_vol':             round(gk, 6),
            'hurst':              round(hurst, 3) if hurst is not None else None,
            'rsi':                round(rsi, 1) if rsi is not None else None,
            'confidence':         confidence,
            'history_len':        len(full_history),
            'above_strike':       above_strike,
            'result':             result,
            'outcome':            'WIN' if won else 'LOSS',
        }

    return None


# ── Fee + simulation ──────────────────────────────────────────────────────────

def kalshi_fee(contracts: int, price_cents: float) -> float:
    p = price_cents / 100.0
    return math.ceil(MAKER_FEE_RATE * contracts * p * (1 - p) * 100) / 100


def simulate(records: list) -> float:
    ET_OFFSET = timedelta(hours=5)
    cash = STARTING_CASH
    session_daily_pnl = session_peak_pnl = 0.0
    session_trade_count = 0
    session_date_et = None

    for r in records:
        entry_et = datetime.fromisoformat(r['entry_dt']) - ET_OFFSET
        date_et  = entry_et.strftime('%Y-%m-%d')
        if date_et != session_date_et:
            session_date_et = date_et
            session_daily_pnl = session_peak_pnl = 0.0
            session_trade_count = 0

        lp = r['limit_price_cents']
        max_daily_loss   = -max(MAX_DAILY_LOSS_FLOOR, min(MAX_DAILY_LOSS_CAP, cash * MAX_DAILY_LOSS_PCT / 100))
        giveback_limit   = abs(max_daily_loss) * MAX_GIVEBACK_MULT
        giveback_dollars = (session_peak_pnl - session_daily_pnl) if session_peak_pnl > 0 else 0.0

        skip_reason = None
        if MAX_ENTRY_PRICE_RM > 0 and lp > MAX_ENTRY_PRICE_RM: skip_reason = f'price {lp}¢ > max {MAX_ENTRY_PRICE_RM}¢'
        elif session_daily_pnl <= max_daily_loss:      skip_reason = 'daily_loss_limit'
        elif giveback_dollars >= giveback_limit:        skip_reason = 'session_giveback'
        elif session_trade_count >= MAX_TRADES_PER_DAY: skip_reason = 'max_trades'

        if skip_reason:
            r.update(contracts=0, cost=0.0, pnl=0.0, cash_after=round(cash, 2), skipped_reason=skip_reason)
            continue

        p_dollars        = lp / 100.0
        fee_per_c_raw    = MAKER_FEE_RATE * p_dollars * (1 - p_dollars)
        total_cost_per_c = p_dollars + fee_per_c_raw

        # Confidence-tiered flat risk: 1% at gap=0.15, scales linearly to 5% at gap≥0.65
        gap              = abs(r['p_yes'] - 0.5)
        risk_pct         = min(0.05, 0.01 + 0.08 * max(0.0, gap - 0.15))
        risk_dollars     = cash * risk_pct
        budget_contracts = round(risk_dollars / total_cost_per_c) if total_cost_per_c > 0 else 1
        contracts        = min(max(1, budget_contracts), MAX_CONTRACTS_RM, MAX_ORDER_DEPTH)

        avg_cents = (SLIPPAGE_FREE_CTRS * lp + (contracts - SLIPPAGE_FREE_CTRS) *
                     (lp + (contracts - SLIPPAGE_FREE_CTRS) * SLIPPAGE_CENTS_PER / 2)
                     ) / contracts if contracts > SLIPPAGE_FREE_CTRS else float(lp)

        p_eff     = avg_cents / 100.0
        fee_per_c = kalshi_fee(contracts, avg_cents) / contracts
        net_win   = (1.0 - p_eff) - fee_per_c
        net_loss  = -p_eff - fee_per_c

        pnl  = contracts * (net_win if r['outcome'] == 'WIN' else net_loss)
        cash = max(0.0, cash + pnl)
        session_daily_pnl   += pnl
        session_peak_pnl     = max(session_peak_pnl, session_daily_pnl)
        session_trade_count += 1

        r.update(contracts=contracts, cost=round(contracts * (p_eff + fee_per_c), 2),
                 pnl=round(pnl, 2), cash_after=round(cash, 2), outcome_sim=r['outcome'])

    return cash


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    log.info(f"=== Directional KXBTC15M Backtest · {DAYS_BACK}d · ${STARTING_CASH} start ===")

    markets     = fetch_settled_markets(DAYS_BACK)
    candles_15m = fetch_candles_15m(60)
    candles_5m  = fetch_candles_5m(60)

    if not markets or len(candles_15m) < 100 or len(candles_5m) < 100:
        print("Insufficient data"); return

    records, skipped = [], 0
    for mkt in markets:
        try:
            r = process_market(mkt, candles_15m, candles_5m)
            if r: records.append(r)
            else: skipped += 1
        except Exception as e:
            log.warning(f"Skip {mkt.get('ticker','?')}: {e}"); skipped += 1

    records.sort(key=lambda r: r['entry_dt'])
    log.info(f"Qualified: {len(records)}, skipped {skipped} (of {len(markets)} total)")

    if not records:
        print("No qualifying trades"); return

    final      = simulate(records)
    executed   = [r for r in records if r.get('contracts', 0) > 0]
    skipped_rm = [r for r in records if r.get('contracts', 0) == 0]
    wins       = [r for r in executed if r.get('outcome_sim', r['outcome']) == 'WIN']
    losses     = [r for r in executed if r.get('outcome_sim', r['outcome']) == 'LOSS']
    strong     = [r for r in executed if r.get('enter_signal')]
    strong_w   = [r for r in strong   if r.get('outcome_sim', r['outcome']) == 'WIN']

    skip_reasons: dict = {}
    for r in skipped_rm:
        k = r.get('skipped_reason', 'unknown')
        skip_reasons[k] = skip_reasons.get(k, 0) + 1

    max_cash = STARTING_CASH; max_dd = 0.0
    cur_s = max_ws = max_ls = 0; last_oc = None
    for r in executed:
        oc = r.get('outcome_sim', r['outcome'])
        max_cash = max(max_cash, r['cash_after'])
        max_dd   = max(max_dd, (max_cash - r['cash_after']) / max_cash * 100)
        cur_s    = cur_s + 1 if oc == last_oc else 1
        if oc == 'WIN': max_ws = max(max_ws, cur_s)
        else:           max_ls = max(max_ls, cur_s)
        last_oc = oc

    wr       = len(wins) / max(len(executed), 1) * 100
    pnl      = final - STARTING_CASH
    ret_pct  = (final / STARTING_CASH - 1) * 100
    avg_win  = sum(r['pnl'] for r in wins)   / max(len(wins), 1)
    avg_loss = sum(r['pnl'] for r in losses) / max(len(losses), 1)
    gw       = sum(r['pnl'] for r in wins)
    gl       = abs(sum(r['pnl'] for r in losses))
    period   = f"{records[0]['entry_dt'][:16]} → {records[-1]['entry_dt'][:16]} UTC"

    W = 108
    print("\n" + "=" * W)
    print(f"  DIRECTIONAL MODEL  ·  KXBTC15M  ·  {DAYS_BACK}-day  ·  ${STARTING_CASH:.0f} start  ·  {period}")
    price_gate_str = f"entry≤{MAX_ENTRY_PRICE_RM}¢ (market efficiency)" if MAX_ENTRY_PRICE_RM > 0 else "no price gate"
    print(f"  Filters: Markov gap≥{MARKOV_MIN_GAP} · 6-9min · Hurst>{MIN_HURST} · vel<{VEL_SAFETY_RATIO:.0%}×cross · vol≤{MAX_VOL_MULT}×ref · {price_gate_str}")
    print("=" * W)
    print(f"  {'Sizing: tiered flat risk (gap→risk%)':<40} {'1%@0.15 → 5%@0.65':>8}")
    print(f"  {'Windows total':<40} {len(markets):>8}")
    print(f"  {'Qualified (all gates pass)':<40} {len(records):>8}  ({len(records)/max(len(markets),1)*100:.1f}%)")
    print(f"  {'Executed by agent':<40} {len(executed):>8}")
    print(f"    {'↳ strong signal (enter★)':<38} {len(strong):>8}  WR {len(strong_w)/max(len(strong),1)*100:.1f}%")
    print(f"  {'Skipped by risk manager':<40} {len(skipped_rm):>8}")
    for k, v in sorted(skip_reasons.items(), key=lambda x: -x[1]):
        print(f"      ↳ {k:<36} {v:>8}")
    print(f"  {'-'*50}")
    print(f"  {'Win rate':<40} {wr:>7.1f}%")
    print(f"  {'Avg win per trade':<40} ${avg_win:>+7.2f}")
    print(f"  {'Avg loss per trade':<40} ${avg_loss:>+7.2f}")
    print(f"  {'Profit factor':<40} {gw/max(gl,0.01):>8.2f}×")
    print(f"  {'Longest win / loss streak':<40}   {max_ws:>3} / {max_ls}")
    print(f"  {'-'*50}")
    print(f"  {'Starting cash':<40} ${STARTING_CASH:>8.2f}")
    print(f"  {'Final cash':<40} ${final:>8.2f}")
    print(f"  {'Total P&L':<40} ${pnl:>+8.2f}")
    print(f"  {'Return':<40} {ret_pct:>+7.1f}%")
    print(f"  {'Max drawdown':<40} {max_dd:>7.1f}%")
    print(f"  {'Peak balance':<40} ${max_cash:>8.2f}")
    # ── Price bucket breakdown ────────────────────────────────────────────────
    buckets = [(0,65,'<65¢'),(65,73,'65-73¢'),(73,79,'73-79¢'),(79,85,'79-85¢'),(85,100,'85+¢')]
    print()
    print("  EDGE BY ENTRY PRICE  (break-even WR = entry price)")
    print(f"  {'Bucket':<10} {'Trades':>7} {'WR':>7} {'BE WR':>7} {'Edge':>7} {'Total PnL':>10}")
    print("  " + "-" * 55)
    for lo, hi, label in buckets:
        b_trades = [r for r in executed if lo <= r['limit_price_cents'] < hi]
        if not b_trades: continue
        b_wins   = [r for r in b_trades if r.get('outcome_sim', r['outcome']) == 'WIN']
        b_wr     = len(b_wins) / len(b_trades) * 100
        b_be_wr  = (lo + hi) / 2
        b_edge   = b_wr - b_be_wr
        b_pnl    = sum(r['pnl'] for r in b_trades)
        print(f"  {label:<10} {len(b_trades):>7} {b_wr:>6.1f}% {b_be_wr:>6.1f}% {b_edge:>+6.1f}pp ${b_pnl:>+8.2f}")
    print("=" * W)
    print()

    print("  TRADE LOG")
    hdr = (f"  {'#':<4} {'Entry (UTC)':<17} {'S':<3} {'LP¢':>4} {'Min':>4} "
           f"{'pYes':>6} {'Pers':>5} {'RSI':>5} {'Hurst':>5} "
           f"{'Spot':>9} {'Strike':>9} {'Dist%':>6} "
           f"{'Ctrs':>4} {'PnL':>8} {'Bal':>9}  Result")
    print(hdr)
    print("  " + "-" * (len(hdr) - 2))
    n = 0
    for r in records:
        if r.get('contracts', 0) == 0: continue
        n += 1
        oc    = r.get('outcome_sim', r['outcome'])
        sig   = "★" if r.get('enter_signal') else " "
        icon  = "✓ WIN" if oc == 'WIN' else "✗ LOSS"
        h_str = f"{r['hurst']:.2f}" if r.get('hurst') is not None else "  -  "
        r_str = f"{r['rsi']:.0f}" if r.get('rsi') is not None else "  -"
        print(f"  {n:<4} {r['entry_dt'][5:16].replace('T',' '):<17} {r['side']:<3} "
              f"{r['limit_price_cents']:>4} {r['minutes_left']:>4.1f} "
              f"{r['p_yes']:>6.3f} {r['persist']:>5.2f} {r_str:>5} {h_str:>5} "
              f"${r['spot']:>8,.0f} ${r['strike']:>8,.0f} {r['dist_pct']:>+6.3f} "
              f"{r['contracts']:>4} ${r['pnl']:>+7.2f} ${r['cash_after']:>8.2f}  "
              f"{sig}{icon}")
    print("=" * W)
    print()


if __name__ == '__main__':
    main()
