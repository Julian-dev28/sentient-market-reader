# Markov Chain Signal Engine

## Overview

The signal engine predicts whether BTC will be above a given strike price at the end of a 15-minute window. It uses a 9-state Markov chain built from 5-minute BTC price changes.

**Key insight**: States represent momentum (5-min % change), not distance from strike. Momentum persists — the model captures whether BTC is trending, not just where it is.

## State Space

9 states based on 5-minute price change bins:

```
State 0: < −1.5%       (strong down)
State 1: −1.5 to −1%
State 2: −1 to −0.5%
State 3: −0.5 to −0.2%
State 4: ±0.2%         (flat)
State 5: 0.2 to 0.5%
State 6: 0.5 to 1%
State 7: 1 to 1.5%
State 8: > 1.5%        (strong up)
```

Boundaries (Python/TypeScript both use these exact values):
```python
BOUNDS = [-3.35, -2.24, -1.12, -0.45, 0.45, 1.12, 2.24, 3.35]
```

Note: these are %-change bounds, not annualized. State 0 starts at < −3.35% per 5-min.

## State Metadata

Each state has a representative return and within-state volatility (% per 5-min candle):

```python
STATE_RETURNS = [-2.0, -1.25, -0.75, -0.35, 0.0,  0.35, 0.75, 1.25,  2.0]
STATE_VOL     = [ 1.0,  0.35,  0.25,  0.15, 0.10, 0.15, 0.25,  0.35,  1.0]
```

## Building the Transition Matrix

From a sequence of historical states, build an empirical 9×9 transition probability matrix:

```python
def build_transition_matrix(states: list[int]) -> list[list[float]]:
    counts = [[0.0] * 9 for _ in range(9)]
    for i in range(len(states) - 1):
        counts[states[i]][states[i+1]] += 1.0
    return [
        [v / sum(row) for v in row] if sum(row) > 0 else [1/9] * 9
        for row in counts
    ]
```

Uses the last 480 candles (40 hours) as the rolling window.

## Chapman-Kolmogorov Propagation

To predict T steps ahead, propagate the state probability distribution forward:

```python
def predict(P: list, current_state: int, minutes_left: float, dist_pct: float) -> dict:
    T = max(1, round(minutes_left / 5))  # number of 5-min steps
    req = -dist_pct  # required cumulative drift: negative if above strike (can drop), positive if below

    dist = [0.0] * 9
    dist[current_state] = 1.0  # start certain of current state

    exp_drift = 0.0
    var_sum   = 0.0

    for _ in range(T):
        # Expected return and variance of this step
        sm = sum(dist[i] * STATE_RETURNS[i] for i in range(9))
        se = sum(dist[i] * (STATE_VOL[i]**2 + STATE_RETURNS[i]**2) for i in range(9))
        exp_drift += sm
        var_sum   += max(0.0, se - sm**2)

        # Propagate: dist = dist @ P
        nxt = [sum(dist[i] * P[i][j] for i in range(9)) for j in range(9)]
        dist = nxt

    sigma = math.sqrt(max(var_sum, 0.01))
    p_yes = norm_cdf((exp_drift - req) / sigma)
    return {'p_yes': p_yes, 'persist': P[current_state][current_state], 'exp_drift': exp_drift}
```

`dist_pct` is `(btc_price - strike) / strike * 100`. If BTC is 2% above strike, `req = -2%` — price can drop up to 2% and still win YES.

## Gate Stack

All gates must pass for a trade to be approved:

### 1. Markov Gap Gate
```python
gap = abs(p_yes - 0.5)
gap >= 0.11  # model must be ≥61% confident (or ≤39% for NO)
```

### 2. Persistence Gate
```python
persist = P[current_state][current_state]  # self-transition probability
persist >= 0.82  # momentum state must be self-reinforcing
```

### 3. Volatility Gate (Garman-Klass)
```python
# GK volatility from last 16 completed 15-min candles
gk = sqrt(mean(0.5*log(hi/lo)^2 - (2*log2 - 1)*log(cl/op)^2))
gk <= REF_VOL_15M * MAX_VOL_MULT  # REF_VOL_15M=0.002, MAX_VOL_MULT=1.25
```
Skip chaotic windows where volatility is elevated. `None` passes (insufficient data).

### 4. Hurst Exponent Gate
```python
# Estimate Hurst from log-returns variance ratio
hurst >= 0.50  # H > 0.5 = trending (persistent), H < 0.5 = mean-reverting
```
`None` passes. Mean-reverting regimes (H < 0.5) trend against the Markov signal.

### 5. Timing Gate
```python
is_golden = 65 <= yes_ask <= 73  # golden zone: high WR, still valuable

if is_golden:
    time_ok = 3 <= minutes_left <= 12   # wider window for high-confidence entries
else:
    time_ok = 6 <= minutes_left <= 9    # standard window
```

### 6. Price Cap Gate
```python
limit_price = yes_ask if p_yes > 0.5 else no_ask
price_ok = limit_price <= 72  # above 72¢ market is efficiently priced
```

### 7. UTC Hour Blocker
```python
BLOCKED_HOURS = {11, 18}  # empirically -40pp to -57pp edge margin
utc_hour = datetime.utcnow().hour
not_blocked = utc_hour not in BLOCKED_HOURS
```

### 8. Noise Gate (d-score based)
```python
dist_pct = (btc_price - strike) / strike * 100
abs(dist_pct) >= 0.02  # reject when BTC is essentially at the strike (coin-flip noise)
```

## Kelly Sizing (Tiered)

```python
def kelly_size(p_win: float, price_cents: int, bankroll: float) -> int:
    p_d     = price_cents / 100
    fee     = 0.0175 * p_d * (1 - p_d)     # Kalshi maker fee (1.75% × p × (1-p))
    net_win = (1 - p_d) - fee               # profit per contract if win
    cost    = p_d + fee                     # cost per contract (including fee)
    b       = net_win / cost                # win/loss ratio

    # Full Kelly fraction
    kf = max(0.0, (b * p_win - (1 - p_win)) / b)

    # Tiered Kelly multiplier by price zone
    if   65 <= price_cents <= 73: frac = 0.35
    elif price_cents <= 79:       frac = 0.12
    elif price_cents <= 85:       frac = 0.08
    else:                         frac = 0.05

    risk_pct  = min(0.20, frac * kf)       # cap at 20% of bankroll per trade
    dyn_cap   = max(25, round(bankroll / 200 * 25))  # dynamic contract cap scales with bankroll
    contracts = min(max(1, round(bankroll * risk_pct / cost)), dyn_cap)
    return contracts
```

## Candle Source

Uses **Coinbase Exchange API** (same feed Kalshi settles against):

```
GET https://api.exchange.coinbase.com/products/BTC-USD/candles
  ?granularity=300    # 5-min candles
  &start=<unix>
  &end=<unix>

Response: [[time, low, high, open, close, volume], ...]
Sorted descending by time. Re-sort ascending for processing.
```

Fetch 2 days of data per run. The API returns max 300 candles per request — paginate with 300×granularity chunks.

## History Construction

```python
def build_markov_history(candles_5m: list, up_to_ts: float) -> list[int]:
    # Only use candles that are fully closed before check time
    relevant = [c for c in candles_5m if c[0] + 300 <= up_to_ts]
    states = []
    for i in range(1, len(relevant)):
        prev, curr = relevant[i-1][4], relevant[i][4]
        if prev > 0:
            pct = (curr - prev) / prev * 100.0
            states.append(price_change_to_state(pct))
    return states[-480:]  # last 480 states (40 hours)
```

Minimum 20 states required before the model is considered valid (`has_history` gate).

## Current State Detection

```python
check_ts = time.time()
c5_ts    = int(check_ts // 300) * 300 - 300  # most recently closed 5-min bar

c5_bar  = candles_by_ts.get(c5_ts) or candles_by_ts.get(c5_ts - 300)
c5_prev = candles_by_ts.get(c5_ts - 300)

if c5_bar and c5_prev and c5_prev[4] > 0:
    pct = (c5_bar[4] - c5_prev[4]) / c5_prev[4] * 100.0
    current_state = price_change_to_state(pct)
else:
    current_state = 4  # default: flat
```

## Hurst Exponent Computation

```python
def compute_hurst(candles: list) -> float | None:
    closes = [c[4] for c in reversed(candles)]
    if len(closes) < 12: return None
    lr = [math.log(closes[i]/closes[i-1]) for i in range(1, len(closes)) if closes[i-1] > 0]
    if len(lr) < 6: return None

    # Variance ratio method
    v1 = sum(r*r for r in lr) / len(lr)                  # variance of 1-step returns
    pairs = [lr[i] + lr[i+1] for i in range(0, len(lr)-1, 2)]
    v2 = sum(r*r for r in pairs) / max(len(pairs), 1)    # variance of 2-step returns

    if v1 <= 0: return None
    return max(0.0, min(1.0, 0.5 + math.log(max(v2/(2*v1), 1e-12)) / (2*math.log(2))))
```

## TypeScript vs Python Parity

Both implementations use identical:
- State bounds: `[-3.35, -2.24, -1.12, -0.45, 0.45, 1.12, 2.24, 3.35]`
- STATE_RETURNS: `[-2.0, -1.25, -0.75, -0.35, 0.0, 0.35, 0.75, 1.25, 2.0]`
- STATE_VOL: `[1.0, 0.35, 0.25, 0.15, 0.10, 0.15, 0.25, 0.35, 1.0]`
- Gate thresholds: gap ≥ 0.11, persist ≥ 0.82
- Kelly tiers: 35/12/8/5%

TypeScript lives in `lib/markov/chain.ts` + `lib/markov/history.ts`.  
Python lives in `python-service/run_backtest.py` and `sentient-trader-mcp/sentient_trader_mcp/server.py`.
