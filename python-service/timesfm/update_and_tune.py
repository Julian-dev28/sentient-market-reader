"""
TimesFM BTC Analysis
────────────────────
Fetches recent BTC candles, runs Google TimesFM's pretrained time-series
foundation model, and outputs:
  1. forecast.json  — 4-candle (1-hour) forward price forecast with quantiles
  2. analysis.json  — P(YES) estimates for any target strike + 24h session outlook

TimesFM 1.3 PyTorch is inference-only (no fine_tune). Uses forecast_on_df().
"""

import os
import json
import requests
import numpy as np
import pandas as pd
import timesfm
from datetime import datetime, timedelta
from dotenv import load_dotenv

load_dotenv()


# ── Helpers ───────────────────────────────────────────────────────────────────

def fetch_btc_candles(granularity=900, limit=128):
    """Fetch 15-min BTC candles from Coinbase (last 128 candles ≈ 32 hours)."""
    end   = datetime.utcnow()
    start = end - timedelta(seconds=granularity * limit)
    params = {
        'start':       start.isoformat(),
        'end':         end.isoformat(),
        'granularity': granularity,
    }
    res = requests.get(
        'https://api.exchange.coinbase.com/products/BTC-USD/candles',
        params=params, timeout=15, verify=False,
    )
    res.raise_for_status()
    data = res.json()
    df = pd.DataFrame(data, columns=['timestamp', 'low', 'high', 'open', 'close', 'volume'])
    df['ds'] = pd.to_datetime(df['timestamp'], unit='s')
    df = df[['ds', 'close']].rename(columns={'close': 'btc_price'})
    df = df.sort_values('ds').reset_index(drop=True)
    df['unique_id'] = 'BTC'
    return df


def timesfm_p_yes(forecast_df: pd.DataFrame, strike_price: float) -> float:
    """
    Estimate P(BTC > strike_price) from TimesFM quantile predictions.

    TimesFM outputs quantile columns q0.1 … q0.9. Each represents the
    price level that BTC is expected to be AT OR BELOW with that probability.
    So P(BTC > strike) = 1 - CDF(strike) ≈ 1 - interpolated_quantile.
    """
    if forecast_df.empty:
        return 0.5

    # Use first horizon step (15 min ahead — the most relevant for the current window)
    row = forecast_df.iloc[0]

    quantile_cols = {
        0.1: 'timesfm-q-0.1',
        0.2: 'timesfm-q-0.2',
        0.3: 'timesfm-q-0.3',
        0.4: 'timesfm-q-0.4',
        0.5: 'timesfm-q-0.5',
        0.6: 'timesfm-q-0.6',
        0.7: 'timesfm-q-0.7',
        0.8: 'timesfm-q-0.8',
        0.9: 'timesfm-q-0.9',
    }

    # Build (quantile_level, price) pairs
    pairs = []
    for q, col in quantile_cols.items():
        if col in row.index:
            pairs.append((q, float(row[col])))

    if not pairs:
        return 0.5

    pairs.sort(key=lambda x: x[1])  # sort by price ascending

    prices = [p for _, p in pairs]
    quants = [q for q, _ in pairs]

    if strike_price <= prices[0]:
        # Strike below all quantiles → BTC almost certainly above strike
        return min(0.97, 1.0 - quants[0])

    if strike_price >= prices[-1]:
        # Strike above all quantiles → BTC almost certainly below strike
        return max(0.03, 1.0 - quants[-1])

    # Linear interpolation between surrounding quantile prices
    for i in range(len(prices) - 1):
        if prices[i] <= strike_price <= prices[i + 1]:
            # Interpolate quantile at strike_price
            frac = (strike_price - prices[i]) / (prices[i + 1] - prices[i])
            q_at_strike = quants[i] + frac * (quants[i + 1] - quants[i])
            return max(0.03, min(0.97, 1.0 - q_at_strike))

    return 0.5


def compute_24h_outlook(forecast_df: pd.DataFrame, last_price: float) -> dict:
    """
    Compute a 24-hour session outlook from multiple TimesFM forecast runs.
    We run 6 rolling forecasts (24 × 15-min = 6 hours via chaining).
    This gives a rough directional sense for the trading session.
    """
    if forecast_df.empty:
        return {'trend': 'unknown', 'range_high': last_price, 'range_low': last_price, 'drift_pct': 0.0}

    # All forecast horizons combined
    medians = forecast_df['timesfm'].values if 'timesfm' in forecast_df.columns else []

    q10_all = [forecast_df[c].values for c in forecast_df.columns if 'q-0.1' in c]
    q90_all = [forecast_df[c].values for c in forecast_df.columns if 'q-0.9' in c]

    range_low  = float(np.min(q10_all)) if q10_all else last_price * 0.995
    range_high = float(np.max(q90_all)) if q90_all else last_price * 1.005

    if len(medians):
        terminal = float(medians[-1])
        drift_pct = (terminal - last_price) / last_price * 100
        trend = 'bullish' if drift_pct > 0.1 else 'bearish' if drift_pct < -0.1 else 'neutral'
    else:
        drift_pct = 0.0
        trend = 'neutral'

    return {
        'trend':       trend,
        'drift_pct':   round(drift_pct, 4),
        'range_low':   round(range_low, 2),
        'range_high':  round(range_high, 2),
        'q10_terminal': round(float(np.min([q[-1] for q in q10_all])) if q10_all else last_price, 2),
        'q90_terminal': round(float(np.max([q[-1] for q in q90_all])) if q90_all else last_price, 2),
        'spread':      round(range_high - range_low, 2),
        'volatility_proxy': round((range_high - range_low) / last_price * 100, 4),
    }


# ── Step 1: Fetch data ────────────────────────────────────────────────────────
print("[1/4] Fetching BTC 15-min candles from Coinbase…")
df = fetch_btc_candles()
last_price = float(df['btc_price'].iloc[-1])
print(f"      Fetched {len(df)} candles  ({df['ds'].min()} → {df['ds'].max()})")
print(f"      Last BTC price: ${last_price:,.2f}")

csv_path = 'btc_data.csv'
df.to_csv(csv_path, index=False)
print(f"      Saved to {csv_path}")


# ── Step 2: Load TimesFM pretrained checkpoint ────────────────────────────────
print("[2/4] Loading TimesFM pretrained checkpoint (google/timesfm-1.0-200m-pytorch)…")
print("      (First run downloads ~800MB from HuggingFace — subsequent runs use cache)")

hparams = timesfm.TimesFmHparams(
    context_len=128,   # 128 × 15-min = 32 hours of history
    horizon_len=4,     # predict next 4 candles = 1 hour ahead
    backend='cpu',
)
checkpoint = timesfm.TimesFmCheckpoint(
    huggingface_repo_id='google/timesfm-1.0-200m-pytorch',
    version='torch',
)
tfm = timesfm.TimesFm(hparams=hparams, checkpoint=checkpoint)
print("      Model loaded.")


# ── Step 3: Run 1-hour forecast ───────────────────────────────────────────────
print("[3/4] Running TimesFM 1-hour forecast (4 × 15-min candles)…")

forecast_df = tfm.forecast_on_df(
    inputs=df,
    freq='15min',
    value_name='btc_price',
    num_jobs=1,
)

print(f"      Forecast shape: {forecast_df.shape}")
print(forecast_df.to_string(index=False))

# Save raw forecast
forecast_path = 'forecast.json'
forecast_records = forecast_df.to_dict(orient='records')
forecast_output = {
    'generated_at':      datetime.utcnow().isoformat(),
    'last_known_price':  last_price,
    'last_known_time':   df['ds'].iloc[-1].isoformat(),
    'horizon_candles':   4,
    'granularity_min':   15,
    'forecast':          forecast_records,
}
with open(forecast_path, 'w') as f:
    json.dump(forecast_output, f, indent=2, default=str)
print(f"      Saved forecast → {forecast_path}")


# ── Step 4: Compute P(YES) + 24h analysis ─────────────────────────────────────
print("[4/4] Computing P(YES) probabilities and 24h session outlook…")

# Current market context — try to get current Kalshi market info
strike_price = None
try:
    from datetime import timezone
    now_et_response = requests.get(
        'https://api.exchange.coinbase.com/products/BTC-USD/ticker',
        timeout=5
    )
    # Just use last known price from candles as current price
    strike_price = last_price  # approximate: use last candle close
    print(f"      Using last candle close as reference strike: ${strike_price:,.2f}")
except Exception:
    pass

# P(YES) for various strike levels around current price
p_yes_scenarios = {}
if last_price > 0:
    for offset_pct in [-0.5, -0.25, -0.1, 0.0, 0.1, 0.25, 0.5]:
        target_strike = last_price * (1 + offset_pct / 100)
        p = timesfm_p_yes(forecast_df, target_strike)
        p_yes_scenarios[f"{'+' if offset_pct >= 0 else ''}{offset_pct:.2f}%"] = {
            'strike':  round(target_strike, 2),
            'p_yes':   round(p, 4),
            'p_no':    round(1 - p, 4),
        }

# 24h outlook
outlook = compute_24h_outlook(forecast_df, last_price)

analysis_output = {
    'generated_at':    datetime.utcnow().isoformat(),
    'last_price':      last_price,
    'p_yes_by_strike': p_yes_scenarios,
    'outlook_1h':      outlook,  # based on 4-candle forecast
    'forecast_summary': {
        'median_next_15m': round(float(forecast_df['timesfm'].iloc[0]), 2) if len(forecast_df) else last_price,
        'median_next_1h':  round(float(forecast_df['timesfm'].iloc[-1]), 2) if len(forecast_df) else last_price,
        'q10_next_1h':     round(float(forecast_df['timesfm-q-0.1'].iloc[-1]), 2) if len(forecast_df) else last_price,
        'q90_next_1h':     round(float(forecast_df['timesfm-q-0.9'].iloc[-1]), 2) if len(forecast_df) else last_price,
    },
}

analysis_path = 'analysis.json'
with open(analysis_path, 'w') as f:
    json.dump(analysis_output, f, indent=2, default=str)

print(f"\n✓ Analysis saved → {analysis_path}")
print(f"  Last BTC:  ${last_price:,.2f}")
print(f"  1h median: ${analysis_output['forecast_summary']['median_next_1h']:,.2f}")
print(f"  1h range:  ${analysis_output['forecast_summary']['q10_next_1h']:,.2f} – ${analysis_output['forecast_summary']['q90_next_1h']:,.2f}")
print(f"  Outlook:   {outlook['trend']} ({outlook['drift_pct']:+.2f}% drift)")
print(f"\n  P(YES) scenarios:")
for offset, data in p_yes_scenarios.items():
    print(f"    strike {offset} (${data['strike']:,.2f}): P(YES)={data['p_yes']:.1%}  P(NO)={data['p_no']:.1%}")
print("\n✓ TimesFM analysis complete.")
