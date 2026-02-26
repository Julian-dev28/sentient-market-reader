#!/bin/bash
# Restart both the Python ROMA service and Next.js dev server

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "→ Stopping servers..."
pkill -f "uvicorn main:app" 2>/dev/null
pkill -f "next dev" 2>/dev/null
sleep 1

echo "→ Starting Python ROMA service..."
cd "$PROJECT_DIR/python-service"
source .venv/bin/activate
python3 -m uvicorn main:app --port 8001 --host 0.0.0.0 &
UVICORN_PID=$!

echo "→ Starting Next.js dev server..."
cd "$PROJECT_DIR"
npm run dev &
NEXT_PID=$!

echo ""
echo "✓ Python service  pid=$UVICORN_PID  http://localhost:8001"
echo "✓ Next.js         pid=$NEXT_PID     http://localhost:3000"
echo ""
echo "Press Ctrl+C to stop both."

wait
