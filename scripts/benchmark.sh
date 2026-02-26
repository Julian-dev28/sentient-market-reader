#!/usr/bin/env bash
# ── ROMA Pipeline Provider Benchmark ──────────────────────────────────────────
# Compares wall-clock time for single-provider vs split-provider pipeline runs.
# Usage: bash scripts/benchmark.sh [mode] [provider] [provider2]
# Examples:
#   bash scripts/benchmark.sh keen grok huggingface   (split: Grok→Sent, HF→Prob)
#   bash scripts/benchmark.sh sharp grok              (baseline: Grok both stages)
#   bash scripts/benchmark.sh blitz                   (blitz: uses env AI_PROVIDER)

MODE="${1:-keen}"
P1="${2:-grok}"
P2="${3:-}"

BASE_URL="${PIPELINE_URL:-http://localhost:3000}"
ENDPOINT="$BASE_URL/api/pipeline"

# Colours
GREEN='\033[0;32m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'; RESET='\033[0m'

parse_ms() {
  # Extract a numeric field from JSON using python3
  python3 -c "import json,sys; d=json.load(sys.stdin); print($1)" 2>/dev/null || echo "?"
}

run_bench() {
  local label="$1"
  local url="$2"
  echo -e "${CYAN}━━━ $label ━━━${RESET}"
  echo -e "  URL: $url"
  local t0
  t0=$(python3 -c "import time; print(int(time.time()*1000))")
  local result
  result=$(curl -sf "$url" 2>&1)
  local exit_code=$?
  local t1
  t1=$(python3 -c "import time; print(int(time.time()*1000))")
  local wall=$((t1 - t0))

  if [[ $exit_code -ne 0 ]]; then
    echo -e "  ${YELLOW}ERROR — curl failed (is the server running at $BASE_URL?)${RESET}"
    echo "  $result"
    return
  fi

  # Check for JSON error
  local api_err
  api_err=$(echo "$result" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('error',''))" 2>/dev/null)
  if [[ -n "$api_err" ]]; then
    echo -e "  ${YELLOW}API error: $api_err${RESET}"
    return
  fi

  local sent_ms prob_ms risk_ms total_agents cycle_start cycle_end
  sent_ms=$(echo "$result" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['agents']['sentiment']['durationMs'])")
  prob_ms=$(echo "$result" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['agents']['probability']['durationMs'])")
  risk_ms=$(echo "$result" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['agents']['risk']['durationMs'])")
  sent_prov=$(echo "$result" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['agents']['sentiment']['agentName'])" | sed 's/SentimentAgent (roma-dspy · //' | sed 's/)//')
  prob_prov=$(echo "$result" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['agents']['probability']['agentName'])" | sed 's/ProbabilityModelAgent (roma-dspy · //' | sed 's/)//')
  cycle_start=$(echo "$result" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['cycleStartedAt'])")
  cycle_end=$(echo "$result" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['cycleCompletedAt'])")
  pipeline_ms=$(python3 -c "
from datetime import datetime
s = datetime.fromisoformat('${cycle_start}'.replace('Z','+00:00'))
e = datetime.fromisoformat('${cycle_end}'.replace('Z','+00:00'))
print(int((e-s).total_seconds()*1000))
" 2>/dev/null || echo "?")

  echo -e "  ${GREEN}Sentiment${RESET}    $sent_ms ms   ($sent_prov)"
  echo -e "  ${GREEN}Probability${RESET}  $prob_ms ms   ($prob_prov)"
  echo -e "  ${GREEN}Risk${RESET}         $risk_ms ms"
  echo -e "  ─────────────────────────────"
  echo -e "  Pipeline ms:  $pipeline_ms ms   (server-side)"
  echo -e "  Wall-clock:   $wall ms   (including network)"
  echo ""
}

echo ""
echo -e "${GREEN}ROMA Pipeline Provider Benchmark${RESET}  mode=$MODE"
echo ""

# Baseline: single provider (includes 8s pause)
BASELINE_URL="${ENDPOINT}?mode=${MODE}&provider=${P1}"
run_bench "Baseline — $P1 (both stages + 8s pause)" "$BASELINE_URL"

# Split provider (no pause)
if [[ -n "$P2" ]]; then
  SPLIT_URL="${ENDPOINT}?mode=${MODE}&provider=${P1}&provider2=${P2}"
  run_bench "Split — $P1 → Sentiment / $P2 → Probability (no pause)" "$SPLIT_URL"
else
  echo -e "${YELLOW}No provider2 specified — skipping split run.${RESET}"
  echo "  Usage: bash scripts/benchmark.sh $MODE $P1 huggingface"
  echo ""
fi
