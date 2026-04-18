"""
research_loop.py — Nightly self-evolution engine

1. Fetches 30-day market + candle data (once, cached for all runs)
2. Runs baseline backtest with current params
3. Ablation study: varies one param at a time, finds best improvement
4. Parses daemon trade logs for live performance data
5. Calls Claude API — analyzes results, writes a research report
6. If any variation beats baseline by > 5%, creates a git branch
   with the proposed param change ready to review & merge

Usage:
  source ~/.sentient-venv313/bin/activate
  python3 research_loop.py              # full run
  python3 research_loop.py --no-claude  # skip API call, just backtest grid
  python3 research_loop.py --days 14    # shorten backtest window
"""

import argparse, copy, json, math, os, re, subprocess, sys, time
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional

# ── Env ────────────────────────────────────────────────────────────────────────
_env_path = Path(__file__).parent.parent / ".env.local"
if _env_path.exists():
    for line in _env_path.read_text().splitlines():
        if line and not line.startswith("#") and "=" in line:
            k, _, v = line.partition("=")
            os.environ.setdefault(k.strip(), v.strip())

sys.path.insert(0, os.path.dirname(__file__))
import run_backtest as _bt

# ── Param grid ─────────────────────────────────────────────────────────────────
# Each entry: (param_name, list_of_values_to_try, human_label)
# "current" marks the baseline value so we can skip it cleanly.
PARAM_GRID = [
    ("MARKOV_MIN_GAP",    [0.08, 0.09, 0.10, 0.11, 0.13, 0.15],  "Markov min gap"),
    ("MIN_PERSIST",       [0.78, 0.80, 0.82, 0.85, 0.87],         "Min persist"),
    ("MAX_ENTRY_PRICE_RM",[68,   70,   71,   72,   73,   74],      "Max entry price (¢)"),
    ("MIN_MINUTES_LEFT",  [3,    4,    5,    6,    7],              "Min minutes left"),
    ("MAX_MINUTES_LEFT",  [8,    9,    10,   11,   12],             "Max minutes left"),
    ("MAX_VOL_MULT",      [1.10, 1.15, 1.25, 1.35, 1.50],         "Max vol multiplier"),
    ("MIN_HURST",         [0.45, 0.48, 0.50, 0.52, 0.55],         "Min Hurst exponent"),
]

# Score = total_return_pct × win_rate_pct / max(max_drawdown_pct, 1)
def score(stats: dict) -> float:
    ret = stats.get("total_return_pct", 0)
    wr  = stats.get("win_rate_pct", 0)
    dd  = max(stats.get("max_drawdown_pct", 1), 1)
    n   = stats.get("total_trades", 0)
    if n < 10:
        return -9999  # not enough trades to be meaningful
    return ret * wr / dd


# ── Backtest runner ────────────────────────────────────────────────────────────
def _run_with_params(markets, c15, c5, overrides: dict, days: int) -> dict:
    """Run simulate() on pre-fetched data with temporary param overrides."""
    original = {}
    for k, v in overrides.items():
        original[k] = getattr(_bt, k)
        setattr(_bt, k, v)
    try:
        records = []
        for mkt in markets:
            r = _bt.process_market(mkt, c15, c5)
            if r:
                records.append(r)
        records.sort(key=lambda r: r["entry_dt"])
        final_cash = _bt.simulate(records)
        executed   = [r for r in records if r.get("contracts", 0) > 0]
        wins       = [r for r in executed if r.get("outcome_sim", r["outcome"]) == "WIN"]
        losses     = [r for r in executed if r.get("outcome_sim", r["outcome"]) == "LOSS"]
        gw = sum(r["pnl"] for r in wins)
        gl = abs(sum(r["pnl"] for r in losses))
        peak = _bt.STARTING_CASH; max_dd = 0.0
        for r in executed:
            peak   = max(peak, r["cash_after"])
            max_dd = max(max_dd, (peak - r["cash_after"]) / peak * 100)
        buckets = {}
        for lo, hi, label in [(0,65,"<65¢"),(65,73,"65-73¢"),(73,79,"73-79¢"),(79,85,"79-85¢")]:
            bt_ = [r for r in executed if lo <= r["limit_price_cents"] < hi]
            bw  = [r for r in bt_ if r.get("outcome_sim", r["outcome"]) == "WIN"]
            if bt_:
                buckets[label] = {
                    "trades": len(bt_),
                    "wr":     round(len(bw)/len(bt_)*100, 1),
                    "pnl":    round(sum(r["pnl"] for r in bt_), 2),
                }
        return {
            "days_back":         days,
            "starting_cash":     _bt.STARTING_CASH,
            "final_cash":        round(final_cash, 2),
            "total_return_pct":  round((final_cash / _bt.STARTING_CASH - 1) * 100, 1),
            "win_rate_pct":      round(len(wins) / max(len(executed), 1) * 100, 1),
            "profit_factor":     round(gw / max(gl, 0.01), 2),
            "max_drawdown_pct":  round(max_dd, 1),
            "total_trades":      len(executed),
            "total_wins":        len(wins),
            "total_losses":      len(losses),
            "price_buckets":     buckets,
            "params":            dict(overrides),
        }
    finally:
        for k, v in original.items():
            setattr(_bt, k, v)


# ── Log parser ─────────────────────────────────────────────────────────────────
def parse_daemon_logs(days: int = 7) -> dict:
    """Parse trade_daemon logs into summary stats."""
    log_dir   = Path(__file__).parent / "logs"
    cutoff    = datetime.now(timezone.utc) - timedelta(days=days)
    trades    = []
    no_trades = []

    for log_file in sorted(log_dir.glob("daemon_*.log")):
        try:
            date_str = log_file.stem.replace("daemon_", "")
            file_dt  = datetime.strptime(date_str, "%Y%m%d").replace(tzinfo=timezone.utc)
            if file_dt < cutoff - timedelta(days=1):
                continue
        except ValueError:
            continue

        for line in log_file.read_text(errors="replace").splitlines():
            # SETTLED WIN/LOSS lines
            m = re.search(
                r"SETTLED (WIN|LOSS) ([+-]?\$[\d.]+) \| (\S+) \| BUY (\w+) @ (\d+)¢",
                line
            )
            if m:
                outcome, pnl_str, ticker, side, price = m.groups()
                try:
                    pnl = float(pnl_str.replace("$", "").replace("+", ""))
                    if "LOSS" in outcome:
                        pnl = -abs(pnl)
                    trades.append({
                        "outcome": outcome, "pnl": pnl,
                        "ticker": ticker, "side": side, "price": int(price),
                    })
                except ValueError:
                    pass
                continue

            # NO TRADE lines
            m2 = re.search(r"NO TRADE — (.+)", line)
            if m2:
                no_trades.append(m2.group(1).strip())

    if not trades:
        return {"available": False, "message": "No settled trades in daemon logs yet"}

    wins   = [t for t in trades if t["outcome"] == "WIN"]
    losses = [t for t in trades if t["outcome"] == "LOSS"]
    total_pnl = sum(t["pnl"] for t in trades)
    wr        = len(wins) / len(trades) * 100

    # Rejection reason breakdown
    reason_counts: dict[str, int] = {}
    for reason in no_trades:
        key = reason[:60]
        reason_counts[key] = reason_counts.get(key, 0) + 1
    top_reasons = sorted(reason_counts.items(), key=lambda x: -x[1])[:5]

    return {
        "available":       True,
        "total_trades":    len(trades),
        "wins":            len(wins),
        "losses":          len(losses),
        "win_rate_pct":    round(wr, 1),
        "total_pnl":       round(total_pnl, 2),
        "avg_win":         round(sum(t["pnl"] for t in wins)   / max(len(wins), 1), 2),
        "avg_loss":        round(sum(t["pnl"] for t in losses) / max(len(losses), 1), 2),
        "no_trade_count":  len(no_trades),
        "top_skip_reasons": top_reasons,
        "by_price": {
            "65-73¢": _bucket_stats(trades, 65, 73),
            "73-79¢": _bucket_stats(trades, 73, 79),
            "<65¢":   _bucket_stats(trades, 0,  65),
        },
    }


def _bucket_stats(trades, lo, hi):
    bt = [t for t in trades if lo <= t["price"] < hi]
    if not bt:
        return None
    bw = [t for t in bt if t["outcome"] == "WIN"]
    return {
        "trades": len(bt),
        "wr":     round(len(bw)/len(bt)*100, 1),
        "pnl":    round(sum(t["pnl"] for t in bt), 2),
    }


# ── Claude analysis ────────────────────────────────────────────────────────────
def call_claude(baseline: dict, best: Optional[dict], live: dict, all_results: list) -> str:
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        return "No ANTHROPIC_API_KEY found — skipping Claude analysis."

    try:
        import anthropic
        client = anthropic.Anthropic(api_key=api_key)
    except ImportError:
        return "anthropic package not installed — skipping Claude analysis."

    # Build context
    ctx = f"""You are analyzing a live Kalshi BTC binary options trading algorithm.
The strategy bets YES/NO on whether BTC will be above/below a strike price at each
15-minute window expiry. Gates: Markov chain momentum signal, Hurst > 0.5 (trending
regime), Garman-Klass vol < 1.25×ref, timing window (6-9 min, or 3-12 for golden zone
65-73¢), UTC hour blocks (11, 18).

## Current strategy params
- MARKOV_MIN_GAP = {_bt.MARKOV_MIN_GAP}  (min directional conviction gap from 50%)
- MIN_PERSIST = {_bt.MIN_PERSIST}          (Markov state persistence threshold)
- MAX_ENTRY_PRICE_RM = {_bt.MAX_ENTRY_PRICE_RM}¢  (entry price cap — 65-73¢ golden zone)
- MIN_MINUTES_LEFT = {_bt.MIN_MINUTES_LEFT}, MAX_MINUTES_LEFT = {_bt.MAX_MINUTES_LEFT}
- BLOCKED_UTC_HOURS = {sorted(_bt.BLOCKED_UTC_HOURS)}
- MIN_HURST = {_bt.MIN_HURST}, MAX_VOL_MULT = {_bt.MAX_VOL_MULT}
- KELLY_FRACTION = {_bt.KELLY_FRACTION} (fractional Kelly sizing, tiered by price zone)

## 30-day backtest baseline
{json.dumps(baseline, indent=2)}

## Top parameter variations tested (ablation study)
{json.dumps(all_results[:10], indent=2)}
"""

    if best and score(best) > score(baseline):
        ctx += f"""
## Best improvement found
{json.dumps(best, indent=2)}
Score improvement: {score(best) - score(baseline):+.1f} (current: {score(baseline):.1f})
"""

    if live.get("available"):
        ctx += f"""
## Live daemon performance ({live.get('total_trades', 0)} settled trades)
{json.dumps(live, indent=2)}
"""
    else:
        ctx += "\n## Live daemon performance: not yet available (daemon just started)\n"

    prompt = ctx + """
## Your task
Write a structured research report covering:

1. **Performance diagnosis** — what's working, what's not. Look at win rate by price bucket,
   trade count vs opportunities, any patterns in when we win vs lose.

2. **Parameter insights** — from the ablation study, which params have the most impact?
   Are the best variations consistent with the theory (e.g. tighter gap = fewer but higher
   quality trades)?

3. **Proposed changes** — list specific param changes to try next, with clear reasoning.
   Format as:
   ```
   PROPOSED: PARAM_NAME = new_value  (was old_value)
   REASON: ...
   ```

4. **Novel discovery ideas** — suggest 2-3 new signals or filters not currently in the
   algorithm that are worth backtesting. Be specific (e.g. "add RSI < 30 filter when
   betting YES in below-strike windows" not "try momentum indicators").

5. **Risk observations** — anything that looks fragile or over-fit.

Keep the report concise but data-driven. Every claim should reference specific numbers."""

    message = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=2000,
        messages=[{"role": "user", "content": prompt}],
    )
    return message.content[0].text


# ── Git branch ─────────────────────────────────────────────────────────────────
def propose_branch(best: dict, baseline_score: float) -> Optional[str]:
    """Create a git branch with proposed param changes if improvement is significant."""
    best_score = score(best)
    improvement_pct = (best_score / max(abs(baseline_score), 0.01) - 1) * 100
    if improvement_pct < 5:
        return None

    repo_root  = Path(__file__).parent.parent
    branch     = f"research/proposed-{datetime.now().strftime('%Y%m%d-%H%M')}"
    bt_file    = Path(__file__).parent / "run_backtest.py"
    content    = bt_file.read_text()

    # Apply param changes
    for param, new_val in best["params"].items():
        pattern = rf"^({re.escape(param)}\s*=\s*)(.+)$"
        content = re.sub(pattern, rf"\g<1>{new_val}", content, flags=re.MULTILINE)

    try:
        subprocess.run(["git", "-C", str(repo_root), "checkout", "-b", branch],
                       check=True, capture_output=True)
        bt_file.write_text(content)
        subprocess.run(["git", "-C", str(repo_root), "add",
                        str(bt_file.relative_to(repo_root))],
                       check=True, capture_output=True)
        subprocess.run(["git", "-C", str(repo_root), "commit", "-m",
                        f"research: proposed params ({improvement_pct:+.0f}% score)\n\n{json.dumps(best['params'])}"],
                       check=True, capture_output=True)
        subprocess.run(["git", "-C", str(repo_root), "checkout", "-"],
                       check=True, capture_output=True)
        return branch
    except subprocess.CalledProcessError as e:
        # Restore file if something went wrong
        try:
            subprocess.run(["git", "-C", str(repo_root), "checkout", "-"], capture_output=True)
            subprocess.run(["git", "-C", str(repo_root), "checkout", str(bt_file.relative_to(repo_root))],
                           capture_output=True)
        except Exception:
            pass
        return None


# ── Main ───────────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description="Sentient research loop")
    parser.add_argument("--days",       type=int,  default=30,    help="Backtest lookback days")
    parser.add_argument("--no-claude",  action="store_true",      help="Skip Claude API call")
    parser.add_argument("--no-branch",  action="store_true",      help="Skip git branch creation")
    args = parser.parse_args()

    research_dir = Path(__file__).parent / "research"
    research_dir.mkdir(exist_ok=True)
    report_path = research_dir / f"{datetime.now().strftime('%Y-%m-%d')}.md"

    print(f"\n{'='*60}")
    print(f"  Sentient Research Loop — {datetime.now().strftime('%Y-%m-%d %H:%M UTC')}")
    print(f"  Backtest: {args.days} days | Claude: {not args.no_claude}")
    print(f"{'='*60}\n")

    # ── Step 1: Fetch data once ───────────────────────────────────────────────
    print("Fetching historical data (once)...")
    t0 = time.time()
    markets = _bt.fetch_settled_markets(args.days)
    c15     = _bt.fetch_candles_15m(args.days + 5)
    c5      = _bt.fetch_candles_5m(args.days + 5)
    print(f"  {len(markets)} markets, {len(c15)} 15m candles, {len(c5)} 5m candles "
          f"({time.time()-t0:.0f}s)\n")

    # ── Step 2: Baseline ──────────────────────────────────────────────────────
    print("Running baseline backtest...")
    baseline = _run_with_params(markets, c15, c5, {}, args.days)
    b_score  = score(baseline)
    print(f"  Baseline: {baseline['total_return_pct']:+.1f}% return | "
          f"{baseline['win_rate_pct']:.1f}% WR | "
          f"{baseline['total_trades']} trades | "
          f"{baseline['max_drawdown_pct']:.1f}% DD | "
          f"score={b_score:.1f}\n")

    # ── Step 3: Ablation grid ─────────────────────────────────────────────────
    print("Running parameter ablation study...")
    all_variations: list[dict] = []

    for param_name, values, label in PARAM_GRID:
        current_val = getattr(_bt, param_name, None)
        best_for_param = None

        for val in values:
            if val == current_val:
                continue
            override = {param_name: val}
            stats    = _run_with_params(markets, c15, c5, override, args.days)
            s        = score(stats)
            delta    = s - b_score
            marker   = " ★" if delta > 0 else ""
            print(f"  {label}={val}: {stats['total_return_pct']:+.1f}% | "
                  f"{stats['win_rate_pct']:.1f}% WR | "
                  f"{stats['total_trades']}T | score={s:.1f} ({delta:+.1f}){marker}")
            stats["variation_label"] = f"{param_name}={val}"
            all_variations.append(stats)
            if best_for_param is None or s > score(best_for_param):
                best_for_param = stats

        print()

    # Sort by score
    all_variations.sort(key=score, reverse=True)
    best = all_variations[0] if all_variations else None

    if best and score(best) > b_score:
        print(f"Best variation: {best['variation_label']} "
              f"(score {score(best):.1f} vs baseline {b_score:.1f}, "
              f"{(score(best)/max(abs(b_score),0.01)-1)*100:+.0f}%)\n")
    else:
        print("No variation beat the baseline.\n")

    # ── Step 4: Parse daemon logs ─────────────────────────────────────────────
    print("Parsing daemon logs...")
    live_stats = parse_daemon_logs(days=7)
    if live_stats.get("available"):
        print(f"  Live: {live_stats['total_trades']} trades | "
              f"{live_stats['win_rate_pct']:.1f}% WR | "
              f"P&L ${live_stats['total_pnl']:+.2f}\n")
    else:
        print(f"  {live_stats.get('message', 'No live data')}\n")

    # ── Step 5: Claude analysis ───────────────────────────────────────────────
    analysis = ""
    if not args.no_claude:
        print("Calling Claude for analysis (this takes ~15s)...")
        analysis = call_claude(baseline, best, live_stats, all_variations[:12])
        print("  Done.\n")

    # ── Step 6: Write report ──────────────────────────────────────────────────
    lines = [
        f"# Sentient Research Report — {datetime.now().strftime('%Y-%m-%d')}",
        f"",
        f"**Backtest:** {args.days} days | **Baseline score:** {b_score:.1f}",
        f"",
        f"## Baseline ({args.days}d)",
        f"",
        f"| Metric | Value |",
        f"|--------|-------|",
        f"| Return | {baseline['total_return_pct']:+.1f}% |",
        f"| Win rate | {baseline['win_rate_pct']:.1f}% |",
        f"| Trades | {baseline['total_trades']} |",
        f"| Profit factor | {baseline['profit_factor']:.2f} |",
        f"| Max drawdown | {baseline['max_drawdown_pct']:.1f}% |",
        f"",
        f"**Price buckets:**",
        f"",
    ]
    for bucket, bdata in baseline.get("price_buckets", {}).items():
        lines.append(f"- `{bucket}`: {bdata['trades']} trades, {bdata['wr']:.1f}% WR, P&L ${bdata['pnl']:+.2f}")

    if live_stats.get("available"):
        lines += [
            f"",
            f"## Live Performance (last 7 days)",
            f"",
            f"| Metric | Value |",
            f"|--------|-------|",
            f"| Trades | {live_stats['total_trades']} |",
            f"| Win rate | {live_stats['win_rate_pct']:.1f}% |",
            f"| Total P&L | ${live_stats['total_pnl']:+.2f} |",
            f"| Avg win | ${live_stats['avg_win']:+.2f} |",
            f"| Avg loss | ${live_stats['avg_loss']:+.2f} |",
        ]
        if live_stats.get("top_skip_reasons"):
            lines += ["", "**Top skip reasons:**", ""]
            for reason, count in live_stats["top_skip_reasons"]:
                lines.append(f"- ({count}×) {reason}")

    lines += [
        f"",
        f"## Ablation Study — Top 10 Variations",
        f"",
        f"| Variation | Return | WR | Trades | DD | Score | Δ |",
        f"|-----------|--------|-----|--------|-----|-------|---|",
    ]
    for v in all_variations[:10]:
        s = score(v)
        d = s - b_score
        lines.append(
            f"| `{v['variation_label']}` | "
            f"{v['total_return_pct']:+.1f}% | "
            f"{v['win_rate_pct']:.1f}% | "
            f"{v['total_trades']} | "
            f"{v['max_drawdown_pct']:.1f}% | "
            f"{s:.1f} | "
            f"{d:+.1f} |"
        )

    if analysis:
        lines += ["", "## Claude Analysis", "", analysis]

    report_path.write_text("\n".join(lines))
    print(f"Report saved → {report_path}")

    # ── Step 7: Propose git branch ────────────────────────────────────────────
    if not args.no_branch and best and score(best) > b_score:
        branch = propose_branch(best, b_score)
        if branch:
            print(f"\nProposed branch created: {branch}")
            print(f"Review with: git diff main..{branch}")
            print(f"Merge with:  git checkout main && git merge {branch}")
        else:
            improvement = (score(best)/max(abs(b_score),0.01)-1)*100
            if improvement < 5:
                print(f"\nImprovement {improvement:.1f}% < 5% threshold — no branch created")
            else:
                print("\nBranch creation failed (check git status)")

    print(f"\nDone. Report: {report_path}\n")
    return baseline, all_variations, live_stats


if __name__ == "__main__":
    main()
