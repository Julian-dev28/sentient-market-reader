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
from typing import Optional
from concurrent.futures import ThreadPoolExecutor, as_completed

import dspy
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from roma_dspy.core.engine.solve import solve, ROMAConfig
from roma_dspy.resilience.circuit_breaker import module_circuit_breaker
from roma_dspy.config.schemas.base import RuntimeConfig, LLMConfig
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

def build_llm_config(roma_mode: str = "keen", provider_override: Optional[str] = None) -> tuple[LLMConfig, str]:
    """
    Build an LLMConfig from environment variables.
    Mirrors the TypeScript llm-client providers exactly:
      anthropic    → ANTHROPIC_API_KEY
      openai       → OPENAI_API_KEY
      grok         → XAI_API_KEY → api.x.ai/v1
      openrouter   → OPENROUTER_API_KEY + OPENROUTER_MODEL
      huggingface  → HF_API_KEY → router.huggingface.co/v1 (or HF_BASE_URL)

    roma_mode is passed from the Next.js request body (not read from env),
    so only the root .env.local needs to be edited.
      blitz → blitz model (grok-3-mini-fast — faster infra, same weights as mini)
      sharp → fast model  (grok-3-mini)
      keen  → mid model   (grok-3-fast)
      smart → smart model (grok-3)
    provider_override: if set, takes precedence over AI_PROVIDER env var (split-provider support).
    Returns (llm_config, provider_label).
    """
    provider = provider_override or os.getenv("AI_PROVIDER", "grok")

    if provider == "anthropic":
        api_key = os.getenv("ANTHROPIC_API_KEY")
        if not api_key:
            raise ValueError("ANTHROPIC_API_KEY not set")
        if roma_mode == "blitz":
            model = os.getenv("ANTHROPIC_BLITZ_MODEL", "claude-haiku-4-5-20251001")
        elif roma_mode == "sharp":
            model = os.getenv("ANTHROPIC_FAST_MODEL", "claude-haiku-4-5-20251001")
        elif roma_mode == "keen":
            model = os.getenv("ANTHROPIC_MID_MODEL", "claude-haiku-4-5-20251001")
        else:  # smart
            model = os.getenv("ANTHROPIC_SMART_MODEL", "claude-sonnet-4-6")
        return (
            LLMConfig(model=f"anthropic/{model}", api_key=api_key),
            f"anthropic/{model}",
        )

    if provider == "openai":
        api_key = os.getenv("OPENAI_API_KEY")
        if not api_key:
            raise ValueError("OPENAI_API_KEY not set")
        if roma_mode == "blitz":
            model = os.getenv("OPENAI_BLITZ_MODEL", "gpt-4o-mini")
        elif roma_mode == "sharp":
            model = os.getenv("OPENAI_FAST_MODEL", "gpt-4o-mini")
        elif roma_mode == "keen":
            model = os.getenv("OPENAI_MID_MODEL", "gpt-4o-mini")
        else:  # smart
            model = os.getenv("OPENAI_SMART_MODEL", "gpt-4o")
        return (
            LLMConfig(model=f"openai/{model}", api_key=api_key),
            f"openai/{model}",
        )

    if provider == "grok":
        api_key = os.getenv("XAI_API_KEY")
        if not api_key:
            raise ValueError("XAI_API_KEY not set")
        if roma_mode == "blitz":
            model = os.getenv("GROK_BLITZ_MODEL", "grok-3-mini-fast")
        elif roma_mode == "sharp":
            model = os.getenv("GROK_FAST_MODEL", "grok-3-mini")
        elif roma_mode == "keen":
            model = os.getenv("GROK_MID_MODEL", "grok-3-fast")
        else:  # smart
            model = os.getenv("GROK_SMART_MODEL", "grok-3")
        return (
            LLMConfig(
                model=f"openai/{model}",
                api_key=api_key,
                base_url="https://api.x.ai/v1",
            ),
            f"grok/{model}",
        )

    if provider == "openrouter":
        api_key = os.getenv("OPENROUTER_API_KEY")
        if not api_key:
            raise ValueError("OPENROUTER_API_KEY not set")
        model = os.getenv("OPENROUTER_MODEL", "anthropic/claude-sonnet-4-6")
        return (
            LLMConfig(
                model=f"openrouter/{model}",
                api_key=api_key,
                base_url="https://openrouter.ai/api/v1",
            ),
            f"openrouter/{model}",
        )

    if provider == "huggingface":
        api_key = os.getenv("HUGGINGFACE_API_KEY") or os.getenv("HF_API_KEY")
        if not api_key:
            raise ValueError("HUGGINGFACE_API_KEY not set")
        base_url = os.getenv("HF_BASE_URL", "https://router.huggingface.co/v1")
        if roma_mode == "blitz":
            model = os.getenv("HF_BLITZ_MODEL", "Qwen/Qwen2.5-1.5B-Instruct")
        elif roma_mode == "sharp":
            model = os.getenv("HF_FAST_MODEL", "meta-llama/Llama-3.2-3B-Instruct")
        elif roma_mode == "keen":
            model = os.getenv("HF_MID_MODEL", "meta-llama/Llama-3.1-8B-Instruct")
        else:  # smart
            model = os.getenv("HF_SMART_MODEL", "meta-llama/Llama-3.3-70B-Instruct")
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
    )

    return ROMAConfig(
        runtime=RuntimeConfig(timeout=700),
        agents=agents,
    )


def build_roma_config_tiered(analysis_llm: LLMConfig, orchestration_llm: LLMConfig) -> ROMAConfig:
    """
    Tiered ROMA config — fastest quality mix:
      Atomizer + Planner  → orchestration_llm (fast/cheap — just task decomposition)
      Executor + Aggregator → analysis_llm (quality model — the actual reasoning)

    This cuts 30-50% off wall time because orchestration calls are sequential
    and cheap to speed up; analysis calls run in parallel and need quality.
    """
    def make_cfg(llm: LLMConfig, temperature: float, max_tokens: int) -> AgentConfig:
        return AgentConfig(llm=LLMConfig(
            model=llm.model,
            api_key=llm.api_key,
            base_url=llm.base_url,
            temperature=temperature,
            max_tokens=max_tokens,
        ))

    return ROMAConfig(
        runtime=RuntimeConfig(timeout=700),
        agents=AgentsConfig(
            atomizer=make_cfg(orchestration_llm, temperature=0.1, max_tokens=1000),
            planner=make_cfg(orchestration_llm, temperature=0.3, max_tokens=3000),
            executor=make_cfg(analysis_llm,      temperature=0.5, max_tokens=2000),
            aggregator=make_cfg(analysis_llm,    temperature=0.2, max_tokens=4000),
        ),
    )


# Build LLM config on startup using default mode — each /analyze call rebuilds with the request's roma_mode
try:
    _llm_config, _provider_label = build_llm_config("keen")
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
    roma_mode: Optional[str] = "keen"      # blitz | sharp | keen | smart — analysis model tier
    orch_mode: Optional[str] = None        # orchestration model tier (atomizer/planner); defaults to one tier below roma_mode
    provider: Optional[str] = None         # overrides AI_PROVIDER env (single-provider support)
    providers: Optional[list[str]] = None  # multi-provider parallel solve — runs each provider simultaneously and merges answers


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
    return {
        "status": "ok",
        "provider": _provider_label,
        "model": _llm_config.model if _llm_config else "unconfigured",
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

    # Rebuild LLM config using the mode sent by the caller (not env)
    # provider from request overrides AI_PROVIDER env — enables split-provider pipelines
    roma_mode = req.roma_mode or "keen"
    analysis_llm, provider_label = build_llm_config(roma_mode, req.provider)

    # Orchestration tier: one step faster than analysis tier by default
    # sharp→blitz, keen→sharp, smart→keen; blitz stays at blitz (already at floor)
    _orch_tier_map = {"blitz": "blitz", "sharp": "blitz", "keen": "sharp", "smart": "keen"}
    orch_mode = req.orch_mode or _orch_tier_map.get(roma_mode, "sharp")
    orchestration_llm, _ = build_llm_config(orch_mode, req.provider)

    # Multi-provider mode: providers list takes precedence over single provider
    active_providers = req.providers if req.providers and len(req.providers) > 0 else [req.provider or os.getenv("AI_PROVIDER", "grok")]

    print(f"[ROMA] /analyze  mode={roma_mode}  orch={orch_mode}  providers={active_providers}  model={analysis_llm.model}")

    start = time.time()

    full_prompt = f"""{req.goal}

Market context:
{req.context}"""

    def run_single_solve(prov: str) -> tuple[str, object]:
        """Run one ROMA solve for a given provider; returns (provider_label, result)."""
        a_llm, p_label = build_llm_config(roma_mode, prov)
        o_llm, _       = build_llm_config(orch_mode, prov)
        cfg = build_roma_config_tiered(a_llm, o_llm)
        return p_label, solve(full_prompt, max_depth=req.max_depth, config=cfg)

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

    # Per-mode solve timeout — keeps total wall time predictable.
    # The underlying thread may outlive this timeout (Python can't hard-kill threads),
    # but the HTTP response returns immediately with a 504 so the caller can retry.
    _solve_timeouts = {"blitz": 35, "sharp": 55, "keen": 85, "smart": 120}
    solve_timeout = _solve_timeouts.get(roma_mode, 85)

    try:
        if len(active_providers) == 1:
            # ── Single-provider solve (standard path) ─────────────────────────
            # Don't use `with` — that calls shutdown(wait=True) which blocks until
            # the thread finishes even after a timeout. We want to return immediately.
            _ex = ThreadPoolExecutor(max_workers=1)
            future = _ex.submit(run_single_solve, active_providers[0])
            try:
                prov_label, result = future.result(timeout=solve_timeout)
            except (TimeoutError, Exception) as _te:
                _ex.shutdown(wait=False)
                if isinstance(_te, TimeoutError):
                    raise HTTPException(
                        status_code=504,
                        detail=f"ROMA solve timed out after {solve_timeout}s (mode={roma_mode}). Try blitz mode or retry.",
                    )
                raise _te
            _ex.shutdown(wait=False)
            answer, was_atomic, subtasks = extract_answer(result)
            duration_ms = int((time.time() - start) * 1000)
            print(f"[ROMA] done  provider={prov_label}  duration={duration_ms}ms")

        else:
            # ── Multi-provider parallel solve ─────────────────────────────────
            print(f"[ROMA] parallel solve across {len(active_providers)} providers")
            results_map: dict[str, tuple[str, object]] = {}

            with ThreadPoolExecutor(max_workers=len(active_providers)) as ex:
                future_to_prov = {ex.submit(run_single_solve, p): p for p in active_providers}
                for future in as_completed(future_to_prov, timeout=solve_timeout):
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
