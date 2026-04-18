# Kalshi API

## Overview

Kalshi is a regulated prediction market exchange. KXBTC15M markets are 15-minute BTC binary options: "Will BTC be above strike price X at the end of this 15-minute window?"

Base URL: `https://api.elections.kalshi.com/trade-api/v2`

## Authentication

All portfolio/trading endpoints require RSA-PSS authentication. Market data endpoints are public (no auth needed).

### Signature Construction

```
payload = timestamp_ms + METHOD + path
```

- `timestamp_ms`: `Date.now()` as string (milliseconds, not seconds)
- `METHOD`: uppercase HTTP verb (`GET`, `POST`, `DELETE`)
- `path`: URL path only, **no query string** (e.g., `/trade-api/v2/markets`)
- Concatenated directly — **no separators, no newlines**

### RSA-PSS Parameters

```typescript
// lib/kalshi-auth.ts
const sign = createSign('RSA-SHA256')
sign.update(payload)
const signature = sign.sign({
  key: privateKey,
  padding: constants.RSA_PKCS1_PSS_PADDING,
  saltLength: constants.RSA_PSS_SALTLEN_DIGEST,  // salt length = digest length (SHA-256 = 32)
}, 'base64')
```

### Required Headers

```
KALSHI-ACCESS-KEY:       <your-api-key-uuid>
KALSHI-ACCESS-TIMESTAMP: <unix-ms-as-string>
KALSHI-ACCESS-SIGNATURE: <base64-rsa-pss-signature>
Content-Type:            application/json
```

### Python Implementation

```python
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding as _pad
import base64, time

def kalshi_headers(method: str, path: str, api_key: str, pem_path: str) -> dict:
    pk = serialization.load_pem_private_key(
        open(pem_path, 'rb').read(), password=None
    )
    ts = str(int(time.time() * 1000))
    sig = pk.sign(
        (ts + method.upper() + path).encode(),
        _pad.PSS(mgf=_pad.MGF1(hashes.SHA256()), salt_length=_pad.PSS.DIGEST_LENGTH),
        hashes.SHA256(),
    )
    return {
        'KALSHI-ACCESS-KEY':       api_key,
        'KALSHI-ACCESS-TIMESTAMP': ts,
        'KALSHI-ACCESS-SIGNATURE': base64.b64encode(sig).decode(),
        'Content-Type':            'application/json',
    }
```

### Common Mistakes

- Using `time.time()` (seconds) instead of `time.time() * 1000` (milliseconds) → 401
- Including query params in the signed path → 401
- Using PKCS#1 v1.5 padding instead of PSS → 401
- Adding separators between payload parts → 401

## Market Discovery

### Ticker Format

```
KXBTC15M-{YY}{MON}{DD}{HHMM}-{NN}

Examples:
  KXBTC15M-26APR181415-15    window closing 2:15 PM ET on Apr 18, 2026
  KXBTC15M-26APR181430-30    window closing 2:30 PM ET

Event ticker (without -NN): KXBTC15M-26APR181415
```

- The datetime in the ticker is the **window close time in US Eastern Time (ET)**
- `{NN}` is a strike suffix (the strike number, e.g., 15 = strike at $76k, 30 = another strike)

### Computing the Current Event Ticker

```python
from datetime import datetime, timezone, timedelta

def current_event_ticker() -> str:
    months = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"]
    now = datetime.now(timezone.utc)

    # DST-aware ET offset
    year = now.year
    mar_dst = datetime(year, 3, 8, 2, tzinfo=timezone.utc)
    mar_dst += timedelta(days=(6 - mar_dst.weekday()) % 7)
    nov_dst = datetime(year, 11, 1, 2, tzinfo=timezone.utc)
    nov_dst += timedelta(days=(6 - nov_dst.weekday()) % 7)
    off = -4 if mar_dst <= now < nov_dst else -5

    et = (now + timedelta(hours=off)).replace(second=0, microsecond=0)
    nxt = (et.minute // 15 + 1) * 15
    if nxt >= 60:
        et = et.replace(minute=0) + timedelta(hours=1)
    else:
        et = et.replace(minute=nxt)

    return f"KXBTC15M-{et.strftime('%y')}{months[et.month-1]}{et.strftime('%d%H%M')}"
```

### Fetching the Active Market

```python
import httpx

async def get_active_market() -> dict | None:
    event = current_event_ticker()
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.get(
            'https://api.elections.kalshi.com/trade-api/v2/markets',
            params={'event_ticker': event, 'status': 'open'},
        )
        markets = r.json().get('markets', [])
        if markets:
            return normalize_market(markets[0])

    # Fallback: list all open KXBTC15M markets
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.get(
            'https://api.elections.kalshi.com/trade-api/v2/markets',
            params={'series_ticker': 'KXBTC15M', 'status': 'open', 'limit': 10},
        )
        markets = r.json().get('markets', [])
        tradeable = [m for m in markets if (normalize_market(m).get('yes_ask') or 0) > 0]
        return normalize_market(tradeable[0]) if tradeable else (normalize_market(markets[0]) if markets else None)
```

### Normalizing Market Prices

**CRITICAL**: The Kalshi API v2 returns prices as `yes_ask_dollars` (string USD like `"0.7200"`). The integer `yes_ask` field is `null`. Always normalize before use:

```python
def normalize_market(m: dict) -> dict:
    for field, dollar_field in [
        ('yes_ask', 'yes_ask_dollars'), ('yes_bid', 'yes_bid_dollars'),
        ('no_ask',  'no_ask_dollars'),  ('no_bid',  'no_bid_dollars'),
    ]:
        if not m.get(field) and m.get(dollar_field):
            try:
                m[field] = round(float(m[dollar_field]) * 100)
            except (ValueError, TypeError):
                pass
    return m
```

### Key Market Fields

```python
market = {
    'ticker':          'KXBTC15M-26APR181415-15',
    'event_ticker':    'KXBTC15M-26APR181415',
    'floor_strike':    76070.49,          # BTC strike price (float)
    'yes_sub_title':   'Target Price: $76,070.49',
    'close_time':      '2026-04-18T12:15:00Z',  # USE THIS for countdown
    'expiration_time': '2026-04-25T12:15:00Z',  # IGNORE — far future
    'status':          'active',          # 'active' when open (not 'open')
    'yes_ask':         72,                # after normalization (integer cents)
    'no_ask':          30,
    'yes_bid':         70,
    'no_bid':          28,
}
```

## Placing Orders

```python
body = {
    'order': {
        'ticker': 'KXBTC15M-26APR181415-15',
        'action': 'buy',
        'side':   'yes',        # or 'no'
        'type':   'limit',
        'count':  5,            # contracts (integer)
        'yes_price': 72,        # cents (integer, 1–99)
        'no_price':  28,        # must satisfy yes_price + no_price = 100
    }
}
r = await client.post('/portfolio/orders', json=body,
                      headers=kalshi_headers('POST', '/trade-api/v2/portfolio/orders', ...))
order = r.json().get('order', {})
order_id = order.get('order_id')
```

## Balance and Positions

```python
# Balance
bal = (await kget('/portfolio/balance')).get('balance', {})
available = bal.get('available_balance_cents', 0) / 100  # convert to USD

# Open positions
pos = await kget('/portfolio/positions', {'settlement_status': 'unsettled'})
for p in pos.get('market_positions', []):
    if p['position'] != 0:
        print(p['ticker'], p['position'], 'contracts')

# Resting orders
orders = await kget('/portfolio/orders', {'status': 'resting'})
```

## Cancel Order

```python
# DELETE /portfolio/orders/{order_id}
path = f'/trade-api/v2/portfolio/orders/{order_id}'
r = await client.delete(f'https://api.elections.kalshi.com{path}',
                        headers=kalshi_headers('DELETE', path, ...))
```

## Rate Limits and Errors

- Auth errors return `401` — check timestamp is milliseconds, path has no query string
- `400 File already exists` on PyPI upload means bump version first
- Markets with `yes_ask=null` (pre-normalization) are still valid and open — don't skip them
- The `status` query param `"open"` returns markets with `status: "active"` in the response body — this is normal
