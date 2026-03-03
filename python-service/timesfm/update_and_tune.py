"""
TimesFM BTC Forecast
────────────────────
Fetches recent BTC candles, runs Google TimesFM's pre-trained time-series
foundation model, and saves a short-horizon forecast to forecast.json.
The ROMA pipeline can read this file as an additional signal.

TimesFM 1.3 PyTorch does NOT support fine_tune() — it's inference-only.
We use forecast_on_df() with the pretrained checkpoint from HuggingFace.
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


def fetch_btc_candles(granularity=900, limit=128):
    """Fetch 15-min BTC candles from Coinbase (last 128 candles = ~32 hours)."""
    end = datetime.utcnow()
    start = end - timedelta(seconds=granularity * limit)
    params = {
        'start': start.isoformat(),
        'end': end.isoformat(),
        'granularity': granularity,
    }
    res = requests.get(
        'https://api.exchange.coinbase.com/products/BTC-USD/candles',
        params=params,
        timeout=15,
    )
    res.raise_for_status()
    data = res.json()
    df = pd.DataFrame(data, columns=['timestamp', 'low', 'high', 'open', 'close', 'volume'])
    df['date'] = pd.to_datetime(df['timestamp'], unit='s')
    df = df[['date', 'close']].rename(columns={'date': 'ds', 'close': 'btc_price'})
    df = df.sort_values('ds').reset_index(drop=True)
    df['unique_id'] = 'BTC'   # TimesFM requires a series ID column
    return df


# ── Step 1: Fetch data ────────────────────────────────────────────────────────
print("[1/3] Fetching BTC 15-min candles from Coinbase…")
df = fetch_btc_candles()
print(f"      Fetched {len(df)} candles  ({df['ds'].min()} → {df['ds'].max()})")

csv_path = 'btc_data.csv'
df.to_csv(csv_path, index=False)
print(f"      Saved to {csv_path}")

# ── Step 2: Load TimesFM pretrained checkpoint ────────────────────────────────
print("[2/3] Loading TimesFM pretrained checkpoint (google/timesfm-1.0-200m-pytorch)…")
print("      (First run downloads ~800MB from HuggingFace — subsequent runs use cache)")

hparams = timesfm.TimesFmHparams(
    context_len=128,    # number of historical candles to feed as context
    horizon_len=4,      # predict next 4 candles (1 hour)
    backend='cpu',
)
checkpoint = timesfm.TimesFmCheckpoint(
    huggingface_repo_id='google/timesfm-1.0-200m-pytorch',
    version='torch',
)
tfm = timesfm.TimesFm(hparams=hparams, checkpoint=checkpoint)
print("      Model loaded.")

# ── Step 3: Run forecast ──────────────────────────────────────────────────────
print("[3/3] Running TimesFM forecast on BTC data…")

forecast_df = tfm.forecast_on_df(
    inputs=df,
    freq='15min',
    value_name='btc_price',
    num_jobs=1,
)

print(f"      Forecast output shape: {forecast_df.shape}")
print(forecast_df.head(10).to_string(index=False))

# ── Save forecast to JSON for ROMA pipeline ───────────────────────────────────
forecast_path = 'forecast.json'
forecast_records = forecast_df.to_dict(orient='records')

# Attach metadata
output = {
    'generated_at': datetime.utcnow().isoformat(),
    'last_known_price': float(df['btc_price'].iloc[-1]),
    'last_known_time': df['ds'].iloc[-1].isoformat(),
    'horizon_candles': 4,
    'granularity_min': 15,
    'forecast': forecast_records,
}
with open(forecast_path, 'w') as f:
    json.dump(output, f, indent=2, default=str)

print(f"\n✓ Forecast saved to {os.path.abspath(forecast_path)}")
print(f"  Last known BTC: ${output['last_known_price']:,.2f}")
if forecast_records:
    cols = [c for c in forecast_df.columns if 'quantile' in c.lower() or 'mean' in c.lower() or 'point' in c.lower()]
    print(f"  Forecast columns: {list(forecast_df.columns)}")

print("\nFine-tuning complete!")
