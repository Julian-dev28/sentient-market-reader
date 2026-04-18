# Research Loop (Self-Evolution Engine)

## What It Is

`python-service/research_loop.py` — a nightly ablation study that:
1. Runs the backtest across a parameter grid
2. Reads live daemon trade logs for real performance data
3. Calls Claude to analyze results and write a research report
4. Creates a git branch if any parameter combination beats baseline by >5%

## Usage

```bash
source ~/.sentient-venv313/bin/activate
cd "<project-root>"

# Full run (fetches data, runs ablation, calls Claude, maybe creates branch)
python3 python-service/research_loop.py

# Skip Claude API call — just run backtest grid
python3 python-service/research_loop.py --no-claude

# Shorter backtest window (faster)
python3 python-service/research_loop.py --days 14
```

## Parameter Grid

The ablation varies one parameter at a time, holding all others at baseline:

```python
PARAM_GRID = [
    ("MARKOV_MIN_GAP",    [0.08, 0.09, 0.10, 0.11, 0.13, 0.15],  "Markov min gap"),
    ("MIN_PERSIST",       [0.78, 0.80, 0.82, 0.85, 0.87],         "Min persist"),
    ("MAX_ENTRY_PRICE_RM",[68,   70,   71,   72,   73,   74],      "Max entry price (¢)"),
    ("MIN_MINUTES_LEFT",  [3,    4,    5,    6,    7],              "Min minutes left"),
    ("MAX_MINUTES_LEFT",  [8,    9,    10,   11,   12],             "Max minutes left"),
    ("MAX_VOL_MULT",      [1.10, 1.15, 1.25, 1.35, 1.50],         "Max vol multiplier"),
    ("MIN_HURST",         [0.45, 0.48, 0.50, 0.52, 0.55],         "Min Hurst exponent"),
]
```

## Scoring Metric

```python
def score(stats: dict) -> float:
    ret = stats.get('total_return_pct', 0)
    wr  = stats.get('win_rate_pct', 0)
    dd  = max(stats.get('max_drawdown_pct', 1), 1)
    n   = stats.get('total_trades', 0)
    if n < 10:
        return -9999  # not enough trades to be meaningful
    return ret * wr / dd
```

`score = total_return × win_rate / max_drawdown`

Higher is better. Requires ≥10 trades to avoid overfitting on tiny samples.

## How Ablation Works

Data is fetched once and cached for all runs (avoids redundant API calls):

```python
# Fetch once
markets = await fetch_kalshi_markets(days)
c15     = await fetch_candles(900, days)
c5      = await fetch_candles(300, days)

# Run baseline
baseline_stats = run_with_params(markets, c15, c5, overrides={}, days=days)
baseline_score = score(baseline_stats)

# Ablate each parameter
for param_name, values, label in PARAM_GRID:
    for val in values:
        stats = run_with_params(markets, c15, c5, overrides={param_name: val}, days=days)
        s = score(stats)
        all_results.append({...})
```

`run_with_params` monkey-patches `run_backtest` module constants before calling `simulate()`:

```python
def run_with_params(markets, c15, c5, overrides: dict, days: int) -> dict:
    import run_backtest as _bt
    original = {}
    for k, v in overrides.items():
        original[k] = getattr(_bt, k)
        setattr(_bt, k, v)
    try:
        return _bt.simulate(markets, c15, c5)
    finally:
        for k, v in original.items():
            setattr(_bt, k, v)
```

## Live Log Parsing

The research loop reads daemon logs to compare backtest results with actual live performance:

```python
def parse_daemon_logs(days: int = 7) -> dict:
    log_dir = Path(__file__).parent / 'logs'
    wins = losses = 0
    pnl = []

    for f in sorted(log_dir.glob('daemon_*.log'))[-days:]:
        for line in f.read_text().splitlines():
            if 'WIN' in line:
                wins += 1
                # extract P&L from "WIN | P&L: +$0.87"
                m = re.search(r'P&L:\s*([+-]?\$[\d.]+)', line)
                if m: pnl.append(float(m.group(1).replace('$', '')))
            elif 'LOSS' in line:
                losses += 1
                m = re.search(r'P&L:\s*([+-]?\$[\d.]+)', line)
                if m: pnl.append(float(m.group(1).replace('$', '')))

    n = wins + losses
    return {
        'trades': n,
        'win_rate': wins/n if n else 0,
        'total_pnl': sum(pnl),
        'avg_pnl': sum(pnl)/n if n else 0,
    }
```

## Claude Analysis

Calls `claude-sonnet-4-6` with a structured prompt containing:
- Baseline stats (return, WR, drawdown, trade count)
- Best-performing parameter variation (if any beats baseline)
- Live daemon stats for the last 7 days
- Top 5 results from the ablation grid
- Question: "What does this suggest about the signal? Are the live results consistent with backtest?"

```python
def call_claude(baseline, best, live, all_results) -> str:
    from anthropic import Anthropic
    client = Anthropic()

    prompt = f"""
You are analyzing a Kalshi BTC 15-min prediction market trading system.

## Backtest Results (baseline, {days} days)
- Return: {baseline['total_return_pct']:.1f}%
- Win rate: {baseline['win_rate_pct']:.1f}%
- Max drawdown: {baseline['max_drawdown_pct']:.1f}%
- Trades: {baseline['total_trades']}
- Score: {score(baseline):.2f}

## Best Ablation Result
{json.dumps(best, indent=2)}

## Live Daemon Performance (last 7 days)
{json.dumps(live, indent=2)}

## Top 5 Ablation Results
{json.dumps(sorted(all_results, key=lambda r: r['score'], reverse=True)[:5], indent=2)}

Analyze: Is the live performance consistent with backtest? Which parameter change would you recommend?
Write a concise research report (< 400 words).
"""

    msg = client.messages.create(
        model='claude-sonnet-4-6',
        max_tokens=1000,
        messages=[{'role': 'user', 'content': prompt}],
    )
    return msg.content[0].text
```

## Git Branch Creation

If the best variation beats baseline score by >5%:

```python
def propose_branch(best: dict, baseline_score: float) -> str | None:
    if best['score'] <= baseline_score * 1.05:
        return None  # not enough improvement

    branch = f"research/{datetime.now().strftime('%Y%m%d')}-{best['param']}-{best['value']}"
    subprocess.run(['git', 'checkout', '-b', branch], check=True)

    # Patch run_backtest.py with the proposed value
    content = Path('python-service/run_backtest.py').read_text()
    # ... regex replace the constant ...
    Path('python-service/run_backtest.py').write_text(patched)

    subprocess.run(['git', 'add', 'python-service/run_backtest.py'], check=True)
    subprocess.run(['git', 'commit', '-m', f'Research: {best["label"]}={best["value"]} (+{improvement:.1f}% score)'], check=True)
    subprocess.run(['git', 'checkout', 'main'], check=True)

    return branch
```

The branch is local only. A human reviews it before merging. This is intentional — the loop proposes, humans decide.

## Output

Reports saved to `python-service/research/YYYY-MM-DD.md`:

```markdown
# Research Report — 2026-04-18

## Baseline (30 days)
- Return: +312.4%  Win rate: 79.2%  Drawdown: 4.1%  Score: 603.1

## Best Variation
- MIN_PERSIST = 0.85 → Score: 681.4 (+12.9%)

## Claude Analysis
[Claude's report here]

## Recommendation
Proposed branch: research/20260418-MIN_PERSIST-0.85
```

## Running Nightly via Cron

```bash
# Run at 2 AM UTC every night
echo "0 2 * * * cd '<project-root>' && source ~/.sentient-venv313/bin/activate && python3 python-service/research_loop.py >> python-service/logs/research.log 2>&1" | crontab -
```

## The `/research` Claude Code Skill

`~/.claude/commands/research.md` lets you run the research loop from Claude Code:

```markdown
Run the nightly research loop:

```bash
cd "<project-root>"
source ~/.sentient-venv313/bin/activate
python3 python-service/research_loop.py
```

Then read the output report in python-service/research/ and summarize the findings.
```
