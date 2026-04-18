# sentient-trader-mcp

> Autonomous Kalshi BTC prediction market trader — MCP server for Claude Code

Give Claude Code full authority to analyze Kalshi BTC options markets and place real trades on your behalf. The engine uses a Markov chain momentum signal with empirically-tuned gates (timing, vol regime, Hurst exponent, price cap) to identify high-probability entries.

**Backtest (30 days, $200 start):** +397% return · 82% win rate · 5% max drawdown

---

## Install

```bash
pip install sentient-trader-mcp
```

## Configure

Create `~/.sentient-trader/config.env`:

```env
KALSHI_API_KEY=your-kalshi-api-key-id
KALSHI_PRIVATE_KEY_PATH=~/.kalshi/private_key.pem
```

Or set environment variables directly.

You need a [Kalshi](https://kalshi.com) account with API access and an RSA key pair.  
Generate keys in Kalshi → Settings → API.

## Register with Claude Code

```bash
claude mcp add -s user sentient-trader -- python -m sentient_trader_mcp
```

## Use it

Open Claude Code and type `/trade` — Claude will:
1. Check the active KXBTC15M market
2. Run the full Markov signal
3. Place a real order if all gates pass
4. Report balance and P&L

Or ask directly:
- *"What's the current market signal?"*
- *"Check my Kalshi balance"*
- *"Show my open positions"*

---

## Tools

| Tool | Description |
|------|-------------|
| `get_market` | Current active KXBTC15M market — strike, BTC price, minutes left |
| `analyze_signal` | Full Markov signal — recommendation, position size, all gate results |
| `place_trade` | Place a real Kalshi limit order ⚠ |
| `get_balance` | Account balance |
| `get_positions` | Open positions + resting orders |
| `cancel_order` | Cancel a resting order |
| `kelly_size` | Calculate Kelly-optimal position size |

---

## The Signal

**Markov chain momentum** — a 9-state model of 5-min BTC price changes. Chapman-Kolmogorov propagation over T steps gives P(BTC above strike at expiry).

**Gates (all must pass to trade):**
- Markov gap ≥ 11pp from 50% — model must be ≥61% confident
- Markov persistence ≥ 82% — momentum state must be self-reinforcing
- Garman-Klass vol ≤ 1.25× reference — skip chaotic windows
- Hurst exponent ≥ 0.50 — trending regime only, not mean-reverting
- Timing: 6–9 min (standard) or 3–12 min (65–73¢ golden zone)
- Entry price ≤ 72¢ — above this the market is efficiently priced

**Kelly sizing (tiered by price zone):**
- 65–73¢: 35% Kelly · 73–79¢: 12% Kelly · 79–85¢: 8% Kelly

**Blocked UTC hours:** 11:00 and 18:00 (empirically -40pp to -57pp margin)

---

## Overridable Parameters

Set via environment variables:

```env
MARKOV_MIN_GAP=0.11
MIN_PERSIST=0.82
MAX_ENTRY_PRICE=72
MAX_VOL_MULT=1.25
MIN_HURST=0.50
```

---

## Disclaimer

This places **real orders with real money** on a regulated prediction market exchange. Use at your own risk. Nothing here is financial advice. Start with `analyze_signal` in read-only mode before enabling live trading.

## License

MIT
