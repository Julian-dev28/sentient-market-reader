# ROMA Python Microservice

Runs the **real** [`roma-dspy`](https://github.com/sentient-agi/ROMA) SDK from Sentient Foundation and exposes it as a FastAPI endpoint for the Next.js pipeline.

When this service is running, the `ProbabilityModelAgent` uses the actual ROMA recursive solve loop instead of the TypeScript reimplementation. If the service is unreachable, the pipeline falls back to TypeScript ROMA automatically — no downtime.

---

## Requirements

- Python 3.12+
- An LLM API key (OpenRouter recommended — routes to any model)

---

## Setup

```bash
cd python-service

# Create virtualenv
python3.12 -m venv .venv
source .venv/bin/activate       # Windows: .venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt

# Configure env
cp .env.example .env
# Edit .env — add your OPENROUTER_API_KEY (or ANTHROPIC/OPENAI key)
```

---

## Run

```bash
uvicorn main:app --port 8001 --reload
```

Service starts at `http://localhost:8001`.

- `GET  /health` — check status + configured provider
- `POST /analyze` — run ROMA solve on a goal + market context
- `GET  /docs`   — interactive Swagger UI

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `AI_PROVIDER` | Yes | `openrouter` \| `anthropic` \| `openai` \| `grok` |
| `OPENROUTER_API_KEY` | If openrouter/grok | Get at https://openrouter.ai |
| `ANTHROPIC_API_KEY` | If anthropic | Anthropic console |
| `OPENAI_API_KEY` | If openai | OpenAI platform |

---

## How it works

The service wraps `roma_dspy.core.engine.solve.solve()`:

```python
from roma_dspy.core.engine.solve import solve

result = solve(f"{goal}\n\nMarket context:\n{context}")
```

ROMA internally runs:
1. **Atomizer** — is this directly answerable?
2. **Planner** — decompose into 3–5 independent subtasks
3. **Executors** — run subtasks in parallel
4. **Aggregator** — synthesize into unified answer

The raw answer string is returned to Next.js, which then does structured extraction (pModel, recommendation, confidence) using `llmToolCall`.

---

## Connecting to Next.js

In your root `.env.local`:

```env
PYTHON_ROMA_URL=http://localhost:8001
```

Set to empty string to disable and always use the TypeScript ROMA fallback:

```env
PYTHON_ROMA_URL=
```
