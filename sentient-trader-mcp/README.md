# sentient-trader-mcp

> Autonomous Kalshi BTC prediction market trader — MCP server for Claude Code

Give Claude Code full authority to analyze Kalshi BTC options markets and place real trades on your behalf. The engine uses a Markov chain momentum signal with empirically-tuned gates (timing, vol regime, Hurst exponent, side-specific price caps) to identify high-probability entries.

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
- Markov gap ≥ 11pp from 50% — model must be ≥61% directionally confident
- Markov persistence ≥ 82% — dominant state must self-reinforce
- Minimum 20 transitions before the matrix is trusted
- GK vol ≤ 1.25× baseline — skip chaotic high-vol regimes
- Hurst exponent ≥ 0.50 — skip mean-reverting markets
- Distance from strike ≥ 0.05% — skip near-ATM noise
- Entry 6–9 min before close (3–12 min for YES in 65–73¢ golden zone)

**Risk rules (hardcoded — not configurable):**
| Parameter | Value |
|---|---|
| Entry price cap — YES | ≤ 72¢ |
| Entry price cap — NO | ≤ 65¢ |
| Blocked UTC hours | 8, 11, 16, 18, 21 |
| Max Kelly fraction | 18% |
| Max position size | 20% of bankroll |

**Why split price caps?**  
Live data analysis (147 fills): NO trades at 65–72¢ return −$7.71/trade (53% WR vs 69% break-even needed). Above 65¢, NO is a consensus-following bet with terrible payout. YES up to 72¢ is profitable across all buckets; 72¢+ loses −$9.34/trade.

**Blocked hours** — empirically catastrophic from live fills:
- 11 UTC: EU/US handover (−57pp margin); 18 UTC: US afternoon news (−40pp)
- 8 UTC: EU open noise (44% WR); 16 UTC: US pre-close (36% WR); 21 UTC: thin liquidity (40% WR)

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `KALSHI_API_KEY` | — | Kalshi API key ID (required) |
| `KALSHI_PRIVATE_KEY_PATH` | — | Path to RSA private key PEM (required) |
| `MARKOV_MIN_GAP` | `0.11` | Minimum Markov directional gap |
| `MIN_PERSIST` | `0.82` | Minimum Markov persistence |
| `MAX_ENTRY_PRICE_YES` | `72` | YES price cap in cents |
| `MAX_ENTRY_PRICE_NO` | `65` | NO price cap in cents |
| `MAX_VOL_MULT` | `1.25` | Max vol multiplier vs 0.2%/candle baseline |
| `MIN_HURST` | `0.50` | Min Hurst exponent (trend filter) |

---

## Disclaimer

Places real orders with real money on a regulated prediction market exchange. Always run `analyze_signal` first — never call `place_trade` unless `approved: true`. Use at your own risk. Nothing here is financial advice.
