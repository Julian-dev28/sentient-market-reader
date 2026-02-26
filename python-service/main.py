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
from roma_dspy.core.engine.solve import solve
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

def configure_lm():
    """Configure DSPy LM from environment variables."""
    provider = os.getenv("AI_PROVIDER", "openrouter")

    if provider == "anthropic":
        api_key = os.getenv("ANTHROPIC_API_KEY")
        if not api_key:
            raise ValueError("ANTHROPIC_API_KEY not set")
        lm = dspy.LM("anthropic/claude-sonnet-4-5", api_key=api_key)

    elif provider == "openai":
        api_key = os.getenv("OPENAI_API_KEY")
        if not api_key:
            raise ValueError("OPENAI_API_KEY not set")
        lm = dspy.LM("openai/gpt-4o", api_key=api_key)

    elif provider == "grok":
        # xAI via OpenRouter
        api_key = os.getenv("OPENROUTER_API_KEY") or os.getenv("XAI_API_KEY")
        if not api_key:
            raise ValueError("OPENROUTER_API_KEY or XAI_API_KEY not set for Grok")
        lm = dspy.LM(
            "openrouter/x-ai/grok-3",
            api_key=api_key,
            api_base="https://openrouter.ai/api/v1",
        )

    else:
        # Default: OpenRouter (most flexible — supports all models)
        api_key = os.getenv("OPENROUTER_API_KEY")
        if not api_key:
            raise ValueError("OPENROUTER_API_KEY not set")
        lm = dspy.LM(
            "openrouter/anthropic/claude-sonnet-4-5",
            api_key=api_key,
            api_base="https://openrouter.ai/api/v1",
        )

    dspy.configure(lm=lm)
    return provider


# Configure on startup
try:
    _provider = configure_lm()
    print(f"[ROMA] DSPy LM configured — provider: {_provider}")
except Exception as e:
    print(f"[ROMA] Warning: LM configuration failed: {e}")
    print("[ROMA] Service will start but /analyze will fail until env vars are set.")


# ── Request / Response models ─────────────────────────────────────────────────

class AnalyzeRequest(BaseModel):
    goal: str
    context: str
    max_depth: Optional[int] = 2


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

@app.get("/health")
def health():
    provider = os.getenv("AI_PROVIDER", "openrouter")
    return {"status": "ok", "provider": provider, "sdk": "roma-dspy"}


@app.post("/analyze", response_model=AnalyzeResponse)
def analyze(req: AnalyzeRequest):
    """
    Run the actual ROMA recursive solve loop on a trading goal + market context.

    The goal and context are combined into a single rich prompt that ROMA
    decomposes into parallel analytical subtasks.
    """
    start = time.time()

    # Combine goal + context into the full prompt ROMA will solve
    full_prompt = f"""{req.goal}

Market context:
{req.context}"""

    try:
        # ── THE REAL THING: actual roma-dspy solve() call ─────────────────────
        result = solve(full_prompt)
        # ─────────────────────────────────────────────────────────────────────

        duration_ms = int((time.time() - start) * 1000)
        provider = os.getenv("AI_PROVIDER", "openrouter")

        # roma-dspy returns a string answer (or SolveResult depending on version)
        if isinstance(result, str):
            answer = result
            was_atomic = True
            subtasks = []
        else:
            # SolveResult object (if the SDK exposes it)
            answer = str(result.answer if hasattr(result, "answer") else result)
            was_atomic = getattr(result, "was_atomic", True)
            raw_subtasks = getattr(result, "subtasks", [])
            subtasks = [
                SubtaskResult(
                    id=getattr(t, "id", f"t{i+1}"),
                    goal=getattr(t, "goal", str(t)),
                    result=str(getattr(t, "result", "")),
                )
                for i, t in enumerate(raw_subtasks)
            ]

        return AnalyzeResponse(
            answer=answer,
            was_atomic=was_atomic,
            subtasks=subtasks,
            duration_ms=duration_ms,
            provider=provider,
        )

    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"ROMA solve failed: {str(e)}")
