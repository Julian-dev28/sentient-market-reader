# Live Trading Setup

## Prerequisites

1. **Kalshi account** with API access enabled
2. **RSA key pair** generated in Kalshi → Settings → API
3. **Node.js 20+** and **Python 3.10+**
4. **Python venv** at `~/.sentient-venv313` with dependencies

## Step 1: Kalshi API Keys

1. Go to [kalshi.com](https://kalshi.com) → Settings → API
2. Create an API key → download the RSA private key `.pem` file
3. Save the private key: `cp ~/Downloads/kalshi_key.pem ./kalshi_private.pem`

The private key file is `.gitignore`d via `*.pem` pattern — it will never be committed.

## Step 2: Environment Variables

Create `.env.local` in the project root:

```env
# Kalshi
KALSHI_API_KEY=<
KALSHI_PRIVATE_KEY_PATH=..pem

# LLM (required for AI mode)
ANTHROPIC_API_KEY=sk-ant-...
XAI_API_KEY=xai-...

# ROMA depth (keep at 1 for live trading)
ROMA_MAX_DEPTH=1
```

## Step 3: Python Environment

The venv is at `~/.sentient-venv313` (outside the project dir — inside causes Turbopack symlink panics):

```bash
# If venv doesn't exist:
python3 -m venv ~/.sentient-venv313

source ~/.sentient-venv313/bin/activate
pip install httpx mcp cryptography anthropic uvicorn fastapi

# Verify
python3 -c "import httpx, mcp, cryptography; print('OK')"
```

**Critical**: `python3 main.py` does NOTHING — there is no `__main__` block. Always use:
```bash
python3 -m uvicorn main:app --port 8001 --host 0.0.0.0
```

## Step 4: Run the App

```bash
# Terminal 1: Next.js
npm run dev

# Terminal 2: Python service (only needed for AI mode / backtest)
cd python-service
source ~/.sentient-venv313/bin/activate
python3 -m uvicorn main:app --port 8001 --host 0.0.0.0
```

App: `http://localhost:3000/dashboard`

## Step 5: Verify Auth Works

In the dashboard, click "Get Balance" or run the pipeline once in Quant mode. If auth is correct you'll see your balance. If you see a 401 error:

- Check `KALSHI_API_KEY` is the UUID (not the key name)
- Check `KALSHI_PRIVATE_KEY_PATH` points to the correct `.pem` file
- Verify the path is relative to the project root or absolute

## Step 6: Enable Live Mode

The dashboard has a Live/Paper toggle in the Header. Live mode:
- Shows a confirmation modal before enabling
- All subsequent pipeline runs that approve a trade will call `/api/place-order`
- The trade alert modal appears with a "Buy $40" button

**Paper mode** (default): Pipeline runs fully but no real orders are placed. Execution agent output says "Paper trade only."

## Step 7: Run the Trade Daemon (Optional)

For fully autonomous 24/7 trading without Claude Code:

```bash
source ~/.sentient-venv313/bin/activate
cd "<project-root>"

# Test with dry-run first
python3 python-service/trade_daemon.py --dry-run

# Live when ready
python3 python-service/trade_daemon.py --bankroll 200
```

## Step 8: MCP Server Setup (Claude Code Integration)

Create credentials file:
```bash
mkdir -p ~/.sentient-trader
cat > ~/.sentient-trader/config.env << EOF
KALSHI_API_KEY=<YOUR_KALSHI_API_KEY_UUID>
KALSHI_PRIVATE_KEY_PATH=/absolute/path/to/kalshi_private.pem
EOF
```

Note: **absolute path** required in config.env (MCP server CWD is unknown).

Install and register:
```bash
pip install sentient-trader-mcp
claude mcp add -s user sentient-trader -- python3 -m sentient_trader_mcp
```

Restart Claude Code, then test:
```
What's the current KXBTC15M market?
```

## Credential Priority (Web App)

`lib/kalshi-auth.ts` loads credentials in this order:
1. `.kalshi-credentials.json` (UI-uploaded via Settings page)
2. `KALSHI_PRIVATE_KEY` env var (PEM content inline, for Vercel)
3. `KALSHI_PRIVATE_KEY_PATH` + `KALSHI_API_KEY` env vars (local dev)

## Credential Priority (MCP Server / Python)

1. `~/.sentient-trader/config.env`
2. `$CWD/.env.local`
3. `$CWD/.env`
4. Environment variables already set

## Order Placement Details

```typescript
// lib/kalshi-trade.ts
export async function placeOrder({
  ticker, side, count, yesPrice, noPrice, clientOrderId
}: PlaceOrderParams): Promise<PlaceOrderResult>
```

- `side`: `"yes"` or `"no"`
- `yesPrice` + `noPrice` must sum to 100
- `count`: number of contracts (each contract = $1 face value)
- `clientOrderId`: optional dedup key (use `Date.now()` + random)

The API route `/api/place-order` wraps this and returns `{ ok, orderId, error }`.

## Risk Parameters

Default values in the risk manager and daemon:

| Parameter | Default | Meaning |
|-----------|---------|---------|
| Min edge | 3% | Minimum (pModel - marketPrice) to place a trade |
| Daily loss cap | $150 (web) / $50 (daemon) | Stop for the day |
| Max drawdown | 15% | Stop if portfolio drops 15% |
| Max daily trades | 48 | Circuit breaker |
| Max trade size | 20% of bankroll | Per-trade cap |
| Blocked UTC hours | 11, 18 | Never trade these windows |
| Max entry price | 72¢ | Above this, market is efficiently priced |

## Verifying a Placed Order

```typescript
// After placeOrder returns orderId, check positions:
GET /api/positions
→ resting_orders: [{ order_id, ticker, side, contracts, price }]
```

Orders may fill immediately (if price is at ask) or rest in the book. Kalshi KXBTC15M markets are generally liquid during active windows.

## Settlement

Markets settle automatically at `close_time`. Results appear in positions as settled. The daemon logs WIN/LOSS after detecting settlement. The web app doesn't currently auto-detect settlement (P&L is manually tracked in the trade log).

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `401 Unauthorized` | Wrong API key or signature | Check timestamp is ms, path has no query string |
| `No active market found` | `yes_ask` is null (new API format) | Ensure normalization: `yes_ask = round(float(yes_ask_dollars) * 100)` |
| MCP returns stale data | Old server version still running | `pip install --upgrade sentient-trader-mcp` + restart Claude Code |
| Pipeline never completes | ROMA at max_depth=0 (unlimited) | Set `ROMA_MAX_DEPTH=1` in `.env.local` |
| `python3 main.py` does nothing | No `__main__` block | Use `python3 -m uvicorn main:app --port 8001` |
| Turbopack symlink panic | venv inside project dir | Move venv to `~/.sentient-venv313` |
