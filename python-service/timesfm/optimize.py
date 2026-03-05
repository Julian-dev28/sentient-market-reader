"""
Daily Algo Optimizer — Gemini 2.5 Flash Meta-Optimizer
───────────────────────────────────────────────────────
Reads:
  - trade_history.json  (recent settled trades with signals)
  - analysis.json       (TimesFM P(YES) + 24h outlook)
  - calibration.json    (Brier score, signal importances, Platt params)

Calls Gemini 2.5 Flash with a structured prompt, receives parameter
recommendations in JSON format, writes algo_params.json.

Run once per trading session (e.g. each morning or after 20+ settled trades).

Usage:
    source venv313/bin/activate
    python3 optimize.py [--trades path] [--dry-run]
"""

import argparse
import json
import os
import sys
from datetime import datetime
from pathlib import Path
from typing import Optional
from dotenv import load_dotenv

load_dotenv()

# ── Allowed parameter ranges (guardrails) ────────────────────────────────────
PARAM_BOUNDS = {
    'alpha_cap':                 (0.70, 0.92),   # max quant weight in LOP blend
    'gate_velocity_threshold':   (0.40, 0.75),   # reachability gate pace threshold
    'edge_min_pct':              (1.5,  6.0),    # minimum edge % to place trade
    'sentiment_weight':          (0.05, 0.30),   # sentiment blend weight in LOP
    'fat_tail_nu':               (2.0,  8.0),    # Student-t degrees of freedom
}

DEFAULT_PARAMS = {
    'alpha_cap':                 0.85,
    'gate_velocity_threshold':   0.55,
    'edge_min_pct':              3.0,
    'sentiment_weight':          0.18,
    'fat_tail_nu':               4.0,
}


def clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


def load_json_safe(path: str) -> Optional[dict]:
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return None


def summarize_trades(trades: list[dict]) -> dict:
    """Compute quick stats from raw trade records for the prompt."""
    settled = [t for t in trades if t.get('outcome') in ('WIN', 'LOSS')]
    if not settled:
        return {'count': 0}

    wins = [t for t in settled if t['outcome'] == 'WIN']
    losses = [t for t in settled if t['outcome'] == 'LOSS']

    avg_p = sum(t['pModel'] for t in settled) / len(settled)
    actual_wr = len(wins) / len(settled)

    # Brier score
    brier = sum((t['pModel'] - (1 if t['outcome'] == 'WIN' else 0)) ** 2 for t in settled) / len(settled)

    # Signal stats (if available)
    with_sigs = [t for t in settled if t.get('signals')]
    sent_correct = 0
    gate_correct = 0
    if with_sigs:
        for t in with_sigs:
            s = t['signals']
            actual_yes = (t['side'] == 'yes' and t['outcome'] == 'WIN') or \
                         (t['side'] == 'no' and t['outcome'] == 'LOSS')
            if (s.get('sentimentScore', 0) > 0.1) == actual_yes:
                sent_correct += 1
            if s.get('minutesLeft', 15) < 5 and t['outcome'] == 'WIN':
                gate_correct += 1

    # Calibration gap: avg predicted - actual win rate
    calibration_gap = avg_p - actual_wr

    return {
        'count':             len(settled),
        'win_rate':          round(actual_wr, 4),
        'avg_p_model':       round(avg_p, 4),
        'calibration_gap':   round(calibration_gap, 4),
        'brier_score':       round(brier, 4),
        'wins':              len(wins),
        'losses':            len(losses),
        'sentiment_accuracy': round(sent_correct / len(with_sigs), 4) if with_sigs else None,
        'last_5_outcomes':   [t['outcome'] for t in settled[-5:]],
    }


def build_prompt(
    trade_summary: dict,
    calibration: dict,
    timesfm_analysis: dict,
    current_params: dict,
) -> str:
    return f"""You are a quantitative trading system optimizer for a BTC binary options algo.
Your task: analyze yesterday's performance data and recommend parameter adjustments for today's session.

═══════════════════════════════════════════════════════
YESTERDAY'S TRADING PERFORMANCE
═══════════════════════════════════════════════════════
{json.dumps(trade_summary, indent=2)}

═══════════════════════════════════════════════════════
CALIBRATION ANALYSIS
═══════════════════════════════════════════════════════
Brier Score: {calibration.get('brierScore', 0.25):.4f}  (random=0.25, perfect=0.00)
Log Loss:    {calibration.get('logLoss', 0.693):.4f}
ROC-AUC:     {calibration.get('rocAuc', 0.5):.4f}  (random=0.5, perfect=1.0)
Win Rate:    {calibration.get('overallWinRate', 0.5):.1%}
Avg P(MODEL):{calibration.get('avgPModel', 0.5):.1%}

Signal Importances (accuracy = fraction of times signal correctly predicted outcome):
{json.dumps(calibration.get('signals', []), indent=2)}

Platt Scaling: a={calibration.get('plattA')}, b={calibration.get('plattB')}
(None = not enough data fitted yet)

═══════════════════════════════════════════════════════
TIMESFM 24H SESSION OUTLOOK
═══════════════════════════════════════════════════════
{json.dumps(timesfm_analysis.get('outlook_1h', {}), indent=2)}
Forecast summary: {json.dumps(timesfm_analysis.get('forecast_summary', {}), indent=2)}

═══════════════════════════════════════════════════════
CURRENT ALGO PARAMETERS
═══════════════════════════════════════════════════════
{json.dumps(current_params, indent=2)}

Parameter meanings:
- alpha_cap [0.70–0.92]: max weight given to quant math vs LLM in blend. Higher = more math trust.
- gate_velocity_threshold [0.40–0.75]: reachability gate — what fraction of required velocity BTC needs to be "on pace".
  Lower = more permissive (let more trades through). Higher = stricter (fewer trades, higher confidence).
- edge_min_pct [1.5–6.0]: minimum model vs market edge % to place a trade. Higher = fewer but higher-conviction trades.
- sentiment_weight [0.05–0.30]: how much LLM sentiment shifts the probability estimate.
  Lower if sentiment accuracy is near 0.5 (coin flip). Higher if sentiment is reliably >0.65.
- fat_tail_nu [2.0–8.0]: Student-t degrees of freedom for BTC tail model.
  Lower ν = heavier tails (more volatile days). Higher ν = lighter tails (calm days).

═══════════════════════════════════════════════════════
REASONING GUIDELINES
═══════════════════════════════════════════════════════
1. If Brier score > 0.20 → model is poorly calibrated → increase alpha_cap (trust math more)
2. If sentiment accuracy < 0.55 → reduce sentiment_weight significantly
3. If sentiment accuracy > 0.65 → sentiment is a real signal → increase sentiment_weight
4. If calibration_gap > 0.10 (model overconfident) → raise edge_min_pct (require more edge)
5. If calibration_gap < -0.05 (model underconfident) → lower edge_min_pct
6. If TimesFM shows high volatility (spread > $300) → lower fat_tail_nu (heavier tails)
7. If TimesFM shows low volatility (spread < $100) → raise fat_tail_nu (lighter tails)
8. If win rate < 0.45 → consider conservative risk_level, higher edge_min_pct
9. If win rate > 0.65 and trades > 10 → normal or aggressive mode is warranted
10. Do NOT make dramatic changes (±0.10 max per parameter per day) — dampening prevents overfitting

Respond ONLY with a JSON object, no explanation outside the JSON:
{{
  "alpha_cap": <float>,
  "gate_velocity_threshold": <float>,
  "edge_min_pct": <float>,
  "sentiment_weight": <float>,
  "fat_tail_nu": <float or null>,
  "rationale": "<2-3 sentence explanation>",
  "risk_level": "<conservative|normal|aggressive>",
  "key_changes": ["<change 1>", "<change 2>"]
}}"""


def call_gemini(prompt: str, api_key: str) -> dict:
    """Call Gemini 2.5 Flash via REST API."""
    import urllib.request
    url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-04-17:generateContent?key={api_key}"
    payload = json.dumps({
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {
            "temperature":    0.2,   # low temp for structured JSON output
            "maxOutputTokens": 512,
        },
    }).encode()
    req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read())
    text = data["candidates"][0]["content"]["parts"][0]["text"]
    # Strip markdown code fences if present
    text = text.strip()
    if text.startswith("```"):
        text = text.split("```")[1]
        if text.startswith("json"):
            text = text[4:]
    return json.loads(text.strip())


def apply_bounds(params: dict) -> dict:
    """Clamp all parameters to allowed ranges."""
    out = dict(params)
    for key, (lo, hi) in PARAM_BOUNDS.items():
        if key in out and out[key] is not None:
            out[key] = round(clamp(float(out[key]), lo, hi), 4)
    return out


def dampen(proposed: dict, current: dict, max_delta: float = 0.10) -> dict:
    """Prevent dramatic single-day shifts — max ±max_delta per parameter."""
    out = dict(proposed)
    for key in PARAM_BOUNDS:
        if key in out and out[key] is not None and key in current:
            delta = out[key] - current[key]
            if abs(delta) > max_delta:
                out[key] = round(current[key] + max_delta * (1 if delta > 0 else -1), 4)
    return out


def main():
    parser = argparse.ArgumentParser(description='Daily algo optimizer')
    parser.add_argument('--trades',   default='trade_history.json', help='Path to trade history JSON')
    parser.add_argument('--analysis', default='analysis.json',       help='Path to TimesFM analysis JSON')
    parser.add_argument('--calibration', default='calibration.json', help='Path to calibration JSON')
    parser.add_argument('--params',   default='algo_params.json',    help='Path to current/output params JSON')
    parser.add_argument('--dry-run',  action='store_true',           help='Print prompt + result, do not save')
    args = parser.parse_args()

    api_key = os.getenv('GOOGLE_AI_API_KEY') or os.getenv('GEMINI_API_KEY')
    if not api_key:
        print("ERROR: Set GOOGLE_AI_API_KEY or GEMINI_API_KEY in .env", file=sys.stderr)
        sys.exit(1)

    # Load inputs
    trades_raw   = load_json_safe(args.trades) or []
    analysis     = load_json_safe(args.analysis) or {}
    calibration  = load_json_safe(args.calibration) or {}
    current_params = load_json_safe(args.params)
    if not current_params:
        current_params = dict(DEFAULT_PARAMS)
        print("  No existing algo_params.json — using defaults.")

    # Summarise trades
    if isinstance(trades_raw, list):
        trades = trades_raw
    elif isinstance(trades_raw, dict) and 'trades' in trades_raw:
        trades = trades_raw['trades']
    else:
        trades = []

    trade_summary = summarize_trades(trades)
    print(f"\n  Trades analysed: {trade_summary.get('count', 0)} settled")
    if trade_summary.get('count', 0) < 5:
        print("  ⚠ Fewer than 5 settled trades — optimisation may not be meaningful yet.")
        print("  Using default parameters with small nudge from TimesFM volatility only.")

    # Build prompt
    prompt = build_prompt(trade_summary, calibration, analysis, current_params)

    if args.dry_run:
        print("\n── PROMPT ────────────────────────────────────────────────────────────────")
        print(prompt[:3000], "…" if len(prompt) > 3000 else "")
        print("─" * 78)

    # Call Gemini
    print("\n  Calling Gemini 2.5 Flash…")
    try:
        raw = call_gemini(prompt, api_key)
    except Exception as e:
        print(f"  ERROR calling Gemini: {e}", file=sys.stderr)
        sys.exit(1)

    # Apply bounds + dampening
    proposed = apply_bounds(raw)
    dampened = dampen(proposed, current_params)

    output: dict = {
        **dampened,
        'rationale':      raw.get('rationale', ''),
        'risk_level':     raw.get('risk_level', 'normal'),
        'key_changes':    raw.get('key_changes', []),
        'computed_at':    datetime.utcnow().isoformat(),
        'trades_sampled': trade_summary.get('count', 0),
        'brier_score':    trade_summary.get('brier_score', calibration.get('brierScore', 0.25)),
    }

    print("\n── OPTIMISATION RESULT ───────────────────────────────────────────────────")
    print(f"  Risk level:   {output['risk_level']}")
    print(f"  Rationale:    {output['rationale']}")
    for change in output.get('key_changes', []):
        print(f"  · {change}")
    print("\n  Parameters:")
    for k in PARAM_BOUNDS:
        prev = current_params.get(k, '?')
        new  = output.get(k, '?')
        arrow = '→' if prev != new else '='
        print(f"    {k:<28} {prev} {arrow} {new}")
    print("─" * 78)

    if not args.dry_run:
        with open(args.params, 'w') as f:
            json.dump(output, f, indent=2)
        print(f"\n✓ Saved optimised parameters → {args.params}")
    else:
        print("\n[dry-run] Not saving.")


if __name__ == '__main__':
    main()
