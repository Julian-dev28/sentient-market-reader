"""
Sentient Market Reader — ROMA Python Microservice
──────────────────────────────────────────────────
Wraps the real roma-dspy SDK and exposes it as a FastAPI endpoint
for the Next.js pipeline to call.

Runs the actual Sentient Foundation ROMA recursive solve loop:
  Atomizer → Planner → parallel Executors → Aggregator

Usage:
  pip install -r requirements.txt
  cp .env.example .env
  uvicorn main:app --port 8001 --reload
"""

import os
import time
import traceback
import json as _json
from datetime import datetime
from typing import Optional
from concurrent.futures import ThreadPoolExecutor, as_completed

import dspy
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from roma_dspy.core.engine.solve import solve, ROMAConfig
from roma_dspy.resilience.circuit_breaker import module_circuit_breaker
from roma_dspy.config.schemas.base import RuntimeConfig, LLMConfig
from roma_dspy.types.adapter_type import AdapterType
from roma_dspy.config.schemas.agents import AgentConfig, AgentsConfig
from dotenv import load_dotenv

load_dotenv()

app = FastAPI(
    title="Sentient Market Reader — ROMA Service",
    description="Runs the real roma-dspy ROMA solve loop for Kalshi KXBTC15M analysis",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://localhost:3001"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


# ── LLM configuration ────────────────────────────────────────────────────────

def build_llm_config(
    provider_override: Optional[str] = None,
    model_override: Optional[str] = None,
    api_keys: Optional[dict] = None,
) -> tuple[LLMConfig, str]:
    """
    Build an LLMConfig from environment variables (or user-provided keys).
    Single model per provider — set via env var or model_override.
    api_keys: optional dict with per-provider keys e.g. {'openrouter': '...', 'anthropic': '...'}
    provider_override: if set, takes precedence over AI_PROVIDER env var.
    """
    provider = provider_override or os.getenv("AI_PROVIDER", "grok")
    ak = api_keys or {}

    if provider == "anthropic":
        api_key = ak.get("anthropic") or os.getenv("ANTHROPIC_API_KEY")
        if not api_key:
            raise ValueError("ANTHROPIC_API_KEY not set")
        model = model_override or os.getenv("ANTHROPIC_MODEL", "claude-haiku-4-5-20251001")
        return (
            LLMConfig(model=f"anthropic/{model}", api_key=api_key),
            f"anthropic/{model}",
        )

    if provider == "openai":
        api_key = ak.get("openai") or os.getenv("OPENAI_API_KEY")
        if not api_key:
            raise ValueError("OPENAI_API_KEY not set")
        model = model_override or os.getenv("OPENAI_MODEL", "gpt-4o-mini")
        return (
            LLMConfig(model=f"openai/{model}", api_key=api_key),
            f"openai/{model}",
        )

    if provider == "grok":
        api_key = ak.get("xai") or ak.get("grok") or os.getenv("XAI_API_KEY")
        if not api_key:
            raise ValueError("XAI_API_KEY not set")
        model = model_override or os.getenv("GROK_MODEL", "grok-3-mini-fast")
        return (
            LLMConfig(
                model=f"openai/{model}",
                api_key=api_key,
                base_url="https://api.x.ai/v1",
            ),
            f"grok/{model}",
        )

    if provider == "openrouter":
        api_key = ak.get("openrouter") or os.getenv("OPENROUTER_API_KEY")
        if not api_key:
            raise ValueError("OPENROUTER_API_KEY not set")
        model = model_override or os.getenv("OPENROUTER_MODEL", "google/gemini-2.5-flash")
        return (
            LLMConfig(
                model=f"openrouter/{model}",
                api_key=api_key,
                base_url="https://openrouter.ai/api/v1",
                adapter_type=AdapterType.CHAT,         # force ChatAdapter — JSONAdapter fails on non-grok models via OpenRouter
                use_native_function_calling=False,      # prevents DSPy from auto-switching to tool-call format
            ),
            f"openrouter/{model}",
        )

    if provider == "huggingface":
        api_key = ak.get("huggingface") or ak.get("hf") or os.getenv("HUGGINGFACE_API_KEY") or os.getenv("HF_API_KEY")
        if not api_key:
            raise ValueError("HUGGINGFACE_API_KEY not set")
        base_url = os.getenv("HF_BASE_URL", "https://router.huggingface.co/v1")
        model = model_override or os.getenv("HUGGINGFACE_MODEL", "Qwen/Qwen2.5-7B-Instruct")
        return (
            LLMConfig(
                model=f"openai/{model}",
                api_key=api_key,
                base_url=base_url,
            ),
            f"huggingface/{model}",
        )

    raise ValueError(f"Unknown AI_PROVIDER '{provider}' — use: anthropic | openai | grok | openrouter | huggingface")


def build_roma_config(llm: LLMConfig) -> ROMAConfig:
    """
    Build a ROMAConfig with the given LLMConfig for all agents.
    Prefer build_roma_config_tiered() for better speed/quality balance.
    runtime.timeout must be >= max agent LLM timeout (default 600s).
    """
    def agent_llm(temperature: float = 0.5, max_tokens: int = 2000) -> LLMConfig:
        return LLMConfig(
            model=llm.model,
            api_key=llm.api_key,
            base_url=llm.base_url,
            temperature=temperature,
            max_tokens=max_tokens,
        )

    agents = AgentsConfig(
        atomizer=AgentConfig(llm=agent_llm(temperature=0.1, max_tokens=1000)),
        planner=AgentConfig(llm=agent_llm(temperature=0.3, max_tokens=3000)),
        executor=AgentConfig(llm=agent_llm(temperature=0.5, max_tokens=2000)),
        aggregator=AgentConfig(llm=agent_llm(temperature=0.2, max_tokens=4000)),
        verifier=AgentConfig(llm=agent_llm(temperature=0.1, max_tokens=1000)),
    )

    return ROMAConfig(
        runtime=RuntimeConfig(timeout=700),
        agents=agents,
    )


def build_roma_config_tiered(analysis_llm: LLMConfig, orchestration_llm: LLMConfig, roma_mode: str = "keen") -> ROMAConfig:
    """
    Tiered ROMA config — fastest quality mix:
      Atomizer + Planner  → orchestration_llm (fast/cheap — just task decomposition)
      Executor + Aggregator → analysis_llm (quality model — the actual reasoning)

    Token budgets — just above the truncation point, not so high that generation time blows up:
      blitz: executor 700,  aggregator 600   (atomic fast signal)
      sharp: executor 1000, aggregator 800   (~10s/call at 100 tok/s)
      keen:  executor 1100, aggregator 900
      smart: executor 1200, aggregator 1000
    """
    _token_budgets = {
        "blitz": {"executor": 3000, "aggregator": 1500},
        "sharp": {"executor": 3500, "aggregator": 1800},
        "keen":  {"executor": 4000, "aggregator": 2000},
        "smart": {"executor": 4500, "aggregator": 2500},
    }
    budgets = _token_budgets.get(roma_mode, _token_budgets["keen"])

    def _is_reasoning_model(model: str) -> bool:
        """OpenAI o-series reasoning models require temperature=1.0 and max_tokens>=16000."""
        import re
        return bool(re.search(r'[/:]o[1-9](-|$|mini|preview|high)', model))

    def make_cfg(llm: LLMConfig, temperature: float, max_tokens: int) -> AgentConfig:
        import copy as _copy
        cfg_llm = _copy.copy(llm)
        if _is_reasoning_model(getattr(cfg_llm, 'model', '')):
            temperature = 1.0
            max_tokens  = max(16000, max_tokens)
        try:
            cfg_llm.temperature = temperature
            cfg_llm.max_tokens = max_tokens
        except Exception:
            pass  # LLMConfig immutable — adapter still set via dspy.context in run_single_solve
        return AgentConfig(llm=cfg_llm)

    # Executor must always emit sources field (Optional in signature but JSONAdapter enforces it)
    executor_cfg = make_cfg(analysis_llm, temperature=0.5, max_tokens=budgets["executor"])
    executor_cfg.signature_instructions = (
        "Always include ALL output fields in your JSON response. "
        "The 'sources' field is required — if no sources were used, set it to an empty list: []"
    )

    # Orchestration budgets — enough room to avoid truncation without blowing up generation time
    orch_budgets = {
        "blitz": {"atomizer": 900,  "planner": 1200},
        "sharp": {"atomizer": 1000, "planner": 1400},
        "keen":  {"atomizer": 1000, "planner": 1600},
        "smart": {"atomizer": 1200, "planner": 2000},
    }
    ob = orch_budgets.get(roma_mode, orch_budgets["keen"])

    return ROMAConfig(
        runtime=RuntimeConfig(timeout=700),
        agents=AgentsConfig(
            atomizer=make_cfg(orchestration_llm, temperature=0.1, max_tokens=ob["atomizer"]),
            planner=make_cfg(orchestration_llm,  temperature=0.3, max_tokens=ob["planner"]),
            executor=executor_cfg,
            aggregator=make_cfg(analysis_llm,    temperature=0.2, max_tokens=budgets["aggregator"]),
            verifier=make_cfg(orchestration_llm, temperature=0.1, max_tokens=500),
        ),
    )


# Build LLM config on startup — each /analyze call rebuilds with the request's provider + keys
try:
    _llm_config, _provider_label = build_llm_config()
    # Also configure global DSPy LM for any direct dspy.predict() calls
    dspy.configure(lm=dspy.LM(
        _llm_config.model,
        api_key=_llm_config.api_key,
        api_base=_llm_config.base_url,
    ))
    print(f"[ROMA] LLM configured — provider: {_provider_label}, model: {_llm_config.model}")
except Exception as e:
    _llm_config = None
    _provider_label = "unknown"
    print(f"[ROMA] Warning: LM configuration failed: {e}")
    print("[ROMA] Service will start but /analyze will fail until env vars are set.")


# ── Request / Response models ─────────────────────────────────────────────────

class AnalyzeRequest(BaseModel):
    goal: str
    context: str
    max_depth: Optional[int] = 1
    beam_width: Optional[int] = None       # parallel executor beams; None = SDK default (typically 1-2)
    roma_mode: Optional[str] = "keen"      # blitz | sharp | keen | smart — controls token budgets only
    provider: Optional[str] = None         # overrides AI_PROVIDER env (single-provider support)
    providers: Optional[list[str]] = None  # multi-provider parallel solve — runs each provider simultaneously and merges answers
    model_override: Optional[str] = None   # override specific model ID (e.g. "google/gemini-2.5-pro")
    api_keys: Optional[dict] = None        # per-provider API keys {'openrouter': '...', 'anthropic': '...', 'xai': '...', ...}


class SubtaskResult(BaseModel):
    id: str
    goal: str
    result: str


class AnalyzeResponse(BaseModel):
    answer: str
    was_atomic: bool
    subtasks: list[SubtaskResult]
    duration_ms: int
    provider: str


# ── Endpoints ────────────────────────────────────────────────────────────────

@app.post("/reset")
def reset_breakers():
    """Reset all circuit breakers — call after a transient failure to unblock future solves."""
    module_circuit_breaker.reset_all()
    return {"status": "reset", "message": "All circuit breakers reset to CLOSED"}


@app.get("/health")
def health():
    primary   = os.getenv("AI_PROVIDER", "grok")
    provider2 = os.getenv("AI_PROVIDER2", "")
    roma_mode = os.getenv("ROMA_MODE", "keen")
    return {
        "status": "ok",
        "provider": primary,
        "provider2": provider2 or None,
        "roma_mode": roma_mode,
        "sdk": "roma-dspy",
    }


@app.post("/analyze", response_model=AnalyzeResponse)
def analyze(req: AnalyzeRequest):
    """
    Run the actual ROMA recursive solve loop on a trading goal + market context.

    The goal and context are combined into a single rich prompt that ROMA
    decomposes into parallel analytical subtasks.
    """
    if _llm_config is None:
        raise HTTPException(status_code=503, detail="LLM not configured — check env vars")

    # Rebuild LLM config using provider + keys from the caller
    # provider from request overrides AI_PROVIDER env — enables split-provider pipelines
    roma_mode = req.roma_mode or "keen"
    analysis_llm, provider_label = build_llm_config(req.provider, req.model_override, req.api_keys)
    orchestration_llm, _ = build_llm_config(req.provider, None, req.api_keys)

    # Multi-provider mode: providers list takes precedence over single provider
    active_providers = req.providers if req.providers and len(req.providers) > 0 else [req.provider or os.getenv("AI_PROVIDER", "grok")]

    print(f"[ROMA] /analyze  mode={roma_mode}  providers={active_providers}  model={analysis_llm.model}")

    start = time.time()

    full_prompt = f"""{req.goal}

Market context:
{req.context}"""

    # beam_width: how many parallel executor subtasks ROMA runs simultaneously
    # Higher = more parallelism, more tokens, faster wall-time for multi-subtask goals
    beam_width = req.beam_width or int(os.getenv("ROMA_BEAM_WIDTH", "2"))

    def run_single_solve(prov: str) -> tuple[str, object]:
        """Run one ROMA solve for a given provider; returns (provider_label, result)."""
        a_llm, p_label = build_llm_config(prov, req.model_override, req.api_keys)
        o_llm, _       = build_llm_config(prov, None, req.api_keys)
        cfg = build_roma_config_tiered(a_llm, o_llm, roma_mode)
        solve_kwargs: dict = {"max_depth": req.max_depth, "config": cfg}

        # For OpenRouter, force ChatAdapter at the DSPy global level for the entire solve.
        # Per-agent adapter_type config alone isn't enough — context propagation through
        # ROMA's async retry decorators loses the per-agent setting. Wrapping the full
        # solve() in dspy.context(adapter=ChatAdapter()) ensures all predictor calls
        # inside this solve use the text-format adapter, preventing JSONAdapter parse errors.
        use_chat_adapter = prov == "openrouter"
        ctx_adapter = dspy.ChatAdapter() if use_chat_adapter else None

        def _solve():
            try:
                return solve(full_prompt, beam_width=beam_width, **solve_kwargs)
            except TypeError:
                return solve(full_prompt, **solve_kwargs)

        if ctx_adapter is not None:
            with dspy.context(adapter=ctx_adapter):
                return p_label, _solve()
        return p_label, _solve()

    def extract_answer(result: object) -> tuple[str, bool, list]:
        """Extract answer string, was_atomic flag, and subtasks from a solve result."""
        if isinstance(result, str):
            return result, True, []
        answer = str(result.result or result.goal or result)
        node_type_str = str(getattr(result, "node_type", "")).upper()
        was_atomic = "PLAN" not in node_type_str
        children = getattr(result, "children", []) or []
        subtasks = [
            SubtaskResult(
                id=str(getattr(c, "task_id", f"t{i+1}"))[:8],
                goal=str(getattr(c, "goal", "")),
                result=str(getattr(c, "result", "") or ""),
            )
            for i, c in enumerate(children)
        ]
        return answer, was_atomic, subtasks

    try:
        if len(active_providers) == 1:
            # ── Single-provider solve (standard path) ─────────────────────────
            prov_label, result = run_single_solve(active_providers[0])
            answer, was_atomic, subtasks = extract_answer(result)
            duration_ms = int((time.time() - start) * 1000)
            print(f"[ROMA] done  provider={prov_label}  duration={duration_ms}ms")

        else:
            # ── Multi-provider parallel solve ─────────────────────────────────
            print(f"[ROMA] parallel solve across {len(active_providers)} providers")
            results_map: dict[str, tuple[str, object]] = {}

            with ThreadPoolExecutor(max_workers=len(active_providers)) as ex:
                future_to_prov = {ex.submit(run_single_solve, p): p for p in active_providers}
                for future in as_completed(future_to_prov):
                    prov = future_to_prov[future]
                    try:
                        prov_label, res = future.result()
                        results_map[prov] = (prov_label, res)
                    except Exception as e:
                        print(f"[ROMA] provider {prov} failed: {e}")

            if not results_map:
                raise RuntimeError("All providers failed in parallel solve")

            # Merge: concatenate each provider's answer with a labeled separator
            parts = []
            all_subtasks: list[SubtaskResult] = []
            for prov, (prov_label, res) in results_map.items():
                ans, atomic, subs = extract_answer(res)
                parts.append(f"[{prov_label}]\n{ans}")
                all_subtasks.extend(subs)

            answer     = "\n\n---\n\n".join(parts)
            was_atomic = len(all_subtasks) == 0
            subtasks   = all_subtasks
            prov_label = " + ".join(pl for _, (pl, _) in results_map.items())
            duration_ms = int((time.time() - start) * 1000)
            print(f"[ROMA] parallel done  providers={prov_label}  duration={duration_ms}ms")

        return AnalyzeResponse(
            answer=answer,
            was_atomic=was_atomic,
            subtasks=subtasks,
            duration_ms=duration_ms,
            provider=prov_label,
        )

    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"ROMA solve failed: {str(e)}")


# ── Calibration & Optimization ────────────────────────────────────────────────

_PARAM_BOUNDS = {
    'alpha_cap':               (0.70, 0.92),
    'gate_velocity_threshold': (0.40, 0.75),
    'edge_min_pct':            (1.5,  6.0),
    'sentiment_weight':        (0.05, 0.30),
    'fat_tail_nu':             (2.0,  8.0),
}

_DEFAULT_PARAMS = {
    'alpha_cap':               0.85,
    'gate_velocity_threshold': 0.55,
    'edge_min_pct':            3.0,
    'sentiment_weight':        0.18,
    'fat_tail_nu':             4.0,
}


class CalibrateRequest(BaseModel):
    predictions: list[float]   # raw p_model values in [0, 1]
    outcomes:    list[int]     # 0 (LOSS) or 1 (WIN)


class CalibrateResponse(BaseModel):
    a: float    # Platt scaling coefficient
    b: float    # Platt scaling intercept
    n: int      # number of samples fitted


class OptimizeRequest(BaseModel):
    trades:      list[dict]   # TradeRecord list from client
    calibration: dict = {}    # CalibrationResult


class OptimizeResponse(BaseModel):
    alphaCap:              float
    gateVelocityThreshold: float
    edgeMinPct:            float
    sentimentWeight:       float
    fatTailNu:             Optional[float]
    rationale:             str
    riskLevel:             str
    keyChanges:            list[str]
    computedAt:            str
    tradesSampled:         int
    brierScore:            float


def _opt_clamp(val: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, val))


def _opt_apply_bounds(params: dict) -> dict:
    out = dict(params)
    for k, (lo, hi) in _PARAM_BOUNDS.items():
        if k in out and out[k] is not None:
            out[k] = round(_opt_clamp(float(out[k]), lo, hi), 4)
    return out


def _opt_dampen(proposed: dict, current: dict, max_delta: float = 0.10) -> dict:
    out = dict(proposed)
    for k in _PARAM_BOUNDS:
        if k in out and out[k] is not None and k in current:
            delta = out[k] - current[k]
            if abs(delta) > max_delta:
                out[k] = round(current[k] + max_delta * (1 if delta > 0 else -1), 4)
    return out


def _opt_summarize_trades(trades: list[dict]) -> dict:
    settled = [t for t in trades if t.get('outcome') in ('WIN', 'LOSS')]
    if not settled:
        return {'count': 0}
    wins      = [t for t in settled if t['outcome'] == 'WIN']
    avg_p     = sum(t.get('pModel', 0.5) for t in settled) / len(settled)
    actual_wr = len(wins) / len(settled)
    brier     = sum((t.get('pModel', 0.5) - (1 if t['outcome'] == 'WIN' else 0)) ** 2
                    for t in settled) / len(settled)
    with_sigs = [t for t in settled if t.get('signals')]
    sent_correct = 0
    if with_sigs:
        for t in with_sigs:
            s = t['signals']
            actual_yes = (t.get('side') == 'yes' and t['outcome'] == 'WIN') or \
                         (t.get('side') == 'no'  and t['outcome'] == 'LOSS')
            if (s.get('sentimentScore', 0) > 0.1) == actual_yes:
                sent_correct += 1
    return {
        'count':              len(settled),
        'win_rate':           round(actual_wr, 4),
        'avg_p_model':        round(avg_p, 4),
        'calibration_gap':    round(avg_p - actual_wr, 4),
        'brier_score':        round(brier, 4),
        'wins':               len(wins),
        'losses':             len(settled) - len(wins),
        'sentiment_accuracy': round(sent_correct / len(with_sigs), 4) if with_sigs else None,
        'last_5_outcomes':    [t['outcome'] for t in settled[-5:]],
    }


def _opt_build_prompt(trade_summary: dict, calibration: dict, current_params: dict) -> str:
    return f"""You are a quantitative trading system optimizer for a BTC binary options algo.
Analyze performance data and recommend parameter adjustments for the next trading session.

TRADING PERFORMANCE
{_json.dumps(trade_summary, indent=2)}

CALIBRATION ANALYSIS
Brier Score: {calibration.get('brierScore', 0.25):.4f}  (random=0.25, perfect=0.00)
Log Loss:    {calibration.get('logLoss', 0.693):.4f}
ROC-AUC:     {calibration.get('rocAuc', 0.5):.4f}  (random=0.5, perfect=1.0)
Win Rate:    {calibration.get('overallWinRate', 0.5):.1%}
Avg P(MODEL):{calibration.get('avgPModel', 0.5):.1%}

Signal Importances:
{_json.dumps(calibration.get('signals', []), indent=2)}

CURRENT ALGO PARAMETERS
{_json.dumps(current_params, indent=2)}

Parameter meanings:
- alpha_cap [0.70–0.92]: max weight given to quant math vs LLM. Higher = more math trust.
- gate_velocity_threshold [0.40–0.75]: reachability gate pace threshold. Lower = more permissive.
- edge_min_pct [1.5–6.0]: minimum model vs market edge % to place a trade.
- sentiment_weight [0.05–0.30]: how much LLM sentiment shifts the probability estimate.
- fat_tail_nu [2.0–8.0]: Student-t degrees of freedom. Lower = heavier tails (volatile).

REASONING GUIDELINES
1. If Brier score > 0.20 → model poorly calibrated → increase alpha_cap (trust math more)
2. If sentiment accuracy < 0.55 → reduce sentiment_weight significantly
3. If sentiment accuracy > 0.65 → sentiment is a real signal → increase sentiment_weight
4. If calibration_gap > 0.10 (model overconfident) → raise edge_min_pct
5. If calibration_gap < -0.05 (model underconfident) → lower edge_min_pct
6. If win rate < 0.45 → higher edge_min_pct (require more edge before trading)
7. If win rate > 0.65 and trades > 10 → normal or aggressive mode
8. Do NOT make dramatic changes (max ±0.10 per parameter per session) — prevents overfitting

Respond ONLY with a JSON object:
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


def _opt_call_gemini(prompt: str, api_key: str) -> dict:
    import urllib.request as _ureq
    url = (
        "https://generativelanguage.googleapis.com/v1beta/models/"
        f"gemini-2.5-flash-preview-04-17:generateContent?key={api_key}"
    )
    payload = _json.dumps({
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": 0.2, "maxOutputTokens": 512},
    }).encode()
    req = _ureq.Request(url, data=payload, headers={"Content-Type": "application/json"})
    with _ureq.urlopen(req, timeout=30) as resp:
        data = _json.loads(resp.read())
    text = data["candidates"][0]["content"]["parts"][0]["text"].strip()
    if text.startswith("```"):
        text = text.split("```")[1]
        if text.startswith("json"):
            text = text[4:]
    return _json.loads(text.strip())


def _opt_call_openrouter(prompt: str, api_key: str) -> dict:
    """Call Gemini 2.5 Flash via OpenRouter — used when GOOGLE_AI_API_KEY is absent."""
    import requests as _req
    model = os.getenv("OPENROUTER_MODEL", "google/gemini-2.5-flash")
    resp = _req.post(
        "https://openrouter.ai/api/v1/chat/completions",
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        json={
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0.2,
            "max_tokens": 512,
        },
        timeout=30,
    )
    resp.raise_for_status()
    text = resp.json()["choices"][0]["message"]["content"].strip()
    if text.startswith("```"):
        text = text.split("```")[1]
        if text.startswith("json"):
            text = text[4:]
    return _json.loads(text.strip())


@app.post("/calibrate", response_model=CalibrateResponse)
def calibrate(req: CalibrateRequest):
    """
    Fit Platt scaling to raw model predictions.
    p_cal = sigmoid(a * logit(p_raw) + b)
    Minimises negative log-likelihood via L-BFGS-B.
    """
    try:
        import numpy as np
        from scipy.special import logit, expit
        from scipy.optimize import minimize
    except ImportError:
        raise HTTPException(status_code=503, detail="scipy/numpy not available — pip install scipy numpy")

    if len(req.predictions) < 10:
        raise HTTPException(status_code=400, detail="Need at least 10 samples for Platt scaling")

    eps = 1e-7
    p = np.clip(np.array(req.predictions, dtype=float), eps, 1 - eps)
    y = np.array(req.outcomes, dtype=float)
    f = logit(p)

    def neg_ll(params: list) -> float:
        a, b = params
        p_cal = np.clip(expit(a * f + b), eps, 1 - eps)
        return -float(np.mean(y * np.log(p_cal) + (1 - y) * np.log(1 - p_cal)))

    result = minimize(neg_ll, x0=[1.0, 0.0], method='L-BFGS-B',
                      bounds=[(-10.0, 10.0), (-10.0, 10.0)])
    a, b = result.x.tolist()
    print(f"[CAL] Platt scaling fitted — a={a:.4f} b={b:.4f} n={len(y)}")
    return CalibrateResponse(a=round(a, 6), b=round(b, 6), n=int(len(y)))


@app.get("/backtest")
def backtest(
    request: Request,
    days: int = 3,
    provider: Optional[str] = None,
    roma_mode: str = "blitz",
    starting_cash: float = 100.0,
    max_llm: int = 20,
    limit: Optional[int] = None,
    model: Optional[str] = None,
):
    """
    Run historical backtest against settled KXBTC15M markets.
    Fetches real Kalshi + Coinbase data; replays quant math (+ optional LLM).

    days: 1–14 days of history (default 3)
    provider: if set (e.g. "openrouter"), enriches up to max_llm records with ROMA LLM
    roma_mode: ROMA speed mode for LLM calls (default "blitz")
    max_llm: max records to enrich with LLM (default 20)
    api_keys: pass via x-provider-keys header (base64-encoded JSON dict)
    """
    if days < 1 or days > 14:
        raise HTTPException(status_code=400, detail="days must be between 1 and 14")
    if max_llm < 1 or max_llm > 50:
        raise HTTPException(status_code=400, detail="max_llm must be 1–50")

    # Read per-provider API keys from header (base64 JSON, same format as /analyze)
    api_keys: dict = {}
    keys_header = request.headers.get("x-provider-keys")
    if keys_header:
        try:
            import base64
            api_keys = _json.loads(base64.b64decode(keys_header).decode())
        except Exception:
            pass

    try:
        from backtest import run_backtest
        result = run_backtest(
            days_back=days,
            provider=provider or None,
            api_keys=api_keys or None,
            roma_mode=roma_mode,
            max_llm=max_llm,
            limit=limit,
            model_override=model or None,
            starting_cash=starting_cash,
        )
        return result
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Backtest failed: {str(e)}")


@app.post("/optimize", response_model=OptimizeResponse)
def optimize(req: OptimizeRequest):
    """
    Run Gemini 2.5 Flash meta-optimizer to recommend algo parameter updates.
    Uses GOOGLE_AI_API_KEY (direct) or falls back to OPENROUTER_API_KEY.
    Receives trade history + calibration data → returns updated DailyOptParams.
    """
    google_key    = os.getenv('GOOGLE_AI_API_KEY') or os.getenv('GEMINI_API_KEY')
    openrouter_key = os.getenv('OPENROUTER_API_KEY')
    if not google_key and not openrouter_key:
        raise HTTPException(status_code=503, detail="No optimizer API key — set GOOGLE_AI_API_KEY or OPENROUTER_API_KEY")

    current_params = dict(_DEFAULT_PARAMS)
    trade_summary  = _opt_summarize_trades(req.trades)
    print(f"[OPT] Summarized {trade_summary.get('count', 0)} settled trades for optimization")

    prompt = _opt_build_prompt(trade_summary, req.calibration, current_params)

    try:
        if google_key:
            raw = _opt_call_gemini(prompt, google_key)
            print("[OPT] Used Google AI API (direct)")
        else:
            raw = _opt_call_openrouter(prompt, openrouter_key)
            print(f"[OPT] Used OpenRouter ({os.getenv('OPENROUTER_MODEL', 'google/gemini-2.5-flash')})")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Optimizer call failed: {str(e)}")

    proposed = _opt_apply_bounds(raw)
    final    = _opt_dampen(proposed, current_params)

    print(f"[OPT] Done — risk={raw.get('risk_level')}  brier={trade_summary.get('brier_score', '?')}")

    return OptimizeResponse(
        alphaCap=              final.get('alpha_cap',               _DEFAULT_PARAMS['alpha_cap']),
        gateVelocityThreshold= final.get('gate_velocity_threshold', _DEFAULT_PARAMS['gate_velocity_threshold']),
        edgeMinPct=            final.get('edge_min_pct',            _DEFAULT_PARAMS['edge_min_pct']),
        sentimentWeight=       final.get('sentiment_weight',        _DEFAULT_PARAMS['sentiment_weight']),
        fatTailNu=             final.get('fat_tail_nu'),
        rationale=             raw.get('rationale', ''),
        riskLevel=             raw.get('risk_level', 'normal'),
        keyChanges=            raw.get('key_changes', []),
        computedAt=            datetime.utcnow().isoformat(),
        tradesSampled=         trade_summary.get('count', 0),
        brierScore=            trade_summary.get('brier_score',
                                   req.calibration.get('brierScore', 0.25)),
    )
