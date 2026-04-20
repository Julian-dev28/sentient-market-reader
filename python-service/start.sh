#!/usr/bin/env bash
# Run from anywhere: bash python-service/start.sh
cd "$(dirname "$0")"
exec .venv/bin/uvicorn main:app --port 8001 --host 0.0.0.0 "$@"
