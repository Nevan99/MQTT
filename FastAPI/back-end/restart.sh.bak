#!/usr/bin/env bash
# Start (or restart) the Pi Fleet Controller backend. Kills whatever is
# currently listening on PORT first, so re-running this after an unclean
# exit (stale reload worker, crashed process, etc.) just works.
set -euo pipefail

HOST="${HOST:-192.168.150.20}"
PORT="${PORT:-8000}"
BACKEND_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_ACTIVATE="$BACKEND_DIR/../../.venv/bin/activate"

existing_pids="$(lsof -ti "tcp:$PORT" || true)"
if [ -n "$existing_pids" ]; then
  echo "Stopping existing process(es) on port $PORT: $existing_pids"
  kill $existing_pids
  sleep 1
  still_running="$(lsof -ti "tcp:$PORT" || true)"
  if [ -n "$still_running" ]; then
    echo "Still running, force killing: $still_running"
    kill -9 $still_running
    sleep 1
  fi
fi

# shellcheck disable=SC1090
source "$VENV_ACTIVATE"
cd "$BACKEND_DIR"
exec uvicorn src.main:app --host "$HOST" --port "$PORT" --reload
