# Tutorials

AI-ingestible documentation for the Sentient Market Reader / ROMA Algotrader system.

## Index

| File | Topic |
|------|-------|
| [00_architecture.md](00_architecture.md) | Full system overview, data flow, execution paths, critical facts |
| [01_kalshi_api.md](01_kalshi_api.md) | Kalshi API: auth, RSA-PSS signing, market discovery, price normalization, order placement |
| [02_markov_signal.md](02_markov_signal.md) | Markov chain signal engine: state space, transition matrix, Chapman-Kolmogorov, gate stack, Kelly sizing |
| [03_mcp_server.md](03_mcp_server.md) | sentient-trader-mcp PyPI package: installation, tools, registration, releasing |
| [04_trade_daemon.md](04_trade_daemon.md) | Autonomous trade daemon: timing loop, session risk guards, logging, settlement |
| [05_research_loop.md](05_research_loop.md) | Nightly ablation engine: parameter grid, scoring, Claude analysis, git branch creation |
| [06_nextjs_app.md](06_nextjs_app.md) | Next.js dashboard: layout, hooks, components, API routes, design system |
| [07_agent_pipeline.md](07_agent_pipeline.md) | Agent pipeline: 6 agents, ROMA multi-agent loop, streaming, pipeline lock |
| [08_live_trading_setup.md](08_live_trading_setup.md) | End-to-end setup: credentials, env vars, Python venv, live mode, troubleshooting |

## Key Facts for AI Agents

1. Kalshi prices are returned as `yes_ask_dollars` (string USD) — convert with `round(float(v) * 100)`
2. Market `status` is `"active"` in responses even when queried with `status=open`
3. Always use `close_time` for countdowns — `expiration_time` is days later
4. Timestamp for Kalshi auth is **milliseconds** (`Date.now()`, `time.time() * 1000`)
5. Sign payload is `timestamp + METHOD + path` — no separators, path only (no query string)
6. Python venv is at `~/.sentient-venv313` — never put venv inside the Next.js project dir
7. `python3 main.py` does nothing — use `python3 -m uvicorn main:app --port 8001`
8. `ROMA_MAX_DEPTH=0` means unlimited recursion — always set ≥1
9. Blocked UTC hours: 11 and 18 — empirically -40pp to -57pp edge
10. BTC price source: Coinbase Exchange API — same feed Kalshi settles against
