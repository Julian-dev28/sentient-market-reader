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

def build_llm_config(roma_mode: str = "keen") -> tuple[LLMConfig, str]:
    """
    Build an LLMConfig from environment variables.
    Mirrors the TypeScript llm-client providers exactly:
      anthropic    → ANTHROPIC_API_KEY
      openai       → OPENAI_API_KEY
      grok         → XAI_API_KEY → api.x.ai/v1
      openrouter   → OPENROUTER_API_KEY + OPENROUTER_MODEL
      huggingface  → HF_API_KEY → api-inference.huggingface.co/v1 (or HF_BASE_URL)

    roma_mode is passed from the Next.js request body (not read from env),
    so only the root .env.local needs to be edited.
      blitz → blitz model (grok-3-mini-fast — faster infra, same weights as mini)
      sharp → fast model  (grok-3-mini)
      keen  → mid model   (grok-3-fast)
      smart → smart model (grok-3)
    Returns (llm_config, provider_label).
    """
    provider = os.getenv("AI_PROVIDER", "grok")

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
    runtime.timeout must be >= max agent LLM timeout (default 600s).
    """
    # Each agent gets the same LLM; preserve default temperatures/max_tokens
    # by creating per-role copies with only model/key/base_url overridden.
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
        runtime=RuntimeConfig(timeout=700),  # must be >= agent LLM timeout (600s)
        agents=agents,
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
    roma_mode: Optional[str] = "keen"  # blitz | sharp | keen | smart — passed from Next.js root .env.local


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
    roma_mode = req.roma_mode or "keen"
    llm_config, provider_label = build_llm_config(roma_mode)

    print(f"[ROMA] /analyze  mode={roma_mode}  model={llm_config.model}  provider={provider_label}")

    start = time.time()

    full_prompt = f"""{req.goal}

Market context:
{req.context}"""

    try:
        # ── THE REAL THING: actual roma-dspy solve() call ─────────────────────
        config = build_roma_config(llm_config)
        result = solve(full_prompt, max_depth=req.max_depth, config=config)
        # ─────────────────────────────────────────────────────────────────────

        duration_ms = int((time.time() - start) * 1000)
        print(f"[ROMA] done  model={llm_config.model}  duration={duration_ms}ms")

        if isinstance(result, str):
            answer = result
            was_atomic = True
            subtasks = []
        else:
            # roma-dspy returns a TaskNode — extract the answer text from .result
            answer = str(result.result or result.goal or result)
            # node_type EXECUTE = atomic (no planning step); PLAN = decomposed
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

        return AnalyzeResponse(
            answer=answer,
            was_atomic=was_atomic,
            subtasks=subtasks,
            duration_ms=duration_ms,
            provider=provider_label,
        )

    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"ROMA solve failed: {str(e)}")
