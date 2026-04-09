"""
Historical Backtest — KXBTC15M
─────────────────────────────────
Fetches settled Kalshi KXBTC15M markets + historical BTC 15-min candles,
then replays the deterministic quant math against each window to produce
calibration-ready TradeRecord-compatible records.

Quant-only: no LLM/sentiment signals (set to 0). Only the deterministic
math is replayed: GK vol, Brownian prior, Black-Scholes digital, fat-tail
Student-t, time-weighted blend via Logarithmic Opinion Pool.
"""

import math
import time
import logging
from datetime import datetime, timezone, timedelta
from typing import Optional

import requests

logger = logging.getLogger(__name__)

COINBASE_BASE = "https://api.exchange.coinbase.com"
KALSHI_BASE   = "https://api.elections.kalshi.com/trade-api/v2"

_SESSION = requests.Session()
_SESSION.headers.update({"User-Agent": "sentient-backtest/1.0"})


# ── HTTP helpers ──────────────────────────────────────────────────────────────

def _get_json(url: str, headers: Optional[dict] = None, retries: int = 3):
    """GET JSON with retry/backoff. Uses requests for proper SSL handling."""
    for attempt in range(retries):
        try:
            resp = _SESSION.get(url, headers=headers or {}, timeout=20)
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


# ── Quant math (mirrors lib/indicators.ts exactly) ───────────────────────────

def _norm_cdf(z: float) -> float:
    """Normal CDF — Abramowitz & Stegun (error < 7.5e-8)."""
    sign = 1 if z >= 0 else -1
    x    = abs(z)
    t    = 1.0 / (1.0 + 0.2316419 * x)
    poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))))
    pdf  = math.exp(-0.5 * x * x) / math.sqrt(2 * math.pi)
    return 0.5 + sign * (0.5 - pdf * poly)


def _student_t_cdf(t_val: float, nu: float) -> float:
    """Student-t CDF via regularized incomplete beta (mirrors TypeScript studentTCDF)."""
    try:
        from scipy.stats import t as scipy_t
        return float(scipy_t.cdf(t_val, df=nu))
    except ImportError:
        # Fallback: use normal approximation for large nu
        if nu > 30:
            return _norm_cdf(t_val)
        # Simple approximation for small nu
        x = nu / (nu + t_val * t_val)
        # Use beta function approximation
        import math
        ib = _inc_beta(x, nu / 2.0, 0.5)
        return (1.0 - ib / 2.0) if t_val >= 0 else (ib / 2.0)


def _inc_beta(x: float, a: float, b: float) -> float:
    """Regularized incomplete beta — Lentz continued fraction (mirrors TypeScript)."""
    if x <= 0:
        return 0.0
    if x >= 1:
        return 1.0
    if x > (a + 1) / (a + b + 2):
        return 1.0 - _inc_beta(1 - x, b, a)
    try:
        lbeta = math.lgamma(a) + math.lgamma(b) - math.lgamma(a + b)
    except ValueError:
        return 0.0
    front = math.exp(a * math.log(x) + b * math.log(1 - x) - lbeta) / a
    TINY, EPS = 1e-30, 3e-7
    C = 1.0
    D = 1.0 / max(1 - (a + b) * x / (a + 1), TINY)
    result = D
    for m in range(1, 201):
        aa = m * (b - m) * x / ((a + 2*m - 1) * (a + 2*m))
        D = 1.0 / max(1 + aa * D, TINY)
        C = max(1 + aa / C, TINY)
        result *= C * D
        aa = -(a + m) * (a + b + m) * x / ((a + 2*m) * (a + 2*m + 1))
        D = 1.0 / max(1 + aa * D, TINY)
        C = max(1 + aa / C, TINY)
        delta = C * D
        result *= delta
        if abs(delta - 1) < EPS:
            break
    return front * result


def _log_opinion_pool(p1: float, p2: float, w1: float, w2: float) -> float:
    """Logarithmic Opinion Pool: p_lop ∝ p1^w1 × p2^w2 (log-sum-exp stable)."""
    p1 = max(1e-9, min(1 - 1e-9, p1))
    p2 = max(1e-9, min(1 - 1e-9, p2))
    lyes = w1 * math.log(p1)       + w2 * math.log(p2)
    lno  = w1 * math.log(1 - p1)   + w2 * math.log(1 - p2)
    max_l = max(lyes, lno)
    return math.exp(lyes - max_l) / (math.exp(lyes - max_l) + math.exp(lno - max_l))


def garman_klass_vol(candles: list[dict], n: int = 16) -> Optional[float]:
    """
    Garman-Klass volatility estimator.
    candles: list of {time, low, high, open, close, volume}, newest-first.
    Uses first n candles. Returns per-candle vol (not annualized).
    Formula: σ²_GK = (1/N) Σ [0.5(ln H/L)² − 0.3863(ln C/O)²]
    """
    subset = candles[:n] if len(candles) >= n else candles
    if len(subset) < 4:
        return None
    total = 0.0
    count = 0
    for c in subset:
        h, l, o, cl = c['high'], c['low'], c['open'], c['close']
        if h <= 0 or l <= 0 or o <= 0 or cl <= 0 or l > h:
            continue
        gk = 0.5 * math.log(h / l) ** 2 - 0.3863 * math.log(cl / o) ** 2
        total += gk
        count += 1
    if count < 4:
        return None
    variance = total / count
    return math.sqrt(max(variance, 0.0))


def brownian_p_yes(s0: float, strike: float, vol_per_candle: float, candles_left: float) -> Optional[float]:
    """Brownian motion P(YES): norm.cdf(log(S/K) / (σ * sqrt(T_candles)))"""
    if s0 <= 0 or strike <= 0 or vol_per_candle <= 0 or candles_left <= 0:
        return None
    d = math.log(s0 / strike) / (vol_per_candle * math.sqrt(candles_left))
    return _norm_cdf(d)


def lognormal_p_yes(s0: float, strike: float, vol_per_candle: float, candles_left: float) -> Optional[float]:
    """Black-Scholes digital option P(YES): norm.cdf(d2) — log-normal binary."""
    if s0 <= 0 or strike <= 0 or vol_per_candle <= 0 or candles_left <= 0:
        return None
    d2 = (math.log(s0 / strike) - 0.5 * vol_per_candle ** 2 * candles_left) / \
         (vol_per_candle * math.sqrt(candles_left))
    return _norm_cdf(d2)


def fat_tail_p_yes(s0: float, strike: float, vol_per_candle: float, candles_left: float, nu: float = 4.0) -> Optional[float]:
    """Fat-tail binary option P(YES) — same d2 as log-normal but Student-t(ν) CDF."""
    if s0 <= 0 or strike <= 0 or vol_per_candle <= 0 or candles_left <= 0:
        return None
    d2 = (math.log(s0 / strike) - 0.5 * vol_per_candle ** 2 * candles_left) / \
         (vol_per_candle * math.sqrt(candles_left))
    return _student_t_cdf(d2, nu)


def blend_p_model(
    p_brownian: Optional[float],
    p_lognormal: Optional[float],
    p_fat: Optional[float],
    minutes_left: float,
    p_llm: Optional[float] = None,
) -> float:
    """
    Blend quant priors (and optionally LLM) via Logarithmic Opinion Pool.
    Physics priority: fat+LN > fat only > LN only > Brownian.
    When p_llm is provided, blended using time-weighted alpha (same as live algo).
    Returns P(YES) in [0.05, 0.95].
    """
    if p_fat is not None and p_lognormal is not None:
        physics = _log_opinion_pool(p_lognormal, p_fat, 0.5, 0.5)
    elif p_fat is not None:
        physics = p_fat
    elif p_lognormal is not None:
        physics = p_lognormal
    elif p_brownian is not None:
        physics = p_brownian
    else:
        physics = None

    if physics is None and p_llm is None:
        return 0.5

    if p_llm is not None and physics is not None:
        # Time-weighted alpha: quant weight grows as expiry approaches
        alpha = min(0.85, 0.50 + (1 - minutes_left / 15) * 0.35)  # ~0.5 at mid-window
        blended = _log_opinion_pool(p_llm, physics, 1 - alpha, alpha)
        return max(0.05, min(0.95, blended))

    return max(0.05, min(0.95, physics if physics is not None else p_llm))


# ── LLM enrichment via ROMA ───────────────────────────────────────────────────

def _format_candle_lines(candles_newest_first: list[dict], n: int = 8) -> str:
    """Format last N candles as compact text for ROMA context."""
    lines = []
    for i, c in enumerate(candles_newest_first[:n]):
        mins_ago = (i + 1) * 15
        chg = c['close'] - c['open']
        chg_pct = chg / c['open'] * 100 if c['open'] > 0 else 0
        direction = '▲' if chg >= 0 else '▼'
        lines.append(
            f"  [-{mins_ago:3d}m] O:{c['open']:.0f} H:{c['high']:.0f} "
            f"L:{c['low']:.0f} C:{c['close']:.0f} {direction}{chg_pct:+.2f}%"
        )
    return '\n'.join(lines)


def _call_roma_for_window(
    ticker: str,
    entry_dt: datetime,
    current_price: float,
    floor_strike: float,
    distance_pct: float,
    gk_vol: float,
    price_momentum_1h: float,
    p_brownian: Optional[float],
    p_ln: Optional[float],
    p_fat: Optional[float],
    candles_newest: list[dict],
    provider: str,
    api_keys: dict,
    roma_mode: str = "blitz",
    model_override: Optional[str] = None,
) -> Optional[float]:
    """
    Call the local ROMA /analyze endpoint for one historical market window.
    Returns extracted P(YES) or None on failure.
    """
    import re

    above_str = "ABOVE" if distance_pct >= 0 else "BELOW"
    dist_usd  = abs(distance_pct / 100) * current_price
    candle_txt = _format_candle_lines(candles_newest, n=8)

    pb_str = f"{p_brownian:.3f}" if p_brownian is not None else "n/a"
    pl_str = f"{p_ln:.3f}"       if p_ln       is not None else "n/a"
    pf_str = f"{p_fat:.3f}"      if p_fat      is not None else "n/a"
    context = (
        f"Historical KXBTC15M window: {ticker}\n"
        f"Entry time: {entry_dt.strftime('%Y-%m-%d %H:%M UTC')}\n"
        f"BTC price: ${current_price:,.0f}\n"
        f"Strike price: ${floor_strike:,.0f}\n"
        f"Distance: {distance_pct:+.3f}% ({above_str} strike, ${dist_usd:.0f})\n"
        f"Minutes until expiry: 7.5\n"
        f"GK realized vol (per-15min candle): {gk_vol:.5f}\n"
        f"1h price momentum: {price_momentum_1h:+.2f}%\n"
        f"Quant priors: P(brownian)={pb_str} P(lognormal)={pl_str} P(fat-tail)={pf_str}\n"
        f"Last 8 × 15-min candles (newest first):\n{candle_txt}"
    )
    goal = (
        "You are analyzing a historical BTC binary options window (already expired — this is backtesting). "
        "Estimate P(BTC was ABOVE the strike at the 7.5-minute mark of this 15-minute window). "
        "Use the quant priors as your anchor. Adjust for momentum and candle structure. "
        'Output ONLY a JSON object: {"p_yes": 0.XX}'
    )

    try:
        resp = _SESSION.post(
            "http://localhost:8001/analyze",
            json={
                "goal":           goal,
                "context":        context,
                "max_depth":      1,
                "roma_mode":      roma_mode,
                "provider":       provider,
                "api_keys":       api_keys or {},
                "model_override": model_override,
            },
            timeout=55,
        )
        resp.raise_for_status()
        answer = resp.json().get("answer", "")

        # Try JSON pattern first: {"p_yes": 0.XX}
        json_match = re.search(r'"p_yes"\s*:\s*(0\.\d{2,4})', answer)
        if json_match:
            return max(0.05, min(0.95, float(json_match.group(1))))

        # Fallback: any decimal in range
        floats = re.findall(r'\b(0\.\d{2,4})\b', answer)
        if floats:
            return max(0.05, min(0.95, float(floats[-1])))

    except Exception as e:
        logger.warning(f"[BACKTEST] ROMA call failed for {ticker}: {e}")

    return None


# ── Data fetching ─────────────────────────────────────────────────────────────

def fetch_btc_candles_bulk(start_dt: datetime, end_dt: datetime) -> list[dict]:
    """
    Fetch 15-min BTC/USD candles from Coinbase Exchange in 280-candle chunks
    (~70h per request). Returns list of {time, low, high, open, close, volume}
    sorted oldest-first with duplicates removed.
    """
    granularity = 900         # 15 minutes in seconds
    chunk_secs  = 280 * granularity  # 70 hours

    all_candles: list[dict] = []
    chunk_start = start_dt.astimezone(timezone.utc)
    end_utc     = end_dt.astimezone(timezone.utc)

    while chunk_start < end_utc:
        chunk_end = min(chunk_start + timedelta(seconds=chunk_secs), end_utc)

        url = (
            f"{COINBASE_BASE}/products/BTC-USD/candles"
            f"?granularity={granularity}"
            f"&start={chunk_start.strftime('%Y-%m-%dT%H:%M:%SZ')}"
            f"&end={chunk_end.strftime('%Y-%m-%dT%H:%M:%SZ')}"
        )

        try:
            raw = _get_json(url)
            if isinstance(raw, list):
                for c in raw:
                    # Coinbase format: [time, low, high, open, close, volume]
                    all_candles.append({
                        'time':   int(c[0]),
                        'low':    float(c[1]),
                        'high':   float(c[2]),
                        'open':   float(c[3]),
                        'close':  float(c[4]),
                        'volume': float(c[5]),
                    })
        except Exception as e:
            logger.warning(f"[BACKTEST] Candle fetch failed for chunk {chunk_start}: {e}")

        chunk_start = chunk_end
        if chunk_start < end_utc:
            time.sleep(0.25)  # avoid rate-limiting

    # Deduplicate by timestamp and sort oldest-first
    seen: set[int] = set()
    unique: list[dict] = []
    for c in all_candles:
        if c['time'] not in seen:
            seen.add(c['time'])
            unique.append(c)
    unique.sort(key=lambda c: c['time'])

    logger.info(f"[BACKTEST] Fetched {len(unique)} BTC candles ({start_dt.date()} → {end_dt.date()})")
    return unique


def fetch_kalshi_settled_markets(days_back: int = 3) -> list[dict]:
    """
    Fetch settled KXBTC15M markets from the Kalshi public API using cursor pagination.
    Returns list of {ticker, floor_strike, result, close_time} within days_back.
    """
    cutoff  = datetime.now(timezone.utc) - timedelta(days=days_back)
    markets: list[dict] = []
    cursor: Optional[str] = None

    while True:
        url = (
            f"{KALSHI_BASE}/markets"
            f"?series_ticker=KXBTC15M"
            f"&status=settled"
            f"&limit=200"
        )
        if cursor:
            url += f"&cursor={cursor}"

        try:
            data = _get_json(url)
        except Exception as e:
            logger.error(f"[BACKTEST] Kalshi fetch failed: {e}")
            break

        batch = data.get('markets', [])
        if not batch:
            break

        reached_cutoff = False
        for m in batch:
            close_time_str = m.get('close_time') or m.get('expiration_time')
            if not close_time_str:
                continue
            try:
                close_dt = datetime.fromisoformat(close_time_str.replace('Z', '+00:00'))
            except ValueError:
                continue

            if close_dt < cutoff:
                reached_cutoff = True
                break

            floor_strike = m.get('floor_strike')
            result       = m.get('result')
            ticker       = m.get('ticker', '')

            # Only include settled markets with valid data
            if floor_strike is not None and result in ('yes', 'no') and ticker:
                try:
                    markets.append({
                        'ticker':       ticker,
                        'floor_strike': float(floor_strike),
                        'result':       result,
                        'close_time':   close_time_str,
                    })
                except (TypeError, ValueError):
                    continue

        if reached_cutoff:
            break

        cursor = data.get('cursor')
        if not cursor:
            break

        time.sleep(0.15)

    logger.info(f"[BACKTEST] Fetched {len(markets)} settled KXBTC15M markets ({days_back}d)")
    return markets


# ── Per-market processing ─────────────────────────────────────────────────────

def _process_market(mkt: dict, candles_oldest_first: list[dict], p_llm: Optional[float] = None) -> Optional[dict]:
    """
    Process one settled market into a TradeRecord-compatible backtest record.

    Strategy: simulate pipeline running at mid-window (entry = open + 7.5min).
    Uses last 32 complete 15-min candles before entry as context.
    p_llm: optional LLM P(YES) estimate (from ROMA); blended with quant if provided.
    """
    ticker       = mkt['ticker']
    floor_strike = mkt['floor_strike']
    result       = mkt['result']     # 'yes' | 'no'
    close_time_str = mkt['close_time']

    try:
        close_dt = datetime.fromisoformat(close_time_str.replace('Z', '+00:00'))
    except ValueError:
        return None

    open_dt  = close_dt - timedelta(minutes=15)
    entry_dt = open_dt  + timedelta(minutes=10)  # agent enters at 10 min mark (5 min left)
    entry_ts = entry_dt.timestamp()

    minutes_left = 5.0  # time remaining at simulated entry (matches live TARGET_MINUTES_BEFORE_CLOSE=10)

    # Candles complete before entry: a 15-min candle starting at T covers [T, T+900)
    # It's complete when T + 900 <= entry_ts
    context_candles = [
        c for c in candles_oldest_first
        if c['time'] + 900 <= entry_ts
    ]

    if len(context_candles) < 6:
        return None  # insufficient historical data for this window

    # Last 32 candles, newest-first (matches TypeScript OHLCVCandle order)
    last_32_oldest = context_candles[-32:]
    last_32_newest = list(reversed(last_32_oldest))

    current_price = last_32_newest[0]['close']
    if current_price <= 0:
        return None

    # GK vol from last 16 candles (4h window)
    gk_vol = garman_klass_vol(last_32_newest, n=16)
    if gk_vol is None or gk_vol <= 0:
        # Fallback: realized vol from log-returns
        closes = [c['close'] for c in last_32_newest[:16]]
        if len(closes) < 4:
            return None
        log_rets = [math.log(closes[i] / closes[i+1]) for i in range(len(closes) - 1) if closes[i+1] > 0]
        if not log_rets:
            return None
        gk_vol = math.sqrt(sum(r**2 for r in log_rets) / len(log_rets))
        if gk_vol <= 0:
            return None

    # candles_left = fraction of a 15-min candle remaining at entry
    candles_left = minutes_left / 15.0  # = 0.333 at 5 min left

    # Three independent quant estimates of P(YES)
    p_brownian = brownian_p_yes(current_price, floor_strike, gk_vol, candles_left)
    p_ln       = lognormal_p_yes(current_price, floor_strike, gk_vol, candles_left)
    p_fat      = fat_tail_p_yes(current_price, floor_strike, gk_vol, candles_left, nu=4.0)

    # ── Pure Brownian reachability model (mirrors new live probability-model.ts) ─
    # P(YES) = Φ(d) where d = log(S/K) / (σ√T)
    # Direction is LOCKED to current BTC position — never bet against where BTC sits.
    p_model = p_brownian if p_brownian is not None else (p_ln if p_ln is not None else 0.5)

    # Derived signals
    distance_pct   = (current_price - floor_strike) / floor_strike * 100.0
    above_strike   = current_price >= floor_strike

    # Direction lock: mirror pModel if it contradicts current position
    if above_strike and p_model < 0.5:
        p_model = 1.0 - p_model
    elif not above_strike and p_model > 0.5:
        p_model = 1.0 - p_model
    p_model = max(0.05, min(0.95, p_model))

    # 1h price momentum (4 × 15-min candles ago)
    price_1h_ago = last_32_newest[3]['close'] if len(last_32_newest) >= 4 else current_price
    price_momentum_1h = (current_price - price_1h_ago) / price_1h_ago * 100.0 if price_1h_ago > 0 else 0.0

    edge_abs   = abs(p_model - 0.5)
    confidence = 'high' if edge_abs >= 0.20 else 'medium' if edge_abs >= 0.10 else 'low'

    # ── Strategy simulation: only bet when |d| > CONFIDENCE_THRESHOLD ─────────
    # d = log(S/K) / (σ√T) — the Brownian reachability score
    # |d| > 1.3 → ~90% theoretical win rate; bet is "locked in"
    CONFIDENCE_THRESHOLD = 1.3
    d_score = math.log(current_price / floor_strike) / (gk_vol * math.sqrt(candles_left)) if gk_vol > 0 and candles_left > 0 else 0.0
    if abs(d_score) < CONFIDENCE_THRESHOLD:
        return None        # Not confident enough — skip this window

    # Direction is locked to current position (same as live)
    side      = 'yes' if above_strike else 'no'
    p_win     = p_model if side == 'yes' else (1.0 - p_model)
    limit_price = 50      # cents (historical book not available → assume fair 50¢)
    cost_per  = limit_price / 100.0

    # Outcome from model's perspective
    actual_result = result  # 'yes' or 'no'
    won = (side == actual_result)

    # Half-Kelly sizing (placeholder contracts=1; actual sizing done in run_backtest)
    b      = (100 - limit_price) / limit_price   # net odds = 1.0 at 50¢
    kelly  = max(0.0, (b * p_win - (1.0 - p_win)) / b)
    half_k = kelly * 0.5

    return {
        'id':              f'bt-{ticker}',
        'cycleId':         -1,
        'marketTicker':    ticker,
        'side':            side,
        'limitPrice':      limit_price,
        'contracts':       1,           # will be scaled by run_backtest Kelly sim
        'estimatedCost':   cost_per,
        'enteredAt':       entry_dt.isoformat(),
        'expiresAt':       close_dt.isoformat(),
        'strikePrice':     floor_strike,
        'btcPriceAtEntry': current_price,
        'outcome':         'WIN' if won else 'LOSS',
        'pModel':          round(p_model, 6),
        'pMarket':         0.50,
        'edge':            round(p_model - 0.50, 6),
        'halfKelly':       round(half_k, 6),
        'signals': {
            'sentimentScore':    0.0,
            'sentimentMomentum': 0.0,
            'orderbookSkew':     0.0,
            'sentimentLabel':    'neutral',
            'gkVol':             round(gk_vol, 8),
            'distancePct':       round(distance_pct, 4),
            'minutesLeft':       minutes_left,
            'aboveStrike':       above_strike,
            'priceMomentum1h':   round(price_momentum_1h, 4),
            'pLLM':              round(p_llm if p_llm is not None else p_model, 6),
            'confidence':        confidence,
        },
        'pnl':       0.0,
        'liveMode':  False,
        'isBacktest': True,
    }


def _extract_llm_inputs(mkt: dict, candles_oldest_first: list[dict]) -> Optional[dict]:
    """
    Pre-compute the quant fields needed to call ROMA, without producing the final record.
    Returns a dict with all LLM-call inputs, or None if data is insufficient.
    """
    ticker       = mkt['ticker']
    floor_strike = mkt['floor_strike']
    close_time_str = mkt['close_time']

    try:
        close_dt = datetime.fromisoformat(close_time_str.replace('Z', '+00:00'))
    except ValueError:
        return None

    open_dt  = close_dt - timedelta(minutes=15)
    entry_dt = open_dt  + timedelta(minutes=7, seconds=30)
    entry_ts = entry_dt.timestamp()

    context_candles = [c for c in candles_oldest_first if c['time'] + 900 <= entry_ts]
    if len(context_candles) < 6:
        return None

    last_32_oldest = context_candles[-32:]
    last_32_newest = list(reversed(last_32_oldest))
    current_price  = last_32_newest[0]['close']
    if current_price <= 0:
        return None

    gk_vol = garman_klass_vol(last_32_newest, n=16)
    if gk_vol is None or gk_vol <= 0:
        closes = [c['close'] for c in last_32_newest[:16]]
        if len(closes) < 4:
            return None
        log_rets = [math.log(closes[i] / closes[i+1]) for i in range(len(closes) - 1) if closes[i+1] > 0]
        if not log_rets:
            return None
        gk_vol = math.sqrt(sum(r**2 for r in log_rets) / len(log_rets))
        if gk_vol <= 0:
            return None

    candles_left      = 7.5 / 15.0
    price_1h_ago      = last_32_newest[3]['close'] if len(last_32_newest) >= 4 else current_price
    price_momentum_1h = (current_price - price_1h_ago) / price_1h_ago * 100.0 if price_1h_ago > 0 else 0.0
    distance_pct      = (current_price - floor_strike) / floor_strike * 100.0

    return {
        'ticker':           ticker,
        'entry_dt':         entry_dt,
        'current_price':    current_price,
        'floor_strike':     floor_strike,
        'distance_pct':     distance_pct,
        'gk_vol':           gk_vol,
        'price_momentum_1h': price_momentum_1h,
        'p_brownian':       brownian_p_yes(current_price, floor_strike, gk_vol, candles_left),
        'p_ln':             lognormal_p_yes(current_price, floor_strike, gk_vol, candles_left),
        'p_fat':            fat_tail_p_yes(current_price, floor_strike, gk_vol, candles_left, nu=4.0),
        'candles_newest':   last_32_newest,
    }


# ── P&L simulation helper ─────────────────────────────────────────────────────

def _build_result(records: list[dict], starting_cash: float, days: int) -> dict:
    """Simulate half-Kelly compounding on the backtest records and return summary."""
    cash = starting_cash
    for r in records:
        half_k   = r.get('halfKelly', 0.0)
        limit_p  = r['limitPrice'] / 100.0
        bet      = min(cash * half_k, cash * 0.10)  # cap at 10% of bankroll
        bet      = max(0.0, bet)
        contracts = max(1, int(bet / limit_p)) if limit_p > 0 else 1
        cost     = contracts * limit_p
        if cost > cash:
            contracts = max(1, int(cash / limit_p))
            cost = contracts * limit_p
        if r['outcome'] == 'WIN':
            pnl = contracts * (1.0 - limit_p)   # net gain per contract
        else:
            pnl = -cost
        cash = max(0.0, cash + pnl)
        r['contracts']     = contracts
        r['estimatedCost'] = round(cost, 4)
        r['pnl']           = round(pnl, 4)

    wins   = [r for r in records if r['outcome'] == 'WIN']
    losses = [r for r in records if r['outcome'] == 'LOSS']
    total_pnl = sum(r['pnl'] for r in records)

    return {
        'records': records,
        'count':   len(records),
        'days':    days,
        'provider': None,
        'summary': {
            'starting_cash':    round(starting_cash, 2),
            'final_cash':       round(cash, 2),
            'total_pnl':        round(total_pnl, 2),
            'total_return_pct': round((cash - starting_cash) / starting_cash * 100, 2) if starting_cash > 0 else 0,
            'total_trades':     len(records),
            'wins':             len(wins),
            'losses':           len(losses),
            'win_rate':         round(len(wins) / len(records), 4) if records else 0,
        },
    }


# ── Main orchestrator ─────────────────────────────────────────────────────────

def run_backtest(
    days_back: int = 3,
    provider: Optional[str] = None,
    api_keys: Optional[dict] = None,
    roma_mode: str = "blitz",
    max_llm: int = 20,
    limit: Optional[int] = None,
    model_override: Optional[str] = None,
    starting_cash: float = 100.0,
) -> dict:
    """
    Run historical backtest for the last `days_back` days.

    Steps:
      1. Fetch settled Kalshi KXBTC15M markets
      2. Fetch BTC 15-min candles covering the date range (with 8h lead buffer)
      3. For each market, replay quant math at mid-window entry
      4. Optionally enrich a subset with ROMA LLM analysis (when provider is set)
      5. Return list of TradeRecord-compatible dicts

    provider: if set (e.g. "openrouter"), call ROMA /analyze for up to max_llm markets
    api_keys: per-provider API key dict forwarded to ROMA
    roma_mode: ROMA speed mode ("blitz" recommended for batch)
    max_llm: max number of markets to enrich with LLM (default 20)
    """
    mode_str = f"LLM({provider}/{roma_mode}, max={max_llm})" if provider else "quant-only"
    logger.info(f"[BACKTEST] Starting {days_back}d backtest [{mode_str}]{f' limit={limit}' if limit else ''}")

    # 1. Settled markets
    markets = fetch_kalshi_settled_markets(days_back)
    if limit:
        markets = markets[:limit]
    if not markets:
        logger.warning("[BACKTEST] No settled markets found")
        return _build_result([], starting_cash, days_back)

    # 2. Date range for BTC candles
    close_times = []
    for m in markets:
        try:
            close_times.append(
                datetime.fromisoformat(m['close_time'].replace('Z', '+00:00'))
            )
        except ValueError:
            pass

    if not close_times:
        return []

    earliest = min(close_times) - timedelta(hours=10)  # buffer for 32-candle context
    latest   = max(close_times) + timedelta(minutes=30)

    # 3. Bulk candle fetch
    candles = fetch_btc_candles_bulk(earliest, latest)
    if len(candles) < 10:
        logger.warning(f"[BACKTEST] Only {len(candles)} candles fetched — aborting")
        return _build_result([], starting_cash, days_back)

    # 4. Quant pass — compute all records without LLM
    quant_records: list[dict] = []
    skipped = 0
    for mkt in markets:
        try:
            record = _process_market(mkt, candles)
            if record:
                quant_records.append(record)
            else:
                skipped += 1
        except Exception as e:
            logger.warning(f"[BACKTEST] Skipped {mkt.get('ticker', '?')}: {e}")
            skipped += 1

    if not provider or not quant_records:
        logger.info(
            f"[BACKTEST] Done — {len(quant_records)} records produced, "
            f"{skipped} skipped (of {len(markets)} total markets)"
        )
        return _build_result(quant_records, starting_cash, days_back)

    # 5. LLM enrichment pass — parallel ROMA calls for a sample of markets
    from concurrent.futures import ThreadPoolExecutor, as_completed

    # Take the most recent max_llm markets (most representative for calibration)
    llm_sample = markets[:max_llm]
    logger.info(f"[BACKTEST] Starting LLM enrichment for {len(llm_sample)} markets via {provider}")

    # Pre-compute LLM inputs for the sample
    llm_inputs: dict[str, dict] = {}
    for mkt in llm_sample:
        inp = _extract_llm_inputs(mkt, candles)
        if inp:
            llm_inputs[mkt['ticker']] = inp

    # Call ROMA in parallel (max 4 concurrent to avoid overloading the service)
    llm_results: dict[str, Optional[float]] = {}

    def _enrich(ticker: str, inp: dict) -> tuple[str, Optional[float]]:
        p = _call_roma_for_window(
            ticker=ticker,
            entry_dt=inp['entry_dt'],
            current_price=inp['current_price'],
            floor_strike=inp['floor_strike'],
            distance_pct=inp['distance_pct'],
            gk_vol=inp['gk_vol'],
            price_momentum_1h=inp['price_momentum_1h'],
            p_brownian=inp['p_brownian'],
            p_ln=inp['p_ln'],
            p_fat=inp['p_fat'],
            candles_newest=inp['candles_newest'],
            provider=provider,
            api_keys=api_keys or {},
            roma_mode=roma_mode,
            model_override=model_override,
        )
        return ticker, p

    with ThreadPoolExecutor(max_workers=4) as ex:
        futures = {ex.submit(_enrich, t, inp): t for t, inp in llm_inputs.items()}
        for fut in as_completed(futures):
            try:
                ticker, p = fut.result()
                llm_results[ticker] = p
                status = f"{p:.3f}" if p is not None else "failed"
                logger.info(f"[BACKTEST] LLM {ticker}: p_yes={status}")
            except Exception as e:
                logger.warning(f"[BACKTEST] LLM future failed: {e}")

    # Rebuild records for the LLM-enriched sample; keep quant-only for the rest
    llm_tickers = set(llm_inputs.keys())
    final_records: list[dict] = []

    # Quant-only records (not in LLM sample)
    for r in quant_records:
        if r['marketTicker'] not in llm_tickers:
            final_records.append(r)

    # LLM-enriched records (reprocess with p_llm)
    llm_enriched = 0
    for mkt in llm_sample:
        ticker = mkt['ticker']
        p_llm  = llm_results.get(ticker)
        try:
            record = _process_market(mkt, candles, p_llm=p_llm)
            if record:
                final_records.append(record)
                if p_llm is not None:
                    llm_enriched += 1
        except Exception as e:
            logger.warning(f"[BACKTEST] LLM reprocess failed {ticker}: {e}")

    logger.info(
        f"[BACKTEST] Done — {len(final_records)} total records "
        f"({llm_enriched} LLM-enriched, {len(final_records) - llm_enriched} quant-only), "
        f"{skipped} skipped"
    )
    return _build_result(final_records, starting_cash, days_back)
